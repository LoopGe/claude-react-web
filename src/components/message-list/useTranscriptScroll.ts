/**
 * L3 of the transcript list: SCROLL BEHAVIOUR.
 *
 * `reduceScroll` is the only lifecycle policy machine. It owns attachment,
 * follow intent, the single continuous-write owner, and pending corrections.
 * This React adapter measures DOM geometry, classifies user input, and dispatches
 * named events; it does not keep a parallel owner or intent state machine.
 *
 * The writer gateway owns every scroll write, item-list transform, animation
 * frame, timeout, and Virtuoso fallback. Owner tokens and attachment epochs make
 * every deferred callback stale-safe. Fold mathematics stays in its pure fold
 * session, with measured frames delivered through FOLD_FRAME commands.
 *
 * Follow intent and geometry are separate axes. New content keeps a following
 * viewport at the true bottom, while USER_LEFT drops intent and cancels pending
 * bottom work. Only USER_RETURNED_TO_TRUE_BOTTOM or an explicit FOLLOW_REQUESTED
 * may re-arm it. Spacer-aware bottom describes the viewport above the overlay;
 * it never substitutes for the true-bottom return event.
 *
 * Pending corrections have exactly three outcomes: the writer consumes them, a
 * lifecycle event cancels them, or they remain observably queued for their named
 * delivery condition. Hidden/collapsed geometry produces no lifecycle decision.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import { anyCollapseAnimatingInside, snapshotBodyHeights } from '../collapse-animation'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { scrollDebug as dbg } from './scroll-debug'
import { clamp } from '../../utils/clamp'
import { PANEL_RESHOW_SETTLE_MS, TRANSCRIPT_SEEK_EVENT, keyboardTargetsScroller, middleClickTargetsScroller, touchTargetsScroller, wheelChainsToScroller } from '../panel-transition'
import { createInitialScrollState, reduceScroll, type ScrollEvent, type WorkRequest } from './transcript-scroll-machine'
import { createTranscriptScrollWriter } from './transcript-scroll-writer'
import type { FoldFrame } from './fold-scroll-session'

/** Pixel tolerance for direct bottom checks. Keep this tiny to cover
 *  fractional scroll values without treating a visibly offset viewport as
 *  being at the bottom. */
const BOTTOM_EPSILON_PX = 2

/** Initial value of the follow-gate reset guard's last-reset key. A unique
 *  symbol — never equal to any `transcriptRevealKey` (which may legitimately
 *  be `undefined` for callers like SubagentTranscriptDialog) — so the mount
 *  run of the reset effect always executes once, even for undefined keys. */
const FOLLOW_RESET_NEVER = Symbol('crw-follow-reset-never')

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
/** Keys that scroll a focused scroll container UPWARD and can therefore
 *  produce a leave. Downward keys don't leave, but still stamp intent so a
 *  genuine post-show scroll back to the bottom can end re-show suppression. */
const SCROLL_UP_KEYS = new Set(['PageUp', 'ArrowUp', 'Home'])
const SCROLL_DOWN_KEYS = new Set(['PageDown', 'ArrowDown', 'End'])

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
 * stays inside the spacer reads as `0`, so follow intent never turns off
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

type BottomGeometryEvent =
  | { type: 'USER_LEFT' }
  | { type: 'USER_RETURNED_TO_TRUE_BOTTOM' }
  | { type: 'FOLLOW_DEBOUNCE_REQUESTED' }

/** How long after a keep-alive re-show the scroll machinery treats scroll
 *  events as mechanical artifacts of the row remount rather than user intent.
 *  Shared with App's scroll-memory re-assert loop via panel-transition.ts. */

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
  /** App-owned show sequence. Undefined keeps standalone false→true behavior. */
  showEpoch?: number
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
  /** Static snapshots do not follow the tail. When false, the controller starts
   *  away and never re-arms follow; seeks and restores still work. */
  followEnabled?: boolean
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
   * bottom; callers must dispatch lifecycle events rather than mutating intent.
   */
  seekToIndex: (index: number, align: 'start' | 'center') => void
  /** Restore an arbitrary App-owned scroll-memory target through the same
   *  token-controlled owner used by follow and seek. Follow intent is unchanged. */
  restoreScroll: (target: number) => void
  /** Reveal a virtualized App anchor, then hold its row-relative offset. */
  restoreScrollToIndex: (index: number, offset: number, fallbackTarget: number) => void
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
  showEpoch,
  followEnabled = true,
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
  const lastShowGestureSeqRef = useRef(0)
  const lastScrollEpochRef = useRef<number | undefined>(undefined)
  // At-bottom mirror, read by callbacks (notably the viewport-shrink backstop)
  // without a stale-closure dance. Written by setBottomState.
  const atBottomRef = useRef(true)
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
  // Monotonic input sequence for seek takeover. Unlike Date.now(), this also
  // distinguishes a seek started and a gesture delivered in the same tick.
  const userGestureSeqRef = useRef(0)
  // True within the re-show settle window (see lastShowAtRef above), unless
  // the user has gestured since the re-show — an upward or downward input with
  // a LATER timestamp than lastShowAt ends suppression on the spot (a genuine
  // scroll-down-to-bottom right after switching back must still re-latch follow).
  const justReshowed = useCallback(() => {
    // Same clock as the gesture stamps (Date.now()).
    if (Date.now() - lastShowAtRef.current >= PANEL_RESHOW_SETTLE_MS) return false
    if (userGestureSeqRef.current > lastShowGestureSeqRef.current) return false
    return true
  }, [])
  const [followDebounceRaw] = useLocalStorage<number>(
    'claude-react-web:follow-debounce-ms',
    150,
  )
  const FOLLOW_DEBOUNCE_MS = clamp(Math.round(followDebounceRaw), 50, 500)

  /**
   * React's declarative projection of reducer follow intent. The owner renders
   * it as the wrap element's `data-following` attribute — the observable that
   * replaced the removed jump-to-bottom button as the tests' FOLLOWING/AWAY
   * assertion surface. (The attribute must live on an element the owner
   * renders, not on Virtuoso's scroller: react-hooks/immutability forbids
   * mutating the element obtained from `scrollerRef.current` inside hook
   * callbacks, and a declarative write needs no DOM access at all.)
   */
  const [following, setFollowingState] = useState(followEnabled)
  const scrollStateRef = useRef(createInitialScrollState(0, followEnabled ? 'follow' : 'away'))
  const epochRef = useRef(0)
  const panelVisibleRef = useRef(panelVisible)
  const attachedRevealKeyRef = useRef(transcriptRevealKey)
  const dispatchRef = useRef<(event: ScrollEvent) => void>(() => {})
  const focusNavigationRef = useRef(false)
  const thumbDraggingRef = useRef(false)
  // The writer stores these callbacks and invokes them only from later DOM or
  // scheduler events; no ref value is read while this initializer renders.
  // eslint-disable-next-line react-hooks/refs -- lazy writer construction with event-time ref readers
  const [writer] = useState(() => createTranscriptScrollWriter({
    getVirtuoso: () => virtuosoRef.current,
    firstItemIndex: () => firstItemIndexRef.current,
    onSeekEaseLanded: (token) => dispatchRef.current({ type: 'SEEK_EASE_LANDED', token }),
    onOwnerLanded: (token) => dispatchRef.current({ type: 'OWNER_LANDED', token }),
    onWorkConsumed: (id) => dispatchRef.current({ type: 'WORK_CONSUMED', id }),
    onFollowDebounce: () => {
      if (!followEnabled) return
      const el = scrollerRef.current
      if (!el) {
        atBottomRef.current = false
        return
      }
      if (scrollStateRef.current.intent === 'follow') return
      if (el.clientHeight === 0) {
        atBottomRef.current = false
        return
      }
      if (justReshowed()) return
      if (isAtTrueBottom(el)) {
        dispatchRef.current({ type: 'FOLLOW_REQUESTED' })
        atBottomRef.current = true
      } else {
        atBottomRef.current = false
      }
    },
    onFocusReset: () => { focusNavigationRef.current = false },
    onThumbClear: () => { thumbDraggingRef.current = false },
  }))
  const dispatch = useCallback((event: ScrollEvent) => {
    if (!followEnabled && (event.type === 'FOLLOW_REQUESTED' || event.type === 'FOLLOW_ANIMATION_REQUESTED' || event.type === 'USER_RETURNED_TO_TRUE_BOTTOM')) return
    const previous = scrollStateRef.current
    const transition = reduceScroll(previous, event)
    scrollStateRef.current = transition.state
    const nextFollowing = transition.state.intent === 'follow'
    if ((previous.intent === 'follow') !== nextFollowing) setFollowingState(nextFollowing)
    writer.execute(transition.commands)
  }, [followEnabled, writer])
  useLayoutEffect(() => {
    dispatchRef.current = dispatch
  }, [dispatch])

  // Stamp visibility before the remount-clamp scroll events of the show commit.
  // App-provided epochs replace visibility inference; mount still stamps once
  // so fresh Virtuoso clamps are suppressed too.
  useLayoutEffect(() => {
    panelVisibleRef.current = panelVisible
    const stampShow = () => {
      lastShowAtRef.current = Date.now()
      lastShowGestureSeqRef.current = userGestureSeqRef.current
      // Visibility retires gestures from the previous panel lifetime.
      userScrollIntentRef.current = 0
      dispatch({ type: 'VISIBILITY_CHANGED', visibility: 'visible' })
    }
    if (showEpoch !== undefined) {
      if (lastScrollEpochRef.current !== showEpoch) {
        lastScrollEpochRef.current = showEpoch
        if (panelVisible !== false) stampShow()
      } else {
        dispatch({ type: 'VISIBILITY_CHANGED', visibility: panelVisible === false ? 'hidden' : 'visible' })
      }
      return
    }
    if (panelVisible === false) dispatch({ type: 'VISIBILITY_CHANGED', visibility: 'hidden' })
    else stampShow()
  }, [dispatch, panelVisible, showEpoch])

  const setFollowing = useCallback((next: boolean) => {
    if (next) {
      dispatch({ type: 'FOLLOW_REQUESTED' })
    } else if (scrollStateRef.current.intent === 'follow') {
      dispatch({ type: 'USER_LEFT' })
    }
  }, [dispatch])

  const cancelContinuousOwner = useCallback(() => {
    const owner = scrollStateRef.current.owner
    if (owner.kind !== 'none') dispatch({ type: 'OWNER_CANCELLED', token: owner.token })
  }, [dispatch])

  const requestWork = useCallback((kind: WorkRequest['kind'], delivery: WorkRequest['delivery']) => {
    const workId = scrollStateRef.current.nextWorkId
    dispatch({ type: 'WORK_REQUESTED', kind, delivery })
    return workId
  }, [dispatch])

  const fireWork = useCallback((workId: number) => {
    if (scrollStateRef.current.work.some((work) => work.id === workId)) {
      dispatch({ type: 'WORK_FIRED', id: workId })
    }
  }, [dispatch])

  const startFoldOwner = useCallback(() => {
    const current = scrollStateRef.current
    if (current.owner.kind === 'fold') return current.owner.token
    const token = current.nextToken
    dispatch({ type: 'FOLD_STARTED' })
    requestWork('fold-release', 'after-owner')
    return token
  }, [dispatch, requestWork])

  /**
   * Request absolute-bottom alignment through the reducer/writer gateway. This
   * producer never writes scroll geometry or schedules its own callback.
   *
   * Every caller is a measurement CORRECTION — content grew or the viewport
   * shrank after we had already pinned — so the requested alignment reads as
   * "settle to bottom", not as a jump, and must not animate. The shared gate
   * lives here so a new backstop can't forget it: never yank a user who has
   * scrolled up.
   *
   * `allowDuringAnimation` exists for the append pin only. The two
   * ResizeObserver backstops must stand down while a follow owner is active,
   * but the append pin's whole job is to paint a freshly-mounted row at the
   * bottom in the frame it mounts — and a follow animation is usually still in
   * flight at that moment. Firing that request ahead of the animation is safe:
   * the writer's follow loop re-reads its target each frame, finds
   * `remaining ≈ 0`, and finalizes.
   */
  const pinToBottom = useCallback((
    el: HTMLElement | null = scrollerRef.current,
    {
      allowDuringAnimation = false,
      delivery = 'after-owner',
      verify = true,
    }: {
      allowDuringAnimation?: boolean
      delivery?: WorkRequest['delivery']
      verify?: boolean
    } = {},
  ) => {
    if (!el || scrollStateRef.current.intent !== 'follow') return
    if (scrollStateRef.current.owner.kind === 'follow' && !allowDuringAnimation) return
    if (anyCollapseAnimatingInside(el)) startFoldOwner()

    const absoluteId = requestWork('absolute-bottom', delivery)
    const owner = scrollStateRef.current.owner
    if (owner.kind === 'none' || (owner.kind === 'follow' && allowDuringAnimation)) {
      fireWork(absoluteId)
    }
    dbg('pin', () => ({ delivery, before: Math.round(el.scrollTop), after: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))

    if (verify) {
      const verifyId = requestWork('verify', 'after-owner')
      if (scrollStateRef.current.owner.kind === 'none') fireWork(verifyId)
    }
  }, [fireWork, requestWork, startFoldOwner])

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
  const scheduleTrailingMicroPin = useCallback(() => {
    for (const work of scrollStateRef.current.work) {
      if (work.kind === 'trailing-micro') dispatch({ type: 'WORK_CANCELLED', id: work.id })
    }
    dispatch({ type: 'WORK_REQUESTED', kind: 'trailing-micro', delivery: 'after-owner' })
  }, [dispatch])

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
    pinToBottom(scrollerRef.current, { allowDuringAnimation: true, delivery: 'next-observation' })
  })

  const clearFollowTimer = useCallback(() => {
    dispatch({ type: 'FOLLOW_DEBOUNCE_CANCELLED' })
  }, [dispatch])

  const setBottomState = useCallback((nextAtBottom: boolean) => {
    atBottomRef.current = nextAtBottom
  }, [])

  const syncBottomGeometry = useCallback((
    el: HTMLElement | null = scrollerRef.current,
    event?: BottomGeometryEvent,
  ) => {
    // Collapsed geometry carries no intent. The browser preserves scrollTop
    // across display:none and restores it on show.
    if (!el || el.clientHeight === 0) return
    const userLeft = event?.type === 'USER_LEFT'
    // A follow owner is intentionally away from its target mid-flight. Only a
    // genuine user leave may preempt that geometry.
    if (scrollStateRef.current.owner.kind === 'follow' && !userLeft) return

    const following = scrollStateRef.current.intent === 'follow'

    // Follow intent makes the true bottom an invariant. A genuine user leave
    // arrives as USER_LEFT and is excluded; an away viewport is never yanked.
    if (following && !userLeft && !isAtTrueBottom(el)) {
      dbg('follow-invariant', () => ({
        writer: 'follow-invariant',
        event: event?.type ?? 'GEOMETRY_CHANGED',
        distanceFromBottom: getDistanceFromTrueBottom(el),
      }))
      pinToBottom(el)
    }

    // Measure after the invariant correction. True bottom alone may re-arm
    // follow; spacer-aware bottom only describes the current geometry.
    const atBottom = isAtSpacerAwareBottom(el)
    const atTrueBottom = isAtTrueBottom(el)
    dbg('syncBottomGeometry', () => ({
      event: event?.type ?? 'GEOMETRY_CHANGED',
      atBottom,
      atTrueBottom,
      following,
    }))

    if (userLeft) {
      clearFollowTimer()
      setFollowing(false)
      setBottomState(false)
      return
    }

    const userReturned = event?.type === 'USER_RETURNED_TO_TRUE_BOTTOM'
    if (atTrueBottom && (following || userReturned)) {
      clearFollowTimer()
      dispatch({ type: userReturned ? 'USER_RETURNED_TO_TRUE_BOTTOM' : 'FOLLOW_REQUESTED' })
      setBottomState(true)
      return
    }

    if (atBottom) {
      // Content clamping into the spacer is not a user return. An already-away
      // viewport stays away and records that it is not at the true bottom.
      if (!following) {
        clearFollowTimer()
        setFollowing(false)
      }
      setBottomState(following)
      return
    }

    if (event?.type === 'FOLLOW_DEBOUNCE_REQUESTED') {
      // Keep the previous bottom mirror until the debounce confirms this
      // transient geometry; Virtuoso can report false during a batched append.
      if (!writer.isScheduled('follow-debounce')) {
        dispatch({ type: 'FOLLOW_DEBOUNCE_REQUESTED', delayMs: FOLLOW_DEBOUNCE_MS })
      }
      return
    }
    setBottomState(false)
  }, [FOLLOW_DEBOUNCE_MS, clearFollowTimer, dispatch, pinToBottom, setBottomState, setFollowing, writer])

  const confirmBottomGeometry = useCallback((el: HTMLElement | null = scrollerRef.current) => {
    syncBottomGeometry(el, { type: 'FOLLOW_DEBOUNCE_REQUESTED' })
  }, [syncBottomGeometry])

  // Animated scroll-to-bottom driven by a requestAnimationFrame easing loop.
  //
  // Why not native smooth scrolling? A native animation captures `scrollHeight`
  // ONCE at call time and animates toward
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
    const el = scrollerRef.current
    if (el && (scrollStateRef.current.owner.kind === 'fold' || anyCollapseAnimatingInside(el))) {
      startFoldOwner()
      requestWork('absolute-bottom', 'next-observation')
      return
    }
    dispatch({ type: 'FOLLOW_ANIMATION_REQUESTED' })
  }, [dispatch, requestWork, startFoldOwner])

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
      confirmBottomGeometry(current)
      const now = current.clientHeight
      const shrunk = now < lastHeight
      lastHeight = now
      dbg('scroller-RO', () => ({ shrunk, atBottomRef: atBottomRef.current }))
      // `current.clientHeight > 0`: never snap on the hide-flip — a
      // display:none scroller reads scrollHeight 0, so this scrollTo would
      // write scrollTop 0 on a collapsed box (and the follow invariant
      // re-pins to the real bottom once the panel is shown again anyway).
      if (shrunk && atBottomRef.current && current.clientHeight > 0) {
        pinToBottom(current)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [rowCount, pinToBottom, confirmBottomGeometry])

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
    dbg('spacer-pin', () => ({ bottomStackHeight, animating: scrollStateRef.current.owner.kind === 'follow' }))
    pinToBottom(undefined, { delivery: 'next-observation' })
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
    let lastContentHeight = 0
    let lastItemListH: number | null = null
    let lastPaddingTop: number | null = null
    let lastPaddingBottom: number | null = null
    const contentHeightOf = (scroller: HTMLElement) =>
      scroller.scrollHeight - getBottomSpacerHeight(scroller)
    const ro = new ResizeObserver((entries) => {
      if (cancelled) return
      const scroller = scrollerRef.current
      if (!scroller) return
      if (scroller.clientHeight === 0) {
        lastItemListH = null
        lastPaddingTop = null
        lastPaddingBottom = null
        return
      }

      const entry = entries[entries.length - 1]
      const itemList = entry.target as HTMLElement
      const itemListH = entry.borderBoxSize?.[0]?.blockSize ?? itemList.getBoundingClientRect().height
      const paddingTop = Number.parseFloat(itemList.style.paddingTop) || 0
      const paddingBottom = Number.parseFloat(itemList.style.paddingBottom) || 0
      const paddingDelta = (lastPaddingTop == null ? 0 : paddingTop - lastPaddingTop)
        + (lastPaddingBottom == null ? 0 : paddingBottom - lastPaddingBottom)
      const itemListDelta = lastItemListH == null ? null : itemListH - lastItemListH
      const contentHeight = contentHeightOf(scroller)
      const contentDelta = contentHeight - lastContentHeight
      const foldAnimating = anyCollapseAnimatingInside(scroller)
      const foldOwner = scrollStateRef.current.owner.kind === 'fold'
        ? scrollStateRef.current.owner.token
        : null

      if (foldAnimating) dispatch({ type: 'FOLD_OBSERVED' })
      dispatch({ type: 'GEOMETRY_CHANGED' })
      if ((foldAnimating && scrollStateRef.current.intent === 'follow') || foldOwner !== null) {
        const token = foldOwner ?? startFoldOwner()
        const frame: FoldFrame = {
          bodyHeights: snapshotBodyHeights(scroller),
          itemListDelta,
          contentDelta,
          paddingDelta,
          itemListHeight: itemListH,
          contentHeight,
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        }
        dispatch({ type: 'FOLD_FRAME', token, frame })
        if (foldAnimating && scrollStateRef.current.intent === 'follow') {
          lastItemListH = itemListH
          lastPaddingTop = paddingTop
          lastPaddingBottom = paddingBottom
          lastContentHeight = contentHeight
          return
        }
      }

      lastItemListH = itemListH
      lastPaddingTop = paddingTop
      lastPaddingBottom = paddingBottom
      if (scrollStateRef.current.intent !== 'follow' || scrollStateRef.current.owner.kind === 'follow') return
      if (Math.abs(contentDelta) < 1) return
      lastContentHeight = contentHeight
      if (Math.abs(contentDelta) <= ITEM_LIST_MICRO_DELTA_PX) {
        scheduleTrailingMicroPin()
        return
      }
      pinToBottom(scroller)
    })

    const scroller = scrollerRef.current
    const itemList = scroller?.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
    if (!scroller || !itemList) return () => ro.disconnect()
    lastContentHeight = contentHeightOf(scroller)
    ro.observe(itemList)
    return () => {
      cancelled = true
      ro.disconnect()
    }
  }, [transcriptRevealKey, hasRows, pinToBottom, scheduleTrailingMicroPin, startFoldOwner, dispatch])

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
    let listenersActive = true
    const handler = () => {
      const prevScrollTop = lastScrollTopRef.current
      lastScrollTopRef.current = el.scrollTop
      // Before the ANIMATING guard: the viewport really is moving during a
      // programmatic scroll, so the pinned header and search's nearest-match
      // must keep tracking it. Only the bottom-follow bookkeeping needs to
      // stand down mid-animation.
      emitVisibleTop()
      const isScrollingUp = el.scrollTop < prevScrollTop
      // Overlay-scrollbar recentering can move scrollTop opposite to the
      // pointer delta (an off-center grab). Attribute from the ACTUAL movement.
      if (thumbDraggingRef.current && el.scrollTop !== prevScrollTop) {
        if (isScrollingUp) markUserScrollIntent()
        else markScrollDownIntent()
      }
      if (focusNavigationRef.current && el.scrollTop !== prevScrollTop) {
        if (isScrollingUp) markUserScrollIntent()
        else markScrollDownIntent()
        focusNavigationRef.current = false
      }
      const distTrue = getDistanceFromTrueBottom(el)
      // During mechanical re-show settling, a PRE-show gesture cannot make
      // this scroll user-driven. A genuine post-show gesture stamps a newer
      // intent and justReshowed() becomes false, preserving normal chaining
      // and user-leave behavior.
      const userDriven = Date.now() - userScrollIntentRef.current <= USER_SCROLL_INTENT_MS && !justReshowed()
      // Chain the gesture: an animated wheel pan (or a thumb drag) emits scroll
      // events for hundreds of ms, and each upward one re-arms the window so the
      // whole gesture stays attributable to the user. Only upward events
      // re-arm, so our own downward pins and a downward gesture can't keep the
      // window alive.
      if (userDriven && isScrollingUp && scrollStateRef.current.owner.kind !== 'seek') userScrollIntentRef.current = Date.now()
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
      // no gesture AND no key/pointer sequence we can see — native find-in-page
      // jumping to a match, selection edge autoscroll — reads as a displacement
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
      if (scrollStateRef.current.owner.kind === 'follow' && !(userDriven && isScrollingUp)) return
      dbg('scroll-handler', () => ({ isScrollingUp, userDriven, isUserLeave, following: scrollStateRef.current.intent === 'follow', prevScrollTop, scrollTop: el.scrollTop, distTrue }))
      if (isUserLeave) {
        syncBottomGeometry(el, { type: 'USER_LEFT' })
      } else if (!isScrollingUp && distTrue <= BOTTOM_EPSILON_PX && !justReshowed()) {
        // The user actively scrolled back DOWN to the true bottom — the only
        // scroll-driven path that re-arms follow. A scrollTop drop caused by a
        // bottom-spacer COLLAPSE (task list finishes, clamp back to the new
        // max) must NOT re-latch an away user: the content moved, not them.
        syncBottomGeometry(el, { type: 'USER_RETURNED_TO_TRUE_BOTTOM' })
      } else {
        syncBottomGeometry(el)
      }
    }
    confirmBottomGeometry(el)
    el.addEventListener('scroll', handler, { passive: true })
    // Scroll-intent listeners for the same element lifetime. `wheel` +
    // `touch*` cover mouse/trackpad/touch gestures on the transcript; the
    // overlay scrollbar's thumb is a SIBLING of the scroller (it floats over
    // the parent), so its drag never reaches them and has to be caught at the
    // document — pointer events retarget to the captured thumb mid-drag, which
    // is what keeps the intent fresh for the whole drag.
    const markUserScrollIntent = () => {
      userGestureSeqRef.current += 1
      userScrollIntentRef.current = Date.now()
      leaveOnUpwardGesture()
      cancelContinuousOwner()
      onUserScrollIntentRef.current?.()
    }
    const markScrollDownIntent = () => {
      userGestureSeqRef.current += 1
      cancelContinuousOwner()
      onUserScrollIntentRef.current?.()
      // A direction change retires the old upward gesture. Otherwise a fresh
      // downward input ends re-show suppression and immediately re-activates
      // stale pre-show upward intent for the mechanical-leave test.
      userScrollIntentRef.current = 0
    }
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
      if (!scroller || scrollStateRef.current.intent !== 'follow') return
      if (scroller.scrollHeight - scroller.clientHeight <= BOTTOM_EPSILON_PX) return
      syncBottomGeometry(scroller, { type: 'USER_LEFT' })
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
    const wheelChainsToTranscript = (node: EventTarget | null, deltaY: number): boolean =>
      wheelChainsToScroller(el, node, deltaY)
    // Direction gates separate leave-capable inputs from downward inputs that
    // may only end re-show suppression; neither path attributes later mechanical
    // movement to a stale gesture while justReshowed() is true.
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
      if (e.deltaY > 0) {
        // Downward wheels are user intent too — stamp so justReshowed()'s
        // gesture-escape lets a genuine scroll-down-to-bottom right after a
        // keep-alive re-show re-latch follow — without the upward leave.
        markScrollDownIntent()
        return
      }
      if (e.deltaY === 0) return
      markUserScrollIntent()
    }
    // Scroll keys may target the scroller itself or a focused non-control
    // descendant (a Markdown link). Native scroll ownership keeps ArrowUp/Home
    // inside a nested block or text control from being read as a transcript
    // leave. Shift+Space is Chromium's other page-up.
    // Modifier-held arrows are NOT plain scroll keys: Alt+↑/↓ is the app-level
    // prev/next user-message shortcut (whose window-level dispatcher runs
    // AFTER this element handler) and Alt+Shift+↑/↓ moves sidebar groups —
    // classifying either as scroll intent drops follow and resets the
    // navigation cursor right before the shortcut's own seek.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Tab') {
        // The window-level Shift+Tab permission shortcut runs after this
        // listener. Arm only if it did not consume the chord.
        queueMicrotask(() => {
          if (!listenersActive || e.defaultPrevented) return
          focusNavigationRef.current = true
          dispatch({ type: 'FOCUS_RESET_REQUESTED' })
        })
        return
      }
      if (!keyboardTargetsScroller(el, e.target, e.key)) return
      if (e.ctrlKey || e.metaKey) {
        // Native Ctrl+End / Ctrl+Home are document-boundary scrolls, not the
        // app's Alt+Arrow navigation shortcuts.
        if (e.key === 'End') {
          markScrollDownIntent()
        } else if (e.key === 'Home') {
          markUserScrollIntent()
          leaveOnUpwardGesture()
        }
        return
      }
      if (e.altKey) return
      if (SCROLL_UP_KEYS.has(e.key) || (e.key === ' ' && e.shiftKey)) {
        markUserScrollIntent()
        leaveOnUpwardGesture()
        return
      }
      if (SCROLL_DOWN_KEYS.has(e.key) || e.key === ' ') {
        markScrollDownIntent()
      }
    }
    // Middle-click starts the browser's autoscroll on the nearest scrollable
    // ancestor — scoped to `el` so a middle-click on the sidebar can't mark
    // THIS transcript's intent. Its direction isn't known until it scrolls, so
    // this one keeps the intent+scroll-event path. Native autoscroll continues
    // after pointerup, so the origin is retained until another pointerdown.
    let middleOriginY: number | null = null
    const onMiddleDown = (e: PointerEvent) => {
      if (e.button !== 1) return
      // A second middle click toggles native autoscroll off.
      if (middleOriginY !== null) { middleOriginY = null; return }
      middleOriginY = middleClickTargetsScroller(el, e.target) ? e.clientY : null
    }
    const onMiddleMove = (e: PointerEvent) => {
      if (middleOriginY === null || ((e.buttons & 4) === 0 && e.buttons !== 0)) return
      // Native autoscroll direction is displacement FROM THE ORIGIN, not the
      // direction of the latest pointer move.
      if (e.clientY > middleOriginY) markScrollDownIntent()
      else if (e.clientY < middleOriginY) markUserScrollIntent()
    }
    const onMiddleCancel = (e: PointerEvent) => {
      if (e.button !== 1 || !(e.target instanceof Node && el.contains(e.target))) middleOriginY = null
    }
    const onMiddleKeyCancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') middleOriginY = null
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
      if ((e.buttons & 1) === 0) { // only the primary button can drag the thumb
        // The final movement's scroll event can arrive after pointerup. Keep
        // ownership through that event, then release on the next frame.
        if (thumbDraggingRef.current && !writer.isScheduled('thumb-clear')) {
          dispatch({ type: 'THUMB_CLEAR_REQUESTED' })
        }
        return
      }
      dispatch({ type: 'THUMB_CLEAR_CANCELLED' })
      const target = e.target as HTMLElement | null
      const track = target?.closest?.('.os-track')
      thumbDraggingRef.current = Boolean(track && track.parentElement === el.parentElement)
    }
    const onThumbCaptureLost = () => {
      // pointerup's grace frame must survive the ensuing capture-loss event so
      // the final asynchronous scroll is still attributed.
      if (!writer.isScheduled('thumb-clear')) thumbDraggingRef.current = false
    }
    // Touch is direction-gated like the wheel: dragging the finger DOWN moves the
    // content up (revealing older messages), which is the leave-capable
    // direction; the other direction moves toward the bottom and may end
    // re-show suppression without triggering a leave.
    let lastTouchY: number | null = null
    let touchOwnedByTranscript = false
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? null
      touchOwnedByTranscript = touchTargetsScroller(el, e.target)
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? null
      if (y == null || lastTouchY == null) { lastTouchY = y; return }
      const draggedDown = y > lastTouchY
      const draggedUp = y < lastTouchY
      lastTouchY = y
      // A drag in EITHER direction invalidates a pending navigation target;
      // only the leave-capable direction can drop follow. A horizontal move
      // with no vertical delta is not a scroll-down gesture.
      if (!draggedDown && !draggedUp) return
      if (!touchOwnedByTranscript) return
      if (draggedDown) markUserScrollIntent()
      else if (draggedUp) markScrollDownIntent()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('pointerdown', onMiddleDown, true)
    document.addEventListener('pointermove', onMiddleMove, true)
    document.addEventListener('pointerdown', onMiddleCancel, true)
    document.addEventListener('keydown', onMiddleKeyCancel, true)
    document.addEventListener('pointerdown', onPointerOnThumb, true)
    document.addEventListener('pointermove', onPointerOnThumb, true)
    document.addEventListener('pointerup', onPointerOnThumb, true)
    document.addEventListener('pointercancel', onThumbCaptureLost, true)
    document.addEventListener('lostpointercapture', onThumbCaptureLost, true)
    return () => {
      listenersActive = false
      dispatch({ type: 'THUMB_CLEAR_CANCELLED' })
      dispatch({ type: 'FOCUS_RESET_CANCELLED' })
      thumbDraggingRef.current = false
      focusNavigationRef.current = false
      el.removeEventListener('scroll', handler)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('pointerdown', onMiddleDown, true)
      document.removeEventListener('pointermove', onMiddleMove, true)
      document.removeEventListener('pointerdown', onMiddleCancel, true)
      document.removeEventListener('keydown', onMiddleKeyCancel, true)
      document.removeEventListener('pointerdown', onPointerOnThumb, true)
      document.removeEventListener('pointermove', onPointerOnThumb, true)
      document.removeEventListener('pointerup', onPointerOnThumb, true)
      document.removeEventListener('pointercancel', onThumbCaptureLost, true)
      document.removeEventListener('lostpointercapture', onThumbCaptureLost, true)
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
  }, [hasRows, syncBottomGeometry, confirmBottomGeometry, emitVisibleTop, transcriptRevealKey, cancelContinuousOwner, dispatch, writer, justReshowed])

  // Re-read the spacer-aware geometry when the spacer COMMITS a new height.
  //
  // `syncBottomGeometry` reads the spacer from the DOM (getBottomSpacerHeight),
  // not from this number, so the value here is only a trigger: a taller task
  // list / dock widens the dead zone and can flip the spacer-aware at-bottom
  // state. Split out of the listener effect above so the height churn of a
  // fold does not re-bind listeners.
  useEffect(() => {
    confirmBottomGeometry(scrollerRef.current)
  }, [bottomStackHeight, confirmBottomGeometry])

  // Clean up the follow debounce timer on unmount.
  useEffect(() => () => {
    clearFollowTimer()
  }, [clearFollowTimer])

  // React StrictMode replays this effect's cleanup/setup in development. Setup
  // reactivates the same writer, reattaches the current ref, and restores the
  // reducer's attachment/visibility; a real unmount has no later setup, so
  // disposal remains terminal and stale captured callbacks stay invalid through
  // the attachment invalidation in dispose().
  useEffect(() => {
    const current = scrollerRef.current
    writer.activate()
    writer.attach(current, epochRef.current)
    if (current) {
      dispatch({ type: 'ELEMENT_ATTACHED', element: current })
      dispatch({ type: 'VISIBILITY_CHANGED', visibility: panelVisibleRef.current === false ? 'hidden' : 'visible' })
    }
    return () => {
      dispatch({ type: 'UNMOUNTED' })
      writer.dispose()
    }
  }, [dispatch, writer])

  // --- Virtuoso wiring ----------------------------------------------------

  const scrollerRefCb = useCallback((ref: HTMLElement | Window | null) => {
    const prev = scrollerRef.current
    if (prev && prev !== ref) prev.classList.remove('chat-virtuoso-scroller')
    if (ref && ref instanceof HTMLElement) {
      if (attachedRevealKeyRef.current !== transcriptRevealKey) {
        attachedRevealKeyRef.current = transcriptRevealKey
        epochRef.current += 1
        dispatch({ type: 'EPOCH_CHANGED', epoch: epochRef.current })
      }
      ref.classList.add('chat-virtuoso-scroller')
      scrollerRef.current = ref
      writer.attach(ref, epochRef.current)
      dispatch({ type: 'ELEMENT_ATTACHED', element: ref })
      setOsScroller(ref)
      confirmBottomGeometry(ref)
      return
    }
    scrollerRef.current = null
    writer.attach(null)
    dispatch({ type: 'ELEMENT_DETACHED' })
    setOsScroller(null)
  }, [dispatch, writer, transcriptRevealKey, confirmBottomGeometry, setOsScroller])

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
    if (!followEnabled) return false as const
    if (scrollStateRef.current.intent !== 'follow') return false as const
    animateScrollToBottom()
    return false as const
  }, [animateScrollToBottom, followEnabled])

  const atBottomStateChange = useCallback((reportedAtBottom: boolean) => {
    if (!followEnabled) return
    // Prefer direct DOM geometry so both measurements use the same bottom
    // definition. Before attachment, Virtuoso's report is the only sample.
    const el = scrollerRef.current
    if (el) {
      confirmBottomGeometry(el)
      return
    }
    if (reportedAtBottom) {
      clearFollowTimer()
      setFollowing(true)
      setBottomState(true)
    } else if (!writer.isScheduled('follow-debounce')) {
      dispatch({ type: 'FOLLOW_DEBOUNCE_REQUESTED', delayMs: FOLLOW_DEBOUNCE_MS })
    }
  }, [FOLLOW_DEBOUNCE_MS, clearFollowTimer, confirmBottomGeometry, dispatch, followEnabled, setBottomState, setFollowing, writer])

  const jumpToBottom = useCallback(() => {
    if (!followEnabled) return
    focusNavigationRef.current = false
    dispatch({ type: 'FOCUS_RESET_CANCELLED' })
    thumbDraggingRef.current = false
    setFollowing(true)
    setBottomState(true)
    clearFollowTimer()
    onUserScrollIntentRef.current?.()
    scrollerRef.current?.dispatchEvent(new CustomEvent(TRANSCRIPT_SEEK_EVENT, { bubbles: true }))
    animateScrollToBottom()
  }, [animateScrollToBottom, clearFollowTimer, dispatch, followEnabled, setBottomState, setFollowing])

  const seekToIndex = useCallback((index: number, align: 'start' | 'center') => {
    focusNavigationRef.current = false
    dispatch({ type: 'FOCUS_RESET_CANCELLED' })
    thumbDraggingRef.current = false
    scrollerRef.current?.dispatchEvent(new CustomEvent(TRANSCRIPT_SEEK_EVENT, { bubbles: true }))
    dispatch({ type: 'SEEK_REQUESTED', index, align })
  }, [dispatch])

  const restoreScroll = useCallback((target: number) => {
    dispatch({ type: 'RESTORE_REQUESTED', target })
  }, [dispatch])

  const restoreScrollToIndex = useCallback((index: number, offset: number, fallbackTarget: number) => {
    dispatch({ type: 'RESTORE_REQUESTED', target: fallbackTarget, reveal: { index, offset } })
  }, [dispatch])

  return {
    following,
    scrollerRefCb,
    followOutput,
    atBottomStateChange,
    jumpToBottom,
    seekToIndex,
    restoreScroll,
    restoreScrollToIndex,
    getVisibleTopIndex,
  }
}
