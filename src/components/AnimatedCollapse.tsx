import { prefersReducedMotion } from '../utils/reduced-motion'
import { isRendered } from '../utils/rendered'
import { easeStandard } from '../utils/cubic-bezier'
import { anyCollapseAnimatingInside, releaseAncestorCollapsePins, setCollapseAnimating } from './collapse-animation'
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
/** Opacity fade length. The height tween runs `durationMs`, but the fade keeps
 *  the old CSS transition's split timing — `opacity` used to animate over
 *  `--motion-duration-fast` (120ms) while height ran 240ms, so content became
 *  readable long before the box finished moving. Driving the fade with the
 *  full durationMs (the first rAF-tween version did) silently doubled every
 *  fold's fade and stretched it to any custom durationMs. */
const FADE_DURATION_MS = 120

/** Two resize observations closer together than this are ONE continuous
 *  layout run — an inner animation (a nested collapse, a grid-rows reveal)
 *  feeding the observer every frame — and are followed as they come (a snap per
 *  observation, at the pin's whole-pixel resolution, so the body is never more
 *  than a frame behind the content). An observation isolated past the window is
 *  a discrete jump (a card mounting) and gets the animateResize tween instead. */
const RESIZE_COALESCE_MS = 80

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
 *  content stretched to the body: the measured height is then the clamp.
 *
 *  A box that is not being rendered offers no measurement at all (see
 *  isRendered) and returns null like any other non-adoptable read — the
 *  opt-in above must not widen that: a hidden box is *shorter than the pin*
 *  for the same trivial reason a clamped one is, and adopting it pins the body
 *  to 0. */
function measureAdoptableHeight(
  body: HTMLDivElement,
  content: HTMLDivElement,
  keepWhileClamped: boolean,
): { height: number; pinned: number; clamped: boolean } | null {
  // The USED height (`offsetHeight`), never a rect. getBoundingClientRect
  // carries every ancestor transform, and this app puts one over the whole
  // measuring subtree: the chat panel enters with `scale(0.98)`, so a rect read
  // under it reports 98% of the layout height — and a pin taken from one leaves
  // the card 2% short (a clipped last row) until something re-measures it.
  // offsetHeight is the used height, rounded to a whole pixel: that rounding is
  // the price of a metric no descendant transform can distort, and it keeps the
  // probe, the pin and every comparison in one coordinate. The mount path's
  // initial pin is the deliberate exception — it reads the content's
  // scrollHeight, because before anything is pinned that is what reads PAST an
  // ancestor's flex clamp — and the observer's first measurement replaces it.
  const contentHeight = content.offsetHeight
  // Only a ZERO reading needs the rendered-ness probe: a non-zero one proves the
  // box exists, and this runs per growth frame while an inner animation feeds
  // the observer (see RESIZE_COALESCE_MS), so the ancestor walk in isRendered
  // stays off that path.
  if (contentHeight === 0 && !isRendered(content)) return null
  const pinned = Number.parseFloat(body.style.height)
  const clamped = Number.isFinite(pinned) && body.offsetHeight < pinned - 1
  if (clamped && !keepWhileClamped) return null
  return { height: contentHeight, pinned, clamped }
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
  /** Which kind of animation `animatingRef` is currently running — an
   *  open/close fold (protected from resize observations, which would tear
   *  it down and make every fold instant) or a resize tween (replaceable:
   *  cancel-and-replace is the animateResize contract). Only read while
   *  `animatingRef` is true. */
  const animKindRef = useRef<'fold' | 'resize'>('fold')
  /** Timestamp of the last non-clamped resize observation, for the
   *  continuous-vs-discrete coalesce (see RESIZE_COALESCE_MS). Seeded at
   *  -Infinity so the FIRST observation is always discrete — a clock near
   *  zero (fresh page, faked timers at their epoch) must not read as
   *  "continuous with a fire that never happened". */
  const lastResizeAtRef = useRef(-Infinity)
  const initiallyOpenRef = useRef(open)

  const cleanupAnimation = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = null
  }, [])

  /** Stand down from an OPEN body whose box cannot be measured (see isRendered):
   *  cancel any fold still in flight, then drop the pin — its natural height is
   *  already the right answer (nothing re-pins an auto-height body on its own;
   *  the next fold pins it explicitly, and under a flex clamp the observer does,
   *  because the body's box then differs from its content). The cancel is
   *  unconditional because it is a no-op when nothing is animating, and one shape
   *  for both stand-down sites (a mount in an unrendered subtree, an open in one)
   *  is what keeps them from drifting apart. Clearing the transition is part of
   *  settling — the cancelled fold may already have written the tween's own
   *  transition onto the body, and every other settle path clears it too. */
  const standDown = useCallback(
    (body: HTMLDivElement) => {
      cleanupAnimation()
      body.style.transition = ''
      body.style.height = ''
      body.style.opacity = ''
    },
    [cleanupAnimation],
  )

  // aria-hidden is managed imperatively rather than through JSX. Applying it in
  // the same commit that flips `open` false would cover whatever control the
  // user just pressed — the remove button of the row that is leaving — and
  // Chrome refuses to hide a subtree that still contains the focused element
  // (logging "Blocked aria-hidden on an element because its descendant retained
  // focus"). So it lands only once the fold has SETTLED shut. At that point the
  // focused descendant is either gone (unmountOnExit) or about to become
  // unreachable, so blur it first and the write is accepted.
  const clearBodyAriaHidden = useCallback(() => {
    bodyRef.current?.removeAttribute('aria-hidden')
  }, [])

  const hideClosedBody = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    const active = document.activeElement
    if (active instanceof HTMLElement && body.contains(active)) active.blur()
    body.setAttribute('aria-hidden', 'true')
  }, [])

  const finishOpen = useCallback((height: number) => {
    const body = bodyRef.current
    if (!body) return
    clearBodyAriaHidden()
    lastHeightRef.current = height
    if (unmountOnExit) setMounted(true)
    body.style.height = `${height}px`
    body.style.opacity = ''
    body.style.transition = ''
    body.classList.remove('animating')
    setCollapseAnimating(body, false)
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
  }, [clearBodyAriaHidden, remeasureWhileClamped, unmountOnExit])

  const finishClosed = useCallback(() => {
    const body = bodyRef.current
    if (body) {
      body.style.height = '0px'
      body.style.opacity = '0'
      body.style.transition = ''
      body.classList.remove('animating')
      setCollapseAnimating(body, false)
    }
    animatingRef.current = false
    // The fold has settled: for a body that stays mounted (unmountOnExit off),
    // now is when the closed content is safe to hide from assistive tech. With
    // unmountOnExit on the body is about to disappear, so nothing to mark.
    if (unmountOnExit) setMounted(false)
    else hideClosedBody()
    onExitComplete?.()
  }, [hideClosedBody, onExitComplete, unmountOnExit])

  const animateHeight = useCallback((from: number, to: number, nextOpen: boolean, fade: boolean, kind: 'fold' | 'resize' = 'fold') => {
    const body = bodyRef.current
    if (!body) return

    // Release every pinned ancestor BEFORE the first height this body writes.
    // One place covers every path — an animated or instant fold, an open or a
    // close, and a resize tween — and a pinned ancestor holds this body's
    // growth back until its own observer relays it, one ResizeObserver
    // broadcast later, which paints everything below the fold a step low (see
    // releaseAncestorCollapsePins). Deliberately above the early return below:
    // under reduced motion (and for any <2px delta) nothing else would release.
    releaseAncestorCollapsePins(body)

    cleanupAnimation()

    const reducedMotion = prefersReducedMotion()
    if (reducedMotion || Math.abs(from - to) < 2) {
      if (nextOpen) finishOpen(to)
      else finishClosed()
      return
    }

    let done = false
    body.classList.add('animating')
    setCollapseAnimating(body, true)
    body.style.transition = 'none'
    body.style.height = `${Math.max(0, from)}px`
    if (fade) body.style.opacity = nextOpen ? '0' : '1'

    void body.offsetHeight

    animKindRef.current = kind
    animatingRef.current = true

    // Per-frame INTEGER height tween (rAF), not a CSS height transition. The
    // transition interpolates at fractional px per frame, which re-phases
    // every glyph raster downstream of the animated box: Chrome snaps glyphs
    // to the device-pixel grid at LAYOUT positions, so a fractional layout
    // step re-rasterizes the text at a new sub-pixel phase every frame — the
    // cards below the fold visibly shimmer for the whole fold even when the
    // scroll machinery holds their visual offset constant (measured on a live
    // session: DOM rects steady, user still sees "抖动"). Rounding each frame
    // to whole CSS px keeps every downstream layout step integer, so the
    // transcript's fold-lockstep compensation matches it 1:1 in scroll and
    // nothing below the fold ever re-phases. The curve is tokens.css'
    // --motion-ease-standard — the one the CSS transition declared; only the
    // per-frame granularity differs.
    const ease = easeStandard
    const startedAt = performance.now()
    let raf = 0
    const step = () => {
      if (done) return
      const now = performance.now()
      const t = Math.min(1, (now - startedAt) / durationMs)
      const p = ease(t)
      body.style.height = `${Math.max(0, Math.round(from + (to - from) * p))}px`
      if (fade) {
        // The fade keeps the OLD transition's split timing: same standard
        // ease, but over --motion-duration-fast (120ms), not the height's
        // full durationMs — see FADE_DURATION_MS.
        const pFade = ease(Math.min(1, (now - startedAt) / FADE_DURATION_MS))
        body.style.opacity = String(nextOpen ? pFade : 1 - pFade)
      }
      if (t < 1) raf = window.requestAnimationFrame(step)
      else finish()
    }
    raf = window.requestAnimationFrame(step)

    const finish = () => {
      if (done) return
      done = true
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      cleanupRef.current = null
      // Registry delete MUST happen here, not only inside finishOpen /
      // finishClosed: those read bodyRef.current, which React nulls during an
      // unmount commit BEFORE this pending rAF/timeout fires — they then
      // early-return on the null guard and skip the delete, while the unmount
      // cleanup below early-returns on `done`. A fold interrupted by unmount
      // would otherwise leave the detached element (its whole subtree with it)
      // retained in the module-level Set forever. `body` is the captured,
      // still-non-null element; delete is idempotent.
      setCollapseAnimating(body, false)
      if (nextOpen) finishOpen(to)
      else finishClosed()
    }

    // Safety net: the tween finishes itself on its last frame; the timer only
    // covers a stalled rAF clock (and is what fake-timer tests ride on).
    const timer = window.setTimeout(finish, durationMs + 120)
    cleanupRef.current = () => {
      if (done) return
      done = true
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      body.classList.remove('animating')
      setCollapseAnimating(body, false)
      animatingRef.current = false
    }
  }, [cleanupAnimation, durationMs, finishClosed, finishOpen])

  const rendered = mounted || open || !unmountOnExit

  // Keep the last OPEN children mounted through the exit tween.
  //
  // Callers routinely gate each row on the same condition that flips `open`
  // (the composer does exactly this: removing the final attachment drops the
  // row in the SAME commit that drives open=false). Without freezing, the
  // collapse would tween a box that is already empty — the chip disappears
  // instantly and the user watches a blank strip shrink. Recording the last
  // children while open and rendering those while closed (and still mounted)
  // makes the exit animate what the user saw. Only needed with unmountOnExit:
  // when it is off the caller owns the children's lifetime and they stay
  // mounted regardless, so live children are rendered untouched.
  const lastOpenChildrenRef = useRef(children)
  const [frozenChildren, setFrozenChildren] = useState(children)
  // Track the latest children while open (a ref write in an effect, never a
  // render-time read — the compiler lint forbids the latter).
  useLayoutEffect(() => {
    if (open) lastOpenChildrenRef.current = children
  }, [children, open])
  // On the close transition adopt them as the frozen content. This is a
  // layout-effect state update, so it re-renders (and paints the frozen rows)
  // before the exit tween is shown — the first close render's empty children
  // are never visible. It only runs on the transition, so there is no loop.
  // Gated on unmountOnExit: with it off, `renderedChildren` uses the live
  // children anyway, so the extra render would buy nothing.
  useLayoutEffect(() => {
    if (!open && unmountOnExit) setFrozenChildren(lastOpenChildrenRef.current)
  }, [open, unmountOnExit])
  const renderedChildren = open || !unmountOnExit ? children : frozenChildren

  useLayoutEffect(() => {
    if (!rendered) return
    const body = bodyRef.current
    const content = contentRef.current
    if (!body || !content) return

    if (!initializedRef.current) {
      initializedRef.current = true
      previousOpenRef.current = open
      if (open && !isRendered(content)) {
        // Mounted open inside a subtree that is not being rendered — a card can
        // mount in a keep-alive-cached panel, which still receives live data.
        // scrollHeight is 0 there, and pinning that 0 is what leaves the card
        // header-only until something measures it again, and what makes it grow
        // when the panel is shown. Stand down instead.
        standDown(body)
        return
      }
      const nextHeight = content.scrollHeight
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
      // Measure the target with the USED height, never scrollHeight: under the
      // body's `overflow-y: clip`, scrollHeight can return the body's pinned
      // height rather than the content's true height (see the ResizeObserver
      // note below). The content is laid out by now (the <details> just
      // opened), so its used height is the truth — and unlike a rect it carries
      // no ancestor transform.
      //
      // Opened while the subtree is not being rendered: the persisted collapse
      // flag syncs across tabs, so a card in a cached panel can be opened while
      // it is hidden. Both metrics read 0 there and neither is a height — stand
      // down instead (cancelling the close fold the same flag may have started).
      if (!isRendered(content)) {
        standDown(body)
        return
      }
      const target = content.offsetHeight || content.scrollHeight
      animateHeight(0, target, true, true)
      return
    }

    const startHeight = body.offsetHeight || lastHeightRef.current || content.scrollHeight
    animateHeight(startHeight, 0, false, true)
  }, [animateHeight, appear, open, rendered, standDown, unmountOnExit])

  // Apply / drop aria-hidden AFTER the height effect above, so `animatingRef`
  // already reflects a fold that just started. See hideClosedBody for why the
  // attribute cannot simply track `!open` in JSX.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    if (open) {
      clearBodyAriaHidden()
      return
    }
    if (animatingRef.current) return
    hideClosedBody()
  }, [clearBodyAriaHidden, hideClosedBody, open, rendered])

  useEffect(() => {
    if (!open || !rendered || !('ResizeObserver' in window)) return
    const body = bodyRef.current
    const content = contentRef.current
    if (!body || !content) return

    // Default (animateResize=false) is snap-only: the open/close moment is the
    // only useful animated beat; intrinsic content growth after open is plain
    // layout and snaps in place. With animateResize=true, DISCRETE growth
    // (isolated observations — a card mounting) tweens, while CONTINUOUS
    // growth (an inner animation feeding this observer every frame) is
    // followed exactly (see RESIZE_COALESCE_MS). Either way, never fight an
    // in-flight open/close FOLD — let it play out; finishOpen re-measures the
    // true height at the end, so growth during the fold is still reconciled.
    // Two discrete jumps close enough to each other that a tween from the
    // first is still in flight cancel-and-replace (animateHeight does the
    // canceling).
    const observer = new ResizeObserver(() => {
      if (!previousOpenRef.current) return
      // HOISTED (it used to sit below the measurement): an open/close fold in
      // flight owns this body's height. An observation must never tear it down
      // — that made every open instant — and it must not reach the
      // nested-collapse check below either, which would un-pin a body mid-fold
      // and flash its content open for a frame. finishOpen re-measures at
      // animation end, so growth during the fold is still reconciled. (With the
      // fold case handled here, `animatingRef` below means a RESIZE tween.)
      if (animatingRef.current && animKindRef.current === 'fold') return
      // Measure the content's USED height, not scrollHeight. Under
      // `overflow-y: clip` on the body, content.scrollHeight can return the
      // body's pinned height rather than the true content height (observed:
      // body=232, group-sessions child=152, yet content.scrollHeight=232),
      // which pins the collapse to a stale height and leaves whitespace
      // after a drag-out. offsetHeight is the used height, immune both to that
      // overflow-clip quirk and to an ancestor transform (see
      // measureAdoptableHeight).
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
      // A collapse animating inside this body IS this box's height motion:
      // track the content natively (auto) instead of pinning a copy of it. A
      // pinned copy is written by THIS observer, one broadcast after that
      // nested fold's own per-frame write, so anything reading the boxes in
      // this broadcast — the transcript's fold-lockstep — is a frame behind for
      // the whole fold: the content below a ToolGroupCard painted one
      // growth-step low on every frame. The pin is dropped when the fold starts
      // (releaseAncestorCollapsePins); this keeps it off if something re-pinned
      // in between — e.g. this body's own fold finishing after the nested fold
      // began. Deliberately BELOW the clamped branch: a flex-clamped body must
      // keep healing its pin from the content. And never while a tween of ours
      // is in flight: a RESIZE tween's pin IS its animation, which
      // releaseAncestorCollapsePins skips for exactly this reason — clearing it
      // here would snap that glide to an auto box mid-tween.
      if (!animatingRef.current && anyCollapseAnimatingInside(content)) {
        if (body.style.height !== '') body.style.height = ''
        return
      }
      const currentHeight = body.offsetHeight
      if (Math.abs(measured.height - currentHeight) < 1) {
        // Nothing to correct — and nothing here will ever write a pin either:
        // an auto box already equals its content, so this observer reads no
        // difference on the next growth, and an animateResize body needs a pin
        // to tween FROM (the ToolGroupCard's member-append glide). So a body
        // left unpinned by a release — or by standDown, in the rendered case
        // that let this measurement through — gets its pin back here.
        if (body.style.height === '' && measured.height > 0) body.style.height = `${measured.height}px`
        return
      }
      lastHeightRef.current = measured.height
      if (animatingRef.current) {
        // A resize tween is in flight (the fold case returned above) — tear it
        // down and let the branch below replace it. Cancel-and-replace is the
        // animateResize contract; a blanket guard here used to swallow every
        // observation after the first, freezing the body at the first frame's
        // (stale) target until finishOpen snapped to the truth at the end.
        cleanupAnimation()
      }
      // Continuous vs discrete (see RESIZE_COALESCE_MS): an inner animation
      // is followed EXACTLY — its own motion IS the height animation, and
      // tweening on top of it lags the content behind the clip edge — while
      // an isolated jump gets the tween beat.
      const now = performance.now()
      const continuous = now - lastResizeAtRef.current < RESIZE_COALESCE_MS
      lastResizeAtRef.current = now
      if (animateResize && !continuous) {
        // Resize tween: from the current rendered height to the content's new
        // natural height. fade=false — opacity belongs to the open/close beat,
        // not layout motion.
        animateHeight(currentHeight, measured.height, true, false, 'resize')
      } else {
        // Snap-follow. Clear any transition the torn-down tween left on the
        // element so the jump is truly instant.
        body.style.transition = 'none'
        body.style.height = `${measured.height}px`
      }
    })

    observer.observe(content)
    // Fresh attachment, fresh coalesce clock: a quick fold+reopen (which
    // re-runs this effect) must not inherit a timestamp that makes the first
    // post-reopen observation read as "continuous".
    lastResizeAtRef.current = -Infinity
    return () => observer.disconnect()
  }, [animateHeight, animateResize, cleanupAnimation, open, remeasureWhileClamped, rendered, unmountOnExit])

  useEffect(() => () => cleanupAnimation(), [cleanupAnimation])

  if (!rendered) return null

  return (
    <div
      ref={bodyRef}
      className={`animated-collapse${className ? ` ${className}` : ''}`}
    >
      <div
        ref={contentRef}
        id={id}
        className={`animated-collapse-content${contentClassName ? ` ${contentClassName}` : ''}`}
      >
        {renderedChildren}
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
