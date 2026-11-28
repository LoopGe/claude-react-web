# Agent Note: Monitor event batches render as a compact card

Status: implemented

## Problem

A monitor EVENT batch — the visible leftover class of the task-notification
visibility gate (no `<tool-use-id>` to fold, no `<result>`, non-empty
`<event>` lines) — fell through to MessageView's neutral synthetic-user
fallback, which renders the body as Markdown: raw `<task-notification>` XML
on screen. Both producers hit this: the native provider's mid-turn event
injection (every ~200 ms batch is a streamed user frame, so a chatty watch
floods the transcript with XML cards) and the CLI's disk-replayed batches
(the CLI never streams event batches live, but its JSONL carries them, so
old-session replay shows the same cards).

Corpus survey before the change (2404 CLI JSONL files, 1587 injections):
97.5% of injections are already hidden (foldable → TasksPanel, status-only →
hidden). The visible residue is 40 frames: 18 result-bearing agent re-run
reports (already covered by the `taskResultVersions` content-generation
gate when a record holds the payload), 13 `[Monitor expired …]` housekeeping
notices, and 9 genuine monitor output events. Native logs (11 sessions)
carried only the 5 event batches + 1 foldable settle of one Monitor test —
the native producer's only visible class IS the event batch.

## Decision

A dedicated `MonitorEventView` card (frame-views.tsx) renders the batch:
header = the watch description with the CLI's `Monitor event: "…"` framing
stripped (`monitorEventTitle`), warn-accent icon matching the MonitorBar's
identity, event-count badge when >1; body = each `<event>` verbatim in its
own `<pre>` (raw stdout, never markdown), bash-msg-pre's scroll discipline
(320px cap, overlay-scrollbar hidden-native treatment).

- **Parser**: `parseMonitorEventBatch` (shared/user-frames.ts) beside the
  sibling parsers — same one-pass `readTaskNotification`, gates on
  no-tool-use-id + no-result + ≥1 non-empty event. Collects EVERY event body
  (entity-unescaped, document order), not just the first.
- **Dispatch**: MessageView's `!isHumanUserMessage` branch tries the monitor
  parser BEFORE the neutral fallback. The visibility gate is untouched —
  the frame stays visible exactly where it was; only its renderer changes.
- **Search alignment**: `extractMessageSearchSegments` early-returns ONE
  segment for a monitor batch — `monitorEventSearchText` (title, then
  events, newline-joined, empty title skipped). The card's match-ordinal
  walk counts the same PARTS in the same order, so per-part hits agree end
  to end (the tool-result-text discipline). A query spanning a newline join
  counts server-side but has no client mark — the accepted mention-boundary
  exception class, documented on the helper. Raw stdout is NOT
  markdown-flattened — the card renders it verbatim, so the index must too.
- **Marks**: the card reuses `renderMatchMarks`
  (src/utils/highlight-matches.tsx), extended with an `activeIdx` option
  (backwards compatible) rather than a fourth copy of the range/mark walk.

## Alternatives considered

**A dedicated frame type (durable `task/monitor-event` + live operational
frame).** The structural fix: model history keeps a user-text projection
while every UI surface gets structured data, retiring content sniffing for
new native data. Rejected for THIS change on cost/benefit: the compact
renderer must be written either way; the frame-type route adds a vocabulary
extension + migration + a second shape coexisting with the CLI's XML (which
we cannot change — old-session replay still needs the XML path), and the
corpus shows only ~14 genuinely-visible event frames across all history.
Revisit if monitor events grow more surfaces (history viewer, export).

**Hiding `[Monitor expired …]` notices as housekeeping.** Deferred: the
notice is the only record that a watch ended without output, and the card
now renders it readably; hiding it is a visibility-policy change that
deserves its own decision, not a rider on a renderer change.

**Rendering events through Markdown/AnsiText.** Rejected: monitor output is
raw stdout — markdown would eat `*`/`#`/`<` in log lines, and the search
index would have to flatten identically. Verbatim `<pre>` + literal
findRanges marks (the UserMentionChip discipline) keeps index and render
trivially aligned.

## Consequences

The neutral raw-XML fallback now only serves genuinely unknown synthetic
user frames; every known monitor batch renders as the card on live native
delivery AND CLI disk replay (one renderer, both producers). The frame
still reaches the store, disk, search index and model context unchanged —
this is a pure render-layer change with zero server/protocol surface.
`willRenderEmpty` needed no change: the batch carries user text, so the
row was never dropped.

## Testing

`shared/user-frames.test.ts` pins the parser (both producer shapes, repeated
events, entity unescaping, multi-line bodies, null gates) and the title/
search-text helpers. `shared/search/segments.test.ts` pins the single
visible-strings segment, no XML plumbing indexed, and the foldable
notification staying on the legacy markdown path.
`monitor-event-view.test.tsx` pins the card (stripped title, verbatim pres,
count badge, entity decode, search marks + active ordinal incl. title-first
ordering). `MessageList.test.tsx`'s former "unparseable body via neutral
fallback" test now asserts the compact card end-to-end. Browser-verified
against the live native session: all 5 tick batches render as cards, zero
raw XML, search jump lands with the active mark on the right event.

## Related

[Status-only task-notification injections are hidden](../bug-fix/2026-11-06-hide-resume-task-notification-noise.md)
owns the visibility gate this card renders within; its "monitor events keep
the neutral card" decision is superseded in RENDERER only — the visibility
classification is unchanged.

[Native async-orchestration parity](2026-11-27-native-async-orchestration-parity.md)
owns the native injection delivery that produces these frames.
