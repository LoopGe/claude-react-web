// Tests for the Lightbox zoom/pan hook. Runs in happy-dom: the stage is a
// fixed inset:0 surface, so the hook reads window.innerWidth/innerHeight for
// geometry — setViewport() controls it without faking getBoundingClientRect.
//
// Display model (must match src/utils/image-zoom-math.ts): the <img> sits
// absolutely at the stage's top-left with transform-origin 0 0 and
// `transform: translate(tx, ty) scale(s)`. "Centered" therefore means
// tx = (stageW - fitW) / 2.

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { useImageZoom } from './useImageZoom'

function setViewport(w: number, h: number) {
  const hd = (window as unknown as { happyDOM?: { setViewport?: (v: { width: number; height: number }) => void } }).happyDOM
  if (hd?.setViewport) hd.setViewport({ width: w, height: h })
  else {
    ;(window as unknown as { innerWidth: number; innerHeight: number }).innerWidth = w
    ;(window as unknown as { innerHeight: number; innerWidth: number }).innerHeight = h
  }
}

describe('useImageZoom', () => {
  it('starts centered at the fit size', () => {
    setViewport(500, 500)
    // 2000x1000 fits 500x500 → 500x250, centered → tx 0, ty (500-250)/2 = 125.
    const { result } = renderHook(() => useImageZoom({ naturalWidth: 2000, naturalHeight: 1000 }))
    expect(result.current.fit).toEqual({ w: 500, h: 250 })
    expect(result.current.state).toEqual({ scale: 1, tx: 0, ty: 125 })
    expect(result.current.max).toBe(4) // 1:1 for a 2000-wide image at 500 fit
  })

  it('zoomStep scales anchored at the stage center and clamps', () => {
    setViewport(500, 500)
    const { result } = renderHook(() => useImageZoom({ naturalWidth: 2000, naturalHeight: 1000 }))
    act(() => result.current.zoomStep(2))
    // Center anchor (250, 250): tx' = 250 - (250 - 0) * 2 = -250; ty' = 250 - (250 - 125) * 2 = 0.
    expect(result.current.state).toEqual({ scale: 2, tx: -250, ty: 0 })
  })

  it('zoomStep cannot exceed max', () => {
    setViewport(500, 500)
    const { result } = renderHook(() => useImageZoom({ naturalWidth: 2000, naturalHeight: 1000 }))
    act(() => {
      result.current.zoomStep(8)
      result.current.zoomStep(8)
    })
    expect(result.current.state.scale).toBe(4)
  })

  it('zoomAtPoint zooms around an arbitrary stage point', () => {
    setViewport(500, 500)
    const { result } = renderHook(() => useImageZoom({ naturalWidth: 2000, naturalHeight: 1000 }))
    act(() => result.current.zoomAtPoint(2, 100, 100))
    // tx' = 100 - (100 - 0) * 2 = -100 (in range [-500, 0]).
    // ty' = 100 - (100 - 125) * 2 = 150, but the scaled image (250*2 = 500)
    // exactly fills the 500 stage → clampTranslate normalizes to flush → 0.
    expect(result.current.state).toEqual({ scale: 2, tx: -100, ty: 0 })
  })

  it('drag pans within the clamp', () => {
    setViewport(500, 500)
    const { result } = renderHook(() => useImageZoom({ naturalWidth: 2000, naturalHeight: 1000 }))
    // At fit the image (500x250) is smaller than the stage vertically — the
    // clamp re-centers it, so panning only applies once zoomed in.
    act(() => result.current.zoomStep(2)) // { scale: 2, tx: -250, ty: 0 }
    const el = document.createElement('div')
    act(() => result.current.handlers.onPointerDown({ pointerId: 1, clientX: 200, clientY: 200 } as PointerEvent, el))
    act(() => result.current.handlers.onPointerMove({ pointerId: 1, clientX: 230, clientY: 180 } as PointerEvent))
    // tx: -250 + 30 = -220 (in range [-500, 0]). ty: 0 - 20 = -20 → clamped to
    // 0 (the scaled image exactly fills the stage vertically).
    expect(result.current.state.tx).toBe(-220)
    expect(result.current.state.ty).toBe(0)
    act(() => result.current.handlers.onPointerUp({ pointerId: 1 } as PointerEvent))
    act(() => result.current.handlers.onPointerMove({ pointerId: 1, clientX: 400, clientY: 400 } as PointerEvent))
    // After pointerup the drag is over — a stray move must not pan.
    expect(result.current.state.tx).toBe(-220)
  })

  it('reset returns to the centered fit', () => {
    setViewport(500, 500)
    const { result } = renderHook(() => useImageZoom({ naturalWidth: 2000, naturalHeight: 1000 }))
    act(() => result.current.zoomStep(2))
    act(() => result.current.reset())
    expect(result.current.state).toEqual({ scale: 1, tx: 0, ty: 125 })
  })

  it('resets when the image changes (next/prev)', () => {
    setViewport(500, 500)
    const { result, rerender } = renderHook(({ w, h }: { w: number; h: number }) => useImageZoom({ naturalWidth: w, naturalHeight: h }), {
      initialProps: { w: 2000, h: 1000 },
    })
    act(() => result.current.zoomStep(2))
    // Switch to a 1000x1000 image → fit 500x500, centered at (0, 0), max 2.5.
    rerender({ w: 1000, h: 1000 })
    expect(result.current.state).toEqual({ scale: 1, tx: 0, ty: 0 })
    expect(result.current.max).toBe(2.5)
  })

  it('resets even when the new image has the SAME fit size (resetKey must not alias)', () => {
    setViewport(500, 500)
    // 1000x750 and 2000x1500 both fit to exactly 500x375 in a 500x500 stage.
    const { result, rerender } = renderHook(
      ({ w, h, key }: { w: number; h: number; key: string }) => useImageZoom({ naturalWidth: w, naturalHeight: h, resetKey: key }),
      { initialProps: { w: 1000, h: 750, key: 'a' } },
    )
    act(() => result.current.zoomStep(2))
    expect(result.current.state.scale).toBe(2)
    rerender({ w: 2000, h: 1500, key: 'b' })
    expect(result.current.state).toEqual({ scale: 1, tx: 0, ty: (500 - 375) / 2 })
  })
})
