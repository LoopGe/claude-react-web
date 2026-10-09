// Pure zoom/pan math for the Lightbox image viewer. Runs in node (no DOM):
// the geometry is passed in as plain numbers so every rule is assertable
// without faking getBoundingClientRect (happy-dom returns zeros for it).
//
// Display model: the <img> is laid out at its FIT size (fitSize) and then
// moved with `transform: translate(tx, ty) scale(s)`. The stage is the
// viewport-sized box the image lives in. All coordinates are stage-relative.

import { describe, it, expect } from 'vitest'
import { fitSize, maxScale, zoomAt, clampTranslate, toggleActualSize, MIN_SCALE } from './image-zoom-math'

const FIT_STATE = { scale: 1, tx: 0, ty: 0 } as const

describe('fitSize (contain fit, no upscale)', () => {
  it('fits a landscape image by width', () => {
    // 2000x1000 into a 500x500 stage → width-limited.
    expect(fitSize(2000, 1000, 500, 500)).toEqual({ w: 500, h: 250 })
  })

  it('fits a portrait image by height', () => {
    expect(fitSize(1000, 2000, 500, 500)).toEqual({ w: 250, h: 500 })
  })

  it('returns natural size when the image is smaller than the stage', () => {
    expect(fitSize(300, 200, 500, 500)).toEqual({ w: 300, h: 200 })
  })

  it('uses all the space it can within the stage', () => {
    expect(fitSize(4000, 1000, 800, 400)).toEqual({ w: 800, h: 200 })
  })
})

describe('maxScale', () => {
  it('is at least the zoom-out-of-fit cap (2.5)', () => {
    // 500x500 image in a 500x500 stage: fit == natural, so 1:1 is scale 1.
    expect(maxScale(500, 500, 500, 500)).toBe(2.5)
  })

  it('reaches at least 1:1 for downscaled images', () => {
    // 2000x1000 fit into 500 wide → 1:1 needs scale 4.
    expect(maxScale(2000, 1000, 500, 500)).toBe(4)
  })

  it('never goes below MIN_SCALE', () => {
    expect(maxScale(1, 1, 500, 500)).toBeGreaterThanOrEqual(MIN_SCALE)
  })
})

describe('zoomAt (anchored at a stage-relative point)', () => {
  it('keeps the anchor point visually fixed when zooming in', () => {
    // Image 100 wide at scale 1, tx 0. Pointer at stage x=75.
    // Zoom 2x: scale 2, the anchor must still map to stage x=75:
    // tx' = px - (px - tx) * (s'/s) = 75 - 75*2 = -75.
    const next = zoomAt(FIT_STATE, 2, 75, 50, 8)
    expect(next.scale).toBe(2)
    expect(next.tx).toBe(-75)
    expect(next.ty).toBe(-50)
  })

  it('zooming out reverses the same anchor math', () => {
    const zoomed = { scale: 2, tx: -75, ty: -50 }
    const next = zoomAt(zoomed, 0.5, 75, 50, 8)
    expect(next.scale).toBe(1)
    expect(next.tx).toBe(0)
    expect(next.ty).toBe(0)
  })

  it('clamps to MIN_SCALE when zooming out past fit', () => {
    const next = zoomAt({ scale: 1.2, tx: -10, ty: -10 }, 0.1, 100, 100, 8)
    expect(next.scale).toBe(MIN_SCALE)
    // Clamping the scale re-anchors too: tx' = px - (px - tx) * (1/1.2).
    expect(next.tx).toBeCloseTo(100 - 110 / 1.2, 10)
  })

  it('clamps to the max scale', () => {
    const next = zoomAt({ scale: 7.5, tx: 0, ty: 0 }, 2, 50, 50, 8)
    expect(next.scale).toBe(8)
  })
})

describe('clampTranslate (image may not leave the stage)', () => {
  it('clamps to the edges when the scaled image is larger than the stage', () => {
    // 100x100 image at scale 3 → 300x300 in a 200x200 stage.
    const clamped = clampTranslate({ scale: 3, tx: 40, ty: -250 }, 100, 100, 200, 200)
    expect(clamped.tx).toBe(0) // right edge flush
    expect(clamped.ty).toBe(-100) // bottom edge flush
  })

  it('centers the image when the scaled image is smaller than the stage', () => {
    // 100x100 at scale 1.5 → 150x150 in 200x200 → centered at 25.
    const clamped = clampTranslate({ scale: 1.5, tx: 60, ty: 60 }, 100, 100, 200, 200)
    expect(clamped.tx).toBe(25)
    expect(clamped.ty).toBe(25)
  })

  it('normalizes to flush when the image exactly fills the stage', () => {
    // 100x100 at scale 2 == the 200x200 stage exactly: the only translation
    // that still covers the stage is (0, 0) — tx=-100 would bare the right edge.
    const clamped = clampTranslate({ scale: 2, tx: -100, ty: -100 }, 100, 100, 200, 200)
    expect(clamped.tx).toBe(0)
    expect(clamped.ty).toBe(0)
  })
})

describe('toggleActualSize (double-click: fit ↔ 1:1)', () => {
  it('zooms from fit to 1:1 anchored at the pointer', () => {
    // 2000x1000 fit into 500x250 → 1:1 = scale 4. Pointer at (100, 50).
    const next = toggleActualSize(FIT_STATE, 2000, 500, 100, 50, 8)
    expect(next.scale).toBe(4)
    expect(next.tx).toBe(100 - 100 * 4) // anchor preserved
    expect(next.ty).toBe(50 - 50 * 4)
  })

  it('returns to fit when already at (or past) 1:1', () => {
    // Already at scale 4 == 1:1 → back to the fit state.
    expect(toggleActualSize({ scale: 4, tx: -300, ty: -150 }, 2000, 500, 100, 50, 8)).toEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    })
    // Past 1:1 (8 > 4) also goes back to fit.
    expect(toggleActualSize({ scale: 8, tx: -300, ty: -150 }, 2000, 500, 100, 50, 8)).toEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    })
  })
})
