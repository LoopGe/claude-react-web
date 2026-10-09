// Tests for the Lightbox UI: toolbar zoom controls, double-click actual-size
// toggle, wheel zoom, multi-image navigation, Escape/empty-area close, and the
// broken-image fallback.
//
// happy-dom does not decode images (naturalWidth stays 0), so tests simulate
// the browser's load step: define naturalWidth/naturalHeight on the element
// and fireEvent.load it — exactly what the browser does natively before
// onLoad fires.

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, fireEvent } from '@testing-library/react'
import { ImageViewerProvider, useImageViewer } from '../hooks/useImageViewer'

// Exit-presence reads matchMedia (reduced motion) at close time; happy-dom's
// implementation is fine but the stub keeps the animated-exit path
// deterministic, matching Overlay.test.tsx. (Cleanup is global — see
// src/test-setup.ts; don't re-add per-file afterEach(cleanup).)
vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))

function setup(images: Parameters<ReturnType<typeof useImageViewer>['openViewer']>[0], index = 0) {
  const { result } = renderHook(() => useImageViewer(), { wrapper: ImageViewerProvider })
  act(() => result.current.openViewer(images, index))
  return result
}

/** Simulate the browser finishing the image decode for the current img.
 *  configurable: React reuses the same <img> DOM node across src changes, so
 *  a later test step may need to redefine the properties on the same node. */
function loadCurrent(width = 2000, height = 1000) {
  const img = document.body.querySelector('img.lightbox-img') as HTMLImageElement
  expect(img).not.toBeNull()
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true })
  fireEvent.load(img)
}

describe('Lightbox', () => {
  // happy-dom actually decodes data-URL PNGs: an invalid payload fires load
  // with naturalWidth=0 (which the Lightbox treats as a failure), so every
  // fixture must be a real decodable image. Distinct srcs come from fragments.
  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const srcA = `${PNG_1PX}#a`
  const srcB = `${PNG_1PX}#b`
  const single = [{ src: srcA, alt: 'one' }]
  const pair = [
    { src: srcA, alt: 'one' },
    { src: srcB, alt: 'two' },
  ]

  it('renders the current image with the download link pointing at it', () => {
    setup(pair, 1)
    const img = document.body.querySelector('img.lightbox-img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(srcB)
    expect(img.getAttribute('alt')).toBe('two')
    const dl = document.body.querySelector('a.lightbox-download') as HTMLAnchorElement
    expect(dl.getAttribute('href')).toBe(srcB)
    expect(dl.hasAttribute('download')).toBe(true)
  })

  it('zoom-in/out buttons move the transform; zoom-out is disabled at fit', () => {
    setup(single)
    loadCurrent()
    const zoomIn = document.body.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement
    const zoomOut = document.body.querySelector('[aria-label="Zoom out"]') as HTMLButtonElement
    expect((zoomOut as HTMLButtonElement).disabled).toBe(true) // scale 1 = fit, nothing to zoom out from
    act(() => fireEvent.click(zoomIn))
    const img = document.body.querySelector('img.lightbox-img') as HTMLElement
    expect(img.style.transform).toContain('scale(1.25)')
    expect((zoomOut as HTMLButtonElement).disabled).toBe(false)
    act(() => fireEvent.click(zoomOut))
    expect(img.style.transform).toContain('scale(1)')
    expect((zoomOut as HTMLButtonElement).disabled).toBe(true)
  })

  it('reset button returns to the fit state', () => {
    setup(single)
    loadCurrent()
    act(() => fireEvent.click(document.body.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement))
    act(() => fireEvent.click(document.body.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement))
    const img = document.body.querySelector('img.lightbox-img') as HTMLElement
    expect(img.style.transform).not.toContain('scale(1)')
    act(() => fireEvent.click(document.body.querySelector('[aria-label="Reset zoom"]') as HTMLButtonElement))
    expect(img.style.transform).toContain('scale(1)')
  })

  it('double-click toggles actual size (1:1) and back', () => {
    setup(single)
    loadCurrent()
    const img = document.body.querySelector('img.lightbox-img') as HTMLElement
    // 2000 natural fit into 1024 → 1:1 = scale 2000/1024 = 1.953125.
    fireEvent.doubleClick(img, { clientX: 100, clientY: 100 })
    expect(img.style.transform).toContain('scale(1.953125)')
    fireEvent.doubleClick(img, { clientX: 100, clientY: 100 })
    expect(img.style.transform).toContain('scale(1)')
  })

  it('wheel zooms in and out (native non-passive listener)', () => {
    setup(single)
    loadCurrent()
    const stage = document.body.querySelector('.lightbox-stage') as HTMLElement
    // happy-dom's WheelEvent constructor does not apply clientX/clientY from
    // the init object (deltaY only), so build a MouseEvent (whose coords do
    // apply) and inject deltaY — the listener reads exactly these three.
    const wheel = (deltaY: number) => {
      const ev = new MouseEvent('wheel', { clientX: 512, clientY: 384, bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'deltaY', { value: deltaY })
      act(() => stage.dispatchEvent(ev))
    }
    wheel(-100)
    const img = document.body.querySelector('img.lightbox-img') as HTMLElement
    expect(img.style.transform).toContain('scale(1.25)')
    wheel(100)
    expect(img.style.transform).toContain('scale(1)')
  })

  it('shows prev/next controls for multi-image groups and wraps around', () => {
    setup(pair)
    expect(document.body.querySelector('.lightbox-nav-prev')).not.toBeNull()
    expect(document.body.querySelector('.lightbox-nav-next')).not.toBeNull()
    act(() => fireEvent.click(document.body.querySelector('.lightbox-nav-next') as HTMLButtonElement))
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcB)
    act(() => fireEvent.click(document.body.querySelector('.lightbox-nav-next') as HTMLButtonElement))
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcA)
    act(() => fireEvent.click(document.body.querySelector('.lightbox-nav-prev') as HTMLButtonElement))
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcB)
  })

  it('single-image groups render no navigation chrome', () => {
    setup(single)
    expect(document.body.querySelector('.lightbox-nav-prev')).toBeNull()
    expect(document.body.querySelector('.lightbox-nav-next')).toBeNull()
  })

  it('ArrowLeft/ArrowRight navigate multi-image groups', () => {
    setup(pair)
    fireEvent.keyDown(document.body.querySelector('.lightbox-stage') as HTMLElement, { key: 'ArrowRight' })
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcB)
    fireEvent.keyDown(document.body.querySelector('.lightbox-stage') as HTMLElement, { key: 'ArrowLeft' })
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcA)
  })

  it('Escape closes via the overlay escape stack', () => {
    setup(single)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.body.querySelector('.lightbox-overlay')?.getAttribute('data-state')).toBe('closing')
  })

  it('mousedown on the empty stage area closes (the image itself does not)', () => {
    setup(single)
    const stage = document.body.querySelector('.lightbox-stage') as HTMLElement
    fireEvent.mouseDown(stage) // target === currentTarget → empty area
    expect(document.body.querySelector('.lightbox-overlay')?.getAttribute('data-state')).toBe('closing')
  })

  it('shows an error placeholder when the image fails to load', () => {
    setup(single)
    const img = document.body.querySelector('img.lightbox-img') as HTMLImageElement
    fireEvent.error(img)
    expect(document.body.querySelector('img.lightbox-img')).toBeNull()
    const err = document.body.querySelector('.lightbox-error')
    expect(err).not.toBeNull()
    expect(err?.textContent).toBeTruthy()
  })

  it('treats a zero-natural-size load (dimensionless SVG) as a failure, not a blank stage', () => {
    setup(single)
    loadCurrent(0, 0)
    expect(document.body.querySelector('img.lightbox-img')).toBeNull()
    expect(document.body.querySelector('.lightbox-error')).not.toBeNull()
  })

  it('ignores pointerdowns that start on toolbar/nav chrome (pan must not capture button clicks)', () => {
    setup(single)
    loadCurrent()
    act(() => fireEvent.click(document.body.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement))
    const img = document.body.querySelector('img.lightbox-img') as HTMLElement
    const before = img.style.transform
    // Press ON the button, then drag: a pan capture here would also retarget
    // the browser's click at the stage, killing the button's onClick.
    fireEvent.pointerDown(document.body.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement, { pointerId: 1, clientX: 900, clientY: 30 })
    fireEvent.pointerMove(document.body.querySelector('.lightbox-stage') as HTMLElement, { pointerId: 1, clientX: 960, clientY: 60 })
    expect(img.style.transform).toBe(before)
    // The button still works afterwards (click not swallowed by a capture).
    act(() => fireEvent.click(document.body.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement))
    expect(img.style.transform).toContain('scale(1.5625)')
  })

  it('navigates with arrow keys via the document listener (works before any tab focus)', () => {
    setup(pair)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcB)
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcA)
  })

  it('keeps the img styled while the next image loads (no intrinsic-size flash)', () => {
    setup(pair)
    loadCurrent(2000, 1000) // fit 1024x512
    act(() => fireEvent.click(document.body.querySelector('.lightbox-nav-next') as HTMLButtonElement))
    const img = document.body.querySelector('img.lightbox-img') as HTMLElement
    expect(img.getAttribute('src')).toBe(srcB)
    // Invariant: from the moment any natural size is known, the img is ALWAYS
    // rendered with an explicit fit style — the src change alone must never
    // drop it back to unstyled intrinsic size (the top-left flash).
    // (happy-dom's own decode of the fixture may land before or after this
    // assertion; either way a style must be present.)
    expect(img.style.width).toMatch(/^\d+(\.\d+)?px$/)
    expect(img.style.transform).not.toBe('')
    // New image finishes loading with different dimensions → re-fit:
    // 1000x1000 into the 1024x768 stage is height-limited → 768x768.
    Object.defineProperty(img, 'naturalWidth', { value: 1000, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 1000, configurable: true })
    fireEvent.load(img)
    expect(img.style.width).toBe('768px')
  })

  it('opens the download link safely for cross-origin images (new tab, never a same-tab navigation)', () => {
    setup(single)
    const dl = document.body.querySelector('a.lightbox-download') as HTMLAnchorElement
    expect(dl.getAttribute('target')).toBe('_blank')
    expect(dl.getAttribute('rel')).toContain('noopener')
  })

  it('ignores modified arrows (browser back/forward own Alt+arrows)', () => {
    setup(pair)
    fireEvent.keyDown(document.body, { key: 'ArrowRight', altKey: true })
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcA)
  })

  it('ignores arrows from editable targets (text fields keep cursor movement)', () => {
    setup(pair)
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    fireEvent.keyDown(ta, { key: 'ArrowRight' })
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcA)
    ta.remove()
  })

  it('detaches the arrow listener during the exit animation (closed viewer owns no keys)', () => {
    const result = setup(pair)
    act(() => result.current.close())
    expect(document.body.querySelector('.lightbox-overlay')?.getAttribute('data-state')).toBe('closing')
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    // Still showing the first image — no navigation happened while closing.
    expect((document.body.querySelector('img.lightbox-img') as HTMLImageElement).getAttribute('src')).toBe(srcA)
  })

  it('disables zoom/pan chrome while an error card shows (stale geometry must not stay live)', () => {
    setup(pair)
    loadCurrent(2000, 1000)
    // Navigate to a broken image (load fires with naturalWidth=0 → failure).
    act(() => fireEvent.click(document.body.querySelector('.lightbox-nav-next') as HTMLButtonElement))
    const img = document.body.querySelector('img.lightbox-img') as HTMLImageElement
    Object.defineProperty(img, 'naturalWidth', { value: 0, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 0, configurable: true })
    fireEvent.load(img)
    expect(document.body.querySelector('.lightbox-error')).not.toBeNull()
    expect((document.body.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement).disabled).toBe(true)
    expect((document.body.querySelector('[aria-label="Reset zoom"]') as HTMLButtonElement).disabled).toBe(true)
    // Navigating back to the good image restores the chrome with its geometry.
    act(() => fireEvent.click(document.body.querySelector('.lightbox-nav-prev') as HTMLButtonElement))
    expect((document.body.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('wheel never scrolls the page behind the lightbox (preventDefault even before decode)', () => {
    setup(single)
    const stage = document.body.querySelector('.lightbox-stage') as HTMLElement
    const ev = new MouseEvent('wheel', { clientX: 512, clientY: 384, bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'deltaY', { value: -100 })
    stage.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    // …and no zoom lands without a decoded image.
    const img = document.body.querySelector('img.lightbox-img') as HTMLElement
    expect(img.style.transform).not.toContain('scale(1.25)')
  })

  it('ignores pointerdowns on toolbar padding and the error card (not just buttons)', () => {
    setup(single)
    loadCurrent()
    act(() => fireEvent.click(document.body.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement))
    const img = document.body.querySelector('img.lightbox-img') as HTMLElement
    const before = img.style.transform
    fireEvent.pointerDown(document.body.querySelector('.lightbox-toolbar') as HTMLElement, { pointerId: 1, clientX: 880, clientY: 30 })
    fireEvent.pointerMove(document.body.querySelector('.lightbox-stage') as HTMLElement, { pointerId: 1, clientX: 940, clientY: 60 })
    expect(img.style.transform).toBe(before)
  })
})
