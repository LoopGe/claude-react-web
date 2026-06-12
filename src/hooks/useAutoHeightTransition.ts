import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'

interface AutoHeightTransitionOptions {
  durationMs?: number
  easing?: string
  measureTargetHeight?: () => number | null
  observe?: RefObject<HTMLElement | null>
}

interface AutoHeightTransitionControls {
  captureHeight: () => void
}

/**
 * Animates an auto-sized element between layout changes by temporarily
 * pinning its computed height to pixel values. Call captureHeight() before
 * the state change that swaps content so the hook has a reliable start point.
 */
export function useAutoHeightTransition<T extends HTMLElement>(
  ref: RefObject<T | null>,
  key: unknown,
  options: AutoHeightTransitionOptions = {},
): AutoHeightTransitionControls {
  const {
    durationMs = 240,
    easing = 'cubic-bezier(0.22, 1, 0.36, 1)',
    measureTargetHeight,
    observe,
  } = options
  const startHeightRef = useRef<number | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const animatingRef = useRef(false)
  const lastTargetHeightRef = useRef<number | null>(null)
  const pendingTargetHeightRef = useRef<number | null>(null)

  const readTargetHeight = useCallback(() => {
    const el = ref.current
    if (!el) return null
    return measureTargetHeight?.() ?? el.scrollHeight
  }, [measureTargetHeight, ref])

  const clearInlineHeight = useCallback((el: HTMLElement) => {
    el.classList.remove('auto-height-animating')
    el.style.height = ''
    el.style.transition = ''
    el.style.overflow = ''
    el.style.willChange = ''
  }, [])

  const animateFromTo = useCallback(function runHeightAnimation(startHeight: number, nextHeight: number) {
    const el = ref.current
    if (!el) return

    cleanupRef.current?.()
    cleanupRef.current = null
    lastTargetHeightRef.current = nextHeight

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion || Math.abs(startHeight - nextHeight) < 2) {
      pendingTargetHeightRef.current = null
      animatingRef.current = false
      clearInlineHeight(el)
      return
    }

    el.classList.add('auto-height-animating')
    el.style.transition = 'none'
    el.style.height = startHeight + 'px'
    el.style.overflow = 'hidden'
    el.style.willChange = 'height'

    void el.offsetHeight

    let done = false
    animatingRef.current = true
    const raf = window.requestAnimationFrame(() => {
      el.style.transition = 'height ' + durationMs + 'ms ' + easing
      el.style.height = nextHeight + 'px'
    })

    const finish = (followPending: boolean) => {
      if (done) return
      done = true
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      el.removeEventListener('transitionend', onEnd)

      const pendingTarget = followPending ? (pendingTargetHeightRef.current ?? readTargetHeight()) : null
      pendingTargetHeightRef.current = null

      if (pendingTarget != null && Math.abs(pendingTarget - nextHeight) >= 2) {
        animatingRef.current = false
        cleanupRef.current = null
        runHeightAnimation(nextHeight, pendingTarget)
        return
      }

      lastTargetHeightRef.current = pendingTarget ?? nextHeight
      clearInlineHeight(el)
      animatingRef.current = false
      cleanupRef.current = null
    }

    const onEnd = (event: TransitionEvent) => {
      if (event.target === el && event.propertyName === 'height') finish(true)
    }

    const timer = window.setTimeout(() => finish(true), durationMs + 120)
    el.addEventListener('transitionend', onEnd)
    cleanupRef.current = () => finish(false)
  }, [clearInlineHeight, durationMs, easing, readTargetHeight, ref])

  const captureHeight = useCallback(() => {
    const el = ref.current
    if (!el) return
    const startHeight = el.getBoundingClientRect().height
    cleanupRef.current?.()
    cleanupRef.current = null
    pendingTargetHeightRef.current = null
    startHeightRef.current = startHeight
    el.classList.add('auto-height-animating')
    el.style.transition = 'none'
    el.style.height = startHeight + 'px'
    el.style.overflow = 'hidden'
    el.style.willChange = 'height'
  }, [ref])

  useEffect(() => {
    const observed = observe?.current
    if (!observed || !ref.current || !('ResizeObserver' in window)) return

    const observer = new ResizeObserver(() => {
      const nextTarget = readTargetHeight()
      if (nextTarget == null) return

      const previousTarget = lastTargetHeightRef.current
      if (previousTarget == null) {
        lastTargetHeightRef.current = nextTarget
        return
      }
      if (Math.abs(nextTarget - previousTarget) < 2) {
        lastTargetHeightRef.current = nextTarget
        return
      }

      lastTargetHeightRef.current = nextTarget
      if (animatingRef.current) {
        pendingTargetHeightRef.current = nextTarget
        return
      }

      animateFromTo(previousTarget, nextTarget)
    })

    observer.observe(observed)
    return () => {
      observer.disconnect()
    }
  }, [animateFromTo, observe, readTargetHeight, ref])

  useEffect(() => {
    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    const nextHeight = readTargetHeight()
    if (nextHeight == null) return

    const startHeight = startHeightRef.current
    startHeightRef.current = null
    if (startHeight != null) {
      animateFromTo(startHeight, nextHeight)
      return
    }

    const previousHeight = lastTargetHeightRef.current
    if (previousHeight == null) {
      lastTargetHeightRef.current = nextHeight
      return
    }
    if (Math.abs(nextHeight - previousHeight) < 2) {
      lastTargetHeightRef.current = nextHeight
      return
    }

    lastTargetHeightRef.current = nextHeight
    if (animatingRef.current) {
      pendingTargetHeightRef.current = nextHeight
      return
    }

    animateFromTo(previousHeight, nextHeight)
  }, [animateFromTo, readTargetHeight, key])

  return { captureHeight }
}


