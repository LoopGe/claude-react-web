// @vitest-environment happy-dom
/** Zoom math + pointer-anchored scroll compensation (DSH ZoomViewport parity). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PDF_ZOOM,
  anchoredScroll,
  applyAnchoredZoom,
  clampZoom,
  fitWidthZoom,
  gestureZoom,
  steppedZoom,
  wheelZoomDelta,
} from './pdf-zoom'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('fitWidthZoom', () => {
  it('shrinks a page wider than the viewport, inset excluded', () => {
    expect(fitWidthZoom(124, 200, 24)).toBeCloseTo(0.5)
    expect(fitWidthZoom(60, 100, 24)).toBeCloseTo(0.36)
  })

  it('never enlarges: a narrower page stays at actual size', () => {
    expect(fitWidthZoom(500, 100, 24)).toBe(1)
    expect(fitWidthZoom(124, 100, 24)).toBe(1)
  })

  it('defaults to actual size without a measured intrinsic width', () => {
    expect(fitWidthZoom(500, undefined)).toBe(1)
    expect(fitWidthZoom(500, 0)).toBe(1)
  })
})

describe('preset and step math', () => {
  it('pins the fixed range, step, and presets', () => {
    expect(PDF_ZOOM.minimum).toBe(0.25)
    expect(PDF_ZOOM.maximum).toBe(4)
    expect(PDF_ZOOM.step).toBe(0.25)
    expect([...PDF_ZOOM.presets]).toEqual([0.25, 0.5, 1, 1.5, 2])
  })

  it('clamps to the fixed range', () => {
    expect(clampZoom(0.1)).toBe(0.25)
    expect(clampZoom(9)).toBe(4)
    expect(clampZoom(1.37)).toBe(1.37)
  })

  it('steps to the next 25% boundary in each direction', () => {
    expect(steppedZoom(1, 1)).toBe(1.25)
    expect(steppedZoom(1, -1)).toBe(0.75)
    // A gesture value between steps lands on the nearest boundary OUTWARD.
    expect(steppedZoom(1.37, 1)).toBe(1.5)
    expect(steppedZoom(1.37, -1)).toBe(1.25)
    expect(steppedZoom(0.3, 1)).toBe(0.5)
    expect(steppedZoom(0.3, -1)).toBe(0.25)
  })

  it('stops stepping at the range bounds', () => {
    expect(steppedZoom(0.25, -1)).toBe(0.25)
    expect(steppedZoom(4, 1)).toBe(4)
    expect(steppedZoom(3.9, 1)).toBe(4)
  })
})

describe('wheel gesture math', () => {
  it('passes pixel deltas through, clamped to ±40', () => {
    expect(wheelZoomDelta(-12, WheelEvent.DOM_DELTA_PIXEL, 600)).toBe(-12)
    expect(wheelZoomDelta(-500, WheelEvent.DOM_DELTA_PIXEL, 600)).toBe(-40)
    expect(wheelZoomDelta(500, WheelEvent.DOM_DELTA_PIXEL, 600)).toBe(40)
  })

  it('converts line and page delta modes to pixels, then clamps', () => {
    expect(wheelZoomDelta(-2, WheelEvent.DOM_DELTA_LINE, 600)).toBe(-32)
    expect(wheelZoomDelta(-0.05, WheelEvent.DOM_DELTA_PAGE, 600)).toBe(-30)
    expect(wheelZoomDelta(-3, WheelEvent.DOM_DELTA_LINE, 600)).toBe(-40)
    expect(wheelZoomDelta(-1, WheelEvent.DOM_DELTA_PAGE, 600)).toBe(-40)
  })

  it('scales exponentially with the clamped delta', () => {
    expect(gestureZoom(1, -40)).toBeCloseTo(Math.exp(0.4))
    expect(gestureZoom(2, 40)).toBeCloseTo(2 * Math.exp(-0.4))
    expect(gestureZoom(1, 0)).toBe(1)
  })
})

describe('anchoredScroll', () => {
  it('keeps the anchored offset fixed across the scale ratio', () => {
    expect(anchoredScroll(10, 50, 2)).toBe(70)
    expect(anchoredScroll(0, 100, 0.5)).toBe(-50)
    expect(anchoredScroll(30, 0, 3)).toBe(90)
  })
})

describe('applyAnchoredZoom', () => {
  function scrollport(): HTMLDivElement {
    const node = document.createElement('div')
    document.body.append(node)
    Object.defineProperty(node, 'clientWidth', { value: 200, configurable: true })
    Object.defineProperty(node, 'clientHeight', { value: 100, configurable: true })
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0 } as DOMRect)
    return node
  }

  function surfaceIn(node: HTMLElement): HTMLDivElement {
    const surface = document.createElement('div')
    surface.setAttribute('data-pdf-zoom-surface', '')
    node.append(surface)
    return surface
  }

  it('is a no-op at the unchanged scale', () => {
    const node = scrollport()
    expect(applyAnchoredZoom(node, 1, 1)).toBe(1)
    expect(node.getAttribute('data-pdf-zoom-mode')).toBeNull()
    expect(node.style.getPropertyValue('--pdf-zoom')).toBe('')
  })

  it('clamps the requested scale to the fixed range', () => {
    const node = scrollport()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    expect(applyAnchoredZoom(node, 2, 10)).toBe(4)
    expect(node.style.getPropertyValue('--pdf-zoom')).toBe('4')
    expect(applyAnchoredZoom(node, 0.5, 0.01)).toBe(0.25)
  })

  it('applies fixed mode and compensates scroll around the viewport center without a pointer', () => {
    const node = scrollport()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    node.scrollLeft = 10
    node.scrollTop = 20
    expect(applyAnchoredZoom(node, 1, 2)).toBe(2)
    expect(node.getAttribute('data-pdf-zoom-mode')).toBe('fixed')
    expect(node.style.getPropertyValue('--pdf-zoom')).toBe('2')
    // Center anchor: x = 100, y = 50 → (scroll + offset) * ratio - offset.
    expect(node.scrollLeft).toBe((10 + 100) * 2 - 100)
    expect(node.scrollTop).toBe((20 + 50) * 2 - 50)
  })

  it('compensates around the pointer when no zoom surface is under it', () => {
    const node = scrollport()
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20 } as DOMRect)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    node.scrollLeft = 5
    node.scrollTop = 7
    applyAnchoredZoom(node, 1, 2, 60, 70)
    // Pointer offset inside the scrollport: x = 50, y = 50.
    expect(node.scrollLeft).toBe((5 + 50) * 2 - 50)
    expect(node.scrollTop).toBe((7 + 50) * 2 - 50)
  })

  it('anchors on the measured surface when the pointer is over a page', () => {
    const node = scrollport()
    const surface = surfaceIn(node)
    const child = document.createElement('span')
    surface.append(child)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(child)
    const rects = vi.spyOn(surface, 'getBoundingClientRect')
    rects.mockReturnValueOnce({ left: 100, top: 40 } as DOMRect)
    rects.mockReturnValueOnce({ left: 80, top: 30 } as DOMRect)
    node.scrollLeft = 0
    node.scrollTop = 0
    applyAnchoredZoom(node, 1, 2, 150, 90)
    // The pointed surface point (offset 50,50) must stay under (150,90):
    // scroll += nextBounds.origin + offset * ratio - pointer.
    expect(node.scrollLeft).toBe(80 + 50 * 2 - 150)
    expect(node.scrollTop).toBe(30 + 50 * 2 - 90)
    expect(rects).toHaveBeenCalledTimes(2)
  })
})
