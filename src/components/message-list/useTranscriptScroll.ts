/**
 * L3 of the transcript list: SCROLL BEHAVIOUR.
 *
 * Everything that reads or writes the scroller's geometry lives here — the
 * bottom-follow gate, the jump-to-bottom button state, the unseen badge, the
 * rAF follow animation, and the three re-pin backstops. It used to be spread
 * across ~600 lines of `MessageList`, interleaved with row derivation and
 * message rendering, which is why each observer's comment had to explain why it
 * doesn't fight the other two.
 *
 * The model, in one place:
 *
 *   FOLLOWING   `shouldFollowRef` true. New content pins the viewport to the
 *               bottom. This is the resting state.
 *   AWAY        The user scrolled up. Follow is off, the jump button is
 *               visible, and new content increments the unseen badge. Entered
 *               only by a genuine upward scroll ('disable-now') or by the
 *               follow-disable debounce confirming a settled non-bottom
 *               geometry. Left by scrolling back to the real bottom or by
 *               pressing jump-to-bottom.
 *   ANIMATING   `scrollAnimatingRef` true for the duration of a programmatic
 *               scroll (follow or jump). Mid-animation the viewport is
 *               intentionally not at the bottom, so every geometry consumer
 *               short-circuits while this is set — otherwise the 150ms
 *               follow-disable debounce fires mid-flight and drops us to AWAY.
 *
 * Writes to `scrollTop` go through exactly two paths: `pinToBottom` (instant
 * snap, used by the three re-pin backstops) and `animateScrollToBottom` (the
 * rAF easing loop). Keeping that list at two is the point of this module — a
 * third writer added elsewhere is how the viewport ends up fighting itself.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import { useLocalStorage } from '../../hooks/useLocalStorage'

/** Pixel tolerance for direct bottom checks. Keep this tiny to cover
 *  fractional scroll values without treating a visibly offset viewport as
 *  being at the bottom. */
const BOTTOM_EPSILON_PX = 2

/**
 * Height of the bottom-overlay spacer currently rendered in Virtuoso's Footer
 * slot, or 0 when there is none.
 *
 * Excluded from every "how far from the bottom are we" calculation: the spacer
 * reserves room for the absolutely-positioned live typing bubble AND the task
 * cards stacked beneath it, so counting it would make a viewport that is
 * visually pinned to the last settled message read as ~110px short of the
 * bottom.
 */
const getBottomSpacerHeight = (el: HTMLElement) => {
  const spacer = el.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
  if (!spacer) return 0

  const rectHeight = spacer.getBoundingClientRect().height
  if (rectHeight > 0) return rectHeight

  // Layout hasn't measured the spacer yet (or we're in an environment without
  // a layout engine): fall back to the height we asked for.
  const styleHeight = Number.parseFloat(spacer.style.height || getComputedStyle(spacer).height)
  return Number.isFinite(styleHeight) ? styleHeight : 0
}

const getDistanceFromBottom = (el: HTMLElement) => (
  Math.max(0, el.scrollHeight - getBottomSpacerHeight(el) - el.scrollTop - el.clientHeight)
)

/**
 * Distance from the TRUE bottom of the scroll content — `scrollHeight`, with NO
 * spacer subtraction.
 *
 * Why a second metric? The spacer-aware `getDistanceFromBottom` above is right
 * for the BUTTON and the "at bottom" state (a viewport resting above the task
 * list / live bubble should read as at-bottom), but it is WRONG for the
 * user-leave gate: because the spacer height is subtracted, an up-scroll that
 * stays inside the spacer reads as `0`, so `shouldFollowRef` never turns off
 * and the re-pin backstops keep snapping the viewport back down ("wheel-up gets
 * absorbed").
 *
 * The true-bottom distance is keyed to `scrollHeight`, which is where
 * `pinToBottom` parks the viewport when following. Any net upward scroll from
 * there is a genuine user leave; an animated group FOLD clamps `scrollTop`
 * down in lockstep as `scrollHeight` shrinks, so this distance stays ≈ 0 there
 * and is not mistaken for a leave.
 */
const getDistanceFromTrueBottom = (el: HTMLElement) => (
  Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
)

const getBottomGeometry = (el: HTMLElement) => {
  const distanceFromBottom = getDistanceFromBottom(el)
  const atBottom = distanceFromBottom <= BOTTOM_EPSILON_PX
  return { atBottom, canJumpToBottom: !atBottom }
}

/** True when the viewport is parked at the very bottom (scrollHeight) — the
 *  only geometry that may re-arm follow. Distinct from
 *  `getBottomGeometry().atBottom`, which also covers the spacer-reserved dead
 *  zone (see `getDistanceFromTrueBottom`). */
const isAtTrueBottom = (el: HTMLElement) => getDistanceFromTrueBottom(el) <= BOTTOM_EPSILON_PX

type FollowMode = 'restore' | 'disable-now' | 'disable-debounced' | 'preserve'
type BottomSyncMode = FollowMode | 'confirm-away'

export interface UseTranscriptScrollOptions {
  /** Shared handle so seeks can fall back to Virtuoso's index API before the
   *  scroller element exists. */
  virtuosoRef: RefObject<VirtuosoHandle | null>
  /** Overlay-scrollbar attach callback; wired from the same ref callback that
   *  captures the scroller. */
  setOsScroller: (el: HTMLElement | null) => void
  /** Rendered row count. Re-arms the DOM listeners whose closures capture the
   *  scroller element, which Virtuoso can swap as the list grows. */
  rowCount: number
  /** Raw transcript length. Drives the synchronous append pin — it must react
   *  to the underlying items, not the filtered rows, because a flush can grow
   *  `items` without changing the row count. */
  itemCount: number
  /** Rows that should tick the unseen badge (parent-filtered, non-hidden). */
  trackedCount: number
  /** Transcript identity. The inner scroller remounts when it changes, so
   *  element-bound observers must re-attach and all state must reset. */
  transcriptRevealKey: string | undefined
  /** Committed height of the bottom-overlay spacer. Owned by the caller
   *  because it also drives the Footer slot. */
  bottomStackHeight: number
  /**
   * The top-most VISIBLE row changed, reported in Virtuoso's offset space
   * (dataIndex + firstItemIndex) — same space as `rangeChanged`.
   *
   * Measured from geometry rather than taken from Virtuoso's reported range:
   * `rangeChanged` reports the RENDERED range, which `increaseViewportBy.top`
   * deliberately extends above the fold, so its `startIndex` sits ~600px too
   * high. Consumers that mean "what is the user actually looking at" (the
   * pinned question header, search's nearest-match, prev/next user-message
   * navigation) need the real top.
   *
   * Fires only when the index changes. Held in a ref internally, so the
   * callback's identity may change freely without re-binding listeners.
   */
  onVisibleTopChange?: (offsetIndex: number) => void
}

export interface TranscriptScrollApi {
  /** True when the viewport is at the real bottom. Drives the jump button. */
  atBottom: boolean
  canJumpToBottom: boolean
  /** New messages that arrived while AWAY. Badge on the jump button. */
  unseenCount: number
  /** Virtuoso `scrollerRef`. */
  scrollerRefCb: (ref: HTMLElement | Window | null) => void
  /** Virtuoso `followOutput`. Always returns false — we drive the follow
   *  scroll ourselves so Virtuoso doesn't animate against us. */
  followOutput: (atBottom: boolean) => false
  /** Virtuoso `atBottomStateChange`. */
  atBottomStateChange: (reportedAtBottom: boolean) => void
  /** Jump-to-bottom button handler. */
  jumpToBottom: () => void
  /**
   * Programmatic seek to a row — search hits, user-message navigation.
   * Suspends follow first, so the seek can't be yanked back by the bottom pin.
   * The ONLY sanctioned way to move the viewport somewhere other than the
   * bottom; callers must not reach for `shouldFollowRef` themselves.
   */
  seekToIndex: (index: number, align: 'start' | 'center') => void
  /**
   * Offset-space index of the top-most VISIBLE row, or null when it can't be
   * measured (no scroller yet, or nothing rendered). Callers that receive a
   * Virtuoso range should prefer this and fall back to the reported
   * `startIndex` — see `onVisibleTopChange` for why the two differ.
   */
  getVisibleTopIndex: () => number | null
}

export function useTranscriptScroll({
  virtuosoRef,
  setOsScroller,
  rowCount,
  itemCount,
  trackedCount,
  transcriptRevealKey,
  bottomStackHeight,
  onVisibleTopChange,
}: UseTranscriptScrollOptions): TranscriptScrollApi {
  // Virtuoso's underlying scroll element. Captured through scrollerRefCb.
  const scrollerRef = useRef<HTMLElement | null>(null)
  // `atBottom` is state (not just a ref) because the jump-to-bottom button's
  // visibility needs to re-render when it changes. The ref-mirror keeps
  // callbacks readable without a stale-closure dance.
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const [canJumpToBottom, setCanJumpToBottom] = useState(false)
  // Debounced "should follow" — filters out transient isAtBottom=false spikes
  // Virtuoso emits during rapid/batch item additions (the scroll-to-bottom
  // animation hasn't settled yet, so its internal isAtBottom momentarily flips
  // false). Only after isAtBottom stays false for FOLLOW_DEBOUNCE_MS do we
  // actually stop following.
  const shouldFollowRef = useRef(true)
  const followTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Previous scrollTop, so the scroll handler can detect *user-driven* upward
  // scrolls (scrollTop decreasing) and bypass the follow-disable debounce.
  const lastScrollTopRef = useRef(0)
  // Held TRUE for the whole of a programmatic scroll-to-bottom animation. See
  // the ANIMATING state in the module comment: while set, the scroll handler
  // and syncBottomGeometry leave atBottomRef/shouldFollowRef alone. Bounded by
  // the rAF loop's own completion or cancellation, so it can never latch.
  const scrollAnimatingRef = useRef(false)
  // rAF handle for the in-flight animated scroll, so a new jump (or unmount)
  // cancels the previous loop instead of stacking two that fight over
  // scrollTop.
  const scrollAnimRafRef = useRef<number | null>(null)
  const [followDebounceRaw] = useLocalStorage<number>(
    'claude-react-web:follow-debounce-ms',
    150,
  )
  const FOLLOW_DEBOUNCE_MS = Math.max(50, Math.min(500, Math.round(followDebounceRaw)))
  /** How many new messages have arrived since the user last saw the bottom. */
  const [unseenCount, setUnseenCount] = useState(0)
  const unseenCountRef = useRef(0)

  /**
   * The instant-snap scrollTop writer. One of only two places that move the
   * viewport (the other is the rAF loop in `animateScrollToBottom`).
   *
   * Every caller is a measurement CORRECTION — content grew or the viewport
   * shrank after we had already pinned — so the snap reads as "settle to
   * bottom", not as a jump, and must not animate. The shared gate lives here so
   * a new backstop can't forget it: never yank a user who has scrolled up.
   *
   * `allowDuringAnimation` exists for the append pin only. The two
   * ResizeObserver backstops must stand down mid-animation (the rAF loop
   * re-targets every frame, so a competing snap would fight it), but the append
   * pin's whole job is to paint a freshly-mounted row at the bottom in the frame
   * it mounts — and a follow animation is usually still in flight at that
   * moment, so honouring the guard there would disable it exactly when it
   * matters. Snapping ahead of the animation is safe: the loop re-reads its
   * target each frame, finds `remaining ≈ 0`, and finalizes.
   */
  const pinToBottom = useCallback((
    el: HTMLElement | null = scrollerRef.current,
    { allowDuringAnimation = false }: { allowDuringAnimation?: boolean } = {},
  ) => {
    if (!el) return
    if (!shouldFollowRef.current) return
    if (scrollAnimatingRef.current && !allowDuringAnimation) return
    el.scrollTop = el.scrollHeight
  }, [])

  // Synchronous bottom-pin for freshly-appended trailing items.
  //
  // Root cause of the "new message flashes one row too high, then snaps down"
  // jitter: when `items` grows, Virtuoso has already grown `scrollHeight` to
  // include the new row by the time React commits (the sizer is up to date),
  // but `scrollTop` is still at the OLD bottom. The follow-scroll
  // (`followOutput` → `animateScrollToBottom`) only runs its first step on the
  // NEXT requestAnimationFrame, so the browser paints one frame with the new
  // row pushed ~1 row below the viewport bottom (equivalently: the transcript
  // sitting one row too high). That single stale-scrollTop frame is the
  // visible jump.
  //
  // Fix: pin right here in useLayoutEffect — after the DOM mutation, BEFORE
  // paint — so the new row is painted at the bottom in the very frame it
  // mounts. `scrollHeight` is already correct at this point, so this is an
  // exact pin, not an estimate. The rAF ease still runs afterward but finds
  // `remaining ≈ 0` and finalizes immediately, so the two never fight — which
  // is why this pin deliberately ignores the in-flight-animation guard.
  const prevPinItemsLenRef = useRef(itemCount)
  useLayoutEffect(() => {
    const prevLen = prevPinItemsLenRef.current
    prevPinItemsLenRef.current = itemCount
    if (itemCount <= prevLen) return
    pinToBottom(scrollerRef.current, { allowDuringAnimation: true })
  })

  const clearFollowTimer = useCallback(() => {
    if (followTimerRef.current == null) return
    clearTimeout(followTimerRef.current)
    followTimerRef.current = null
  }, [])

  const clearUnseen = useCallback(() => {
    if (unseenCountRef.current === 0) return
    unseenCountRef.current = 0
    setUnseenCount(0)
  }, [])

  const setBottomState = useCallback((nextAtBottom: boolean) => {
    if (atBottomRef.current === nextAtBottom) return
    atBottomRef.current = nextAtBottom
    setAtBottom(nextAtBottom)
  }, [])

  const scrollScrollerToBottom = useCallback((behavior: 'auto' | 'smooth' = 'auto') => {
    const el = scrollerRef.current
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior })
      return
    }
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior })
  }, [virtuosoRef])

  const syncBottomState = useCallback((
    nextAtBottom: boolean,
    followMode: FollowMode,
  ) => {
    if (nextAtBottom || followMode !== 'disable-debounced') {
      setBottomState(nextAtBottom)
    }

    if (nextAtBottom && shouldFollowRef.current) {
      clearUnseen()
    }

    if (followMode === 'restore') {
      clearFollowTimer()
      shouldFollowRef.current = true
      setCanJumpToBottom(false)
      // The generic clear above is gated on shouldFollowRef, so an arrive
      // from AWAY (follow was off) has to clear here, after re-arming.
      clearUnseen()
      return
    }

    if (followMode === 'disable-now') {
      // Genuine user scroll-away: the user drilled up out of the bottom, so
      // the jump-to-bottom button SHOULD surface immediately. (In contrast,
      // 'disable-debounced' below must never do this while we're still
      // following — a transient geometry flutter during a bulk replay isn't a
      // user leave.)
      clearFollowTimer()
      shouldFollowRef.current = false
      setCanJumpToBottom(true)
      setBottomState(false)
      return
    }

    if (followMode === 'disable-debounced' && followTimerRef.current == null) {
      followTimerRef.current = setTimeout(() => {
        followTimerRef.current = null
        const el = scrollerRef.current
        if (!el) {
          setCanJumpToBottom(false)
          setBottomState(false)
          return
        }

        const geometry = getBottomGeometry(el)

        // While still following/pinned, a not-at-bottom geometry read is a
        // pin-lag (content grew before the follow/pin caught up), never a
        // genuine leave. Doing anything here — showing the button OR flipping
        // shouldFollowRef false — is exactly what flashed the jump button
        // across every bulk-load batch on session switches: the 150ms timer
        // fired during the transient, armed a "leave", and disarmed the
        // following gate so subsequent geo reads surfaced the button too. Until
        // the user has actually scrolled up (which trips 'disable-now'), keep
        // following and keep the button hidden; the content-growth pin will
        // snap back.
        if (shouldFollowRef.current) {
          return
        }

        // Already away: reflect the real settled geometry — show the button
        // when below is unavailable-looking / away, restore follow when back
        // at the TRUE bottom. Restoring while still inside the dead zone
        // (spacer-aware at-bottom) would re-latch follow and re-arm the re-pin
        // backstops that snap the viewport back down.
        if (isAtTrueBottom(el)) {
          setCanJumpToBottom(false)
          setBottomState(true)
          shouldFollowRef.current = true
          clearUnseen()
        } else if (geometry.atBottom) {
          // Settled inside the dead zone while away: keep the leave — button
          // stays up so the user has the affordance (and the badge keeps
          // counting new arrivals).
          setCanJumpToBottom(true)
          setBottomState(false)
        } else {
          setCanJumpToBottom(geometry.canJumpToBottom)
          setBottomState(geometry.atBottom)
        }
      }, FOLLOW_DEBOUNCE_MS)
    }
  }, [FOLLOW_DEBOUNCE_MS, clearFollowTimer, clearUnseen, setBottomState])

  const syncBottomGeometry = useCallback((
    el: HTMLElement | null = scrollerRef.current,
    modeWhenAway: BottomSyncMode = 'preserve',
  ) => {
    if (!el) {
      setCanJumpToBottom(false)
      return null
    }
    // ANIMATING: the viewport is intentionally not yet at the bottom. Don't let
    // that mid-animation gap arm the follow-disable debounce or flip
    // atBottomRef false (which would re-show the jump button and disarm the
    // re-pin paths the animation depends on). Treat the viewport as
    // still-at-bottom until the rAF loop completes and clears the guard.
    if (scrollAnimatingRef.current) {
      return getBottomGeometry(el)
    }
    const geometry = getBottomGeometry(el)
    // The top of the real bottom: the viewport parked at scrollHeight (what
    // pinToBottom targets). Follow re-arms ONLY here. The spacer-aware
    // `geometry.atBottom` also covers the dead zone (the region reserved by the
    // task list / live bubble) — re-latching follow there is exactly the state
    // that lets the re-pin backstops snap an upward scroll back down.
    const atTrueBottom = isAtTrueBottom(el)
    const delayAway = modeWhenAway === 'confirm-away' && !geometry.atBottom && atBottomRef.current
    // Never surface the jump button while we're still auto-following / pinned
    // to the bottom. During a bulk replay/load the content (scrollHeight) grows
    // faster than the follow/pin can move scrollTop, so a raw geometry read
    // transiently reports "not at bottom" mid-pin and then "at bottom" again
    // once the pin catches up — flashing the button on/off every growth batch
    // even though the user never left the bottom. The button only becomes
    // meaningful once follow has been disabled — either the user scrolled up
    // ('disable-now' flips shouldFollowRef false immediately) or the 150ms
    // follow-disable debounce confirmed a genuine stay-away. Once AWAY, the
    // button is always offered — including inside the dead zone, where the
    // spacer-aware `geometry.canJumpToBottom` (false) would otherwise hide it
    // and park an away user with no affordance.
    const following = shouldFollowRef.current
    const canJump = !following
    setCanJumpToBottom(delayAway ? false : canJump)
    const userLeft = modeWhenAway === 'disable-now'
    // Follow re-arms ONLY when the user is at the true bottom AND either (a)
    // they were already following (a passive re-read / content fold keeps it
    // on), or (b) this call is the scroll handler reporting an active
    // scroll-BACK-down to the true bottom ('restore'). A passive re-read that
    // lands at the true bottom while the user is AWAY — notably a bottom-spacer
    // collapse clamping scrollTop down to the new max — must NOT re-latch,
    // because the content moved, not the user; re-latching is what lets the
    // re-pin backstops snap an away viewport back.
    const followMode = userLeft
      ? 'disable-now'
      : (atTrueBottom && (following || modeWhenAway === 'restore'))
        ? 'restore'
        : geometry.atBottom
          ? (following ? 'preserve' : 'disable-now')
          : modeWhenAway === 'confirm-away'
            ? 'disable-debounced'
            : modeWhenAway === 'restore' ? 'preserve' : modeWhenAway
    syncBottomState(geometry.atBottom, followMode)
    return geometry
  }, [syncBottomState])

  // Animated scroll-to-bottom driven by a requestAnimationFrame easing loop.
  //
  // Why not native `behavior: 'smooth'`? `el.scrollTo({ top: scrollHeight,
  // smooth })` captures `scrollHeight` ONCE at call time and animates toward
  // that stale pixel over ~300ms. While the animation runs, any content growth
  // (streaming text mirroring into the spacer Footer, Virtuoso row-height
  // measurement settling, lazy images/code blocks) moves the real bottom past
  // the captured target, so the animation lands short — and with atBottomRef
  // momentarily false, the re-pin guards skip, so nothing corrects it. That was
  // the intermittent "sometimes doesn't scroll to bottom" bug.
  //
  // Fix: re-read `el.scrollHeight` on EVERY frame and ease scrollTop toward the
  // fresh target. The target can never go stale because it is refreshed each
  // frame, so the animation always terminates exactly at the real bottom no
  // matter how content grows mid-flight. The loop also cancels itself if it
  // detects the user scrolled up mid-animation (scrollTop dropped below the
  // last value we set), so we never fight a legitimate user scroll.
  const animateScrollToBottom = useCallback(() => {
    // Cancel any in-flight animation before starting a new one.
    if (scrollAnimRafRef.current != null) {
      cancelAnimationFrame(scrollAnimRafRef.current)
      scrollAnimRafRef.current = null
    }
    const el = scrollerRef.current
    if (!el) {
      // No scroller yet — fall back to Virtuoso's index API.
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' })
      return
    }
    scrollAnimatingRef.current = true
    let lastSetTop = el.scrollTop
    const step = () => {
      scrollAnimRafRef.current = null
      // Re-read the target every frame so it can never go stale.
      const target = el.scrollHeight - el.clientHeight
      const current = el.scrollTop
      // User scrolled up mid-animation — abort and let the normal scroll
      // handler take over (it will latch user-intent and disable follow).
      if (current < lastSetTop - BOTTOM_EPSILON_PX) {
        scrollAnimatingRef.current = false
        return
      }
      const remaining = target - current
      if (remaining <= BOTTOM_EPSILON_PX) {
        // Snap the last sub-pixel and finalize.
        el.scrollTo({ top: target, behavior: 'auto' })
        scrollAnimatingRef.current = false
        // Confirm bottom state now that we've truly arrived; the guard is
        // already false so this sync runs for real.
        syncBottomGeometry(el, 'confirm-away')
        return
      }
      // Ease toward the target: cover ~25% of the remaining distance per frame
      // → ~250-350ms for typical chat heights, matching native smooth scroll.
      const next = current + remaining * 0.25
      el.scrollTo({ top: next, behavior: 'auto' })
      lastSetTop = next
      scrollAnimRafRef.current = requestAnimationFrame(step)
    }
    scrollAnimRafRef.current = requestAnimationFrame(step)
  }, [syncBottomGeometry, virtuosoRef])

  // --- Unseen badge -------------------------------------------------------
  const lastCountRef = useRef(0)
  // Session switch: the inner scroller remounts (Virtuoso is keyed on the
  // transcript), but this hook's owner persists. Reset all bottom/scroll/unseen
  // state so stale values from the old transcript don't leak into the new one —
  // a phantom badge, or a stale atBottomRef=false that makes the new
  // transcript's first message increment unseenCount instead of clearing it.
  // MUST run before the tracked-count effect below so lastCountRef is 0 when
  // that effect computes its delta (otherwise the delta is the full new count).
  //
  // Both `atBottom` and `canJumpToBottom` STATE are reset here, not just the
  // refs: the owner isn't keyed on the transcript, so a stale
  // `canJumpToBottom=true / atBottom=false` would render the jump button on the
  // new transcript's very first frame (the button is a SIBLING of the
  // reveal-hidden list and stays visible) — a one-frame stale flash.
  // reduced-motion users can't rely on `.chat-messages-reveal-pending
  // { opacity: 0 }` hiding it either, so the state reset is the only reliable
  // one. Geometry re-syncs on the new scroller after Virtuoso remounts.
  useEffect(() => {
    clearUnseen()
    clearFollowTimer()
    atBottomRef.current = true
    shouldFollowRef.current = true
    lastCountRef.current = 0
    // Intentional one-shot reset on a rare event (transcript switch). The
    // cascading-render cost the rule guards against is irrelevant here — it's a
    // single commit after a persisted-owner remount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAtBottom(true)
    setCanJumpToBottom(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptRevealKey])

  useEffect(() => {
    const delta = trackedCount - lastCountRef.current
    lastCountRef.current = trackedCount
    if (delta <= 0) {
      // Rows shrank (compact_boundary, /clear, upstream trimming) — a
      // structural reduction isn't "new messages the user missed," so reset the
      // badge rather than leaving a stale count that overstates how many
      // messages are below the viewport.
      if (delta < 0) clearUnseen()
      return
    }
    if (atBottomRef.current) {
      clearUnseen()
    } else {
      // Keep the ref in lockstep with state: the bottom-state sync reads
      // `unseenCountRef.current` to decide whether to clear. Updating only
      // state would leave the ref at 0 and the handler would silently no-op,
      // leaving the badge stuck.
      unseenCountRef.current += delta
      setUnseenCount(unseenCountRef.current)
    }
  }, [clearUnseen, trackedCount])

  // --- Re-pin backstops ---------------------------------------------------

  // Viewport geometry trigger: panels above/below the scroller can change the
  // available height without firing a scroll event. Keep the jump button and
  // bottom-follow state in sync with the real DOM geometry on every resize.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastHeight = el.clientHeight
    const ro = new ResizeObserver(() => {
      const current = scrollerRef.current
      if (!current) return
      syncBottomGeometry(current, 'confirm-away')
      const now = current.clientHeight
      const shrunk = now < lastHeight
      lastHeight = now
      if (shrunk && atBottomRef.current) {
        scrollScrollerToBottom('auto')
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [rowCount, scrollScrollerToBottom, syncBottomGeometry])

  // Re-pin AFTER the bottom spacer commits its new height.
  //
  // Root cause of "the scrollbar sits one line short of the bottom while the
  // bottom stack's height is changing": the caller's ResizeObserver measures
  // the stack (live bubble + task cards) and sets `bottomStackHeight`, which
  // resizes the Virtuoso Footer spacer that reserves room for it. That state
  // update is asynchronous — the spacer's new height only lands once React
  // commits, which is AFTER the ResizeObserver callback returns. Reading
  // scrollHeight inside that callback therefore reads the STALE bottom and pins
  // there; once the spacer grows, the viewport is left one line short.
  //
  // The content-growth backstop below does not catch this: it observes
  // Virtuoso's item-list, and the bottom spacer lives in the Footer slot — a
  // SIBLING of the item-list — so an item-list ResizeObserver never fires when
  // the spacer resizes.
  //
  // Pinning here, in a layout effect keyed on the spacer height, runs AFTER
  // React has committed the new spacer (so scrollHeight is fresh) but BEFORE
  // paint, so the viewport is at the real bottom in the very frame it grows.
  useLayoutEffect(() => {
    // <= 0 means no spacer is rendered (the Footer is gated on it), so there is
    // nothing to re-pin for — skip, to avoid yanking the viewport on mount or
    // after streaming ends when a non-bottom position may be intentional.
    if (bottomStackHeight <= 0) return
    pinToBottom()
  }, [bottomStackHeight, pinToBottom])

  // Re-pin when SETTLED content grows AFTER the follow animation has already
  // finalized. Root cause of "a tall message (or a rapid burst) lands partway
  // down instead of at the bottom":
  //
  // When rows grow, the append pin and the rAF follow both read `scrollHeight`
  // at a moment when Virtuoso is still counting the freshly-mounted tail row at
  // its ESTIMATED height (it measures real heights asynchronously, after
  // paint). The rAF loop sees `remaining ≈ 0` at that estimated bottom and
  // finalizes, clearing the ANIMATING guard. A frame later Virtuoso measures
  // the row's real (much larger) height, `scrollHeight` grows downward, but
  // `scrollTop` stays at the stale estimated bottom — so the viewport sits
  // mid-way through the new content. No `scroll` event fires (scrollTop didn't
  // move) so the scroll handler can't correct it, and the 150ms debounce
  // disarms follow before anything re-pins. A burst stacks the same race.
  //
  // The viewport observer above watches clientHeight for shrink; the spacer
  // effect watches the live typing bubble. Neither catches settled-content
  // growth. This observer fills that gap by watching Virtuoso's ITEM-LIST,
  // whose border-box height tracks the rendered items.
  //
  // Why the item-list and NOT scroller.firstElementChild: that first child is
  // Virtuoso's viewport, which is height:100% / position:absolute — fixed to
  // the scroller, so it never resizes on content growth. Observing it (an
  // earlier implementation) meant this backstop never fired for its intended
  // purpose, so the "tall message lands partway" bug stayed latent.
  //
  // Re-attached on `transcriptRevealKey` because Virtuoso remounts (new
  // scroller + item-list) on a transcript switch — a long-lived `[]`-deps form
  // held a stale reference to the previous list and went dead after the first
  // switch.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    let cancelled = false
    let raf = 0
    // Content-only baseline (scrollHeight MINUS the live streaming spacer),
    // tracked monotonically. The spacer must be excluded rather than tracking
    // raw scrollHeight: it inflates scrollHeight while a turn is active, and
    // when the turn ends and the footer exits, the shrink is skipped by the
    // "only fire on growth" guard WITHOUT decrementing the baseline — leaving
    // it inflated by ~110px. Any post-exit growth smaller than that inflation
    // (notably Virtuoso's async re-measurement of the just-landed final
    // assistant message at its real Markdown height, which routinely lands
    // after the spacer is gone because the SDK emits `result` only ~15ms after
    // the `assistant` frame) would then read as no growth and be skipped — so
    // the viewport never re-pinned and landed short (the "bounces up a bit when
    // the streaming footer disappears" jolt).
    let lastContentHeight = 0
    const contentHeightOf = (scroller: HTMLElement) =>
      scroller.scrollHeight - getBottomSpacerHeight(scroller)
    const ro = new ResizeObserver(() => {
      if (cancelled) return
      const scroller = scrollerRef.current
      if (!scroller) return
      if (!shouldFollowRef.current || scrollAnimatingRef.current) return
      const contentH = contentHeightOf(scroller)
      if (Math.abs(contentH - lastContentHeight) < 1) return
      lastContentHeight = contentH
      // Re-pin on shrink as well as growth while following. A group folding
      // ABOVE the viewport reduces scrollHeight; with the viewport pinned to
      // the old bottom, no scroll event fires to correct it (the browser only
      // clamps when scrollTop exceeds the new max), so growth-only tracking
      // would leave the viewport short of the new bottom and the appended
      // boundary/new message below it un-scrolled-to.
      pinToBottom(scroller)
    })
    const attach = () => {
      if (cancelled) return
      const scroller = scrollerRef.current
      if (!scroller) { raf = requestAnimationFrame(attach); return }
      const itemList = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
      if (!itemList) { raf = requestAnimationFrame(attach); return }
      lastContentHeight = contentHeightOf(scroller)
      ro.observe(itemList)
    }
    attach()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [transcriptRevealKey, pinToBottom])

  // --- Visible top row ----------------------------------------------------

  const getVisibleTopIndex = useCallback((): number | null => {
    const el = scrollerRef.current
    if (!el) return null
    const viewportTop = el.getBoundingClientRect().top
    // Virtuoso stamps every rendered row with `data-item-index` in offset
    // space, which is exactly what `rangeChanged` reports — so resolving the
    // visible top this way is a drop-in for it, just without the overscan
    // rows. One layout flush for the scroller rect, then cheap reads.
    const rendered = el.querySelectorAll<HTMLElement>('[data-item-index]')
    for (let i = 0; i < rendered.length; i++) {
      const row = rendered[i]
      if (row.getBoundingClientRect().bottom > viewportTop) {
        const raw = row.dataset.itemIndex
        const parsed = raw == null ? Number.NaN : Number.parseInt(raw, 10)
        return Number.isFinite(parsed) ? parsed : null
      }
    }
    return null
  }, [])

  // Ref-held so a caller can pass an inline callback without re-binding the
  // scroll listener on every render.
  const onVisibleTopChangeRef = useRef(onVisibleTopChange)
  useEffect(() => {
    onVisibleTopChangeRef.current = onVisibleTopChange
  }, [onVisibleTopChange])
  const lastVisibleTopRef = useRef<number | null>(null)
  const emitVisibleTop = useCallback(() => {
    const notify = onVisibleTopChangeRef.current
    if (!notify) return
    const index = getVisibleTopIndex()
    if (index == null || index === lastVisibleTopRef.current) return
    lastVisibleTopRef.current = index
    notify(index)
  }, [getVisibleTopIndex])

  // --- Scroll intent ------------------------------------------------------

  // Authoritative scroll-state listener. Virtuoso's callback can miss native
  // scroll intent, so direct DOM geometry decides whether the viewport is
  // actually at the bottom. Any upward scroll away from that direct bottom
  // state disables follow immediately (→ AWAY), while scrolling back to the
  // real bottom restores follow and clears the unseen badge.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop
    const handler = () => {
      const prevScrollTop = lastScrollTopRef.current
      lastScrollTopRef.current = el.scrollTop
      // Before the ANIMATING guard: the viewport really is moving during a
      // programmatic scroll, so the pinned header and search's nearest-match
      // must keep tracking it. Only the bottom-follow bookkeeping needs to
      // stand down mid-animation.
      emitVisibleTop()
      // ANIMATING: skip the geometry sync entirely. Mid-animation the viewport
      // is intentionally not yet at the bottom; running the sync would see
      // dist>0, arm the 150ms follow-disable debounce, and fire it
      // mid-animation — dropping to AWAY and re-showing the jump button,
      // exactly the race the guard exists to prevent. The rAF loop clears the
      // guard when it lands (or aborts on user scroll-up).
      if (scrollAnimatingRef.current) return
      const isScrollingUp = el.scrollTop < prevScrollTop
      // A genuine user push-away measures against the TRUE bottom
      // (scrollHeight). The spacer-aware `getDistanceFromBottom` subtracts the
      // task-list / live-bubble reserve, so an up-scroll that stays inside it
      // reads as 0 and follow never turns off — and the re-pin backstops then
      // keep snapping the viewport back ("wheel-up gets absorbed"). Any net
      // upward scroll from the true bottom is a user leave; an animated group
      // FOLD clamps scrollTop down in lockstep with the shrinking content
      // bottom, so this distance stays ≈ 0 there and is not a leave.
      const distTrue = getDistanceFromTrueBottom(el)
      const isUserLeave = isScrollingUp && distTrue > BOTTOM_EPSILON_PX
      if (isUserLeave) {
        syncBottomGeometry(el, 'disable-now')
      } else if (!isScrollingUp && distTrue <= BOTTOM_EPSILON_PX) {
        // The user actively scrolled back DOWN to the true bottom — the only
        // scroll-driven path that re-arms follow. A scrollTop drop caused by a
        // bottom-spacer COLLAPSE (task list finishes, clamp back to the new
        // max) must NOT re-latch an away user: the content moved, not them.
        syncBottomGeometry(el, 'restore')
      } else {
        syncBottomGeometry(el, 'preserve')
      }
    }
    syncBottomGeometry(el, 'confirm-away')
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [rowCount, syncBottomGeometry, bottomStackHeight, emitVisibleTop])

  // Clean up the follow debounce timer on unmount.
  useEffect(() => () => {
    clearFollowTimer()
  }, [clearFollowTimer])

  // Cancel any in-flight animated scroll on unmount so a pending rAF callback
  // can't fire after the scroller is gone.
  useEffect(() => () => {
    if (scrollAnimRafRef.current != null) {
      cancelAnimationFrame(scrollAnimRafRef.current)
      scrollAnimRafRef.current = null
    }
    scrollAnimatingRef.current = false
  }, [])

  // --- Virtuoso wiring ----------------------------------------------------

  const scrollerRefCb = useCallback((ref: HTMLElement | Window | null) => {
    const prev = scrollerRef.current
    if (prev && prev !== ref) prev.classList.remove('chat-virtuoso-scroller')
    if (ref && ref instanceof HTMLElement) {
      ref.classList.add('chat-virtuoso-scroller')
      scrollerRef.current = ref
      setOsScroller(ref)
      syncBottomGeometry(ref, 'confirm-away')
      return
    }
    scrollerRef.current = null
    setOsScroller(null)
    syncBottomGeometry(null)
  }, [syncBottomGeometry, setOsScroller])

  // New settled message arrives → Virtuoso calls followOutput. We drive the
  // follow-scroll OURSELVES via `animateScrollToBottom` and return `false` so
  // Virtuoso doesn't also fire its own scroll and fight ours.
  //
  // Why not return 'smooth' (let Virtuoso animate)? Two problems the rAF loop
  // fixes:
  //  1. Stale target. A native smooth scroll captures scrollHeight once at call
  //     time; content growth during the ~300ms animation moves the real bottom
  //     past it and the follow lands short. The rAF loop re-targets every
  //     frame, so it always terminates at the real bottom.
  //  2. Follow-disable race. During a smooth follow the viewport is momentarily
  //     not at bottom; the scroll handler / syncBottomGeometry would see
  //     dist>0, arm the 150ms debounce, and fire it mid-follow — so the NEXT
  //     append isn't followed. The ANIMATING guard short-circuits both for the
  //     whole animation.
  //
  // (The live typing bubble is pinned separately by the spacer layout effect,
  // so this only affects settled-message appends — the standard chat-UI
  // snap-to-new-message.)
  const followOutput = useCallback((_atBottom: boolean) => {
    if (!shouldFollowRef.current) return false as const
    animateScrollToBottom()
    return false as const
  }, [animateScrollToBottom])

  const atBottomStateChange = useCallback((reportedAtBottom: boolean) => {
    // Prefer direct DOM geometry so the button and follow-mode use the same
    // bottom definition. Fall back to Virtuoso's report if the scroller is not
    // attached yet.
    const el = scrollerRef.current
    if (el) {
      syncBottomGeometry(el, 'confirm-away')
      return
    }
    setCanJumpToBottom(!reportedAtBottom)
    syncBottomState(
      reportedAtBottom,
      reportedAtBottom ? 'restore' : 'disable-debounced',
    )
  }, [syncBottomGeometry, syncBottomState])

  const jumpToBottom = useCallback(() => {
    // Animates smoothly to the real bottom via the rAF loop, so unlike native
    // `behavior: 'smooth'` it can never land short when content grows
    // mid-animation.
    //
    // Optimistically return to FOLLOWING before the animation lands, so the
    // backstops stay armed for the duration and beyond:
    //   - shouldFollowRef = true    -> followOutput tracks new appends
    //   - setBottomState(true)      -> atBottomRef=true arms the re-pin paths;
    //                                  also kept true by the ANIMATING guard
    //   - setCanJumpToBottom(false) -> hide the button without a flicker
    //   - clearFollowTimer()        -> cancel any pending disable-debounced
    //                                  timer from the prior scroll-up so it
    //                                  cannot flip follow back off mid-jump
    shouldFollowRef.current = true
    setBottomState(true)
    setCanJumpToBottom(false)
    clearFollowTimer()
    animateScrollToBottom()
    clearUnseen()
  }, [animateScrollToBottom, clearFollowTimer, clearUnseen, setBottomState])

  const seekToIndex = useCallback((index: number, align: 'start' | 'center') => {
    // Leave FOLLOWING so the programmatic scroll isn't yanked back by the
    // bottom pin. Returning to FOLLOWING is the user's call — scrolling back to
    // the bottom, or pressing jump-to-bottom.
    shouldFollowRef.current = false
    virtuosoRef.current?.scrollToIndex({ index, behavior: 'smooth', align })
  }, [virtuosoRef])

  return {
    atBottom,
    canJumpToBottom,
    unseenCount,
    scrollerRefCb,
    followOutput,
    atBottomStateChange,
    jumpToBottom,
    seekToIndex,
    getVisibleTopIndex,
  }
}
