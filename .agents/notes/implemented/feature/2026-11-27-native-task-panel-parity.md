# Agent Note: Native TasksPanel foreground parity and live subagent progress

Status: implemented

## Problem

The TasksPanel, the swarm pill, and the SubagentCard render whatever `session.tasks` holds, with zero provider awareness; the fold pipeline (`applyTaskEvent` in `server/session-pump.ts` → `tasks-snapshot` → the client `TASKS_SNAPSHOT` reducer) is provider-agnostic. The claude provider surfaces a foreground subagent as a running record that settles to terminal with its result, and a running subagent carries a one-line progress summary. Native's task-frame emission reaches the panel only for backgrounded tasks: a foreground subagent runs and finishes invisible, and no running task shows progress. A user who switches a session between providers loses the task roster and the progress signal. The gap is entirely on the emission side — the surface already renders every field parity needs.

## Decision

`NativeTaskManager` emits the foreground subagent lifecycle, and a per-subagent `SubagentProgress` tracker emits live progress, both as neutral operational frames the host adapter projects to the SDK `task_*` shapes. The pump fold and the client reducer are unchanged.

### Foreground lifecycle emission

`runForeground` emits `task/started` with `isBackgrounded: false` when `metadata.taskType === 'subagent'`, and the settle handler emits `task/notification` carrying the final report as `result` for a foreground subagent. Foreground shells emit nothing — claude parity: only agents and backgrounded tasks appear in the panel. The neutral `task/started` frame carries an `isBackgrounded` boolean the adapter projects (rather than a hardcoded `true`), so the pump's existing `task_started` upsert flips the flag on a mid-flight foreground→background detach with no new fold logic. A foreground subagent backgrounded mid-flight has `wasForeground === false` at settle and takes the backgrounded branch, so it notifies exactly once.

### Live progress: mechanical frame plus summary fork

The tracker observes the nested run through the subagent's existing `turnDeps.emit` interceptor and ticks on the CLI's ~30 s cadence (`PROGRESS_INTERVAL_MS`). Every tick emits a mechanical `task/progress` carrying the usage triple (`totalTokens` / `toolUses` / `durationMs`) and `lastToolName`, independent of any option. When `agentProgressSummaries` is on (default, mirroring the claude provider) and there is new material since the last fork and no fork in flight, the tick also forks the subagent's own conversation to produce a one-line `summary`.

The fork reuses the subagent's exact `model` / `system` / `tools` prefix so the request reads the prompt cache the subagent's own rounds warmed; only the fork tail and a short output are new tokens. It streams a single round with a small output cap (`PROGRESS_MAX_TOKENS = 64`), a breakpoint-free user tail via `appendMessages`, and effort / fast-mode stripped through the seam's `forkProfile` flag — a summary must not ride fast-mode billing or a subagent profile's effort override. `thinking: { type: 'disabled' }` applies under the same model gate as the prompt-suggestion fork (`runSuggestion` in `native-session.ts`, the direct in-repo precedent). The collected text is normalized to one present-tense line (`normalizeProgressSummary`: trim, first line, 100-code-point cap, reject empty) and rides as `summary` on a second `task/progress` frame; the client folds latest-wins.

The tracker is neutral core: it imports only the vocabulary, the wire projection, sibling core types, and neutral `shared/*`. It starts when the nested run starts and stops in the subagent's `finally` (clear the timer, abort any in-flight fork); the fork's signal is tied to the subagent's run signal, so an interrupt cancels it. The failure contract is `runSuggestion`'s: abort → silent, error → `log.debug` plus a `native_task_progress_total` metric, never a throw into the subagent. A failed or skipped fork still leaves the mechanical fields on the tick's frame. The fork is a read-only observation — it never writes the transcript, the v3 log, read-state, PDF reservations, or session usage.

### Fork-tail validity against a mid-round snapshot

`runTurn` pushes the assistant message into history before executing its tools and the matching `tool_result` messages only after they finish. A tick during tool execution — the dominant state of a working subagent — therefore snapshots a history ending in an assistant message whose `tool_use` blocks have no results. The API rejects a following user message that omits those results, so the fork tail is ONE user message that first carries a synthetic `tool_result` block for every trailing unmatched `tool_use` (placeholder content `(tool still running)`, keyed by the real `tool_use_id`), then the summary prompt text. The synthetic results are ephemeral fork-tail content: never persisted, never fed back to the subagent, and they let the summary name in-flight tools. A snapshot ending in complete tool results (or plain user text) gets a prompt-only tail — consecutive same-role user messages are API-legal. The `runSuggestion` precedent never hits the unmatched case because it forks only at turn end, when history is well-formed.

### Emit-only usage

The usage triple rides the wire for SDK shape parity but is emit-only: the pump's `task_progress` fold reads only `summary` / `last_tool_name` / `description` / `subagent_type`, and `TaskRecordUi` (`shared/tasks.ts`) has no usage fields — for claude too. Surfacing token / tool / duration counts would extend `shared/tasks.ts`, the pump, the reducer, and the UI; that is a new feature beyond parity and is out of scope.

### Transport seam

The fork reaches the transport through the subagent's existing `AgentToolDeps.streamFor` → `NativeSession.streamFor` seam, widened to forward `appendMessages`, an optional `maxTokens` (absent falls back to the session default), and the `forkProfile` effort / fast-mode strip. The test seam flattens the tail into `messages` so scripted streams read the full fork content. This is the only transport change; there is no second fork-specific dep.

## Alternatives considered

**A separate small-model summary call.** Re-sending the subagent context to a small model without the prompt cache pays full input cost on every tick and produces a lower-quality summary from a model that did not reason over the work. The CLI's documented strategy is to fork the subagent's own conversation so the prefix is a cache read; the fork matches it.

**Trim the incomplete round instead of synthesizing results.** Dropping the trailing unmatched `tool_use` round would make the tail legal but snapshot stale state and lose the ability to name the tool currently running. Synthetic placeholder results keep the freshest snapshot and let the summary describe in-flight work; they cost nothing durable because the tail is ephemeral.

**Surface the usage triple in the panel.** Tempting because the numbers are already on the wire, but claude emits and drops them identically; making them visible is a separate feature touching four layers, not parity.

**Foreground shells in the panel.** Claude shows only agents and backgrounded tasks; a foreground Bash settles silently. Matching that keeps the panel's meaning consistent across providers.

**A second fork-specific transport dep.** A dedicated fork streamer would duplicate the seam's credential / retry / projection wiring. Widening the existing `streamFor` request keeps one transport path and leaves existing callers unchanged.

## Consequences

The panel means the same thing regardless of provider, with zero client change: the existing fold and reducer already handle every field parity emits. Progress is cheap when the subagent prefix is cache-warm — only the tail and short output are new tokens.

The always-on-thinking limitation is inherited from the prompt-suggestion fork: models whose ids match the thinking classifier but reject `thinking:disabled` (Opus 5.5 / Sonnet 5.5) 400 on the fork. The fork silently skips there (the failure contract), and mechanical progress still emits; a thinking-mode-aware gate is a scheduled follow-up. A cold prefix pays full input cost for that fork; the no-new-material skip and the one-in-flight bound keep this rare. Usage numbers remain invisible, matching claude — parity, not a regression.

Knowingly left out: usage surfacing, foreground shells, `task_updated` emission (native has no state transition that needs it beyond `task_started` / `task_progress` / `task_notification`), and any change to the subagent-watcher backstop (it polls the CLI's JSONL transcript and is claude-specific; native emits its own frames directly and needs no watcher).

## Testing

The end-to-end proof (`server/providers/native/e2e-subagent.test.ts`) drives a foreground subagent through `SessionManager` and asserts the real pump fold: a running record keyed by the Agent tool_use id (`isBackgrounded: false`, `taskType: 'subagent'`), a mid-run `task_progress` folding `progressSummary` / `lastToolName`, and a terminal record whose `result` equals the nested report; a foreground shell produces no record. The progress cadence is advanced with fake interval timers while `vi.waitFor` polls on real timers.

A client reducer pin (`src/session-store/reducer.test.ts`) dispatches a native foreground record (`isBackgrounded: false`, running), its terminal notification-folded record carrying the inline report, and the Agent tool_result, and asserts the `activeSubagents` entry settles exactly once — one record, `isAsync` stays false, the canonical tool_result payload wins — pinning the zero-client-change claim against the foreground notification + tool_result coexistence.

Unit pins cover vocabulary purity and neutrality for the new frame, the adapter's exact SDK projection, the task-manager foreground / shell / detach lifecycle, and the tracker's cadence, fork-tail validity, option gating, and silent failure contract.

## Related

[Unified native background task ownership](../architecture/2026-11-11-native-background-tasks.md) owns the `NativeTaskManager` execution / signal / detach architecture this emission extends; its background-only panel scope is widened here to include live foreground subagents.

[Provider seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md) owns the adapter boundary: the neutral core emits task frames, and the host adapter remains the sole SDK projection point.