/**
 * Height target for the session settings panel body
 * (`.settings-panel-body`), consumed by `useAutoHeightTransition`'s
 * `measureTargetHeight`.
 *
 * The body is the panel's flexible remainder: when the tab content is short
 * the panel is content-sized and the body's height IS the content height;
 * when the content is tall the card is capped by
 * `.settings-overlay > .settings-panel { max-height: 100% }` and the body
 * sits at that ceiling. So the target is `min(content.scrollHeight, ceil)`
 * where `ceil` is the body's height in the capped regime — the value
 * `clearInlineHeight` must agree with, or the end of every height tween
 * snaps the box (and the overlay scrollbar on it).
 *
 * `ceil` is fixed layout geometry: the overlay's content-box bottom minus
 * the body's top, minus the card's chrome below the body (its padding and
 * bottom border):
 *
 *   body top       = the offsetTop chain up to the overlay (see below)
 *   content bottom = overlay.clientHeight − overlay's paddingBottom
 *   chrome below   = panel's paddingBottom + panel's borderBottomWidth
 *
 * The body-top chain is walked rather than named because which element the
 * body's offsetTop is RELATIVE to varies over time: offsetTop is always
 * measured against the offsetParent's PADDING edge (CSSOM), and the overlay
 * scrollbar promotes `.settings-panel` to `position: relative` in a passive
 * effect (overlay-scrollbar.ts attach) — AFTER this hook's first measure. So
 * the body's offsetParent is the panel once promoted and the overlay before
 * it, and a formula that names the panel double-counts its offsetTop +
 * clientTop in the pre-promotion window (a 17px-under ceiling that seeds a
 * spurious catch-up tween on panel open). Summing body.offsetTop plus each
 * intermediate offsetParent's offsetTop + clientTop is exact in both regimes:
 *
 *   promoted:   117 + (16 + 1) = 134 within the overlay
 *   unpromoted: 134 (already overlay-relative)
 *
 * The even older formula (`overlay.clientHeight − body.offsetTop`) mixed an
 * overlay-relative clientHeight with a panel-relative offsetTop and counted
 * the backdrop's padding and the card's borders as body space — pinning the
 * body 34px past its natural height on a live panel (1087 vs 1053), visible
 * as the scrollbar suddenly snapping short when the tween chain ended and
 * `clearInlineHeight` released the pin.
 */
export function measureSettingsPanelBodyHeight(body: HTMLElement, content: HTMLElement): number {
  const overlay = body.closest('.settings-overlay') as HTMLElement | null
  const panel = body.closest('.settings-panel') as HTMLElement | null
  if (!overlay || !panel) {
    // The DOM contract (Chat renders Overlay > SettingsPanel) holds for every
    // caller — a silent fallback here would mask a contract break as an
    // uncapped tween target, the bug class this module exists to fix.
    throw new Error('measureSettingsPanelBodyHeight: body is not inside a .settings-overlay > .settings-panel layout')
  }
  const overlayStyle = window.getComputedStyle(overlay)
  const panelStyle = window.getComputedStyle(panel)
  let bodyTop = body.offsetTop
  for (let node = body.offsetParent as HTMLElement | null; node && node !== overlay; node = node.offsetParent as HTMLElement | null) {
    bodyTop += node.offsetTop + node.clientTop
  }
  const contentBottom = overlay.clientHeight - parseFloat(overlayStyle.paddingBottom)
  const chromeBelow = parseFloat(panelStyle.paddingBottom) + parseFloat(panelStyle.borderBottomWidth)
  // A squeezed geometry (the chrome consumes the whole overlay) is a REAL 0
  // ceiling — no falsy-zero fallback to the full content height.
  const availableBodyHeight = Math.max(0, contentBottom - bodyTop - chromeBelow)
  return Math.min(content.scrollHeight, availableBodyHeight)
}
