# Native Background Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native sessions can detach in-flight Bash and synchronous Agent calls, keep them running independently, stop them from TasksPanel, and read their final output through `TaskOutput`.

**Architecture:** A session-scoped `NativeTaskManager` sits between `runTurn()` and backgroundable tools. It owns execution promises, per-task abort controllers, removable parent-signal subscriptions, parent/child ownership, detach/stop/output waits, terminal retention, and task frames. Bash and Agent declare metadata; the sequential loop and existing REST/TasksPanel/task-result store remain in place.

**Tech Stack:** TypeScript ESM (`.js` imports), Node 20, React 19, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-native-background-tasks-design.md`

## Global Constraints

- Cover mid-flight Bash and synchronous Agent detach only. Launch-time `run_in_background`, automatic completion turns, incremental progress, and cross-process execution recovery are out of scope.
- Preserve sequential native tool execution and exactly one `tool_result` for each originating `tool_use_id`; real background output never becomes a second result.
- `taskId === toolUseId` for native tasks. Background acknowledgements name `TaskOutput` and the task id.
- Detached work is independent of `turnAbort`; nested detach does not implicitly detach the outer Agent; session teardown stops everything.
- Only detached tasks emit task frames or enter TasksPanel. Retain at most 50 terminal records; never evict active records.
- `TaskOutput` uses final output only: `block` defaults to `false`, `timeout` is milliseconds with default `30_000` and maximum `600_000`.
- Reuse provider-neutral system task frames and optional inline `result`; do not manufacture Claude XML notifications.
- Do not change Claude provider behavior or add provider-name branches to React components.
- TypeScript ESM imports use `.js`; diagnostics use `createLogger`; no new dependencies.
- Review each task's full diff before its commit. Do not commit unrelated working-tree changes.

## Review Focus

1. **Interrupt after detach:** the detached Bash/Agent must survive the parent turn's later interrupt. Task 2 pins the signal transition; Task 7 pins it end-to-end.
2. **Nested ownership:** detaching/stopping an outer Agent must not kill a nested task independently detached earlier, and ordinary nested detach must leave the outer Agent foreground. Tasks 2 and 5 pin both directions.
3. **Message protocol:** every original call gets exactly one result, background completion emits no top-level `result`, and the acknowledgement never becomes the Agent's final report. Tasks 3, 5, and 7 pin these invariants.
4. **Stale lifecycle state:** destroy settles all work, only detached tasks emit terminal rows, and pre-restart active rows become `stopped/worker_restart`. Tasks 2, 6, and 7 pin teardown and recovery.
5. **Unsupported controls and output waits:** unsupported providers expose no background action or tooltip, while `TaskOutput` handles unknown ids, running tasks, timeout, stop, and terminal eviction without marking the task failed. Tasks 1 and 4 own these cases.

---

### Task 1: Gate background controls by provider capability

**Files:**
- Modify: `shared/session-info.ts`
- Modify: `server/session-manager.ts` (`projectSharedSessionFields`)
- Modify: `src/utils/task-actions.ts`
- Modify: `src/components/Chat.tsx`
- Modify: `src/components/Composer.tsx`
- Modify: `src/App.tsx`
- Test: `server/session-manager.test.ts`
- Test: `src/utils/task-actions.test.ts`
- Test: `src/components/Composer.test.tsx`

**Interfaces:**
- Add `SessionInfoBase.taskControlSupported?: boolean`, derived from `ProviderCapabilities.supportsTaskControl` for live and dormant projections.
- Add `shouldRunBackgroundShortcut({ supported, working, turnActive }): boolean` and extend `shouldOfferBackgroundAction` with `taskControlSupported`.
- Add optional `Composer` prop `backgroundTasksSupported?: boolean` (default `true`).
- UI treats only explicit `false` as unsupported so old fixtures/frames retain Claude-compatible behavior.
- An unsupported focused session has no Alt+B shortcut registration, so its command-palette entry disappears as well as its handler.

- [ ] **Step 1: Write failing capability tests**

```ts
expect(shouldOfferBackgroundAction({
  turnActive: true, terminated: false, hasLiveSyncSubagent: false,
  taskControlSupported: false,
})).toBe(false)
expect(shouldRunBackgroundShortcut({
  supported: false, working: true, turnActive: true,
})).toBe(false)
```

Add a Composer assertion that `backgroundTasksSupported={false}` removes `(Alt+B backgrounds it)` from the Interrupt tooltip while the default keeps it. In `session-manager.test.ts`, create a native session without sending a turn and assert live and dormant `SessionInfo.taskControlSupported === false`; assert the Claude fixture reports `true`.

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

Run:

```bash
npx vitest run src/utils/task-actions.test.ts src/components/Composer.test.tsx server/session-manager.test.ts
```

- [ ] **Step 3: Implement the projection and gates**

Derive `taskControlSupported` in `projectSharedSessionFields()` using `this.providers.get(x.provider ?? 'claude').capabilities.supportsTaskControl`. Pass `session.taskControlSupported !== false` into Chat's action gate and Composer. Register the Alt+B shortcut only when the focused session is supported, and guard its handler with `shouldRunBackgroundShortcut`; removing the registration also removes the command-palette entry. Composer appends the shortcut advertisement only when supported.

- [ ] **Step 4: Re-run tests and typecheck**

```bash
npx vitest run src/utils/task-actions.test.ts src/components/Composer.test.tsx server/session-manager.test.ts
npm run typecheck
```

- [ ] **Step 5: Review and commit**

Review the task diff, fix confirmed findings, then commit only these files with `fix(native): hide unsupported background task controls`.

---

### Task 2: Build the native task lifecycle manager

**Files:**
- Create: `server/providers/native/task-manager.ts`
- Create: `server/providers/native/task-manager.test.ts`
- Modify: `server/providers/native/frames.ts`
- Test: `server/providers/native/frames.test.ts`

**Interfaces:**

```ts
export interface NativeTaskMetadata {
  toolUseId: string
  taskType: 'shell' | 'subagent'
  description: string
  subagentType?: string
}

export class NativeTaskManager {
  constructor(emit: (frame: AgentMessage) => void)
  runForeground(
    metadata: NativeTaskMetadata,
    execute: (signal: AbortSignal) => Promise<ToolOutcome>,
    parentSignal: AbortSignal,
    parentTaskId?: string,
  ): Promise<ToolOutcome>
  background(toolUseId?: string): boolean
  stop(taskId: string): Promise<void>
  destroy(): Promise<void>
}
```

`taskId` equals `toolUseId`. Add `taskStartedFrame` and `taskNotificationFrame` factories carrying the fields in the spec, including optional inline `result`.

- [ ] **Step 1: Write lifecycle tests with controllable deferred executions**

Pin these cases:

```ts
// Foreground completion: real outcome, zero task frames.
// Detach: background() === true, ack names the id and TaskOutput,
// task_started has is_backgrounded:true, execution is still unresolved.
// Completion: task_notification carries status/result, never a tool_result.
// Unknown or terminal background(id): false; no-id detaches all foreground records.
// stop() rejects an unknown or still-foreground id.
// Parent abort before detach aborts; parent abort after detach does not.
// Nested detach leaves the parent foreground; outer stop spares an independently detached child.
// stop() maps to stopped; outcome.isError maps to failed; success maps to completed.
// destroy() aborts every record but emits terminal frames only for detached tasks.
```

Use fake `parentToolUseId` relationships to prove ownership without requiring model streams. Assert `stop()` and `destroy()` do not resolve until the observed execution settles.

- [ ] **Step 2: Run the manager tests and confirm they fail**

```bash
npx vitest run server/providers/native/task-manager.test.ts server/providers/native/frames.test.ts
```

- [ ] **Step 3: Implement `NativeTaskManager` and task frame factories**

Create a per-task controller and subscribe it to the parent signal only while foreground. Observe the execution promise immediately. Detach removes that subscription, emits `task_started`, and resolves only the loop's wait with the non-error acknowledgement. Keep the real outcome for terminal notification and later `TaskOutput`.

Track stop-requested state separately from `ToolOutcome.isError`. Remove parent listeners on every settlement. Retain active records and cap terminal records at 50.

- [ ] **Step 4: Re-run manager tests and typecheck**

```bash
npx vitest run server/providers/native/task-manager.test.ts server/providers/native/frames.test.ts
npx tsc -p tsconfig.node.json --noEmit
```

- [ ] **Step 5: Review and commit**

Review the task diff, fix confirmed findings, then commit with `feat(native): add detachable task lifecycle manager`.

---

### Task 3: Wire Bash and the sequential loop through the manager

**Files:**
- Modify: `server/providers/native/tools/types.ts`
- Modify: `server/providers/native/tools/bash.ts`
- Modify: `server/providers/native/loop.ts`
- Modify: `server/providers/native/native-session.ts`
- Modify: `server/providers/native/subagent.ts` (pass the shared manager through nested `LoopDeps`)
- Modify: `server/session-pump.ts`
- Test: `server/providers/native/loop.test.ts`
- Test: `server/providers/native/tools/bash.test.ts`
- Test: `server/providers/native/native-session.test.ts`
- Test: `server/session-pump.test.ts`

**Interfaces:**
- `ToolDef.backgroundable?: { taskType: 'shell' | 'subagent'; describe(input): string; subagentType?(input): string | undefined }`.
- `LoopDeps.tasks: NativeTaskManager` is required for main and nested loops.
- `NativeSession.backgroundTasks(toolUseId?): Promise<boolean>` and `stopTask(taskId): Promise<void>` delegate to the manager.
- Host `applyTaskEvent` preserves optional string `result` on `system/task_notification`.

- [ ] **Step 1: Add failing loop, session, Bash, and pump tests**

In `loop.test.ts`, use a fake backgroundable tool and deferred execution:

```ts
const wait = runTurn(/* backgroundable call */)
await flushUntilToolStarts()
expect(deps.tasks.background('tu-1')).toBe(true)
const nextRequest = await nextStreamRequest()
expect(toolResultsOf(nextRequest)).toEqual([
  expect.objectContaining({ tool_use_id: 'tu-1', is_error: false }),
])
expect(toolResultsOf(nextRequest)[0].text).toContain('TaskOutput')
```

Assert non-backgroundable tools still receive the original turn signal and direct execution path. Add a NativeSession test that exact-id/no-id delegation reaches the same manager and `destroy()` awaits detached work. Add Bash metadata assertions for description and shell type. In `session-pump.test.ts`, fold a notification with `result: 'final output'` and assert the task record retains it.

- [ ] **Step 2: Run the focused suites and confirm failure**

```bash
npx vitest run server/providers/native/loop.test.ts server/providers/native/tools/bash.test.ts server/providers/native/native-session.test.ts server/session-pump.test.ts
```

- [ ] **Step 3: Implement metadata-driven loop delegation and session controls**

For backgroundable calls, build metadata from the permission-updated input and call `runForeground(..., ctx.parentToolUseId ?? undefined)`. Keep the existing try/catch and result ordering. Construct the manager before Agent creation and pass it through `AgentToolDeps` into nested `runTurn` so nested Bash uses the same ownership tree.

Construct `NativeTaskManager` with the session output callback. Await `tasks.destroy()` in `NativeSession.destroy()` before `output.end()` and log close. Extend the pump's inline result narrowing without changing XML handling.

- [ ] **Step 4: Re-run focused suites and typecheck**

```bash
npx vitest run server/providers/native/loop.test.ts server/providers/native/tools/bash.test.ts server/providers/native/native-session.test.ts server/session-pump.test.ts
npx tsc -p tsconfig.node.json --noEmit
```

- [ ] **Step 5: Review and commit**

Review the task diff, fix confirmed findings, then commit with `feat(native): detach foreground Bash execution`.

---

### Task 4: Add model-facing TaskOutput

**Files:**
- Create: `server/providers/native/tools/task-output.ts`
- Create: `server/providers/native/tools/task-output.test.ts`
- Modify: `server/providers/native/task-manager.ts`
- Modify: `server/providers/native/task-manager.test.ts`
- Modify: `server/providers/native/native-session.ts`
- Modify: `server/providers/native/native-provider.ts`
- Test: `server/providers/native/native-session.test.ts`
- Test: `server/providers/native/prompt/sections.test.ts`

**Interfaces:**

```ts
output(
  taskId: string,
  options: { block?: boolean; timeout?: number },
  signal: AbortSignal,
): Promise<ToolOutcome>

export const TASK_OUTPUT_GUIDANCE = '...'
export function createTaskOutputTool(tasks: NativeTaskManager): ToolDef
```

`TaskOutput` is not backgroundable. Its schema requires `task_id`, accepts `block` and `timeout`, and uses the spec's defaults/cap.

- [ ] **Step 1: Write output and registration tests**

Cover unknown/evicted ids as errors; running and terminal non-blocking reads; blocking completion; timeout returning a non-error running outcome; abort; stopped output; and oldest-terminal eviction after 51 completions. Assert timeout does not change the task's state.

Update tool-list expectations to this order:

```ts
// Main: Bash, Read, Write, Edit, Grep, Glob, LS, Agent, TaskOutput, Skill, ...MCP
// Nested: all of the above except Agent, with MCP preserved.
```

Assert parent and nested system prompts contain the `tool:TaskOutput` guidance section.

- [ ] **Step 2: Run output tests and confirm failure**

```bash
npx vitest run server/providers/native/task-manager.test.ts server/providers/native/tools/task-output.test.ts server/providers/native/native-session.test.ts server/providers/native/prompt/sections.test.ts
```

- [ ] **Step 3: Implement output waits and per-session tool registration**

Resolve all output waiters on terminal settlement or eviction, and remove timeout/abort listeners on every path. Create the tool with the shared manager and insert it between Agent and Skill in both `rebuildTools()` branches. Register `TASK_OUTPUT_GUIDANCE` for parent and nested prompt rendering.

- [ ] **Step 4: Re-run output tests and typecheck**

```bash
npx vitest run server/providers/native/task-manager.test.ts server/providers/native/tools/task-output.test.ts server/providers/native/native-session.test.ts server/providers/native/prompt/sections.test.ts
npx tsc -p tsconfig.node.json --noEmit
```

- [ ] **Step 5: Review and commit**

Review the task diff, fix confirmed findings, then commit with `feat(native): expose background results through TaskOutput`.

---

### Task 5: Enable synchronous Agent detach and final-report delivery

**Files:**
- Modify: `server/providers/native/subagent.ts`
- Modify: `src/session-store/normalize.ts`
- Test: `server/providers/native/subagent.test.ts`
- Test: `server/providers/native/e2e-subagent.test.ts`
- Test: `src/session-store/normalize.test.ts`
- Test: `src/session-store/sidechain-index.test.ts`

**Interfaces:**
- Agent declares `backgroundable.taskType = 'subagent'`; description comes from `input.description`, and `subagentType` is the validated string or `general-purpose`.
- `parseTaskNotification` forwards optional system-frame `result` alongside `summary`.
- Existing `TASKS_SNAPSHOT` remains the only `isAsync` authority.

- [ ] **Step 1: Add Agent and client regression tests**

Script an Agent whose nested run is blocked, detach it, and assert:

```ts
expect(parentToolResult.is_error).toBe(false)
expect(parentToolResult.text).toContain('TaskOutput')
expect(sidechainFrames.every(f => f.parent_tool_use_id === agentToolUseId)).toBe(true)
expect(topLevelResultFrames).toHaveLength(1)
// After nested completion:
expect(notification.result).toBe('real final report')
expect(notification.result).not.toContain('running in the background')
```

Add nested-Bash-without-outer-detach coverage. On the client, prove the detach acknowledgement is rescued to background by the snapshot and the later system notification overwrites it with `result`, without changing `isAsync` in the notification branch.

- [ ] **Step 2: Run Agent/client suites and confirm failure**

```bash
npx vitest run server/providers/native/subagent.test.ts server/providers/native/e2e-subagent.test.ts src/session-store/normalize.test.ts src/session-store/sidechain-index.test.ts
```

- [ ] **Step 3: Add Agent metadata and system-result passthrough**

Keep Agent execution itself unchanged: the manager now supplies its signal and early outcome. Forward optional `result` through `parseTaskNotification`; do not stamp `isAsync` there.

- [ ] **Step 4: Re-run Agent/client suites and both typechecks**

```bash
npx vitest run server/providers/native/subagent.test.ts server/providers/native/e2e-subagent.test.ts src/session-store/normalize.test.ts src/session-store/sidechain-index.test.ts
npm run typecheck
```

- [ ] **Step 5: Review and commit**

Review the task diff, fix confirmed findings, then commit with `feat(native): background synchronous subagents`.

---

### Task 6: Reconcile stale native tasks on spawn

**Files:**
- Modify: `server/session-manager.ts` (`hydrateTasks`)
- Test: `server/session-manager.test.ts`

**Interfaces:**
- Hydrated non-terminal records are reconciled only when `session.provider === 'native'`.
- Reconciliation preserves output/timing metadata, sets `status: 'stopped'`, `reason: 'worker_restart'`, a fresh `endedAt`, then persists and broadcasts the snapshot.

- [ ] **Step 1: Write restart reconciliation tests**

Seed `TaskResultStore` with one running native task and one terminal task, respawn from the same state dir, and assert only the running row becomes stopped with `worker_restart`. Repeat with a Claude session and assert its records are untouched. Assert the reconciled native row no longer contributes to Waiting or offers Stop.

- [ ] **Step 2: Run the manager tests and confirm failure**

```bash
npx vitest run server/session-manager.test.ts
```

- [ ] **Step 3: Implement reconciliation in the existing hydration seam**

Apply it after loading and before the final prune/broadcast. Save the reconciled records through the existing persistence path; do not add native task events to model history.

- [ ] **Step 4: Re-run tests and typecheck**

```bash
npx vitest run server/session-manager.test.ts
npx tsc -p tsconfig.node.json --noEmit
```

- [ ] **Step 5: Review and commit**

Review the task diff, fix confirmed findings, then commit with `fix(native): settle stale tasks after restart`.

---

### Task 7: End-to-end acceptance and capability enablement

**Files:**
- Create: `server/providers/native/e2e-background.test.ts`
- Modify: `server/providers/native/native-provider.ts`
- Modify: `server/providers/native/native-session.test.ts`
- Modify: `server/session-manager.test.ts` (native capability expectations from Task 1)
- Modify: `docs/superpowers/specs/2026-11-11-native-background-tasks-design.md`
- Move: `.agents/notes/proposed/architecture/2026-11-11-native-background-tasks.md` → `.agents/notes/implemented/architecture/2026-11-11-native-background-tasks.md`

**Interfaces:**
- `NativeProvider.capabilities.supportsTaskControl = true` only after the acceptance scenarios pass against the direct handle.
- Existing `/tasks/background` and `/tasks/:taskId/stop` routes require no new shape.

- [x] **Step 1: Write the failing end-to-end acceptance suite**

Use scripted model streams and controllable executions to prove:

1. Bash detach → parent continues → final output agrees between TasksPanel state and `TaskOutput`.
2. Agent detach → parent continues → sidechain parentage remains intact → final notification contains the real report.
3. Nested Bash detach leaves the outer Agent foreground.
4. Parent interrupt after detach leaves work alive; TasksPanel Stop terminates it.
5. Destroy/restart leaves no active native records and never creates rows for never-detached foreground calls; `TaskOutput` reports a pre-restart id as unknown while its historical TasksPanel row remains.
6. No scenario emits a second result for the original call or a second top-level turn result.

Keep the provider capability `false` while writing the direct-handle acceptance tests, then add route-level assertions that currently fail with 501.

- [x] **Step 2: Run the acceptance suite and confirm only capability-gated cases fail**

```bash
npx vitest run server/providers/native/e2e-background.test.ts server/routes/sessions-background.test.ts
```

- [x] **Step 3: Enable the capability and update projections**

Flip `supportsTaskControl` to `true` and update the native capability assertions, including live/dormant projections from Task 1.

- [x] **Step 4: Run focused acceptance and regression suites**

```bash
npx vitest run server/providers/native server/routes/sessions-background.test.ts server/session-manager.test.ts server/session-pump.test.ts src/utils/task-actions.test.ts src/components/Composer.test.tsx src/session-store/normalize.test.ts src/session-store/sidechain-index.test.ts
npm run typecheck
```

- [x] **Step 5: Update decision records and run the full gate**

Mark the design implemented. Move the Agent Note to `implemented/architecture`, change its header/status and rewrite Proposal/Acceptance criteria/Risks into the implemented Decision/Consequences structure required by `.agents/notes/README.md`.

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run verify:agent-notes
git diff --check
```

- [x] **Step 6: Review the complete feature diff and commit**

Run the required full-diff code review, verify and fix confirmed findings, and re-run affected checks. Commit only the native background-task implementation and its documentation with `feat(native): support background tasks and output retrieval`.
