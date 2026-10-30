# Session State and Legacy Cursor Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unused SessionStore/SessionSnapshot surface and the retired uuid-cursor protocol while preserving seq-window, subagent replay, and all observable chat behavior.

**Architecture:** Perform three behavior-preserving deletions: fixed/unused store projections, write-only permission state, then legacy cursor actions and write-only cursor fields. Keep the internal `prependMessages` helper and all current replay/seq behavior; migrate tests to current public inputs rather than deleting meaningful coverage.

**Tech Stack:** TypeScript, React 19, Vitest, Testing Library, existing SessionStore/reducer/seq-window/SessionSynchronizer.

**Spec:** `docs/superpowers/specs/2026-10-30-session-state-cleanup-design.md`

## Global Constraints

- UI, WS/REST protocol, SessionSynchronizer, and reducer behavior remain unchanged except removal of state that has no observable consumer.
- `reduceSessionState(state, action)` remains the reducer seam; do not split or redesign it in this project.
- Keep `REPLAY_REPLACE`, internal `prependMessages`, `pendingResults`, `workflowIndex`, mirror `activeWorkflows`, `planStatus`, `pidToToolUseId`, and activeWorktree machinery.
- `WINDOW_PAGE at:'head'` uses uuid dedup; signature/prompt-overlap coverage must use `REPLAY_REPLACE`'s older slice.
- Do not add compatibility aliases, empty replacement methods, or fixed-default fields.
- Stage only exact files changed by each task; never stage unrelated working-tree or untracked files.
- Before every commit, run `code-review` on the full task diff, fix confirmed findings, and re-review non-trivial fixes.

## Review Focus

1. **Permission resolution without a toolUseID:** no observable state should change, while plan/question/pid mappings still update correctly — pinned in Task 2.
2. **Two prepend dedup modes:** uuid-dedup belongs to `WINDOW_PAGE`; signature-overlap belongs to `REPLAY_REPLACE` — pinned in Task 3.
3. **Replay after cursor deletion:** dedup, overlap, chronology, and subagent state must remain identical without `lastMessageUuid` — pinned in Task 3.
4. **CLEAR_TRANSCRIPT after reset removal:** tests must retain empty-live-ready behavior and no stale live-turn flush — pinned in Task 1.
5. **Workflow inspection after projection removal:** running and completed records remain available through `workflowIndex` — pinned in Task 1.

## File Structure

- `src/session-store/types.ts` — remove retired snapshot/mirror fields and action variants.
- `src/session-store/store.ts` — remove projections, caches, and unused public/private methods.
- `src/session-store/selectors.ts` — remove unused whole-store accessors.
- `src/session-store/reducer.ts` — remove write-only permission/cursor state and action branches; preserve all other folds.
- `src/session-store/normalize.ts` — remove cursor-only `isCursorAnchorable` in Task 3.
- `src/session-store/store.test.ts` — remove fixed-value assertions and use current clear behavior.
- `src/session-store/reducer.test.ts` — remove deleted-action tests, migrate prepend tests, preserve behavior assertions.
- `src/session-store/active-worktree.test.ts` — remove legacy actions from random sequences, keep invariant coverage.
- `src/session-sync/session-synchronizer.test.ts` — replace `store.reset()` with `CLEAR_TRANSCRIPT`.
- `src/types.ts`, `src/session-store/commands.ts`, `src/components/WorkflowCard.tsx` — update stale comments only where they reference removed APIs.

---

### Task 1: Remove Fixed Readiness Fields and Unused Store Surface

**Files:**
- Modify: `src/session-store/types.ts`
- Modify: `src/session-store/store.ts`
- Modify: `src/session-store/selectors.ts`
- Modify: `src/session-store/store.test.ts`
- Modify: `src/session-sync/session-synchronizer.test.ts`
- Modify: `src/types.ts`
- Modify: `src/session-store/commands.ts`
- Modify: `src/components/WorkflowCard.tsx`

**Interfaces:**
- Removes: `hydrateReady`, `idbReady`, `cacheHasDroppedMedia`, snapshot `activeWorkflows`, `lastMessageUuid` projection only, `dispatchMany`, `useSessionSnapshot`, `getSessionState`, `reset`, `clearPersisted`, private `wipe`.
- Preserves: mirror `activeWorkflows`, `workflowIndex`, `replayReady`, `getSessionStore`, `useSessionField`, `useSessionSelector`, `dispatch`, `CLEAR_TRANSCRIPT`.

- [ ] **Step 1: Write failing surface and behavior tests**

Add/update focused assertions so current code fails:
- `getSnapshot()` lacks `hydrateReady`, `idbReady`, `cacheHasDroppedMedia`, and `activeWorkflows`.
- A running and a completed Workflow remain readable through `workflowIndex` after the running-only projection is removed.
- The synchronizer clear test dispatches `CLEAR_TRANSCRIPT` and asserts replayReady plus no later stale live-turn flush, rather than calling `store.reset()`.
- Direct API-surface assertions fail before deletion: a SessionStore instance has no `dispatchMany`, `reset`, or `clearPersisted` property, and the selectors module has no `useSessionSnapshot` or `getSessionState` export.

- [ ] **Step 2: Run the tests to verify the new surface assertions fail**

Run: `npm test -- src/session-store/store.test.ts src/session-sync/session-synchronizer.test.ts`
Expected: FAIL because the fixed fields/projection and `store.reset()` still exist.

- [ ] **Step 3: Delete the fixed fields and unused APIs**

Remove only the interfaces listed above. Delete Workflow running-only caches/helper without touching mirror data or `workflowIndex`. Replace reset-based tests with direct `CLEAR_TRANSCRIPT`; update comments in `src/types.ts`, `commands.ts`, and `WorkflowCard.tsx` so they no longer describe removed API as active.

- [ ] **Step 4: Run store, workflow, and synchronizer tests**

Run: `npm test -- src/session-store/store.test.ts src/session-store/reducer.test.ts src/session-sync/session-synchronizer.test.ts src/components/WorkflowOverlay.test.tsx src/components/SubagentTranscriptDialog.test.tsx`
Expected: PASS, including running/completed Workflow access through `workflowIndex` and unchanged clear/replay behavior.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Review and commit**

Review the full diff first. Then stage only:

```bash
git add src/session-store/types.ts src/session-store/store.ts src/session-store/selectors.ts src/session-store/store.test.ts src/session-sync/session-synchronizer.test.ts src/types.ts src/session-store/commands.ts src/components/WorkflowCard.tsx
git commit -m "refactor: remove unused session store surface" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: Remove Write-Only Permission State

**Files:**
- Modify: `src/session-store/types.ts`
- Modify: `src/session-store/store.ts`
- Modify: `src/session-store/reducer.ts`
- Modify: `src/session-store/reducer.test.ts`

**Interfaces:**
- Removes: mirror/snapshot `permissionDecisions` and mirror `permissionPending`.
- Preserves: `planStatus`, `questionAnswers`, `pidToToolUseId`, permission channel behavior, and all other `PERMISSION_REQUEST/RESOLVED` folds.

- [ ] **Step 1: Write failing permission-state tests**

Add reducer tests asserting the mirror no longer carries `permissionDecisions` or `permissionPending`. Keep and strengthen behavior tests proving:
- allow/deny still flips an existing plan through `planStatus`;
- clarified question answers still update `questionAnswers`;
- resolution still removes the matching `pidToToolUseId` entry;
- a resolution without toolUseID and without plan/question mapping leaves all observable mirror fields unchanged.

- [ ] **Step 2: Run the permission tests to verify the new assertions fail**

Run: `npm test -- src/session-store/reducer.test.ts`
Expected: FAIL because the two write-only maps still exist.

- [ ] **Step 3: Delete permission map state and maintenance**

Remove both fields, initialization, snapshot projection, and all reducer reads/writes/capping. Do not change `pidToToolUseId`, `planStatus`, or `questionAnswers` branches. Update the affected test to assert pid cleanup rather than the deleted pending map.

- [ ] **Step 4: Run permission and plan behavior tests**

Run: `npm test -- src/session-store/reducer.test.ts src/session-store/commands.test.ts src/components/MessageList.test.tsx`
Expected: PASS, including plan approval/rejection, question clarification, and no-map resolution behavior.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Review and commit**

```bash
git add src/session-store/types.ts src/session-store/store.ts src/session-store/reducer.ts src/session-store/reducer.test.ts
git commit -m "refactor: remove write-only permission state" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: Retire Legacy Cursor Actions and Write-Only Cursor Fields

**Files:**
- Modify: `src/session-store/types.ts`
- Modify: `src/session-store/store.ts`
- Modify: `src/session-store/reducer.ts`
- Modify: `src/session-store/normalize.ts`
- Modify: `src/session-store/reducer.test.ts`
- Modify: `src/session-store/active-worktree.test.ts`

**Interfaces:**
- Removes: public `PREPEND_MESSAGES`, `ADOPT_CURSOR`, `SETTLE_RESULT_INDEXES`, `MARK_TAIL_FIRST_APPLIED`, `tailFirstUnsettled`, mirror `lastMessageUuid`, and `isCursorAnchorable`.
- Preserves: internal `prependMessages`, `REPLAY_REPLACE`, `pendingResults`, and all current seq/replay behavior.

- [ ] **Step 1: Rewrite cursor-era tests to current behavior before deleting implementation**

Restructure tests so the suite distinguishes deleted implementation tests from retained behavior:
- delete only tests whose sole purpose is a removed action or cursor value;
- migrate uuid-dedup prepend cases to `WINDOW_PAGE at:'head'` with valid seq/page fixtures;
- migrate signature/prompt-overlap cases to `REPLAY_REPLACE`'s older slice (`trustUuidDedup: false`);
- keep replay dedup/order/subagent assertions while removing only `lastMessageUuid` assertions;
- remove legacy actions from active-worktree random generators while retaining WINDOW_* sequences and invariant checks after every action;
- add mirror/snapshot assertions that `lastMessageUuid` and `tailFirstUnsettled` are absent after implementation.

- [ ] **Step 2: Run the rewritten suites to verify old implementation fails them**

Run: `npm test -- src/session-store/reducer.test.ts src/session-store/active-worktree.test.ts`
Expected: FAIL on deleted-field/action assertions, while retained behavior cases define the coverage that must stay green.

- [ ] **Step 3: Delete the legacy actions and cursor maintenance**

Remove the four action variants and switch branches, `adoptCursor`, `settleResultIndexes`, `tailFirstUnsettled`, public PREPEND dispatch, `lastMessageUuid` projection/initialization/maintenance, replay cursor-advance block, append write, evict repair, and `isCursorAnchorable`. Keep internal `prependMessages` and every other replay/reducer fold unchanged.

- [ ] **Step 4: Run cursor-adjacent and replay behavior suites**

Run: `npm test -- src/session-store/reducer.test.ts src/session-store/active-worktree.test.ts src/session-store/subagent-ingest.test.ts src/session-sync src/components/SubagentTranscriptDialog.test.tsx`
Expected: PASS, including both prepend dedup modes, replay order/dedup, pendingResults, and activeWorktree invariants.

- [ ] **Step 5: Verify deletion completeness and the full client**

Run:

```bash
git grep -n -E 'ADOPT_CURSOR|SETTLE_RESULT_INDEXES|MARK_TAIL_FIRST_APPLIED|PREPEND_MESSAGES|tailFirstUnsettled|lastMessageUuid|isCursorAnchorable' -- src
```

Expected: no matches. If a historical comment remains, update it in the owning file and include that exact file in the commit.

Run: `npm run typecheck`
Expected: PASS.

Run: `npx vitest run src`
Expected: all client tests PASS.

Run: `npx eslint src/session-store src/session-sync`
Expected: 0 errors.

Run: `npm run build`
Expected: PASS.

Run: `npm test`
Expected: full suite PASS, or only the explicitly documented pre-existing Windows server baseline failures with zero new client failures.

- [ ] **Step 6: Review and commit**

Review the full diff first. Stage only the task files plus any comment-only file explicitly required by the previous search:

```bash
git add src/session-store/types.ts src/session-store/store.ts src/session-store/reducer.ts src/session-store/normalize.ts src/session-store/reducer.test.ts src/session-store/active-worktree.test.ts docs/superpowers/specs/2026-10-30-session-state-cleanup-design.md docs/superpowers/plans/2026-10-30-session-state-cleanup.md
git commit -m "refactor: retire legacy session cursor protocol" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
