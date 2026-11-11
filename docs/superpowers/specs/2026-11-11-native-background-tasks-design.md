# Native provider background tasks design

**Date:** 2026-11-11
**Status:** Implemented
**Scope:** Mid-flight foreground Bash commands and synchronous Agent calls in the `native` provider

## Intent

The message-card **background** action is available for both the `claude` and `native` providers. `NativeProvider.capabilities.supportsTaskControl` is `true`, and the existing routes drive native task detach and stop.

The native provider supports the same user-facing operation for both expensive blocking primitives it owns:

- a foreground Bash command that is taking too long;
- a synchronous Agent whose parent turn is waiting for its final report.

Backgrounding must preserve the running work, immediately answer the originating `tool_use` with a background acknowledgement, and let that turn continue. The task must remain visible, stoppable, and readable afterwards.

This is useful because interrupting and restarting loses process state and work already performed. It is not merely a TasksPanel navigation feature.

## Goals

1. `NativeSession.backgroundTasks(toolUseId?)` detaches one matching foreground Bash/Agent call, or every currently foreground backgroundable call when the id is absent.
2. The originating main-thread or nested `runTurn()` immediately receives a non-error `ToolOutcome` acknowledging the background task and continues its model loop.
3. The underlying Bash process or nested Agent loop continues independently of the originating turn's `turnAbort`.
4. `NativeSession.stopTask(taskId)` stops a background task, including a Bash process tree or an in-flight nested Agent turn.
5. Detached tasks appear in the existing TasksPanel with running/terminal state, elapsed time, and final output.
6. A model-facing `TaskOutput` tool can query a task without blocking or wait for its final output with a bounded timeout.
7. Main-thread and nested tool calls obey the same lifecycle rules. Backgrounding a nested Bash call resumes the nested Agent loop without implicitly detaching the outer Agent.
8. The frontend offers per-card buttons and `Alt+B` only when the session provider supports task control.
9. Existing provider-neutral task frames, REST routes, TasksPanel, and task-result persistence are reused.

## Non-goals

- Model-initiated `run_in_background: true` at Bash/Agent launch time.
- Automatic model continuation when a background task finishes after the parent turn has ended. Completion updates the UI; a still-running model can use `TaskOutput`.
- Incremental stdout streaming, Agent `progressSummary`, or partial output in `TaskOutput`. The first version reports running state and final output.
- Resuming execution after a server process restart, or reattaching to old OS processes.
- `TaskOutput` access to tasks from a previous server process. Historical terminal rows remain available in TasksPanel through `TaskResultStore`.
- Backgrounding arbitrary MCP tools, workflows, or tools other than Bash and Agent.
- Parallelizing native tool execution. The existing sequential loop stays unchanged except for detachable outcomes.
- SDK `subagent/*` transcript files or `supportsSubagentTranscripts`. Native sidechain frames remain in the native session log.

## Anti-goals / failure conditions

The feature fails even if the happy path works if any of these occur:

- Interrupting the parent turn kills an already detached task.
- Backgrounding an outer Agent implicitly creates independent tasks for all its nested tools.
- Stopping an outer Agent kills a nested task that was independently detached earlier.
- A second `tool_result` for the original `tool_use_id` is emitted when the real execution finishes.
- A foreground tool that was never backgrounded appears as a background task in TasksPanel.
- A task completion emits a second top-level `result` frame or closes the session's output stream.
- A background acknowledgement is mistaken for the Agent's final report.
- Native sessions continue to show a control that the provider cannot execute.

## User-visible behavior

### Background this task

The existing running Bash and synchronous Agent cards call:

```text
POST /api/sessions/:id/tasks/background
{ "toolUseId": "..." }
```

On success the model-visible outcome is equivalent to:

```text
Task <taskId> is running in the background.
Use TaskOutput with task_id="<taskId>" to retrieve its final output.
```

This is a normal, non-error `tool_result` for the original call. The model can continue, call `TaskOutput`, or finish its turn.

`Alt+B` uses the same route without `toolUseId` and detaches all calls whose own state is still foreground, including eligible nested calls. The existing proxy-id fallback in the route remains valid because native also implements the no-id form.

### TasksPanel

A task enters TasksPanel only when it is detached. The row shows:

- shell or subagent type;
- description;
- `background` marker;
- running state and elapsed time;
- final output when available;
- Stop while non-terminal.

No incremental output is promised in this version.

### TaskOutput

The per-session native tool list includes `TaskOutput` in both main and nested loops:

```ts
{
  task_id: string,
  block?: boolean,   // default false
  timeout?: number   // milliseconds; block mode only, default 30_000, max 600_000
}
```

Behavior:

- Unknown or expired task id: error outcome.
- `block: false`, still running: non-error running status, with no claim of partial output.
- `block: false`, terminal: final output and terminal status.
- `block: true`: wait for terminal output or the timeout/abort signal.
- Timeout while still running: non-error running status so the model can poll again; it does not mark the task failed.
- Stopped tasks return their terminal stopped status and any output produced before the stop.

Terminal records are retained in the live manager with the same 50-record terminal cap used by the host task store. Active records are never evicted.

## Architecture

### One deep module: `NativeTaskManager`

Create `server/providers/native/task-manager.ts`. It owns every detachable execution in one native session, including nested loops.

Its interface has five operations:

```ts
runForeground(metadata, execute, parentSignal, parentTaskId?): Promise<ToolOutcome>
background(toolUseId?): boolean
stop(taskId): Promise<void>
output(taskId, options, signal): Promise<ToolOutcome>
destroy(): Promise<void>
```

The implementation hides:

- task records and the `toolUseId`/`taskId` association;
- per-task `AbortController` instances;
- parent-signal subscriptions and their removal on detach;
- parent/child relationships between an Agent and its nested tools;
- foreground/background/terminal state;
- outcome capture and terminal retention;
- task frame emission;
- stop/timeout waiters and teardown.

`taskId` equals the originating `toolUseId` in this version. Tool-use ids are session-unique, this avoids a second identifier mapping, and the REST route already treats them as opaque strings. This is an internal native choice, not a new host-wide contract.

### Tool metadata, not tool-name branches in the loop

`ToolDef` gains optional background metadata:

```ts
backgroundable?: {
  taskType: 'shell' | 'subagent'
  describe(input): string
  subagentType?(input): string | undefined
}
```

Bash and the per-session Agent tool declare it. Other tools, including `TaskOutput`, do not.

`runTurn()` keeps its existing permission and sequential execution flow. For a backgroundable call it delegates execution to `NativeTaskManager.runForeground`; for every other call it keeps the current direct `tool.run()` path. The loop does not inspect Bash/Agent input itself.

`LoopDeps` carries the session's task manager. The Agent's nested `runTurn()` receives the same manager, so nested Bash calls can detach independently.

### Execution and outcome ownership

For each backgroundable call the manager:

1. Creates a task record in `foreground` state before execution starts.
2. Creates a per-task `AbortController` and passes its signal to `tool.run()`.
3. Subscribes that controller to the caller's signal while the task is foreground.
4. Observes the execution promise immediately, including rejection, so a detached promise can never become unhandled.
5. Returns the real `ToolOutcome` to the waiting loop when it finishes foreground.
6. On detach, removes the caller-signal subscription and resolves the loop's wait with the background acknowledgement.
7. Keeps observing the real execution and stores its final `ToolOutcome` for `TaskOutput` and the terminal task event.

The originating loop therefore emits exactly one `tool_result`: either the real foreground outcome or the background acknowledgement. The manager never emits another `tool_result` for that call.

Errors from tool execution retain the existing conversion to an error `ToolOutcome`. A terminal background outcome maps to `failed` when `isError` is true, `completed` otherwise, and `stopped` when stop was explicitly requested or teardown aborted it.

### Parent and child tasks

`frameCtx.parentToolUseId` identifies the enclosing Agent task for nested calls.

- Detaching a nested Bash call removes only its subscription to the Agent's signal. The outer Agent remains foreground and continues waiting for its nested model loop.
- Detaching an outer Agent makes its signal independent of the main turn. Nested calls still attached to that signal continue with it, but do not become independently listed background tasks.
- Stopping an outer Agent aborts nested calls still attached to its signal.
- A nested call that was independently detached earlier has removed that subscription and survives the outer Agent's stop.
- Session teardown aborts every task regardless of these relationships.

This gives explicit per-card semantics without recursively changing unrelated task ownership.

### Interrupt versus stop versus destroy

| Operation | Foreground task | Detached task |
| --- | --- | --- |
| `interrupt()` / `turnAbort` | Aborts through the current caller-signal subscription | Unaffected; subscription was removed at detach |
| `stopTask(taskId)` | Not offered by TasksPanel; direct calls reject as not backgrounded | Aborts that task's controller |
| `destroy()` / session abort | Aborts | Aborts |

`stop()` aborts and awaits the observed execution's settlement before returning. `destroy()` aborts all records and awaits their settlements before `NativeSession` ends the output stream and closes its log. It emits terminal task events only for detached tasks; a foreground call that never entered TasksPanel must not appear there merely because the session was destroyed. No timeout fallback is added for tools that ignore abort; the real Bash and streaming implementations already honor their signals.

## Task frames and result delivery

Native emits existing provider-neutral system frames through `NativeSession.output`.

### Detach

Before the background acknowledgement is returned to the loop, emit `task_started` with:

- `task_id` and `tool_use_id`;
- `task_type: 'local_bash' | 'local_agent'`;
- description and optional `subagent_type`;
- `is_backgrounded: true`;
- original start time in `receivedAt`.

Emitting the start record before the acknowledgement gives the client's task snapshot authority the earliest possible chance to mark a synchronous Agent async. Existing client rescue/out-of-order handling remains covered by tests.

### Completion

Emit `task_notification` with:

- the same ids and description;
- `status: 'completed' | 'failed' | 'stopped'`;
- optional `reason: 'worker_restart'` only for stale active records reconciled on a later spawn;
- `result`: the final `ToolOutcome.text` when non-empty;
- completion time.

The host's `applyTaskEvent` currently ignores inline `result` on system notifications, and the client's `parseTaskNotification` reads only `summary`. Both narrowings gain optional `result` passthrough. This avoids manufacturing Claude-style XML merely to reuse the result path and lets both TasksPanel and SubagentCard receive the real final report instead of the detach acknowledgement.

The existing pump already folds these frames, persists task snapshots through `TaskResultStore`, and broadcasts `tasks-snapshot`. Native `persistFrame()` continues to ignore system frames; no duplicate task records are added to the native model-history log.

A nested Agent keeps `emitResult: false`; its background completion does not emit a top-level turn result.

## Session wiring and capabilities

`NativeSession` constructs one task manager with its frame emission callback, then constructs:

- the existing Agent tool with the same manager;
- a new per-session `TaskOutput` tool with the same manager.

`rebuildTools()` includes `TaskOutput` alongside Agent and Skill in both MCP and non-MCP branches. Nested loops inherit it through the live tool list. Its factory exports a `TASK_OUTPUT_GUIDANCE` sentence, and `NativeProvider.renderSystem()` registers a static `tool:TaskOutput` prompt section for both parent and nested prompts, matching the existing Agent/Skill treatment.

`NativeSession` implements `backgroundTasks()` and `stopTask()` by delegating to the manager. `NativeProvider.capabilities.supportsTaskControl` is `true`.

`NativeSession.destroy()` stops and settles all tasks before ending output and closing the log.

## Frontend capability gate

`SessionInfo` gains `taskControlSupported?: boolean`, re-derived from the provider registry in `projectSharedSessionFields()` so both `info()` and `infoFromMeta()` report it for live and dormant sessions. It is runtime-derived, not persisted.

The value gates:

- `Chat`'s `backgroundToolAction` context;
- App's `Alt+B` shortcut registration (and therefore its command-palette entry) and handler;
- the Interrupt tooltip's `Alt+B` advertisement.

It does not hide the TasksPanel entry: terminal task history remains useful after a provider change or restart. Non-terminal native records from an earlier process are reconciled to terminal before the UI can offer Stop on them.

No `provider === 'native'` condition is added to React components.

## Persistence and restart reconciliation

### Within one server process

The background acknowledgement is persisted by the existing main/nested tool-result path, so model history remains valid. The real execution outcome lives in the task manager and `TaskResultStore`, not as a second model-history result.

`TaskOutput` can read live and terminal tasks owned by the current `NativeSession`, including tasks that finished after the parent turn ended.

### Sleep, resume, and respawn

Native background execution never survives destruction of its owning in-process session. `destroy()` settles every task as stopped before the replacement session can start.

### Server restart

On native session spawn, any non-terminal records hydrated from `TaskResultStore` belong to the previous process. Reconcile them to:

- `status: 'stopped'`;
- `reason: 'worker_restart'`;
- a fresh `endedAt`;
- preserved result/output and timing metadata.

Persist and broadcast the reconciled snapshot. This prevents an eternal Waiting state or a Stop button for a process that no longer exists.

The native manager starts empty. Consequently `TaskOutput` reports old ids as unknown after a restart; TasksPanel remains the historical output surface. Cross-process `TaskOutput` recovery is deliberately out of scope.

## Testing strategy

Implementation is test-first at the manager interface and then through the existing provider/host seams.

### `NativeTaskManager` unit tests

Cover:

- foreground completion returns the real outcome and emits no task frames;
- detach returns the ack while execution continues;
- exact-id and all-task detach;
- missing/already-terminal id returns false;
- turn abort before detach kills, turn abort after detach does not;
- nested detach leaves the outer Agent foreground;
- outer stop kills attached nested work but not independently detached work;
- stop maps to `stopped`, tool errors to `failed`, normal outcomes to `completed`;
- blocking/non-blocking output, timeout, unknown id, and terminal retention;
- destroy aborts every record, emits terminal events only for detached tasks, and settles before resolution.

### Native loop and tool tests

- A backgroundable tool receives a task-controlled signal and `toolUseId`.
- Non-backgroundable tools retain their existing direct path.
- Main and nested loops emit exactly one result per originating call.
- Bash detach preserves the process and final bounded output.
- Agent detach preserves sidechain parentage and returns the real final report in `task_notification.result`.
- `TaskOutput` appears in main and nested tool schemas and honors its timeout contract.

### Host and client tests

- Route tests already covering native/per-task/no-id behavior remain valid; add native manager integration rather than mocking the capability away.
- `applyTaskEvent` folds inline `result`; `parseTaskNotification` forwards it to SubagentCard.
- Task snapshots flip a detached native Agent to async/background and the real notification overwrites the ack with the final report.
- `SessionInfo` projections derive `taskControlSupported` for live and dormant sessions.
- Chat hides card actions, App removes the `Alt+B` shortcut/command-palette entry, and the Interrupt tooltip omits the shortcut when unsupported; the existing Claude path and advertisement stay available.
- Restart reconciliation terminates stale native active records without altering terminal records or another provider's records.

### End-to-end native tests

Use scripted model streams and controllable tool executions for deterministic coverage:

1. Parent Bash call → detach → parent model continues → background command completes → TasksPanel result and `TaskOutput` agree.
2. Parent Agent call → detach → parent model continues → nested frames retain parentage → notification carries the final report.
3. Nested Bash detach without outer Agent detach.
4. Parent turn interrupt after detach leaves work alive; TasksPanel Stop terminates it.
5. Destroy/restart leaves no active native task records.

## Implementation order

1. Add the capability projection and hide unsupported controls, removing the current dead-button defect independently of the feature work.
2. Build `NativeTaskManager` and its unit tests.
3. Wire backgroundable Bash through `runTurn`, then implement host frames, output, stop, and `TaskOutput`.
4. Share the manager with nested Agent loops and enable Agent detach.
5. Extend host/client result narrowing and SubagentCard behavior.
6. Add teardown/restart reconciliation and end-to-end coverage.
7. Flip `supportsTaskControl` and run the full verification suite.

## Calls made in this design

These were chosen for this proposal rather than dictated by the request:

- One shared task manager for both Bash and Agent, instead of separate implementations.
- Mid-flight detach and `TaskOutput` only; launch-time background flags and automatic completion turns are deferred.
- `taskId === toolUseId` for native tasks.
- Final output only in the first version; no incremental output/progress channel.
- Optional inline `result` on provider-neutral system notifications, instead of synthetic Claude XML.
- No cross-process execution recovery or old-task `TaskOutput` lookup.
- The TasksPanel remains visible regardless of capability; only mutation controls are capability-gated.
