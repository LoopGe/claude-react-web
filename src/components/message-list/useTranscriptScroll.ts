/**
 * L3 of the transcript list: SCROLL BEHAVIOUR.
 *
 * Everything that reads or writes the scroller's geometry lives here — the
 * bottom-follow gate (mirrored out as `following` state), the rAF follow
 * animation, the re-pin backstops and the settle verification pass.
 * It used to be spread across ~600 lines of `MessageList`, interleaved with row
 * derivation and message rendering, which is why each observer's comment had to
 * explain why it doesn't fight the other two.
 *
 * The model, in one place:
 *
 *   FOLLOWING   `shouldFollowRef` true. New content pins the viewport to the
 *               bottom, and the bottom is an INVARIANT: every pin is verified
 *               against the geometry for the next few frames, and a viewport
 *               that ends up away from the true bottom while still following is
 *               snapped back. This is the resting state.
 *   AWAY        The user scrolled up. Follow is off. Entered
 *               only by a USER-CAUSED upward scroll ('disable-now' — the scroll
 *               handler requires a fresh wheel / touch / scrollbar-drag gesture,
 *               because the transcript's scrollTop is also moved by our own
 *               pins, by Virtuoso's size corrections and by the browser, and
 *               latching on one of those drops follow for good) or by the
 *               follow-disable debounce confirming a settled non-bottom
 *               geometry. Left by scrolling back to the real bottom or by
 *               invoking jump-to-bottom (the chat right-click menu's
 *               "Scroll to bottom").
 *   ANIMATING   `scrollAnimatingRef` true for the duration of a programmatic
 *               scroll (follow or jump). Mid-animation the viewport is
 *               intentionally not at the bottom, so every geometry consumer
 *               short-circuits while this is set — otherwise the 150ms
 *               follow-disable debounce fires mid-flight and drops us to AWAY.
 *
 * Writes to `scrollTop` go through exactly three paths: `pinToBottom` (instant
 * snap, used by the re-pin backstops and the follow invariant),
 * `animateScrollToBottom` (the rAF easing loop), and the item-list observer's
 * fold-lockstep compensation (absolute `Math.round(ledger)` writes plus a
 * sub-pixel translateY on the item-list — scroll alone is integer-grained and
 * cannot hold the content below the fold still; see the ledger comment at the
 * branch). Keeping that list at three is the point of this module — a fourth
 * writer added elsewhere is how the viewport ends up fighting itself.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import { anyCollapseAnimatingInside } from '../collapse-animation'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { scrollDebug as dbg } from './scroll-debug'
import { clamp } from '../../utils/clamp'

/** Pixel tolerance for direct bottom checks. Keep this tiny to cover
 *  fractional scroll values without treating a visibly offset viewport as
 *  being at the bottom. */
const BOTTOM_EPSILON_PX = 2

/** Initial value of the follow-gate reset guard's last-reset key. A unique
 *  symbol — never equal to any `transcriptRevealKey` (which may legitimately
 *  be `undefined` for callers like SubagentTranscriptDialog) — so the mount
 *  run of the reset effect always executes once, even for undefined keys. */
const FOLLOW_RESET_NEVER = Symbol('crw-follow-reset-never')

/** How long a settle-verification pass keeps watching the viewport after a
 *  pin (see verifyFollowInvariant). Long enough to outlast Virtuoso's
 *  post-replay re-measurement storm, short enough that it can never read as a
 *  permanent frame loop. */
const SETTLE_VERIFY_MS = 1500
/** End a verification pass early once the viewport has held the true bottom
 *  this many consecutive frames. */
const SETTLE_STABLE_FRAMES = 3

/**
 * How long a user-scroll gesture keeps a subsequent scrollTop move attributable
 * to the user (see `userScrollIntentRef`), measured from the LAST event of the
 * gesture rather than from its start.
 *
 * Two measurements shape this number, both taken in the real app under reduced
 * motion: Chromium pans a wheel scroll over hundreds of ms, and the first
 * scroll event that actually moves the viewport arrives ~690ms after the wheel
 * event (the pan starts slow, then emits upward events the whole way). So the
 * window has to outlast that start latency, and each UPWARD event re-arms it
 * (the gesture "chains") so an arbitrarily long pan stays attributed. It still
 * dies 1.2s after the chain's last upward event, so a programmatic move once the
 * user has stopped (a clamp, a Virtuoso correction) is read as a displacement
 * and corrected instead of dropping follow.
 */
const USER_SCROLL_INTENT_MS = 1200

/** Seek-easing snap threshold: within this many px of the target the seek
 *  stops easing and pins the final position. Small enough to read as exact. */
const SEEK_SNAP_PX = 2

/** Item-list height deltas within this band never trigger the re-pin — the
 *  instant scrollTop write costs more (momentum cancellation) than the
 *  invisible ≤3px drift it would fix. See the micro-delta comment in the
 *  observer. */
const ITEM_LIST_MICRO_DELTA_PX = 3
/** How long after the LAST sub-band item-list wobble the trailing correction
 *  waits before it writes. Each wobble resets it, so a settling chain produces
 *  no write at all; once the chain quiets, ONE exact pin cleans up the residue
 *  the band deliberately left (at a quiet turn end no scroll event or append
 *  ever comes to correct it — the "回复刚结束差几像素" report). Exported for
 *  the band tests' clock. */
export const TRAILING_MICRO_PIN_MS = 250
/** Frames the seek loop HOLDS the anchor after landing, re-pinning if a late
 *  row re-measurement (Virtuoso measures fresh-mounted rows a frame or two
 *  after paint) shifts the content under the parked viewport. */
const SEEK_HOLD_FRAMES = 8

/** Keys that scroll a focused scroll container UPWARD — the only ones that can
 *  produce a leave. PageDown / Space / End can't, so they deliberately don't
 *  mark intent: a keypress that can't scroll up is no evidence that a later
 *  upward move was the user's. */
const SCROLL_UP_KEYS = new Set(['PageUp', 'ArrowUp', 'Home'])

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
 * for the "at bottom" STATE (a viewport resting above the task
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

/** The spacer-aware at-bottom check: right for the at-bottom STATE (a viewport
 *  resting above the task list / live bubble should read as at-bottom), wrong
 *  for the user-leave gate (see getDistanceFromTrueBottom). */
const isAtSpacerAwareBottom = (el: HTMLElement) =>
  getDistanceFromBottom(el) <= BOTTOM_EPSILON_PX

/** True when the viewport is parked at the very bottom (scrollHeight) — the
 *  only geometry that may re-arm follow. Distinct from
 *  `isAtSpacerAwareBottom`, which also covers the spacer-reserved dead
 *  zone (see `getDistanceFromTrueBottom`). */
const isAtTrueBottom = (el: HTMLElement) => getDistanceFromTrueBottom(el) <= BOTTOM_EPSILON_PX

type FollowMode = 'restore' | 'disable-now' | 'disable-debounced' | 'preserve'
type BottomSyncMode = FollowMode | 'confirm-away'

/** How long after a keep-alive re-show the scroll machinery treats scroll
 *  events as mechanical artifacts of the row remount rather than user intent.
 *  Consumed by the justReshowed() suppression in this hook AND by App's
 *  scroll-memory re-assert loop (src/App.tsx), whose deadline must stay
 *  within this window — tune them together. */
export const PANEL_RESHOW_SETTLE_MS = 750

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
  /** Transcript identity. The inner scroller remounts when it changes, so
   *  element-bound observers must re-attach and all state must reset. */
  transcriptRevealKey: string | undefined
  /** Committed height of the bottom-overlay spacer. Owned by the caller
   *  because it also drives the Footer slot. */
  bottomStackHeight: number
  /** The hook's mirror of Virtuoso's `firstItemIndex` anchor. Kept in sync by
   *  the owner (which owns the anchor), so seekToIndex can resolve DATA-space
   *  indices to the OFFSET-space stamps Virtuoso writes on row elements. */
  firstItemIndexRef: RefObject<number>
  /** False while the hosting panel is in the keep-alive cache. Re-showing a
   *  cached panel remounts the rows, and the scrollTop clamps during that
   *  rebuild emit scroll events whose geometry reads "at the bottom" — the
   *  restore path then re-latches follow and the follow invariant pins the
   *  viewport to the bottom, discarding the restored scroll position. The
   *  hook suppresses every follow re-arm for a short window after each
   *  re-show (mechanical scroll events only in that window — the user hasn't
   *  scrolled yet). */
  panelVisible?: boolean
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
  /**
   * The user did something that scrolls this transcript (wheel / touch /
   * scroll key / overlay-thumb drag), in EITHER direction. Consumers that keep
   * a navigation cursor (prev/next user message) reset it here: a manual scroll
   * invalidates the last programmatic target, so navigation must re-anchor to
   * what the user is now looking at. Deliberately NOT fired by the programmatic
   * seek's own scroll events.
   */
  onUserScrollIntent?: () => void
}

export interface TranscriptScrollApi {
  /** Mirror of the follow gate, for declarative rendering. The owner stamps
   *  it as the wrap element's `data-following` attribute. */
  following: boolean
  /** Virtuoso `scrollerRef`. */
  scrollerRefCb: (ref: HTMLElement | Window | null) => void
  /** Virtuoso `followOutput`. Always returns false — we drive the follow
   *  scroll ourselves so Virtuoso doesn't animate against us. */
  followOutput: (atBottom: boolean) => false
  /** Virtuoso `atBottomStateChange`. */
  atBottomStateChange: (reportedAtBottom: boolean) => void
  /** Jump-to-bottom handler (chat right-click menu "Scroll to bottom"). */
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
  transcriptRevealKey,
  bottomStackHeight,
  firstItemIndexRef,
  onVisibleTopChange,
  onUserScrollIntent,
  panelVisible,
}: UseTranscriptScrollOptions): TranscriptScrollApi {
  // Boolean form of rowCount for effect deps: the scroll/gesture listeners
  // only need to (re-)attach when the scroller comes into existence, not on
  // every appended row. See the listener effect's closing comment.
  const hasRows = rowCount > 0
  // Virtuoso's underlying scroll element. Captured through scrollerRefCb.
  const scrollerRef = useRef<HTMLElement | null>(null)
  // Timestamp of the last keep-alive re-show (panelVisible false→true, or
  // mount). For a short window after a re-show, every scroll event on the
  // scroller is a mechanical artifact of the row remount (scrollTop clamps
  // while Virtuoso rebuilds the range), not user intent — the geometry reads
  // "at the bottom" mid-rebuild and the restore path would re-latch follow,
  // letting the follow invariant discard the restored scroll position ("切
  // group 回来跳到底部"). All follow re-arm paths consult justReshowed()
  // (declared after userScrollIntentRef below).
  //
  // The window (750ms) must cover App's scroll-memory re-assert loop, which
  // holds the restored offset against Virtuoso's gradual repositioning for
  // ~700ms after the re-show — a shorter suppression lets the drift-landed
  // geometry re-latch follow inside the band. A user gesture (wheel/touch/
  // scroll key — userScrollIntentRef, stamped AFTER lastShowAt) ends the
  // suppression early: past that point scroll events are the user's again.
  const lastShowAtRef = useRef(0)
  // useLayoutEffect: the stamp must land BEFORE the remount-clamp scroll
  // events of the show commit — App's restore layout effect writes scrollTop
  // pre-paint and Virtuoso's rebuild can emit clamps in the same frame, both
  // ahead of a passive effect's delivery. Date.now() on purpose: it must be
  // comparable with userScrollIntentRef (stamped with Date.now() by the
  // gesture listeners).
  useLayoutEffect(() => {
    if (panelVisible !== false) lastShowAtRef.current = Date.now()
  }, [panelVisible])
  // At-bottom mirror, read by callbacks (notably the viewport-shrink backstop)
  // without a stale-closure dance. Written by setBottomState.
  const atBottomRef = useRef(true)
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
  // When the user last did something that scrolls this transcript (0 = never).
  //
  // The only evidence that an upward move was the USER's doing. Everything else
  // that moves scrollTop — our pins, Virtuoso's size corrections, the browser's
  // clamps — must not be allowed to latch AWAY, so the leave test requires this
  // to be fresh. Set by the wheel / touch / overlay-thumb-drag listeners in the
  // scroll-intent effect below.
  const userScrollIntentRef = useRef(0)
  // True within the re-show settle window (see lastShowAtRef above), unless
  // the user has gestured since the re-show — their wheel/touch/scroll key
  // stamps userScrollIntentRef with a LATER timestamp than lastShowAt, which
  // ends the suppression on the spot (a genuine scroll-down-to-bottom right
  // after switching back must still re-latch follow).
  const justReshowed = useCallback(() => {
    // Same clock as the gesture stamps (Date.now()).
    if (Date.now() - lastShowAtRef.current >= PANEL_RESHOW_SETTLE_MS) return false
    // User gesture stamped after the re-show → the scroll events are the
    // user's again; end the suppression (a genuine scroll-down-to-bottom
    // right after switching back must still re-latch follow).
    if (userScrollIntentRef.current > lastShowAtRef.current) return false
    return true
  }, [])
  // Held TRUE for the whole of a programmatic scroll-to-bottom animation. See
  // the ANIMATING state in the module comment: while set, the scroll handler
  // and syncBottomGeometry leave atBottomRef/shouldFollowRef alone. Bounded by
  // the rAF loop's own completion or cancellation, so it can never latch.
  const scrollAnimatingRef = useRef(false)
  // rAF handle for the in-flight animated scroll, so a new jump (or unmount)
  // cancels the previous loop instead of stacking two that fight over
  // scrollTop.
  const scrollAnimRafRef = useRef<number | null>(null)
  // Seek-loop state (seekToIndex's own rAF easing): handle, sequence token (so
  // a newer seek cancels the older loop), and the post-landing hold counter.
  const seekAnimRafRef = useRef<number | null>(null)
  const seekSeqRef = useRef(0)
  // True for the whole life of a seek (ease + landed hold). The scroll
  // handler's gesture-chaining restamp consults this: the seek's OWN upward
  // scroll events must not re-arm userScrollIntentRef, or an upward seek fired
  // while a prior gesture is still fresh (≤ USER_SCROLL_INTENT_MS old) reads
  // its own first write as a user takeover and self-aborts after one frame
  // ("Alt+↑ does nothing right after wheeling up"). Genuine user gestures are
  // unaffected — wheel / touch / scroll key / overlay-thumb listeners stamp
  // userScrollIntentRef directly, bypassing this chain.
  const seekActiveRef = useRef(false)
  const [followDebounceRaw] = useLocalStorage<number>(
    'claude-react-web:follow-debounce-ms',
    150,
  )
  const FOLLOW_DEBOUNCE_MS = clamp(Math.round(followDebounceRaw), 50, 500)

  /**
   * The single mutation point for the follow gate. `shouldFollowRef` is the
   * synchronous gate every pin/handler decision reads; the `following` mirror
   * is React state the OWNER renders declaratively as the wrap element's
   * `data-following` attribute — the observable that replaced the removed
   * jump-to-bottom button as the tests' FOLLOWING/AWAY assertion surface.
   * (The attribute must live on an element the owner renders, not on
   * Virtuoso's scroller: react-hooks/immutability forbids mutating the
   * element obtained from `scrollerRef.current` inside hook callbacks, and a
   * declarative write needs no DOM access at all.)
   */
  const [following, setFollowingState] = useState(true)
  const setFollowing = useCallback((next: boolean) => {
    shouldFollowRef.current = next
    setFollowingState(next)
  }, [])

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
  // Held in a ref (assigned below, once `verifyFollowInvariant` exists) so
  // `pinToBottom` can stay dependency-free while still kicking off a
  // verification pass. Declared before it to avoid a use-before-define cycle.
  const verifyRef = useRef<() => void>(() => {})
  const settleRafRef = useRef<number | null>(null)
  // Explicit "a pass is running" flag, NOT the rAF handle. `tick` re-enters
  // through `pinToBottom` → `verifyRef.current()` (every pin starts a pass by
  // design), so using the handle as the guard would let a pinning tick start a
  // SECOND pass whose handle the outer tick then overwrites — an untracked loop
  // per pinning frame, uncancellable on unmount.
  const settleRunningRef = useRef(false)
  // Assigned during render, not in a passive effect: the append pin and the
  // spacer pin run in LAYOUT effects, i.e. before passive effects, and they
  // must be able to open a pass on the commit that mounts them.

  const pinToBottom = useCallback((
    el: HTMLElement | null = scrollerRef.current,
    { allowDuringAnimation = false, reason = '?', verify = true }: { allowDuringAnimation?: boolean; reason?: string; verify?: boolean } = {},
  ) => {
    if (!el) { dbg('pin skip', () => ({ reason, why: 'no-el' })); return }
    if (!shouldFollowRef.current) { dbg('pin skip', () => ({ reason, why: 'away' })); return }
    if (scrollAnimatingRef.current && !allowDuringAnimation) { dbg('pin skip', () => ({ reason, why: 'animating' })); return }
    dbg('pin', () => ({ reason, before: Math.round(el.scrollTop) }))
    el.scrollTop = el.scrollHeight
    // Every correction is provisional: the layout can keep moving after this
    // write, so verify the invariant across the next frames (see
    // verifyFollowInvariant). Handled through a ref so this callback stays
    // dependency-free and the two can call each other. `verify: false` opts
    // out — the fold-lockstep pin, whose NEXT observation is guaranteed to
    // re-pin anyway, must not keep a verify pass ticking (and re-pinning)
    // every frame for the whole animation.
    if (verify) verifyRef.current()
  }, [])

  // --- Trailing micro-band correction --------------------------------------
  //
  // The item-list observer's micro-delta band skips the instant re-pin for
  // sub-band wobbles; its contract says the residue is "corrected by the
  // follow invariant on the next scroll event or append". At a quiet turn end
  // neither ever comes: the chain's last event is frequently a POSITIVE
  // growth (a row re-measure lands taller), positive growth fires no clamp
  // and no scroll event, and the verify pass has long expired — so the 1–3px
  // residue the band deliberately left stays on screen (the "回复刚结束
  // 差几像素" report). Schedule a correction instead of dropping the event:
  // every wobble RESETS the timer, so a settling chain produces no write at
  // all, and ONE exact pin lands once the chain has been quiet for a beat. A
  // panel frozen by a hidden tab heals the same way — the RO's queued entry
  // is delivered after the tab returns and arms the same trailing pass.
  const trailingMicroPinRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleTrailingMicroPin = useCallback(() => {
    if (trailingMicroPinRef.current != null) clearTimeout(trailingMicroPinRef.current)
    trailingMicroPinRef.current = setTimeout(() => {
      trailingMicroPinRef.current = null
      const el = scrollerRef.current
      // Same stand-down contract as every other corrector: not following, an
      // animation owns the viewport, or the panel is display:none in the
      // keep-alive cache.
      if (!el || !shouldFollowRef.current || scrollAnimatingRef.current) return
      if (el.clientHeight === 0) return
      if (getDistanceFromTrueBottom(el) > BOTTOM_EPSILON_PX) {
        pinToBottom(el, { reason: 'trailing-micro' })
      }
    }, TRAILING_MICRO_PIN_MS)
  }, [pinToBottom])

  // --- Settle verification -------------------------------------------------
  //
  // While FOLLOWING, "at the bottom" is an invariant, not an event: every
  // correction we make is provisional, because the layout can keep moving
  // AFTER the last write. Virtuoso re-measures the rendered rows for a few
  // hundred ms after a bulk replay and expresses those corrections in ways no
  // observer of ours can see — it rewrites the item list's leading/trailing
  // padding, and it moves content with MARGINS and offset compensations, which
  // are not part of any element's border box. The result is a viewport that is
  // left short of a grown content bottom with: no resize fired (the item-list /
  // spacer / viewport observers all stay silent), no scrollTop write, and no
  // scroll event. Nothing re-pins even though follow is still on — the
  // "关掉动画效果后 Session 有时候滚动不到最底部" report (a
  // reduced-motion page has no entrance animations spreading that work over
  // frames, so the corrections land as one late jump instead of being absorbed).
  //
  // So we verify the invariant instead of assuming it: for a short window after
  // any pin, re-read the distance from the true bottom each frame and re-pin
  // while it is non-zero, stopping as soon as the viewport has HELD the bottom
  // for a few consecutive frames (or the window expires). Self-limiting by
  // construction — it never becomes a permanent frame loop, and it stands down
  // the moment follow is dropped (the user's call) or a follow animation takes
  // ownership of the viewport.
  const verifyFollowInvariant = useCallback(() => {
    if (settleRunningRef.current) return
    settleRunningRef.current = true
    const deadline = Date.now() + SETTLE_VERIFY_MS
    let stableFrames = 0
    const finish = () => {
      settleRunningRef.current = false
      settleRafRef.current = null
    }
    const tick = () => {
      const el = scrollerRef.current
      if (!el || !shouldFollowRef.current || Date.now() > deadline) { dbg('verify stop', () => ({ why: !el ? 'no-el' : !shouldFollowRef.current ? 'away' : 'deadline' })); finish(); return }
      if (scrollAnimatingRef.current) {
        // The follow animation owns the viewport; it re-reads its target every
        // frame. Wait it out, then resume verifying.
        stableFrames = 0
        settleRafRef.current = requestAnimationFrame(tick)
        return
      }
      const short = getDistanceFromTrueBottom(el)
      dbg('verify tick', () => ({ stableFrames }))
      if (short > BOTTOM_EPSILON_PX) {
        stableFrames = 0
        // Re-enters verifyFollowInvariant through pinToBottom; settleRunningRef
        // is what makes that a no-op instead of a second loop.
        pinToBottom(el)
      } else {
        stableFrames++
        if (stableFrames >= SETTLE_STABLE_FRAMES) { finish(); return }
      }
      settleRafRef.current = requestAnimationFrame(tick)
    }
    settleRafRef.current = requestAnimationFrame(tick)
  }, [pinToBottom])

  // Render-time assignment (not an effect): see the comment where verifyRef is
  // declared — layout-effect pins run before passive effects and must be able
  // to open a pass. Deliberate render-time ref use, same escape hatch
  // MessageList's useStableSet takes for its referential memoization.
  /* eslint-disable-next-line react-hooks/refs -- documented above */
  verifyRef.current = verifyFollowInvariant

  useEffect(() => () => {
    if (settleRafRef.current != null) {
      cancelAnimationFrame(settleRafRef.current)
      settleRafRef.current = null
    }
    settleRunningRef.current = false
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
    pinToBottom(scrollerRef.current, { allowDuringAnimation: true, reason: 'append' })
  })

  const clearFollowTimer = useCallback(() => {
    if (followTimerRef.current == null) return
    clearTimeout(followTimerRef.current)
    followTimerRef.current = null
  }, [])

  const setBottomState = useCallback((nextAtBottom: boolean) => {
    atBottomRef.current = nextAtBottom
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
    dbg('syncBottomState', () => ({ nextAtBottom, followMode, followBefore: shouldFollowRef.current }))
    if (nextAtBottom || followMode !== 'disable-debounced') {
      setBottomState(nextAtBottom)
    }

    if (followMode === 'restore') {
      clearFollowTimer()
      setFollowing(true)
      return
    }

    if (followMode === 'disable-now') {
      // Genuine user scroll-away: the user drilled up out of the bottom, so
      // follow drops immediately. (In contrast, 'disable-debounced' below must
      // never do this while we're still following — a transient geometry
      // flutter during a bulk replay isn't a user leave.)
      clearFollowTimer()
      setFollowing(false)
      setBottomState(false)
      return
    }

    if (followMode === 'disable-debounced' && followTimerRef.current == null) {
      followTimerRef.current = setTimeout(() => {
        followTimerRef.current = null
        const el = scrollerRef.current
        if (!el) {
          setBottomState(false)
          return
        }

        // While still following/pinned, a not-at-bottom geometry read is a
        // pin-lag (content grew before the follow/pin caught up), never a
        // genuine leave. Flipping shouldFollowRef false here is exactly what
        // dropped follow across every bulk-load batch on session switches:
        // the 150ms timer fired during the transient and armed a "leave".
        // Until the user has actually scrolled up (which trips 'disable-now'),
        // keep following; the content-growth pin will snap back.
        if (shouldFollowRef.current) {
          return
        }

        // Collapsed scroller (clientHeight 0) = the panel is display:none in
        // the keep-alive cache. Every distance reads 0 there, so
        // isAtTrueBottom would report "at the bottom" and re-latch follow on
        // a panel the user deliberately scrolled away from — the follow
        // invariant then snaps the viewport back to the bottom when the panel
        // is re-shown. Same stand-down contract as syncBottomGeometry: decide
        // nothing from collapsed geometry.
        if (el.clientHeight === 0) {
          setBottomState(false)
          return
        }
        // Just-reshowed window: the remount clamps read as "at the bottom"
        // even with the panel visible. Decide nothing from them — return
        // WITHOUT touching state, so a re-shown panel that genuinely sits at
        // the true bottom can still re-latch follow once the window ends.
        if (justReshowed()) {
          return
        }

        // Already away: restore follow only when back at the TRUE bottom.
        // Restoring while still inside the dead zone (spacer-aware at-bottom)
        // would re-latch follow and re-arm the re-pin backstops that snap the
        // viewport back down.
        if (isAtTrueBottom(el)) {
          setFollowing(true)
          setBottomState(true)
        } else {
          setBottomState(false)
        }
      }, FOLLOW_DEBOUNCE_MS)
    }
  }, [FOLLOW_DEBOUNCE_MS, clearFollowTimer, setBottomState, setFollowing])

  const syncBottomGeometry = useCallback((
    el: HTMLElement | null = scrollerRef.current,
    modeWhenAway: BottomSyncMode = 'preserve',
  ) => {
    if (!el) return
    // Collapsed scroller (clientHeight 0) = the panel is display:none in
    // the keep-alive cache. Every distance reads 0 there — "at the bottom"
    // — which the mode calculus below misreads (a bogus leave/restore, and
    // a shrink-backstop scroll write). The browser preserves scrollTop
    // across the hide and restores it on show (verified in-app), so the
    // correct move is to stand down until the panel is visible again.
    if (el.clientHeight === 0) return
    // ANIMATING: the viewport is intentionally not yet at the bottom. Don't let
    // that mid-animation gap arm the follow-disable debounce or flip
    // atBottomRef false (which would disarm the re-pin paths the animation
    // depends on). Treat the viewport as still-at-bottom until the rAF loop
    // completes and clears the guard.
    //
    // Exception: an explicit 'disable-now' is the user's own leave, latched by
    // a gesture they just made (the wheel/key handlers call it directly, and
    // the scroll handler forwards a user-driven upward move with it). Dropping
    // that here leaves `shouldFollowRef` true, so the follow invariant and the
    // backstops snap the viewport back and the gesture is erased — the rAF loop
    // aborts on the same move without syncing (its comment assumes the handler
    // latched the leave), so nothing else would record it.
    if (scrollAnimatingRef.current && modeWhenAway !== 'disable-now') {
      return
    }

    const following = shouldFollowRef.current
    const userLeft = modeWhenAway === 'disable-now'

    // FOLLOW INVARIANT — while following, the viewport IS the bottom.
    //
    // "Following" is the resting state, so a viewport that is away from the
    // true bottom while `shouldFollowRef` is still set is not a state the user
    // asked for; it is a displacement we have not accounted for yet. Enforcing
    // it here (rather than only in the element-shaped backstops) is what covers
    // a correction that moves the content bottom under a pinned viewport without
    // resizing the item-list, the spacer or the viewport and without a scrollTop
    // write — those slipped past all three backstops and left the transcript
    // short with follow still on (the "关掉动画效果后 Session 有时候
    // 滚动不到最底部" bug).
    //
    // Safe by construction: a genuine user scroll-up arrives as
    // `modeWhenAway === 'disable-now'` (the scroll handler latched it as
    // user-intent BEFORE calling us), so `userLeft` excludes it — follow is
    // dropped instead. Same for an away user: `following` is false, so nothing
    // here ever yanks them.
    if (following && !userLeft && !isAtTrueBottom(el)) {
      dbg('follow-invariant', () => ({ modeWhenAway }))
      pinToBottom(el, { reason: 'follow-invariant' })
    }

    // Read the geometry AFTER the invariant pin, so the state below describes
    // where the viewport IS, not the displacement we just corrected.
    const atBottom = isAtSpacerAwareBottom(el)
    // The top of the real bottom: the viewport parked at scrollHeight (what
    // pinToBottom targets). Follow re-arms ONLY here. The spacer-aware
    // `atBottom` also covers the dead zone (the region reserved by the task
    // list / live bubble) — re-latching follow there is exactly the state
    // that lets the re-pin backstops snap an upward scroll back down.
    const atTrueBottom = isAtTrueBottom(el)
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
        : atBottom
          ? (following ? 'preserve' : 'disable-now')
          : modeWhenAway === 'confirm-away'
            ? 'disable-debounced'
            : modeWhenAway === 'restore' ? 'preserve' : modeWhenAway
    syncBottomState(atBottom, followMode)
  }, [pinToBottom, syncBottomState])

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

  // --- Follow-gate reset --------------------------------------------------
  // Session switch: the inner scroller remounts (Virtuoso is keyed on the
  // transcript), but this hook's owner persists. Reset the bottom/scroll state
  // so stale values from the old transcript don't leak into the new one — a
  // stale atBottomRef=false would disarm the viewport-shrink backstop, and a
  // stale following=false would leave the new transcript unpinned.
  //
  // Guarded by the last-reset key. The reset may only run when the transcript
  // identity ACTUALLY changes. Two verified reasons to gate it:
  //  1. Fast Refresh (dev) has been observed to re-render hook owners with a
  //     transiently-undefined revealKey while a group switch has the panel
  //     hidden — an undefined→key flip then re-runs the reset for a transcript
  //     that did not change, wiping the user's away state.
  //  2. Same-key effect re-fires (same key value, same instance, no remount)
  //     wipe the away state identically: the follow-invariant then snaps the
  //     viewport back to the bottom when the panel is re-shown, defeating the
  //     keep-alive cache's scroll-preservation promise ("切 group 回来滚动位置
  //     丢失,回到底部"). The key-equality check suppresses both regardless of
  //     which React mechanism produced them.
  const lastResetKeyRef = useRef<string | undefined | typeof FOLLOW_RESET_NEVER>(FOLLOW_RESET_NEVER)
  useEffect(() => {
    if (lastResetKeyRef.current === transcriptRevealKey) return
    lastResetKeyRef.current = transcriptRevealKey
    clearFollowTimer()
    atBottomRef.current = true
    userScrollIntentRef.current = 0
    // Intentional one-shot re-init on a rare event (transcript switch): the
    // cascading-render cost the set-state rule guards against is irrelevant
    // for a single commit after a session switch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFollowing(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptRevealKey])

  // --- Re-pin backstops ---------------------------------------------------

  // Viewport geometry trigger: panels above/below the scroller can change the
  // available height without firing a scroll event. Keep the bottom-follow
  // state in sync with the real DOM geometry on every resize.
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
      dbg('scroller-RO', () => ({ shrunk, atBottomRef: atBottomRef.current }))
      // `current.clientHeight > 0`: never snap on the hide-flip — a
      // display:none scroller reads scrollHeight 0, so this scrollTo would
      // write scrollTop 0 on a collapsed box (and the follow invariant
      // re-pins to the real bottom once the panel is shown again anyway).
      if (shrunk && atBottomRef.current && current.clientHeight > 0) {
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
    dbg('spacer-pin', () => ({ bottomStackHeight, animating: scrollAnimatingRef.current }))
    pinToBottom(undefined, { reason: 'spacer' })
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
    // Fractional border-box height of the observed item-list, from the last
    // observation. `scrollHeight` is integer-rounded, so it can't express a
    // sub-pixel content change — the fold-lockstep compensation below needs
    // the FRACTIONAL delta to keep the bottom exactly still.
    let lastItemListH: number | null = null
    // The fold-lockstep LEDGER: the compensation's own fractional scrollTop.
    // Measured on this very page (dpr=2): `scrollTop = x.5` reads back `x` —
    // Chrome floors scrollTop to whole CSS px on write AND read. An
    // incremental `scrollTop += Δ` therefore loses Δ's fraction EVERY frame
    // (the read returns the floored stored value), the loss accumulates
    // ~0.5px/frame, and the follow invariant's 2px threshold periodically
    // snaps it back — the measured ±2.8px sawtooth mid-expand. The ledger
    // keeps the exact fractional target (accumulating无损 in a JS number) and
    // writes it; the DOM floors it, so the DOM rides ≤1px from the true
    // bottom, but that offset varies SMOOTHLY with the eased height instead
    // of sawtoothing, and never accumulates.
    let ledger: number | null = null
    // The sub-pixel half of the compensation. scrollTop is integer-grained
    // (measured: write x.5 → read x, even at dpr=2), so scroll alone can
    // never hold the content below the fold pixel-still — its position
    // wanders within a ±1px band as the eased height's fraction changes.
    // During a fold, the remainder rides on a translateY applied to the
    // item-list: the transform is compositor-precise, so
    //   visual = docPos − round(ledger) + (round(ledger) − ledger) ≡ docPos − ledger
    // is EXACTLY constant per frame. The ≤0.5px error is thereby moved onto
    // the expanding card itself (whose whole body is visibly animating) and
    // the clipped bottom edge — both imperceptible.
    let transformEl: HTMLElement | null = null
    let settleRaf: number | null = null
    const clearFoldTransform = () => {
      if (transformEl) {
        transformEl.style.transform = ''
        transformEl = null
      }
    }
    // Settle watcher: RO deliveries stop when the last fold finishes, so the
    // transform cannot be cleared from the observer path. Keep checking each
    // frame and, once nothing is animating (or follow was dropped / the
    // panel hidden mid-fold), clear the transform and the ledger. The ≤1px
    // fractional residue this leaves (floored scrollTop + integer
    // scrollHeight) is deliberately dropped, not scrolled in: it is within
    // the follow invariant's epsilon and the next scroll event / append pin
    // reconciles it — an extra write here would re-arm a verify pass for an
    // invisible step.
    const settleFoldTransform = () => {
      if (settleRaf != null) cancelAnimationFrame(settleRaf)
      const step = () => {
        settleRaf = null
        const scroller = scrollerRef.current
        if (cancelled || !scroller) return
        if (scroller.clientHeight !== 0 && shouldFollowRef.current && !scrollAnimatingRef.current && anyCollapseAnimatingInside(scroller)) {
          settleRaf = requestAnimationFrame(step)
          return
        }
        clearFoldTransform()
        ledger = null
      }
      settleRaf = requestAnimationFrame(step)
    }
    const contentHeightOf = (scroller: HTMLElement) =>
      scroller.scrollHeight - getBottomSpacerHeight(scroller)
    const ro = new ResizeObserver((entries) => {
      if (cancelled) return
      const scroller = scrollerRef.current
      if (!scroller) return
      // Collapsed scroller (clientHeight 0) = the panel is display:none in
      // the keep-alive cache. The hide-flip delivers a 0×0 box whose
      // scrollHeight reads 0 while the spacer (if any) still contributes its
      // style height, so the delta reads as a huge "shrink" — pre-guard this
      // fired the instant re-pin with scrollTop = scrollHeight = 0 on the
      // hidden element. Same stand-down contract as syncBottomGeometry and
      // the scroller-RO backstop: decide nothing from collapsed geometry.
      if (scroller.clientHeight === 0) { dbg('itemlist-RO collapsed-skip', () => ({})); lastItemListH = null; ledger = null; return }
      // This frame's observation of the item-list box. borderBoxSize carries
      // the fractional block size; the rect fallback covers engines without
      // the entries API shape. RO is state-based: one entry per element per
      // callback, so the last entry IS this frame's geometry.
      const entry = entries[entries.length - 1]
      const itemListH = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height
      if (!shouldFollowRef.current || scrollAnimatingRef.current) { dbg('itemlist-RO skip', () => ({ follow: shouldFollowRef.current, animating: scrollAnimatingRef.current })); lastItemListH = itemListH; ledger = null; return }
      const contentH = contentHeightOf(scroller)

      // Lockstep bottom-pinning while a collapse fold is in flight anywhere in
      // this transcript (ToolGroupCard, the TaskList card, any AnimatedCollapse
      // rendered inside the scroller).
      //
      // A fold animates its body height over ~240ms, so the content changes by
      // a FRACTION of a pixel every frame while follow is still on. The paths
      // below can't follow that: the micro-delta band skips ≤3px frames (most
      // of the ease's tail) and hands them to the trailing pin — a one-shot
      // write 250ms after the chain quiets, visibly late — and the
      // settle-verify pass only corrects once the drift crosses
      // BOTTOM_EPSILON_PX, which turns the whole animation into a ±2px
      // sawtooth. Both measured live: expanding a ToolGroupCard while
      // FOLLOWING wobbled the card below it ±2.5px per frame and bounced
      // +2.5/−2.5px at animation end, while the same expansion AWAY from the
      // bottom (no compensation running at all) was perfectly smooth.
      //
      // The compensation must ALSO be fractional, and it must NOT trust the
      // DOM's scrollTop as its accumulator. An integer pin
      // (`scrollTop = scrollHeight`) shimmers ±1px per frame: scrollHeight is
      // rounded, so the distance-from-bottom left after each pin is a
      // DIFFERENT sub-pixel residue every frame as the eased height advances.
      // An incremental `scrollTop += Δ` looked like the fix and wasn't: the
      // DOM floors scrollTop on write AND read (measured on this page, dpr=2:
      // write x.5 → read x), so every frame's Δ fraction is lost off the
      // floored read, the loss accumulates ~0.5px/frame, and the follow
      // invariant's 2px threshold periodically snaps it back — a ±2.8px
      // sawtooth mid-expand. Hence the LEDGER: the fractional target lives in
      // a JS number (lossless), the DOM gets floored copies of it, and the
      // DOM's ≤1px offset from the true bottom varies smoothly with the eased
      // height instead of sawtoothing — sub-pixel drift, never accumulation.
      // Growth accumulates on the ledger; shrink hands control to the
      // browser's own clamp (see the branch below).
      //
      // This callback is the one compensation point that runs AFTER layout and
      // BEFORE paint: the delta here is THIS frame's final geometry (the real
      // ResizeObserver fires on every per-frame height step of the transition,
      // sub-pixel included), so the content below the fold never moves in any
      // painted frame.
      //
      // Deliberately placed BEFORE the delta checks, and deliberately
      // transcript-wide: a fold's per-frame step is routinely <1px, so a
      // delta gate would re-open the tail sawtooth, and while a fold animates
      // ANY growth this transcript sees wants the same lockstep (an unrelated
      // zero-delta fire degenerates to a no-op — scrollTop is unchanged).
      if (anyCollapseAnimatingInside(scroller)) {
        dbg('itemlist-RO fold-lockstep', () => ({}))
        const itemDelta = lastItemListH == null ? null : itemListH - lastItemListH
        lastItemListH = itemListH
        lastContentHeight = contentH
        const domTop = scroller.scrollTop
        if (itemDelta == null) {
          // No fractional reference (first observation after a baseline
          // reset): fall back to the integer pin for this frame.
          pinToBottom(scroller, { reason: 'fold-lockstep', verify: false })
          ledger = scroller.scrollTop
        } else {
          // Seed the ledger direction-aware. GROWTH: the browser does not
          // move scrollTop on its own, so the ledger starts at the DOM value
          // and the frame's delta stacks on top of it. SHRINK: the browser
          // has ALREADY clamped scrollTop to the reduced max in this same
          // layout pass (the clamp is what keeps the bottom pinned — adding
          // the delta again double-scrolls, measured at 2× per frame), so
          // the ledger starts FROM the clamped value.
          if (ledger == null) ledger = itemDelta < 0 ? domTop : domTop + itemDelta
          else ledger += itemDelta
          const max = scroller.scrollHeight - scroller.clientHeight
          if (ledger > max) ledger = max
          if (ledger < 0) ledger = 0
          // Integer half → scroll; fractional half → transform. Together
          // they hold the content below the fold EXACTLY still (see the
          // ledger/transform comments above).
          const rounded = Math.round(ledger)
          scroller.scrollTop = rounded
          const target = entry.target as HTMLElement
          const frac = rounded - ledger
          target.style.transform = frac === 0 ? '' : `translateY(${frac}px)`
          transformEl = target
        }
        // Arm the settle watcher only when a transform is actually riding on
        // the item list (transformEl set by a previous frame and not yet
        // cleared). The common all-integer fold — every frac 0, no transform
        // ever applied — has nothing for the watcher to clear, and re-arming
        // a cancel/re-request rAF pair on every RO frame for the whole fold
        // is pure waste.
        if (transformEl) settleFoldTransform()
        return
      }
      lastItemListH = itemListH
      ledger = null
      clearFoldTransform()

      const delta = contentH - lastContentHeight
      if (Math.abs(delta) < 1) { dbg('itemlist-RO noop', () => ({})); return }
      // Baseline always tracks past this point, INCLUDING micro-deltas we
      // skip below — otherwise three consecutive 2px wobbles re-read as a
      // 6px delta and defeat the band.
      lastContentHeight = contentH
      // Micro-delta band: 1–3px height flutter (row re-measures settling,
      // streaming line rounding) must not hard-write scrollTop. Each pin is
      // an instant write that kills native momentum — measured live, a
      // -3/-2/-1/-1 settling chain produced a pin per frame with the verify
      // loop perpetually re-armed (the 吸附感 report). ≤3px of drift is
      // invisible, and a real event (append, spacer commit, the user's next
      // scroll — every scroll event re-checks the follow invariant) corrects
      // any residue.
      if (Math.abs(delta) <= ITEM_LIST_MICRO_DELTA_PX) {
        dbg('itemlist-RO micro-skip', () => ({ delta }))
        // The band skips the WRITE, not the correction: schedule the trailing
        // exact pin (see scheduleTrailingMicroPin). Applies to negative
        // deltas too — the check reads live geometry at fire time, so a
        // clamp that already healed the shrink makes it a silent no-op.
        scheduleTrailingMicroPin()
        return
      }
      dbg('itemlist-RO pin', () => ({ delta }))
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
      // NO rect-based seed for lastItemListH: the observation path reads
      // borderBoxSize (layout box, transform-free) while getBoundingClientRect
      // carries ancestor transforms — seeded mid-flight (panel-enter
      // scale(0.98), a DnD FLIP), the first fold frame's itemDelta would read
      // the transform's error (~2% of the list) as a huge shrink and mis-pin
      // the ledger by tens of px. Leave it null: the first observation
      // establishes the baseline, and a first fold frame takes the documented
      // integer-pin fallback (one frame, no ledger) instead of a poisoned
      // delta. `lastContentHeight` keeps its content-based seed — scrollHeight
      // is transform-free.
      lastItemListH = null
      ro.observe(itemList)
    }
    attach()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      // A mid-fold teardown (transcript switch) must not leave the sub-pixel
      // transform — or the settle watcher — behind on the unmounting list.
      if (settleRaf != null) cancelAnimationFrame(settleRaf)
      clearFoldTransform()
      // The armed trailing correction belongs to THIS transcript's wobble
      // chain: a transcriptRevealKey switch tears the observer down and must
      // tear the correction down with it, or a wobble armed on the old
      // transcript fires against the new one's freshly-reset scroller.
      if (trailingMicroPinRef.current != null) {
        clearTimeout(trailingMicroPinRef.current)
        trailingMicroPinRef.current = null
      }
    }
  }, [transcriptRevealKey, pinToBottom, scheduleTrailingMicroPin])

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
  const onUserScrollIntentRef = useRef(onUserScrollIntent)
  useEffect(() => {
    onUserScrollIntentRef.current = onUserScrollIntent
  }, [onUserScrollIntent])
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
  // real bottom restores follow.
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
      const isScrollingUp = el.scrollTop < prevScrollTop
      const distTrue = getDistanceFromTrueBottom(el)
      const userDriven = Date.now() - userScrollIntentRef.current <= USER_SCROLL_INTENT_MS
      // Chain the gesture: an animated wheel pan (or a thumb drag) emits scroll
      // events for hundreds of ms, and each upward one re-arms the window so the
      // whole gesture stays attributable to the user. Only upward events
      // re-arm, so our own downward pins and a downward gesture can't keep the
      // window alive.
      if (userDriven && isScrollingUp && !seekActiveRef.current) userScrollIntentRef.current = Date.now()
      // A genuine user push-away measures against the TRUE bottom
      // (scrollHeight). The spacer-aware `getDistanceFromBottom` subtracts the
      // task-list / live-bubble reserve, so an up-scroll that stays inside it
      // reads as 0 and follow never turns off — and the re-pin backstops then
      // keep snapping the viewport back ("wheel-up gets absorbed"). An animated
      // group FOLD clamps scrollTop down in lockstep with the shrinking content
      // bottom, so this distance stays ≈ 0 there and is not a leave.
      //
      // A leave also has to be USER-CAUSED. The transcript's scrollTop is moved
      // by our own pins, by Virtuoso's size corrections and by the browser's
      // clamps, and mid-turn the content grows under the viewport continuously,
      // so `distTrue` is large at almost every instant — which made ANY
      // transient upward blip satisfy `isScrollingUp && distTrue > 0`. Latching
      // AWAY on one of those drops follow for the rest of the session and the
      // transcript never reaches the bottom again: the live-turn
      // "有时候会滚动不到最底部" report. So require evidence of a real gesture
      // (wheel / touch / scroll key / overlay-thumb drag — see
      // userScrollIntentRef); an upward move with no gesture is a displacement
      // to correct, and it falls through to `preserve` → the follow invariant
      // re-pins it.
      //
      // Residual gap, deliberately accepted: a scroll the browser performs with
      // no gesture AND no key we can see — native find-in-page jumping to a
      // match, middle-click/selection edge autoscroll — reads as a displacement
      // and is re-pinned. Those are the only inputs that can't leave; the app's
      // own search uses `seekToIndex` (which drops follow explicitly), and the
      // alternative (treating every upward move as a leave) is the bug above.
      const isUserLeave = isScrollingUp && distTrue > BOTTOM_EPSILON_PX && userDriven
      // ANIMATING: stand down mid-flight — the viewport is intentionally not yet
      // at the bottom, so a geometry sync here would see dist>0, arm the 150ms
      // follow-disable debounce and fire it mid-animation. Exception: a
      // USER-driven upward move must not be swallowed. The rAF loop aborts on
      // that same move, and (with the follow invariant now enforcing the
      // bottom) dropping it would erase the user's nudge instead of leaving.
      if (scrollAnimatingRef.current && !(userDriven && isScrollingUp)) return
      dbg('scroll-handler', () => ({ isScrollingUp, userDriven, isUserLeave, following: shouldFollowRef.current }))
      if (isUserLeave) {
        syncBottomGeometry(el, 'disable-now')
      } else if (!isScrollingUp && distTrue <= BOTTOM_EPSILON_PX && !justReshowed()) {
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
    // Scroll-intent listeners for the same element lifetime. `wheel` +
    // `touch*` cover mouse/trackpad/touch gestures on the transcript; the
    // overlay scrollbar's thumb is a SIBLING of the scroller (it floats over
    // the parent), so its drag never reaches them and has to be caught at the
    // document — pointer events retarget to the captured thumb mid-drag, which
    // is what keeps the intent fresh for the whole drag.
    const markUserScrollIntent = () => { userScrollIntentRef.current = Date.now(); onUserScrollIntentRef.current?.() }
    // A gesture that asks the viewport to move UP, seen while FOLLOWING (i.e.
    // parked at the bottom), IS the leave — and it has to be latched here rather
    // than from the scroll event the gesture produces. Mid-turn the append pin
    // re-writes scrollTop = scrollHeight in the same frame the browser pans, so
    // by the time the scroll event is delivered the position reads as unchanged
    // (or lower) and `isScrollingUp` is false: the user's wheel-up was erased
    // before we could see it (measured: a 197px PageUp, and a 1500px wheel pan,
    // both gone). Waiting for the event means a streaming transcript cannot be
    // left at all.
    //
    // The scrollable guard keeps a nudge on a transcript with nothing above it
    // from dropping follow — there is no earlier content to go read.
    const leaveOnUpwardGesture = () => {
      const scroller = scrollerRef.current
      if (!scroller || !shouldFollowRef.current) return
      if (scroller.scrollHeight - scroller.clientHeight <= BOTTOM_EPSILON_PX) return
      syncBottomGeometry(scroller, 'disable-now')
    }
    // True when a wheel with `deltaY` over `node` will be chained by the
    // browser up to THIS transcript. `node` may sit inside scroll containers
    // nested in the transcript (a Bash card's output block, a code block) —
    // their scroll events don't bubble, so a wheel that scrolls THEM must not
    // be read as transcript activity. But the browser only lets a nested
    // container consume a wheel it can actually scroll in the wheel's
    // direction: parked at the boundary, the wheel chains to the next
    // scrollable ancestor instead. So the wheel belongs to the transcript
    // only when EVERY scrollable between `node` and the scroller is itself at
    // that boundary — a mid-scroll ancestor swallows the chain and the
    // transcript never moves.
    const wheelChainsToTranscript = (node: EventTarget | null, deltaY: number): boolean => {
      let cur = node instanceof HTMLElement ? node : null
      while (cur && cur !== el) {
        const overflowY = getComputedStyle(cur).overflowY
        if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight + 1) {
          const consumesDown = cur.scrollTop < cur.scrollHeight - cur.clientHeight - BOTTOM_EPSILON_PX
          const consumesUp = cur.scrollTop > BOTTOM_EPSILON_PX
          if (deltaY < 0 ? consumesUp : consumesDown) return false
        }
        cur = cur.parentElement
      }
      return true
    }
    // Only UPWARD-capable inputs (see SCROLL_UP_KEYS): a wheel-down, a touch
    // drag toward the bottom or a PageDown can't produce a leave, and treating
    // them as intent would let a programmatic displacement landing in the window
    // latch one.
    const onWheel = (e: WheelEvent) => {
      // ctrl+wheel is zoom (trackpad pinch), not scrolling.
      if (e.ctrlKey || e.metaKey) return
      // A wheel over a nested scroll container normally belongs to THAT
      // container (scrolling the stdout pre must not drop follow), so it is
      // ignored. But a container parked at the wheel's boundary can't consume
      // it — the browser CHAINS the wheel to this transcript, and the chained
      // scroll arrives with no gesture evidence, because the nested gate is
      // exactly what skipped the intent stamp. Unattributed, the follow
      // invariant reads the chained move as a displacement and re-pins the
      // viewport to the bottom: the user wheeling up out of a long stdout
      // could never scroll the transcript past the bottom ("stdout 滚到顶部
      // 滚不动"). Classify first — a wheel that will chain IS a transcript
      // wheel, and takes the exact transcript path below.
      if (!wheelChainsToTranscript(e.target, e.deltaY)) return
      // ANY transcript wheel invalidates a pending user-message navigation
      // target; the direction gate below is purely for the follow leave.
      onUserScrollIntentRef.current?.()
      if (e.deltaY >= 0) {
        // Downward wheels are user intent too — stamp so justReshowed()'s
        // gesture-escape lets a genuine scroll-down-to-bottom right after a
        // keep-alive re-show re-latch follow — without the upward leave.
        userScrollIntentRef.current = Date.now()
        return
      }
      markUserScrollIntent()
      leaveOnUpwardGesture()
    }
    // Scroll keys only reach the scroller when IT holds focus (Virtuoso renders
    // its scroller with tabIndex 0, so clicking a message focuses it) — and
    // requiring the scroller itself as the target is what keeps ArrowUp/Home
    // pressed inside a nested block (or a message's own control) from being
    // read as a transcript leave. Shift+Space is Chromium's other page-up.
    // Modifier-held arrows are NOT plain scroll keys: Alt+↑/↓ is the app-level
    // prev/next user-message shortcut (whose window-level dispatcher runs
    // AFTER this element handler) and Alt+Shift+↑/↓ moves sidebar groups —
    // classifying either as scroll intent drops follow and resets the
    // navigation cursor right before the shortcut's own seek.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target !== el) return
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (!SCROLL_UP_KEYS.has(e.key) && !(e.key === ' ' && e.shiftKey)) return
      markUserScrollIntent()
      leaveOnUpwardGesture()
    }
    // Middle-click starts the browser's autoscroll on the nearest scrollable
    // ancestor — scoped to `el` so a middle-click on the sidebar can't mark
    // THIS transcript's intent. Its direction isn't known until it scrolls, so
    // this one keeps the intent+scroll-event path.
    const onMiddleDown = (e: PointerEvent) => {
      if (e.button === 1) markUserScrollIntent()
    }
    // The overlay scrollbar's thumb is a SIBLING of the scroller (it floats over
    // the scroller's parent), so its drag never reaches the listeners above and
    // has to be caught at the document. Scoped by parent: the thumb's track is
    // appended to the scroller's own parent, which is what distinguishes this
    // transcript's thumb from the sidebar's / another panel's — marking on any
    // `.os-thumb` would let an unrelated drag re-open the false-leave this gate
    // exists to close. Pointer events retarget to the captured thumb mid-drag,
    // which is what keeps the intent fresh for the whole drag.
    const onPointerOnThumb = (e: PointerEvent) => {
      if (!e.buttons) return // only a held button can be dragging the thumb
      const target = e.target as HTMLElement | null
      const track = target?.closest?.('.os-track')
      if (track && track.parentElement === el.parentElement) markUserScrollIntent()
    }
    // Touch is direction-gated like the wheel: dragging the finger DOWN moves the
    // content up (revealing older messages), which is the leave-capable
    // direction; a drag the other way can't drop follow and must not mark
    // intent, or a programmatic displacement inside the window would.
    let lastTouchY: number | null = null
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? null
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? null
      if (y == null || lastTouchY == null) { lastTouchY = y; return }
      const draggedDown = y > lastTouchY
      lastTouchY = y
      // A drag in EITHER direction invalidates a pending navigation target;
      // only the leave-capable direction marks follow intent.
      onUserScrollIntentRef.current?.()
      if (draggedDown) markUserScrollIntent()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('pointerdown', onMiddleDown, true)
    document.addEventListener('pointerdown', onPointerOnThumb, true)
    document.addEventListener('pointermove', onPointerOnThumb, true)
    return () => {
      el.removeEventListener('scroll', handler)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('pointerdown', onMiddleDown, true)
      document.removeEventListener('pointerdown', onPointerOnThumb, true)
      document.removeEventListener('pointermove', onPointerOnThumb, true)
    }
    // NO `bottomStackHeight` here. It used to be a dep so this effect re-ran —
    // and re-synced the spacer-aware geometry — whenever the spacer resized.
    // But a CSS height transition (a composer fold) resizes the spacer on EVERY
    // frame, so that also tore down and re-registered all seven listeners ~14
    // times per fold. The geometry re-sync now lives in its own effect below;
    // the listener lifetime is keyed only on things that actually replace the
    // scroller or its content shape.
    //
    // Same reasoning for `rowCount` → `hasRows`: every handler above reads its
    // state through refs and dependency-free callbacks (getVisibleTopIndex is
    // []-deps; syncBottomGeometry's own identity is stable), so an appended
    // message needs NO re-bind. `rowCount` was the dep only so the effect
    // re-ran once the scroller actually exists (Virtuoso mounts it after the
    // first row) — the 0→1 transition, not every append.
  }, [hasRows, syncBottomGeometry, emitVisibleTop, transcriptRevealKey])

  // Re-read the spacer-aware geometry when the spacer COMMITS a new height.
  //
  // `syncBottomGeometry` reads the spacer from the DOM (getBottomSpacerHeight),
  // not from this number, so the value here is only a trigger: a taller task
  // list / dock widens the dead zone and can flip the spacer-aware at-bottom
  // state. Split out of the listener effect above so the height churn of a
  // fold does not re-bind listeners.
  useEffect(() => {
    syncBottomGeometry(scrollerRef.current, 'confirm-away')
  }, [bottomStackHeight, syncBottomGeometry])

  // Clean up the follow debounce timer on unmount.
  useEffect(() => () => {
    clearFollowTimer()
  }, [clearFollowTimer])

  // Cancel any in-flight animated scroll (jump / seek) on unmount so a pending
  // rAF callback can't fire after the scroller is gone.
  useEffect(() => () => {
    if (scrollAnimRafRef.current != null) {
      cancelAnimationFrame(scrollAnimRafRef.current)
      scrollAnimRafRef.current = null
    }
    if (seekAnimRafRef.current != null) {
      cancelAnimationFrame(seekAnimRafRef.current)
      seekAnimRafRef.current = null
    }
    seekActiveRef.current = false
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
    // Prefer direct DOM geometry so follow-mode uses the same bottom
    // definition. Fall back to Virtuoso's report if the scroller is not
    // attached yet.
    const el = scrollerRef.current
    if (el) {
      syncBottomGeometry(el, 'confirm-away')
      return
    }
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
    //   - setFollowing(true)   -> followOutput tracks new appends
    //   - setBottomState(true) -> atBottomRef=true arms the re-pin paths;
    //                             also kept true by the ANIMATING guard
    //   - clearFollowTimer()   -> cancel any pending disable-debounced timer
    //                             from the prior scroll-up so it cannot flip
    //                             follow back off mid-jump
    setFollowing(true)
    setBottomState(true)
    clearFollowTimer()
    animateScrollToBottom()
  }, [animateScrollToBottom, clearFollowTimer, setBottomState, setFollowing])

  const seekToIndex = useCallback((index: number, align: 'start' | 'center') => {
    // Leave FOLLOWING so the programmatic scroll isn't yanked back by the
    // bottom pin. Returning to FOLLOWING is the user's call — scrolling back to
    // the bottom, or invoking jump-to-bottom.
    setFollowing(false)
    // Drive the seek with our OWN rAF easing loop instead of Virtuoso's
    // `scrollToIndex({ behavior: 'smooth' })`. Why not the native smooth scroll:
    // mid-scroll row measurements (rows mounting as the viewport pans) fire
    // `listRefresh`, and Virtuoso's initial-position latch re-issues the
    // scrollToIndex a few frames later with the RECOMPUTED offset — which
    // cancels the in-flight native smooth scroll and yanks the viewport back
    // toward the launch point (measured: a 1044px up-seek from the bottom slid
    // ~330px and was then dragged back 927px, reading as "the menu item did
    // nothing"). The rAF loop owns the viewport until it lands: the target is
    // re-read from the LIVE DOM every frame (rows carry `data-item-index` in
    // offset space), so size corrections are absorbed instead of fighting the
    // animation. A far target that's still virtualized away is NOT jumped to
    // with an instant `behavior: 'auto'`: the loop extrapolates its position
    // from the mounted rows (see `estimateTopInContent`) and eases toward that,
    // swapping to the exact measurement once the target mounts — so every seek
    // animates, near or far.
    const el = scrollerRef.current
    if (!el) {
      virtuosoRef.current?.scrollToIndex({ index, behavior: 'smooth', align })
      return
    }
    // One animation writer at a time: cancel any in-flight seek/jump loop.
    if (seekAnimRafRef.current != null) {
      cancelAnimationFrame(seekAnimRafRef.current)
      seekAnimRafRef.current = null
    }
    if (scrollAnimRafRef.current != null) {
      cancelAnimationFrame(scrollAnimRafRef.current)
      scrollAnimRafRef.current = null
      scrollAnimatingRef.current = false
    }
    const token = ++seekSeqRef.current
    // The seek owns the viewport only until the USER takes it back. A gesture
    // (wheel / touch / scroll key / overlay-thumb drag) stamped AFTER the seek
    // began ends the loop outright — both the ease and the landed hold. Without
    // this the hold's re-pin absorbs every wheel notch (and resets its own
    // expiry on each correction, so continuous wheeling keeps it alive
    // forever), and the ease fights the wheel for its remaining frames — the
    // "点完 Scroll to next user message 后鼠标滚不动" report. Gestures stamped
    // BEFORE the seek (the leave-wheel that parked the viewport, a click's own
    // pointer events) don't abort: the comparison is strictly later-than.
    // The seek's own scroll events can't trip this — the scroll handler's
    // gesture-chaining restamp is suppressed while seekActiveRef is set (see
    // seekActiveRef), and every real gesture stamps userScrollIntentRef
    // directly from its own listener.
    const seekStartedAt = Date.now()
    const userTookOver = () => userScrollIntentRef.current > seekStartedAt
    const offsetIndexOf = (row: HTMLElement): number => {
      const raw = row.dataset.itemIndex
      return raw == null ? Number.NaN : Number.parseInt(raw, 10)
    }
    const contentTopOf = (row: HTMLElement): number =>
      row.getBoundingClientRect().top + el.scrollTop - el.getBoundingClientRect().top
    // Offset-space stamp of the row (data space + firstItemIndex), or null
    // while the row isn't rendered.
    const rowTopInContent = (): number | null => {
      const offsetIndex = index + firstItemIndexRef.current
      const row = el.querySelector<HTMLElement>(`[data-item-index="${offsetIndex}"]`)
      if (!row) return null
      return contentTopOf(row)
    }
    const rowHeight = (): number => {
      const offsetIndex = index + firstItemIndexRef.current
      return el.querySelector<HTMLElement>(`[data-item-index="${offsetIndex}"]`)?.getBoundingClientRect().height ?? 0
    }
    // Position for a target that is still virtualized away. Virtuoso renders
    // only a window around the viewport (overscan 600px), so a step over a tall
    // message leaves the target unmounted. The old code answered that with an
    // INSTANT `scrollToIndex({ behavior: 'auto' })`, which is why a far
    // prev/next snapped with no animation. Extrapolate from the mounted rows
    // instead (their measured heights give a local average per row), so the
    // ease always has a target to chase: as the viewport pans, the window
    // follows, the target mounts, and `rowTopInContent` takes over with the
    // exact position. Re-derived every frame, so a bad estimate only changes
    // the speed, never the landing.
    const estimateTopInContent = (): number | null => {
      const target = index + firstItemIndexRef.current
      const rows = el.querySelectorAll<HTMLElement>('[data-item-index]')
      const n = rows.length
      if (n === 0) return null
      const first = rows[0]
      const last = rows[n - 1]
      const firstOff = offsetIndexOf(first)
      const lastOff = offsetIndexOf(last)
      const firstTop = contentTopOf(first)
      const lastTop = contentTopOf(last)
      const lastBottom = lastTop + last.getBoundingClientRect().height
      const span = lastOff - firstOff + 1
      const avgH = span > 0 ? (lastBottom - firstTop) / span : el.clientHeight
      if (!(avgH > 0)) return null
      if (target > lastOff) return lastBottom + avgH * (target - lastOff - 1)
      if (target < firstOff) return firstTop - avgH * (firstOff - target)
      return null
    }
    // Where the viewport top should park for the row to sit at `align`.
    // Clamped to the reachable scroll range: a target near the tail (or a row
    // taller/shorter than the viewport under 'center') can ask for a scrollTop
    // past the max. The browser silently clamps `scrollTo`, so the loop would
    // see `remaining` never fall under the snap threshold and re-issue the same
    // clamped write forever. Clamping here turns that into `remaining === 0`,
    // which lands and releases the loop.
    const desiredTop = (): number | null => {
      const top = rowTopInContent() ?? estimateTopInContent()
      if (top == null) return null
      const raw = align === 'center' ? top - (el.clientHeight - (rowHeight() || el.clientHeight)) / 2 : top
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
      return Math.max(0, Math.min(raw, maxScrollTop))
    }
    // Safety bound: extrapolating to a row that never mounts (pathological size
    // tree) must not pin the rAF loop forever. On exhaustion fall back to
    // Virtuoso's own jump so the click still does something.
    let easeFrames = 600
    // Cleared on EVERY exit of the loop (abort, supersede, fallback, hold
    // expiry); stays set across the ease→hold hand-off. See seekActiveRef.
    const endSeek = () => { seekActiveRef.current = false }
    const step = () => {
      seekAnimRafRef.current = null
      if (token !== seekSeqRef.current || scrollerRef.current !== el) { endSeek(); return }
      if (userTookOver()) { endSeek(); return }
      const desired = desiredTop()
      if (desired == null) {
        // Nothing measurable at all (empty list): defer to Virtuoso.
        endSeek()
        virtuosoRef.current?.scrollToIndex({ index, behavior: 'auto', align })
        return
      }
      const current = el.scrollTop
      const remaining = desired - current
      if (Math.abs(remaining) <= SEEK_SNAP_PX) {
        el.scrollTo({ top: desired, behavior: 'auto' })
        // Hold position for a few frames: Virtuoso re-measures late-mounting
        // rows after the viewport stops, and a correction that shifts content
        // would otherwise strand the row off-target. The hold re-checks the
        // anchor and re-pins if the content moved under us.
        let holds = SEEK_HOLD_FRAMES
        const hold = () => {
          seekAnimRafRef.current = null
          if (token !== seekSeqRef.current || scrollerRef.current !== el) { endSeek(); return }
          // User gesture after landing: release the anchor, same as mid-ease.
          if (userTookOver()) { endSeek(); return }
          const want = desiredTop()
          if (want != null && Math.abs(el.scrollTop - want) > SEEK_SNAP_PX) {
            el.scrollTo({ top: want, behavior: 'auto' })
            holds = SEEK_HOLD_FRAMES
          }
          if (holds-- > 0) seekAnimRafRef.current = requestAnimationFrame(hold)
          else endSeek()
        }
        seekAnimRafRef.current = requestAnimationFrame(hold)
        return
      }
      if (easeFrames-- <= 0) {
        endSeek()
        virtuosoRef.current?.scrollToIndex({ index, behavior: 'auto', align })
        return
      }
      // Ease: cover ~25% of the remaining distance per frame (~250-350ms).
      el.scrollTo({ top: current + remaining * 0.25, behavior: 'auto' })
      seekAnimRafRef.current = requestAnimationFrame(step)
    }
    seekActiveRef.current = true
    seekAnimRafRef.current = requestAnimationFrame(step)
    // Ref read (firstItemIndexRef.current) is live-by-design — a ref needs no dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setFollowing, virtuosoRef])

  return {
    following,
    scrollerRefCb,
    followOutput,
    atBottomStateChange,
    jumpToBottom,
    seekToIndex,
    getVisibleTopIndex,
  }
}
