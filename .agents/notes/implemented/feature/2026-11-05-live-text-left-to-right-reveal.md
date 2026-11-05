# Agent Note: Left-to-right reveal for live streaming text

Status: implemented

## Problem

The live turn rendered in ~80 ms batches: each flush re-compiled the tail
markdown block and the text appeared as a whole. A growth should read as ink
flowing left-to-right instead of popping in, without touching the markdown
pipeline — the tail block is re-compiled whole per flush and the mid-stream DOM
must stay byte-identical to the settled render (the pixel-parity contract).

The obvious per-token approach — wrapping each newly arrived run in a span with
a sweep animation, as the throwaway preview did — cannot survive markdown:
a delta can sit inside `**bold**`, a link, or a code span, and splitting the
source at the delta boundary breaks formatting and introduces a block break.
Direct DOM wrapping after React commits fights reconciliation.

## Decision

A **spatial CSS mask** on the element that holds the live markdown, driven by
one caret measurement per flush (`useStreamingReveal`). The markdown DOM is
never modified; only the mask geometry changes.

Each flush measures the last rendered glyph with a `Range`, converts it to the
masked element's coordinate space, and sets the vertical boundary plus the
caret strip. `chat.css` turns those into three unioned mask layers:

1. a vertical layer that is opaque above the tail line and transparent below
   it, so settled lines never animate. The boundary is the caret's **line box**
   top (glyph top minus half the leading), clamped to the element's top for a
   first-line caret, so taller inline content on the same line (KaTeX) cannot
   peek through the opaque band and the first line still reveals;
2. a horizontal layer whose width is animated from the previous caret to the
   new one, so only the tail line sweeps left-to-right;
3. a narrow always-opaque strip at the new caret, so the blinking cursor (a
   `::after` inside the masked subtree) leads the ink instead of being hidden.

The width animation runs through the Web Animations API (`element.animate`
over `mask-size`). It restarts cleanly per flush, needs no duplicate keyframe
bodies, and matches the transcript entrance sweep's existing WAAPI usage. The
mask is removed when the animation finishes, when a rewrite shrinks the text,
and on unmount (a microtask makes that cleanup distinguishable from StrictMode's
cleanup→re-run, which must keep the first sweep). Growth with no horizontal
advance (trailing space, newline, a closing `**`/backtick) keeps the in-flight
sweep rather than truncating it. Reduced motion never starts a sweep and leaves
no mask behind.

Tails that render block-level content after the caret (fenced code, tables,
images, thematic breaks, display math) opt out via `isRevealableTail` and
appear whole: the mask cannot reveal a region it did not measure. The predicate
takes the whole `StreamSegment` (including the code type) and is shared by both
renderers, so the inline draft card and the overlay bubble cannot drift.

## Alternatives considered

**Wrap each newly arrived run in an animated span (the preview).** Rejected:
it requires splitting markdown at the delta boundary, which breaks inline
formatting and adds a block break; DOM wrapping after commit fights React's
reconciliation.

**Re-run a block-wide sweep on every flush.** Rejected: the mask's soft edge
would sit at the same x on every line, so the right edge of every settled line
would re-fade at ~12 Hz — visible shimmer, and it violates the "settled text
stays static" goal.

**Render the live tail as plain text and swap to markdown when it settles.**
Rejected: raw markdown markers would show while streaming and the settle
exchange is exactly the swap the in-place card design removed.

**Animate opacity only (no direction).** Rejected: the requested effect is
directional; a plain fade does not read as left-to-right.

**Alternating animation class names with duplicate keyframe bodies.**
Rejected: the repo's global keyframe-uniqueness guard forbids two identical
`@keyframes` bodies, and `animation: none` + reflow to restart would add a
second forced layout per flush. WAAPI restarts without either cost.

## Consequences

The hook does two `getBoundingClientRect` reads (the Range and the container)
in a layout effect on the 80 ms flush path. The reads share one forced layout
that the browser would perform before paint anyway, but they do move that work
into the commit task; on very long drafts this is the main cost of the feature.
Measurement is skipped when the text does not grow and when layout is
unmeasurable (hidden panel, test DOM).

The mask repaints the tail block while the sweep runs, but the animated
property is `mask-size` (not layout), and the block is small.

Block-level content is intentionally not swept. A tail that mixes prose and an
image waits for the next prose growth before it animates again.

A window resize during the ~240 ms sweep is not handled specially; the mask is
dropped when the animation finishes, so any stale geometry lives at most one
sweep.

The `black` stops in the mask are alpha-channel values, not theme colours (the
same convention as the `.streaming-plain` edge fade); they are deliberately not
theme variables.