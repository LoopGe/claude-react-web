// Pure zoom/pan math for the Lightbox image viewer (src/components/Lightbox.tsx).
//
// Display model: the <img> is laid out at its FIT size (fitSize) and then moved
// with `transform: translate(tx, ty) scale(s)`. The stage is the viewport-sized
// box the image lives in; all coordinates passed in here are stage-relative.
// Keeping this DOM-free lets the rules live in node-env tests
// (src/utils/image-zoom-math.test.ts) — happy-dom's getBoundingClientRect is
// always zeroed, so geometry arrives as plain numbers by design.

export interface ZoomState {
  scale: number
  tx: number
  ty: number
}

/** Never display smaller than the fit size. */
export const MIN_SCALE = 1
/** Cap when the image is at (or below) its natural size at fit. */
const DEFAULT_MAX_SCALE = 2.5

/** Contain-fit (nw, nh) into a (vw, vh) stage without upscaling: an image
 *  smaller than the stage shows at its natural pixel size. */
export function fitSize(nw: number, nh: number, vw: number, vh: number): { w: number; h: number } {
  const factor = Math.min(vw / nw, vh / nh, 1)
  return { w: nw * factor, h: nh * factor }
}

/** Upper zoom bound: DEFAULT_MAX_SCALE, raised so 1:1 natural size is always
 *  reachable for images the fit step downscaled. */
export function maxScale(nw: number, nh: number, vw: number, vh: number): number {
  const { w } = fitSize(nw, nh, vw, vh)
  return Math.max(DEFAULT_MAX_SCALE, nw / w, MIN_SCALE)
}

/** Scale by `factor` keeping the stage point (px, py) visually fixed.
 *  The resulting scale is clamped to [MIN_SCALE, max]; the clamp re-anchors
 *  the translate so the zoom never jumps. */
export function zoomAt(state: ZoomState, factor: number, px: number, py: number, max: number): ZoomState {
  const scale = Math.min(Math.max(state.scale * factor, MIN_SCALE), Math.max(max, MIN_SCALE))
  const ratio = scale / state.scale
  return {
    scale,
    tx: px - (px - state.tx) * ratio,
    ty: py - (py - state.ty) * ratio,
  }
}

/** Clamp the translate so the scaled image never leaves the stage: flush to an
 *  edge when larger, centered when smaller. */
export function clampTranslate(state: ZoomState, w: number, h: number, vw: number, vh: number): ZoomState {
  const clampAxis = (size: number, view: number, t: number): number => {
    const slack = view - size * state.scale // negative when the image overflows
    if (slack >= 0) return slack / 2
    return Math.min(Math.max(t, slack), 0)
  }
  return {
    scale: state.scale,
    tx: clampAxis(w, vw, state.tx),
    ty: clampAxis(h, vh, state.ty),
  }
}

/** Double-click toggle: from fit go to 1:1 natural size anchored at the
 *  pointer; from 1:1 or beyond go back to the centered fit state. */
export function toggleActualSize(
  state: ZoomState,
  naturalWidth: number,
  fitWidth: number,
  px: number,
  py: number,
  max: number,
): ZoomState {
  const actual = naturalWidth / fitWidth
  if (state.scale < actual - 1e-9) {
    return zoomAt(state, actual / state.scale, px, py, max)
  }
  return { scale: MIN_SCALE, tx: 0, ty: 0 }
}
