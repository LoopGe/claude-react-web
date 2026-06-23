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

interface AnimatedCollapseProps {
  open: boolean
  children: ReactNode
  className?: string
  contentClassName?: string
  unmountOnExit?: boolean
  appear?: boolean
  durationMs?: number
  onExitComplete?: () => void
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
  }, [unmountOnExit])

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
      animateHeight(0, content.scrollHeight, true, true)
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

    // Snap-only: AnimatedCollapse animates the OPEN/CLOSE transition; intrinsic
    // content size changes after open are NOT animated. Animating content
    // growth (e.g. an async fetch landing inside an opened collapse) would
    // either fight an in-flight open animation (visible "two-step" jitter as
    // the new animateHeight cancels and restarts) or stack a second 240 ms
    // transition immediately after the first — both are jarring. The
    // open/close moment is the only useful animated beat; everything else is
    // layout, which the browser handles for free.
    //
    // If the content grows while an open animation is still in flight, we
    // tear down that animation FIRST (clear the transition + cancel its
    // transitionend handler so it can't reset height to the original `to`)
    // then snap to the new height in a single frame.
    const observer = new ResizeObserver(() => {
      if (!previousOpenRef.current) return
      const nextHeight = content.scrollHeight
      // Compare against the body's ACTUAL rendered height, not lastHeightRef.
      // lastHeightRef can drift out of sync with the real DOM when other
      // paths (useLayoutEffect init, an in-flight animation's finishOpen)
      // update body.style.height without touching lastHeightRef — and a stale
      // match here would short-circuit the snap, leaving the collapse pinned
      // to an old height (e.g. a group that doesn't shrink after a session
      // is dragged out). The body's live height is the source of truth.
      const currentHeight = body.getBoundingClientRect().height
      if (Math.abs(nextHeight - currentHeight) < 1) return
      lastHeightRef.current = nextHeight
      if (animatingRef.current) {
        // Tear down the in-flight open animation and snap to the fully-open
        // state. We must mirror finishOpen's full cleanup — clearing only the
        // transition is not enough:
        //   - opacity was mid-fade (0 → 1) and would freeze at e.g. 0.5
        //     forever once the transition is gone. Clear it so the element
        //     snaps to the CSS default (1).
        //   - in unmountOnExit mode with initial open=false, setMounted(true)
        //     normally fires inside finishOpen. Skipping it here would leave
        //     `mounted` stuck at false, so a later open=false would compute
        //     rendered=false and unmount with no close animation and no
        //     onExitComplete callback.
        cleanupAnimation()
        body.classList.remove('animating')
        body.style.transition = ''
        body.style.opacity = ''
        animatingRef.current = false
        if (unmountOnExit) setMounted(true)
      }
      body.style.height = `${nextHeight}px`
    })

    observer.observe(content)
    return () => observer.disconnect()
  }, [cleanupAnimation, open, rendered, unmountOnExit])

  useEffect(() => () => cleanupAnimation(), [cleanupAnimation])

  if (!rendered) return null

  return (
    <div
      ref={bodyRef}
      className={`animated-collapse${className ? ` ${className}` : ''}`}
      aria-hidden={!open}
    >
      <div ref={contentRef} className={`animated-collapse-content${contentClassName ? ` ${contentClassName}` : ''}`}>
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
