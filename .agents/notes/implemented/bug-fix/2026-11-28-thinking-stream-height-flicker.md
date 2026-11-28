# Agent Note: Streaming thinking-block height flicker (down-then-up dip each flush)

Status: implemented

## Problem

While a thinking block streamed, its bottom edge dipped one growth-step below
the pinned transcript bottom and snapped back on every flush — a visible
"向下一跳动闪烁" (measured live 2026-11-28 on a streaming session: item-list
`scrollHeight` +18 while `scrollTop` held, card bottom 1139→1157→1139). The
thinking block's own fold and the settled expand/collapse were clean; the
dip was specific to live height growth.

Two stacked causes, each necessary:

1. **Pinned body lags the content commit.** `AnimatedCollapse`'s snap-follow
   wrote the body height from a ResizeObserver, one broadcast AFTER the content
   grew. The wrapping Virtuoso row therefore grew in a later rendering step than
   the flush commit, so the transcript's item-list observer fired a frame after
   the growth had already painted.
2. **The item-list growth pin stood down during a follow owner.**
   `useTranscriptScroll`'s item-list RO returned early when `owner.kind ===
   'follow'` and called `pinToBottom` with the default `allowDuringAnimation:
   false`. So even when the observer fired, the growth was not pinned that frame;
   the settle-verify loop re-pinned next frame. The stale-scrollTop frame painted
   in between was the dip.

`layout-shift` never reported it: the growth extends the row's bottom (top fixed,
not a layout shift) and the correction is scroll-driven (also not a layout
shift). Diagnosing it required a ResizeObserver probe registered AFTER the
machinery's observer (so it reads post-pin, pre-paint geometry) — a rAF probe
alone reads pre-pin state and misleads.

## Decision

Two changes, both required together:

- `AnimatedCollapse.nativeSnapHeight` (default false; threaded through
  `AnimatedDetails`; `ThinkingBody` passes `live`): a snap-mode open body tracks
  content height NATIVELY (auto) instead of pinning a copy, so the row grows in
  the SAME commit as its content. The open/close fold still pins explicitly
  (`animateHeight`); `animateResize` and the default snap pin are unchanged. Same
  contract as the existing nested-collapse auto path.
- The item-list growth pin no longer stands down during a follow owner: it calls
  `pinToBottom(scroller, { allowDuringAnimation: true, delivery:
  'next-observation' })`, exactly like the synchronous append pin. Safe for the
  same reason — the writer's follow loop re-reads its target each frame, finds
  `remaining ≈ 0` and finalizes. Seek/restore/fold owners still queue the work
  (the fire condition only matches `none`/`follow`), so the pin never fights them.

## Alternatives considered

- Fixing only the follow-pin stand-down: the pinned body still grows a rendering
  step late, so the observer fires after the growth painted — dip remains.
- Fixing only the body height (auto): the observer fires same-frame but stands
  down during the follow owner — dip remains.
- A bottom-stack spacer debounce (an earlier hypothesis): the spacer transient
  misread is a separate turn-boundary phenomenon, not this per-flush growth dip.

## Consequences

A `nativeSnapHeight` body carries no explicit height pin while open, so anything
that previously read its `style.height` as the content height must read the used
box instead (the fold already does, via `currentBodyHeight`). Scoped to the
streaming thinking row to keep the default pin contract everywhere else.
