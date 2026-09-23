// Controlled fold wrapper for a long real-user message body.
//
// Measurement, not character count: the clamp threshold is a pixel height
// compared against the MEASUREMENT element's scrollHeight, so images, code
// blocks, font scaling and panel narrowing all factor in automatically.
//
// Two-element split (review finding): the OUTER box owns clipping — inline
// max-height + `overflow: clip` + the fade mask — while the INNER
// `.fold-measure` box owns measurement. The inner box carries no
// max-height of its own (the parent's clamp clips painting, not the
// child's layout box), so its scrollHeight is the natural content height
// in every state. Measuring the clamp box itself would be wrong under
// `overflow: clip`: a clip box is not a scroll container, and reads
// against it are browser-dependent once the parent caps the height.
// `overflow: clip` (not `hidden`) on the outer box is what makes
// Tab-triggered focus scrolling impossible — `hidden` boxes remain
// programmatically scrollable, which would slide the content against the
// fixed fade mask with no way to scroll back.
//
// State is controlled: expansion lives in a Set<foldKey> lifted to
// MessageList so a Virtuoso scroll-away unmount cannot lose it. forceOpen
// bypasses both the clamp AND the toggle — the search-hit rule (mirrors
// ToolGroupCard's hasSearchHit override): a folded body would hide the
// <mark> the user navigated to.
//
// The flip between the rest states TWEENS (explicit height pin → transition
// → land): see the height-tween block below for why the direct class flip
// read as a flicker against the transcript's scroll system.
import { prefersReducedMotion } from '../../utils/reduced-motion'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { IconChevronDown } from '../icons/ToolIcons'
import { FOLD_MAX_PX } from './fold-key'

// Height-tween duration. The inline transition reads the same tokens the CSS
// fold rules use; the raw ms only sizes the transitionend FALLBACK timer (a
// missed event must still land the fold). Keep in lockstep with
// --motion-duration-moderate (240ms) — the same value AnimatedCollapse's
// DEFAULT_DURATION_MS mirrors, with the same accepted coupling.
//
// The inline transition SHORTHAND fully replaces any stylesheet transition
// for the tween's duration, so it must carry mask-size itself — armTween
// commits the band's start/end inline around the armed transition (the class
// flip alone would commit the change under `transition: none`, which never
// animates). mask-size rides at the SAME duration as height: the tile
// (`100%` ↔ `calc(100% + var(--fold-fade-height))`) stays ≥ the box under either
// calc-interpolation model a browser may use, so mask-repeat can never
// stripe the fade band mid-content, and the band tracks the edge exactly.
// The -webkit- alias rides along for engines without unprefixed mask-size
// (a skipped transition entry is per-property, never fatal).
//
// Known edge, accepted: `.theme-transitioning * { transition-property: …
// !important }` (armed for ~250ms on a light/dark flip) beats any inline
// transition, so a toggle landing inside that window snaps instead of
// tweens. Self-healing — the fallback timer still lands the rest state, and
// the pin equals the natural height so nothing stays visually stuck.
//
// Deliberately a third hand-rolled tween core rather than a shared helper
// (the repo already has AnimatedCollapse's animateHeight and the
// useAutoHeightTransition hook): this fold's from-derivation (constant vs
// live box vs re-read after clamp neutralization), clamp-aware land, mask
// endpoints committed around the armed transition, and no-style-prop
// ownership model don't fit either — adopting one would mean growing it
// several new options (land callback, transition override, pre-reflow hook)
// and changing its rAF write timing, with other call sites along for the
// ride. Unifying all three on one parameterized core is the right FOLLOW-UP
// refactor, deliberately out of scope for this fix.
const TWEEN_MS = 240
const TWEEN_TRANSITION = [
  'height var(--motion-duration-moderate) var(--motion-ease-standard)',
  'mask-size var(--motion-duration-moderate) var(--motion-ease-standard)',
  '-webkit-mask-size var(--motion-duration-moderate) var(--motion-ease-standard)',
].join(', ')

interface Props {
  /** Controlled expansion — owned by the parent (MessageList's per-foldKey Set). */
  expanded: boolean
  /** Search hit in this message: render fully open with no toggle. */
  forceOpen?: boolean
  /** Toggle callback — parent flips its lifted state; no local copy here. */
  onToggle: () => void
  children: ReactNode
}

export function FoldableBody({ expanded, forceOpen = false, onToggle, children }: Props) {
  const measureRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  // Stable, page-unique id for the clipped region, so the toggle can point
  // aria-controls at it (mirrors ToolGroupCard's bodyId pattern; multiple
  // folded user bodies can coexist in one transcript).
  const regionId = useId()

  const measure = useCallback(() => {
    const el = measureRef.current
    if (!el) return
    // scrollHeight of the INNER box: never clamped, never clipped, so it
    // always reports the natural content height (the parent's max-height
    // clips painting only — it does not shrink this child's layout box).
    // +1 absorbs sub-pixel rounding so a body exactly at the threshold
    // stays unfolded.
    setOverflows(el.scrollHeight > FOLD_MAX_PX + 1)
  }, [])

  // Measure before paint so an over-long body never flashes unclamped.
  useLayoutEffect(() => {
    measure()
  }, [measure])

  // Content can grow past the threshold after mount (image load, late font,
  // panel resize). happy-dom and older test envs may lack ResizeObserver —
  // skip silently; the initial measure already ran.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const el = measureRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  // `open` (not `expanded`) is what the fold renders: forceOpen is a hard
  // override in BOTH directions — it pins the body open while a search hit
  // is inside it, and it must also win MID-TWEEN (a collapse caught by a
  // search hit lands open immediately; see the tween effect).
  const open = expanded || forceOpen
  const clamped = overflows && !open
  const showToggle = overflows && !forceOpen

  // --- Height tween (Show more / Show less) --------------------------------
  //
  // The rest states are binary (clamped 240px ↔ natural height). Flipping
  // them directly snaps the row in ONE frame; the transcript's scroll system
  // (the item-list ResizeObserver re-pin and the follow invariant in
  // useTranscriptScroll) then corrects scrollTop in a LATER frame — a
  // two-step displacement the eye reads as a flicker. Tweening the height
  // turns the same correction into per-frame lockstep: each frame nudges
  // scrollHeight by a few px and the existing backstops re-pin smoothly.
  // That lockstep is exactly the input they were built for — the animated
  // group FOLD notes in useTranscriptScroll describe this same shape, and
  // ToolGroupCard gets it from AnimatedCollapse the same way.
  //
  // Same technique as AnimatedCollapse: pin the current height, force a
  // reflow, transition to the target, land the rest state on transitionend
  // (timeout fallback for missed events). The bottom fade rides the moving
  // edge for free — .fold-content's mask-size is box-relative, so the mask
  // geometry tracks the animated height without JS.
  //
  // "A tween is in flight" is keyed on tweenCleanupRef !== null — the ONE
  // source of truth, assigned at start and nulled at landing/handover (a
  // separate boolean flag was tried and drifted out of sync: review finding).
  const tweenCleanupRef = useRef<(() => void) | null>(null)
  const openRef = useRef(open)
  // Rest-state mirror for the async finish path: by the time a tween's
  // fallback timer fires, forceOpen (search hit) may have flipped — the land
  // must restore the CURRENT rest state, not the one captured at start.
  // Render-time ref write, same escape hatch as useTranscriptScroll's
  // verifyRef.
  const clampedRef = useRef(clamped)
  /* eslint-disable-next-line react-hooks/refs -- documented above */
  clampedRef.current = clamped

  // Land the rest state: auto height, no transition, no inline clip, no
  // tween mask, clamp per the CURRENT clamped value. All writes share one
  // style recalc, so no intermediate frame can paint between them. The
  // single owner of the rest-state definition — the clamp effect below
  // lands through this too, so toggled and untouched folds can never
  // disagree. Clearing the inline overflow and the tweening class hands
  // painting back to the class rules: `.fold-clamped` clips and fades (the
  // fold cut), the open state does NEITHER (an unmasked, unclipped open box
  // lets the :focus-visible ring of the last descendant paint past the
  // bubble edge, and non-folding bubbles skip the mask compositing pass —
  // the tween's clip and mask are inline and die here with it).
  const landRest = useCallback((el: HTMLDivElement) => {
    el.style.transition = ''
    el.style.height = ''
    el.style.overflow = ''
    el.style.maskImage = ''
    el.style.webkitMaskImage = ''
    el.style.maskSize = ''
    el.style.webkitMaskSize = ''
    el.classList.remove('fold-tweening')
    el.style.maxHeight = clampedRef.current ? `${FOLD_MAX_PX}px` : ''
  }, [])

  // Rest-state clamp, applied imperatively rather than through the style
  // prop. React rewrites style-prop values on every re-render that changes
  // them, and a maxHeight landing MID-TWEEN would cap the box and snap the
  // animation to its end. With no style prop at all, React never touches
  // el.style, and the tween exclusively owns the box while a tween is in
  // flight. (The class still flips declaratively — it only steers the mask,
  // which is safe to transition independently.) At rest the inline height
  // and transition are always empty (the land invariant), so landing here
  // is equivalent to writing maxHeight alone.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (tweenCleanupRef.current != null) return
    landRest(el)
  }, [clamped, landRest])

  useLayoutEffect(() => {
    const el = bodyRef.current
    const measureEl = measureRef.current
    if (!el || !measureEl) return

    // Content shrank below the threshold mid-tween (image unload, panel
    // reflow): the fold is moot — land immediately instead of tweening
    // toward a clamp that no longer applies (whose class flip ALSO just
    // wiped the tween mask via React's className rewrite). Runs before the
    // gates below so it fires regardless of open/forceOpen.
    if (!overflows && tweenCleanupRef.current != null) {
      tweenCleanupRef.current?.()
      tweenCleanupRef.current = null
      landRest(el)
      return
    }

    // forceOpen is a hard override, never tweened — and it must interrupt a
    // tween ALREADY in flight even when `open` itself didn't change (a fresh
    // expand caught by a search hit): the navigated <mark> must be visible
    // now, not in 240ms. Hence this branch runs BEFORE the open gate below,
    // which alone would early-return on an unchanged open.
    if (forceOpen) {
      const wasOpen = openRef.current
      openRef.current = true
      if (tweenCleanupRef.current != null || !wasOpen) {
        tweenCleanupRef.current?.()
        tweenCleanupRef.current = null
        landRest(el)
      }
      return
    }

    if (openRef.current === open) return
    openRef.current = open

    // A running tween hands over: cancel its listeners/timer but KEEP the
    // inline height/transition — the retarget continues from the live box.
    // Read the live INTERPOLATED height before touching anything: once
    // `transition: none` lands, the box snaps to the inline (target) height
    // and the mid-flight position is lost. offsetHeight (used layout
    // height), not a rect: rects carry ancestor transforms, and the panel
    // entrance `scale(0.98)` would read every from-height 2% short — the
    // exact hazard AnimatedCollapse documents.
    const wasTweening = tweenCleanupRef.current != null
    const liveHeight = wasTweening ? el.offsetHeight : 0
    // The live interpolated mask position, so a handover continues the fade
    // from where it visually IS instead of snapping to the new direction's
    // rest endpoint — a mid-slide band would otherwise pop by up to a ramp
    // height in one frame. Empty where computed mask-size is unavailable
    // (test environments) — armTween falls back to the direction default.
    const liveMaskSize = wasTweening
      ? (getComputedStyle(el).maskSize || undefined)
      : undefined
    tweenCleanupRef.current?.()
    tweenCleanupRef.current = null

    const natural = measureEl.scrollHeight
    const to = open ? natural : FOLD_MAX_PX
    // Reduced motion, or nothing to grow into: no pin, no transition — the
    // class flip alone does the work.
    if (natural <= FOLD_MAX_PX || prefersReducedMotion()) {
      landRest(el)
      return
    }

    // Neutralize the clamp BEFORE deriving the start height: a fresh collapse
    // must read the box's natural (auto) height, not the clamp the effect
    // above just re-applied for this same flip.
    el.style.maxHeight = ''

    // Pin → reflow → transition, with the landing machinery. Extracted so
    // the finish reconcile can re-arm toward a re-measured target without
    // duplicating the listener/timer plumbing.
    const armTween = (from: number, target: number, maskFrom?: string) => {
      let done = false
      // The fade rides the moving edge, which requires the mask to be
      // PRESENT for the whole tween with box-relative endpoints committed
      // UNDER the armed transition: the class flip alone would commit the
      // mask-size change at the forced reflow below — under
      // `transition: none` — and snap the band instead of sliding it.
      // Start = the pre-click rest look (expand: band on the edge; collapse:
      // band fully below the box, invisible), end = the target rest look.
      // Both endpoints are box-relative (the 100% part tracks the live box
      // every frame), so the band tracks the edge in both directions; the
      // below-edge offset is the stylesheet's fade ramp height via the
      // shared --fold-fade-height custom property, so the band's top lands
      // exactly at the box edge when fully below it.
      const belowEdge = '100% calc(100% + var(--fold-fade-height))'
      const maskStart = maskFrom ?? (open ? '100% 100%' : belowEdge)
      const maskEnd = open ? belowEdge : '100% 100%'
      el.style.transition = 'none'
      el.style.height = `${Math.max(0, from)}px`
      // Clip while the pin is below the content — inline, because overflow
      // lives on `.fold-clamped` only (an OPEN fold must stay unclipped so
      // descendant :focus-visible rings paint past the edge). The double
      // write is the inline equivalent of the stylesheet's hidden-then-clip
      // fallback: an engine without `clip` keeps `hidden`.
      el.style.overflow = 'hidden'
      el.style.overflow = 'clip'
      el.classList.add('fold-tweening')
      el.style.maskSize = maskStart
      el.style.webkitMaskSize = maskStart
      void el.offsetHeight
      el.style.transition = TWEEN_TRANSITION
      el.style.height = `${target}px`
      el.style.maskSize = maskEnd
      el.style.webkitMaskSize = maskEnd

      const finish = () => {
        if (done) return
        done = true
        el.removeEventListener('transitionend', onEnd)
        window.clearTimeout(timer)
        tweenCleanupRef.current = null
        // Reconcile mid-flight content growth (an image landing inside the
        // body during the 240ms): continue toward the re-measured natural
        // instead of snapping the moment the pin clears — AnimatedCollapse
        // reconciles at land for the same reason. Collapse needs no
        // reconcile: the clamp caps whatever the content does.
        //
        // scrollHeight (not offsetHeight) is the SAME read the overflow
        // measurement above has always used, and it is safe from the
        // "clipped box reports its pin" quirk AnimatedCollapse documents:
        // that quirk hit a box SIZED by the pin; `.fold-measure` is an
        // auto-height block child whose layout a parent pin never touches —
        // and the pre-tween fold measured over this exact structure in
        // production (under the quirk, Show more could never have appeared).
        //
        // All height reads are integer, so on fractional layouts (browser
        // zoom, non-integer DPR) the land can settle ≤1px from the last
        // pinned frame. Accepted: the fractional alternative (rect reads)
        // carries the ancestor-transform hazard — the panel entrance
        // `scale(0.98)` skews every rect by 2% — worth more than an
        // imperceptible 1px settle.
        if (open && Math.abs(measureEl.scrollHeight - target) > 1) {
          // Re-arm with the mask parked at its committed below-edge end —
          // restarting from the edge would pop the fade the user just
          // watched slide away back ONTO the box for a second cycle.
          armTween(el.offsetHeight, measureEl.scrollHeight, belowEdge)
          return
        }
        landRest(el)
      }
      const onEnd = (event: TransitionEvent) => {
        if (event.target === el && event.propertyName === 'height') finish()
      }
      const timer = window.setTimeout(finish, TWEEN_MS + 120)
      el.addEventListener('transitionend', onEnd)
      tweenCleanupRef.current = () => {
        if (done) return
        done = true
        el.removeEventListener('transitionend', onEnd)
        window.clearTimeout(timer)
        // Handover, not landing: the inline height/transition stay so the
        // retarget re-pins from the live box.
      }
    }

    // Start height. A handover continues from the live interpolated height
    // captured above; a fresh collapse reads the (now unclamped) box; a
    // fresh expand starts at the CLAMPED rest height as a constant — the
    // clamp is already gone at this point, so the live box would read the
    // natural height and the tween would degenerate to a no-op.
    const from = wasTweening
      ? liveHeight
      : !open
        ? el.offsetHeight
        : FOLD_MAX_PX
    if (Math.abs(to - from) < 2) {
      landRest(el)
      return
    }
    armTween(from, to, liveMaskSize)
  }, [open, forceOpen, overflows, landRest])

  // Unmount mid-tween (Virtuoso scroll-away unmounts rows): stop the timer
  // and listener so nothing writes styles to a detached node (mirrors
  // AnimatedCollapse's unmount cleanup).
  useEffect(() => () => {
    tweenCleanupRef.current?.()
    tweenCleanupRef.current = null
  }, [])

  return (
    <>
      <div
        ref={bodyRef}
        id={regionId}
        className={clamped ? 'fold-content fold-clamped' : 'fold-content'}
      >
        <div ref={measureRef} className="fold-measure">{children}</div>
      </div>
      {showToggle && (
        <div className="fold-toggle-row">
          <button
            type="button"
            className="fold-toggle"
            aria-expanded={open}
            aria-controls={regionId}
            onClick={onToggle}
          >
            <IconChevronDown size={12} className={open ? 'fold-toggle-chev open' : 'fold-toggle-chev'} />
            {open ? 'Show less' : 'Show more'}
          </button>
        </div>
      )}
    </>
  )
}
