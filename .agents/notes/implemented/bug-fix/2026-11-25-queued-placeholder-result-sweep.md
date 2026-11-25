# Agent Note: Queued placeholder survives the result sweep

Status: implemented

## Problem

A user message sent mid-turn that cannot steer (carries an image/file, steering
disabled, or admission closed) takes the server's queued-not-published route: it
is durably committed but deliberately unpublished — no seq, no history-ring entry
— until the turn terminal materializes it. On the client the pending bubble lives
only as an optimistic placeholder in `intent.pendingPlaceholders`, not in
`mirror.items`.

The pump broadcasts the `result` frame before `onTurnSettling` runs
`materializeQueued` (fire-and-forget). The reducer's result branch called
`clearSendingPlaceholders`, which wipes ALL placeholders — including the still-
queued one whose materialization echo has not landed. The bubble vanished at turn
end and reappeared only when materialization published it next round. Steering
messages were immune (they publish into the ring immediately). A second loss path:
`message-queued` is fired once and never re-served on subscribe, so a tab
reconnecting/reloading during the queue window lost the bubble until
materialization.

## Decision

The result branch uses a narrower sweep, `clearAbandonedPlaceholders`
(`src/session-store/user-message-lifecycle.ts`): keep a placeholder iff
`deliveryStatus === 'queued'`, drop the rest. A server-confirmed queued placeholder
has a materialization echo still pending, so it survives; the existing exact-uuid
echo-merge consumes it when the materialized frame lands, and an interrupt
withdrawal evicts it via `EVICT_MESSAGES` → `dropEchoedPlaceholders` (which already
prunes intent by server uuid). Raw pre-ack optimistics (`sending`, status
undefined) and acked-`'consumed'` entries are dropped — the latter because
publication already happened, so keeping one would strand a ghost.
`SESSION_TERMINATED` keeps the clear-all `clearSendingPlaceholders`: a terminated
session never materializes, so even a queued survivor has no echo coming.

The echo-merge FIFO fallback is narrowed to the oldest `sending === true` entry
(exact-uuid match still wins first). A server-uuid-keyed placeholder can never be
the materialization of a different-uuid echo, so the fallback skips it — otherwise
a parentless `<task-notification>` injection clustering at turn end would FIFO-eat
a queued survivor the sweep now keeps alive.

The reconnect gap is closed by mirroring the `withdrawnUuids` msgstat seed:
`TranscriptWriter.queuedOps` exposes the pending ops, `SessionManager.queuedStatusFrames`
shapes them into `message-queued` frames (shared helper with the live
`publishQueued` so they cannot drift), and `SessionEventBroadcaster.subscribeMessageStatus`
seeds them to a fresh subscriber before the withdrawal window. No client change —
`applyQueuedMessage`'s guards make late/duplicate seeds idempotent.

## Alternatives considered

**Publish the queued prompt at queue time (give it a seq/ring entry immediately).**
Rejected: the deferred publication is the feature's point — the prompt's seq must
precede its own assistant reply, and assigning it mid-turn would interleave it amid
the current turn's still-streaming assistant blocks (the A,U,R inversion the
queued-not-published design exists to prevent). The fix keeps that ordering intact
and repairs the client lifecycle instead.

**Keep placeholders by `sending !== true` rather than `deliveryStatus === 'queued'`.**
Rejected: that also retains acked-`'consumed'` entries, whose publication already
happened — a stranded ghost. Keep-iff-queued matches the server's own queue
accounting (`countQueuedUserTurns`), so client retention and server queue truth
cannot drift, and it keeps the Stop-with-cancelQueued affordance truthful across
the result→materialization window.

**Add a timeout/fallback clearer for a queued placeholder whose echo never lands.**
Rejected as premature defense: the materialized message is in the ring, so a
reconnect/reconcile delivers it and the echo-merge consumes the placeholder. A
permanent ghost requires a continuously-connected tab that drops the echo and never
reconciles — not an observed state. Recorded as a residual rather than coded around.

## Consequences

Bought: a mid-turn queued bubble no longer vanishes at turn end; a reconnecting tab
recovers pending bubbles; the Stop-cancelQueued count stays honest through the
window. Cost: the result sweep no longer clears queued placeholders, so the narrow
FIFO gate is load-bearing (without it a notification injection eats the survivor).

Known residuals (documented, not coded around): a raw pre-ack `sending` optimistic
can still be FIFO-eaten by a parentless main-thread tool_result / notification frame
(pre-existing, unchanged by this fix); the queued seed inherits the withdrawal
seed's generation-guard race (a rebuild during disconnect can drop it; it self-heals
at materialization); and a dropped materialization echo on a never-reconnecting tab
could ghost a queued placeholder (the ring mirror heals it on any reconnect).

## Testing

`src/session-store/queued-placeholder-sweep.test.ts` pins survival through result,
exact-uuid materialization consumption, the other-tab route, mixed-map selective
drop, withdrawal-after-result, and the steered contrast. The FIFO gate, the helper,
and `SESSION_TERMINATED` clearing a queued survivor have dedicated unit tests;
`server/session-manager.test.ts` pins the reconnect seed (present during the queue
window, absent after materialization).

## Related

[user-frame origin identity](../architecture/2026-11-19-user-frame-origin-identity.md)
owns the host-echo / synthetic-frame classification the echo-merge builds on.
