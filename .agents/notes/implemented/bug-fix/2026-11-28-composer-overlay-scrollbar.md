# Agent Note: Composer editor unified overlay scrollbar

Status: implemented

## Problem

The composer editor (`.rich-prompt`) and the side-chat input scrolled their
capped drafts with the legacy native scrollbar (the `tokens.css` global
fallback) while every other scroll surface in the app uses the self-built
[overlay scrollbar](2026-11-18-overlay-scrollbar-horizontal-drag.md): an
always-visible native bar that eats layout width, next to auto-hiding overlay
thumbs elsewhere. The overlay rollout had wired the composer's Preview pane
(`setPreviewOs`) but never the editor itself, and no decision record excluded
it — an omission, not a design.

Two facts made the editor a non-trivial attach:

- `syncEditorHeight` keeps `overflow-y: hidden` while the height tween grows
  the box and flips it to `auto` only past `max-height`. A thumb keyed on
  scroll overflow alone (`scrollHeight > clientHeight`, true mid-tween even
  under `hidden`) flashes during every growth tween — the exact flash the
  `hidden` default exists to prevent.
- The vertical track's CSS `right: 0` pins it to the PARENT's padding-box
  right edge. Every prior consumer's scroller was flush right; the editor is
  not (`.composer-main` has horizontal padding; the side-chat input row holds
  a Send/Attach button column to the right), so the thumb would float over
  the gutter or the buttons.

## Decision

- `RichPromptInput` attaches the overlay scrollbar itself
  (`useOverlayScrollbar` + `useMergedRef` with the host's `editorRef`), so
  every host (Composer, SideChatDrawer) gets the unified control with no
  per-host wiring to forget.
- `attachOverlayScrollbar` gains an opt-in `respectHiddenOverflow` option:
  when true, an axis whose computed overflow is `hidden`/`clip` shows no
  thumb — the thumb appears exactly when a native bar would. The editor opts
  in; the default (false) treats `hidden` as mere clipping. The hook forwards
  the option like every other; a seam test drives render → hook → attach →
  scroll update so a silently dropped option fails CI.
- `syncTrackBox` pins the vertical track's cross axis to the scroller's own
  padding-box right edge (`left` + `right: auto`), the horizontal twin of the
  existing bottom-edge pin. Flush-right consumers are unchanged (the formula
  coincides with `right: 0` there).

## Alternatives considered

**Universal hidden-overflow gate (no option).** The coherent "thumb ≡ native
bar" rule for every consumer. Rejected: `useAutoHeightTransition` pins
`overflow: hidden` for the duration of a height tween on ~25 dialog bodies
(GitPanel, SettingsPanel, the pickers, …) whose content stays overflowed and
wheel-scrollable; there `hidden` is a clipping technique, not a no-scrollbar
intent, and the gate would blank their only scroll affordance mid-animation
(the native bar is already hidden by `data-os-native-hidden`). The two host
intents are real and proven, so the option names the axis instead of changing
shipped dialog behavior as a side effect of a composer fix.

**Per-host wiring (Composer attaches the editor's scrollbar).** Rejected —
that is precisely how the editor got missed: the preview was wired and the
editor forgotten. The component that owns the scroller owns its scrollbar.

**Hand-rolled mount effect / composed ref callback writing `ref.current`.**
Rejected: `react-hooks/immutability` flags writing a prop-owned RefObject,
and `useMergedRef` is the established composition idiom (its module-level
`setRef` exists for exactly this). The merged ref's stable-ref precondition
is already required by the component's `[ref]`-keyed effects.

## Consequences

- `respectHiddenOverflow` is a host-intent axis future consumers must choose:
  hidden-as-no-bar (the editor) vs hidden-as-clipping (dialog height tweens,
  the default). Removing the option in favor of a universal gate would
  re-introduce the mid-tween blanking on every animated dialog body.
- The vertical track now follows the scroller's right edge everywhere,
  including scrollers inset by parent padding — strictly the module's stated
  "track matches el's box" contract, which the cross axis previously violated.
- `useOverlayScrollbar` forwards a fixed option list; any new
  `OverlayScrollbarOptions` field must be added there too, or it is silently
  dropped. The RichPromptInput seam test pins the forwarding for this option.
