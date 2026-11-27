# Native provider TasksPanel parity — design

Date: 2026-11-27
Status: proposed
Owner: native provider

## Intent

The native provider's TasksPanel only reflects tasks that were explicitly
backgrounded. A foreground subagent runs and finishes without ever appearing
in the panel, and no running task shows live progress. The claude provider
shows both: foreground subagents appear as running records that settle to
terminal, and running subagents carry a one-line progress summary. This
design brings native to that same behavior so the panel means the same thing
regardless of which provider backs the session.

The why is consistency of the surface, not a new capability: a user who
switches a session between providers should not lose the task roster or the
progress signal. The panel, the swarm pill, and the SubagentCard already
render whatever `session.tasks` holds; the gap is entirely on the emission
side.

## Current state

The fold pipeline is provider-agnostic. The pump folds `task_*` system frames
into `session.tasks` (`server/session-pump.ts:219` `applyTaskEvent`,
`:1563` fan-out) and broadcasts `tasks-snapshot`; the client renders it with
zero provider awareness. Native participates through two neutral operational
frames projected by the host adapter (`server/providers/native-host-frame-adapter.ts:282-305`):

- `task/started` → `task_started`, emitted only on detach
  (`server/providers/native/task-manager.ts:189`), projected with
  `is_backgrounded: true` hardcoded.
- `task/notification` → `task_notification`, emitted only when a
  **backgrounded** task settles (`task-manager.ts:101`, the `wasForeground`
  else-branch).

Two consequences:

1. **Foreground tasks never enter the panel.** A foreground subagent's settle
   resolves the tool loop directly (`task-manager.ts:98-99`) and emits nothing.
   The claude CLI emits `task_started` (`is_backgrounded: false`) at foreground
   agent launch and `task_notification` at its settle, so claude's panel shows
   the full foreground lifecycle.
2. **No live progress.** Native emits no `task_progress` / `task_updated`, so
   `progressSummary` / `lastToolName` / usage never populate. The claude
   provider feeds these via `agentProgressSummaries`.

## Goals

- A foreground **subagent** appears in the panel as a running record at launch
  and settles to a terminal record with its result, matching claude.
- Running subagents carry live progress: a model-generated one-line `summary`
  (when the progress-summary option is on) plus `last_tool_name`, surfaced in
  the panel exactly as claude surfaces them. The `usage` triple
  (`total_tokens` / `tool_uses` / `duration_ms`) is emitted on the wire for SDK
  shape parity but is **emit-only**: the pump's `task_progress` fold
  (`session-pump.ts:316-328`) reads only `summary` / `last_tool_name` /
  `description` / `subagent_type`, and `TaskRecordUi` (`shared/tasks.ts`) has no
  usage fields — for claude too. Surfacing usage numbers would be a new feature
  beyond parity and is explicitly out of scope (see Non-goals).
- The progress summary uses the CLI's fork strategy: reuse the subagent's own
  model and prompt cache, not a separate small-model call.
- Zero client change. The existing `task_progress` fold and `TASKS_SNAPSHOT`
  reducer already handle every field the panel renders (`summary`,
  `last_tool_name`); the emit-only `usage` triple rides the wire and is dropped
  by the fold, identically to claude.

## Non-goals

- Foreground **shells** stay out of the panel (claude parity: only agents and
  backgrounded tasks appear). A foreground Bash settles silently as today.
- No `task_updated` emission. The pump handles it, but native has no state
  transition that needs it beyond what `task_started` / `task_progress` /
  `task_notification` already carry.
- No change to the subagent-watcher backstop. That polls the CLI's JSONL
  transcript (`server/subagent-watcher.ts:101`) and is claude-specific; native
  emits its own frames directly and needs no watcher.
- No surfacing of the `usage` triple in the panel. Claude emits it on the wire
  and drops it at the fold; native matches. Making token/tool/duration counts
  visible would extend `shared/tasks.ts`, the pump, the reducer, and the UI —
  a separate feature, not parity.
- No fix for the always-on-thinking `thinking:disabled` 400 (see Constraints).

## Anti-goals

- A progress fork that blocks, errors, or slows the subagent's own turn.
  Progress is best-effort; every fork failure is silent.
- A fork that writes into the transcript, the v3 log, read-state, PDF
  reservations, or session usage. It is a read-only observation.
- A separate small-model summary call that re-sends the subagent context
  without the prompt cache — more expensive and lower quality than the fork.
- Hardcoded color or client-side special-casing of native task records.

## Design

### A. Foreground subagent lifecycle (task-manager)

`NativeTaskManager` owns task-frame emission. Extend it to emit for foreground
subagents, keyed on `metadata.taskType` (already present,
`task-manager.ts:8`):

| moment | subagent | shell |
|---|---|---|
| foreground launch | `task/started`, `isBackgrounded: false` (new) | nothing |
| foreground settle | `task/notification` with result (new) | nothing |
| detach (background) | `task/started`, `isBackgrounded: true` (existing) | same (existing) |
| backgrounded settle | `task/notification` (existing) | same (existing) |

- Launch: in `runForeground`, after the record is registered, emit
  `task/started` when `taskType === 'subagent'`.
- Settle: in the `settled` handler, the foreground branch keeps resolving the
  loop **and** emits `task/notification` when `taskType === 'subagent'`. The
  backgrounded branch is unchanged. A foreground subagent backgrounded
  mid-flight has `wasForeground === false` at settle, so it takes the
  backgrounded branch and emits exactly one notification — no double fire.
- The `task/started` neutral frame gains an `isBackgrounded: boolean` field;
  the adapter projects it instead of the hardcoded `true`. The pump's
  `task_started` upsert (`session-pump.ts:287`) already flips `isBackgrounded`
  on a foreground→background detach, so the mid-flight background case needs
  no new pump logic.

The foreground `task_notification` carries the final report as `result`, the
same shape claude emits. The pump folds it into a terminal record while the
SubagentCard settles via the tool_result; both paths coexist exactly as they
do for claude (a test pins this — see Test plan).

### B. Live progress (mechanical + summary fork)

A per-subagent progress tracker observes the nested run and emits
`task/progress` on a ~30 s cadence (the CLI's interval, `sdk.d.ts:2121`).

**Observation.** The subagent's `turnDeps.emit` interceptor
(`server/providers/native/subagent.ts:231`) already sees every frame. Feed the
tracker from there:

- `tool_uses`: count `tool_use` blocks.
- `last_tool_name`: the most recent `tool_use` name.
- `total_tokens`: accumulate `AssistantFrame.usage` per round.
- `duration_ms`: `now - startedAt`.
- a "new material since last fork" flag (any assistant text or tool call).

**Mechanical emission.** Each tick emits `task/progress` carrying the usage
triple and `last_tool_name`, regardless of the summary option. This matches
claude, where the mechanical fields ride `task_progress` independent of the
model-generated `summary`.

**Summary fork.** When the option is on, the tick also forks the subagent
conversation to produce the `summary`, reusing the prompt-suggestion fork
machinery (`native-session.ts:1536` `runSuggestion` is the direct precedent):

1. Skip if no new material since the last fork, or a fork is already in flight
   (at most one per subagent).
2. Snapshot `nestedHistory` (`subagent.ts:219`) — slice it, since `runTurn`
   keeps appending concurrently.
3. Project the snapshot to wire via `projectNativeHistoryToWire`
   (`wire/wire-projection.ts:100`) with the subagent's `attachmentProjection`.
4. Build the fork request: the **same** `model` / `system` / `tools` prefix the
   subagent's own rounds use (so `buildRequestBody`'s cache breakpoints hit the
   shared prefix), plus a breakpoint-free fork tail via `appendMessages`
   (`anthropic-stream.ts:51`). Single round, `thinking: { type: 'disabled' }`
   under the same model gate as `runSuggestion` (`native-session.ts:1575`),
   small `maxTokens`, text-only collection.
5. **Make the tail legal against a mid-round snapshot.** `runTurn` pushes the
   assistant message into history *before* executing its tools
   (`loop.ts:245`) and the matching `tool_result` user message only after they
   finish (`:524`). A tick during tool execution — the dominant state of a
   working subagent — therefore snapshots a history ending in an assistant
   message whose `tool_use` blocks have no `tool_result`s. The API rejects a
   following user message that omits those results, so the fork tail is a
   single user message that first carries **synthetic `tool_result` blocks**
   for every trailing unmatched `tool_use` (placeholder content such as
   "(tool still running)", keyed by the real `tool_use_id`), then the summary
   prompt text. The synthetic results are ephemeral fork-tail content: never
   persisted, never fed back to the subagent, and they let the summary name
   in-flight tools. When the snapshot instead ends in a complete `tool_result`
   user message, the tail is an ordinary consecutive user message — legal, since
   the API combines consecutive same-role messages into one turn. The
   `runSuggestion` precedent never hits the unmatched case because it forks only
   at turn end, when history is well-formed.
6. Normalize the collected text to one present-tense line (strip whitespace,
   cap length, reject empty/multi-line — the `normalizeSuggestion` /
   `screenSuggestion` pattern). On a pass, ride it as `summary` on the tick's
   `task/progress`.

Cost: the prefix is a prompt-cache read (0.1x); only the fork tail and the
short output are new tokens. This is why the SDK documents the fork as
"typically minimal" cost (`sdk.d.ts:2124`).

**Lifecycle.** The tracker starts when the nested run starts and stops in the
subagent's `finally` (`subagent.ts:345`): clear the timer, abort any in-flight
fork. The fork's abort signal is tied to the subagent's `ctx.signal`, so a
subagent interrupt cancels its fork. The failure contract is `runSuggestion`'s:
abort → silent; error → `log.debug` + a metric, never a throw into the
subagent. A failed or skipped fork still leaves the mechanical fields on the
tick's frame.

### C. Neutral vocabulary + adapter projection

`task/progress` is a new envelope-less `OperationalFrame` member
(`vocabulary/live-frame.ts:58`), shaped like the other task frames (no
session_id/uuid/parent — task frames carry none on the SDK side either,
`live-frame.ts:44`):

```
{ type: 'task/progress'; taskId; toolUseId; description; subagentType?;
  usage: { totalTokens; toolUses; durationMs }; lastToolName?; summary?; time }
```

`task/started` gains `isBackgrounded: boolean`.

The host adapter (`native-host-frame-adapter.ts`) owns the SDK projection:

- `task/progress` → `{ type: 'system', subtype: 'task_progress', task_id,
  tool_use_id, description, subagent_type?, usage: { total_tokens, tool_uses,
  duration_ms }, last_tool_name?, summary?, receivedAt: time }` — the exact
  `SDKTaskProgressMessage` shape (`sdk.d.ts:6334`).
- `task/started` → `is_backgrounded: event.isBackgrounded`.

`isOperationalFrame` (`native-session.ts:1658`) adds the `task/progress`
discriminant so the frame rides the existing live-only operational emission
path (`emitFrame`, `:1671`) — pushed verbatim to the live channel, never
persisted (R6). The neutrality pin (`native/vocabulary/neutrality.test.ts`)
and the live-frame purity pin extend to cover the new member; the adapter
remains the sole SDK boundary importer.

### D. Transport seam (appendMessages through streamFor)

The subagent reaches the transport through `AgentToolDeps.streamFor`
(`subagent.ts:51`) → `NativeSession.streamFor` (`native-session.ts:1463`) →
`defaultStream` (`:1420`). Neither currently forwards `appendMessages`; the
suggestion fork bypasses them and calls `streamAnthropicMessages` directly
(`:1650`). `defaultStream` also hardcodes `maxTokens: DEFAULT_MAX_TOKENS`
(16384, `:1439`) and applies the **session's** live `effortLevel` / `fastMode`
(`:1442-1443`) — none of which a cheap progress fork should inherit.

Widen the `streamFor` / `defaultStream` request type to carry, alongside
`appendMessages?: unknown[]`:

- `maxTokens?: number` — the fork passes a small cap (a one-line summary needs
  tens of tokens, not 16384); absent falls back to `DEFAULT_MAX_TOKENS` so
  existing callers are unchanged.
- an effort / fast-mode **strip** for the fork: `runSuggestion` deliberately
  sends no effort / fastMode / thinkingDisplay (`:1566-1575`), and the progress
  fork matches — a summary must not ride fast-mode billing or a subagent
  profile's effort override. The seam expresses this as an explicit
  "fork profile" flag (or nullable effort/fastMode overrides) that
  `defaultStream` honors by omitting those fields, rather than reading the
  session's live values.

Forward all three to `streamAnthropicMessages`. The test seam
(`streamSupplier`) flattens the tail into `messages` so scripted tests see the
full fork content, exactly as `runSuggestionFork` does (`:1642`).
`AgentToolDeps.streamFor`'s signature widens to match. The progress fork then
calls `deps.streamFor({ model, system, tools, messages: projectedPrefix,
appendMessages: forkTail, maxTokens: SMALL, signal, thinking, forkProfile: true },
{ suppressRetryFrames: true })` — reusing the nested-stream seam that already
suppresses retry frames for subagents. This is the only transport change.

### E. Option gating + metrics

- A native session option `agentProgressSummaries` (default **on**, mirroring
  the claude provider's app default) gates **only** the summary fork.
  Mechanical `task_progress` is always on for subagents. Threaded through
  `NativeSession` opts → `AgentToolDeps` → the tracker.
- Metric `native_task_progress_total` counter
  `{ outcome: 'generated' | 'mechanical' | 'suppressed' | 'failed', reason? }`,
  mirroring `native_prompt_suggestion_total`. Series labels are finite enums
  only (no session ids / uuids).

## Constraints

- **Neutrality.** The progress tracker is core: it imports only neutral
  vocabulary, `wire/wire-projection`, loop types, and `shared/tasks`. No SDK,
  no host adapter, no host-domain services (the six-port discipline,
  `native/host-free.test.ts`). The fork rides the neutral `streamFor` seam.
- **Envelope-less task frames.** `task/progress` carries no session_id/uuid;
  the adapter projects `receivedAt` from `time`. The pump keys on `task_id`.
- **Live-only.** Task frames never enter the history ring or the v3 log (R6).
  `task_notification` is the one exception that keeps the ring+broadcast path
  (the pump's existing behavior); `task/progress` is ephemeral like
  `task_started`.
- **Always-on-thinking 400 (inherited).** Models whose ids match the
  thinking classifier but reject `thinking:disabled` (Opus 5.5 / Sonnet 5.5)
  400 on the fork; the fork silently skips there, exactly as the suggestion
  fork does today (`native-session.ts:1568-1574`). Mechanical progress still
  emits. A thinking-mode-aware gate is a possible follow-up, out of scope.
- **Prompt-cache dependence.** The fork's low cost assumes the subagent prefix
  is cache-warm. A cold prefix pays full input cost for that fork; the
  no-new-material skip and one-in-flight bound keep this rare.

## Decisions made here (builder calls)

These are my calls, not user-agreed specifics; flag them on review:

- Summary strategy = the CLI fork (reuse subagent model + cache), not a
  small-model call. Grounded in `sdk.d.ts:2120-2127`.
- Cadence ~30 s, matching the CLI interval.
- Scope = subagents only for both foreground lifecycle and the progress fork;
  foreground shells stay silent (user-confirmed claude parity).
- `agentProgressSummaries` default on, gating only the summary fork;
  `last_tool_name` progress is always on, the `usage` triple is emit-only wire
  parity (not surfaced — matches claude, user-confirmed parity scope).
- Fork-tail validity = synthesize placeholder `tool_result` blocks for trailing
  unmatched `tool_use` in the fork tail (fresher than trimming the incomplete
  round; lets the summary name in-flight tools). Consecutive user messages are
  API-legal, so the post-tool-result window needs no special handling.
- The transport seam is widened (`appendMessages` + `maxTokens` + a fork-profile
  effort/fast-mode strip through `streamFor`) rather than adding a second
  fork-specific dep. The fork inherits neither the 16384 output ceiling nor
  fast-mode billing nor the session/subagent effort.
- Metric name `native_task_progress_total`.

## Left to the builder

- Module decomposition: a sibling `subagent-progress.ts` vs. inline in
  `subagent.ts`. Prefer a sibling for testability; the emit interceptor feeds
  it via an `observe(frame)` call.
- The summary prompt wording (present-tense, one line, no preamble) and the
  normalize length cap / multi-line rejection thresholds.
- Timer implementation (interval vs. per-tick setTimeout) and the exact
  "new material" predicate.
- Test fixture specifics and the e2e assertion shape.

## Test plan

- Vocabulary purity + neutrality pins extended for `task/progress` and the
  `task/started.isBackgrounded` field.
- Adapter projection unit tests: `task_progress` exact SDK shape;
  `task_started` `is_backgrounded` false/true.
- `task-manager`: foreground subagent launch + settle frames; foreground shell
  silent; backgrounded path unchanged; foreground→background flip emits one
  notification.
- Progress tracker unit tests (scripted stream seam): cadence, no-material
  skip, one-in-flight bound, abort cancellation, silent failure,
  `last_tool_name` always present, summary normalize/screen, option-off
  summary-less frames.
- Fork-tail validity tests: a mid-round snapshot ending in unmatched `tool_use`
  produces a tail carrying synthetic `tool_result` blocks keyed by the real
  ids (the request would 400 without them); a post-tool-result snapshot produces
  a legal consecutive-user tail; the fork request carries the small `maxTokens`
  and omits effort / fastMode (the seam's fork profile).
- e2e subagent test: a foreground subagent produces a running panel record
  that settles to terminal with its result; progress frames fold into
  `progressSummary` / `lastToolName`.
- Client reducer pin: `TASKS_SNAPSHOT` handles a native foreground record
  (`isBackgrounded: false`) and the foreground `task_notification` +
  tool_result coexistence without double-settling the SubagentCard.

## Files touched

- `server/providers/native/vocabulary/live-frame.ts` — `task/progress` member;
  `task/started.isBackgrounded`.
- `server/providers/native-host-frame-adapter.ts` — `task_progress` projection;
  `task_started` reads `isBackgrounded`.
- `server/providers/native/native-session.ts` — `isOperationalFrame`
  discriminant; `streamFor`/`defaultStream` `appendMessages` forwarding + test
  seam flatten; option threading.
- `server/providers/native/task-manager.ts` — foreground subagent launch +
  settle emission.
- `server/providers/native/subagent.ts` — emit interceptor feeds the tracker;
  tracker start/stop; `streamFor` signature widen.
- `server/providers/native/subagent-progress.ts` (new) — the tracker + fork.
- `server/providers/native/native-provider.ts` — `agentProgressSummaries`
  option surface.
- Tests alongside each; e2e in `native/e2e-subagent.test.ts`.
- Decision record on implementation:
  `.agents/notes/implemented/feature/2026-11-27-native-task-panel-parity.md`.