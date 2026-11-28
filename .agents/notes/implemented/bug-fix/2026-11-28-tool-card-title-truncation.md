# Agent Note: Tool-card title truncation contract (eye-button overlap, dense-tier collapse)

Status: implemented

## Problem

In narrow panels the open-in-preview (eye) button painted on top of the file
name on file-tool cards (measured live 2026-11-28: 21.8px of overlap on a
370px card). Root cause, by geometry:

1. `.tool-card-title` is `flex: 1 1 0`, so it only ever receives the header's
   leftover width; below the row's content width the deficit lands inside it.
2. Inside, the copy button `.tool-card-filepath` shrinks (`flex: 0 1 auto;
   min-width: 0`) but the nowrap file-name span could not (automatic minimum
   size = full text width) and the button was `overflow: visible` — the file
   name painted outside its own box.
3. The eye button (`44e8c666`, flex `0 0 auto`) is laid out right after the
   shrunk button box — exactly the overflow region. Before that commit the
   same overflow was clipped invisibly at the title's `overflow: hidden`
   edge; the eye put chrome in the overflow's path.
4. The dir suffix — the element meant to absorb scarcity — reached width 0
   (its ellipsis engaged) while the base's overflow bypassed it entirely.

A second, adjacent defect: the copy button's `margin: 0 -4px` wash bleed
reaches exactly the title's edges, where the title's `overflow: hidden` cut
both the hover wash and the `:focus-visible` ring on the left and right.

## Decision

One coherent truncation model, ordered, all inside the copy button:

- The file-name span shrinks with an ellipsis (`min-width: 0; overflow: clip;
  text-overflow: ellipsis`) — truncation stays inside the button's box.
- The dir suffix carries `flex-shrink: 999`: it sacrifices itself entirely
  before the file name loses a character (the name identifies the card).
- The copy button is `overflow: clip` — the clipping boundary for the row, so
  no child can ever paint across the sibling eye button again. `clip`, not
  `hidden`: no scroll container (no keyboard-scrollable hidden text, no
  persisted scroll offset); the same choice on the base span keeps one
  answer to that question in the file.
- `.tool-card-title:has(.tool-card-filepath)` opts out of the title clip
  (`overflow: visible`) — a file-path title clips itself, so the outer clip
  only cut the wash/ring bleed — and floors at `min-width: 32px` (eye 21px +
  title gap 6px + slack) so the unshrinkable eye can never escape an
  unclipped title into the actions zone; the floor makes the header wrap one
  line earlier instead.
- Dense-card tier raised 239px → 479px: three-panel splits put cards at
  ~350-480px, exactly where titles start truncating; the tier hides the
  status/background labels (icons + colour still carry the state; both
  buttons keep aria-labels) and gives the icon-only pill the shipped
  `.tool-status-compact` geometry. The old 240px tier only fired below any
  realistic pressure point. The subagent surface collapses the same
  background label at 590px in chat.css — the two comments cross-reference.
- `src/styles/tool-card-filepath.test.ts` pins the contract textually
  (happy-dom runs no layout), including compact-geometry parity, and
  `tests/browser/tool-card-layout.spec.ts`'s wrap test re-baselined 280px →
  140px viewport: with collapsed labels the header only wraps below ~145px
  of card now.

## Alternatives considered

- Content-aware collapse (make the title `flex: 1 1 auto` so the shrink pass
  sees the deficit and weighted-shrink the labels first): rejected — with
  `flex-wrap: wrap` on the header, a real base size makes the actions cluster
  WRAP to a second line at exactly the widths we want to collapse instead of
  collapsing; `nowrap` would change wrap semantics for every card kind.
  Container-query tiers are the codebase's established proxy and stay.
- Proportional shrink (base and dir both shrinkable at `flex-shrink: 1`):
  rejected — truncates the file name while a dir fragment still shows,
  inverting the documented name-first priority.
- Hiding the `new file` badge at narrow widths (review suggestion): rejected
  as speculative — measured at the 479px breakpoint the filename still shows
  ~48px of ellipsized name beside the badge; the vanish case needs ~190px
  cards, narrower than any width the codebase acknowledges.
- Inset focus ring (`outline-offset` negative) or dropping the -4px wash
  margin: rejected — both change the shipped visual; un-clipping the
  self-clipping title fixes the ring without touching either.

## Consequences

- At 240-479px cards the status/background label text is gone by design
  (icon + colour remain); users who read the words at those widths lose them.
- A zero-width dir suffix still reserves the button's 8px gap on each side
  (flex gaps don't collapse; margins on the suffix wouldn't vanish either) —
  accepted dead space, commented at the rule.
- Two dense-row pill geometries exist in CSS (`.tool-status-compact` and the
  tier's re-declaration, no class hook inside an at-rule); parity is pinned
  by test, not by construction.
- The 32px title floor is a derived literal (eye geometry lives in TSX as
  `IconEye size={13}`); the derivation is commented and the literal pinned —
  an eye resize must re-derive it.
