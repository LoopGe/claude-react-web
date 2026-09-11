import {
  type DetailsHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

const DEFAULT_DURATION_MS = 240
const TRANSITION = [
  'height var(--motion-duration-moderate) var(--motion-ease-standard)',
  'opacity var(--motion-duration-fast) var(--motion-ease-standard)',
].join(', ')

/** What the collapse should settle the body's height on, or null when the
 *  measurement must not be adopted.
 *
 *  Normally simply the content's rendered height. Under a flex clamp from an
 *  ancestor (`.chat-bottom-stack` caps its height, and the clamp lands on the
 *  body) that box belongs to the ancestor, not the content — adopting it is
 *  what latches a panel small after the constraint lifts — so a caller that
 *  has not opted in gets null, exactly as before.
 *
 *  `keepWhileClamped` is the opt-in for the one shape where the reading stays
 *  trustworthy under a clamp: a body whose content is deliberately left at its
 *  intrinsic height, so it OVERFLOWS a clamped body rather than being squeezed
 *  into it (the TaskList card's `flex: 0 0 auto` content). There the content's
 *  own height is what the body should be pinned to, in both directions, so the
 *  card is right again the moment the constraint lifts. Do not set it for
 *  content stretched to the body: the measured height is then the clamp. */
function measureAdoptableHeight(
  body: HTMLDivElement,
  content: HTMLDivElement,
  keepWhileClamped: boolean,
): { height: number; pinned: number; clamped: boolean } | null {
  const contentHeight = content.getBoundingClientRect().height
  const pinned = Number.parseFloat(body.style.height)
  // The LAYOUT height (`offsetHeight`), not a rect: getBoundingClientRect
  // includes ancestor transforms, and the chat panel plus the overlay panels
  // enter with `scale(0.98)` — every body inside one would read as clamped for
  // the length of that entrance. offsetHeight is the used height, which is what
  // "the ancestor handed us less than we pinned" actually means.
  const clamped = Number.isFinite(pinned) && body.offsetHeight < pinned - 1
  if (clamped && !keepWhileClamped) return null
  // Under a clamp the reading we pin must be in the same coordinate space as
  // the pin: a rect would carry the same ancestor scale that the probe above
  // just discounted, and pinning 98% of the content leaves the card a few px
  // short (a stray scrollbar and a clipped last row) until something else
  // resizes the content.
  return { height: clamped ? content.offsetHeight : contentHeight, pinned, clamped }
}

interface AnimatedCollapseProps {
  open: boolean
  children: ReactNode
  className?: string
  contentClassName?: string
  unmountOnExit?: boolean
  appear?: boolean
  durationMs?: number
  onExitComplete?: () => void
  /** id applied to the animated content box, so a sibling control can target
   *  it via aria-controls (the body stays mounted even when folded when
   *  unmountOnExit=false, so the target is always reachable). */
  id?: string
  /** Animate intrinsic content-size changes while open (default: snap).
   *  When true, a ResizeObserver-driven height change tweens instead of
   *  jumping, so e.g. a task row appending to an open TaskList grows the
   *  panel smoothly. The open/close fold always takes precedence — a resize
   *  that lands mid-open/close lets that animation finish first. */
  animateResize?: boolean
  /** Keep the pinned height in step with the content while an ancestor
   *  flex-clamps the body (`remeasureWhileClamped` opts out of the default
   *  "never adopt a clamped reading" rule — see measureAdoptableHeight). Only
   *  for bodies whose content is deliberately left at its intrinsic height, so
   *  a reading taller than the clamped box really is the content's own height:
   *  the TaskList card, whose `.todo-panel .animated-collapse-content` is
   *  `flex: 0 0 auto` inside `.chat-bottom-stack`'s 45% cap. Without it a row
   *  landing under the clamp leaves the pin stale, so the card stays short —
   *  the new rows reachable only by scrolling — until some later row heals it.
   *  Default false: for the ordinary content stretched to the body, the
   *  measured height IS the clamp and must never be adopted. */
  remeasureWhileClamped?: boolean
}

export function AnimatedCollapse({
  open,
  children,
  className = '',
  contentClassName = '',
  unmountOnExit = true,
  appear = false,
  durationMs = DEFAULT_DURATION_MS,
  onExitComplete,
  id,
  animateResize = false,
  remeasureWhileClamped = false,
}: AnimatedCollapseProps) {
  const [mounted, setMounted] = useState(open || !unmountOnExit)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const initializedRef = useRef(false)
  const previousOpenRef = useRef(open)
  const lastHeightRef = useRef(0)
  const cleanupRef = useRef<(() => void) | null>(null)
  const animatingRef = useRef(false)
  const initiallyOpenRef = useRef(open)

  const cleanupAnimation = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = null
  }, [])

  const finishOpen = useCallback((height: number) => {
    const body = bodyRef.current
    if (!body) return
    lastHeightRef.current = height
    if (unmountOnExit) setMounted(true)
    body.style.height = `${height}px`
    body.style.opacity = ''
    body.style.transition = ''
    body.classList.remove('animating')
    animatingRef.current = false
    // If the content's true height drifted while the open animation played
    // (ResizeObserver snaps are deferred during the animation so it can play
    // out — see the observer below), snap to the current true height now so
    // nothing stays clipped under `overflow-y: clip`. Under a clamp this is
    // the same rule the observer applies — one definition, see
    // measureAdoptableHeight.
    const content = contentRef.current
    if (content) {
      const measured = measureAdoptableHeight(body, content, remeasureWhileClamped)
      if (measured && measured.height > 0 && Math.abs(measured.height - height) > 1) {
        lastHeightRef.current = measured.height
        body.style.height = `${measured.height}px`
      }
    }
  }, [remeasureWhileClamped, unmountOnExit])

  const finishClosed = useCallback(() => {
    const body = bodyRef.current
    if (body) {
      body.style.height = '0px'
      body.style.opacity = '0'
      body.style.transition = ''
      body.classList.remove('animating')
    }
    animatingRef.current = false
    if (unmountOnExit) setMounted(false)
    onExitComplete?.()
  }, [onExitComplete, unmountOnExit])

  const animateHeight = useCallback((from: number, to: number, nextOpen: boolean, fade: boolean) => {
    const body = bodyRef.current
    if (!body) return

    cleanupAnimation()

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion || Math.abs(from - to) < 2) {
      if (nextOpen) finishOpen(to)
      else finishClosed()
      return
    }

    let done = false
    body.classList.add('animating')
    body.style.transition = 'none'
    body.style.height = `${Math.max(0, from)}px`
    if (fade) body.style.opacity = nextOpen ? '0' : '1'

    void body.offsetHeight

    animatingRef.current = true
    const raf = window.requestAnimationFrame(() => {
      body.style.transition = TRANSITION
      body.style.height = `${Math.max(0, to)}px`
      if (fade) body.style.opacity = nextOpen ? '1' : '0'
    })

    const finish = () => {
      if (done) return
      done = true
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      body.removeEventListener('transitionend', onEnd)
      cleanupRef.current = null
      if (nextOpen) finishOpen(to)
      else finishClosed()
    }

    const onEnd = (event: TransitionEvent) => {
      if (event.target === body && event.propertyName === 'height') finish()
    }

    const timer = window.setTimeout(finish, durationMs + 120)
    body.addEventListener('transitionend', onEnd)
    cleanupRef.current = () => {
      if (done) return
      done = true
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      body.removeEventListener('transitionend', onEnd)
      body.classList.remove('animating')
      animatingRef.current = false
    }
  }, [cleanupAnimation, durationMs, finishClosed, finishOpen])

  const rendered = mounted || open || !unmountOnExit

  useLayoutEffect(() => {
    if (!rendered) return
    const body = bodyRef.current
    const content = contentRef.current
    if (!body || !content) return

    const nextHeight = content.scrollHeight
    if (!initializedRef.current) {
      initializedRef.current = true
      previousOpenRef.current = open
      lastHeightRef.current = open ? nextHeight : 0
      const shouldAnimateInitialOpen = open && (appear || (!initiallyOpenRef.current && unmountOnExit))
      body.style.height = shouldAnimateInitialOpen ? '0px' : (open ? `${nextHeight}px` : '0px')
      body.style.opacity = open && !shouldAnimateInitialOpen ? '' : '0'
      if (shouldAnimateInitialOpen) animateHeight(0, nextHeight, true, true)
      return
    }

    if (previousOpenRef.current === open) return
    previousOpenRef.current = open

    if (open) {
      // Measure the target with getBoundingClientRect, not scrollHeight:
      // under the body's `overflow-y: clip`, scrollHeight can return the
      // body's pinned height rather than the content's true height (see the
      // ResizeObserver note below). The content is laid out by now (the
      // <details> just opened), so its bounding box is the true height.
      const target = content.getBoundingClientRect().height || content.scrollHeight
      animateHeight(0, target, true, true)
      return
    }

    const startHeight = body.getBoundingClientRect().height || lastHeightRef.current || content.scrollHeight
    animateHeight(startHeight, 0, false, true)
  }, [animateHeight, appear, open, rendered, unmountOnExit])

  useEffect(() => {
    if (!open || !rendered || !('ResizeObserver' in window)) return
    const body = bodyRef.current
    const content = contentRef.current
    if (!body || !content) return

    // Default (animateResize=false) is snap-only: the open/close moment is the
    // only useful animated beat; intrinsic content growth after open is plain
    // layout and snaps in place. With animateResize=true we tween those changes
    // so a list that grows while open (e.g. a TaskList row appending) eases
    // open instead of jumping. Either way, never fight an in-flight open/close
    // animation — let it play out (finishOpen re-measures the true height at
    // the end, so growth during the animation is still reconciled) — and a
    // rapid run of resize events cancels-and-replaces, so a streaming list
    // follows smoothly instead of stacking a new 240ms tween per row.
    const observer = new ResizeObserver(() => {
      if (!previousOpenRef.current) return
      // Measure the content's RENDERED height, not scrollHeight. Under
      // `overflow-y: clip` on the body, content.scrollHeight can return the
      // body's pinned height rather than the true content height (observed:
      // body=232, group-sessions child=152, yet content.scrollHeight=232),
      // which pins the collapse to a stale height and leaves whitespace
      // after a drag-out. getBoundingClientRect reflects the actual layout
      // box and is immune to the overflow-clip scrollHeight quirk.
      const measured = measureAdoptableHeight(body, content, remeasureWhileClamped)
      if (!measured) return
      if (measured.clamped) {
        // The box belongs to the ancestor, not the content (see
        // measureAdoptableHeight, which only returns a height here for opted-in
        // callers). Record it rather than animating into it: the body's own box
        // does not move while the clamp holds — the ancestor still governs it —
        // so the visible effect is only that the card comes back at its full
        // height when the constraint lifts, instead of staying at whatever
        // height it had when the constraint appeared. (The pinned height is
        // part of the card's flex basis, so with a sibling card sharing the
        // same capped stack the shrink split between them does shift.)
        // Never retarget a live tween (see the guard below); finishOpen
        // re-measures — by this same rule — at its end.
        if (animatingRef.current) return
        if (Math.abs(measured.height - measured.pinned) < 1) return
        lastHeightRef.current = measured.height
        body.style.height = `${measured.height}px`
        return
      }
      const currentHeight = body.getBoundingClientRect().height
      if (Math.abs(measured.height - currentHeight) < 1) return
      lastHeightRef.current = measured.height
      if (animatingRef.current) {
        // An open/close animation is in flight — let it play to its target
        // rather than tearing it down (which made every open instant /
        // animation-less). finishOpen re-measures at animation end so any
        // growth during the animation is still reconciled.
        return
      }
      if (animateResize) {
        // Resize tween: from the current rendered height to the content's new
        // natural height. fade=false — opacity belongs to the open/close beat,
        // not layout motion. Rapid successive events call animateHeight again,
        // which cancels the in-flight tween and restarts from the live height.
        animateHeight(currentHeight, measured.height, true, false)
      } else {
        body.style.height = `${measured.height}px`
      }
    })

    observer.observe(content)
    return () => observer.disconnect()
  }, [animateHeight, animateResize, open, remeasureWhileClamped, rendered, unmountOnExit])

  useEffect(() => () => cleanupAnimation(), [cleanupAnimation])

  if (!rendered) return null

  return (
    <div
      ref={bodyRef}
      className={`animated-collapse${className ? ` ${className}` : ''}`}
      aria-hidden={!open}
    >
      <div
        ref={contentRef}
        id={id}
        className={`animated-collapse-content${contentClassName ? ` ${contentClassName}` : ''}`}
      >
        {children}
      </div>
    </div>
  )
}

interface AnimatedDetailsProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children' | 'onToggle'> {
  defaultOpen?: boolean
  summary: ReactNode
  children: ReactNode
  summaryClassName?: string
  collapseClassName?: string
  contentClassName?: string
  durationMs?: number
  onOpenChange?: (open: boolean) => void
}

export function AnimatedDetails({
  defaultOpen = false,
  open: controlledOpen,
  summary,
  children,
  className = '',
  summaryClassName = '',
  collapseClassName = '',
  contentClassName = '',
  durationMs = DEFAULT_DURATION_MS,
  onOpenChange,
  ...detailsProps
}: AnimatedDetailsProps) {
  const isControlled = controlledOpen != null
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  const [detailsOpen, setDetailsOpen] = useState(open)
  const openRef = useRef(open)

  useEffect(() => {
    openRef.current = open
  }, [open])

  const setNextOpen = useCallback((nextOpen: boolean) => {
    if (nextOpen) setDetailsOpen(true)
    if (!isControlled) setUncontrolledOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }, [isControlled, onOpenChange])

  const handleSummaryClick = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    setNextOpen(!open)
  }, [open, setNextOpen])

  return (
    <details
      {...detailsProps}
      className={className}
      open={detailsOpen || open}
      data-state={open ? 'open' : 'closed'}
    >
      <summary
        className={summaryClassName || undefined}
        aria-expanded={open}
        onClick={handleSummaryClick}
      >
        {summary}
      </summary>
      <AnimatedCollapse
        open={open}
        className={collapseClassName}
        contentClassName={contentClassName}
        unmountOnExit={false}
        durationMs={durationMs}
        onExitComplete={() => { if (!openRef.current) setDetailsOpen(false) }}
      >
        {children}
      </AnimatedCollapse>
    </details>
  )
}
