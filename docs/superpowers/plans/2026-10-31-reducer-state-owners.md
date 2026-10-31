# Reducer State Owners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolithic reducer into six behavior-owning modules while preserving `reduceSessionState(state, action)`, removing the dead `cachedPlainText` compatibility parameter, and keeping dismissed subagents dismissed after replay and index rebuilds.

**Architecture:** Extract leaves first, then index coordination, transcript logging, full message processing, and finally replay merging. `index-pipeline` alone owns pendingResults and unified index pruning; `message-pipeline` preserves applyMessage ordering; `replay-merge` consumes those pipelines without calling back into the reducer entry.

**Tech Stack:** TypeScript, React 19, Vitest, existing SessionStore/reducer/seq-window/normalize modules.

**Spec:** `docs/superpowers/specs/2026-10-31-reducer-state-owners-design.md`

## Global Constraints

- `reduceSessionState(state, action)` keeps its exact signature and observable behavior, except the user-approved dismissed replay fix.
- `REPLAY_REPLACE`, internal `prependMessages`, overlap/stale-copy/chronology logic, seq/tombstone behavior, and activeWorktree remain intact.
- `index-pipeline` alone owns pendingResults park/drain/prune and `pruneIndexesToLive`; drain never calls full `applyMessage`.
- tool/plan/question updates precede sidechain updates and pendingResults parking.
- `TASKS_SNAPSHOT.isBackgrounded` remains the sole `isAsync` authority; dismissed remains terminal.
- Do not delete `topLevelUserPromptSignature`'s cached plaintext parameter or the boot-time legacy-cache sweep.
- Keep `reducer.ts` helper re-exports during migration; do not rewrite the characterization suites just to match file names.
- Stage only exact files changed by each task and run `code-review` on the full diff before every commit.
- In addition to task-focused tests, run `npm test` once before every commit and distinguish accepted pre-existing server baseline failures from new failures.

## Review Focus

1. **Pending drain and rebuild:** parked results settle exactly once without duplicating transcript items — pinned in Task 5.
2. **Dismissed after replay and page-back:** replay/reset and trim→prepend cannot revive a dismissed record — pinned in Task 3.
3. **Full applyMessage order:** optimistic FIFO, live-turn/index/draft/trim/eviction ordering stays exact — pinned in Task 7.
4. **Transcript invariants:** both prepend dedup modes, seq boundaries, and activeWorktree remain correct — pinned in Task 6.
5. **Streaming isolation:** live-turn extraction does not reintroduce Chat/MessageList renders per flush — pinned in Tasks 1 and 8.

## File Structure

### New business modules

- `src/session-store/live-turn.ts` — streaming delta/rate/prune/flush and draft behavior.
- `src/session-store/tool-index.ts` — generic tools, plans, questions, and permission mappings.
- `src/session-store/sidechain-index.ts` — subagents/workflows/skills, task joins, and dismissal.
- `src/session-store/turn-status.ts` — turn-end sweep, stale timeout, and pure status predicates.
- `src/session-store/transcript-log.ts` — items/messages/window/worktree/prepend/trim/evict/stamp.
- `src/session-store/replay-merge.ts` — fresh/cache replay merging and helpers.

### New coordination modules

- `src/session-store/index-pipeline.ts` — ordered tool+sidechain folds, pendingResults, unified prune/rebuild.
- `src/session-store/message-pipeline.ts` — full applyMessage orchestration.
- `src/session-store/user-message-lifecycle.ts` — optimistic delivery intent and consumed/steered coordination.
- `src/session-store/window-bridge.ts` — WINDOW_* handlers (windowLive/windowPage/windowEvict) that compose seq-window operators with message-pipeline.applyMessage and transcript-log.prependMessages/evictMessages. This seam breaks the would-be value-import cycle between message-pipeline and transcript-log: message-pipeline imports transcript-log primitives (updateTranscriptMirror/evictMessages/trimFront) for its result/trim/evict path, and the WINDOW handlers need applyMessage to drive freshly-windowed messages into the ordered log — housing them in transcript-log would close the cycle. window-bridge imports both, so transcript-log no longer imports message-pipeline and the dependency graph is acyclic at the value level.

### Residual entry

- `src/session-store/reducer.ts` — action routing, simple root fields, and helper re-exports only.
- `src/session-store/normalize.ts` — message classification plus temporary turn-status re-exports; no ActiveWorktree type definition.

---

### Task 1: Prepare Types and Remove the Dead Plaintext Parameter

**Files:**
- Modify: `src/session-store/types.ts`
- Modify: `src/session-store/normalize.ts`
- Modify: `src/session-store/plain-text-lazy.test.ts`

**Interfaces:**
- Moves: `ActiveWorktree` interface from normalize to types, eliminating the type-only `types ↔ normalize` cycle.
- Removes: `toTranscriptItem`'s third `cachedPlainText` parameter.
- Preserves: `topLevelUserPromptSignature`'s cached plaintext parameter and lazy `null`/`undefined` behavior.

- [ ] **Step 1: Write failing lazy-memo and type-ownership tests**

Update `plain-text-lazy.test.ts` to prove the contract without the deleted parameter: a memoized `null` skips extraction and an `undefined` value recomputes. Add compile-time checks that `ActiveWorktree` is exported from `types.ts` and that `toTranscriptItem` accepts exactly two arguments.

- [ ] **Step 2: Run tests/typecheck to verify the old shape fails**

Run: `npm test -- src/session-store/plain-text-lazy.test.ts && npm run typecheck`
Expected: FAIL on the new two-argument signature/type ownership or old lazy test structure.

- [ ] **Step 3: Move the type and delete the compatibility parameter**

Move only the `ActiveWorktree` interface. Remove the third parameter and its stale cache comments while retaining lazy memo behavior and every two-argument caller. Update `topLevelUserPromptSignature` documentation to make clear its parameter remains live.

- [ ] **Step 4: Run lazy/normalize tests and typecheck**

Run: `npm test -- src/session-store/plain-text-lazy.test.ts src/session-store/normalize.test.ts && npm run typecheck`
Expected: PASS with no type-only ActiveWorktree cycle.

- [ ] **Step 5: Review and commit**

```bash
git add src/session-store/types.ts src/session-store/normalize.ts src/session-store/plain-text-lazy.test.ts
git commit -m "refactor: prepare reducer state ownership boundaries" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: Extract live-turn

**Files:**
- Create: `src/session-store/live-turn.ts`
- Create: `src/session-store/live-turn.test.ts`
- Modify: `src/session-store/reducer.ts`

**Interfaces:**
- Produces:
  - `updateLiveTurnMirror(mirror: ServerMirror, message: SdkMessage): ServerMirror`
  - `flushLiveTurn(mirror: ServerMirror): ServerMirror`
  - `pruneFinalizedLiveTurnText(mirror: ServerMirror, message: SdkMessage): ServerMirror`

- [ ] **Step 1: Write failing live-turn module tests**

Cover phase transitions, parent-vs-sidechain isolation, real/estimated token rates, main-thread prune with sidechain preservation, flush-to-draft, and identity-stable no-op behavior. Keep existing streaming isolation as the integration control.

- [ ] **Step 2: Run the new tests to verify the module is missing**

Run: `npm test -- src/session-store/live-turn.test.ts`
Expected: FAIL because `live-turn.ts` does not exist.

- [ ] **Step 3: Move live-turn implementation**

Move `updateLiveTurnMirror`, `pruneFinalizedLiveTurnText`, `pushRateSample`, rate constants, `resultContentToText`, and the `LIVE_TURN_FLUSH` body into the new module. Replace reducer call sites with the exact interfaces above; do not change the applyMessage orchestration yet.

- [ ] **Step 4: Run live-turn and streaming suites**

Run: `npm test -- src/session-store/live-turn.test.ts src/session-store/reducer.test.ts src/components/streaming-render-isolation.test.tsx`
Expected: PASS, including Chat/MessageList zero renders per flush.

- [ ] **Step 5: Review and commit**

```bash
git add src/session-store/live-turn.ts src/session-store/live-turn.test.ts src/session-store/reducer.ts
git commit -m "refactor: extract live turn state owner" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: Extract sidechain-index and Fix Dismissal Rebuilds

**Files:**
- Create: `src/session-store/sidechain-index.ts`
- Create: `src/session-store/sidechain-index.test.ts`
- Modify: `src/session-store/reducer.ts`
- Modify: `src/session-store/normalize.ts`

**Interfaces:**
- Produces:
  - `updateSidechainIndexMirror(mirror, message): ServerMirror`
  - `applyTasksSnapshot(mirror, tasks): ServerMirror`
  - `dismissSubagent(state, toolUseId): SessionState`
  - `reapplyDismissed(state): SessionState`
  - `hasTranscriptBackground(records): boolean`

- [ ] **Step 1: Write failing sidechain and dismissal tests**

Cover Subagent/Workflow/Skill seed/result/child folds, launch-ack skipping, task-snapshot isAsync authority, and child-result flips without a live-status guard. Add two dismissal regressions: replay/reset cannot revive dismissed, and trim→page-back cannot turn dismissed back into running.

- [ ] **Step 2: Run the new tests to verify current failures**

Run: `npm test -- src/session-store/sidechain-index.test.ts`
Expected: FAIL because the module is missing and current replay/index rebuild can resurrect dismissed.

- [ ] **Step 3: Move sidechain folds and reapply dismissal after rebuilds**

Move Subagent/Workflow/Skill folds, TASKS_SNAPSHOT, DISMISS_SUBAGENT, and reapplyDismissed. Call reapplyDismissed after replayReplace and after every `rebuildIndexesFromMessages`. Keep `dismissed` excluded from completion and `reapplyDismissed` re-exported from reducer.

- [ ] **Step 4: Run sidechain, replay, and subagent suites**

Run: `npm test -- src/session-store/sidechain-index.test.ts src/session-store/skill-index.test.ts src/session-store/reducer.test.ts src/session-store/subagent-ingest.test.ts src/components/SubagentTranscriptDialog.test.tsx`
Expected: PASS, including replay/reset and trim→page-back dismissal cases.

- [ ] **Step 5: Review and commit**

```bash
git add src/session-store/sidechain-index.ts src/session-store/sidechain-index.test.ts src/session-store/reducer.ts src/session-store/normalize.ts
git commit -m "refactor: extract sidechain index and preserve dismissals" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: Extract tool-index

**Files:**
- Create: `src/session-store/tool-index.ts`
- Create: `src/session-store/tool-index.test.ts`
- Modify: `src/session-store/reducer.ts`

**Interfaces:**
- Produces:
  - `updateToolIndexMirror(mirror, message): ServerMirror`
  - `applyPermissionRequest(state, request): SessionState`
  - `applyPermissionResolved(state, id, decision): SessionState`

`pendingResults` remains with the current reducer until Task 5 and must not move into tool-index.

- [ ] **Step 1: Write failing tool-index tests**

Cover generic running/success/error and payload capture, plan approval/rejection/content, question pending/answered/clarified, pid cleanup, and no-map permission no-op. Verify sidechain-owned tool IDs remain excluded from generic tool status.

- [ ] **Step 2: Run the new tests to verify the module is missing**

Run: `npm test -- src/session-store/tool-index.test.ts`
Expected: FAIL because `tool-index.ts` does not exist.

- [ ] **Step 3: Move generic tool, plan, question, and permission folds**

Move only the generic/plan/question/pid branches. Keep the current reducer's `updateIndexesMirror` coordinator and pendingResults logic for Task 5, preserving branch order.

- [ ] **Step 4: Run tool, plan, question, and permission suites**

Run: `npm test -- src/session-store/tool-index.test.ts src/session-store/tool-status.test.ts src/session-store/reducer.test.ts src/components/MessageList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Review and commit**

```bash
git add src/session-store/tool-index.ts src/session-store/tool-index.test.ts src/session-store/reducer.ts
git commit -m "refactor: extract generic tool index" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 5: Extract turn-status and Form index-pipeline

**Files:**
- Create: `src/session-store/turn-status.ts`
- Create: `src/session-store/turn-status.test.ts`
- Create: `src/session-store/index-pipeline.ts`
- Create: `src/session-store/index-pipeline.test.ts`
- Modify: `src/session-store/reducer.ts`
- Modify: `src/session-store/normalize.ts`

**Interfaces:**
- `sweepAtTurnEnd(mirror): ServerMirror`
- `settleStaleLiveSubagents(mirror, opts?): ServerMirror`
- `computeWaiting(input): boolean`
- `computeTurnActive(input): boolean`
- `countTaskActivity(tasks): { all: number; indicator: number }`
- `updateIndexesMirror(mirror, message): ServerMirror`
- `drainPendingResults(mirror): ServerMirror`
- `rebuildIndexesFromMessages(state, messages): SessionState`
- `pruneIndexesToLive(mirror, live: Set<string>, retained: Set<string>): ServerMirror`

- [ ] **Step 1: Write failing status and index-pipeline tests**

Cover identity-stable turn sweep, background→pending, stale timeout, `indicator <= all`, tool-before-sidechain owner-known behavior, sidechain-child non-parking, pending cap/prune/drain exactly once, unified prune across all maps, and reapplyDismissed after rebuild. Assert drain does not change items/messages/liveTurn.

- [ ] **Step 2: Run the new tests to verify the modules are missing**

Run: `npm test -- src/session-store/turn-status.test.ts src/session-store/index-pipeline.test.ts`
Expected: FAIL because both modules are missing.

- [ ] **Step 3: Move status predicates, sweep, and index coordination**

Move turn-status functions and normalize re-exports. Form index-pipeline by composing the existing tool-index then sidechain-index folds, moving pendingResults and unified pruning there. Re-export `rebuildIndexesFromMessages` and `settleStaleLiveSubagents` from reducer.

- [ ] **Step 4: Run status/index and active-worktree suites**

Run: `npm test -- src/session-store/turn-status.test.ts src/session-store/index-pipeline.test.ts src/session-store/tool-status.test.ts src/session-store/skill-index.test.ts src/session-store/active-worktree.test.ts src/session-store/reducer.test.ts`
Expected: PASS, including no duplicate append and unchanged activeWorktree invariant.

- [ ] **Step 5: Review and commit**

```bash
git add src/session-store/turn-status.ts src/session-store/turn-status.test.ts src/session-store/index-pipeline.ts src/session-store/index-pipeline.test.ts src/session-store/reducer.ts src/session-store/normalize.ts
git commit -m "refactor: extract turn status and index pipeline" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 6: Extract transcript-log

**Files:**
- Create: `src/session-store/transcript-log.ts`
- Create: `src/session-store/transcript-log.test.ts`
- Modify: `src/session-store/reducer.ts`

**Interfaces:**
- `windowLive(state, seq, generation, message): SessionState`
- `windowPage(state, action): SessionState`
- `windowEvict(state, seqs): SessionState`
- `prependMessages(state, older, opts?): SessionState`
- `trimFront(state): SessionState`
- `evictMessages(state, uuids): SessionState`
- `updateTranscriptMirror(mirror, message): ServerMirror`
- `MEMORY_ITEM_CAP = 1000`

- [ ] **Step 1: Write failing transcript-log tests**

Cover WINDOW tail/head/live/evict, uuid dedup vs REPLAY_REPLACE signature overlap, trim boundary/cap, activeWorktree recompute/fold, and `pruneIndexesToLive` delegation without direct cross-owner map writes.

- [ ] **Step 2: Run the new tests to verify the module is missing**

Run: `npm test -- src/session-store/transcript-log.test.ts`
Expected: FAIL because `transcript-log.ts` does not exist.

- [ ] **Step 3: Move transcript and window implementation**

Move window handlers, prepend, trim/evict, updateTranscriptMirror, seq/uuid/prune helpers, and `MEMORY_ITEM_CAP` with its reducer re-export. Call index-pipeline for index rebuild/prune; do not import replay-merge or message-pipeline.

- [ ] **Step 4: Run transcript, seq, and worktree suites**

Run: `npm test -- src/session-store/transcript-log.test.ts src/session-store/active-worktree.test.ts src/session-store/reducer.test.ts src/session-sync/session-synchronizer.seq.test.ts`
Expected: PASS for both prepend modes and all seq/worktree invariants.

- [ ] **Step 5: Review and commit**

```bash
git add src/session-store/transcript-log.ts src/session-store/transcript-log.test.ts src/session-store/reducer.ts
git commit -m "refactor: extract transcript log and seq window handlers" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 7: Extract message-pipeline and user-message-lifecycle

**Files:**
- Create: `src/session-store/message-pipeline.ts`
- Create: `src/session-store/message-pipeline.test.ts`
- Create: `src/session-store/user-message-lifecycle.ts`
- Create: `src/session-store/user-message-lifecycle.test.ts`
- Modify: `src/session-store/transcript-log.ts`
- Modify: `src/session-store/reducer.ts`

**Interfaces:**
- `applyMessage(state, message): SessionState`
- `applyOptimisticUserMessage(state, message): SessionState`
- `ackUserMessage(state, pendingId, serverUuid, receivedAt?): SessionState`
- `applyMessageConsumed(state, uuid, consumedAt): SessionState`
- `applyMessageSteered(state, uuid, state): SessionState`
- `clearSendingPlaceholders(intent): ClientIntent`
- transcript-log `stampMessageConsumed` / `stampMessageSteered` for mirror-only updates.

- [ ] **Step 1: Write failing pipeline and intent tests**

Pin the exact applyMessage order from the spec: FIFO placeholder, effectiveConsumedAt, transient slots, live-turn, transcript, indexes, drain, prune, draft supersede, consumed cleanup, result sweep, trim, and refusal eviction. Add optimistic/ack/consumed/steered tests proving transcript stamps remain in transcript-log while intent changes stay in user-message-lifecycle.

- [ ] **Step 2: Run the new tests to verify the modules are missing**

Run: `npm test -- src/session-store/message-pipeline.test.ts src/session-store/user-message-lifecycle.test.ts`
Expected: FAIL because the pipeline/lifecycle modules do not exist.

- [ ] **Step 3: Move the full applyMessage orchestration and intent handlers**

Move applyMessage without changing its order. Put mirror-only consumed/steered stamps in transcript-log and intent-only changes in user-message-lifecycle. reducer delegates MESSAGE and optimistic actions to these modules; replay remains for Task 8.

- [ ] **Step 4: Run pipeline, intent, streaming, and replay-adjacent suites**

Run: `npm test -- src/session-store/message-pipeline.test.ts src/session-store/user-message-lifecycle.test.ts src/session-store/reducer.test.ts src/session-store/active-worktree.test.ts src/components/streaming-render-isolation.test.tsx`
Expected: PASS, including FIFO and exact applyMessage ordering.

- [ ] **Step 5: Review and commit**

```bash
git add src/session-store/message-pipeline.ts src/session-store/message-pipeline.test.ts src/session-store/user-message-lifecycle.ts src/session-store/user-message-lifecycle.test.ts src/session-store/transcript-log.ts src/session-store/reducer.ts
git commit -m "refactor: extract message pipeline and user lifecycle" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 8: Extract replay-merge and Slim reducer.ts

**Files:**
- Create: `src/session-store/replay-merge.ts`
- Create: `src/session-store/replay-merge.test.ts`
- Modify: `src/session-store/reducer.ts`
- Modify: `docs/superpowers/specs/2026-10-31-reducer-state-owners-design.md` only if an implemented interface differs from the spec

**Interfaces:**
- `replayReplace(state, messages, permissions): SessionState`
- `dedupeReplayPayload(messages): SdkMessage[]`
- `splitReplayAgainstCache(messages, items): { older, mid, newer, overlap }`

`reducer.ts` retains only action routing, simple root fields, and helper re-exports.

- [ ] **Step 1: Write failing replay-merge tests**

Cover fresh and cache merge, reset:true overlap, stale-copy replacement, mid-slice/chronology, prompt overlap, disk-only sweep, and dismissal after replay. Confirm replay calls message-pipeline/transcript-log/index-pipeline rather than reducer.ts.

- [ ] **Step 2: Run the new tests to verify the module is missing**

Run: `npm test -- src/session-store/replay-merge.test.ts`
Expected: FAIL because `replay-merge.ts` does not exist.

- [ ] **Step 3: Move replay merging and collapse reducer.ts to routing**

Move replayReplace and all helpers. replay-merge calls `message-pipeline.applyMessage`, `transcript-log.prependMessages`, and `sidechain-index.reapplyDismissed` as appropriate. reducer.ts keeps the exact external reducer signature and re-exports helpers from their owners; no business module imports reducer.ts.

- [ ] **Step 4: Run all session-store and integration suites**

Run: `npx vitest run src/session-store src/session-sync src/components/SubagentTranscriptDialog.test.tsx src/components/streaming-render-isolation.test.tsx`
Expected: PASS.

Run: `npm run typecheck && npx eslint src/session-store src/session-sync`
Expected: PASS with 0 errors.

Run a runtime import-cycle check over the new modules and `reducer.ts`; expected: no runtime cycles.

```bash
node <<'NODE'
const fs = require('fs'), path = require('path'), ts = require('typescript')
const dir = path.resolve('src/session-store')
const files = fs.readdirSync(dir).filter(f => /\.ts$/.test(f) && !f.endsWith('.test.ts')).map(f => path.join(dir, f))
const set = new Set(files), graph = new Map(files.map(f => [f, []]))
function resolve(from, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), spec)
  for (const f of [base, base + '.ts', path.join(base, 'index.ts')]) if (set.has(f)) return f
  return null
}
for (const f of files) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true)
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly && ts.isStringLiteral(st.moduleSpecifier)) {
      const to = resolve(f, st.moduleSpecifier.text)
      if (to) graph.get(f).push(to)
    }
  }
}
for (const f of files) {
  const seen = new Set()
  function dfs(v, trail) {
    if (trail.has(v)) throw new Error(`runtime import cycle: ${[...trail, v].join(' -> ')}`)
    if (seen.has(v)) return
    seen.add(v)
    for (const to of graph.get(v)) dfs(to, new Set([...trail, to]))
  }
  dfs(f, new Set([f]))
}
console.log('No runtime import cycles in src/session-store')
NODE
```

- [ ] **Step 5: Run complete verification**

Run: `npx vitest run src`
Expected: all client tests PASS.

Run: `npm run build && npm test`
Expected: build PASS and full suite PASS, or only explicitly documented pre-existing server baseline failures with zero new client failures.

- [ ] **Step 6: Review and commit**

```bash
git add src/session-store/replay-merge.ts src/session-store/replay-merge.test.ts src/session-store/reducer.ts docs/superpowers/specs/2026-10-31-reducer-state-owners-design.md docs/superpowers/plans/2026-10-31-reducer-state-owners.md
git commit -m "refactor: split reducer into state owners" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
