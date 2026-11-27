# Agent Note: Native zero-turn context seed

Status: implemented

## Problem

A brand-new native session's Context bar stayed empty for its ENTIRE first
turn and only jumped to the final value at turn end; from the second turn on
it refreshed per API round like the claude provider. Live-reproduced on the
dev server (a native session tapped over WebSocket): `cachedContextUsage`
was `null` through every first-turn assistant frame, while a warm session's
tap showed a context broadcast in the same millisecond as each main-thread
assistant frame.

The causal chain is native's turn-end usage accounting meeting the seed's
zero guard:

- `NativeSession.getContextUsage()` sums `lastUsage`, which is written only
  when a turn settles (`native-session.ts`, after `runTurn` returns). Before
  the first turn the answer is an exact `totalTokens: 0` with a fully
  resolved `maxTokens`/`model`/`autoCompactThreshold`.
- The spawn-time seed probe (`SessionManager.seedContextUsage`) feeds that
  answer to `liteContextUsageFromSdkUsage`, whose zero-total guard refuses
  it — so no cached snapshot lands.
- The pump's mid-turn derivation (`liteContextUsageFromAssistant`) requires
  a cached window to divide against; with no snapshot every first-turn
  assistant frame returns null.
- Native's result frame carries no `modelUsage` (the host adapter projects
  plain usage buckets), so `liteContextUsageFromResult` always returns null
  on native and the turn-end reconcile probe is the bar's only first-turn
  source.

The zero guard exists to stop a placeholder reading clobbering a healthy
last-good snapshot mid-turn. On the seed path the cache is empty by
definition — there is nothing to clobber — so the guard was protecting
nothing while starving the first turn of its denominator.

## Decision

`liteContextUsageFromSdkUsage` gains `opts.allowZeroTotal`; the seed path
(`seedContextUsage`, which also serves the WS-subscribe self-heal
`ensureContextUsageSeed`) passes it. An EXACT zero total with a usable
window/model lands as a `0 / window · 0%` probe-sourced snapshot carrying the
response's threshold; a fraction rounding to zero, a negative/non-finite
total, an unusable window, or a missing model stay refused. The reconcile
path never sets the flag, so its clobber protection is unchanged.

The painted zero is honest ("no API call yet") and self-corrects within the
first round: the snapshot's window is exactly what the mid-turn assistant
derivation needs, so the first turn now refreshes per round from round 1.
The seed's existing staleness guards (cache-nonempty and `lastTurnAt`
identity at resolve time) still skip a late zero answer once a turn has
landed its own snapshot.

## Alternatives considered

**Estimate a pre-turn total in native's `getContextUsage`.** The composition
already prices system/tools/history when no usage sample exists, so the
probe could report an estimated total instead of 0. Rejected: the lite total
is the authoritative last-request reading that compaction pressure and the
mismatch gauge consume; mixing an estimate into it would blur the
authoritative/estimated boundary the composition table deliberately keeps
(the split is approximate, the total exact).

**Accept zero totals in the builder unconditionally.** Rejected: the
reconcile probe fires mid-turn on queued-input sessions, where a zero
answer (a wedged or restarting backend) would drag a healthy bar to 0 — the
exact clobber the guard was added for. The exception belongs to the one
caller whose cache-empty precondition makes it safe.

**Synthesize `modelUsage` on native's result frame so the result derivation
works.** It would remove the turn-end probe dependency, but it invents an
SDK-shaped field native does not otherwise carry, and it still leaves the
first turn's MID-TURN gap (the result only lands at turn end). The seed
denominator is the root cause; the probe path already works.

## Consequences

A fresh native session paints `0 / window` at spawn (or at first subscribe
when the spawn probe was refused) and refreshes per round from the first
assistant frame. The claude provider's seed is unaffected in practice — its
CLI accounting reports a real pre-turn total — but a zero-answer claude
backend now paints the window instead of nothing, which is the same honest
pre-turn state. The reconcile path, the aggregate-wire latch
([Context Bar oscillation](2026-11-20-context-bar-aggregate-wire-oscillation.md)),
and the zero guards in `assembleLiteUsage` are untouched. Pinned by
`session-pump.test.ts` (builder flag semantics) and `session-manager.test.ts`
(zero seed paints the window AND the first turn's assistant frame refreshes
it).

## Related

- Capacity resolution and the fallback window the seed paints:
  [native model context resolution](../architecture/2026-11-14-native-model-context-resolution.md).
- The reconcile probe and mid-turn latch this deliberately does not change:
  [Context Bar oscillation on the aggregate-reporting usage wire](2026-11-20-context-bar-aggregate-wire-oscillation.md).
