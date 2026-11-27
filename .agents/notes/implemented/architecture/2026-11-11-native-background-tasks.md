# Agent Note: Unified native background task ownership

Status: implemented

## Problem

Native Bash and synchronous Agent calls both block their originating `runTurn()` on a tool promise. The app already exposes per-card and whole-turn background controls, but without an execution object that can outlive that wait, native cannot honor them. A Bash-only detach flag would leave Agent behavior, nested calls, stopping, output ownership, and teardown semantics inconsistent.

## Decision

One session-scoped `NativeTaskManager` sits between `runTurn()` and backgroundable tool execution. Bash and Agent declare background metadata; the manager owns task identity, execution promises, independent abort controllers, parent-signal subscriptions, detach, stop, output waits, terminal events, and destruction.

Backgrounding resolves the originating tool wait with one normal acknowledgement while the real execution continues. The actual completion has two halves: a live operational task notification with inline output (the TasksPanel roster) and a model-facing `<task-notification>` user injection that wakes a continuation turn at the next idle window — never a second `tool_result` for the original call. The injection is a durable neutral user message whose XML the host classifies by content (`shared/user-frames.ts`), so the host's existing turn stamping and task fold serve native unchanged; the two host folds (system-frame path and XML path) are idempotent upserts keyed by toolUseId. A foreground settle injects nothing — the parent already holds the report via its `tool_result`. The same manager is shared with nested Agent loops so a nested Bash call can detach without implicitly detaching its parent Agent. Detaching a nested call leaves the outer Agent foreground, and independently detached nested work survives an outer Agent stop.

Detached work survives a later parent interrupt. TasksPanel lists detached calls, including their terminal state and final output, and Stop terminates the selected task. Foreground subagents also appear live (running → terminal) through the parity emission; foreground shells stay silent. `TaskOutput` supports non-blocking reads and bounded blocking waits for tasks in the current process. Destroy settles every execution; a later spawn reconciles stale active native records to stopped with `worker_restart` while preserving their historical rows.

The shipped scope covers mid-flight Bash and synchronous Agent detach, model-initiated `run_in_background`, TasksPanel status/output, explicit stop, model-facing `TaskOutput`, and idle-delivery completion injection (the 2026-11-27 native async-orchestration parity plan). Mid-turn injection delivery, incremental output streaming, and cross-process execution recovery remain deferred. Provider capability projections enable the existing controls for native live and dormant sessions, while unsupported providers still hide per-card background actions and `Alt+B`.

The full behavior and lifecycle contract is in `docs/superpowers/specs/2026-11-11-native-background-tasks-design.md`.

## Alternatives considered

**Bash-only special cases in `runTurn()`.** This would make the first command easier to detach, but Agent and nested Bash would need separate state and signal rules. The most failure-prone behavior—who owns execution after detach—would be duplicated rather than shared.

**Keep using only `turnAbort` and add a background boolean.** A detached task would still be killed by the next parent interrupt. Each task needs its own controller plus a removable parent-signal subscription.

**Emit a second real `tool_result` when execution finishes.** Anthropic history requires one result for each tool call, and the background acknowledgement already answers it. Final output belongs to task events and `TaskOutput`.

**Structured system frames as the ONLY completion surface (rejecting Claude's XML `<task-notification>` injection).** The original decision kept the operational frame alone: smaller, and no other provider's wire format. The async-orchestration parity plan overturned it — the operational frame reaches only the UI, so the model never learned a background completion except by polling `TaskOutput`, while the CLI wakes the model with a user-role XML injection. The injection is now the model-facing delivery path: the XML grammar mirrors the host parser exactly (entity-escaped text fields), the core stays neutral (the host adapter projects the neutral user frame to SDK), and the operational frame still feeds TasksPanel.

**Persist and resume live native tasks across server restarts.** Native execution and model streams are in-process; promising reattachment would require a substantially different process and output-storage architecture. Stale active records are instead reconciled to stopped on the next spawn.

**Hide TasksPanel when task control is unsupported.** The panel is also a historical result surface. Only mutation controls need capability gating.

## Testing

Lifecycle, loop, tool, host, and client tests pin signal ownership, nested detach/stop behavior, inline results, and capability gating. Direct-handle end-to-end coverage exercises Bash and Agent detach, nested Bash, parent interrupt followed by Stop, and destroy/restart. It asserts exactly one acknowledgement or foreground result for each original call; a backgrounded settle adds exactly one continuation turn (the injection) while a foreground settle adds none. `e2e-notification-injection.test.ts` pins the injection contract end-to-end through the real host pump: content-classified user frame, the continuation request carrying the XML, the hook-rewake banner-only regression with per-kind `stop_hook_active` Stop guards, delivery after an interrupted turn, and destroy dropping a pending injection. Restart assertions read folded `session.tasks` state: old active rows become terminal, never-detached foreground calls create no rows, and old `TaskOutput` ids are unknown.

## Consequences

The shared manager makes parent/child ownership and removable signal subscriptions explicit instead of distributing them across tool branches. Inline task-notification results let TasksPanel and SubagentCard display the real report; the model-facing injection reuses the CLI's XML grammar and the host's content classification, so native gains the completion wake with no host pump change. The idle-injection queue is shared with asyncRewake hook wakes (`PendingInjection`), but only the hook kind seeds `stop_hook_active:true` — a completion continuation is an ordinary fresh-guard turn.

Final-output-only retrieval is less useful for very long commands than streaming output, but avoids a new progress protocol. `TaskOutput` cannot retrieve pre-restart tasks even though TasksPanel retains their historical rows; cross-process recovery would require a different execution and output-storage architecture.

## Related

[Task output streaming architecture](../../proposed/architecture/2026-11-14-task-output-streaming.md) proposes the live-output and cross-process output-storage architecture deferred here. It remains blocked on the upstream event and byte contracts; the final-output-only behavior above is still the shipped reality.

[Native TasksPanel foreground parity](../feature/2026-11-27-native-task-panel-parity.md) extends the emission scope owned here: foreground subagents emit a live running → terminal lifecycle and running subagents carry progress, while the execution / signal / detach architecture above is unchanged.
