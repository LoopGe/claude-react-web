# Agent Note: Overlay scrollbar horizontal drag — dead axis, grab-centering, 2px thumb

Status: implemented

## Problem

The self-built overlay scrollbar (`src/utils/overlay-scrollbar.ts`) had three
compounding horizontal-axis defects, all reported against the GitPanel diff
preview and shared by every `orientation: 'horizontal' | 'both'` host
(DiffView, TurnDiffView, ResourceDiffBody, ResourceSnapshotDiffBody,
WorktreeChanges):

1. The shared thumb-drag handler subtracted `trackRect.top` from the pointer
   coordinate on BOTH axes. For horizontal drags (`clientX`) the track's
   viewport Y entered the X math, so the scroll fraction was negative
   everywhere inside the track and clamped to 0 — the horizontal thumb could
   never be dragged off the left edge. Measured live: a 300px drag left
   `scrollLeft` at 0 while the vertical control scrolled normally.
2. With the axis corrected, the drag's documented "center the thumb under the
   pointer" design became the next defect: it subtracts `thumbSize/2` instead
   of preserving the grab offset. A diff thumb spans most of the track
   (half-width > whole travel), so a left-edge grab dead-zoned until the
   pointer moved `thumbSize/2`, and a right-edge grab teleported to the far
   end on the first move.
3. The horizontal thumb rendered 2px tall, too thin to grab: `.os-thumb` has
   no cross-axis size; block layout stretches `width:auto` to the 6px track,
   but `height:auto` on the empty thumb div collapses to 0 + 2px border.

## Decision

The drag maps the pointer through the track origin on the pointer's OWN axis
(`left` for horizontal, `top` for vertical) and preserves the grab offset
recorded at pointerdown from the thumb's RENDERED leading edge
(`getBoundingClientRect`). The rendered read stays faithful when the rAF
thumb sync lags a wheel scroll and keeps one source of truth for the thumb
position instead of a second copy of updateAxis's scroll→track mapping.
Track/thumb geometry is sampled at pointerdown; only the scroll range is
re-read per move (streaming growth).

`.os-track-horizontal .os-thumb { height: 100% }` restores the 6px thickness
symmetric with the vertical thumb (global `border-box`, 4px colored core).

## Deferred

Pre-existing or latent gaps found in review, knowingly not bundled:

- Mid-drag streaming drift: frozen pointerdown geometry vs updateAxis's live
  re-render means a streaming drag's rendered thumb can slide away from the
  grab point. Root fix would gate updateAxis's thumb writes on `dragging`
  (one geometry epoch per drag) — a render/drag interaction decision.
- Multi-touch: `onUp` does not match `ev.pointerId` against the captured
  pointer, so a second touch's pointerup on the thumb ends the first drag.
- Horizontal track cross-axis position: `syncTrackBox` syncs only left/width;
  the track's vertical position stays CSS `bottom: 0` of the PARENT. Every
  current host places the scroller last and flush (measured offset 0); a
  footer sibling or parent padding-bottom under a future host would float
  the thumb off the scroller's bottom edge.

## Alternatives considered

**Keep the center-under-pointer formula.** It is only harmless when
`thumbSize/2` is small against travel (long lists, tiny thumb). Wide thumbs
turn it into "drag does nothing" / "jumps to the end" — the exact reported
symptoms. The "natural grab feel" the old comment claimed is what delta
following actually delivers; centering is not natural when grabbing
off-center.

**Derive the grab position from `el.scrollLeft` via a copy of updateAxis's
scroll→track mapping.** Duplicates the formula and jumps when the render
lags the scroll within a frame; reading the rendered rect grabs what the
user sees. Implemented first, replaced in review.

## Consequences

Horizontal thumbs drag correctly from any grab point, clamped at both ends,
and are 6px thick like the vertical ones. The drag model now has seven
regression pins (`overlay-scrollbar.test.ts`: axis mapping + both clamps,
left-edge, right-edge, mid-scroll rendered position, vertical control,
mid-drag range growth, 'both' orientation) and a CSS cross-axis pin
(`overlay-scrollbar-thumb.test.ts`, anchored regex via `readCss`). The
mid-drag growth pin covers the scroll range only — happy-dom fires no scroll
events, so rendered-thumb consistency during a real streaming drag stays
untested (see Deferred). TDD RED was observed for each behavior before its
fix; live browser probes matched the expected mapping exactly (left +30 → 48
of 362, full travel → max, back → 0; right hold → 0, +40 → 64; thumb 6px with
`elementFromPoint` hitting it).
