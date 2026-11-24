# Agent Note: Panel height-change animation

Status: implemented

## Problem

The resource preview modal (`ResourceModal`, the app-header eye toggle) is
content-sized: its card carries `max-height: min(86vh, 760px)` and the body is
the flexible remainder. Every height change while open was an instant jump —
switching tabs (only the active tab mounts its body, keyed by address), a read
landing, the markdown View source ↔ View preview toggle, an image decoding, or
switching between the five resource kinds. The open/close beat already animated
(Overlay's `overlay-panel-in/out`); the in-place height changes did not.

## Decision

The body's height tweens between content changes via the existing
`useAutoHeightTransition` hook — the same primitive and 240ms standard ease the
settings panels use. No new animation machinery and no new dependency.

- **The animated box is the body (`.resource-modal-body`), not the card.** The
  card's ref is not exposed by `Overlay`, and the body is the precedent's choice
  (`SettingsPanel`, `GlobalSettingsModal`). A stable `.resource-modal-content`
  wrapper inside the body is the ResizeObserver target — the body's children
  remount per tab, so the observer needs a persistent box. The wrapper carries
  the same flex fill chain (`flex: 1 1 auto; min-height: 0; display: flex;
  flex-direction: column`) so all five resource kinds size identically.
- **The hook lives in a `ResourceModalSurface` child rendered as Overlay's
  child, not in the always-mounted `ResourceModal` host.** Chat keeps
  `ResourceModal` mounted; `Overlay` unmounts its children when closed. A hook
  in the host would never re-install its observer on reopen (the host's refs go
  null while closed but its effects do not re-run) and would carry a stale height
  baseline across open/close. Mounting with the surface gives a fresh baseline
  on every open — so the open beat itself does not tween — and a live observer
  for async growth within a tab.
- **The target is capped** by `measureResourceModalBodyHeight`
  (`resource-modal-measure.ts`): `min(naturalContentHeight + bodyPadding,
  cap − cardBorders − header)`. The cap lives on the card itself, so the ceiling
  is plain arithmetic (no offsetParent walk like `settings-panel-measure`). An
  uncapped target pins the body past the card's space and `clearInlineHeight`
  snaps it back when the tween ends — the jump class that module documents.
- **The natural height is read with a synchronous content-sized flip.** The
  wrapper is flex-fill so the five kinds keep their inner scrollers, which means
  its `scrollHeight` tracks the body's pinned/clamped height, not the new content
  — reading it directly would degenerate every tab-switch tween to a snap. The
  measure flips the wrapper to `flex: 0 0 auto` for the read (children expand to
  natural height), then restores it; no paint lands between flip and restore. The
  settings precedent avoids this only because its wrapper is permanently
  content-sized and its BODY scrolls — a shape that would move this modal's
  scrolling off the inner elements that carry the overlay scrollbars.
- **Capture before every active-tab change, and only then**: chip click,
  arrow-key navigation, and closing the ACTIVE tab call `captureHeight()` before
  mutating the store. A no-op focus (the already-active chip, arrow wrap on a lone
  tab) and closing a background chip do NOT capture — the store early-returns /
  the active body is unchanged, so no key change would ever release the pin and
  the body would strand at a fixed height.
- **Line navigation stays centered through the tween.** `NumberedCode` extracts
  `centerTarget` and adds a ResizeObserver on the code scroller that re-centers
  the target on container resize within `RE_CENTER_WINDOW_MS` (400ms — the 240ms
  tween plus the hook's +120ms safety timer and slack) of the jump, standing down
  on explicit user scroll input. It does NOT infer "user scrolled" from a scrollTop
  delta: the browser clamps scrollTop when the viewport grows, which would falsely
  latch and disable re-centering for the rest of the jump's life. Stand-down sources
  are wheel and touchstart on the pre, plus a pointerdown on the pre's PARENT whose
  target falls outside the pre — the overlay scrollbar's thumb is a sibling of the
  pre (appended to its parent by `useOverlayScrollbar`) and dragging it sets
  scrollTop with no event on the pre, so this catches a thumb drag at drag start.
  A pointerdown INSIDE the pre (text selection) is not a scroll and does not stand
  down. The modal's height tween resizes the scroller after the jump centered
  against the start height; without this the target drifts off-center by half the
  height delta.
- **The content wrapper carries `.modal-section`'s gap** (`var(--space-2-5)`).
  `FilePreviewBody` renders a fragment (source toggle + scroller + truncated hint)
  whose siblings used to be direct children of the body and received that gap; the
  interposed wrapper must restore it or the markdown preview's spacing tightens.

The motion gate is the shared one: `motionSuppressed()` (OS reduced-motion or the
in-app Animation speed = Off preset, see
[animation-speed-off](2026-11-09-animation-speed-off.md)) makes the hook snap.

## Resume session picker

The same primitive animates the resume picker's list (`ResumeSessionDialog`,
`.palette-list`): the "Loading…" placeholder → N rows growth, query filtering,
and scope-toggle refetch tween instead of jumping. Both the modal and panel
variants share the wiring; the dialog mounts/unmounts with the open cycle
(presence-gated callers in App and Chat), so the hook lives directly in it — no
surface extraction needed, and a fresh baseline on every open.

- A content-sized `.resume-list-content` wrapper (`role="presentation"`, so the
  listbox→option ownership survives) holds the rows and is the observer target —
  stable during the tween, firing once per content change rather than per frame.
  The hook key is `loading|error|filtered.length`, which also drives the tween
  where ResizeObserver is unavailable.
- The measure is the shared `measureCappedContentHeight` (the original bespoke
  `resume-list-measure.ts` was deleted once the generic measure existed). The
  list follows the panel-overlay convention (GitPanel/TasksPanel): a flex:1
  scroller with NO own vh cap, filling a card capped at max-height:100% of the
  panel (panel variant) or 84vh (modal variant). The target is `min(content,
  card ceiling)`. An earlier inline `max-height:50vh` on the list was an
  undocumented outlier inconsistent with the panel overlays; it was removed so
  the picker fills its host like the rest. The panel variant's WIDTH is likewise
  aligned: `.panel-overlay-card.resume-overlay-panel` overrides the shared
  compact 560px picker width with `width:100%; max-width:
  --chat-reading-max-width` (the 900px reading column GitPanel/TasksPanel/
  SearchPanel use); InputHistory keeps the 560px picker width.
- **The ceiling is pin-independent**, computed from the card CAP minus fixed
  chrome (borders/padding + header + footer + section padding + sibling rows +
  gaps + list margins), NOT from the section's current height. The card is
  content-sized below its cap, so a section-derived ceiling collapses to the
  list's pinned height during an in-flight tween and clamps a mid-tween retarget
  to where the tween already is (settling short, then snapping on release). A
  percentage card cap (the panel's 100%) does not resolve to px in computed
  style, so it is resolved against the parent's content height; vh/px caps read
  straight. Verified live to equal the list's used height and to be unchanged
  when the list is pinned mid-tween.

## Generic measure and broader rollout

The same treatment extends across the app's panels and dialogs: CommandPalette,
InputHistoryPanel, FullDiffViewer, UpdateDialog, StructuredPanel, McpInstaller,
McpImportDialog, NewSessionDialog, SnippetsManagerDialog, UploadsManagerDialog,
TasksPanel, SessionSearchPanel, WorktreeChanges, GitPanel's discrete route swaps,
and the smaller dialogs (ShortcutHelp, McpExportDialog, ProfileCreateDialog,
RunAsAgentControl, PermissionDialog, QuestionDialog, ElicitationDialog,
ModelPicker, CommandPicker). Rather than a bespoke measure per surface, these
share `measureCappedContentHeight(box, content, card)`
(`src/utils/capped-height-measure.ts`): the resume ceiling idea generalized to
any nesting by walking from the box up to the card and summing each level's
padding, flex gaps, and in-flow sibling outer heights. The card cap is resolved
NON-INVASIVELY from the card's computed `max-height` — a px length reads straight
(vh and `min(vh,px)` already resolve), and percentage / `min()` / `max()` terms
are resolved against the card parent's fixed content height. Each surface adds a
content-sized wrapper (the observer target), a measure callback finding its card
via `closest`, and a state key; `TasksPanel`/`WorktreeChanges`/`GitPanel` row
folds use `AnimatedCollapse`/`AnimatedDetails` and the card hook stands down for
them via `claimCollapseMotionInside`. Fixed-height views (the SessionSearchPanel
preview, terminal, drawers) are intentionally not animated.

Three robustness rules the generic measure must honor (all found in review or
live debugging, and verified live):

- **Skip out-of-flow children in the chrome sum.** The overlay scrollbar appends
  an absolute track to the card whose height equals the scroller's; counting it
  as chrome collapsed the ceiling to ~0 whenever the scroller overflowed.
  Absolute/fixed children consume no flex space, so they are excluded (this also
  removes the need for a per-consumer nested-overlay refusal).
- **Floor the target at the box's `min-height`.** A snippets list's 120px floor
  means a short list renders taller than its natural content; a target below the
  floor diverges from the used height and gives a growth tween a dead zone.
- **Resolve the cap without mutating the box.** An earlier empirical lift forced
  the box tall, read the card's clamped height, and restored the box. Restoring an
  auto box let it reflow to full natural height BEFORE the hook pinned the tween
  start (the resume loading→results transition jumped instead of animating), and
  mid-tween the lift animated against the hook's height transition, collapsing the
  ceiling into a one-shot oscillation. The non-invasive resolver touches nothing,
  so the measure cannot disturb the pin or reflow the box.

## Alternatives considered

### Why not animate the card instead of the body?

`Overlay` does not expose a card ref, so reaching it means either adding a prop
to a primitive ~15 surfaces use or a `closest()` query hack. The body is the
settings precedent's animated box and is directly ref-able. The card auto-follows
the pinned body, so the visual result is the same.

### Why not keep the hook in the ResourceModal host?

The host is always mounted; its refs go null while the Overlay is closed but its
effects do not re-run on reopen, so the observer would never install and the
baseline would go stale (a reopen could glide from a pre-close height). Making
the measure callback's identity depend on `open` to force the effects to re-run
was considered and rejected as an implicit identity hack; mounting the hook with
the surface is the honest lifecycle.

### Why not suppress the animation when a tab has a line target?

Skipping the tween for `#L` navigations would exempt exactly the dramatic
height changes (opening a file from a markdown link) and trade precision for
stillness. Re-centering on resize keeps both — animation everywhere and a
centered target — so suppression lost.

### Why not infer "user scrolled" from a scrollTop delta?

The first implementation latched `userScrolled` whenever scrollTop differed from
the last written value. That misclassifies a browser clamp as a user move: when
the tween GROWS the viewport, the browser clamps scrollTop down to the new
smaller max for any target past mid-file, falsely latching and disabling
re-centering for the rest of the jump (a later shrink then never re-centers). A
contents refetch clamps the same way. The shipped gate is a time window around
the jump (covers the tween, expires cleanly) plus explicit input events for user
intent — neither relies on distinguishing a clamp from a scroll by value.

### Why not derive the resume ceiling from the section's current height?

The first resume measure read `section.clientHeight` minus siblings/gaps. It is
correct in steady state (verified equal to the list's used height) but pin-
DEPENDENT: below the card cap the card is content-sized, so the section's height
tracks the list's pinned height during a tween, and a mid-tween retarget clamps to
where the tween already is, settling short and snapping on release. An offsetTop
walk to the card was also tried and rejected — the card is not positioned, so the
chain overshoots it. The cap-based ceiling (card cap minus fixed chrome) is pin-
independent and resolves the panel's percentage cap against the parent.

## Consequences

- Tab switches, load landings, source toggles, image decodes, and kind switches
  glide instead of jumping; the open/close beat is unchanged.
- The two-stage loading motion (shrink to the "Reading…" hint, grow to content)
  is preserved, matching the settings panels' loading keys — not hidden.
- `NumberedCode` now installs a ResizeObserver and wheel/touchstart/pointerdown
  listeners whenever a line target is active (none for the common no-target case).
  The upcoming wrap toggle
  ([preview-polish](2026-11-24-preview-polish.md)) is
  another height-change source the body observer covers automatically; its
  scroll-to-line recompute is the same concern this note's re-centering addresses.
- The body carries the primitive's `.auto-height-animating { flex: 0 0 auto;
  will-change: height }` override so flex cannot fight the pin while animating.
- The resume picker's list glides on load/filter/scope changes too. Its measure
  (`resume-list-measure.ts`) and the wiring (observer + key paths, pin release)
  are unit- and integration-tested; the cap-based ceiling's pin-independence and
  equality with the used height are verified live. The `.palette-list.auto-height-
  animating` override is a separate rule like the settings/global/modal-list ones
  (the class only lands when this hook animates, so the shared CommandPalette and
  InputHistoryPanel lists are unaffected).
- Cost: one extracted surface component, a content wrapper div + CSS rule, a
  capped-measure util (with the content-sized flip), the no-op capture guards, and
  the windowed re-centering observer. The measure math and flip-and-restore are
  unit-tested (`resource-modal-measure.test.ts`); the wiring (capture, key-driven
  tween, no-op guards) is tested in `ResourceModal.test.tsx` with the measure
  mocked; the re-centering (growth, user stand-down, window expiry) is tested in
  `NumberedCode.test.tsx`. The flip's layout correctness — a flex-fill wrapper
  clamping its scrollHeight — is a browser-layout fact jsdom cannot compute, so it
  is verified manually in the live modal rather than by a unit assertion.

## Related

- [preview-polish](2026-11-24-preview-polish.md) — the
  numbered-view wrap toggle adds a height-change source this animation covers.
- [animation-speed-off](2026-11-09-animation-speed-off.md) — the motion gate the
  hook respects.