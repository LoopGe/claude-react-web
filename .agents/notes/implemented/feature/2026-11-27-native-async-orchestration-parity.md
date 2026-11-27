# Agent Note: Native async-orchestration parity

Status: implemented

## Problem

The native provider's async-orchestration tool surface trails the pinned Claude CLI (2.1.311): no Task\* checklist family, no model-initiated backgrounding (`run_in_background`), no model-facing TaskStop, no Monitor. A background completion reaches the TasksPanel through the operational task frame, but the model learns of it only by polling TaskOutput — the CLI wakes the model with a user-role `<task-notification>` injection. The host machinery these features need already exists and is provider-agnostic: the Task\* fold (`shared/task-list.ts`), the content-based user-frame classification (`shared/user-frames.ts`), and the pump's notification fold / stamp / hide path. The gap is entirely on the native tool and emission side.

## Decision

The parity surface is built from native tools and neutral emissions over the existing host folds; the host pump, the client reducer, and the TasksPanel are unchanged. The execution / signal / detach architecture is owned by [unified native background task ownership](../architecture/2026-11-11-native-background-tasks.md); this note owns the tool surface and the delivery mechanism.

### Task\* checklist family

A per-session `NativeTaskStore` (`task-store.ts`) holds the full record (subject, description, status, activeForm, blocks, blockedBy, owner, metadata) with sequential numeric ids. TaskCreate / TaskUpdate mutate it; TaskGet / TaskList are pure reads. The transcript is the persistence: `rebuild` folds the neutral log's TaskCreate / TaskUpdate tool_use inputs plus the create's tool_result text on resume, gated on a successful non-error result. TaskCreate's result text is exactly `Task #<n> created successfully: <subject>` because the host fold assigns ids by parsing `#N` from that text (`parseTaskId`) — the result text is the id contract, not the input. The store keeps the richer fields for TaskGet / TaskList parity; the host fold needs only the `#N` text. TodoWrite stays registered beside the family (the CLI carries both).

### Authoritative tasklist snapshot seam

`deriveTaskListForSession` (`server/tasklist-state.ts`) gains a native branch: it reads the neutral v3 log through `nativeHistoryCache` — the same host read cache the history path uses, with events projected to SDK RawLines at the adapter seam — and folds the renderable lines with the existing `deriveTaskListFromLines`. No second parser. Native logs carry sidechain frames inline, so main + sidechain fold in one seq-ordered pass (the CLI path merges two files). One resolver serves both consumers: the HTTP snapshot (`SessionManager.tasklistSnapshot`) and the live `tasklist-snapshot` WS broadcast (`session-broadcaster.ts`), so the authoritative base layer under the client's window fold agrees across live and dormant reads.

### Model-initiated backgrounding, opt-in for Bash AND Agent

`ToolDef.backgroundable` gains `shouldBackground?(input): boolean`; the loop starts `tasks.runForeground(...)` and, when the predicate holds, calls `tasks.background(call.id)` before awaiting the execution — the detach resolves the tool wait with the TaskOutput acknowledgement while the work continues on its own controller. Bash and Agent both expose `run_in_background?: boolean` with `shouldBackground: (i) => i.run_in_background === true`. **Both default FALSE**, deliberately not the CLI's Agent-default-true: default-backgrounding Agent would turn the parent's tool_result from the subagent report into a detach ack, breaking the established foreground report contract (SubagentCard, the subagent e2e). The parity gap is the capability (the parameter exists), not the default policy.

### TaskStop

`TaskStop` accepts `task_id` only and wraps `NativeTaskManager.stop`, which requires a backgrounded task. Unknown or non-backgrounded ids return a soft `isError` result, not a throw. Named-agent addressing (`name` param) needs the named-agent feature and is out of scope.

### Content-classified completion injection

A backgrounded settle has two halves: the live `task/notification` operational frame (TasksPanel roster) and a model-facing injection. The injection is a durable neutral `user/message` whose body is `<task-notification>` XML (`taskNotificationXml`, entity-escaped text fields, `<status>` always verbatim, `<tool-use-id>` optional). The host's `classifyUserFrameOrigin` classifies it BY CONTENT before any marker check, so the existing stamp / fold / ring / broadcast path serves it with zero host change and **no synthetic marker**. The XML grammar mirrors the host parser exactly (unit-pinned against the real parser, including markup-in-result round-trips). A foreground settle injects nothing — the parent already holds the report via its tool_result. The two host folds (system-frame path and XML path) are idempotent upserts keyed by toolUseId, so the panel shows one record. Emitting a user conversation frame required a deliberate vocabulary extension (`UserMessage` in the emission / envelope unions) and one adapter projection (`projectUserInjection`); the core stays neutral.

### PendingInjection union and the per-kind Stop guard

The wake queue item is a discriminated union: `{ kind: 'hook-rewake'; wake: HookWake } | { kind: 'task-notification'; notification: TaskNotificationFacts }`. Hook-rewake keeps `stopHookActive: true` — it is Stop-hook feedback, and the flag is the loop guard that lets a rewake's own Stop hook terminate. A task-notification continuation is NOT stop-hook feedback, so its turn seeds `stopHookActive: false` (an ordinary fresh-guard turn); an ordinary user turn seeds undefined. Interrupt / stop does not withdraw pending notifications (CLI parity — they deliver at the next window); `destroy()` drops them without hanging teardown.

### Mid-turn round-boundary delivery

`drainInjection` is a loop dep sibling to `drainSupplement`, called at the top of every round before the request is built. It admits ONLY the task-notification kind: each entry is appended durable (`log.append` → `flush` → clear-after-flush → emit), then appended to model history verbatim, so a Monitor event or a background completion joins the NEXT round of a long turn instead of waiting for full settlement. Hook-rewakes stay idle-only (their banner + feedback shape is a turn-start concern, not mid-round context). User input keeps its idle-window priority over pending injections. The durability discipline mirrors `injectSupplements`: a rejected flush throws out of the turn with the batch still queued, and the idle wake branch delivers it.

### Monitor

Monitor watches a shell command's stdout lines or a WebSocket's text frames and runs as a background task through the SAME `backgroundable` machinery (`taskType: 'monitor'` → the `local_monitor` frame discriminant → the client's `'monitor'` alias) — no separate task registration, so TaskStop, the panel, and the settle inject all serve it unchanged. Events batch within a ~200 ms window into ONE injection (one model wake, not one turn per line). Two delivery shapes are deliberately distinct: event batches carry no `toolUseId` and an empty result (non-foldable — the host renders the `<event>` lines as a neutral card and never settles the running record), while the manager's backgrounded-settle inject carries the `toolUseId` and folds the record to terminal exactly once. A 64 KiB cap bounds both the partial-line buffer and each emitted event, with a `...[line truncated]` marker; complete lines are extracted before the remainder is capped so a newline is never lost. An optional `ToolDef.validate?(input)` hook runs BEFORE `runForeground` (Monitor opts in), so malformed input produces a clean error tool result and never registers a background record — the loop reads `backgroundable.describe(input)` before `run`, so validation must precede registration. Expiry (`timeout_ms`, default 300 s, cap 1800 s) is the designed end of a watch: status completed, not failed.

## Alternatives considered

**Synthetic-marker-based injection.** Stamping the native injection with the host's synthetic marker would route it through the marker rung, but content classification already runs first and is provider-agnostic — the XML body IS the classification key. A marker would add host coupling for a fact the content already carries.

**Reusing HookWake as-is for notifications.** `HookWake.stopHookActive` is a hardcoded `true` literal, correct for hook feedback and wrong for a completion continuation: it would mislabel the notification turn's Stop dispatch and defeat the Stop-hook loop guard's meaning. The discriminated union keeps each kind's guard semantics explicit.

**Idle-only delivery for everything.** The idle wake queue waits for full turn settlement, which makes Monitor useless during a long turn — the exact situation a watch exists for. The round-boundary drain delivers notifications mid-turn while hook-rewakes keep their proven idle-only contract.

**The CLI's Agent-default-true backgrounding.** Flipping the default turns the parent tool_result into a detach ack and breaks the foreground report contract. Opt-in for both tools keeps the report path intact; the capability is the parity, not the policy.

**A second parser for the native tasklist derive.** Reading the neutral log with a dedicated tasklist parser would duplicate the projection and drift from the history read path. The `nativeHistoryCache` adapter-seam projection is the single read surface.

**Monitor registering its own task record.** A bespoke registration path would duplicate the detach / stop / settle / inject machinery and need its own panel wiring. Riding `backgroundable` gives Monitor every task behavior for free; the tool needs only the inject sink and a spawn port.

**Withdrawing pending notifications on stop.** Tempting for queue hygiene, but the CLI keeps them deliverable after an interrupt; matching that keeps the model's completion knowledge consistent across providers.

## Consequences

The model-facing completion wake, the Task\* checklist, and Monitor all ride existing host folds and client surfaces with zero host pump or client change; the neutral core stays SDK-free (the adapter is the sole projection point). The opt-in backgrounding default means a native model must explicitly ask for background work where a CLI model gets it by default for Agent — a deliberate policy difference, not a missing capability. TaskStop addresses tasks by id only. The mid-turn drain makes notification latency a round boundary rather than a full turn, at the cost of one more queue-drain site whose durability discipline must match `injectSupplements`.

## Deferred

- Workflow / Cron\* / ScheduleWakeup / SendMessage / ListAgents — the larger orchestration cluster.
- Named-agent TaskStop addressing; Agent `isolation` / `effort` / `model`-enum parity beyond the existing override.
- The structured-run headless path (`structured-run.ts`) registers an inline `NativeTaskManager` with a no-op sink and no TaskOutput tool, and does not destroy it: model opt-in backgrounding there is bounded by the command's own lifetime but unreaped.
- Flush-failure injection duplication is theoretical: it needs a persistent disk write failure across the drain flush, the turn/end flush, and the wake flush. The clear-after-flush discipline is kept; no speculative dedup for an unobserved failure.

## Testing

Structural pins (`vocabulary/neutrality.test.ts`, `host-free.test.ts`) gate every new core file's imports. Unit suites pin the store rebuild, the four Task\* tools, TaskStop, the XML grammar against the real host parser, the Monitor batching / caps / validate hook, and the loop's round-boundary drain. End-to-end suites through the real host pump pin the live fold and provisional-id resolution (`e2e-task-list`), model-initiated detach and the foreground report regression (`e2e-background`), the content-classified injection with per-kind Stop guards and interrupt / destroy semantics (`e2e-notification-injection`), and mid-turn delivery, hook-rewake idle-only regression, user-input priority, expiry, re-arm, and resume rebuild (`e2e-monitor`). `tasklist-state.test.ts` pins the native derive seam against the projected-lines fold and the CLI regression. Some e2e wall-clock assertions are load-sensitive under parallel vitest on win32; a flaky file is confirmed by an isolated re-run.

## Related

[Unified native background task ownership](../architecture/2026-11-11-native-background-tasks.md) owns the `NativeTaskManager` execution / signal / detach architecture and the two-half completion decision; this note owns the parity tool surface and the injection delivery mechanism (idle queue plus mid-turn drain).

[Native TasksPanel foreground parity](2026-11-27-native-task-panel-parity.md) owns the foreground subagent lifecycle and live progress emission that the panel renders beside these background records.

[Provider seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md) owns the adapter boundary the injection projection and the tasklist read seam respect.

[User frame origin identity](../architecture/2026-11-19-user-frame-origin-identity.md) owns the content classification the injection rides.