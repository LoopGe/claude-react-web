# Transcript Queued-Not-Published Send Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate a queued root prompt's durability from its public seq so a normal mid-turn send stays append-only (`P1,A1,R1,U2`) instead of forming a live `A,U,R` chronology inversion, with crash-safe dispatch states and a multi-tab queued-bubble contract.

**Architecture:** The per-session `TranscriptWriter` (already built + unit-tested in `server/transcript-writer.ts`, currently UNWIRED) becomes the send path's durable dispatch owner. Idle sends dispatch + materialize immediately (behavior-preserving); a root prompt arriving while a prior turn is unresolved commits `queued-not-published` (no public seq, no ring) and materializes at the prior turn's terminal in `dispatchOrdinal` order. A new `message-queued` msgstat frame carries the queued bubble to other tabs; `clientOperationId` makes dispatch idempotent and reconciles optimistic placeholders. This is the prerequisite for automatic live rebuild triggers (turn-end `REBUILD_REQUIRED`): once normal queued input is append-only, a rebuild trigger fires only on genuine anomalies.

**Tech Stack:** TypeScript, Node 20 `node:fs/promises`, Hono, Vitest (server Node env, client happy-dom), React 19 session-store reducer.

**Spec:** `docs/superpowers/specs/2026-11-16-transcript-ordered-reconcile-design.md` — §8.1 (single writer, dispatchQueue, "Queued root prompt", rebuild drain), §7.2 (empty-canonical / dispatch-unknown recovery), §7.3 (withdrawal-intent / withdrawal-unknown), §8.3 (clientOperationId, lifecycleEpoch, placeholder reconciliation), §10 (attachment-lease coupling). Section references below (§N) point into that spec; the spec owns algorithm detail. This plan pins files, signatures, values and the tests that prove each task.

## Global Constraints

- Durable-before-publish: a frame enters ring/WS only after its batch commit record is fsynced (§8.1). The provider call NEVER holds `writerQueue`; `dispatchQueue` is separate so a synchronous native direct hand-off `onUserMessageConsumed` can re-enter the writer (§8.1).
- Dispatch states: `enqueue-not-attempted` → `enqueue-attempted` committed BEFORE the provider call; only `enqueue-not-attempted` auto-retries; `enqueue-attempted`-then-crash = `dispatch-unknown` (user decides, NO auto re-execution) (§8.1, §7.2).
- `queued-not-published` allocates NO public seq and enters NO ring; other tabs see the queued bubble via the input-queue-status (msgstat) channel; the sending tab uses its optimistic placeholder (§8.1).
- Normal queued turns stay append-only; the historical live `A,U,R` is repaired once at migration, not per-send (§8.1, §14.1).
- `msg` in the seq subsystem stays the SDK-free live wire shape (`unknown`); do not import `@anthropic-ai/claude-agent-sdk` into the browser bundle.
- Withdrawal: `interrupt(cancelQueued)` writes withdrawal-intent candidates only; echo/turnActive/assistant-work cancels the intent; still-unpaired + confirmed drain commits retraction; drain-unknown → `withdrawal-unknown`, NO auto re-enqueue (§7.3).
- Attachment leases referenced by `queued-not-published`/`enqueue-*` durable states stay valid until the state resolves (§10 implementation constraint).
- All diagnostics via `createLogger(scope)`; metrics labels are finite enums (never session ids/uuids).
- TDD: failing test first, run red, implement, run green, commit. `npm run typecheck` (all tsconfigs) + targeted Vitest before each commit.
- Work on `main` (user consent established) unless the executor chooses a worktree. Commit ONLY touched files via explicit `git add` (the working tree may carry unrelated parallel-session changes).

## Review Focus

Input classes most likely to bite a real user; each gets a test in the owning task.

1. **POST ACK lost, client retries the same send** — must NOT mint a second prompt; the retry reuses `clientOperationId` and returns the original ACK (Task 3).
2. **Crash after `queued-not-published` commit, before the prior turn's terminal** — restart materializes the prompt at the prior turn's terminal in provider order, exactly once, and re-dispatches it (Task 6).
3. **Crash after `enqueue-attempted`, provider may or may not have taken the prompt** — restart enters `dispatch-unknown`, never auto re-executes; user chooses (Task 6).
4. **Stop (`interrupt cancelQueued`) while a prompt is `queued-not-published` (not yet in the SDK queue)** — the queued bubble is withdrawn visibly on every tab; a drain whose outcome is unknown enters `withdrawal-unknown`, not silent loss or auto re-send (Task 5).
5. **Two tabs, one sends mid-turn** — the non-sending tab paints a queued bubble from `message-queued` and replaces it with the real seq-carrying frame at materialization, no duplicate (Task 4).

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `server/session-manager.ts` (modify) | per-session writer ownership; `publishUserMessage` split (D1); route send/dispatch through writer; async `onTurnSettling` materialization; interrupt drain of writer queue | 1, 2, 5 |
| `server/transcript-writer.ts` (modify) | `nextDispatchOrdinal`; `inputCommit` carries payload (D7); `publishQueued` hook; `drainQueued` for withdrawal | 1, 2, 5, 6 |
| `server/session-pump.ts` (modify) | `onTurnSettling` → async; pump awaits it before `moreQueued` (D3) | 2 |
| `server/transcript-sidecar.ts` (modify) | pure `classifyPendingInputs` (last state per operationId → pending-input view, D7) | 6 |
| `shared/ws-protocol.ts`, `server/ws-protocol.ts`, `src/ws-types.ts` (modify) | `WsMessageQueued` frame; `clientOperationId` on send response | 2, 3 |
| `shared/send-body.ts` (modify) | accept optional `clientOperationId` | 3 |
| `server/routes/sessions.ts` (modify) | thread `clientOperationId` through send/sendContent; echo in response | 3 |
| `server/prompt-uuid-store.ts` or new `server/client-operation-store.ts` (create/modify) | persist `clientOperationId → {promptUuid, occurrenceId, dispatchState}` idempotency map | 3 |
| `src/session-store/{types,reducer,user-message-lifecycle}.ts` (modify) | `MESSAGE_QUEUED` action; placeholder reconciliation by clientOperationId; delivery-unknown | 3, 4 |
| `src/session-sync/session-synchronizer.ts` (modify) | route `message-queued` frame | 4 |
| composer send call site (modify) | generate `clientOperationId` before POST | 3 |

The writer (`TranscriptWriter`, `DispatchOp`, `WriterDeps`, `GenerationLedger`) already exists and is unit-tested; Tasks 1–2 WIRE it, they do not rebuild it. Pure fold/classification logic stays in `transcript-sidecar.ts`/`transcript-writer.ts`; I/O wiring lives in the manager.

## Dispatch Mechanics Design (resolved integration points)

The writer's `enqueueDispatch`/`materializeQueued` exist but are NOT turnkey: the idle path dispatches to the provider without materializing (no seq/publish), and `materializeQueued` is async while the pump's `onTurnSettling` hook is sync. These are the precise integration decisions the executor must follow.

### D1. `pushToSession` splits into bookkeeping + durable publish

`pushToSession(s, userMsg)` today does TWO jobs: (a) ring/lifecycle bookkeeping — `stampReceivedAt`, `pushBounded(s.history, …)`, `pendingTurns`/`workingSince`, `autoResumeCounts.delete`, `recapManager.invalidate`, `lastTurnSummary = undefined`, `persist`; and (b) seq + broadcast — `recordTranscriptFor` (store.record + fire-and-forget sidecar append) then `for (sub of s.subscribers) sub.push`. The writer replaces ONLY (b): `writer.appendDurable(userMsg)` does store.record + batch fsync + `deps.publish` (subscribers.push), durable-before-publish. Job (a) stays in the manager. Extract a `publishUserMessage(s, userMsg)` helper = job (a) + `await writer.appendDurable(userMsg)`; the old `recordTranscriptFor` call inside `pushToSession` is removed for the send path (the pump's assistant/result ingest keeps `recordTranscriptFor` unchanged — only user-prompt dispatch moves to the writer).

### D2. Idle dispatch ordering (behavior-preserving)

`dispatchUserMessage` becomes `async`. After `trySteerMessage` (unchanged, still first), the idle route is:
1. `recordPromptUuid(s, userMsg)` (BEFORE the provider call — native pairs inside enqueue).
2. `await writer.enqueueDispatch(op)` where the writer commits `enqueue-not-attempted` → `enqueue-attempted`, then calls `deps.dispatchUser(op)`.
3. `deps.dispatchUser` = `handle.enqueueUserMessage(forSdk)` + carry `consumedAt` back onto `userMsg` (`stampConsumedAt`) — the provider call. The writer releases `writerQueue` across this call, so a synchronous native `onUserMessageConsumed` → `commitLifecycle` re-enters freely (D4).
4. After `enqueueDispatch` resolves, `await publishUserMessage(s, userMsg)` (D1) — seq + broadcast + bookkeeping. `consumedAt` is already stamped (step 3), so the published frame carries it exactly as today.

Idle observable behavior (seq, ring, broadcast, consumedAt, pendingTurns) is unchanged; the only addition is the durable input-batch states + fsync barrier. `dispatchNewUserMessage` becomes async, `await`s `dispatchUserMessage`, and on rejection rolls back the anchor + the `promptUuids` entry (its existing catch). `send`/`sendContent` already run inside `opLock.run(async …)`; `assertTranscriptMutable` (T7c degraded fence) stays BEFORE dispatch.

### D3. Queued dispatch + turn-terminal materialization ordering

Mid-turn (`deps.isTurnActive()` true, not steered): `enqueueDispatch` commits `queued-not-published`, calls `deps.publishQueued(op)` (manager → `pushMessageStatus` `WsMessageQueued`), pushes to `writer.queued`, allocates NO seq, NO ring. The sending tab's optimistic placeholder is unaffected; other tabs paint the queued bubble (Task 4).

**The pump must await materialization.** `PumpDeps.onTurnSettling` becomes `(session, emptyResult) => Promise<void>`; the pump result handler `await`s it (`session-pump.ts:1797`) BEFORE reading `moreQueued = handle.queueDepth` (`:1798`). The manager's `onTurnSettling` impl: `drainAndRequeueSteered(s, emptyResult)` (unchanged, sync) THEN `if (!emptyResult) await writer.materializeQueued()`. `materializeQueued` per op: `await appendDurable(payload)` (seq + publish) THEN `deps.dispatchUser(op)` (provider enqueue → `queueDepth` rises). Because the pump awaits, `queueDepth` reflects the materialized prompts before `moreQueued`, so `pendingTurns`/`workingSince` stay correct. On an empty bookend (`emptyResult === true`) materialization is skipped (a background-task completion is not a turn terminal — mirrors `drainAndRequeueSteered`'s guard).

### D4. Native synchronous hand-off re-entrancy

The native provider consumes `enqueueUserMessage` synchronously and fires `onUserMessageConsumed` inside the call. That callback commits lifecycle metadata via `writer.commitLifecycle` (re-entrant `writerQueue`). This is safe ONLY because `enqueueDispatch` runs the provider call on `dispatchQueue`, NOT `writerQueue` — `writerQueue` is free during `dispatchUser`. The executor must NOT hold `writerQueue` across `dispatchUser`. `recordPromptUuid` precedes the call (D2 step 1) so the native pairing finds the entry. Run `server/providers/native/e2e-thinking-effort.test.ts` to pin this.

### D5. Writer coexistence with T7c reset writer + degraded fence

T7c landed `TranscriptWriter.forReset` (reset-only, used by compact) and `assertTranscriptMutable`. The dispatch writer (`writerFor`) is a SEPARATE per-session instance; its `GenerationLedger` is unused for live append (`appendDurable` reads `deps.generation()` = holder store generation, not the ledger). Reset generations are allocated only by the reset writer at idle compact; live append never allocates a generation, so the two ledgers cannot conflict. Both writers append to the same sidecar, whose internal serial queue orders the batches. `writerFor`'s `appendDurable` must reject when the holder is degraded (the writer's `degradedFlag` is set via `abortRebuild('failed')`; the manager also fences send via `assertTranscriptMutable` before dispatch). On unload/delete, drop the dispatch writer instance alongside `transcriptStores`/`resetJournals`.

### D6. dispatchOrdinal + operationId

`writer.nextDispatchOrdinal()` returns a per-session monotonic uint53 (add a counter). `operationId` = the prompt's server uuid (`userMsg.uuid`) for user ops — stable across the input-batch states and the withdrawal/recovery paths. `clientOperationId` (Task 3) is carried on the op for idempotency but is distinct from `operationId`.

### D7. Crash-recovery fold classification (Task 6)

Input batches (`batchType:'input'`, rows `{operationId, dispatchOrdinal, state, route?}`) are committed throughout dispatch but `foldSidecarRowsV2` currently ignores them for the projection. Add a pure `classifyPendingInputs(rows): PendingInputView` that, per `operationId`, takes the LAST committed input/lifecycle state and classifies:
- latest `queued-not-published` (no later materialize/withdraw) → a `PendingOperation` to materialize at the prior turn's terminal in canonical order (the prompt never reached the provider; safe to dispatch). Its payload is recovered from the input batch's stored `payload` (the input row must carry the userMsg payload — add it in Task 1's `inputCommit`).
- latest `enqueue-not-attempted` → auto-retry (re-dispatch; the provider never saw it).
- latest `enqueue-attempted` with NO provider echo / consumed lifecycle / turn terminal evidence → `dispatch-unknown`: surface for manual recovery, NEVER auto re-dispatch (§7.2). Evidence that the provider took it (a matching `v` echo in the JSONL, a `consumed` lifecycle row, or the prompt's assistant turn in canonical) resolves it to dispatched (drop from pending).
- latest `withdrawn` → tombstone (already evicted; exclude from pending).

`classifyPendingInputs` is pure (rows in, view out) and unit-tested in `transcript-sidecar.test.ts`. The manager's reconcile feeds the `queued-not-published`/`enqueue-not-attempted` ops into `ReconcileInput.pending` (buildOrderedProjection includes each exactly once, §7.4) and re-dispatches them after the projection commits; `dispatch-unknown` ops are surfaced (degraded-style recovery prompt), not dispatched. Materialization on recovery uses the same `publishUserMessage` + `dispatchUser` path as live (D1/D2).

---

### Task 1: Per-session writer + durable dispatch for idle sends (behavior-preserving)

**Files:**
- Modify: `server/session-manager.ts` (writer ownership; `dispatchNewUserMessage`/`dispatchUserMessage` async; `recordTranscriptFor` publish path)
- Test: `server/session-manager.test.ts` (extend the transcript seq store describe)

**Interfaces:**
- Consumes: `TranscriptWriter`, `DispatchOp`, `WriterDeps` from `server/transcript-writer.ts` (existing); `TranscriptSidecar.appendBatch`; `TranscriptStore.record`.
- Produces:
  - `SessionManager` field `private readonly transcriptWriters = new Map<string, TranscriptWriter>()` and `private writerFor(id: string): TranscriptWriter` (lazily constructs with `WriterDeps` bound to the session's sidecar/store/provider handle; `isTurnActive: () => s.pendingTurns > 0 || s.turnActive === true`; `generation: () => holder.store.generation`).
  - `dispatchUserMessage` becomes `async`; idle root dispatch routes through `writer.enqueueDispatch({operationId, dispatchOrdinal, kind:'user', payload: userMsg, clientOperationId?})` whose `dispatchUser` dep performs the existing `recordPromptUuid` + `handle.enqueueUserMessage` + consumed-stamp, and whose materialization performs the existing `pushToSession` broadcast+seq. Idle observable behavior (broadcast + seq + consumedAt) is UNCHANGED.
  - `dispatchOrdinal`: per-session monotonic counter on the writer (add `nextDispatchOrdinal(): number` to `TranscriptWriter`).

- [ ] **Step 1: Write the failing test** — `server/session-manager.test.ts`

```ts
it('idle send commits enqueue-attempted BEFORE the provider call and still broadcasts + seqs', async () => {
  const info = await sm.create({ cwd: TEST_CWD })
  const order: string[] = []
  const h = mockHandles[0]
  const origEnqueue = h.enqueueUserMessage // spy via the claude handle wrapper
  // observe: input batch state rows precede the provider enqueue
  const sent = await sm.send(info.id, 'hello')
  expect(await waitFor(() => sm.transcriptHead(info.id)?.headSeq === 1)).toBe(true)
  const rows = await new TranscriptSidecar(dir, info.id).load()
  const states = rows.filter((r) => r.operationId).map((r) => r.state)
  expect(states).toEqual(['enqueue-not-attempted', 'enqueue-attempted'])
  // observable behavior preserved: the prompt is in the seq space + ring
  const win = await sm.getTranscriptWindow(info.id)
  expect((win.messages[0].msg as { message: { content: string } }).message.content).toBe('hello')
})
```

- [ ] **Step 2: Run red** — `npx vitest run server/session-manager.test.ts -t "idle send commits enqueue-attempted"`. Expected: FAIL (no input-batch state rows; writer unwired).

- [ ] **Step 3: Implement** writer ownership + async idle dispatch per **D1/D2/D4/D5/D6**. Extract `publishUserMessage` (bookkeeping + `writer.appendDurable`, D1); `dispatchUserMessage` async idle route = recordPromptUuid → `enqueueDispatch` (dispatchUser dep = provider enqueue + consumedAt stamp) → `publishUserMessage` (D2). Keep `trySteerMessage` first (unchanged). `dispatchNewUserMessage` async + rollback on rejection. `writerFor` builds WriterDeps bound to the holder sidecar/store/handle; drop it on unload/delete (D5). Add `nextDispatchOrdinal()` (D6) and make `inputCommit` store the op `payload` on the input row (needed by Task 6 recovery, D7). Do NOT change steering, requeue, or `onInputConsumed`; do NOT hold writerQueue across dispatchUser (D4).

- [ ] **Step 4: Run green** — same command. Expected: PASS. Then run the full `server/session-manager.test.ts` + `server/session-manager-steering.test.ts` + `server/providers/native/e2e-thinking-effort.test.ts` (native sync hand-off must still pair uuids). Expected: PASS (behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add server/session-manager.ts server/transcript-writer.ts server/session-manager.test.ts
git commit -m "feat(transcript): wire per-session writer durable dispatch for idle sends"
```

---

### Task 2: queued-not-published branch + turn-terminal materialization

**Files:**
- Modify: `server/session-manager.ts` (`onTurnSettling` async materialization trigger), `server/transcript-writer.ts` (`publishQueued` hook), `server/session-pump.ts` (`onTurnSettling` → async, pump awaits it before `moreQueued` — **D3**)
- Modify: `shared/ws-protocol.ts`, `server/ws-protocol.ts`, `src/ws-types.ts` (`WsMessageQueued`)
- Test: `server/session-manager.test.ts`, `server/frame-bridge.test.ts`, `server/session-pump.test.ts`

**Interfaces:**
- Consumes: Task 1 `writerFor`, `writer.enqueueDispatch`, `writer.materializeQueued`; `pushMessageStatus`.
- Produces:
  - `WsMessageQueued { kind:'message-queued'; sessionId; uuid; message: unknown; clientOperationId?: string }` — rides the msgstat channel, NO seq. Added to `WsServerFrame` union + the msgstat drive loop in `frame-bridge.ts`.
  - Mid-turn root dispatch (`isTurnActive()` true, not steered): `enqueueDispatch` commits `queued-not-published`, pushes `WsMessageQueued` via a new `WriterDeps.publishQueued(op)` hook (manager wires to `pushMessageStatus`), allocates NO seq, does NOT ring/broadcast the real frame.
  - `PumpDeps.onTurnSettling` becomes `(session, emptyResult) => Promise<void>`; the pump result handler `await`s it BEFORE reading `moreQueued` (**D3**, `session-pump.ts:1797-1798`). Manager impl: `drainAndRequeueSteered` (sync, unchanged) THEN `if (!emptyResult) await writer.materializeQueued()` — each queued op: `appendDurable` (seq + real broadcast) then `dispatchUser` (provider enqueue raises queueDepth), in `dispatchOrdinal` order. The await guarantees queueDepth reflects materialized prompts before the working-state decision.

- [ ] **Step 1: Write the failing test** — `server/session-manager.test.ts`

```ts
it('a mid-turn root prompt is queued-not-published and materializes after the prior result (A,R,U append-only)', async () => {
  const info = await sm.create({ cwd: TEST_CWD })
  await sm.send(info.id, 'turn1')                 // seq 0 (U1)
  emitAssistant('A', 'mA', 'reply')               // seq 1
  const queued = await sm.send(info.id, 'turn2')  // mid-turn → queued-not-published
  // No public seq for turn2 yet: headSeq still 2, no ring broadcast of turn2
  expect(sm.transcriptHead(info.id)?.headSeq).toBe(2)
  const rows = await new TranscriptSidecar(dir, info.id).load()
  expect(rows.some((r) => r.state === 'queued-not-published')).toBe(true)
  mockHandles[0].emit({ type: 'result', subtype: 'success', uuid: 'R', session_id: info.id }) // seq 2 (R1)
  // turn2 materializes AFTER the result: order U1,A,R1,U2
  expect(await waitFor(() => sm.transcriptHead(info.id)?.headSeq === 4)).toBe(true)
  const win = await sm.getTranscriptWindow(info.id)
  expect(win.messages.map((m) => (m.msg as { uuid?: string }).uuid)).toEqual([expect.any(String), 'A', 'R', queued.uuid])
  expect(win.generation).toBe(0) // no rebuild
})
```

- [ ] **Step 2: Run red** — `npx vitest run server/session-manager.test.ts -t "queued-not-published and materializes"`. Expected: FAIL (turn2 gets an immediate seq today).

- [ ] **Step 3: Implement** the queued branch + `publishQueued` hook + `WsMessageQueued` frame + turn-terminal materialization per **D3**. Make `onTurnSettling` async + pump awaits it before `moreQueued`; materialization runs only on a REAL result (`emptyResult === false`), after `drainAndRequeueSteered`. Add a `session-pump.test.ts` case pinning that a queued prompt materialized at turn end keeps `pendingTurns=1` (moreQueued sees the raised queueDepth) — the async-ordering regression guard.

- [ ] **Step 4: Run green** — same command + `npx vitest run server/frame-bridge.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/session-manager.ts server/transcript-writer.ts shared/ws-protocol.ts server/ws-protocol.ts src/ws-types.ts server/frame-bridge.ts server/session-manager.test.ts server/frame-bridge.test.ts
git commit -m "feat(transcript): queued-not-published mid-turn prompts materialize at turn terminal"
```

---

### Task 3: clientOperationId idempotency + placeholder reconciliation

**Files:**
- Modify: `shared/send-body.ts`, `server/routes/sessions.ts`, `server/session-manager.ts`
- Create: `server/client-operation-store.ts` (persist `clientOperationId → {promptUuid, dispatchState}`; atomic write like `prompt-uuid-store.ts`)
- Modify: composer send call site; `src/session-store/user-message-lifecycle.ts`
- Test: `server/client-operation-store.test.ts`, `server/routes/sessions.test.ts`, `src/session-store/reducer.test.ts`

**Interfaces:**
- Consumes: Task 1–2 dispatch; `ackUserMessage`/`applyOptimisticUserMessage` (existing, `user-message-lifecycle.ts`).
- Produces:
  - send body gains optional `clientOperationId: string`; response gains `message.clientOperationId`.
  - `ClientOperationStore.record(id, clientOperationId, entry)` / `.get(id, clientOperationId)`; `sm.send`/`sendContent` accept `clientOperationId`, and a repeat key returns the ORIGINAL ack without re-dispatch (idempotent).
  - Client generates `clientOperationId` (= optimistic uuid) before POST; `ackUserMessage` reconciles the placeholder by `clientOperationId` first, then server uuid.

- [ ] **Step 1: Write the failing test** — `server/routes/sessions.test.ts`

```ts
it('a retried send with the same clientOperationId returns the original ack and does not dispatch twice', async () => {
  // first POST {text:'hi', clientOperationId:'op-1'} → {message:{uuid:U}}
  // second POST same clientOperationId → same uuid U; provider enqueue called ONCE
})
```

- [ ] **Step 2: Run red** — targeted Vitest. Expected: FAIL (no clientOperationId handling).

- [ ] **Step 3: Implement** the store + body/response threading + idempotent dispatch + client generation/reconciliation per signatures. Unprovable legacy placeholders (no mapping) enter `delivery-unknown`, never auto-retry (§8.3).

- [ ] **Step 4: Run green** — targeted files. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/send-body.ts server/routes/sessions.ts server/session-manager.ts server/client-operation-store.ts server/client-operation-store.test.ts server/routes/sessions.test.ts src/session-store/user-message-lifecycle.ts src/session-store/reducer.test.ts
git commit -m "feat(transcript): clientOperationId idempotent dispatch and placeholder reconciliation"
```

---

### Task 4: Client multi-tab queued-bubble contract

**Files:**
- Modify: `src/session-store/{types,reducer}.ts`, `src/session-sync/session-synchronizer.ts`
- Test: `src/session-sync/session-synchronizer.seq.test.ts`, `src/session-store/reducer.test.ts`

**Interfaces:**
- Consumes: Task 2 `WsMessageQueued`; Task 3 placeholder reconciliation; `pendingPlaceholders` (existing `ReadonlyMap<string, TranscriptItem>`).
- Produces: `{ type:'MESSAGE_QUEUED'; uuid; message; clientOperationId? }` reducer action rendering a queued bubble (no seq); the materialization `message` frame (seq-carrying) dedups/replaces the queued bubble by uuid; `deriveDeliveryStatus` shows queued until consumed.

- [ ] **Step 1: Write the failing test** — `session-synchronizer.seq.test.ts`

```ts
it('a non-sending tab paints a queued bubble from message-queued and replaces it on materialization', async () => {
  // dispatch {kind:'message-queued', uuid:'u2', message:{...}} → a queued item appears, no seq
  // dispatch {kind:'message', seq:3, generation:0, message:{uuid:'u2',...}} → ONE item, seq 3, not queued
})
```

- [ ] **Step 2: Run red** — targeted Vitest. Expected: FAIL (frame unhandled).

- [ ] **Step 3: Implement** the action + synchronizer routing + dedup per signatures. The queued bubble must NOT engage the seq window (no seq); materialization flows through the existing `WINDOW_LIVE` path and removes the queued placeholder by uuid.

- [ ] **Step 4: Run green** — targeted files. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-store/types.ts src/session-store/reducer.ts src/session-sync/session-synchronizer.ts src/session-sync/session-synchronizer.seq.test.ts src/session-store/reducer.test.ts
git commit -m "feat(transcript): client queued-bubble rendering and materialization dedup"
```

---

### Task 5: Withdrawal integration (interrupt drains the writer queue)

**Files:**
- Modify: `server/session-manager.ts` (`interrupt`), `server/transcript-writer.ts` (`drainQueued(): DispatchOp[]`)
- Test: `server/session-manager.test.ts` (interrupt with cancelQueued describe)

**Interfaces:**
- Consumes: Task 2 `writer.queued`; existing `withdrawHostQueue`, `pushMessageStatus`, `evictTranscriptAndBroadcast`.
- Produces: `TranscriptWriter.drainQueued(): DispatchOp[]` (removes + returns queued-not-published ops); `interrupt(cancelQueued)` drains BOTH the host Pushable AND the writer queue, unions the uuids into the existing withdrawal broadcast + tombstone path. Withdrawal-intent semantics per §7.3: a prompt with echo/turnActive cancels its intent; drain-unknown → `withdrawal-unknown` (no auto re-enqueue).

- [ ] **Step 1: Write the failing test** — `server/session-manager.test.ts`

```ts
it('Stop withdraws a queued-not-published prompt visibly on every tab', async () => {
  // turn1 in flight; turn2 queued-not-published (writer queue, NOT Pushable)
  // interrupt(cancelQueued) → messages-withdrawn includes turn2.uuid; turn2 absent from window after rebuild
})
```

- [ ] **Step 2: Run red** — targeted Vitest. Expected: FAIL (writer queue not drained).

- [ ] **Step 3: Implement** `drainQueued` + interrupt union per signatures. A `queued-not-published` op has no public seq yet — withdrawal commits a durable withdrawn input state (no seq tombstone needed); the client evicts the queued bubble by uuid via `messages-withdrawn`.

- [ ] **Step 4: Run green** — targeted files + the existing cancelQueued suite. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/session-manager.ts server/transcript-writer.ts server/session-manager.test.ts
git commit -m "feat(transcript): interrupt withdraws queued-not-published prompts"
```

---

### Task 6: Crash recovery + attachment-lease coupling

**Files:**
- Modify: `server/transcript-sidecar.ts` (fold input batches → pending-input view + dispatch-state classification), `server/transcript-writer.ts` (restore queued/pending on hydrate), `server/session-manager.ts` (reconcile materializes recovered queued ops; lease hold)
- Test: `server/transcript-sidecar.test.ts`, `server/transcript-writer.test.ts`, `server/session-manager.test.ts`

**Interfaces:**
- Consumes: Task 1–5 durable states; `foldSidecarRowsV2`; `ReconcileInput.pending` (`PendingOperation[]`, existing).
- Produces: fold classifies each input op's latest durable state; `queued-not-published` ops become `PendingOperation`s materialized at the prior turn's terminal in canonical order (exactly once); `enqueue-attempted`/`dispatch-unknown` ops surface for manual recovery (NO auto re-dispatch, §7.2). Attachment leases for pending durable states held until resolution (§10).

- [ ] **Step 1: Write the failing test** — `server/session-manager.test.ts`

```ts
it('crash after queued-not-published: restart materializes the prompt at the prior turn terminal, once', async () => {
  // turn1 + assistant in sidecar; turn2 queued-not-published; NO result yet; simulate restart (fresh manager)
  // provider JSONL has turn1+assistant; reconcile → turn2 materializes after the turn1 terminal, re-dispatched once
})
it('crash after enqueue-attempted: restart enters dispatch-unknown, never auto re-executes', async () => {
  // input batch enqueue-attempted, provider may have taken it; restart → dispatch-unknown, no auto enqueue
})
```

- [ ] **Step 2: Run red** — targeted Vitest. Expected: FAIL.

- [ ] **Step 3: Implement** per **D7**: pure `classifyPendingInputs(rows)` (last committed state per operationId → queued/not-attempted/attempted/withdrawn classification + dispatch-unknown evidence check), unit-tested first. Task 1's `inputCommit` must store the userMsg `payload` on the input row so recovery can re-materialize. Manager reconcile feeds queued/not-attempted ops into `ReconcileInput.pending` (buildOrderedProjection includes each exactly once, §7.4), re-dispatches via `publishUserMessage`+`dispatchUser` after commit; `dispatch-unknown` surfaced, NEVER auto-dispatched. Attachment leases for pending states held until resolution (§10).

- [ ] **Step 4: Run green** — targeted files + `server/transcript-incident.test.ts` (regression). Expected: PASS.

- [ ] **Step 5: Full verification + commit**

```bash
npm run typecheck && npm run lint && npm run test
git add server/transcript-sidecar.ts server/transcript-writer.ts server/session-manager.ts server/transcript-sidecar.test.ts server/transcript-writer.test.ts server/session-manager.test.ts
git commit -m "feat(transcript): crash-safe queued-input recovery and attachment-lease coupling"
```

---

## Self-Review

**1. Spec coverage:** §8.1 dispatchQueue + enqueue states → Task 1; queued-not-published + materialization → Task 2; clientOperationId idempotency + placeholder reconciliation → Task 3; multi-tab queued bubble (§8.1 "其他已连接 tab") → Task 4; withdrawal-intent/unknown (§7.3) → Task 5; crash recovery + dispatch-unknown (§7.2) + attachment lease (§10) → Task 6. lifecycleEpoch (§8.3) is carried by the existing consumed/steered lifecycle frames + the input-batch states; a dedicated epoch counter is deferred to T7c's attached-epochs work (noted, not silently dropped).

**2. Step scan:** each step is one action (write test / run red / implement signature / run green / commit). Implementation steps give signatures + spec pointers, not bodies. No TBD lines.

**3. Type consistency:** `TranscriptWriter`/`DispatchOp`/`WriterDeps`/`PendingOperation`/`ReconcileInput` consumed by name match the existing modules. New names (`writerFor`, `nextDispatchOrdinal`, `publishQueued`, `drainQueued`, `WsMessageQueued`, `MESSAGE_QUEUED`, `ClientOperationStore`) defined once and consumed consistently. `clientOperationId` optional throughout (backward compatible).

**4. Review Focus:** all five lines have tests — RF1 Task 3, RF2/RF3 Task 6, RF4 Task 5, RF5 Task 4.

**5. Proportion:** six tasks wiring an existing tested writer; the plan pins files/signatures/tests and points to spec sections for algorithm detail. The **Dispatch Mechanics Design (D1–D7)** section resolves the integration decisions the executor cannot make alone: the `pushToSession` bookkeeping/publish split (D1), idle dispatch ordering + consumedAt (D2), the async `onTurnSettling` + pump-await-before-moreQueued ordering (D3), native re-entrancy (D4), T7c reset-writer/degraded-fence coexistence (D5), dispatchOrdinal/operationId (D6), and crash-recovery fold classification (D7). Task 1 is deliberately behavior-preserving so the risky sync→async dispatch change lands with a green existing suite before any observable queued behavior changes.

**Known coupling risks for the executor (resolved in D1–D7):** Task 1's sync→async `dispatchUserMessage` touches `dispatchNewUserMessage`'s rollback contract and the native synchronous direct hand-off (`onInputConsumed` re-entrancy, D4) — run the steering + native e2e suites, not just the new test. Task 2's materialization MUST be awaited by the pump before `moreQueued` (D3) or `pendingTurns` clears prematurely — the `session-pump.test.ts` ordering case pins this. Task 6's `dispatch-unknown` must NEVER auto re-dispatch (D7). The dispatch writer coexists with T7c's reset writer without generation conflict (D5).