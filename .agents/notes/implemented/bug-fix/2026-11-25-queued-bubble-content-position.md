# Agent Note: Queued bubble carries full content and pins its position

Status: implemented

## Problem

The queued-placeholder survival fix (see Related) keeps a mid-turn
queued-not-published user message's optimistic placeholder alive through the
turn. That exposed two UX defects the user confirmed live:

1. The dimmed queued bubble showed only text, no image/file. The composer's
   optimistic placeholder was text-only — `insertUserMessage(text)` built
   `message.content = text`; images/files went only into the POST body. The image
   appeared only at materialization when the real frame replaced the placeholder.
2. The queued bubble rendered at the transcript tail and drifted downward as the
   reply streamed: `buildSnapshot` appended placeholders after `mirror.items`, and
   finalized assistant frames tail-append before the placeholder, pushing it down.

## Decision

**Content.** `insertUserMessage` accepts `string | OutgoingContentBlock[]`; the
composer builds the full outgoing payload (`buildOutgoingBody`) BEFORE the
optimistic insert and passes its content, so the placeholder renders images/files
immediately (the whole downstream path — `toTranscriptItem`, `getBlocks`,
`ImageBlockView`/`useImageContent` — is content-agnostic and resolves a ref
identically for placeholder and real item; bytes are uploaded at paste time). This
also gives a text-less images/files-only send a placeholder (it had none). The
side-chat drawer gets the same treatment and now sends `clientOperationId` so
`applyQueuedMessage` recognizes its own queued placeholder (no duplicate bubble).

**Position.** A new render-only module `placeholder-placement.ts`
(`mergePlaceholdersChronologically`) inserts each placeholder at its send-time
position using `repairChronology`'s backward-scan rule ("after the last timed
element ≤ t", null-time transparent), keyed on the SERVER stamp `msgTime(ph.msg)`
only. A pre-ack placeholder (timeless msg) falls back to the tail; once the ack
stamps `msg.receivedAt` it pins chronologically. `buildSnapshot` calls it memoized
on the three input refs, so `snapshot.items` identity is stable across
`LIVE_TURN_FLUSH` (no per-flush realloc/re-render). `mirror.items` keeps its seq
order; the Map send order is never reordered (FIFO echo-merge + ack re-key depend
on it); items/messages stay index-aligned.

The settled row stays at the seq tail. At materialization the echo-merge drops the
placeholder and the real item appends at the seq tail — the bubble settles ONCE at
the turn boundary into its permanent position, instead of drifting continuously.

## Key fact

The main transcript is seq-ordered everywhere (live, reload, bystander tabs).
`repairChronology` runs only in `replayReplace`, dispatched only by the subagent
drill-in store — never the main path (WINDOW_LIVE/WINDOW_PAGE/REBASE). A
materialized queued prompt gets its seq at the prior turn terminal, so its
permanent position is the seq tail (after the prior result, before its own reply).
There is no replay pass that heals a mid-list insertion back on the main path.

## Alternatives considered

**Place the real item by receivedAt too (full chronological).** Rejected: a live
tab would render the prompt inside turn N while a reloaded/bystander tab renders it
after turn N's result — permanent cross-tab divergence (no repairChronology on the
main path); it also reads as part of the wrong turn and breaks the seq-window
invariant `window-bridge`/`trimFront`/`evictMessages` rely on.

**Placeholder below the draft card (stable bottom).** Rejected: violates the
pinned "draft card always last" design and the scroll-follow/bottom-stack
assumptions; doesn't remove absolute drift.

**Place by the item-level client-clock receivedAt.** Rejected: a skewed remote
client (LAN/QR access is shipped) would misplace the bubble, and the client stamp
is lost on ack/consumed item rebuilds. Server `msgTime` only avoids both; pre-ack
goes to the tail until the server time is known.

## Consequences

Bought: the queued bubble shows its attachments immediately and stays pinned while
the reply streams; the merge memoization also removes a pre-existing per-flush
array realloc. Cost: a single bounded settle at the turn boundary (send-time
position → seq tail), invisible in follow mode. A cleaner-but-larger alternative —
an out-of-flow queued tray above the composer that enters the flow at the tail on
materialization — would eliminate the settle; noted as a follow-up if the settle
proves unacceptable. The insertion scan duplicates repairChronology's q-loop rule
(a shared `findInsertionIndex` helper is a possible future consolidation); strict
`≤` comparison honors sub-second server-stamp inversions that repairChronology's
5s tolerance would ignore (accepted minor edge).

## Testing

`placeholder-placement.test.ts` (insertion rule, null-time transparency, send-order
ties, pre-ack→tail, server-clock-only, index alignment); `store.test.ts`
(chronological position via WINDOW_PAGE + MESSAGE_QUEUED, flush-stable items
identity, materialization → seq tail); `commands.test.ts` (multimodal insert + ack
preserves array); `SideChatDrawer.test.tsx` (clientOperationId matches the
placeholder). The reducer FIFO/send-order pins use a tail-merge test helper
independent of the store and stay green.

## Related

[Queued placeholder survives the result sweep](2026-11-25-queued-placeholder-result-sweep.md)
— the survival fix whose kept-alive placeholder exposed these two defects.
