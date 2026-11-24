# Agent Note: Status-only task-notification injections are hidden

Status: implemented

## Problem

After a server restart the transcript showed raw XML cards for
`<task-notification>` user frames:

```
SYSTEM
<task-notification> <task-id>ad0e…</task-id> <output-file>…</output-file>
<status>stopped</status> <summary>Background agent "…" didn't finish before
the previous session ended</summary> <note>No completion record was found…
</note> </task-notification>
```

The harness injects one of these per abandoned background task each time a
session resumes; they accumulated across restarts (seven in one transcript).

`shouldHideByDefault` hid a `<task-notification>` user injection only when
`parseTaskNotificationInjection` succeeded, and that parser requires a
`<tool-use-id>`. The recovery notice carries only `<task-id>`, so it was not
hidden. It then fell through `isHumanUserMessage` (correctly, as non-human) to
MessageView's neutral card, which renders the body as Markdown — the raw XML.
That card also labelled itself `system` because the disk-replay normalizer
(`server/history-reader.ts`) does not carry `origin` through, so
`userMessageOriginKind` was undefined.

The gate existed because a parseable injection's payload has a home (the
TasksPanel, keyed by task record); the review of the original design required
an unparseable one to stay visible rather than vanish from every surface.
That reasoning does not hold for a notice with no payload at all.

## Decision

`shouldHideByDefault` now hides every `<task-notification>` injection except
the unparseable ones that carry actual payload:

- foldable (has `<tool-use-id>`) → hidden; output rendered in TasksPanel,
- unparseable and status-only (no non-empty `<result>`, no `<event>`) → hidden,
- unparseable but carrying a non-empty `<result>` or a monitor `<event>` →
  visible in the neutral card, because there is no task record to key and no
  other render path for that payload.

One-pass classification is `classifyTaskNotificationInjection` in
`shared/user-frames.ts`, next to the parser it complements: `foldable`,
`hasPayload`, or `null` for a non-notification. The frame still
reaches the store and the disk JSONL in all cases: the reducer's
`activeSubagents` merge and `backfillSubagentCompletions` read it regardless
of `hiddenByDefault`.

### Update 2026-11-23: unroutable completions fold into existing records

The third bullet's "nothing to key a task record on" was too strong: the
injection's `<task-id>` IS the task map's primary key (the subagent's
agentId). A result-bearing no-`<tool-use-id>` completion — the harness's
re-notification when a previously-launched background agent stops again
(e.g. after a SendMessage resume) — now folds into a record under that key,
and its transcript row is dropped once the record holds the payload.

- server: `applyTaskNotificationInjection` parses the shape with
  `parseUnroutableCompletion` (shared/user-frames.ts — non-empty `<result>`,
  no `<tool-use-id>`, present `<task-id>`) and merges status/result/endedAt
  into `session.tasks.get(taskId)`. Monitor `<event>`-only and status-only
  notices never settle a record (the original rejection's concern).
- client: the hide decision is state-dependent, so it lives in the row
  model, NOT in `shouldHideByDefault` (which stays content-only for the
  server search index). `buildTranscriptRows` takes `taskResultVersions`
  (fed by `useTaskResultVersions` from `mirror.tasks`) — each result-holding
  record's content generation, inline (`taskResultVersionForRecord`) or
  paged (`resultRef.resultVersion`, computed by `projectTasksSnapshot` with
  the same function) — and drops the injection row only when the generation
  under its task-id equals `taskResultVersionForText(injection.result)`.
  The identity match, not bare task-id membership, is what makes the
  guarantee hold: a record carrying a DIFFERENT report (an earlier stop's
  result, a fuller output_file body, a pre-change session that never folded
  this injection) keeps the card — fail-visible, the report is never lost.
  Live replay and disk replay agree because both read the same tasks
  snapshot (sidecar-seeded after restart).

No disk backfill: without a live re-notification, old sessions heal only if
the record already carries a result from another path (the 2026-11-24
update below adds healing via a fresh re-notification that creates the
record). Known gap, same class as before: in-session search still indexes
the injection (its `hiddenByDefault` stays false) and can point at a row the
row model drops.

### Update 2026-11-24: backfill a record when none exists

The 2026-11-23 contract was deliberately conservative ("only merge into an
EXISTING record, never create"). Its visible cost showed up in a live
session: a background agent's record had been evicted by the 50-terminal
cap (`MAX_TERMINAL_TASKS`), so its late re-notification found no record,
the fold no-op'd, and the raw-XML card stayed — correct fail-visible
behavior, but the report had no TasksPanel home even though the agent's
disk transcript still existed.

The user chose to lift the never-create rule: when no record exists, the
fold now CREATES a terminal record keyed by the injection's `<task-id>` —
`taskType: 'subagent'`, `isBackgrounded: true`, `description` from
`<summary>` (the parser now carries it), `result`/`status` from the
injection, no `toolUseId` (there is no launch tool_use for a
re-notification). TasksPanel already renders this shape: the drill-in
viewer keys the disk transcript by `taskId` (the agentId), the result block
reads the record's result, and the elapsed timer is gated on `startedAt`
(absent here). The client hide mechanism is unchanged — the created record
holds THIS payload by construction, so the content-generation match drops
the row.

What this gives up: the conservative guarantee that the task map only ever
gains records from real launch/progress frames. A created record is a
terminal stub born from a completion notice; it is subject to the same
50-terminal cap, so a sufficiently long session can still evict it and a
later re-notification would re-create it. Monitor `<event>`-only and
status-only notices still never create (the parser gates on a non-empty
`<result>`), so the original rejection's monitor concern stays handled.
Raising `MAX_TERMINAL_TASKS` was the alternative lever; it only delays
eviction and does not restore already-evicted records, so backfill was
chosen instead.

## Alternatives considered

**Hide every `<task-notification>` injection, as the original spec §3.3
said.** Rejected: Monitor events (`<event>`) and the rare unroutable agent
completion (has `<result>`, no `<tool-use-id>`) have no other surface. The
former is the only user-facing output a persistent Monitor delivers; hiding
it would delete a feature. Corpus survey before the change: 7 status-only
recovery notices, 1 completion with a result and no id, 226 monitor events.

**Keep the status-only notice visible but render a compact card instead of
raw XML.** Rejected as scope: the notice is model-facing housekeeping ("send
it another message with SendMessage"), not a user-facing result, and a
bespoke card for it would be a new surface for content the user does not act
on. It remains in the model's context on disk.

**Fold task-id-only notices into `session.tasks` so their status survives in
TasksPanel.** Rejected at the time: `<task-id>` equals the subagent's agentId
and is the task map's primary key, but monitor events also carry `<task-id>`
and must not become task records. Distinguishing them there would duplicate
the payload classification this change already needs for rendering, and the
stopped status is recoverable from the persisted task sidecar. The
2026-11-23 update adopts the narrowed form for RESULT-bearing completions
only (existing records, never created); the monitor-event concern is handled
by gating the fold on a non-empty `<result>`, which monitor notifications
do not carry.

**Preserve `origin` through the disk normalizer so the card says
`task-notification` instead of `system`.** Rejected as the fix: it only
relabels raw XML; the user does not want the row at all. Left untouched as an
unrelated replay-fidelity gap.

## Consequences

The recovery notice no longer renders in the transcript, and in-session search
(`Chat.tsx` skips `hiddenByDefault` items) no longer finds it. The global
cross-session search (`SessionManager.searchMessages`) still scans raw JSONL
entries with no visibility filter and can return a hit whose snippet is the
XML — a pre-existing gap it shares with every hidden injection, and the reason
a hit there can point at a row this filter hides. The only other trace is the
raw JSONL, where the model still sees the notice — unchanged, since the
transcript filter never affected what the CLI feeds the model.

A status-only notice that is genuinely a failure (no `<result>`, no
`<tool-use-id>`) is hidden too; the failure remains visible through the SDK
`system/task_notification` path and the subagent watcher when the task is
routable.

Because the classifier is content-based (the SDK does not reliably stamp
`origin`), a human message that pastes a complete, payload-less injection with
a closing tag is hidden as well. That is the same trade-off the filter already
made for complete injections carrying a `<tool-use-id>`; narrowing it to
harness-stamped frames would need origin to survive the disk normalizer and
would still miss live frames that lack it.

Tests pin both directions: `normalize.test.ts` (recovery notice hidden;
foldable-with-result hidden; monitor event and unroutable result kept) and
`shared/user-frames.test.ts` (`classifyTaskNotificationInjection`, including
whitespace-only payload elements).

## Related

[Task output streaming architecture](../../proposed/architecture/2026-11-14-task-output-streaming.md) proposes output-ref storage and bounded reads for large unroutable payloads. The neutral-card and status-only hiding decisions above remain current; that proposal does not change them while it is waiting on upstream event contracts.