# Agent Note: Three-mode transparency with fully opaque surfaces

Status: implemented

## Problem

The Transparency switch controlled only the floating-glass tokens. Turning it off made those surfaces opaque but deliberately preserved wallpaper-driven translucency in the sidebar, chat panels, and their contents. A user who wants every sidebar, card, dialog, and other neutral surface to be solid had no setting for it.

## Decision

Transparency is a three-mode preference: `glass`, `no-frost`, and `opaque`. The first two preserve the previous switch states, including their appearance and stored boolean migration. `opaque` makes neutral UI surfaces solid and disables backdrop filtering, while retaining modal scrims, semantic tint fills, shadows, selection, hover treatments, and animation opacity. The control is available on every skin because direct neutral surfaces can remain translucent even when a skin's shared glass tokens are already opaque.

Wallpaper opacity, content opacity, and blur sliders remain the raw preferences written by `useBackground`. New `--effective-app-*` aliases are the values consumed by `layout.css`; opaque mode pins the effective values to solid/no-blur, so returning to Glass restores the raw sliders without rewriting them.

`glass.css` owns the opaque overrides because it loads after the surface stylesheets. Shared glass surfaces use tokens, wallpaper chrome uses the solid background aliases, and a small roster handles neutral surfaces whose own rules mix a base colour with `transparent`. Inline SVG refraction filtering requires an `!important` override, and `useLiquidGlass` uses a read-only subscription to the applied attribute so opaque mode stops displacement-map generation without persisting or broadcasting storage on mount. Semantic surface colours are preserved, including the Brutalist WorkingBar's yellow. There is no global background reset that could erase message-type, accent, code, or state colours.

## Alternatives considered

**Broaden the existing off state to cover everything.** This would have changed the appearance of users who intentionally keep floating dialogs solid while retaining wallpaper translucency. A third mode preserves that behavior.

**Add an independent opaque switch beside the transparency switch.** Two overlapping booleans would require precedence and disabled-state rules and could represent contradictory settings. One three-state preference keeps the states mutually exclusive.

**Overwrite the inline wallpaper slider values in Opaque mode.** Inline values win over ordinary root CSS, and overwriting them would lose the user's previous settings. Effective aliases separate the stored preference from the active rendering value.

**Use a universal `background` or `opacity` reset.** A universal reset would destroy semantic colours and functional transparency and would also change entire subtrees. The override is limited to neutral surface fills and backdrop filters.

## Consequences

Opaque removes backdrop-filter work and prevents wallpaper from showing through UI surfaces, but it does not stop animation-driven repainting and is not a substitute for Animation speed Off. Modal scrims remain translucent for modality, and semantic tint fills remain translucent where they convey state rather than a neutral surface.

Adding a new neutral translucent surface requires either routing it through the shared glass tokens or adding it to the explicit opaque roster. `src/styles/opaque-transparency.test.ts` pins the current roster and effective-token contract.

## Testing

Unit tests cover legacy boolean migration, document attribute mapping, the three-mode control, and the CSS contract. Browser verification covers Default, Glow, and Anthropic skins, dark and light modes, a translucent wallpaper, portal surfaces, and restoration of the original wallpaper slider values after returning to Glass.
