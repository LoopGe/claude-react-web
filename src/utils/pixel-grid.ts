/** Snap a CSS-px length to the DEVICE-pixel grid.
 *
 *  The pixel unit that matters for visual stability is the device pixel, not
 *  the CSS pixel: Chrome quantizes `scrollTop` to whole device px (measured
 *  live at dpr=1.5: writing 13659 held 20489/1.5 — a ±1/3px step the old
 *  whole-CSS-px rounding left uncompensated), and it rasterizes text at the
 *  device-pixel grid of LAYOUT positions (aa7ea76e), so a layout step of
 *  1 CSS px at dpr=1.5 is 1.5 device px and re-phases every glyph below the
 *  animated box each frame — the expand shimmer reported at 150% scaling.
 *
 *  Whole CSS px happens to coincide with the device grid at dpr=1 and dpr=2
 *  (which is why the whole-CSS-px fix verified fine there); at fractional
 *  devicePixelRatio it does not. Every per-frame height the fold/reveal tweens
 *  write and every scrollTop the fold-lockstep writes must land on THIS grid.
 *
 *  `dpr` is a parameter (not a module constant) so tests can pin it and so a
 *  live devicePixelRatio change (monitor move, zoom) is picked up per call. */
export function snapToDevicePx(cssPx: number, dpr: number = window.devicePixelRatio || 1): number {
  return Math.round(cssPx * dpr) / dpr
}
