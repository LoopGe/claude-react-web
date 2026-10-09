import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clampTranslate, fitSize, maxScale, toggleActualSize, zoomAt, type ZoomState } from '../utils/image-zoom-math'

/** Zoom/pan state for the Lightbox. The stage is a fixed inset:0 surface, so
 *  all geometry comes from window.innerWidth/innerHeight — no
 *  getBoundingClientRect (happy-dom zeroes it; the math is unit-tested in
 *  src/utils/image-zoom-math.test.ts).
 *
 *  Display model: the <img> must be positioned absolutely at the stage's
 *  top-left with `transform-origin: 0 0` and
 *  `transform: translate(tx, ty) scale(s)` — the math anchors zooms against
 *  that exact mapping. "Centered" is tx = (stageW - fitW) / 2, set both at
 *  init/reset and re-derived by clampTranslate whenever the scaled image is
 *  smaller than the stage. */
/** Structural pointer shape the pan handlers need — satisfied by both the
 *  DOM PointerEvent and React's synthetic one. */
export interface PanPointerEvent {
  pointerId: number
  clientX: number
  clientY: number
}

export function useImageZoom(options: {
  naturalWidth: number
  naturalHeight: number
  /** Identity of the viewed image. Distinct images with an identical fit size
   *  alias to the same geometry — the key includes this so every image switch
   *  resets zoom/pan, not just size changes. */
  resetKey?: string
}): {
  fit: { w: number; h: number }
  max: number
  state: ZoomState
  isPanning: boolean
  handlers: {
    onPointerDown: (e: PanPointerEvent, el: EventTarget) => void
    onPointerMove: (e: PanPointerEvent) => void
    onPointerUp: (e: { pointerId: number }) => void
    onDoubleClick: (e: { clientX: number; clientY: number }) => void
  }
  zoomAtPoint: (factor: number, px: number, py: number) => void
  zoomStep: (factor: number) => void
  reset: () => void
} {
  const { naturalWidth, naturalHeight } = options

  // Viewport size, synced on window resize so the fit recomputes.
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const fit = useMemo(() => fitSize(naturalWidth, naturalHeight, viewport.w, viewport.h), [naturalWidth, naturalHeight, viewport])
  const max = useMemo(() => maxScale(naturalWidth, naturalHeight, viewport.w, viewport.h), [naturalWidth, naturalHeight, viewport])

  const centerOn = useCallback(
    (f: { w: number; h: number }, vp: { w: number; h: number }): ZoomState => ({
      scale: 1,
      tx: (vp.w - f.w) / 2,
      ty: (vp.h - f.h) / 2,
    }),
    [],
  )
  const [state, setState] = useState<ZoomState>(() => centerOn(fit, viewport))

  // Any geometry change (image switch, viewport resize) re-fits and re-centers.
  // Adjusted during render (documented derived-state pattern): the geometry
  // key detects the change, and the reset lands in the same commit — no
  // effect, no cascading render.
  const [geomKey, setGeomKey] = useState(() => `${options.resetKey ?? ''}|${fit.w}x${fit.h}@${viewport.w}x${viewport.h}`)
  const nextGeomKey = `${options.resetKey ?? ''}|${fit.w}x${fit.h}@${viewport.w}x${viewport.h}`
  if (geomKey !== nextGeomKey) {
    setGeomKey(nextGeomKey)
    setState(centerOn(fit, viewport))
  }

  const apply = useCallback(
    (next: ZoomState) => setState(clampTranslate(next, fit.w, fit.h, viewport.w, viewport.h)),
    [fit, viewport],
  )

  const zoomAtPoint = useCallback(
    (factor: number, px: number, py: number) => {
      setState((prev) => clampTranslate(zoomAt(prev, factor, px, py, max), fit.w, fit.h, viewport.w, viewport.h))
    },
    [fit, viewport, max],
  )

  // Toolbar zoom buttons: anchor at the stage center.
  const zoomStep = useCallback(
    (factor: number) => zoomAtPoint(factor, viewport.w / 2, viewport.h / 2),
    [zoomAtPoint, viewport],
  )

  const reset = useCallback(() => setState(centerOn(fit, viewport)), [centerOn, fit, viewport])

  // Drag-to-pan. The active pointer id + last position live in refs so the
  // handlers stay stable; moves after pointerup are ignored (drag over).
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)
  const [isPanning, setIsPanning] = useState(false)

  const onPointerDown = useCallback((e: PanPointerEvent, el: EventTarget) => {
    dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
    setIsPanning(true)
    // Keep the pan even when the pointer leaves the stage mid-drag.
    ;(el as Element).setPointerCapture?.(e.pointerId)
  }, [])

  const onPointerMove = useCallback(
    (e: PanPointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      const dx = e.clientX - drag.lastX
      const dy = e.clientY - drag.lastY
      drag.lastX = e.clientX
      drag.lastY = e.clientY
      setState((prev) => clampTranslate({ ...prev, tx: prev.tx + dx, ty: prev.ty + dy }, fit.w, fit.h, viewport.w, viewport.h))
    },
    [fit, viewport],
  )

  const onPointerUp = useCallback((e: { pointerId: number }) => {
    if (!dragRef.current || dragRef.current.pointerId !== e.pointerId) return
    dragRef.current = null
    setIsPanning(false)
  }, [])

  const onDoubleClick = useCallback(
    (e: { clientX: number; clientY: number }) => {
      apply(toggleActualSize(state, naturalWidth, fit.w, e.clientX, e.clientY, max))
    },
    [apply, state, naturalWidth, fit, max],
  )

  return {
    fit,
    max,
    state,
    isPanning,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onDoubleClick },
    zoomAtPoint,
    zoomStep,
    reset,
  }
}
