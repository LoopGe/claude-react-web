# Agent Note: Unified native background task ownership

Status: implemented

## Problem

Native Bash and synchronous Agent calls both block their originating `runTurn()` on a tool promise. The app already exposes per-card and whole-turn background controls, but without an execution object that can outlive that wait, native cannot honor them. A Bash-only detach flag would leave Agent behavior, nested calls, stopping, output ownership, and teardown semantics inconsistent.

## Decision

One session-scoped `NativeTaskManager` sits between `runTurn()` and backgroundable tool execution. Bash and Agent declare background metadata; the manager owns task identity, execution promises, independent abort controllers, parent-signal subscriptions, detach, stop, output waits, terminal events, and destruction.

Backgrounding resolves the originating tool wait with one normal acknowledgement while the real execution continues. The actual completion becomes a task notification with inline output, never a second `tool_result` for the original call or a second top-level turn result. The same manager is shared with nested Agent loops so a nested Bash call can detach without implicitly detaching its parent Agent. Detaching a nested call leaves the outer Agent foreground, and independently detached nested work survives an outer Agent stop.

Detached work survives a later parent interrupt. TasksPanel lists only detached calls, including their terminal state and final output, and Stop terminates the selected task. `TaskOutput` supports non-blocking reads and bounded blocking waits for tasks in the current process. Destroy settles every execution; a later spawn reconciles stale active native records to stopped with `worker_restart` while preserving their historical rows.

The shipped scope covers mid-flight Bash and synchronous Agent detach, TasksPanel status/output, explicit stop, and model-facing `TaskOutput`. Launch-time background flags, automatic completion turns, incremental progress, and cross-process execution recovery remain deferred. Provider capability projections enable the existing controls for native live and dormant sessions, while unsupported providers still hide per-card background actions and `Alt+B`.

The full behavior and lifecycle contract is in `docs/superpowers/specs/2026-11-11-native-background-tasks-design.md`.

## Alternatives considered

**Bash-only special cases in `runTurn()`.** This would make the first command easier to detach, but Agent and nested Bash would need separate state and signal rules. The most failure-prone behavior—who owns execution after detach—would be duplicated rather than shared.

**Keep using only `turnAbort` and add a background boolean.** A detached task would still be killed by the next parent interrupt. Each task needs its own controller plus a removable parent-signal subscription.

**Emit a second real `tool_result` when execution finishes.** Anthropic history requires one result for each tool call, and the background acknowledgement already answers it. Final output belongs to task events and `TaskOutput`.

**Reproduce Claude's XML `<task-notification>` injection.** Native already emits structured system frames. Adding optional inline `result` to the existing server/client narrowing is smaller and avoids manufacturing another provider's wire format.

**Persist and resume live native tasks across server restarts.** Native execution and model streams are in-process; promising reattachment would require a substantially different process and output-storage architecture. Stale active records are instead reconciled to stopped on the next spawn.

**Hide TasksPanel when task control is unsupported.** The panel is also a historical result surface. Only mutation controls need capability gating.

## Testing

Lifecycle, loop, tool, host, and client tests pin signal ownership, nested detach/stop behavior, inline results, and capability gating. Direct-handle end-to-end coverage exercises Bash and Agent detach, nested Bash, parent interrupt followed by Stop, and destroy/restart. It asserts exactly one acknowledgement or foreground result for each original call and exactly one top-level turn result. Restart assertions read folded `session.tasks` state: old active rows become terminal, never-detached foreground calls create no rows, and old `TaskOutput` ids are unknown.

## Consequences

The shared manager makes parent/child ownership and removable signal subscriptions explicit instead of distributing them across tool branches. Inline task-notification results let TasksPanel and SubagentCard display the real report without a second model-history result or a provider-specific XML format.

Final-output-only retrieval is less useful for very long commands than streaming output, but avoids a new progress protocol. `TaskOutput` cannot retrieve pre-restart tasks even though TasksPanel retains their historical rows; cross-process recovery would require a different execution and output-storage architecture.
