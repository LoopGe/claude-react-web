# Automatic Live Rebuild Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a genuine live chronology anomaly (a new result/completion whose canonical position precedes the current tail, or a same-resultUuid semantic revision) and automatically quiesce → rebuild → resume, instead of head-appending out of order or waiting for a restart/manual Retry.

**Architecture:** T7b made normal queued input append-only (`P1,A1,R1,U2`), so the only remaining inversions are genuine anomalies — the trigger can fire selectively without rebuilding on every queued send. The writer gains a `rebuild-pending → rebuild-exclusive` state machine: on detection it durably persists the triggering operation + full payload as a non-public `recovery` batch, returns `REBUILD_REQUIRED`, and closes transcript-mutation admission (`rebuildAdmissionPending`). A `pendingRebuilds` scheduler auto-fires the rebuild when the session reaches `quiesceEligible` (turn idle, no executing work), re-evaluating on lifecycle events; the execution reuses the ordered-rebuild algorithm (`reconcileOrdered`) but replaces the current retry's interrupt+unload *withdrawal* with the spec's drain-preserve-replay (`drained-to-pending` → resume replay by `dispatchOrdinal`). Long-term blockers surface an actionable `rebuild-waiting` status with `deferRebuild`.

**Tech Stack:** TypeScript (Node 20), vitest, the existing `TranscriptWriter` / `TranscriptSidecar` (`recovery` batchType) / `reconcileOrdered` / `buildOrderedProjection` / `classifyPendingInputs` / `retryTranscriptReconcile` machinery; React 19 session-store for the `rebuild-waiting`/`deferRebuild` UI.

**Spec:** `docs/superpowers/specs/2026-11-16-transcript-ordered-reconcile-design.md` — §6.1/§6.2 (append-only vs ordered-rebuild decision), §8.1 (writer queue, `rebuild-pending`/`rebuild-exclusive`, `REBUILD_REQUIRED`, `rebuildAdmissionPending`, `quiesceEligible`, `beginQuiesceForRebuild`/`drainInputQueue`/`drained-to-pending`, resume replay, `rebuild-waiting`/`deferRebuild`), §8.3 (capability gate + `transcript-rebased` envelope), §9 (crash recovery), §10 (degraded fence). Section references below point into that spec.

## Global Constraints

- Durable-before-publish: a rebuild is exposed only after its own generation commit fsyncs (`reconcileOrdered` already appends+fsyncs BEFORE `store.reset/hydrate` — do not reorder). The `rebuild-pending` recovery record is the ONLY write allowed before capability upgrade; it produces no WS/ring frame and does not advance client cursors (spec §8.3).
- Normal append-only tail results NEVER trigger a rebuild and NEVER require old-tab upgrade (spec §8.1/§8.3). Only a genuine anomaly (result/completion position earlier than tail, or same-resultUuid semantic revision) triggers. T7b's queued-not-published guarantee is preserved: a normal mid-turn queued send must not trigger.
- `REBUILD_REQUIRED` is not a persistence failure; Retry must not re-execute the handed-off operation in a loop (spec §8.1). The full payload is persisted `rebuild-pending` so crash/cap-eviction still recovers it.
- Rebuild only on a quiesced session (`quiesceEligible`); broker-blocked sessions (pending permission/elicitation/dialog only) ARE eligible (settle them first); `queuedInputs>0` rejects only when an actual turn/tool is executing (spec §8.1).
- Capability gate before any public projection/generation mutation: an incapable browser subscriber → `client-upgrade-required` refusal, `abortRebuild('cancelled')` restores the old projection (spec §8.3). Already enforced in `reconcileOrdered`; the auto path must pre-check and handle refusal without tearing down.
- `msg` in the seq subsystem stays SDK-free (`unknown`); no `@anthropic-ai/claude-agent-sdk` import in the browser bundle. Diagnostics via `createLogger(scope)`; metrics labels finite enums (never session ids/uuids).
- TDD: failing test first, run red, implement, run green, commit. `npm run typecheck` (all tsconfigs) + targeted Vitest before each commit; full-diff `code-review` before any commit lands on main (CLAUDE.md). Commit ONLY task files via explicit `git add` (working tree carries unrelated parallel WIP).

## Review Focus

Input classes most likely to bite a real user; each gets a test in the owning task:

1. **A normal mid-turn queued send / ordinary tail result** must NOT trigger a rebuild (the T7b append-only guarantee) — Task 3 pins both negative cases.
2. **Crash after `rebuild-pending` persist, before the rebuild commits** — restart recovers the pending payload and resumes the rebuild, exactly once (Task 1 + Task 6 integration).
3. **An incapable tab attaches while a rebuild is pending/in-flight** — refusal restores the old projection via `abortRebuild('cancelled')`, no partial generation exposed, pending payload retained (Task 4/5).
4. **A long-term blocker (running background task / accepted plugin invocation)** — `rebuild-waiting {blockers, pendingOperationCount}` actionable status, not infinite loading; `deferRebuild` restores provider/admission and pauses auto-scheduling while retaining the payload (Task 6).
5. **Drain-preserve-replay ordering** — supplement → normal queued user turn, control seed (compact hand-off) before its dependent turn, user prompts in original `dispatchOrdinal` order; no loss, no double-dispatch (Task 5).

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `server/transcript-writer.ts` (modify) | `beginRebuild()` state transition; durable `rebuild-pending` recovery batch; `pendingRebuilds` persistence/restore; `rebuildAdmissionPending` flag | 1 |
| `server/transcript-sidecar.ts` (modify) | `recovery` batchType helpers for rebuild-pending payload (reuse existing `makeCommitV2`); fold ignores non-public recovery rows for projection | 1 |
| `server/session-manager.ts` (modify) | admission control (send/scheduled/fork/discard/Side Chat pre-seed); live anomaly detection; `quiesceEligible`; `pendingRebuilds` auto-scheduler + event re-evaluation; `beginQuiesceForRebuild`/`drainInputQueue`/resume replay; `rebuild-waiting`/`deferRebuild` | 2,3,4,5,6 |
| `server/session-pump.ts` (modify) | turn-end / background-terminal hooks notify the scheduler | 4 |
| `shared/ws-protocol.ts`, `server/ws-protocol.ts`, `src/ws-types.ts` (modify) | `WsRebuildWaiting` frame; `REBUILD_REQUIRED` send/reject reason | 2,6 |
| `server/routes/sessions.ts` (modify) | `POST /sessions/:id/transcript/defer-rebuild`; REBUILD_REQUIRED 409 mapping | 2,6 |
| `src/session-store/{types,reducer}.ts`, `src/session-sync/session-synchronizer.ts` (modify) | `rebuild-waiting` state + `deferRebuild` action | 6 |
| `src/components/Composer.tsx` (modify) | `rebuild-waiting` actionable banner (task-stop / Retry / defer) | 6 |

The ordered-rebuild algorithm (`reconcileOrdered`/`buildOrderedProjection`), capability gate, `transcript-rebased` envelope, and `classifyPendingInputs`/`recoverPendingInputs` already exist (T7a/T7b/T7c/T8a/sidecar-crash-recovery) — this plan WIRES the live trigger + scheduler + drain-replay around them, it does not rebuild them.

---

### Task 1: Writer rebuild-pending state machine + durable pending payload

**Files:**
- Modify: `server/transcript-writer.ts` (`beginRebuild`, `pendingRebuilds` persistence, `rebuildingFlag`), `server/transcript-sidecar.ts` (recovery-batch helper)
- Test: `server/transcript-writer.test.ts`, `server/transcript-sidecar.test.ts`

**Interfaces:**
- Consumes: existing `deferOldCommit`/`addPendingRebuild`/`abortRebuild(outcome)`/`rebuilding` getter; `makeCommitV2({batchType:'recovery'})`; `PendingOperation` (`server/transcript-reconcile.ts`).
- Produces:
  - `TranscriptWriter.beginRebuild(op: PendingOperation): Promise<void>` — sets `rebuildingFlag`, durably appends a non-public `recovery` batch carrying `{kind:'rebuild-pending', operationId, payload: op.entry.msg, dispatchOrdinal}` + commit (fsync), and adds `op` to `pendingRebuilds`. No seq, no ring, no WS frame.
  - `TranscriptWriter.pendingRebuilds` survives reload: a pure `readPendingRebuilds(rows): PendingOperation[]` in transcript-sidecar extracts committed `rebuild-pending` recovery rows not superseded by a later committed generation (mirrors `unsupersededCorrupt` logic).
  - `abortRebuild('cancelled'|'failed')` (exists) releases deferred old commits in order and retains `pendingRebuilds`; extend to clear `rebuildAdmissionPending` (Task 2 owns the flag).

- [ ] **Step 1: Write failing tests** — `beginRebuild` persists a `rebuild-pending` recovery batch (fsync before resolve), allocates no seq, publishes nothing; `readPendingRebuilds` recovers the payload from committed rows and drops it once a newer generation commits; `abortRebuild('failed')` sets degraded + retains pending.
- [ ] **Step 2: Run red** — `npx vitest run server/transcript-writer.test.ts server/transcript-sidecar.test.ts -t "rebuild-pending"`. Expected: FAIL (beginRebuild/readPendingRebuilds absent).
- [ ] **Step 3: Implement** per signatures. The recovery batch uses `batchType:'recovery'` (already ignored by `foldSidecarRowsV2` projection); `readPendingRebuilds` is pure and unit-tested.
- [ ] **Step 4: Run green** — same command + full `transcript-writer.test.ts`/`transcript-sidecar.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(transcript): writer rebuild-pending state + durable pending payload`.

---

### Task 2: rebuildAdmissionPending admission control

**Files:**
- Modify: `server/session-manager.ts` (holder flag + admission gates), `shared/ws-protocol.ts`/`server/ws-protocol.ts`/`src/ws-types.ts` (REBUILD_REQUIRED reason), `server/routes/sessions.ts` (409 mapping)
- Test: `server/session-manager.test.ts`, `server/routes/sessions.test.ts`

**Interfaces:**
- Consumes: Task 1 `beginRebuild`/`abortRebuild`; holder (`TranscriptHolder`).
- Produces: `TranscriptHolder.rebuildAdmissionPending?: boolean`. While set: `send`/`sendContent`/scheduled-send fire/fork/discard/Side Chat pre-seed reject with `HttpError(409, 'REBUILD_REQUIRED')`; due scheduled sends marked deferred (retried in order after resume). Permanent delete still proceeds (tombstones pending payload). Cleared when the pending operation enters the committed generation OR `abortRebuild('cancelled')`.

- [ ] **Step 1: Write failing tests** — admission rejected for send/fork/discard while `rebuildAdmissionPending`; restored after commit and after `abortRebuild('cancelled')`; permanent delete unaffected; due scheduled send deferred not lost.
- [ ] **Step 2: Run red** — targeted Vitest. Expected: FAIL (no admission gate).
- [ ] **Step 3: Implement** the flag + gates at the existing mutation entry points (reuse `assertTranscriptMutable` pattern; add a distinct `assertRebuildAdmission`). Map REBUILD_REQUIRED to 409 in the route `onError`.
- [ ] **Step 4: Run green** — targeted + full manager suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(transcript): rebuildAdmissionPending closes transcript mutations`.

---

### Task 3: Live anomaly detection → REBUILD_REQUIRED

**Files:**
- Modify: `server/session-manager.ts` (live result/completion append path), `server/transcript-reconcile.ts` (pure detection helper)
- Test: `server/transcript-reconcile.test.ts`, `server/session-manager.test.ts`

**Interfaces:**
- Consumes: Task 1 `beginRebuild`; `TurnAnchorStore` turn-terminal membership; `decideReconcile`/`semanticEquivalent`; the live result append point (`recordResultFrame` pump dep + `recordTranscriptFor`).
- Produces: pure `detectRebuildTrigger(old: ProjectionEntry[], incoming: ProjectionEntry, anchors): 'append-only' | 'rebuild-required'` — returns `rebuild-required` when the incoming result/completion's canonical turn-terminal position precedes the current tail, or a same-resultUuid semantic revision (`semanticEquivalent` false). On `rebuild-required` the live path calls `beginRebuild` + sets `rebuildAdmissionPending` + returns REBUILD_REQUIRED instead of head-appending; the triggering frame is NOT broadcast.

- [ ] **Step 1: Write failing tests** — (a) incident-shape result belonging mid-history → `rebuild-required`; (b) same resultUuid semantic revision → `rebuild-required`; (c) **normal tail result → append-only (no trigger)**; (d) **normal mid-turn queued send → no trigger** (T7b guarantee). Manager-level: a live result that belongs mid-history persists rebuild-pending + rejects the next send, does NOT head-append.
- [ ] **Step 2: Run red** — targeted Vitest. Expected: FAIL (detection absent; result head-appends).
- [ ] **Step 3: Implement** the pure detector + wire it into the live result/completion append before `recordTranscriptFor`. Keep ordinary tail append on the existing fast path (no full canonical compose per result — use turn-terminal anchors).
- [ ] **Step 4: Run green** — targeted + full manager + transcript-reconcile suites. Expected: PASS (negative cases c/d prove no false triggers).
- [ ] **Step 5: Commit** `feat(transcript): detect live chronology anomaly and signal REBUILD_REQUIRED`.

---

### Task 4: quiesceEligible + pendingRebuilds auto-scheduler

**Files:**
- Modify: `server/session-manager.ts` (predicate + scheduler + event hooks), `server/session-pump.ts` (turn-end/background-terminal notify)
- Test: `server/session-manager.test.ts`, `server/session-pump.test.ts`

**Interfaces:**
- Consumes: Task 1-3 (`pendingRebuilds`, `rebuildAdmissionPending`, detection); `phaseOf`, `backgroundSubagentCount`, plugin invocation registry, `subscriptionHub.allSubscribersCapable`.
- Produces:
  - `quiesceEligible(s: Session): boolean` — true when no executing tool/turn work, no active/waiting background task, no accepted plugin invocation, no in-flight send; broker-blocked (pending permission/elicitation/dialog only) IS eligible; `queuedInputs>0` rejects only with an executing turn/tool.
  - `schedulePendingRebuilds(id)` — fires the rebuild (Task 5 executor) when `pendingRebuilds` non-empty AND `quiesceEligible` AND capability-capable; invoked from `onTurnSettling` (turn idle), background-terminal, in-flight settle, capability change, process recovery, and explicit Retry. Re-evaluates on each event; blocker uncleared → retain + wait (no loop).

- [ ] **Step 1: Write failing tests** — pending rebuild auto-fires when the turn idles; does NOT fire while a turn/tool executes or a background task runs; re-evaluates on background terminal; capability-incapable → no fire (refusal handled Task 5).
- [ ] **Step 2: Run red** — targeted Vitest. Expected: FAIL (no scheduler).
- [ ] **Step 3: Implement** the predicate + scheduler + pump hooks. The scheduler is idempotent (a rebuild already in flight is not re-fired).
- [ ] **Step 4: Run green** — targeted + full manager + pump suites. Expected: PASS.
- [ ] **Step 5: Commit** `feat(transcript): quiesceEligible + event-driven pendingRebuilds scheduler`.

---

### Task 5: Full quiesce → drain-preserve → rebuild → resume replay

**Files:**
- Modify: `server/session-manager.ts` (`beginQuiesceForRebuild`, `drainInputQueue`, resume replay; extend the retry executor)
- Test: `server/session-manager.test.ts`

**Interfaces:**
- Consumes: Task 1-4; `reconcileOrdered` (rebuild algorithm + envelope), `classifyPendingInputs`/`recoverPendingInputs` (T7b), `interrupt`/`unload`/`resume`, `sendControlMessage`.
- Produces: the auto-rebuild executor (refactors `retryTranscriptReconcile`'s quiesce leg into a shared `quiesceAndRebuild(id, {preserveQueued})`):
  1. stop new sends; new subscribes held pending by the hub (capability check, auto-takeover on resume, reset/attached before live); incapable → `client-upgrade-required`.
  2. broker-blocked: `beginQuiesceForRebuild()` closes model continuation/tool admission, interrupts the waiting turn WITHOUT withdrawing queued input, settles broker (`denyAll/cancelAll({reason:'transcript-rebuild'})`, await SDK awaiters).
  3. `drainInputQueue()` preserves user/supplement/control entries' payload + queueEntryId + type + `dispatchOrdinal`, writes them back as `drained-to-pending` in the same batch (NOT withdrawal; `classifyPendingInputs` must not auto-re-dispatch them).
  4. interrupt/destroy provider, await pump end, mark `terminated:'transcript_rebuild_required'`, await accepted appends.
  5. `reconcileOrdered` rebuild; on capability refusal/failure `abortRebuild(outcome)` (cancelled restores old headSeq + provider/admission; failed keeps fenced read-only).
  6. resume replays by `dispatchOrdinal`: supplement → normal queued user turn, control → `sendControlMessage` (compact hand-off seed before its dependent turn), user → original order; start new pump. Pending modal does not migrate.

- [ ] **Step 1: Write failing tests** — a live session with queued user + supplement + control seed undergoes auto-rebuild: queued inputs are PRESERVED (not withdrawn), replayed in dispatchOrdinal order after rebuild (supplement→user, control before dependent turn); the `transcript-rebased` envelope precedes new-generation frames; capability refusal restores the old projection + retains pending; failed rebuild keeps fenced read-only.
- [ ] **Step 2: Run red** — targeted Vitest. Expected: FAIL (current retry withdraws queued inputs; no drain-preserve-replay).
- [ ] **Step 3: Implement** `quiesceAndRebuild` + drain/replay; route both the auto-scheduler (Task 4) and explicit Retry through it (`preserveQueued:true` for auto, the existing Retry semantics reconciled). Extend `classifyPendingInputs` to recognize `drained-to-pending` (no auto-re-dispatch).
- [ ] **Step 4: Run green** — targeted + full manager + steering + native e2e suites. Expected: PASS.
- [ ] **Step 5: Commit** `feat(transcript): drain-preserve-replay quiesced rebuild`.

---

### Task 6: rebuild-waiting status + deferRebuild + integration regression + docs

**Files:**
- Modify: `server/session-manager.ts` (blocker status + defer), `shared/ws-protocol.ts`/`server/ws-protocol.ts`/`src/ws-types.ts` (`WsRebuildWaiting`), `server/routes/sessions.ts` (`POST /transcript/defer-rebuild`), `src/session-store/{types,reducer}.ts`, `src/session-sync/session-synchronizer.ts`, `src/components/Composer.tsx`
- Test: `server/session-manager.test.ts`, `src/session-store/reducer.test.ts`, `src/session-sync/session-synchronizer.seq.test.ts`
- Docs: move `.agents/notes/proposed/architecture/2026-11-16-transcript-ordered-reconcile.md` auto-trigger section to implemented (or a new note); update spec §8.1 status.

**Interfaces:**
- Consumes: Task 1-5; `abortRebuild('cancelled')`; existing recovery banner (T7c-7).
- Produces:
  - `WsRebuildWaiting { kind:'rebuild-waiting'; sessionId; blockers: Array<'background-task'|'plugin-invocation'|'turn'|'client-upgrade'>; pendingOperationCount: number }` — emitted when a pending rebuild is blocked long-term; cleared when it fires/aborts.
  - `deferRebuild(id)` (route `POST /sessions/:id/transcript/defer-rebuild`) → `abortRebuild('cancelled')` restores provider/admission, pauses auto-scheduling, retains pending payload + a warning; client action alongside task-stop/Retry.
  - Client: `rebuild-waiting` reducer state + Composer actionable banner (task-stop / Retry / defer buttons), generation-guarded.

- [ ] **Step 1: Write failing tests** — a pending rebuild blocked by a running background task emits `rebuild-waiting {blockers:['background-task'], pendingOperationCount}`; `deferRebuild` restores admission + pauses scheduling + retains payload; the banner renders the three actions; end-to-end integration: live incident-shape anomaly → auto REBUILD_REQUIRED → quiesce → rebuild → envelope → resume replay (crash-after-pending recovery variant included).
- [ ] **Step 2: Run red** — targeted Vitest. Expected: FAIL.
- [ ] **Step 3: Implement** the frame + defer route + client state/banner + integration seams.
- [ ] **Step 4: Run green** — targeted + full manager + client store/sync suites.
- [ ] **Step 5: Full verification + review + commit** — `npm run typecheck && npm run test && npm run lint && npm run verify:agent-notes`; full-diff `code-review`, fix confirmed findings (RED→GREEN), re-review non-trivial fixes; then commit `feat(transcript): rebuild-waiting status, deferRebuild, and auto-rebuild integration`.

---

## Self-Review

**1. Spec coverage:** §8.1 writer rebuild-pending/exclusive + durable payload → Task 1; rebuildAdmissionPending → Task 2; live REBUILD_REQUIRED detection (result position/revision) → Task 3; quiesceEligible + auto-schedule + event re-evaluation → Task 4; beginQuiesceForRebuild/drainInputQueue/drained-to-pending/resume replay → Task 5; rebuild-waiting/deferRebuild → Task 6; §8.3 capability gate + envelope reused (T7a/T8a) and exercised in Tasks 4/5; §9 crash-after-pending recovery → Task 1 + Task 6 integration. lifecycleEpoch remains deferred (no producer; T7c ruling) — not silently dropped.

**2. Step scan:** each step is one action (write test / run red / implement signature / run green / commit); implementation steps give signatures + spec pointers, not bodies. No TBD lines.

**3. Type consistency:** `PendingOperation`/`ReconcileInput`/`TranscriptHolder`/`makeCommitV2`/`classifyPendingInputs`/`reconcileOrdered`/`retryTranscriptReconcile` consumed by name match existing modules. New names (`beginRebuild`, `readPendingRebuilds`, `rebuildAdmissionPending`, `detectRebuildTrigger`, `quiesceEligible`, `schedulePendingRebuilds`, `quiesceAndRebuild`, `drainInputQueue`, `deferRebuild`, `WsRebuildWaiting`) defined once, consumed consistently.

**4. Review Focus:** all five lines have tests — RF1 Task 3 (c/d), RF2 Task 1 + Task 6, RF3 Task 4/5, RF4 Task 6, RF5 Task 5.

**5. Proportion:** six tasks wiring the live trigger + scheduler + drain-replay around existing tested rebuild machinery; the plan pins files/signatures/tests and points to spec sections for algorithm detail. Tasks 1-2 are foundation (writer state + admission), Task 3 is the detection trigger, Task 4 the scheduler, Task 5 the execution (the riskiest — drain-preserve-replay replaces the current withdrawal simplification), Task 6 the blocker UX + integration. Task 5 must run the steering + native e2e suites (queued-input replay touches the dispatch path T7b built).

**Known coupling risks for the executor:** Task 3 detection must NOT compose full canonical per result (perf) — use turn-terminal anchors; the negative cases (normal tail result, normal queued send) are the T7b guarantee and must stay green. Task 5's `drained-to-pending` must be recognized by `classifyPendingInputs` so recovery does not auto-re-dispatch drained inputs (extends T7b Task 6). The capability gate already lives in `reconcileOrdered`; the auto path pre-checks and handles refusal via `abortRebuild('cancelled')` without tearing down a healthy session.