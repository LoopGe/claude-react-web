/** PDF zoom math and pointer-anchored scroll compensation.
 *
 * Ported from DSH's shared zoom layer (ui-primitives document-zoom.ts +
 * ZoomViewport.tsx) onto our scroll container. Layout resizes SYNCHRONOUSLY
 * through the `--pdf-zoom` variable + `data-pdf-zoom-mode` attribute (the CSS
 * width rules in file-viewer.css read them), so a gesture can measure the new
 * surface geometry and compensate scroll in the same tick — the bitmap redraw
 * follows asynchronously at the settled zoom. Pure math plus one DOM-applying
 * function; no pdf.js imports, so it stays inside the lazy PDF chunk. */

/** Fixed scale limits, incremental step, and menu choices (1 = 100% = 96-DPI). */
export const PDF_ZOOM = {
  minimum: 0.25,
  maximum: 4,
  step: 0.25,
  presets: [0.25, 0.5, 1, 1.5, 2],
} as const

/** Automatic fit or an explicit actual-size scale selected by the reader. */
export type ZoomPreference =
  | { readonly kind: 'fit-width' }
  | { readonly kind: 'fixed'; readonly scale: number }

/** Default preference for a newly opened PDF. */
export const FIT_WIDTH: ZoomPreference = { kind: 'fit-width' }

/** A wheel/pinch gesture commits its scale after this quiet window. */
export const PINCH_SETTLE_MS = 120
/** Floating controls hide this long after the pointer leaves the reveal zone. */
export const CONTROLS_HIDE_MS = 420
/** Pointer entering this band above the frame's bottom edge reveals the controls. */
export const CONTROLS_REVEAL_HEIGHT_PX = 72

/** Shrink-only fit: a page narrower than the viewport stays at actual size. */
export function fitWidthZoom(
  viewportWidth: number,
  intrinsicWidth: number | undefined,
  horizontalInset = 0,
): number {
  if (intrinsicWidth === undefined || intrinsicWidth <= 0) return 1
  return Math.min(1, Math.max(1, viewportWidth - horizontalInset) / intrinsicWidth)
}

export function clampZoom(zoom: number): number {
  return Math.min(PDF_ZOOM.maximum, Math.max(PDF_ZOOM.minimum, zoom))
}

/** Next 25% boundary outward from the current scale (gesture values included). */
export function steppedZoom(zoom: number, direction: -1 | 1): number {
  const step = direction === -1 ? Math.ceil(zoom / PDF_ZOOM.step) - 1 : Math.floor(zoom / PDF_ZOOM.step) + 1
  return clampZoom(step * PDF_ZOOM.step)
}

/** Wheel delta in pixels: line mode is 16px/line, page mode one viewport, clamped ±40. */
export function wheelZoomDelta(deltaY: number, deltaMode: number, pageHeight: number): number {
  const unit =
    deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : deltaMode === WheelEvent.DOM_DELTA_PAGE ? pageHeight : 1
  return Math.max(-40, Math.min(40, deltaY * unit))
}

/** Exponential gesture step — equal wheel deltas give equal scale ratios. */
export function gestureZoom(current: number, delta: number): number {
  return current * Math.exp(-delta * 0.01)
}

/** Scroll offset keeping the point at `offset` from the scrollport edge fixed. */
export function anchoredScroll(scroll: number, offset: number, ratio: number): number {
  return (scroll + offset) * ratio - offset
}

interface SurfaceAnchor {
  readonly surface: HTMLElement
  readonly x: number
  readonly y: number
  readonly clientX: number
  readonly clientY: number
}

/** The zoom surface under the pointer, if any (pages mark their surface). */
function surfaceAnchor(clientX: number, clientY: number): SurfaceAnchor | undefined {
  const hit = document.elementFromPoint(clientX, clientY)
  const surface = hit instanceof Element ? hit.closest<HTMLElement>('[data-pdf-zoom-surface]') : null
  if (surface === null) return undefined
  const bounds = surface.getBoundingClientRect()
  return { surface, x: clientX - bounds.left, y: clientY - bounds.top, clientX, clientY }
}

/**
 * Apply a fixed zoom to the scrollport, anchored at the pointer (or its center),
 * with scroll compensation. Writes `--pdf-zoom` + `data-pdf-zoom-mode` FIRST so
 * the CSS width rules resize the surfaces synchronously, then measures the
 * pointed surface's new geometry to keep the pointed content point stationary.
 * @param node - the `.pdf-body` scroll container.
 * @param previous - the live scale before this step.
 * @param next - requested scale (clamped to the fixed range).
 * @param clientX - pointer x; omitted anchors at the scrollport center.
 * @param clientY - pointer y; omitted anchors at the scrollport center.
 * @returns the applied scale (unchanged when the request clamps to `previous`).
 */
export function applyAnchoredZoom(
  node: HTMLElement,
  previous: number,
  next: number,
  clientX?: number,
  clientY?: number,
): number {
  next = clampZoom(next)
  if (next === previous) return previous
  const bounds = node.getBoundingClientRect()
  const x = clientX === undefined ? node.clientWidth / 2 : clientX - bounds.left
  const y = clientY === undefined ? node.clientHeight / 2 : clientY - bounds.top
  const anchor = surfaceAnchor(bounds.left + x, bounds.top + y)
  const previousScrollLeft = node.scrollLeft
  const previousScrollTop = node.scrollTop
  const ratio = next / previous
  node.setAttribute('data-pdf-zoom-mode', 'fixed')
  node.style.setProperty('--pdf-zoom', String(next))
  if (anchor === undefined) {
    node.scrollLeft = anchoredScroll(previousScrollLeft, x, ratio)
    node.scrollTop = anchoredScroll(previousScrollTop, y, ratio)
  } else {
    // The surface's pointed point moved with the synchronous resize; scroll by
    // exactly its displacement so it lands back under the pointer.
    const nextBounds = anchor.surface.getBoundingClientRect()
    node.scrollLeft += nextBounds.left + anchor.x * ratio - anchor.clientX
    node.scrollTop += nextBounds.top + anchor.y * ratio - anchor.clientY
  }
  return next
}
