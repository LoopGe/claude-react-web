# Agent Note: Motion-off transition hammer created phantom transitions on Virtuoso internals

Status: implemented

## Problem

With Animation speed = Off, scrolling a streaming transcript bounced the
viewport up and down by hundreds of pixels (the "关动画后消息列表上下跳动"
report). The bounce only appeared under Off — Standard was smooth — and only
while the transcript was following or being scrolled.

## Diagnosis (instrumented, 2026-11-15)

The root cause chain, each link measured live:

1. `transition-property`'s **initial value is `all`**. An element that never
   declares a transition has `transition-duration: 0s` (initial) and none ever
   runs.
2. The motion-off hammer (`[data-motion="off"] * { transition-duration:
   0.01ms !important }`) set the duration on **every** element — which turned
   the initial `all` + 0.01ms into a REAL 0.01ms transition on every style
   write of every element that never declared one.
3. react-virtuoso rewrites the item-list's inline `padding-top` on every
   range recalc (i.e. every scroll step and streaming flush). Under Off each
   write started a real transition whose **computed value lagged the write by
   one frame** (a transition's computed value is its START value until it
   elapses).
4. That one-frame-behind geometry fed back into Virtuoso's next computation:
   scrollHeight flip-flopped ±60–1000 px at frame rate (measured: 59 flickers
   per 240 sampled frames under Off, **0 under Standard with the identical
   synthetic-scroll probe**).
5. While following, the follow-invariant chased every flip (each transient
   high sh read as "content grew, must pin"), the clamp pulled back on every
   transient low — the visible bounce.

Isolations: JS motion gates were held Off throughout (not causal); neutralizing
only `transition-duration` took flickers 59 → 0; per-property bisect singled
out `transition-duration` (delay / animation-delay / scroll-behavior were not
causal). The app's own trace recorder gained `scrollHeight`/`clientHeight` on
the scroll diagnostics to make this class decidable from a recording alone
(ch flip vs sh flip).

## Decision

Two changes, one per measured loop:

- **The hammer's phantom transitions** — the actual root cause. The
  transcript's virtualization subtree gets a true `0s` instead of 0.01ms
  (`[data-motion="off"] .chat-virtuoso-scroller, … *` in
  `src/styles/utilities.css`): a 0s duration never starts a transition, so
  the computed value lands with the write and Virtuoso reads back what it
  wrote. Scoped to the scroller subtree because nothing inside it observes
  `transitionend` while Off (FoldableBody skips tweening under
  `motionSuppressed`), while the transitionend-dependent flows that DO exist
  (PinnedUserMessage / RecapWindow inline height tweens, overlay-scrollbar
  counting) live outside it and keep 0.01ms. **The OS
  `prefers-reduced-motion` block carries the identical carve-out** — its
  hammer is the same `*`-scoped 0.01ms write, so OS reduced-motion users had
  the same flicker. Both carve-outs document the safety invariant: nothing
  inside the scroller may wait on `transitionend`.
- **The scroll machinery's pacing and the verify write loop** — the amplifiers
  (independent defects, both measured live):
  - The collapse-settle latch (`anyCollapseMotionInside`) paces the scroll
    machinery's rendering-step loops (fold owner keep-alive, `sampleFold`, the
    settle-verify tick, the item-list fold-lockstep gate). Under Off a
    collapse never registers while animating (the snap path returns before
    `setCollapseAnimating(true)`), so the machinery previously never stood
    down during churn; the loop sites claim the latch so the stand-down is
    exactly one rendering step. `FOLD_OBSERVED` keeps the STRICT probe (it
    cancels an away restore owner — a stale unclaimed latch must never read
    as a fold there); the RO gate claims the latch itself instead, which
    silently retires a stale latch no other consumer ever claimed.
  - The settle-verify tick bails when its absolute write was **pulled back
    above the position it wrote to** (anchoring/clamp moved the viewport; a
    user leave cancels the work via USER_LEFT). The give-up signature is
    geometric and the fought geometry is remembered at WRITER scope across
    passes (500ms window, refreshed on recurrence): a fresh verify pass whose
    write targets the exact fought `(scrollHeight, scrollTop)` is suppressed
    unwritten — bounding the fight to ~2 writes per window instead of the
    60fps loop. Two false-positive shapes are accepted and documented in the
    bail comment: a START_RESTORE reposition mid-pass (standing down after a
    restore is correct — never fight the restore) and a content shrink above
    the viewport (its sh change misses the fight memory, so suppression
    self-clears). `sampleFold`'s absolute-bottom branch respects the
    suppression by KEEPING the compensation transform and ledger (clearing
    them would jump the viewport to the fought geometry) and retrying on the
    next sample.
- `pinToBottom` / `animateScrollToBottom` keep the STRICT probe: a
  settle-tail latch there would start a fold owner whose `FOLD_STARTED`
  cancels an in-flight follow ease on every streaming snap. The latch's
  pacing consumers are the RO gate and the writer's loops only.

## Alternatives considered

**`transition-property: none !important` in the hammer.** The honest meaning
of Off (no transitions anywhere), and it kills the phantom-transition hazard
app-wide. Rejected for now: it would also break the flows that observe
`transitionend` under Off (the PinnedUserMessage / RecapWindow inline height
tweens land their rest state on the event), each needing an audit and a
`motionSuppressed` sync-land edit. The scoped 0s fixes the measured defect
without touching those contracts; the app-wide sweep is a follow-up if another
surface shows the same flicker.

**`transition-duration: 0s` in the hammer.** Same hazard-killing scope as the
sweep above, same transitionend blast radius — rejected for the same reason.

**Only fix the chase (drop the follow-invariant's re-pin during churn).** The
bounce would have persisted as content flicker (rows appearing/disappearing at
the render-window boundary every frame) — the geometry flip itself is the
disease; the chase only amplified it.

## Consequences

- Off now actually means "no transitions run" inside the transcript, instead
  of "every style write starts a 0.01ms transition". Standard-vs-Off scroll
  behaviour is geometrically identical (probe: 0 flickers in both).
- The hazard is **latent app-wide**: any surface that writes an element's
  style per frame and measures it in the same frame can hit the same
  one-frame-behind loop under Off. The transcript was the measured case; if
  another surface reports it, the fix is the same scoped 0s block, or the
  app-wide `transition-property: none` sweep with the transitionend audit.
- `shared/animation-speed.ts`'s 0.01ms rationale ("keep transitionend
  observable") still holds outside the scroller; the scoped block is the
  documented exception.
- The scroll diagnostics (`scroll-handler` / `follow-invariant` /
  `syncBottomGeometry`) now carry `scrollHeight` and `clientHeight`, so a
  recording alone can decide "content flip vs viewport flip" for this class
  of report.

## Follow-up

The verify give-up treats the pull-back as an anchor fight without knowing
WHICH mechanism pulls the viewport back (Virtuoso's own scroll correction vs
CSS scroll anchoring vs a clamp). If the mechanism is CSS scroll anchoring,
`overflow-anchor: none` on the transcript scroller would remove the pull-back
at the source and make the anchor-fight memory redundant — worth verifying
(mechanism unconfirmed, Safari support to check) if the fight memory ever
needs tuning again.
