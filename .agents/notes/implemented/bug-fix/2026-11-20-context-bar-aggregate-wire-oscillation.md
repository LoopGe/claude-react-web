# Agent Note: Context Bar oscillation on the aggregate-reporting usage wire

Status: implemented

## Problem

On aggregate-reporting backends (the Mify proxy, SDK 0.3.278+) the Context Bar
jumped between a low and a high reading every turn, and the composition
popover's `Messages` row disagreed with the bar's own total.

The pump derives a mid-turn context snapshot from each main-thread `assistant`
frame (`liteContextUsageFromAssistant`) so the bar refreshes per API response
rather than only at turn end. On this wire the live `assistant` frame carries
the `message_start` usage: a non-zero `input_tokens` with **no cache buckets**
and `output_tokens: 0`. The true prompt size arrives only in `message_delta`,
the disk transcript, and the CLI's own `getContextUsage` — never in a complete
assistant frame. Summing the partial frame's buckets under-reports the prompt
(live-measured: a 142k prompt painted as 57k ≈ 7%). The turn-end reconcile
probe then corrects the bar to the CLI's accounting (≈18%), so the bar
oscillates down mid-turn and back up at every turn end.

The existing all-zero guard in `assembleLiteUsage` does not catch this: the
partial frame is non-zero, so it slips through and overwrites the last-good
snapshot.

## Decision

The pump latches `Session.aggregateUsageWire` from the first **real** turn
`result` whose top-level usage is unverifiable (`resultUsageUnverifiable`:
empty/null `iterations`) on a handle that can probe `getContextUsage`. While
the flag is set, the mid-turn assistant derivation is skipped; the turn-end
reconcile probe — the CLI's own accounting, already designated the authority
on this wire — is the sole source. The bar holds its last-good value between
turns instead of dipping to the partial reading.

The latch is guarded like the cold-start anchor (`!emptyResult && !zeroUsage`,
plus `is_error !== true`): the spawn/restart warm-up and other zero-usage
placeholders also carry `iterations: []`, and latching on them would flag every
session — including normal wires — at spawn and disable mid-turn refresh for the
session's life. `canProbe` and `zeroUsage` are hoisted consts shared with the
derivation's `allowUnverifiableFallback` and the cold-start anchor so the sites
cannot drift. The flag is a backend property, so it latches for the session's
life and is not persisted; `respawnInPlace` clears it (the respawn re-resolves
the profile/backend, so the wire may differ) and the first real result on the
new handle re-classifies it.

## Alternatives considered

### Why not gate the assistant frame on `stop_reason == null`?

A complete assistant message has a `stop_reason`; the opening placeholder does
not, so skipping `stop_reason == null` frames looks like a clean completeness
gate. It regresses normal wires: the live stream emits **per-block** frames
(`shared/assistant-message.ts`), which carry `stop_reason: null` yet on a normal
wire carry the correct `message_start` prompt usage. `history-reader.ts`
documents that real frames frequently lack `stop_reason` entirely. The gate
would skip those legitimate frames and disable the mid-turn refresh the helper
exists for. The empty-string `stop_reason` case (grouped with null by
`history-reader`) is a further inconsistency.

### Why not gate on `output_tokens === 0`?

Normal per-block frames also carry `output_tokens: 0` (output is not finalized
per block) while carrying correct prompt usage on a normal wire. The same
regression as the `stop_reason` gate.

### Why not detect the partial signature on the assistant frame itself?

Skipping frames with `output_tokens: 0` and no cache buckets would cover the
first turn and hybrid wires, but it is a heuristic about bucket presence: a
legitimate fully non-cached call (cache buckets absent, `input_tokens` the whole
prompt) matches the signature and would permanently latch the wire off one
frame. The result's `iterations` shape is a definitive backend property, not a
per-frame guess, so the latch keys on it.

### Why not probe getContextUsage mid-turn per API call?

It would give a correct mid-turn bar on every wire, but each probe is a
subprocess control round-trip; spending one per API call defeats the purpose of
the free in-stream derivation. The existing architecture deliberately probes at
turn end on this wire.

## Consequences

Bought: the per-turn oscillation is eliminated from the second turn onward on
the aggregate wire; normal wires and no-probe providers keep their mid-turn
refresh unchanged (pinned by tests). The bar is stable rather than flickering
between a partial reading and its correction.

Cost / known gaps:
- Mid-turn freshness on the aggregate wire is sacrificed for stability: the bar
  updates at turn end (probe) rather than per API response. This is the wire the
  probe was already the authority for.
- The FIRST turn after a spawn/resume still derives from the partial assistant
  frame before its result latches the wire, so the bar can dip once until that
  turn's probe lands. Every later turn is stable.
- A hybrid wire whose results carry populated `iterations` (derivation succeeds,
  no latch) but whose assistant frames still carry partial `message_start` usage
  would still oscillate; the latch keys on the result shape, not the assistant
  shape. Not observed in practice; recorded so a future report is not mistaken
  for a regression of this fix.
- Once latched, a turn that ends in error gets no context update (the assistant
  gate blocks mid-turn derivation and the reconcile fire gate skips error
  results), so the bar holds the previous turn's total until the next success.
  If probes persistently fail (wedged subprocess) the bar likewise holds its
  last-good value rather than moving — stability is preferred over a partial
  reading that is wrong anyway.

## Deferred

The first-turn dip could be eliminated by pre-latching at spawn/resume from the
last persisted result frame (`recordResultFrame` sidecar already stores the
usage payload, including its `iterations` shape). That is an enhancement beyond
the reported per-turn oscillation and is not implemented here.

## Testing

`server/session-pump.test.ts` ("pump: aggregate-wire mid-turn context gate")
pins, in live wire order (assistant → result → assistant): a real aggregate
result latches, the first-turn partial frame dips once and the probe corrects
it, and a post-latch partial frame is ignored. Also: a normal derivable wire
still refreshes mid-turn; a no-probe handle keeps the fallback; the spawn warm-up
does NOT latch; an error result does NOT latch. The warm-up and partial-reading
assertions are red without the guards/gate respectively.

## Related

The reconcile probe and the aggregate-wire refusal it corrects for live in
`server/session-manager.ts` (`reconcileContextUsage`) and
`server/session-pump.ts` (`liteContextUsageFromResult` /
`resultUsageUnverifiable`). No prior note owns context-usage reconciliation.