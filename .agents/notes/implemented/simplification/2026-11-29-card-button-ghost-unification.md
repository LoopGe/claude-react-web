# Agent Note: Card-button ghost tier unification (.icon-btn / .action-btn)

Status: implemented

## Problem

Every in-card action button had grown its own geometry: four "copy" affordances in four dialects (26×26 ghost on tool cards, 26×26 borderless in TasksPanel, a bordered text chip in code fences, a pill in the copyable path chip), the background verb as a fifth, and hover semantics scattered across five grounds (`--bg`, `--bg-elev`, `--btn-hover-bg`, `--danger`, none) — three of them NOT the system's button-hover token. Two buttons carried bespoke `:focus-visible` outlines next to the app-wide ring; none had the `.btn` family's press feedback. Sizes ran 26/24/22/auto, cluster gaps 6/8. Placement broke one rule outright: the open-in-preview eye sat inside the title flow (left) and "Review permission" floated after the chips, while copy/background/status rode the right-aligned `.tool-card-actions` cluster — actions appeared on both edges of the same row.

## Decision

Two anatomy bases in controls.css, composed in the DOM like the pill tiers, plus a placement rule:

- **`.icon-btn`** — the 26×26 ghost square; archetype is the ORIGINAL `.tool-copy-btn` (the UI the user endorsed): transparent ground at rest with a 1px TRANSPARENT border reserved (hover never nudges the glyph), `--fg-muted`, hover = the original **triad**: a dark `--bg` ground, the reserved border revealed as `--border`, lifted ink. `.copied` is INK ONLY (`--ok-text`, no ground). Members: `tool-copy-btn` (styling empty, hook kept), `tasks-panel-icon-btn`, `tasks-row-stop` (keeps its danger solid-invert hover as the destructive semantic), `tool-card-filepath-open`.
- **`.action-btn`** — the 22px text pill; archetype `.tool-card-bg-btn` (whose original always-on outline was dropped in a follow-up review: a bordered button at rest reads as a status capsule next to the `.pill` family — the whole ghost tier is borderless until hover). Members keep only deltas: the verb's accent hover, the code fence's opacity reveal + bar hairline.
- **`.icon-btn-sm` / `.action-btn-sm`** — compact bar-mounted tiers (auto height, 1px padding): the code-fence copy/wrap buttons keep their original metrics; a 22px pill inside a thin bar read heavy.
- **Placement:** every card action rides the right-aligned `.tool-card-actions` cluster. The preview eye left the title — `ToolCard` gained a `preview?: { path; params? }` prop rendering `PreviewOpenButton` (self-gating on the resource-link context; consumers pass it unconditionally). "Review permission" moved into the cluster but stayed a filled warn CTA — it is deliberately NOT a ghost member.
- **Spacing:** one `--gap-actions` (6px — ghost boxes inflate perceived spacing) for both button clusters (`.tool-card-actions`, `.code-block-actions`); chip/metadata rows stay on `--space-2` (`.perm-summary` moved 6→8 to join them).
- **Focus:** the global `:focus-visible` ring owns the family; both bespoke outlines were deleted. Press feedback (`scale(--motion-scale-press)`) matches `.btn`.

## Mid-course correction (what "unified" does NOT mean)

The first cut replaced the prototypes' `--bg` hover with the system token `--btn-hover-bg`, gave `.copied` a soft ok ground, and folded the filled `tool-card-perm-reopen` pill into the action tier for uniform geometry. Reviewed against the live look it was **heavier than what it replaced** — the user's call: "the previous copy button UI was good; align to it." The whole family therefore defers to the original quiet-ghost language: recessive dark-ground hover with a hairline reveal, ink-only copied state, filled CTAs excluded, bar-mounted controls kept compact. Token purity loses to perceived weight here: `--bg` IS the wrong token by taxonomy (it is the page ground, not a button-hover token) and the RIGHT one by outcome; `card-btn-anatomy.test.ts` pins the triad so it cannot "helpfully" migrate to `--btn-hover-bg` later.

## Alternatives considered

- **`--btn-hover-bg` hover + grounded copied state** — built, looked heavy next to the status pills, reverted (see above). Recorded because the token-consistency argument will resurface.
- **Unify onto `.btn-icon`** (the filled 34×30 header tier). Rejected: in-card actions compete with the just-unified pill row for attention; the ghost tier is the card's correct register. `.btn-icon` stays for header chrome/dialogs.
- **Folding `tool-card-perm-reopen` into `.action-btn`.** Rejected: flattening a filled warn CTA into the ghost family erased its urgency — placement unified, appearance kept.
- **One size for all text actions (22px).** Rejected: the code-bar copy/wrap pair originally ran ~18px; the sm modifiers preserve the originals instead of re-growing bar buttons.
- **Grouped selectors without DOM bases.** Same rejection as the pill round — invisible anatomy, no self-describing composition for new sites.

## Consequences

- **Bought:** one anatomy per tier in one file; six render sites total (two are shared components); hover/focus/press behavior identical everywhere; every card action now reads from the right edge, which the truncation contract (title shrinks, cluster is the fixed anchor) now pins against `.icon-btn` instead of a member's `flex: 0 0 auto`; cluster gap is one token.
- **Accepted visual deltas:** stop button 24→26 (larger hit target); preview eye compact-padding → 26×26 box (glyph unchanged, moved to the right edge); TasksPanel toolbar icons `--fg` → `--fg-muted`; the background verb lost its always-visible outline in the follow-up (rest = quiet text + arrow, the box girds on hover — the same triad as the copy button); fence copy hover `--bg-elev` → `--bg` + hairline; fence wrap hover keeps the always-visible bar hairline via its member `border-color`; cluster gaps 8→6 (cards), chip row gap 6→8 (permissions summary); press scale + global ring everywhere.
- **Test surface:** `card-btn-anatomy.test.ts` (bases, member-anatomy ban incl. `outline`, hover triad, sm tiers, gap tokens, placement guard, DOM-composition source scan); `tool-card-filepath.test.ts` re-pointed at the new anchors; `shared.test.tsx` now exercises `PreviewOpenButton` beside `FilePathTitle`, mirroring the real card structure.

## Related

- [Message-card pill unification](2026-11-28-message-pill-unification.md) — same mechanism (DOM-composed bases + semantic hooks + pin + source scan); its `--btn-hover-bg` chip hover stays valid for PILLS, which sit on card grounds, not for the ghost button tier.
