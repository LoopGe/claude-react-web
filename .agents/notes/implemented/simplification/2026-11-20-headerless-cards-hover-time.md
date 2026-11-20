# Agent Note: Headerless message cards with hover timestamp

Status: implemented

## Problem

User/assistant message cards carried a `.msg-header` row — role label
("you"/"assistant"/"subagent"), an inline HH:MM:SS timestamp (itself a
hover-full-timestamp hint), five delivery-status chips (sending / queued /
injecting / injected / processing), and an assistant error badge — gated by
the `showMessageHeaders` setting (a global default plus a per-session
override). The timestamp was visible only with headers on; with headers off
the transcript showed no time at all. The user wanted hovering a card to
reveal its time, and the header chrome itself was unwanted noise. The setting
also carried a full per-session pref layer (SessionMeta persistence, a prefs
route, three carry paths) for a row nobody wanted.

## Decision

Message cards are headerless. Hovering a user/assistant card root reveals
`formatFullTimestamp(msg.receivedAt)` through a `HoverHint` (portalled
`HoverPopover`, 200 ms dwell, flip/clamp, registry arbitration with the
context menu and nested hints). The hint is `disabled` when `receivedAt` is
absent — drafts, pre-ack optimistic bubbles, and old disk lines — so no empty
bubble opens (`HoverHint` has no empty-label guard). `showMessageHeaders` is
removed end to end: global config key, the per-session layer (`SessionMeta`,
`coerceMeta`, `setPrefs`, the `/sessions/:id/prefs` route, the create
whitelist/validation, and the spawn/fork/clear carry paths), and the client
pref chain (`GlobalPrefs`/`SessionPrefs`, both settings panels, the restart
body, and the component threading). The header's labels, timestamp, chips,
and error badge are deleted, not relocated.

## Alternatives considered

**Keep the header and its toggle (status quo).** Rejected: hover is the
wanted time surface, and the header row was redundant chrome the user asked
to remove.

**Relocate the status chips / error badge to a conditional row.** Offered as
the functionality-preserving option (a row rendered only while a status is
active). The user chose full removal — the chips and badge go away with the
header. The `deliveryStatus` data model and the card-root `msg-sending` /
`msg-queued` dimming stay; only the chip/badge presentation is gone.

**CSS-only `:hover` reveal of an inline time element.** Rejected: an in-flow
or absolutely-positioned time element is clipped by the scroller's overflow
and has no edge flip/clamp; the portalled `HoverPopover` already solves
positioning, unmount safety, and surface arbitration, and is the established
dense-list pattern (SessionCard renders one closed popover per row).

## Consequences

The delivery-status chips and assistant error badge no longer render — a
deliberate product choice, not a regression of the data model. `working` and
`nextItemType` became dead `MessageView` props and were removed; `working`
still feeds `ToolGroupCard`'s running-group expand. The draft card's
header-reservation contract (spec §5.5) dissolved: draft and settled cards
share the same headerless shell, so settle continuity holds with no reserved
slot. `MessageTimestamp`, `ASSISTANT_ERROR_LABELS`, the chip CSS family, and
the orphaned `--assistant-header-fg` token are deleted; the base `.msg-header`
CSS stays (system-frame cards still use it), as does `.msg-sending-spinner`
(the pending bash card).

Wire compat is graceful everywhere: a stale `showMessageHeaders` in
`config.json` is ignored (parse branch gone), old-client create/prefs/PUT
postings of the key are silently dropped (whitelist / `hasOwnProperty` /
`WRITABLE_CONFIG_KEYS`), and `coerceMeta` drops persisted overrides so the
next `writeStore` erases them. `SessionPrefs` is now four fields.

The hover relies on `receivedAt` being present on disk-restored history — it
is (the CLI JSONL's ISO timestamp, normalized by history-reader). Three stale
doc comments that claimed disk history has no time were corrected.

## Related

- [Inline is the only streaming render mode](2026-11-20-inline-only-streaming.md)
  — the draft card whose settle continuity this change simplifies (no header
  slot to reserve). Its leaf-isolation contract is unchanged; the card-root
  `HoverHint` adds no per-flush render cost (closed popovers mount no portal).