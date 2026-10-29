# SessionSynchronizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broad `useChatStream`/`ChatStream` module with one WS/REST `SessionSynchronizer`, narrow SessionStore commands/selectors, and session-bound rendering adapters while preserving all transcript behavior.

**Architecture:** A framework-free synchronizer owns every WS/REST request and per-run race state, dispatching into the existing SessionStore. React adapters own lifecycle only; controlled transcript components remain intact while thin session-bound wrappers subscribe at actual consumers. `ChatStream` is removed after main Chat and Side Chat migrate.

**Tech Stack:** React 19, TypeScript, `useSyncExternalStore`, Vitest, Testing Library, existing WsHub/SessionStore/seq-window modules.

**Spec:** `docs/superpowers/specs/2026-10-29-session-synchronizer-design.md`

## Global Constraints

- UI, interaction, WS protocol, REST protocol, SDK behavior, and reducer semantics remain unchanged.
- SessionStore remains the only transcript owner; no second messages/items cache and no new state library.
- Every tail, attached, gap-fill, and loadOlder page uses the same generation/clear-epoch validation.
- Display leaves subscribe only to SessionStore/paging snapshots; none calls `hub.subscribe`.
- Side Chat collapse and main-panel keep-alive hiding must not restart synchronization.
- Controlled `MessageList` continues serving subagent, disk transcript, scratch-store, and static-test callers.
- `running=false` still subscribes; a change in `running` restarts synchronization exactly as the current effect does.
- `ChatStream`, `useChatStream`, and compatibility aliases are absent at completion.
- Do not revert, overwrite, or stage unrelated working-tree changes, especially current MessageList/transcript-rows work.
- Every commit stages only the exact files changed by that task; never stage `src`, `src/components`, or `src/**` wholesale.
- Before every commit, run the repository's `code-review` skill on the full task diff (`git diff HEAD`), verify and fix confirmed findings, and re-review non-trivial fixes.

## Review Focus

1. **A running-flip during deferred loadOlder:** the old run must return 0 and must not dispatch or clear the new run's loading/error state — pinned in Task 2.
2. **A clear racing any tail/head request:** pre-clear content must never resurrect or pin a dead generation — pinned in Task 3.
3. **Side Chat collapse during live traffic:** drawer unmount must not stop/restart WS or refetch the tail — pinned in Task 7.
4. **Controlled/scratch transcripts:** static MessageList callers must not accidentally read the main session store — pinned in Tasks 5 and 8.
5. **Streaming/task telemetry:** new selectors must not reintroduce Chat/MessageList renders per live flush or unused task snapshot — pinned in Task 6.

## File Structure

### New modules

- `src/types/context-usage.ts` — canonical ContextUsage type, independent of hooks.
- `src/session-store/commands.ts` — pure SessionStore command factory.
- `src/hooks/useSessionCommands.ts` — stable React adapter for commands.
- `src/session-sync/session-synchronizer.ts` — WS/REST synchronization, run state, paging snapshot.
- `src/session-sync/useSessionSynchronizer.ts` — React lifecycle and narrow paging interface.
- `src/session-sync/useSessionStreamError.ts` — store error plus WsHub status projection.
- `src/components/SessionMessageList.tsx` — SessionStore adapter over controlled MessageList.
- `src/components/message-list/SessionWorkingBubble.tsx` — activeSubagents/apiRetry adapter.
- `src/components/SessionBottomCards.tsx` — messages adapter for TodoChecklist + MonitorBar.

### Main modifications

- `src/session-store/selectors.ts` — stable primitive selectors shared by Chat and Side Chat.
- `src/components/Chat.tsx` — synchronizer, commands, narrow selectors, session-bound children.
- `src/components/ChatPanel.tsx` — Side Chat synchronizer ownership only.
- `src/components/SideChatDrawer.tsx` — narrow selectors/commands and session-bound children.
- `src/types.ts`, `src/types/config.ts` consumers, context components/tests — ContextUsage import relocation.
- `src/components/message-list/WorkingBubble.tsx` — ActivePhase import relocation.

### Removal at completion

- `src/hooks/useChatStream.ts`
- `src/hooks/useChatStream.test.ts`
- `src/hooks/useChatStream.seq.test.ts`

---

### Task 1: Relocate Context Types and Extract Session Commands

**Files:**
- Create: `src/types/context-usage.ts`
- Create: `src/session-store/commands.ts`
- Create: `src/hooks/useSessionCommands.ts`
- Test: `src/session-store/commands.test.ts`
- Modify: `src/components/message-list/WorkingBubble.tsx`
- Modify: all ContextUsage importers currently referencing `hooks/useChatStream`

**Interfaces:**
- Produces:
  - `ContextUsage` from `src/types/context-usage.ts`.
  - `createSessionCommands(store: SessionStore): SessionCommands`.
  - `useSessionCommands(sessionId: string): SessionCommands`.
  - `SessionCommands = { insertUserMessage(text): string; ackUserMessage(pendingId, serverUuid, receivedAt?): void; rollbackUserMessage(pendingId): void; clearError(): void; dismissSubagent(toolUseId): void }`.

- [ ] **Step 1: Write failing command tests**

Cover five behaviors against a real SessionStore: insert creates an `optimistic:` user message and clears promptSuggestion; ack swaps in server uuid/receivedAt; rollback removes only the matching placeholder; clearError nulls intent.error; dismissSubagent changes only a pending record to interrupted.

```ts
it('insert/ack/rollback keep optimistic delivery semantics', () => { /* assert uuid, receivedAt, items */ })
it('clearError and dismissSubagent dispatch their existing actions', () => { /* assert snapshot/mirror */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/session-store/commands.test.ts`
Expected: FAIL because `session-store/commands` does not exist.

- [ ] **Step 3: Implement the command factory and React adapter**

Move the bodies currently at `useChatStream.ts:765-800` without changing actions. `createSessionCommands` closes over the supplied store; `useSessionCommands` memoizes one factory result per session store. Move `ContextUsage` verbatim to its new type file and update imports; import `ActivePhase` in WorkingBubble directly from `session-store/types`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- src/session-store/commands.test.ts src/components/message-list/WorkingBubble.test.tsx`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS with no ContextUsage/ActivePhase import from useChatStream anywhere in src.

- [ ] **Step 5: Commit**

```bash
git add src/types/context-usage.ts src/session-store/commands.ts src/session-store/commands.test.ts src/hooks/useSessionCommands.ts src/hooks/useChatStream.ts src/hooks/useDetailedContextUsage.ts src/session-store/types.ts src/utils/context-usage.ts src/components/ContextOrb.tsx src/components/ContextOrb.test.tsx src/components/ContextBar.tsx src/components/ContextBar.test.tsx src/components/ContextComposition.tsx src/components/ContextComposition.test.tsx src/components/SettingsPanel.tsx src/components/message-list/WorkingBubble.tsx
git commit -m "refactor: extract session commands and context types"
```

### Task 2: Build the Synchronizer Paging Core and Run Isolation

**Files:**
- Create: `src/session-sync/session-synchronizer.ts`
- Test: `src/session-sync/session-synchronizer.paging.test.ts`

**Interfaces:**
- Produces:

```ts
interface SessionSyncHub {
  addSessionListener(sessionId: string, listener: (frame: WsServerFrame) => void): () => void
  subscribe(sessionId: string, opts?: { force?: boolean }): () => void
}
type SessionSyncGet = <T>(path: string) => Promise<T>
interface TranscriptPagingSnapshot { loadingOlder: boolean; olderError: string | null }
class SessionSynchronizer {
  constructor(options: { sessionId: string; store: SessionStore; hub: SessionSyncHub; get: SessionSyncGet; handlers: SessionSyncHandlers })
  start(): void
  stop(): void
  setHandlers(handlers: SessionSyncHandlers): void
  setTerminated(terminated: boolean): void
  loadOlder(): Promise<number>
  getPagingSnapshot(): TranscriptPagingSnapshot
  subscribePaging(listener: () => void): () => void
}
```

`SessionSyncHandlers` has the same fields as the current `PermissionHandlers`.

- [ ] **Step 1: Write failing open/paging/restart tests**

Use fake hub/REST plus a real SessionStore. Include:
- start subscribes with `{force:true}`, fetches `/sessions/s1/messages?limit=200`, and dispatches the tail page;
- loadOlder returns 0 without hasOlder/oldestSeq, allows only one in-flight request, dispatches a head page, returns its message count, and exposes retryable olderError;
- paging listeners fire only when loadingOlder/olderError changes;
- a deferred loadOlder invalidated by stop/start returns 0, does not dispatch, and cannot clear the new run's `loadingOlder:true`;
- start resets paging to `{loadingOlder:false, olderError:null}` and stop produces no late paging notification.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/session-sync/session-synchronizer.paging.test.ts`
Expected: FAIL because the synchronizer module does not exist.

- [ ] **Step 3: Implement run-scoped paging and validation**

Create a `SyncRunState` on every start containing cancelled/run identity, minGeneration, clearEpoch, gap state, and older-in-flight state. `stop` invalidates the old run; `start` resets the paging snapshot. Move `fetchValidatedPage` and `loadOlder` from useChatStream, making the validated fetch return null for an invalidated run so every caller can stop without dispatching. Tail subscription/listener setup is included; non-paging frame routing arrives in Task 3.

- [ ] **Step 4: Run the paging tests**

Run: `npm test -- src/session-sync/session-synchronizer.paging.test.ts`
Expected: PASS, including restart-during-deferred-loadOlder.

- [ ] **Step 5: Commit**

```bash
git add src/session-sync/session-synchronizer.ts src/session-sync/session-synchronizer.paging.test.ts
git commit -m "refactor: add session synchronizer paging core"
```

### Task 3: Move WS Routing, Gap Repair, Clear Races, and Termination

**Files:**
- Modify: `src/session-sync/session-synchronizer.ts`
- Test: `src/session-sync/session-synchronizer.test.ts`
- Test: `src/session-sync/session-synchronizer.seq.test.ts`
- Reference: `src/hooks/useChatStream.test.ts`, `src/hooks/useChatStream.seq.test.ts`

**Interfaces:**
- Consumes: Task 2 `SessionSynchronizer` and run-scoped validated paging.
- Produces: a complete synchronizer behaviorally equivalent to `useChatStream.ts:290-753`, with no React subscriptions.

- [ ] **Step 1: Port the protocol suites to the synchronizer interface**

Replace renderHook setup with direct synchronizer construction and explicit start/stop. Preserve the existing fake transcript server and case coverage, especially:
- live seq/unsequenced messages, eviction, consumption/steering/withdrawal;
- attached same-generation catch-up and generation-bump tail replacement;
- live holes, multi-page gaps, tombstone-only drain, and no-progress termination;
- session-cleared epoch/floor races for tail, gap, and head pages;
- permission/elicitation/dialog callbacks and edit_prompt extraction;
- context/tasks/prompt-suggestion frames and subscribe-result error clearing;
- terminated-before-replay and live termination waiting for replayReady;
- setHandlers using the newest callbacks without another subscribe.

- [ ] **Step 2: Run the ported suites to verify the missing behaviors fail**

Run: `npm test -- src/session-sync/session-synchronizer.test.ts src/session-sync/session-synchronizer.seq.test.ts`
Expected: FAIL on unimplemented frame routing/gap/termination behavior.

- [ ] **Step 3: Move the remaining synchronization implementation**

Move the frame switch, refetchTail, fillGap, attached reconciliation, session-cleared handling, and terminated sweep from useChatStream. Every async closure captures its SyncRunState; old runs cannot clear new gap flags or dispatch pages. Keep the five-retry stale-page cap and all existing reducer actions unchanged.

- [ ] **Step 4: Run all synchronizer tests**

Run: `npm test -- src/session-sync`
Expected: all paging, protocol, clear-race, tombstone, and termination tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-sync
git commit -m "refactor: move session protocol into synchronizer"
```

### Task 4: Add the React Synchronizer and Stream-Error Adapters

**Files:**
- Create: `src/session-sync/useSessionSynchronizer.ts`
- Create: `src/session-sync/useSessionStreamError.ts`
- Test: `src/session-sync/useSessionSynchronizer.test.tsx`
- Test: `src/session-sync/useSessionStreamError.test.tsx`

**Interfaces:**
- Produces:

```ts
interface TranscriptPaging extends TranscriptPagingSnapshot {
  loadOlder: () => Promise<number>
}
useSessionSynchronizer(sessionId: string, handlers: SessionSyncHandlers, running: boolean, terminated: boolean): TranscriptPaging
useSessionStreamError(sessionId: string): string | null
```

- [ ] **Step 1: Write failing lifecycle and error tests**

Assert: empty sessionId is inert; mount retains and starts once; unmount releases/stops; rerender with new handlers does not resubscribe; changing running stops/starts and preserves force subscription; terminated is forwarded; returned paging follows the synchronizer snapshot. Error tests pin connecting/online/reconnecting transitions and preservation of non-reconnect errors.

- [ ] **Step 2: Run the adapter tests to verify they fail**

Run: `npm test -- src/session-sync/useSessionSynchronizer.test.tsx src/session-sync/useSessionStreamError.test.tsx`
Expected: FAIL because the adapters do not exist.

- [ ] **Step 3: Implement the adapters**

Inject the current WsHub and `api.get` into the Task 3 synchronizer. Use `useSyncExternalStore` for paging and `useSessionField('error') + useWsHubStatus()` for the error projection. Return a memoized TranscriptPaging object whose loadOlder identity is stable per synchronizer.

- [ ] **Step 4: Run adapter and synchronizer tests**

Run: `npm test -- src/session-sync`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-sync
git commit -m "refactor: add React session synchronization adapters"
```

### Task 5: Add Session-Bound Rendering Adapters

**Files:**
- Create: `src/components/SessionMessageList.tsx`
- Create: `src/components/message-list/SessionWorkingBubble.tsx`
- Create: `src/components/SessionBottomCards.tsx`
- Modify: `src/session-store/selectors.ts`
- Test: `src/components/SessionMessageList.test.tsx`
- Test: `src/components/SessionBottomCards.test.tsx`
- Test: `src/components/streaming-render-isolation.test.tsx`

**Interfaces:**
- Produces:
  - `SessionMessageList`: `Omit<ComponentProps<typeof MessageList>, session-owned fields> & { sessionId: string; loadingOlder: boolean; loadOlder: () => Promise<number> }`.
  - `SessionWorkingBubble`: `Omit<ComponentProps<typeof LiveWorkingBubble>, 'activeSubagents' | 'apiRetry'> & { sessionId: string }`.
  - `SessionBottomCards`: explicit sessionId/working/skin/clearing/serverTasks props; reads messages itself.
  - Stable selectors `selectHasActivePhase`, `selectHasTranscriptBackground`, `selectHasLiveSyncSubagent`.

Session-owned MessageList props are items, replayReady, planStatus, planContent, questionAnswers, toolStatus, toolResults, loadOlder, hasOlder, oldestSeq, loadingOlder, transcriptSettling.

- [ ] **Step 1: Write failing adapter tests**

Seed real stores and assert SessionMessageList renders and updates store items/tool data and passes paging controls. Assert SessionBottomCards derives TodoChecklist/MonitorBar content from messages. Assert controlled MessageList still renders supplied static items with no registered main-session data. Add an overlay-mode SessionMessageList render-count test proving LIVE_TURN_FLUSH does not rerender the wrapper; keep existing streaming isolation assertions green.

- [ ] **Step 2: Run adapter tests to verify they fail**

Run: `npm test -- src/components/SessionMessageList.test.tsx src/components/SessionBottomCards.test.tsx`
Expected: FAIL because the adapters do not exist.

- [ ] **Step 3: Implement the thin wrappers and primitive selectors**

Each wrapper subscribes only to its listed fields and delegates to the existing controlled component. Do not modify the controlled data path. SessionMessageList derives transcriptSettling as `!replayReady` and receives `loadingOlder`/`loadOlder` as separate props so an olderError-only change cannot defeat its memoization; SessionWorkingBubble reads activeSubagents/apiRetry; SessionBottomCards reads messages once for both children.

- [ ] **Step 4: Run component and existing transcript tests**

Run: `npm test -- src/components/SessionMessageList.test.tsx src/components/SessionBottomCards.test.tsx src/components/MessageList.test.tsx src/components/MonitorBar.test.tsx src/components/streaming-render-isolation.test.tsx`
Expected: PASS without changing static/scratch transcript behavior.

- [ ] **Step 5: Commit**

```bash
git add src/components/SessionMessageList.tsx src/components/SessionMessageList.test.tsx src/components/SessionBottomCards.tsx src/components/SessionBottomCards.test.tsx src/components/message-list/SessionWorkingBubble.tsx src/session-store/selectors.ts src/components/streaming-render-isolation.test.tsx
git commit -m "refactor: add session-bound transcript adapters"
```

### Task 6: Migrate Main Chat and Remove Its Aggregate Subscription

**Files:**
- Modify: `src/components/Chat.tsx`
- Test: `src/components/streaming-render-isolation.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 4, and 5 adapters/selectors.
- Produces: main Chat with no `useChatStream` call and no aggregate stream object; Side Chat remains temporarily on the old hook until Task 7.

- [ ] **Step 1: Add failing wiring/render tests**

Assert main Chat uses session-bound transcript children and does not rerender on an unused ambient TASKS_SNAPSHOT. Preserve the existing test that a LIVE_TURN_FLUSH causes zero Chat and MessageList renders. Update mocks that currently replace useChatStream so they instead provide the narrow synchronizer paging result.

- [ ] **Step 2: Run focused tests to verify the old wiring fails them**

Run: `npm test -- src/components/streaming-render-isolation.test.tsx`
Expected: FAIL on the new unused-task/wiring assertion.

- [ ] **Step 3: Replace main Chat's stream composition**

Use `useSessionSynchronizer`, `useSessionCommands`, `useSessionStreamError`, SessionMessageList, SessionWorkingBubble, and SessionBottomCards. Retain only narrow selectors for data Chat itself uses for search, export, pending jump, turn status, context UI, and overlay stacks. Remove tasks, permissionDecisions, reset, apiRetry, activeSubagents-array, replayReady, and oldestSeq subscriptions from Chat root; do not recreate a stream-shaped object.

- [ ] **Step 4: Run main-panel and transcript tests**

Run: `npm test -- src/components/streaming-render-isolation.test.tsx src/components/MessageList.test.tsx src/components/Composer.test.tsx`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS with Side Chat's temporary old hook as the only remaining production useChatStream caller.

- [ ] **Step 5: Commit**

```bash
git add src/components/Chat.tsx src/components/streaming-render-isolation.test.tsx
git commit -m "refactor: migrate main chat to session synchronizer"
```

### Task 7: Migrate Side Chat Without Changing Collapse Lifecycle

**Files:**
- Modify: `src/components/ChatPanel.tsx`
- Modify: `src/components/SideChatDrawer.tsx`
- Test: `src/components/SideChatDrawer.test.tsx`
- Test: `src/components/ChatPanel.side-chat.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 4, and 5.
- Produces: ChatPanel owns only Side Chat synchronization/permission lifecycle; SideChatDrawer accepts `paging: TranscriptPaging`, never `stream: ChatStream`.

- [ ] **Step 1: Write failing Side Chat lifecycle tests**

With a deferred-tail fake hub, mount Side Chat, collapse so SideChatDrawer unmounts, expand, and assert one force subscription and one initial tail fetch. Cover sending through insert/ack/rollback commands, older-history paging, waiting/error rendering, and SideChatAutoScroll reading items length plus streamingContent from the store.

- [ ] **Step 2: Run the Side Chat tests to verify they fail**

Run: `npm test -- src/components/SideChatDrawer.test.tsx src/components/ChatPanel.side-chat.test.tsx`
Expected: FAIL because the old stream prop and ChatPanel-level aggregate subscription remain.

- [ ] **Step 3: Migrate ChatPanel and SideChatDrawer**

ChatPanel calls useSessionSynchronizer with the effective Side Chat id and passes only paging to the drawer. The drawer uses SessionMessageList, SessionWorkingBubble, narrow selectors, useSessionStreamError, and useSessionCommands. SideChatAutoScroll subscribes to items itself instead of receiving itemsLength.

- [ ] **Step 4: Run Side Chat and lifecycle tests**

Run: `npm test -- src/components/SideChatDrawer.test.tsx src/components/ChatPanel.side-chat.test.tsx src/components/streaming-render-isolation.test.tsx`
Expected: PASS, including no re-subscribe/tail refetch across collapse.

Run: `npm run typecheck`
Expected: PASS with no production useChatStream callers.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatPanel.tsx src/components/SideChatDrawer.tsx src/components/SideChatDrawer.test.tsx src/components/ChatPanel.side-chat.test.tsx
git commit -m "refactor: migrate side chat synchronization"
```

### Task 8: Delete ChatStream and Run Full Verification

**Files:**
- Delete: `src/hooks/useChatStream.ts`
- Delete: `src/hooks/useChatStream.test.ts`
- Delete: `src/hooks/useChatStream.seq.test.ts`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: no ChatStream/useChatStream/cacheClear/PermissionHandlers compatibility surface.

- [ ] **Step 1: Search for residual compatibility references**

Run:

```bash
git grep -n -E 'ChatStream|useChatStream|cacheClear|PermissionHandlers' -- src
```

Expected: only the three files planned for deletion. If any other file matches, return to the owning migration task and finish that migration before continuing; do not add an unplanned compatibility edit here.

- [ ] **Step 2: Delete the old hook and suites**

Remove the three files and remaining imports/re-exports. Do not leave a type alias, wrapper hook, or test-only compatibility module.

- [ ] **Step 3: Verify static and scratch transcript call sites**

Run:

```bash
git grep -n -E 'ChatStream|useChatStream|stream=\{' -- src
```

Expected: no ChatStream/useChatStream matches and no aggregate stream prop. Run the existing SubagentOverlay, WorkflowOverlay, and subagent-transcript suites to confirm controlled MessageList behavior remains intact.

- [ ] **Step 4: Run the complete repository verification**

Run: `npm run verify`
Expected: typecheck, lint, all tests, and production build PASS.

- [ ] **Step 5: Perform the required manual smoke checks**

Verify main-session open/loadOlder/reconnect/clear/terminated behavior, Side Chat send/collapse/expand/close, subagent and disk transcript rendering, and both streaming modes. Record any environment-dependent check that could not be exercised instead of claiming it passed.

- [ ] **Step 6: Commit**

```bash
git rm src/hooks/useChatStream.ts src/hooks/useChatStream.test.ts src/hooks/useChatStream.seq.test.ts
git add docs/superpowers/specs/2026-10-29-session-synchronizer-design.md docs/superpowers/plans/2026-10-29-session-synchronizer.md
git commit -m "refactor: retire broad chat stream interface"
```
