# Agent Note: Monitor launch ack, persistent watches, and MonitorBar correlation

Status: implemented

## Problem

The native Monitor tool worked end to end — a watch registered a background
task, event batches woke the model mid-turn, TaskStop stopped it, expiry
settled it — but three pieces of its CLI parity were missing or mismatched,
and one of them was a live UI defect:

1. **The launch acknowledgement was not the string the client parses.** The
   native detach ack read `Task <toolUseId> is running in the background.`,
   while `MonitorBar` extracts the running task's id from the CLI shape
   `Monitor started (task <id>, <description>)` with
   `/task\s+([A-Za-z0-9]+)/`. So a native watch never got its task id: the
   bar could only disappear on expiry (5 min default, 30 min cap), while
   TaskStop and a natural settle left it spinning. A raw tool-use id
   (`toolu_01ABC…`) also contains `_`, which the old character class
   truncated.
2. **No `persistent`.** The CLI accepts `persistent: true` (a watch with no
   deadline — `Timeout deadline in milliseconds (0 when persistent)` in the
   binary), but the native schema was `additionalProperties: false` with
   only `timeout_ms`, so a CLI-shaped call was an input error and a long watch
   had to be re-armed every 30 minutes.
3. **Event batches looked like completions to a task-id matcher.** Native
   batches carried the watch's `<task-id>` plus `<status>completed</status>`,
   so once the bar learned the id (fix 1) the first event would have hidden
   the running row.

## Decision

- **The acknowledgement is CLI-shaped, and the tool owns its text.**
  `backgroundable` gains `launchAcknowledgement?(input, taskId)`; the loop
  threads the result into the task metadata and
  `NativeTaskManager.background()` renders it (falling back to the generic
  `Task <id> is running in the background…` TaskOutput pointer for Bash /
  Agent, which pass nothing). Monitor renders the CLI's own
  `mapToolResultToToolResultBlockParam` sentence, verified against the CLI
  binary rather than guessed: `Monitor started (task <id>, timeout 300000ms)`
  for a command watch, `…, expires in <duration> unless the source ends
  first; you get one notice at expiry — re-arm if you still need the watch`
  for a socket, `…, persistent — runs until TaskStop or session end` when
  persistent — then "You will be notified on each event. Keep working — do
  not poll or sleep. Events may arrive while you are waiting for the user —
  an event is not their reply." and a one-line TaskStop pointer. The second
  clause is the DEADLINE, not the description (the CLI's output puts
  `timeoutMs` there; a description-there version would be a plausible but
  wrong imitation), and the client contract is only the `task <id>` clause:
  `MonitorBar` parses the id and nothing else.
- **`MonitorBar`'s parser is widened, not specialized.** The corrected regex
  `/task\s+([A-Za-z0-9_-]+)/i` accepts the CLI wording and any generic
  `Task <id> …` ack (a different provider, a future wording change),
  case-insensitively, and keeps `_`/`-` in ids so a `toolu_…` id survives
  whole. The settle semantics are unchanged: a `<task-notification>`
  carrying the watch's task id ends the row (TaskStop, completion,
  `[Monitor expired …]`), an unmatched id does not, and a non-persistent
  watch also ends on its own timeout.
- **An event batch is status-free at the producer.** `TaskNotificationFacts`
  makes `taskId` / `status` / `result` optional and `taskNotificationXml`
  emits each tag only when present; `Monitor`'s batch flush injects
  `{ description, events }` — no `<task-id>`, no `<status>`, no `<result>`,
  no `<tool-use-id>`. Completions are unchanged (every field present). The
  client gate that would have had to special-case "has `<event>` but is not
  a settle" was written, tested, and **reverted**: a CLI expiry notice
  (`<task-id>` + `<event>[Monitor expired …]`) is a genuine settle the client
  must honour, so the two shapes are separated where they are produced, not
  where they are consumed. `parseMonitorEventBatch` already treated
  `taskId` as optional, and the card never used it.
- **`persistent: true`** is a boolean on the schema (`Timeout deadline in
  milliseconds (0 when persistent)`), validated (`persistent must be a
  boolean`), mutually exclusive with the deadline (`timeout_ms` is ignored,
  the timer is not armed at all rather than armed-and-cleared), and caps
  nothing: the watch ends on TaskStop, a natural process end, or the
  batch/settle path.

## Alternatives considered

**Gate the client on `<event>` presence.** One line in `MonitorBar` (`if
the notification has an <event> line, it is a live batch, never a settle`)
looked cheaper than changing the producer, and it does hold for native
batches. It fails exactly where it matters: the CLI's expiry housekeeping
notice carries `<event>[Monitor expired after 15m …]</event>` and IS the
only end signal a persistent CLI watch ever gets. The producer-side split
keeps both producers' *terminal* notifications settling and only removes a
misleading tag from a *non-terminal* one.

**Status `running` in the batch.** Keeping `<task-id>` and stamping
`<status>running</status>` would be truthfully non-terminal, but
`normalizeTaskStatus` has no running state (anything unrecognized folds to
failed) and the status grammar is the host's fold contract, not a place to
invent a value for one producer.

**Give the bar a `persistent` flag instead of parsing ids.** The bar learns
`persistent` from the tool input already (it uses it to decide whether a
timeout can end the row); it is not a substitute for correlating TaskStop
and settles, which needs the id.

**Build the monitor sentence inside `NativeTaskManager.background()`, keyed
by `taskType`.** The phrase depends on the deadline AND the target kind
(`timeout 300000ms` vs the socket `expires in …` variant), neither of which
the manager's metadata carries; special-casing one task type inside the
generic detach path also makes the manager read tool input by inference.
The hook keeps every tool's launch wording with the tool, and the manager
only chooses "tool said so" vs "generic pointer".

## Consequences

- The launch ack for a monitor is now CLI-shaped; a test pins the full
  sentence for a command watch and the persistent clause for a persistent
  one, and an e2e assertion pins that the LOOP carries the tool's text
  through to the tool_result. The old `containing('background')` assertion
  was replaced rather than loosened.
- Event batches still render as the `MonitorEventView` card
  ([monitor event card](2026-11-28-monitor-event-card.md)) — that parser
  needed no change; only the tags around the events shrank.
- `TaskNotificationFacts` is now optional-field-shaped, so a future
  non-terminal notification kind can use it without stamping a fake status.
  Every completion site still passes the full set, and the XML-vs-parser
  round-trip pin covers both shapes.
- A monitor launched by a provider that still emits a generic
  `Task <id> …` ack is correlated too, thanks to the widened regex.
- One knowing deviation: `timeout_ms` clamps to [1, 1_800_000] where the CLI's
  zod schema is [1000, 1_800_000]. Sub-second deadlines are what the unit and
  e2e suites use to keep expiry tests fast, and a shorter-than-CLI watch hurts
  nobody; the cap (the value that actually surprises a model) is identical.
