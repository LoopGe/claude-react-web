import { prefersReducedMotion } from '../utils/reduced-motion'
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { anyCollapseMotionInside, claimCollapseMotionInside } from '../components/collapse-animation'
import { isRendered } from '../utils/rendered'

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
    // NO metric off an unrendered box (display:none — the settings panel stays
    // mounted under `.hidden`) is a measurement: the zeros, and equally a
    // measure that adds CSS padding to those zeros (~32px for the global
    // settings modal's body). Adopting one tweens the body down while hidden
    // and grows it back from a stub on the next reveal — and the key-driven
    // path reads this on WS-driven key changes WHILE hidden, with no
    // ResizeObserver involved. Same rule AnimatedCollapse pins via isRendered.
    // A measure returning null likewise propagates as "no measurement" (it
    // must not silently fall back to scrollHeight).
    if (!isRendered(el)) return null
    return measureTargetHeight ? measureTargetHeight() : el.scrollHeight
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

    const reducedMotion = prefersReducedMotion()
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
        // A fold that started while this tween was in flight owns the height
        // motion now — never chain a catch-up into it (that re-pins the box
        // below its natural height mid-fold and re-targets every durationMs
        // until the fold settles). Same for a fold that settled just before
        // this finish: the chain would pin below the folded height and
        // re-grow the tail. Release the pin and track instead; the body
        // follows the fold natively from here.
        if (anyCollapseMotionInside(observe?.current ?? null)) {
          lastTargetHeightRef.current = pendingTarget
          clearInlineHeight(el)
          return
        }
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
  }, [clearInlineHeight, durationMs, easing, observe, readTargetHeight, ref])

  const captureHeight = useCallback(() => {
    const el = ref.current
    if (!el) return
    // The USED height, not a rect: a rect carries every ancestor transform, and
    // this hook's callers (a settings panel body, a folder picker list) live
    // inside `.chat-panel`, which enters with `scale(0.98)` (layout.css). A
    // captured start height 2% short makes the tween begin smaller than the box
    // and jump on its first frame — the hazard the fold components document.
    const startHeight = el.offsetHeight
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
      if (nextTarget == null) {
        // A refused read (unrendered box) leaves the baseline untrustworthy —
        // drop it so the reveal's first measurement rebases instead of
        // gliding from the pre-hide target.
        lastTargetHeightRef.current = null
        return
      }

      const previousTarget = lastTargetHeightRef.current
      lastTargetHeightRef.current = nextTarget
      if (previousTarget == null) return

      // Collapse motion owns this box — track the target above but never
      // answer it with a tween of our own. The settings panel body is the
      // measured case: expanding an AnimatedDetails grows the observed
      // content every frame, and a hook-owned height tween on top pins the
      // body mid-fold, clips the fold behind the pin, then snaps the
      // scrollbar short when the tween chain ends (the pin never equals the
      // natural flex height exactly). Standing down lets the body follow the
      // fold natively, and the tracking keeps the next DISCRETE change
      // animating from the reached height — same rule AnimatedCollapse's own
      // observer applies to nested folds. This is the measurement site, so it
      // CLAIMS the settle-tail latch: this delivery is the tail itself when
      // one is pending (deliberately before the Δ check — the tail may well
      // be sub-2px).
      if (claimCollapseMotionInside(observed)) return
      if (Math.abs(nextTarget - previousTarget) < 2) return
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
    if (nextHeight == null) {
      // Refused (unrendered) read: drop the baseline so the reveal's first
      // measurement rebases instead of gliding from the pre-hide target (see
      // the observer's null branch).
      lastTargetHeightRef.current = null
      return
    }

    const startHeight = startHeightRef.current
    startHeightRef.current = null
    if (startHeight != null) {
      animateFromTo(startHeight, nextHeight)
      return
    }

    const previousHeight = lastTargetHeightRef.current
    lastTargetHeightRef.current = nextHeight
    if (previousHeight == null) return

    // Collapse motion owns the height — the same rule as the observer's
    // guard, applied in the same order (track → guard → Δ → animate): this is
    // the other tween start. The query does NOT consume the settle-tail latch
    // — that belongs to the observation that IS the tail. Only the
    // non-capture branch: the captureHeight branch above has already pinned
    // the box and must animate to release it — and a fold there is
    // unreachable anyway, since capture runs in the same commit as a content
    // swap that unmounts any fold.
    if (anyCollapseMotionInside(observe?.current ?? null)) return
    if (Math.abs(nextHeight - previousHeight) < 2) return
    if (animatingRef.current) {
      pendingTargetHeightRef.current = nextHeight
      return
    }

    animateFromTo(previousHeight, nextHeight)
  }, [animateFromTo, observe, readTargetHeight, key])

  return { captureHeight }
}


