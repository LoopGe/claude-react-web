// Virtualised message transcript for one session.
//
// Uses react-virtuoso to render only the visible slice of messages,
// keeping DOM node count bounded regardless of transcript length.
// Keeps the list pinned to the bottom unless the user scrolls up — once
// they do, new messages append silently instead of yanking the viewport.
// Filters out `stream_event` partials (the final assistant message
// carries the complete content, so showing both just flickers).

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Markdown } from './Markdown'
import { PlanStatusProvider, PlanContentProvider, ToolStatusProvider, ToolResultProvider } from '../hooks/usePlanStatus'
import { QuestionAnswersProvider } from '../hooks/useQuestionAnswers'
import { TaskInfoProvider } from '../hooks/useTaskInfo'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { SessionCwdProvider } from '../hooks/useSessionCwd'
import { BackgroundToolProvider } from '../hooks/useBackgroundTool'
import type { SdkMessage } from '../types'
import { formatTokens, formatElapsed, formatClockTime, formatFullTimestamp } from '../utils/format'
import { buildTaskStateMap } from '../utils/task-events'
import { shouldArmEnterAnimation } from '../utils/enter-animation'
import { Tooltip } from './Tooltip'
import { useLocalStorage } from '../hooks/useLocalStorage'
import type { ActiveSubagent, PlanStatus, ToolResultEntry, ToolStatus, TranscriptItem } from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'
import { getBlocks, getEnterPlanToolUseIds, isHumanUserMessage, isTaskNotificationUserMessage, userMessageOriginKind } from '../session-store/normalize'
import { useSubagentContext } from '../hooks/useSubagentContext'
import { useWorkflowContext } from '../hooks/useWorkflowContext'
import { IconArrowDown, IconZap, IconUser, IconExternalLink, IconSquare, IconClock, IconListTodo, IconX } from './icons/ToolIcons'
import { countMatches, extractPlainText, extractMessagePlainText, extractToolUseDiffText } from '../search'
import { BlockView, ToolResultBlock } from './message-list/blocks'
import { OlderHistoryHeader, StreamingFooter } from './message-list/transcript-chrome'
import { ChatEmptyState } from './ChatEmptyState'
import { EasterEggGame } from './EasterEggGame'
import { AnsiText } from './AnsiText'
import { ResultConsumedCtx, useResultConsumed } from './message-list/result-consumed-context'
import { extractUserText, makeResultConsumed, willRenderEmpty } from './message-list/rendering'

/** Re-export type for backward compatibility (types don't affect Fast Refresh). */
export type { ActiveSubagent } from '../session-store/types'

/** Stable empty sentinel for the TaskInfoProvider value when the session
 *  has no TaskCreate/TaskUpdate events, so the provider value stays
 *  referential across renders (consumers' useContext equality check). */
const EMPTY_TASK_MAP = new Map<string, never>()

/** Scroll-navigation surface registered by MessageList and held by the parent
 *  (Chat) for the pinned-header dropdown + right-click menu. `to(index)`
 *  jumps to a specific renderable item (used by the dropdown); `prev`/`next`
 *  step to the adjacent user message. */
export interface ScrollNavigator {
  prev: () => void
  next: () => void
  to: (index: number) => void
}

interface Props {
  items: TranscriptItem[]
  /** Whether the session is currently processing a turn. Gates the
   *  "processing" indicator on consumed user messages so it doesn't
   *  reappear on historical messages after a reconnect. */
  working?: boolean
  /** True while a /clear is in flight (trigger → session-cleared frame).
   *  Adds a blur-fade-out to the transcript and a "Clearing…" veil so the
   *  ~1.7s server teardown+respawn reads as an intentional transition
   *  instead of a frozen screen followed by a hard snap to empty. */
  clearing?: boolean
  /** False while the initial replay from the server is still buffering.
   *  Gates the transcript reveal animation (the one-shot entrance fade on
   *  keyed messages) so it only fires once the replayed content has landed.
   *  No longer gates a loading skeleton — an empty transcript shows the
   *  empty-state immediately (the local /clear X→Y swap mints a fresh,
   *  history-less session; showing a skeleton there until replay-done
   *  arrived was a visible glitch under the clearing veil). */
  replayReady?: boolean
  /** Stable key for the owning transcript (session id in the main chat).
   *  When provided, a ready transcript gets one subtle reveal on mount/load. */
  transcriptRevealKey?: string
  /** Accumulated text from streaming deltas. When non-null, a live
   *  "typing" bubble is rendered at the bottom of the transcript. */
  streamingContent?: string | null
  /** Transient `api_retry` frame (rate-limit retry indicator), or null when
   *  no retry is in flight. Rendered as a tail divider via ApiRetryView (it
   *  lives outside items/messages/IDB — a dedicated transient slot — so this
   *  synthesizes a tail item for rendering only). */
  apiRetry?: SdkMessage | null
  /** Precomputed plan status keyed by toolUseId. */
  planStatus?: ReadonlyMap<string, PlanStatus>
  /** Plan body text extracted from ExitPlanMode tool_result outputs. */
  planContent?: ReadonlyMap<string, string>
  /** Parsed AskUserQuestion answers keyed by tool_use_id. Empty array
   *  means pending (tool_use seen, answer not yet submitted). */
  questionAnswers?: ReadonlyMap<string, QuestionAnswerEntry[]>
  /** Generic tool lifecycle (running/success/error) keyed by tool_use_id.
   *  Drives the status badge on each ToolUseBlock card. */
  toolStatus?: ReadonlyMap<string, ToolStatus>
  /** Captured tool_result payloads keyed by tool_use_id. Each generic
   *  tool card renders its own result inline; the standalone "tool result"
   *  bubble is suppressed for any tool_use_id present here. */
  toolResults?: ReadonlyMap<string, ToolResultEntry>
  /** Current search query. When non-empty, matching text inside messages
   *  is highlighted. */
  searchQuery?: string
  /** Index (into the items array) of the item that should be
   *  scrolled into view and visually highlighted as the active search
   *  result. -1 means no active result. */
  searchActiveMsgIdx?: number
  /** Local match index inside the active item —i.e. for the message
   *  pointed at by `searchActiveMsgIdx`, this names which of its
   *  matches is the user's current navigation target. Lets the
   *  renderer style ONE specific `<mark>` differently (warn-coloured
   *  background) instead of just "the whole message". -1 / undefined
   *  means "no active match in this item" (or the active hit lives in
   *  a different item). */
  searchActiveMatchInItem?: number
  /** Filter mode for parent_tool_use_id:
   *  - undefined / null: only show root messages (parent_tool_use_id == null).
   *    This is the default for the main transcript —subagent-internal
   *    messages are hidden and replaced by SubagentCards in their parent's
   *    tool_use slot.
   *  - string: only show messages whose parent_tool_use_id matches.
   *    Used by SubagentOverlay to render one subagent's inner conversation. */
  parentToolUseIdFilter?: string | null
  /** Items prepended to the rendered list BEFORE the parent-filtered
   *  children, bypassing the parent_tool_use_id filter. Used by
   *  SubagentOverlay to surface a subagent's input prompt as a synthetic
   *  leading bubble at the top of the inner conversation (the SDK doesn't
   *  echo an async subagent's prompt as a child frame). The caller picks
   *  the item's own parent_tool_use_id to control how MessageView labels
   *  it — SubagentOverlay uses the subagent id so it renders via the
   *  subagent-internal branch, matching the sync echo. */
  leadingItems?: TranscriptItem[]
  /** Items appended to the rendered list AFTER the parent-filtered
   *  children, bypassing the parent_tool_use_id filter. Used by
   *  SubagentOverlay to surface a synchronous subagent's result as a
   *  final bubble at the bottom (the Agent tool_result lands on the MAIN
   *  thread with parent_tool_use_id = null, so the filter would otherwise
   *  hide it). Skipped for async subagents, whose reply already streams as
   *  a child assistant frame. */
  trailingItems?: TranscriptItem[]
  /** Lazy-load the previous page of history from disk and prepend it.
   *  Only wired for the main transcript (not subagent overlays). When
   *  provided AND `hasOlder` is true, scrolling to the top triggers it. */
  loadOlder?: () => Promise<number>
  /** Whether older history may exist on disk before the first shown message.
   *  Gates the scroll-to-top trigger and the "loading older" affordance. */
  hasOlder?: boolean
  /** True while a loadOlder() request is in flight (drives the top spinner). */
  loadingOlder?: boolean
  /** Register a navigator that scrolls the transcript to the previous /
   *  next real user message relative to the current viewport top. Wired up
   *  the chain to the session right-click menu ("Scroll to previous/next
   *  user message") and the pinned-header dropdown. The callback identity
   *  is stable for the component's lifetime, so the parent can register it
   *  once. */
  onRegisterNavigate?: (nav: ScrollNavigator) => void
  /** Reports the full list of real top-level user messages currently
   *  rendered, oldest→newest, as {id, text, index}. `index` is the
   *  renderable-item index (passable to ScrollNavigator.to). Used by the
   *  pinned-header dropdown to list every question for direct jump. Fires
   *  only when the list identity changes (length + every id), not on every
   *  render. */
  onUserMessagesChange?: (msgs: { id: string; text: string; index: number }[]) => void
  /** Override the empty-state content shown when there are no messages and
   *  replay is ready. Defaults to a generic "Type a message below to start
   *  the conversation." prompt. Side Chat overrides this to communicate the
   *  ephemeral nature of the drawer. */
  emptyStateContent?: ReactNode
  /** True when the session is expected to have history (e.g. a discard-fork
   *  seeded from a prior conversation, or a resumed session). When set, the
   *  empty-state is suppressed until `replayReady` so the "Start a
   *  conversation" placeholder doesn't flash during the replay window
   *  between the panel swap and the history landing. A fresh /clear session
   *  passes false (or omits) so its empty-state shows immediately. */
  expectHistory?: boolean
  /** Called when the user clicks "Switch model" on a model_not_found error
   *  message. The parent opens its model picker / settings so the user can
   *  pick a valid model without leaving the transcript. */
  onSwitchModel?: () => void
  /** Called when the visible range of messages changes. Reports the
   *  top-most visible item index (in data-array space). Used by the
   *  search system to find the nearest match to the viewport. */
  onVisibleRangeChange?: (topIdx: number) => void
  /** Reports the real user message that should be pinned at the top of the
   *  panel as a "current question" header — the last top-level user message
   *  whose index is strictly above the viewport top (i.e. it has scrolled out
   *  of view). null when the topmost visible region is at or above the most
   *  recent user message (nothing to pin). Fires ONLY when the pinned message
   *  identity changes, so callers don't re-render on every scroll tick. The
   *  chosen message is exactly what `navigate('prev')` scrolls to, so a
   *  parent-rendered pin header can jump back to it via the registered
   *  navigator. */
  onPinnedUserMessageChange?: (info: { id: string; text: string } | null) => void
  /** Force-stop the current in-flight `!`/`!!` command. Wired to the "stop"
   *  button on a pending bash card. Undefined when no abort surface is
   *  available (e.g. Side Chat drawer renders its own MessageList without it). */
  onAbortBash?: () => void
  /** Owning session's cwd. Provided to nested tool cards via SessionCwd
   *  context so EditToolView can resolve real file line numbers via
   *  /api/edit-locate. Undefined when no cwd is in scope. */
  cwd?: string
  /** Background ONE in-flight tool call (Ctrl+B semantics, per-tool precision).
   *  Provided to nested tool cards via the BackgroundTool context so running
   *  Bash cards / synchronous subagent cards can offer a "background this"
   *  button keyed on their own tool_use id. Undefined where backgrounding
   *  isn't wired (Side Chat drawer, WorkflowOverlay, transcript exports —
   *  only the main Chat and SubagentOverlay message lists provide it), and
   *  whenever no turn is active (Chat gates it on its turn-active signal so
   *  a card stuck on 'running' can't offer a dead action). */
  onBackgroundTool?: (toolUseId: string) => void
}

/** An item in the Virtuoso data array. Pre-computing isCompactSummary
 *  here avoids the renderable[i-1] look-back during itemContent.
 *  `itemIndex` maps back to the original items[] position for search
 *  result scrolling (search indices reference the full, unfiltered list). */
interface RenderableItem {
  /** Stable per-message id (SdkMessage uuid, or a synthetic fallback).
   *  Drives the new-message entrance-animation gate —see knownIdsRef. */
  id: string
  msg: SdkMessage
  isCompactSummary: boolean
  renderableIndex: number
  itemIndex: number
  /** Optimistic placeholder still in flight —drives the user bubble's
   *  "sending" spinner. Cleared automatically by the reducer when the
   *  server's broadcast lands and the optimistic gets swapped out. */
  sending?: boolean
  /** Queue-delivery state of a top-level user turn ('queued' = waiting
   *  behind an in-flight turn, 'consumed' = SDK has started processing).
   *  Undefined for everything else. Drives the queued/processing chip. */
  deliveryStatus?: 'queued' | 'consumed'
  /** Wall-clock ms when first observed. Carried from the TranscriptItem so
   *  the entrance-animation gate can tell a live arrival (timestamp present)
   *  from disk-restored history (undefined). */
  receivedAt?: number
}

/** Stable empty-Map sentinels. Using `= new Map()` in the parameter
 *  defaults below would allocate a fresh Map on every render and defeat
 *  React.memo equality whenever a parent omits these props. */
const EMPTY_PLAN_STATUS: ReadonlyMap<string, PlanStatus> = new Map()
const EMPTY_PLAN_CONTENT: ReadonlyMap<string, string> = new Map()
const EMPTY_QUESTION_ANSWERS: ReadonlyMap<string, QuestionAnswerEntry[]> = new Map()
const EMPTY_TOOL_STATUS: ReadonlyMap<string, ToolStatus> = new Map()
const EMPTY_TOOL_RESULTS: ReadonlyMap<string, ToolResultEntry> = new Map()

/** Pixel tolerance for direct bottom checks. Keep this tiny to cover
 *  fractional scroll values without treating a visibly offset viewport as
 *  being at the bottom. */
const BOTTOM_EPSILON_PX = 2

const getStreamingSpacerHeight = (el: HTMLElement) => {
  const spacer = el.querySelector<HTMLElement>('.virtuoso-streaming-spacer')
  if (!spacer) return 0

  const rectHeight = spacer.getBoundingClientRect().height
  if (rectHeight > 0) return rectHeight

  const styleHeight = Number.parseFloat(spacer.style.height || getComputedStyle(spacer).height)
  return Number.isFinite(styleHeight) ? styleHeight : 0
}

const getDistanceFromBottom = (el: HTMLElement) => (
  Math.max(0, el.scrollHeight - getStreamingSpacerHeight(el) - el.scrollTop - el.clientHeight)
)

const getBottomGeometry = (el: HTMLElement) => {
  const distanceFromBottom = getDistanceFromBottom(el)
  const atBottom = distanceFromBottom <= BOTTOM_EPSILON_PX
  return { atBottom, canJumpToBottom: !atBottom }
}

type FollowMode = 'restore' | 'disable-now' | 'disable-debounced' | 'preserve'
type BottomSyncMode = FollowMode | 'confirm-away'

/** Entrance-animation gate tunables (see the gate block in MessageList).
 *  MAX_ENTER_BATCH —only animate when the tail grows by at most this many
 *    ids at once; a larger jump means a bulk load (replay / page), not a
 *    live trickle.
 *  ENTER_MAX_AGE_MS — a tail id only animates if its receivedAt is within
 *    this window of now; filters disk-restored history whose timestamps are
 *    stale even if it somehow reaches the tail path.
 *  KNOWN_IDS_CAP —hard bound on the seen-id set for very long sessions. */
const MAX_ENTER_BATCH = 4
const ENTER_MAX_AGE_MS = 10_000
const KNOWN_IDS_CAP = 4000
const STREAMING_EXIT_MS = 180

/** Return a `Set` whose *identity* is stable as long as its *contents* are
 *  unchanged.
 *
 *  Plain `useMemo(() => new Set(...), [dep])` rebuilds a brand-new Set on
 *  every dep change even when the derived contents are identical (e.g.
 *  `items` got a new array reference from a streaming token flush that
 *  didn't add any EnterPlanMode). That new identity then flows into
 *  `makeResultConsumed` → `ResultConsumedCtx.Provider value` → defeats
 *  every `MessageView`'s `memo`, re-rendering the whole visible transcript
 *  on each new completed message.
 *
 *  This guard compares the candidate to the previously-returned Set (same
 *  size + every element of the candidate already present in the previous)
 *  and reuses the previous reference when equal, so the context value only
 *  changes when the predicate would actually answer differently. */
function useStableSet(candidate: Set<string>): Set<string> {
  // Referential-stability memo: cache the previous Set and reuse it when the
  // candidate is content-equal, so context consumers don't re-render on every
  // parent render. Refs are read/written during render by design here — the
  // value is only used to short-circuit this function and self-corrects on the
  // next render — so the react-hooks/refs rule is disabled for the body.
  /* eslint-disable react-hooks/refs -- intentional render-time ref use for referential memoization */
  const prevRef = useRef<Set<string>>(candidate)
  const prev = prevRef.current
  if (prev === candidate) return candidate
  if (prev.size === candidate.size) {
    let same = true
    for (const id of candidate) {
      if (!prev.has(id)) { same = false; break }
    }
    if (same) return prev
  }
  prevRef.current = candidate
  return candidate
  /* eslint-enable react-hooks/refs */
}

export const MessageList = memo(function MessageList({ items, working, clearing, replayReady = true, transcriptRevealKey, streamingContent, apiRetry, planStatus = EMPTY_PLAN_STATUS, planContent = EMPTY_PLAN_CONTENT, questionAnswers = EMPTY_QUESTION_ANSWERS, toolStatus = EMPTY_TOOL_STATUS, toolResults = EMPTY_TOOL_RESULTS, searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, parentToolUseIdFilter, leadingItems, trailingItems, loadOlder, hasOlder = false, loadingOlder = false, onRegisterNavigate, onUserMessagesChange, emptyStateContent, expectHistory, onSwitchModel, onAbortBash, onVisibleRangeChange, onPinnedUserMessageChange, cwd, onBackgroundTool }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // Captures Virtuoso's underlying scroll element so a ResizeObserver
  // can detect viewport shrink (TodoChecklist panel growing).
  const scrollerRef = useRef<HTMLElement | null>(null)
  // Overlay scrollbar: hides the native bar and floats a thumb over
  // .chat-messages (the scroller's parent). DOM-non-invasive, so Virtuoso's
  // direct scrollTop/scrollHeight measurements on scrollerRef are untouched.
  const setOsScroller = useOverlayScrollbar({ autoHide: 'leave' })
  const streamingRegionRef = useRef<HTMLDivElement | null>(null)
  // --- /clear blur ----------------------------------------------------
  // MessageList applies `.chat-messages-clearing` (see messagesClassName
  // below) while `clearing` is true — the view-only blur that signals a
  // clear in progress during the POST. There is no panel-level veil anymore;
  // the fresh session Y plays `.entering` on mount.
  const [streamingOverlayHeight, setStreamingOverlayHeight] = useState(0)
  // Easter-egg: triple-clicking the empty-state sparkle swaps in a hidden
  // dino-style game. Local UI state only — no session/persistence concerns.
  const [gameOpen, setGameOpen] = useState(false)
  // Stable identities so EasterEggGame's [onExit]-keyed keydown effect
  // doesn't tear down/re-register on every parent re-render.
  const openEasterEgg = useCallback(() => setGameOpen(true), [])
  const closeEasterEgg = useCallback(() => setGameOpen(false), [])
  // `atBottom` is state (not a ref) because the jump-to-bottom button's
  // visibility needs to re-render when it changes. The ref-mirror keeps
  // callbacks readable without a stale-closure dance.
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const [canJumpToBottom, setCanJumpToBottom] = useState(false)
  // Debounced "should follow" ref —filters out transient isAtBottom=false
  // spikes that Virtuoso emits during rapid/batch item additions (the
  // scroll-to-bottom animation hasn't settled yet, so Virtuoso's internal
  // isAtBottom momentarily flips false). Only after isAtBottom stays false
  // for FOLLOW_DEBOUNCE_MS do we actually stop following.
  const shouldFollowRef = useRef(true)
  const followTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks the previous scrollTop so the scroll handler can detect
  // *user-driven* upward scrolls (scrollTop decreasing) and bypass the
  // follow-disable debounce — see the scroll-listener effect for why.
  const lastScrollTopRef = useRef(0)
  // Duration guard held TRUE for the whole of a programmatic smooth
  // scroll-to-bottom animation (jump-to-bottom click, and a new-message
  // follow). While true, both the scroll-event handler and
  // `syncBottomGeometry` short-circuit: they leave atBottomRef=true and
  // shouldFollowRef=true alone. This is what lets the animation play
  // without the follow-disable machinery misreading the mid-animation
  // "not yet at bottom" gap as a user scroll-away and arming the 150ms
  // follow-disable debounce (which would fire mid-animation, flip
  // shouldFollow/atBottom false, and re-introduce the "lands short /
  // doesn't follow the next message" bug). The guard is bounded by the
  // rAF loop's own completion (reaches the real bottom) or cancellation
  // (user scrolls up mid-animation), so it can never latch forever.
  const scrollAnimatingRef = useRef(false)
  // rAF handle for the in-flight animated scroll, so a new jump (or
  // unmount) can cancel the previous loop instead of stacking two
  // animations that fight over scrollTop.
  const scrollAnimRafRef = useRef<number | null>(null)
  const [followDebounceRaw] = useLocalStorage<number>(
    'claude-react-web:follow-debounce-ms',
    150,
  )
  const FOLLOW_DEBOUNCE_MS = Math.max(50, Math.min(500, Math.round(followDebounceRaw)))
  /** How many new messages have arrived since the user last saw the
   *  bottom. Badge number on the jump-to-bottom button. */
  const [unseenCount, setUnseenCount] = useState(0)
  const unseenCountRef = useRef(0)

  // Synchronous bottom-pin for freshly-appended trailing items.
  //
  // Root cause of the "new message flashes one row too high, then snaps
  // down" jitter: when `items` grows, Virtuoso has already grown
  // `scrollHeight` to include the new row by the time React commits (the
  // sizer is up to date), but `scrollTop` is still at the OLD bottom. The
  // follow-scroll (`followOutput` → `animateScrollToBottom`) only runs its
  // first step on the NEXT `requestAnimationFrame`, so the browser paints
  // one frame with the new row pushed ~1 row below the viewport bottom
  // (equivalently: the transcript sitting one row too high). That single
  // stale-`scrollTop` frame is the visible jump.
  //
  // Fix: pin `scrollTop` to the bottom right here in `useLayoutEffect` —
  // after the DOM mutation, BEFORE paint — so the new row is painted at the
  // bottom in the very frame it mounts. `scrollHeight` is already correct at
  // this point (proven by instrumentation), so this is an exact pin, not an
  // estimate. The rAF ease still runs afterward but finds `remaining ≈ 0`
  // and finalizes immediately, so the two never fight. Gated on
  // `shouldFollowRef` so we never yank a user who has scrolled up.
  const prevPinItemsLenRef = useRef(items.length)
  useLayoutEffect(() => {
    const prevLen = prevPinItemsLenRef.current
    prevPinItemsLenRef.current = items.length
    if (items.length <= prevLen) return
    if (!shouldFollowRef.current) return
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
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
  }, [])

  const syncBottomState = useCallback((
    nextAtBottom: boolean,
    followMode: FollowMode,
  ) => {
    if (nextAtBottom || followMode !== 'disable-debounced') {
      setBottomState(nextAtBottom)
    }

    if (nextAtBottom) {
      clearUnseen()
    }

    if (followMode === 'restore') {
      clearFollowTimer()
      shouldFollowRef.current = true
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
        // when below is unavailable-looking / away, restore follow when back.
        if (geometry.atBottom) {
          setCanJumpToBottom(false)
          setBottomState(true)
          shouldFollowRef.current = true
          clearUnseen()
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
    // While a programmatic smooth-scroll animation is in flight, the viewport
    // is intentionally not yet at the bottom. Don't let that mid-animation
    // gap arm the follow-disable debounce or flip atBottomRef false (which
    // would re-show the jump button and disarm the streaming re-pin path the
    // animation depends on). Treat the viewport as still-at-bottom until the
    // rAF loop completes and clears the guard. See scrollAnimatingRef.
    if (scrollAnimatingRef.current) {
      return getBottomGeometry(el)
    }
    const geometry = getBottomGeometry(el)
    const delayAway = modeWhenAway === 'confirm-away' && !geometry.atBottom && atBottomRef.current
    // Never surface the jump button while we're still auto-following / pinned
    // to the bottom (`shouldFollowRef.current`). During a bulk replay/load the
    // scroller's content (scrollHeight) grows faster than the follow/pin can
    // move scrollTop, so a raw geometry read transiently reports "not at
    // bottom" mid-pin and then "at bottom" again once the pin catches up —
    // flashing the button on/off every growth batch even though the user never
    // left the bottom. (This is the flicker observed on session switches: the
    // reveal-pending window hides it only for the first batches; it continues
    // after reveal.) The button only becomes meaningful once follow has been
    // disabled — either the user scrolled up ('disable-now' flips
    // shouldFollowRef false immediately) or the 150ms follow-disable debounce
    // below confirmed a genuine stay-away. While following, keep it hidden.
    const following = shouldFollowRef.current
    const canJump = following ? false : geometry.canJumpToBottom
    setCanJumpToBottom(delayAway ? false : canJump)
    syncBottomState(
      geometry.atBottom,
      geometry.atBottom ? 'restore' : modeWhenAway === 'confirm-away' ? 'disable-debounced' : modeWhenAway,
    )
    return geometry
  }, [syncBottomState])

  // Animated scroll-to-bottom driven by a requestAnimationFrame easing loop.
  //
  // Why not native `behavior: 'smooth'`? `el.scrollTo({ top: scrollHeight,
  // smooth })` captures `scrollHeight` ONCE at call time and animates toward
  // that stale pixel over ~300ms. While the animation runs, any content
  // growth (streaming text mirroring into the spacer Footer, Virtuoso
  // row-height measurement settling, lazy images/code blocks) moves the real
  // bottom past the captured target, so the animation lands short — and with
  // atBottomRef momentarily false, the streaming ResizeObserver re-pin guard
  // skips, so nothing corrects it. That was the intermittent "sometimes
  // doesn't scroll to bottom" bug.
  //
  // Fix: re-read `el.scrollHeight` on EVERY frame and ease scrollTop toward
  // the fresh target. The target can never go stale because it is refreshed
  // each frame, so the animation always terminates exactly at the real
  // bottom no matter how content grows mid-flight. The `scrollAnimatingRef`
  // duration guard keeps the follow-disable machinery from misreading the
  // mid-animation gap (see that ref's comment). The loop also cancels itself
  // if it detects the user scrolled up mid-animation (scrollTop dropped below
  // the last value we set), so we never fight a legitimate user scroll.
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
      // Ease toward the target: cover ~25% of the remaining distance per
      // frame → ~250-350ms for typical chat heights, matching the feel of
      // native smooth scroll.
      const next = current + remaining * 0.25
      el.scrollTo({ top: next, behavior: 'auto' })
      lastSetTop = next
      scrollAnimRafRef.current = requestAnimationFrame(step)
    }
    scrollAnimRafRef.current = requestAnimationFrame(step)
  }, [syncBottomGeometry])

  // An empty string is the turn's pre-text phase: a `liveTurn` already
  // exists (created on the turn's first stream event) but no text delta
  // has flushed yet — the "thinking" phase, or a tool-use turn that never
  // produces assistant prose. Rendering the streaming bubble then yields
  // an empty placeholder that reserves layout space but shows nothing
  // (the gradient mask on .streaming-plain fades out the lone cursor),
  // and WorkingBubble already signals the active phase. Treat "" as null
  // so the footer doesn't mount until real text arrives. The exit-fade
  // logic below still works: at turn end `liveTurn` is cleared to null
  // (reducer sets `liveTurn: null`), which triggers the exit branch and
  // keeps the last non-empty content visible during the fade-out.
  const liveStreamingContent = streamingContent && streamingContent.length > 0 ? streamingContent : null
  const [streamingPresence, setStreamingPresence] = useState(() => ({
    source: liveStreamingContent,
    content: liveStreamingContent,
    exiting: false,
  }))
  const streamingExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const nextStreamingPresence = liveStreamingContent !== streamingPresence.source
    ? liveStreamingContent != null
      ? { source: liveStreamingContent, content: liveStreamingContent, exiting: false }
      : { source: null, content: streamingPresence.content, exiting: streamingPresence.content != null }
    : streamingPresence
  const hasVisibleStreamingContent = nextStreamingPresence.content != null

  if (nextStreamingPresence !== streamingPresence) {
    setStreamingPresence(nextStreamingPresence)
  }

  useEffect(() => {
    if (streamingExitTimerRef.current) {
      clearTimeout(streamingExitTimerRef.current)
      streamingExitTimerRef.current = null
    }
    if (!streamingPresence.exiting) return
    streamingExitTimerRef.current = setTimeout(() => {
      streamingExitTimerRef.current = null
      setStreamingPresence({ source: null, content: null, exiting: false })
    }, STREAMING_EXIT_MS)
    return () => {
      if (streamingExitTimerRef.current) {
        clearTimeout(streamingExitTimerRef.current)
        streamingExitTimerRef.current = null
      }
    }
  }, [streamingPresence.exiting])

  // EnterPlanMode has no lifecycle map (it renders as a stateless marker and
  // nothing consumes its result), so its result ids aren't in any of the maps
  // above. Scan items for them directly and fold them into the predicate so
  // their stray tool_result doesn't fall through to an orphan bubble.
  const enterPlanIds = useStableSet(useMemo(() => {
    const set = new Set<string>()
    for (const it of items) {
      for (const id of getEnterPlanToolUseIds(it.msg)) set.add(id)
    }
    return set
  }, [items]))

  // Subagent (Agent/Task/Explore) results are merged inline into SubagentCard
  // once captured (record.result set). Fold those ids into the predicate so
  // their standalone orphan bubble is suppressed — same merge treatment as a
  // generic tool card. Only ids whose result has actually landed count; a
  // still-running subagent has no result bubble to suppress yet.
  const subagentCtx = useSubagentContext()
  const subagentResultIds = useStableSet(useMemo(() => {
    const set = new Set<string>()
    if (subagentCtx) {
      for (const [id, record] of subagentCtx.index) {
        // A record with a captured result is merged into SubagentCard →
        // suppress its standalone orphan. A 'background' record has had its
        // launch-ack tool_result land (the ack IS the tool_result for this
        // id), so the ack orphan must also be suppressed even though the ack
        // text is deliberately NOT stored as `result` — the SubagentCard
        // represents the subagent, and the ack is internal launch metadata.
        // 'pending' (the post-turn-end form of 'background') and 'dismissed'
        // (user stopped tracking a pending chip) suppress the ack orphan for
        // the same reason — the card is still the subagent's surfacing.
        if (record.result || record.status === 'background' || record.status === 'pending' || record.status === 'dismissed') set.add(id)
      }
    }
    return set
  }, [subagentCtx]))

  // Workflow results are merged inline into WorkflowCard once captured
  // (record.result set), exactly like subagent results into SubagentCard.
  // Fold those ids into the predicate so the Workflow's synthesized tool_result
  // doesn't also render a standalone orphan bubble. Also fold in every child
  // agent's result id: a child's tool_result would otherwise surface as an
  // orphan on the Workflow's sidechain view, but it's already represented by
  // the child row's status + (in the drill-in) the child's own merged card.
  const workflowCtx = useWorkflowContext()
  const workflowResultIds = useStableSet(useMemo(() => {
    const set = new Set<string>()
    if (workflowCtx) {
      for (const [, record] of workflowCtx.index) {
        if (record.result) set.add(record.toolUseId)
        for (const child of record.childAgents) {
          if (child.result) set.add(child.toolUseId)
        }
      }
    }
    return set
  }, [workflowCtx]))

  const isResultConsumed = useMemo(
    () => makeResultConsumed(toolResults, planStatus, questionAnswers, enterPlanIds, subagentResultIds, workflowResultIds),
    [toolResults, planStatus, questionAnswers, enterPlanIds, subagentResultIds, workflowResultIds],
  )

  const { renderableItems, firstItemId, lastItemId, nextItemTypeMap } = useMemo(() => {
    const out: RenderableItem[] = []
    // leadingItems bypass the parent_tool_use_id filter — they're prepended
    // as-is (e.g. the subagent's input prompt, which has no parent frame).
    // See the prop comment for why this exists.
    if (leadingItems) {
      for (let li = 0; li < leadingItems.length; li++) {
        const item = leadingItems[li]
        if (item.hiddenByDefault) continue
        if (willRenderEmpty(item.msg, item.isCompactSummary, isResultConsumed)) continue
        out.push({
          id: item.id,
          msg: item.msg,
          isCompactSummary: item.isCompactSummary,
          renderableIndex: out.length,
          itemIndex: -1 - li,
          sending: item.sending,
          deliveryStatus: item.deliveryStatus,
          receivedAt: item.receivedAt,
        })
      }
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const parent = item.msg.parent_tool_use_id
      // Filter by parent_tool_use_id:
      //  - main transcript (filter == null): show only root messages
      //    —subagent children are surfaced via SubagentCard placeholders
      //    in their parent's tool_use slot, and the full inner stream
      //    lives in SubagentOverlay.
      //  - overlay (filter == "<id>"): show only direct children of that
      //    subagent. Nested subagents inside it surface as SubagentCards
      //    again, allowing drill-down.
      if (parentToolUseIdFilter == null) {
        if (parent != null) continue
      } else {
        if (parent !== parentToolUseIdFilter) continue
      }
      // Drop messages MessageView would render as null (merged tool_result
      // frames, subagent heartbeats, empty assistant shells). Otherwise each
      // leaves an empty `.virtuoso-item-wrapper` whose padding doubles the
      // gap after every tool call. Kept in lockstep with MessageView via the
      // shared willRenderEmpty.
      if (
        !item.hiddenByDefault &&
        !willRenderEmpty(item.msg, item.isCompactSummary, isResultConsumed)
      ) {
        out.push({
          id: item.id,
          msg: item.msg,
          isCompactSummary: item.isCompactSummary,
          renderableIndex: out.length,
          itemIndex: i,
          sending: item.sending,
          deliveryStatus: item.deliveryStatus,
          receivedAt: item.receivedAt,
        })
      }
    }
    // trailingItems bypass the parent_tool_use_id filter — appended after
    // the filtered children (e.g. a sync subagent's result, which lands on
    // the main thread with parent = null). Mirrors the leadingItems prepend.
    if (trailingItems) {
      for (let ti = 0; ti < trailingItems.length; ti++) {
        const item = trailingItems[ti]
        if (item.hiddenByDefault) continue
        if (willRenderEmpty(item.msg, item.isCompactSummary, isResultConsumed)) continue
        out.push({
          id: item.id,
          msg: item.msg,
          isCompactSummary: item.isCompactSummary,
          renderableIndex: out.length,
          itemIndex: -1000 - ti,
          sending: item.sending,
          deliveryStatus: item.deliveryStatus,
          receivedAt: item.receivedAt,
        })
      }
    }
    // Append the transient `api_retry` divider as a synthetic tail item
    // (render-only — it lives in the `apiRetry` slot, not items/messages/IDB).
    // Stable id + no receivedAt so the entrance-animation gate skips it and
    // Virtuoso reuses the row across consecutive retry frames (the slot is
    // overwritten in place, so ApiRetryView gets fresh delayMs props without a
    // remount — same UX as the old in-place replace, minus the append-only
    // violation).
    if (apiRetry) {
      out.push({
        id: '__api_retry__',
        msg: apiRetry,
        isCompactSummary: false,
        renderableIndex: out.length,
        itemIndex: -2,
      })
    }
    // Pre-compute stable lookups so itemContent doesn't depend on the
    // renderableItems array reference (which changes on every message append
    // and would defeat Virtuoso's row-level memo).
    const nextMap = new Map<string, string>()
    for (let i = 0; i < out.length - 1; i++) {
      nextMap.set(out[i].id, out[i + 1].msg.type)
    }
    return {
      renderableItems: out,
      firstItemId: out[0]?.id,
      lastItemId: out[out.length - 1]?.id,
      nextItemTypeMap: nextMap,
    }
  }, [items, parentToolUseIdFilter, isResultConsumed, leadingItems, trailingItems, apiRetry])

  // --- Reverse infinite scroll: keep the viewport anchored on prepend ----
  // Virtuoso requires `firstItemIndex` to decrease by exactly the number of
  // items prepended, in the SAME render that grows `data` at the front —  // otherwise the viewport jumps. We detect a front-prepend by checking
  // whether the previous first renderable message moved to a later index.
  //
  // Computed during render (refs, not state) so `firstItemIndex` and `data`
  // commit together. The `msg === prev` short-circuit makes this a no-op on
  // ordinary appends/streaming; the findIndex only runs on the rare prepend
  // or full-rebuild render. If a discarded concurrent render mutates the
  // ref, the next real render self-corrects (prev still matches) —worst
  // case a single missed adjustment, never compounding drift.
  const INITIAL_FIRST_ITEM_INDEX = 1_000_000
  const firstItemIndexRef = useRef(INITIAL_FIRST_ITEM_INDEX)
  const prevFirstMsgRef = useRef<SdkMessage | null>(null)
  const first = renderableItems.length > 0 ? renderableItems[0].msg : null
  // The easter-egg game is a fresh-invocation easter egg: once real messages
  // arrive, close it so it doesn't reappear when the conversation is later
  // cleared back to empty. Render-time adjustment (prev-value ref) is the
  // React-recommended pattern for "reset state when a value changes" — it
  // avoids the set-state-in-effect cascade. The ref access here trips the
  // `react-hooks/refs` rule, but the read+mutation is idempotent w.r.t. the
  // current render and mirrors the established disable pattern used for the
  // Virtuoso first-item anchor block immediately below.
  /* eslint-disable react-hooks/refs */
  const prevItemsLenRef = useRef(renderableItems.length)
  if (prevItemsLenRef.current !== renderableItems.length) {
    prevItemsLenRef.current = renderableItems.length
    if (renderableItems.length > 0 && gameOpen) setGameOpen(false)
  }
  /* eslint-enable react-hooks/refs */
  // Reading and mutating these refs DURING render is deliberate and required:
  // Virtuoso needs `firstItemIndex` to commit in the SAME render that grows
  // `data` at the front, which a post-render effect can't guarantee (the
  // viewport would jump for one frame). The mutation is idempotent w.r.t. the
  // current render and self-corrects on the next one (see the block comment
  // above), so it's safe despite the rule. Disabled narrowly for this block.
  /* eslint-disable react-hooks/refs */
  if (first == null) {
    // Empty list (session switch / cleared) —reset the anchor.
    firstItemIndexRef.current = INITIAL_FIRST_ITEM_INDEX
    prevFirstMsgRef.current = null
  } else if (prevFirstMsgRef.current == null) {
    prevFirstMsgRef.current = first
  } else if (first !== prevFirstMsgRef.current) {
    const movedTo = renderableItems.findIndex((r) => r.msg === prevFirstMsgRef.current)
    if (movedTo > 0) {
      // `movedTo` items were inserted ahead of the previous first item.
      firstItemIndexRef.current -= movedTo
    } else if (movedTo < 0) {
      // Previous first item is gone (replay rebuild / reset) —re-anchor.
      firstItemIndexRef.current = INITIAL_FIRST_ITEM_INDEX
    }
    prevFirstMsgRef.current = first
  }
  const firstItemIndex = firstItemIndexRef.current
  /* eslint-enable react-hooks/refs */

  // --- New-message entrance animation gate -------------------------------
  // Goal: play a one-shot "rise + blur-in" on messages that genuinely just
  // ARRIVED live —never on the initial replay, session switches, loadOlder
  // history prepends, the optimistic echo user-message swap, or Virtuoso
  // re-mounting an off-screen row as the user scrolls.
  //
  // The discriminator is "a small batch of previously-unseen ids appended at
  // the TAIL of a non-empty list, each stamped with a recent wall-clock
  // receivedAt". That single rule excludes every non-arrival case:
  //   - initial replay / session switch —grows from empty (prevLen 0) or
  //     adds many ids at once —skipped by the prevLen>0 + batch-size guards.
  //   - loadOlder prepend —ids appear at the FRONT, not at indices >=
  //     prevLen —not tail-appends —skipped.
  //   - optimistic echo swap — in-place replace at an existing index, list
  //     length unchanged —no index >= prevLen —skipped (the optimistic
  //     insert already animated the pop).
  //   - scroll re-mount —id already in knownIdsRef and already consumed from
  //     enterIdsRef —skipped.
  // receivedAt recency disambiguates a freshly-type first message (animate)
  // from a replayed single-message session (history timestamp is stale).
  const knownIdsRef = useRef<Set<string>>(new Set())
  const enterIdsRef = useRef<Set<string>>(new Set())
  // ids for which the post-animation cleanup timeout has already been
  // scheduled, so we schedule exactly one per armed row (see enterNodeRef).
  const enterCleanupScheduledRef = useRef<Set<string>>(new Set())
  const prevLenRef = useRef(0)
  // Tracks the id of the last renderable item so the gate can detect an
  // in-place echo replacement (optimistic id → server uuid at the same
  // tail position) and transfer the entering flag for a seamless animation.
  const prevLastIdRef = useRef<string | null>(null)
  // Whole-transcript reveal gate. It arms only for the first ready transcript
  // for a key, so an empty session's first live message keeps using the row-
  // level msg-enter animation instead of also fading the whole scroller.
  const consumedTranscriptKeyRef = useRef<string | undefined>(undefined)
  const pendingTranscriptRevealKeyRef = useRef<string | undefined>(undefined)
  const messagesElRef = useRef<HTMLDivElement | null>(null)
  /* eslint-disable react-hooks/refs -- ref reads/writes during render commit
     the enter-set together with `data`, mirroring the firstItemIndex block. */
  {
    const prevLen = prevLenRef.current
    const curLen = renderableItems.length
    // Tail-append candidates: ids at index >= prevLen that we've never seen.
    // Only consider when growing the list by a small delta (live arrivals
    // trickle in 1— at a time; bulk loads add many at once).
    //
    // prevLen may be 0 for the very first message in a session —that case
    // is fine because receivedAt recency (ENTER_MAX_AGE_MS) and batch-size
    // guards (MAX_ENTER_BATCH) together prevent initial replay / session-
    // switch bulk loads from animating. A disk-restored single-message
    // session also won't animate (receivedAt is undefined).
    const delta = curLen - prevLen
    const armed = shouldArmEnterAnimation(replayReady, delta, prevLen, MAX_ENTER_BATCH)
    if (armed) {
      // eslint-disable-next-line react-hooks/purity -- Date.now() gates animation recency; a stale value at worst skips one animation, never corrupts state.
      const now = Date.now()
      for (let i = prevLen; i < curLen; i++) {
        const it = renderableItems[i]
        if (knownIdsRef.current.has(it.id)) continue
        if (typeof it.receivedAt === 'number' && now - it.receivedAt < ENTER_MAX_AGE_MS) {
          enterIdsRef.current.add(it.id)
        }
      }
    }
    // Echo-replacement transfer: when the server echo replaces the optimistic
    // placeholder in-place (same index, same list length, different id), the
    // new id should inherit the entering flag so the animation continues
    // seamlessly rather than snapping to a static bubble mid-transition.
    // We only check the last few items (the tail window where replacements
    // actually happen) to keep this O(1) instead of scanning the whole list.
    {
      const prevLastId = prevLastIdRef.current
      const curLastId = curLen > 0 ? renderableItems[curLen - 1].id : null
      if (
        prevLastId != null &&
        curLastId != null &&
        curLastId !== prevLastId &&
        enterIdsRef.current.has(prevLastId)
      ) {
        enterIdsRef.current.delete(prevLastId)
        enterIdsRef.current.add(curLastId)
      }
      prevLastIdRef.current = curLastId
    }
    // Record every current id so a later in-place swap / re-mount of the
    // same message is recognised as already-seen and never re-animates.
    //
    // Gated on `delta !== 0` (the list actually grew or shrank) so the O(n)
    // loop doesn't run on every streaming-token render — during streaming
    // `renderableItems` keeps the same length (LIVE_TURN_FLUSH only mutates
    // liveTurn, not items), so the set is already fully populated and every
    // add here would be a no-op. For a 1000-message transcript at ~12fps
    // streaming that's ~12k wasted Set.add calls/sec otherwise.
    //
    // A length-preserving in-place swap (optimistic echo → server uuid at the
    // same index, delta === 0) skips this — the swapped-in id is recorded on
    // the next genuine append. That's safe: re-mounts never re-animate anyway
    // (the `armed` gate above requires delta > 0), and the echo-replacement
    // transfer block above already moves the entering flag to the new id.
    if (delta !== 0) {
      for (const it of renderableItems) knownIdsRef.current.add(it.id)
      // Bound the set so a multi-thousand-message session doesn't leak ids.
      if (knownIdsRef.current.size > KNOWN_IDS_CAP) {
        const live = new Set(renderableItems.map((it) => it.id))
        for (const id of enterIdsRef.current) live.add(id)
        knownIdsRef.current = live
      }
    }
    prevLenRef.current = curLen
  }
  /* eslint-enable react-hooks/refs */

  // Consume an entrance flag when the animation ends and strip the class off
  // the DOM node directly, so the next render and any later scroll-driven
  // re-mount of the same row can't replay it.
  const handleEnterAnimationEnd = useCallback((e: React.AnimationEvent<HTMLDivElement>) => {
    const id = e.currentTarget.dataset.enterId
    if (id) {
      enterIdsRef.current.delete(id)
      enterCleanupScheduledRef.current.delete(id)
    }
    e.currentTarget.classList.remove('msg-enter')
  }, [])

  // Ref callback attached to the entering row's wrapper on mount. Schedules a
  // single fallback timeout that clears the armed flag after the animation
  // duration (+ buffer). This is the safety net for the case the original
  // "delete on first render" logic was trying to plug: if Virtuoso unmounts
  // the row before `animationend` fires (the user scrolled it out of the
  // viewport mid-animation), the event never fires and the flag would linger
  // in `enterIdsRef` — so a later scroll-back remount would replay the
  // entrance. The timeout clears the flag so that remount renders without the
  // class. (The common path — row stays mounted — clears via animationend,
  // which fires within ~240ms, well under the timeout.)
  const ENTER_CLEANUP_MS = 400
  const enterNodeRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const id = node.dataset.enterId
    if (!id) return
    if (enterCleanupScheduledRef.current.has(id)) return
    enterCleanupScheduledRef.current.add(id)
    setTimeout(() => {
      enterIdsRef.current.delete(id)
      enterCleanupScheduledRef.current.delete(id)
    }, ENTER_CLEANUP_MS)
  }, [])

  const handleTranscriptRevealEnd = useCallback((e: React.AnimationEvent<HTMLDivElement>) => {
    if (e.animationName === 'transcript-item-reveal' && e.target instanceof HTMLElement) {
      e.target.classList.remove('transcript-item-reveal')
      e.target.style.animationDelay = ''
      return
    }
    if (e.target === e.currentTarget && e.animationName === 'transcript-reveal') {
      e.currentTarget.classList.remove('chat-messages-reveal')
    }
  }, [])

  useLayoutEffect(() => {
    if (transcriptRevealKey == null || pendingTranscriptRevealKeyRef.current !== transcriptRevealKey) return

    let cancelled = false
    let raf1 = 0
    let raf2 = 0
    const waitForVisibleList = () => {
      if (cancelled) return
      const el = messagesElRef.current
      const list = el?.querySelector('[data-testid="virtuoso-item-list"]')
      const visible = list != null && getComputedStyle(list).visibility !== 'hidden'
      if (!visible) {
        raf2 = requestAnimationFrame(waitForVisibleList)
        return
      }
      if (!el || pendingTranscriptRevealKeyRef.current !== transcriptRevealKey) return
      pendingTranscriptRevealKeyRef.current = undefined
      el.classList.remove('chat-messages-reveal-pending')
      el.classList.add('chat-messages-reveal')
      const rows = Array.from(el.querySelectorAll<HTMLElement>('.virtuoso-item-wrapper'))
      const revealTailStart = Math.max(0, rows.length - 8)
      rows.forEach((row, index) => {
        row.classList.add('transcript-item-reveal')
        row.style.animationDelay = `${Math.max(0, index - revealTailStart) * 24}ms`
      })
    }
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(waitForVisibleList)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [transcriptRevealKey, replayReady, renderableItems.length])

  // Fires when the user scrolls to the top. Pull the previous page of
  // history from disk if there's more and we're not already loading.
  const startReached = useCallback(() => {
    // With Virtuoso always mounted, startReached can fire on the empty-list
    // mount (scroller at top, no items). Skip the network page in that case —
    // there is nothing older to load until at least one message is present.
    if (!loadOlder || !hasOlder || loadingOlder || renderableItems.length === 0) return
    void loadOlder()
  }, [loadOlder, hasOlder, loadingOlder, renderableItems.length])

  // Reverse map: full items[] index —Virtuoso (renderableItems) index.
  // Needed because search indices reference the full, unfiltered list.
  const itemToVirtIdx = useMemo(() => {
    const map = new Map<number, number>()
    for (let vi = 0; vi < renderableItems.length; vi++) {
      map.set(renderableItems[vi].itemIndex, vi)
    }
    return map
  }, [renderableItems])

  // Scroll to the active search result when it changes.
  const prevSearchActiveRef = useRef<number>(-1)
  useEffect(() => {
    if (searchActiveMsgIdx == null || searchActiveMsgIdx < 0) return
    if (searchActiveMsgIdx === prevSearchActiveRef.current) return
    prevSearchActiveRef.current = searchActiveMsgIdx
    const virtIdx = itemToVirtIdx.get(searchActiveMsgIdx)
    if (virtIdx != null) {
      // Temporarily disable follow so the scroll doesn't fight the
      // auto-follow-to-bottom logic.
      shouldFollowRef.current = false
      virtuosoRef.current?.scrollToIndex({ index: virtIdx, behavior: 'smooth', align: 'center' })
    }
  }, [searchActiveMsgIdx, itemToVirtIdx])

  // Track how many new messages arrived so the unseen badge stays accurate.
  // Virtuoso's followOutput handles the actual scrolling.
  //
  // We count items that match the current `parentToolUseIdFilter` but
  // *not* `hiddenByDefault` —system messages are filtered by default,
  // and only non-hidden items should trigger badge increments.
  // Counting by parent dodges the same trap for the main transcript:
  // subagent-internal frames stream in continuously while an Agent runs,
  // but they're hidden in the main list, so they shouldn't tick the
  // badge there. (The overlay has its own MessageList instance with the
  // matching filter, so its badge counts correctly too.)
  const trackedCount = useMemo(() => {
    let count = 0
    for (const item of items) {
      // Exclude hiddenByDefault (system frames, etc.) — they don't render in
      // the transcript so they can't be "unseen." Matches the renderableItems
      // filter and the comment's original intent.
      if (item.hiddenByDefault) continue
      const parent = item.msg.parent_tool_use_id
      if (parentToolUseIdFilter == null) {
        if (parent != null) continue
      } else {
        if (parent !== parentToolUseIdFilter) continue
      }
      count++
    }
    return count
  }, [items, parentToolUseIdFilter])
  const lastCountRef = useRef(0)
  // Session switch: the inner scroller remounts (key={transcriptRevealKey}),
  // but this component instance persists (no key on <MessageList> in
  // Chat.tsx). Reset all bottom/scroll/unseen REFS so stale values from the
  // old session don't leak into the new one — a phantom badge, or a stale
  // atBottomRef=false that makes the new session's first message increment
  // unseenCount instead of clearing it. MUST run before the tracked-count
  // effect below so lastCountRef is 0 when that effect computes its delta
  // (otherwise the delta is the full new-session count, not 0, and the
  // badge miscounts).
  //
  // Both `atBottom` and `canJumpToBottom` STATE are also reset here (not just
  // the refs). <MessageList> is not keyed on session — the component instance
  // persists across a switch while only the inner scroller remounts — so a
  // stale `canJumpToBottom=true / atBottom=false` from the previous session
  // would otherwise render the jump button on the new session's very first
  // frame (the button is a SIBLING of the reveal-hidden list and stays
  // visible), a one-frame stale flash. reduced-motion users can't rely on the
  // `.chat-messages-reveal-pending { opacity: 0 }` CSS hiding it either, so
  // the state reset is the only reliable reset. This effect already sets
  // state via clearUnseen() → setUnseenCount(0), so set-state-in-effect is
  // already on the table here; resetting the button state is consistent with
  // it. Geometry re-syncs on the new scroller after Virtuoso remounts.
  useEffect(() => {
    clearUnseen()
    clearFollowTimer()
    atBottomRef.current = true
    shouldFollowRef.current = true
    lastCountRef.current = 0
    // Intentional one-shot reset on a rare event (session switch): clear the
    // previous session's jump-button state unconditionally so the button can't
    // flash with stale `canJumpToBottom`/`atBottom`. A guarded ref-only reset
    // (the old approach) would leave the stale STATE in place. The cascading-
    // render cost the rule guards against is irrelevant here — it's a single
    // commit after a persisted-component remount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAtBottom(true)
    setCanJumpToBottom(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptRevealKey])
  useEffect(() => {
    const delta = trackedCount - lastCountRef.current
    lastCountRef.current = trackedCount
    if (delta <= 0) {
      // Items shrank (compact_boundary, /clear, upstream trimming) — a
      // structural reduction isn't "new messages the user missed," so reset
      // the badge rather than leaving a stale count that overstates how many
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
  }, [renderableItems.length, scrollScrollerToBottom, syncBottomGeometry])

  useEffect(() => {
    const el = streamingRegionRef.current
    if (!el) {
      setStreamingOverlayHeight(0)
      return
    }

    const updateHeight = () => {
      const height = Math.ceil(el.getBoundingClientRect().height)
      setStreamingOverlayHeight((prev) => (prev === height ? prev : height))
    }

    updateHeight()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(updateHeight)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasVisibleStreamingContent])

  // Re-pin to the bottom AFTER the streaming spacer commits its new height.
  //
  // Root cause of "the scrollbar sits one line short of the bottom while the
  // streaming bubble's height is changing": the ResizeObserver above measures
  // the live overlay and calls setStreamingOverlayHeight, which resizes the
  // Virtuoso Footer spacer that reserves room for the overlay. That state
  // update is asynchronous — the spacer's new height only lands once React
  // commits the re-render, which is AFTER the ResizeObserver callback returns.
  // Reading scrollHeight inside that callback (as a synchronous
  // scrollScrollerToBottom previously did) therefore read the STALE bottom and
  // pinned there; once the spacer then grew, the viewport was left one line
  // short every time the streaming bubble grew.
  //
  // The content-growth backstop further down does not catch this case: it
  // observes Virtuoso's item-list, which grows on settled-content growth but
  // NOT on spacer growth — the streaming spacer lives in the Footer slot, a
  // SIBLING of the item-list, so an item-list ResizeObserver never fires when
  // the spacer resizes. (It previously observed the fixed-height viewport and
  // so never re-pinned on content growth — its callback's `sh <=
  // lastScrollHeight` guard skipped the viewport-resize events that did fire,
  // since scrollHeight was unchanged; that is fixed now, but it still cannot
  // cover the spacer for this structural reason, which is why this layout
  // effect exists.)
  //
  // Pinning here — a layout effect keyed on the spacer height — runs AFTER
  // React has committed the new spacer (so scrollHeight is fresh) but BEFORE
  // paint, so the viewport is at the real bottom in the very frame the spacer
  // grows. Gated like the other re-pins so a user who scrolled up
  // (shouldFollowRef false) or an in-flight follow animation
  // (scrollAnimatingRef true, whose rAF loop already re-targets each frame)
  // isn't yanked.
  useLayoutEffect(() => {
    // streamingOverlayHeight <= 0 means no spacer is rendered (Footer is
    // gated on `streamingOverlayHeight > 0`), so there is nothing to re-pin
    // for — skip to avoid yanking the viewport on mount / after streaming
    // ends, when a non-bottom position may be intentional (e.g. the user
    // scrolled up to read history).
    if (streamingOverlayHeight <= 0) return
    if (!shouldFollowRef.current || scrollAnimatingRef.current) return
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [streamingOverlayHeight])

  // Re-pin to the bottom when SETTLED content grows AFTER the follow animation
  // has already finalized. Root cause of the "a tall message (or a rapid burst
  // of messages) lands partway down instead of at the bottom" bug:
  //
  // When `items` grows, the useLayoutEffect pin and the rAF follow animation
  // both read `scrollHeight` at a moment when Virtuoso is still counting the
  // freshly-mounted tail row at its ESTIMATED height (Virtuoso measures real
  // heights asynchronously via its own ResizeObserver, after paint). The rAF
  // loop sees `remaining ≈ 0` at that estimated bottom and finalizes — clearing
  // `scrollAnimatingRef`. A frame later Virtuoso measures the row's real (much
  // larger) height, `scrollHeight` grows downward, but `scrollTop` stays at the
  // stale estimated bottom — so the viewport sits mid-way through the new
  // content. No `scroll` event fires (scrollTop didn't move) so the scroll
  // handler can't correct it, and `atBottomStateChange(false)`'s 150ms debounce
  // disarms follow before anything re-pins. A burst of messages stacks the same
  // race: each append's animation finalizes at a stale height and the next
  // measurement lands after the loop exits.
  //
  // The scroller's own ResizeObserver (above) watches the VIEWPORT
  // (clientHeight) for shrink; the streamingOverlayHeight layout effect
  // watches the live typing bubble's spacer. Neither catches settled-content
  // growth. This observer fills that gap: it watches Virtuoso's ITEM-LIST
  // ([data-testid="virtuoso-item-list"], whose border-box height tracks the
  // rendered items) and, while we're still following and no animation is in
  // flight, snaps scrollTop to the fresh scrollHeight. Gated on
  // `shouldFollowRef` so a user who has scrolled up is never yanked back
  // (it's false the instant an upward scroll is detected); `scrollAnimatingRef`
  // is skipped because the rAF loop already re-targets each frame. Mirrors the
  // streaming re-pin's instant snap — a measurement correction reads as
  // "settle to bottom", not a jump.
  //
  // Why the item-list and NOT scroller.firstElementChild: that first child is
  // Virtuoso's viewport, which is height:100% / position:absolute — fixed to
  // the scroller, so it never resizes on content growth. Observing it (the
  // previous implementation, whose comment claimed it "tracks total scrollable
  // content") meant this backstop never fired for its intended purpose, so the
  // "tall message lands partway" bug stayed latent. The item-list grows when a
  // freshly-appended tail row is re-measured at its real (larger) height after
  // the rAF follow animation finalized at Virtuoso's estimate — exactly the
  // case to re-pin. (The streaming spacer lives in the Footer slot, a SIBLING
  // of the item-list, so observing the item-list does NOT cover spacer growth;
  // that is the streamingOverlayHeight layout effect's job. The Header/Footer
  // slots are irrelevant to settled-content growth.)
  //
  // Re-attached on `transcriptRevealKey` because Virtuoso remounts (new
  // scroller + item-list) on session switch — the long-lived `[]`-deps form
  // held a stale reference to the previous session's item-list and went dead
  // after the first switch.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    let cancelled = false
    let raf = 0
    // Content-only baseline (scrollHeight MINUS the live streaming spacer),
    // tracked monotonically. We must exclude the spacer here, not track raw
    // scrollHeight: the streaming footer's spacer reserves ~the capped
    // overlay height while a turn is active, inflating scrollHeight. When the
    // turn ends the footer exits and the spacer shrinks to 0 — a SHRINK this
    // observer's "only fire on growth" guard would skip without decrementing
    // the baseline, leaving it inflated by ~110px. Any post-exit content
    // growth smaller than that inflation (notably Virtuoso's async re-
    // measurement of the just-landed final assistant message at its real
    // Markdown height, which routinely lands after the spacer is gone because
    // the SDK emits `result` only ~15ms after the `assistant` frame) would
    // then read as `<= lastContentHeight` and be skipped — so the viewport
    // never re-pinned and landed short of the bottom (the "bounces up a bit
    // when the streaming footer disappears" jolt). Comparing content-only
    // height makes the baseline immune to the spacer's lifecycle.
    let lastContentHeight = 0
    const contentHeightOf = (scroller: HTMLElement) =>
      scroller.scrollHeight - getStreamingSpacerHeight(scroller)
    const ro = new ResizeObserver(() => {
      if (cancelled) return
      const scroller = scrollerRef.current
      if (!scroller) return
      if (!shouldFollowRef.current || scrollAnimatingRef.current) return
      const contentH = contentHeightOf(scroller)
      if (contentH <= lastContentHeight) return
      lastContentHeight = contentH
      scroller.scrollTop = scroller.scrollHeight
    })
    const attach = () => {
      if (cancelled) return
      const scroller = scrollerRef.current
      if (!scroller) { raf = requestAnimationFrame(attach); return }
      // Observe the item-list (rendered items' border-box), NOT the viewport
      // (scroller.firstElementChild, height:100% — never resizes on content
      // growth). See the block comment above for why.
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
  }, [transcriptRevealKey])

  // Authoritative scroll-state listener. Virtuoso's callback can miss
  // native scroll intent, so direct DOM geometry decides whether the
  // viewport is actually at the bottom. Any upward scroll away from that
  // direct bottom state disables follow immediately, while scrolling back
  // to the real bottom restores follow and clears the unseen badge.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop
    const handler = () => {
      const prevScrollTop = lastScrollTopRef.current
      lastScrollTopRef.current = el.scrollTop
      // While a programmatic smooth-scroll animation (jump-to-bottom or a
      // new-message follow) is in flight, skip the geometry sync entirely.
      // Mid-animation the viewport is intentionally not yet at the bottom;
      // running the sync would see dist>0, arm the 150ms follow-disable
      // debounce, and fire it mid-animation — flipping shouldFollow/atBottom
      // false and re-showing the jump button, exactly the race the animation
      // guard exists to prevent. The rAF loop clears the guard when it lands
      // (or aborts on user scroll-up), after which normal sync resumes.
      if (scrollAnimatingRef.current) {
        return
      }
      const isScrollingUp = el.scrollTop < prevScrollTop
      syncBottomGeometry(el, isScrollingUp ? 'disable-now' : 'preserve')
    }
    syncBottomGeometry(el, 'confirm-away')
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [renderableItems.length, syncBottomGeometry, streamingOverlayHeight])

  // Clean up the follow debounce timer on unmount.
  useEffect(() => () => {
    clearFollowTimer()
  }, [clearFollowTimer])

  // Cancel any in-flight animated scroll on unmount so a pending rAF
  // callback can't fire after the scroller is gone.
  useEffect(() => () => {
    if (scrollAnimRafRef.current != null) {
      cancelAnimationFrame(scrollAnimRafRef.current)
      scrollAnimRafRef.current = null
    }
    scrollAnimatingRef.current = false
  }, [])

  const jumpToBottom = useCallback(() => {
    // Jump-to-bottom animates smoothly to the real bottom. The animation is
    // driven by `animateScrollToBottom` — a rAF easing loop that re-reads
    // `scrollHeight` every frame, so unlike native `behavior: 'smooth'` it
    // can never land short when content grows mid-animation (no stale
    // captured target). See that helper for the full rationale.
    //
    // Optimistically re-enable follow BEFORE the animation lands, so the
    // existing backstops stay armed for the duration of the animation and
    // beyond:
    //   - shouldFollowRef = true    -> followOutput tracks new appends
    //   - setBottomState(true)      -> atBottomRef=true arms the streaming
    //                                  ResizeObserver re-pin path; also kept
    //                                  true by scrollAnimatingRef for the
    //                                  animation's duration
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

  // --- Scroll to previous / next user message ----------------------------
  // Data-array (0-based, Virtuoso `scrollToIndex` space) indices of every
  // *real* user message — the same discriminator MessageView uses to pick
  // the "msg user" bubble branch: a genuine human-typed top-level turn
  // (no parent_tool_use_id, no tool_result, not synthetic). Recomputed only
  // when the rendered list changes. Synthetic user-role frames (task
  // notifications, peer messages, …) are excluded so the pin header and
  // navigate-to-user-message never target an injection.
  const userMsgIndices = useMemo(() => {
    const out: number[] = []
    for (let i = 0; i < renderableItems.length; i++) {
      const it = renderableItems[i]
      const msg = it.msg
      if (msg.type !== 'user') continue
      if (it.isCompactSummary) continue
      if (!isHumanUserMessage(msg)) continue
      out.push(i)
    }
    return out
  }, [renderableItems])
  // Mirror in a ref so the (stable) navigate callback reads the latest list
  // without being re-created — keeps its registered identity constant. Synced
  // in an effect (not during render) to respect the refs-in-render rule.
  const userMsgIndicesRef = useRef<number[]>(userMsgIndices)
  useEffect(() => {
    userMsgIndicesRef.current = userMsgIndices
  }, [userMsgIndices])
  // Cache of the last lifted user-message list, for dedup (see the effect
  // below). Declared before the effect that reads it.
  const userMsgListRef = useRef<{ id: string; text: string; index: number }[]>([])

  // Lift the full user-message list {id, text} to the parent for the
  // pinned-header dropdown. Dedup by length + ids so we only re-emit when the
  // set actually changes (streaming token flushes re-derive renderableItems
  // but don't add user messages, so this avoids churning the parent's state).
  useEffect(() => {
    if (!onUserMessagesChange) return
    const msgs = userMsgIndices.map((idx) => {
      const it = renderableItems[idx]
      return { id: it.id, text: extractUserText(it.msg) ?? '', index: idx }
    })
    const prev = userMsgListRef.current
    if (prev.length === msgs.length && prev.every((p, i) => p.id === msgs[i].id && p.text === msgs[i].text && p.index === msgs[i].index)) {
      return
    }
    userMsgListRef.current = msgs
    onUserMessagesChange(msgs)
  }, [userMsgIndices, renderableItems, onUserMessagesChange])

  // Top-most visible data index, tracked from Virtuoso's `rangeChanged`.
  // rangeChanged reports indices in OFFSET space (dataIndex + firstItemIndex),
  // so we subtract firstItemIndex to get back to the `scrollToIndex` space.
  // Kept in a ref (read by the navigate callback, never rendered).
  const topVisibleIdxRef = useRef(0)
  const firstItemIndexValRef = useRef(firstItemIndex)
  useEffect(() => {
    firstItemIndexValRef.current = firstItemIndex
  }, [firstItemIndex])

  // --- Pinned "current question" header --------------------------------
  // The user message pinned at the panel top = the last real user message
  // whose index is strictly above the viewport top (scrolled out of view).
  // Lifted to the parent via onPinnedUserMessageChange; deduped by id so a
  // scroll that doesn't cross a user-message boundary fires nothing. Uses the
  // same `userMsgIndices` discriminator as `navigate('prev')`, so the pin and
  // the "scroll to previous user message" action always agree on a target.
  const renderableItemsRef = useRef(renderableItems)
  useEffect(() => {
    renderableItemsRef.current = renderableItems
  }, [renderableItems])
  const lastPinnedIdRef = useRef<string | null>(null)
  const emitPinned = useCallback(
    (topIdx: number) => {
      const indices = userMsgIndicesRef.current
      let pinnedIdx = -1
      for (let i = indices.length - 1; i >= 0; i--) {
        if (indices[i] < topIdx) {
          pinnedIdx = indices[i]
          break
        }
      }
      const items = renderableItemsRef.current
      const item = pinnedIdx >= 0 && pinnedIdx < items.length ? items[pinnedIdx] : undefined
      const id = item?.id ?? null
      if (id !== lastPinnedIdRef.current) {
        lastPinnedIdRef.current = id
        onPinnedUserMessageChange?.(id ? { id, text: extractUserText(item!.msg) ?? '' } : null)
      }
    },
    [onPinnedUserMessageChange],
  )
  const handleRangeChanged = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      const idx = range.startIndex - firstItemIndexValRef.current
      topVisibleIdxRef.current = idx
      onVisibleRangeChange?.(idx)
      emitPinned(idx)
    },
    [onVisibleRangeChange, emitPinned],
  )
  // Recompute when the rendered list changes without a range event (e.g. a
  // new turn arrives while parked at a scroll offset) so the pin tracks the
  // live transcript, not just scroll position.
  useEffect(() => {
    emitPinned(topVisibleIdxRef.current)
  }, [renderableItems, emitPinned])
  // Reset dedup state on session switch so a coincidentally-matching id from
  // the previous session can't suppress a fresh emit.
  useEffect(() => {
    lastPinnedIdRef.current = null
    emitPinned(topVisibleIdxRef.current)
  }, [transcriptRevealKey, emitPinned])

  const navigateToIndex = useCallback((target: number) => {
    // Disable follow so the programmatic scroll doesn't fight auto-follow
    // (mirrors the search-result scroll path).
    shouldFollowRef.current = false
    virtuosoRef.current?.scrollToIndex({ index: target, behavior: 'smooth', align: 'start' })
  }, [])

  const navigate = useCallback((dir: 'prev' | 'next') => {
    const indices = userMsgIndicesRef.current
    if (indices.length === 0) return
    const top = topVisibleIdxRef.current
    let target: number | undefined
    if (dir === 'prev') {
      // Last user message strictly above the current viewport top.
      for (let i = indices.length - 1; i >= 0; i--) {
        if (indices[i] < top) { target = indices[i]; break }
      }
    } else {
      // First user message strictly below the current viewport top.
      for (let i = 0; i < indices.length; i++) {
        if (indices[i] > top) { target = indices[i]; break }
      }
    }
    if (target == null) return
    navigateToIndex(target)
  }, [navigateToIndex])

  // Expose the navigator to the parent (Chat —App — session context menu +
  // pinned-header dropdown). Object form so callers get prev/next/to in one
  // stable registration.
  useEffect(() => {
    onRegisterNavigate?.({ prev: () => navigate('prev'), next: () => navigate('next'), to: navigateToIndex })
  }, [onRegisterNavigate, navigate, navigateToIndex])

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
  // follow-scroll OURSELVES via `animateScrollToBottom` (a rAF easing loop
  // that re-reads scrollHeight every frame) and return `false` so Virtuoso
  // doesn't also fire its own scroll and fight ours.
  //
  // Why not return 'smooth' (let Virtuoso animate)? Two problems that the
  // rAF loop fixes:
  //  1. Stale target. A native smooth scroll captures scrollHeight once at
  //     call time; content growth during the ~300ms animation moves the real
  //     bottom past it and the follow lands short. The rAF loop re-targets
  //     every frame, so it always terminates at the real bottom.
  //  2. Follow-disable race. During a smooth follow the viewport is
  //     momentarily not at bottom; the scroll handler / syncBottomGeometry
  //     would see dist>0, arm the 150ms follow-disable debounce, and fire it
  //     mid-follow — flipping shouldFollow/atBottom false so the NEXT append
  //     isn't followed. `animateScrollToBottom` holds `scrollAnimatingRef`
  //     true for the whole animation, which makes syncBottomGeometry and the
  //     scroll handler short-circuit (keep atBottom/follow armed) until it
  //     lands.
  // (The live typing bubble is pinned separately by the streaming
  // ResizeObserver, so this only affects settled-message appends — the
  // standard chat-UI snap-to-new-message.)
  const followOutput = useCallback((_atBottom: boolean) => {
    if (!shouldFollowRef.current) return false
    animateScrollToBottom()
    return false
  }, [animateScrollToBottom])

  const atBottomStateChange = useCallback((reportedAtBottom: boolean) => {
    // Prefer direct DOM geometry so the button and follow-mode use the
    // same bottom definition. Fall back to Virtuoso's report if the
    // scroller is not attached yet.
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

  const itemContent = useCallback((_index: number, item: RenderableItem) => {
    // Only pipe `activeMatchInItem` into the message that actually
    // contains the active navigation target. Every other message gets
    // `undefined` so its <mark>s render at the default colour. This
    // is what lets the user visually tell "next match" jumps from one
    // hit to another even within the same message —without per-match
    // resolution we'd be stuck at message granularity.
    const isActiveItem =
      searchActiveMsgIdx != null &&
      searchActiveMsgIdx >= 0 &&
      item.itemIndex === searchActiveMsgIdx
    const activeMatchInItem = isActiveItem ? searchActiveMatchInItem : undefined
    // One-shot entrance animation for genuinely-new arrivals. The flag is
    // armed in the gate block above. Unlike the previous "delete on first
    // render" approach, we KEEP the flag (and thus the `msg-enter` class)
    // applied across re-renders until the CSS animation ends. A live turn
    // re-renders the row within milliseconds of arrival; deleting the flag on
    // the first render stripped the class on the very next render, cancelling
    // the 240ms animation before it was ever visible (animationend never
    // fired). Keeping the class on the same DOM node lets the CSS animation
    // play exactly once — React reconciling an identical className string
    // doesn't touch the DOM, so the running animation is uninterrupted. The
    // flag is cleared in handleEnterAnimationEnd (animationend) and, as a
    // fallback for rows that unmount before animationend fires, by a timeout
    // scheduled on mount — so a scroll-driven remount later can't replay it.
    const isEntering = enterIdsRef.current.has(item.id)
    const className = [
      'virtuoso-item-wrapper',
      item.id === firstItemId ? 'transcript-first-item' : '',
      item.id === lastItemId ? 'transcript-last-item' : '',
      isEntering ? 'msg-enter' : '',
    ].filter(Boolean).join(' ')
    return (
      <div
        className={className}
        data-message-id={item.id}
        data-enter-id={isEntering ? item.id : undefined}
        ref={isEntering ? enterNodeRef : undefined}
        onAnimationEnd={isEntering ? handleEnterAnimationEnd : undefined}
      >
        <MessageView
          msg={item.msg}
          isCompactSummary={item.isCompactSummary}
          searchQuery={searchQuery}
          activeMatchInItem={activeMatchInItem}
          sending={item.sending}
          deliveryStatus={item.deliveryStatus}
          working={working}
          nextItemType={nextItemTypeMap.get(item.id)}
          onSwitchModel={onSwitchModel}
          onAbortBash={onAbortBash}
        />
      </div>
    )
  }, [searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, handleEnterAnimationEnd, enterNodeRef, working, firstItemId, lastItemId, nextItemTypeMap, onSwitchModel, onAbortBash])

  /* eslint-disable react-hooks/refs -- the pending reveal flag must commit in
     the same render as the ready transcript so the first visible frame can be
     hidden until Virtuoso exposes its measured list. */
  if (transcriptRevealKey == null) {
    pendingTranscriptRevealKeyRef.current = undefined
  } else if (replayReady && consumedTranscriptKeyRef.current !== transcriptRevealKey) {
    consumedTranscriptKeyRef.current = transcriptRevealKey
    pendingTranscriptRevealKeyRef.current = renderableItems.length > 0 ? transcriptRevealKey : undefined
  }
  const isTranscriptRevealPending = transcriptRevealKey != null && pendingTranscriptRevealKeyRef.current === transcriptRevealKey
  const messagesClassName = [
    'chat-messages',
    isTranscriptRevealPending && 'chat-messages-reveal-pending',
    clearing && 'chat-messages-clearing',
  ]
    .filter(Boolean)
    .join(' ')
  const visibleStreamingContent = nextStreamingPresence.content
  const streamingRegionClassName = nextStreamingPresence.exiting
    ? 'chat-streaming-region exiting'
    : 'chat-streaming-region'
  /* eslint-enable react-hooks/refs */

  // Virtuoso Footer is reserved for transcript metadata and invisible bottom
  // breathing room. The live streaming bubble is an overlay, so the spacer
  // lets settled messages scroll underneath it instead of being obscured.
  const virtuosoComponents = useMemo(() => {
    // The Header slot shows a "loading older history" affordance pinned to
    // the top. Only relevant for the main transcript (loadOlder provided).
    // `renderableItems.length > 0` gate: with Virtuoso always mounted, the
    // Header slot would otherwise render even over the empty-state overlay
    // (hasOlder defaults true on every session). There is nothing to "scroll
    // up" for until at least one message exists.
    const showOlderHeader = loadOlder != null && (loadingOlder || hasOlder) && renderableItems.length > 0
    const components: Record<string, () => React.ReactElement> = {}
    if (showOlderHeader) {
      components.Header = () => <OlderHistoryHeader loading={loadingOlder} />
    }
    if (streamingOverlayHeight > 0) {
      components.Footer = () => (
        <StreamingOverlaySpacer height={streamingOverlayHeight} />
      )
    }
    return components
  }, [streamingOverlayHeight, loadOlder, loadingOlder, hasOlder, renderableItems.length])

  // Fold the TaskCreate/TaskUpdate stream into a Map<taskId, TaskState> so
  // the inline TaskMutationView card can resolve a TaskUpdate's subject
  // (set at create time, not repeated in the update input). `items[i].msg`
  // is lockstep-equal to the session's message log (reducer.applyMessage
  // appends both arrays in tandem), so folding from items mirrors what
  // TodoChecklist does with stream.messages. Stable empty sentinel keeps
  // the provider value referential when there are no task events.
  const taskInfoMap = useMemo(
    () => buildTaskStateMap(items.map((it) => it.msg)) ?? EMPTY_TASK_MAP,
    [items],
  )

  return (
    <SessionCwdProvider value={cwd}>
    <BackgroundToolProvider value={onBackgroundTool}>
    <PlanStatusProvider value={planStatus}>
    <PlanContentProvider value={planContent}>
    <QuestionAnswersProvider value={questionAnswers}>
    <ToolStatusProvider value={toolStatus}>
    <ToolResultProvider value={toolResults}>
    <TaskInfoProvider value={taskInfoMap}>
    <ResultConsumedCtx.Provider value={isResultConsumed}>
    <div className="chat-messages-wrap">
      <div className="chat-messages-stage">
      <div ref={messagesElRef} key={transcriptRevealKey} className={messagesClassName} onAnimationEnd={handleTranscriptRevealEnd}>
        {/* Virtuoso is ALWAYS mounted (even with zero items) so its scroller
            is already measured by the time the first message arrives. If it
            were mounted fresh on the empty→first-message transition, the first
            paint would top-align the row (alignToBottom needs one layout pass
            to detect "content shorter than viewport"), producing a one-frame
            flash where the message appears at the top before dropping to the
            bottom. Pre-mounting lets followOutput + alignToBottom pin it to the
            bottom on the very first frame. The empty state below is an overlay
            that covers the idle (header-less) scroller while there's nothing
            to show. */}
        <Virtuoso
          ref={virtuosoRef}
          scrollerRef={scrollerRefCb}
          data={renderableItems}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={renderableItems.length > 0 ? renderableItems.length - 1 : 0}
          followOutput={followOutput}
          atBottomStateChange={atBottomStateChange}
          startReached={startReached}
          rangeChanged={handleRangeChanged}
          itemContent={itemContent}
          components={virtuosoComponents}
          // Render ~600px of items BELOW the fold before they become the
          // bottom anchor. Without this, a new tail item (e.g. a tool card
          // arriving mid-stream) mounts at an estimated height, so totalHeight
          // is wrong for one frame; the ResizeObserver then corrects it and
          // `followOutput` re-pins to bottom, yanking scrollTop by
          // (actual —estimated). That one-frame scroll correction shifts the
          // streaming footer bubble as a block — the "streaming footer" jitter. By
          // pre-rendering tail items offscreen they're already measured before
          // becoming the anchor, so no post-insert scroll correction happens.
          // Rows are memoized, so the extra offscreen DOM is cheap.
          increaseViewportBy={{ top: 0, bottom: 600 }}
          alignToBottom
        />
        {renderableItems.length === 0 && (!expectHistory || replayReady) && (
          <div className="chat-messages-empty">
            {emptyStateContent ?? (gameOpen
                ? <EasterEggGame onExit={closeEasterEgg} />
                : <ChatEmptyState onUnlockEasterEgg={openEasterEgg} />)}
          </div>
        )}
      </div>
      {/* Suppress the jump button until the transcript reveal completes.
          During a session switch the new transcript renders under
          `chat-messages-reveal-pending` (replay in progress, list hidden at
          opacity 0) while renderableItems grows in batches. The inner
          scroller's scroll/ResizeObserver effects re-sync geometry on every
          renderableItems.length change, so geometry flaps (not-at-bottom →
          re-pin → not-at-bottom …) and would otherwise flash this button
          repeatedly over the still-invisible transcript. */}
      {!isTranscriptRevealPending && canJumpToBottom && !atBottom && (
        <button
          type="button"
          className="chat-jump-to-bottom"
          onClick={jumpToBottom}
          aria-label={unseenCount > 0 ? `Scroll to latest: ${unseenCount} new message${unseenCount === 1 ? '' : 's'}` : 'Scroll to latest messages'}
        >
          <IconArrowDown size={16} aria-hidden />
          {unseenCount > 0 && <span className="chat-jump-to-bottom-count" aria-hidden>{unseenCount}</span>}
        </button>
      )}
      {visibleStreamingContent != null && (
        <div
          ref={streamingRegionRef}
          className={streamingRegionClassName}
          aria-hidden={nextStreamingPresence.exiting}
        >
          <StreamingFooter content={visibleStreamingContent} />
        </div>
      )}
      </div>
    </div>
    </ResultConsumedCtx.Provider>
    </TaskInfoProvider>
    </ToolResultProvider>
    </ToolStatusProvider>
    </QuestionAnswersProvider>
    </PlanContentProvider>
    </PlanStatusProvider>
    </BackgroundToolProvider>
    </SessionCwdProvider>
  )
})

const MessageView = memo(function MessageView({
  msg,
  isCompactSummary,
  searchQuery,
  activeMatchInItem,
  sending,
  deliveryStatus,
  working,
  nextItemType,
  onSwitchModel,
  onAbortBash,
}: {
  msg: SdkMessage
  isCompactSummary?: boolean
  searchQuery?: string
  /** Local match index inside this message —when set, the Markdown
   *  renderer marks the Nth `<mark>` as the active navigation target.
   *  Caller computes the index per-message and passes `undefined` (or
   *  -1) for messages that aren't the user's current focus. For
   *  multi-block assistant messages we walk the blocks here and rebase
   *  the index into per-block coordinates so each Markdown only sees
   *  the local sub-index. */
  activeMatchInItem?: number
  /** When true, render the user bubble with a "sending" spinner.
   *  Only meaningful for type='user' messages —propagated from the
   *  TranscriptItem's optimistic-placeholder flag. */
  sending?: boolean
  /** Queue-delivery state of a top-level user turn. 'queued' renders a
   *  "queued" chip (the SDK is busy and hasn't read this turn yet);
   *  'consumed' renders a brief "processing" chip; undefined renders
   *  nothing. Mutually exclusive with `sending` in practice (sending is
   *  the pre-ack optimistic state, deliveryStatus is post-ack). */
  deliveryStatus?: 'queued' | 'consumed'
  /** Whether the session is currently working. Gates the processing
   *  indicator so it only shows on active turns, not on historical
   *  consumed messages after a reconnect. */
  working?: boolean
  /** Type of the next message in the transcript. Used to hide the
   *  processing indicator once the model has started responding
   *  (assistant/result after a consumed user message). */
  nextItemType?: string
  /** Called when the user clicks "Switch model" on a model_not_found
   *  error message. Forwarded from MessageList's onSwitchModel prop. */
  onSwitchModel?: () => void
  /** Force-stop the current in-flight `!`/`!!` command. Forwarded to the
   *  pending bash card's "stop" button. */
  onAbortBash?: () => void
}) {
  const type = msg.type

  // Whether this turn ended because the user interrupted it. Read directly
  // from the SDK result message's `terminal_reason` — the subprocess's
  // authoritative report of why the turn stopped (`aborted_streaming` /
  // `aborted_tools` are the two user-interrupt reasons). Because it lives on
  // `msg` itself, it survives Virtuoso unmount/remount; the old approach
  // stored it in transient component state seeded from a one-shot ref, so a
  // re-mounted result row lost the flag and flipped back to normal
  const isInterrupted =
    type === 'result' &&
    (msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools')

  // Memoise the block list so the child `BlockView` / `ToolResultBlock`
  // memos actually hit. `getBlocks(msg)` returns a *fresh* array (and
  // fresh inner object) every call when `msg.message.content` is a
  // string — the common case for plain text messages. Without this
  // memo, every keystroke in the search box rebuilds every block of
  // every message, even though the underlying message hasn't changed.
  // Stable `msg` reference (the store hands us immutable items) —  // stable `blocks` —stable `block` props —memos hit.
  const blocks = useMemo(() => getBlocks(msg), [msg])

  // Active-match plumbing for multi-block assistant messages.
  // Each text block AND each tool_use diff runs its OWN highlighter, so we
  // rebase the message-local match index into per-block coordinates: figure
  // out how many matches each block contributes (text via extractPlainText,
  // tool_use diff via extractToolUseDiffText) and pass the correct sub-index
  // to the one containing the active hit. Other blocks get `undefined` so
  // their <mark>s render at the default colour. We compute per-block counts
  // on the same view the highlighter uses, so the sums line up with what the
  // user can actually navigate to. tool_result blocks are handled separately
  // by `toolResultActiveMatchIdx` below (they only appear in user frames,
  // which never carry tool_use, so the two walks don't overlap).
  // NOTE: this hook MUST stay at the top level (before any conditional
  // `return`), even though only the assistant branch consumes it —  // calling it inside `if (type === 'assistant')` changes the hook
  // count between renders of different message types (React error #310).
  const blockActiveIdx = useMemo(() => {
    const out: Array<number | undefined> = blocks.map(() => undefined)
    const q = searchQuery?.trim()
    if (!q || activeMatchInItem == null || activeMatchInItem < 0) return out
    let remaining = activeMatchInItem
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      let n = 0
      if (b.type === 'text' && typeof b.text === 'string') {
        n = countMatches(extractPlainText(b.text), q)
      } else if (b.type === 'tool_use') {
        n = countMatches(extractToolUseDiffText(b.input, b.name), q)
      }
      if (n === 0) continue
      if (remaining < n) {
        out[i] = remaining
        break
      }
      remaining -= n
    }
    return out
  }, [blocks, searchQuery, activeMatchInItem])

  // Compute the active match index for tool_result content (both inline
  // via ToolCard and orphan bubbles). After text-block matches are
  // consumed, any remaining matches live in tool_result content.
  const toolResultActiveMatchIdx = useMemo(() => {
    const q = searchQuery?.trim()
    if (!q || activeMatchInItem == null || activeMatchInItem < 0) return undefined
    // Subtract text-block matches first.
    let remaining = activeMatchInItem
    for (const b of blocks) {
      if (b.type !== 'text' || typeof b.text !== 'string') continue
      remaining -= countMatches(extractPlainText(b.text), q)
      if (remaining < 0) return undefined // active match is in a text block
    }
    // Walk tool_result blocks to find which one contains the active match.
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue
      const rc = (b as { content?: unknown }).content
      const text = typeof rc === 'string' ? rc
        : Array.isArray(rc) ? (rc as Array<{ type?: string; text?: string }>)
            .filter(x => x.type === 'text' && typeof x.text === 'string')
            .map(x => x.text).join('\n\n')
        : ''
      if (!text) continue
      const n = countMatches(text, q)
      if (n === 0) continue
      if (remaining < n) return remaining
      remaining -= n
    }
    return undefined
  }, [blocks, searchQuery, activeMatchInItem])

  // The result-consumed predicate is built ONCE by MessageList and shared via
  // context, so willRenderEmpty (the item filter) and this render path use the
  // exact same instance — they can't drift. Read unconditionally per
  // rules-of-hooks even though only the user branch uses it.
  const isResultConsumed = useResultConsumed()

  if (type === 'user') {
    const userContent = extractUserText(msg)
    // Tool results that have been consumed by their card (generic ToolCard
    // inline merge, or PlanCard / QuestionCard) are suppressed here. Only
    // ORPHAN results —whose tool_use_id matched no card —fall through to
    // the standalone bubble below, so no result is ever silently dropped.
    const allToolBlocks = blocks.filter((b) => b.type === 'tool_result')
    const toolBlocks = allToolBlocks.filter(
      (b) => typeof b.tool_use_id !== 'string' || !isResultConsumed(b.tool_use_id),
    )

    // Synthetic "conversation summary" frame that the SDK injects right
    // after compact_boundary. It has role=user because the model will
    // consume it as the next turn's input, but the human never type it.
    // Render it collapsed, wired to the preceding Recap divider.
    if (isCompactSummary) {
      return <CompactSummary text={userContent ?? ''} />
    }

    // A `user` frame is synthetic (i.e. NOT type by the human) in two
    // overlapping cases:
    //   1. It carries at least one `tool_result` block — the SDK uses
    //      the user role to feed tool output back to the model.
    //      Notably, top-level tool calls like `Agent` produce a user
    //      frame with `tool_result` but NO `parent_tool_use_id` (the
    //      result goes to the *main* thread; parent_tool_use_id is only
    //      set for subagent-internal tool hops).
    //   2. It has a non-null `parent_tool_use_id` —this is a subagent
    //      (Task/Agent worker) internal conversation message,
    //      forwarded only when `forwardSubagentText: true`.
    // Real user input always has neither: parent_tool_use_id is null
    // AND content is either a string or an array of text blocks.
    const isSubagent = msg.parent_tool_use_id != null
    // `allToolBlocks` decides "is this a synthetic tool-result frame" (so
    // it never falls through to the real-user path even when every result
    // was merged into a card); `toolBlocks` (orphans only) decides what to
    // actually draw in the fallback bubble.
    const isToolResult = allToolBlocks.length > 0
    const hasOrphanResults = toolBlocks.length > 0
    if (isToolResult || isSubagent) {
      // Nothing left to show? Don't draw an empty card. This covers both
      // subagent heartbeat frames (no text, no result) AND the common new
      // case where every tool_result has been merged into its card.
      // Delegated to willRenderEmpty so renderableItems drops these BEFORE
      // they become empty Virtuoso items (see that fn's comment).
      if (willRenderEmpty(msg, isCompactSummary, isResultConsumed)) return null
      // 'subagent' only for a genuine subagent frame with no orphan result
      // to show; everything else (orphan results, or a merged-only
      // tool-result frame carrying stray text) reads as 'tool result'.
      const label = isSubagent && !hasOrphanResults ? 'subagent' : 'tool result'
      return (
        <div className={`msg tool-result${isSubagent && !hasOrphanResults ? ' subagent' : ''}`}>
          <div className="msg-header">
            <span>{label}</span>
          </div>
          <div className="msg-body">
            {userContent && <div style={{ marginBottom: 6, opacity: 0.8 }}>{userContent}</div>}
            {toolBlocks.map((b, i) => (
              <ToolResultBlock key={i} block={b} searchQuery={searchQuery} activeMatchIdx={toolResultActiveMatchIdx} />
            ))}
          </div>
        </div>
      )
    }

    // Real user message
    // `!` bash mode: a synthetic user message carrying <bash-input> tags.
    // Render as a BashMessage card (command + output + exit badge) instead
    // of a normal "you" bubble. The placeholder (optimistic, pre-POST) only
    // has <bash-input>; the server-injected result adds <bash-stdout> etc.
    if (userContent && userContent.includes('<bash-input>')) {
      return <BashMessage text={userContent} sending={sending} onAbort={onAbortBash} searchQuery={searchQuery} activeMatchInItem={activeMatchInItem} />
    }
    // Synthetic <task-notification> injection — a background subagent's
    // result delivered as user-role text by the harness when a background
    // task settles. NOT human input: render as a neutral result card,
    // never as a "you" bubble. (The SDK's own task completion is a `system`
    // / `task_notification` frame, already hidden; this catches the
    // user-role injection path.)
    //
    // Dedup: when the notification's <tool-use-id> matches a subagent whose
    // result has already been merged into its SubagentCard (the reducer's
    // task-notification completion branch flipped it background→done and
    // captured the result), suppress the standalone card — the result is
    // already shown inline on the subagent card, mirroring how synchronous
    // subagent results are merged. Falls through to the standalone card
    // when there's no matching merged record (a background task not spawned
    // via the Agent tool, or a record that never captured a result) so the
    // result is never silently lost.
    if (isTaskNotificationUserMessage(msg)) {
      const tuId = extractTag(userContent ?? '', 'tool-use-id')
      if (tuId && isResultConsumed(tuId)) return null
      return <TaskNotificationCard text={userContent ?? ''} searchQuery={searchQuery} activeMatchIdx={activeMatchInItem} />
    }
    // Other synthetic user-role messages the SDK explicitly marks non-human
    // via `origin`/`isSynthetic` (peer / channel / coordinator /
    // auto-continuation). Render as a neutral labelled card so they're
    // never misrendered as "you". For SDK versions that don't stamp those
    // fields (0.3.x), isHumanUserMessage falls back to true and this branch
    // is skipped — preserving the existing "you" rendering for real input.
    if (!isHumanUserMessage(msg)) {
      const kind = userMessageOriginKind(msg) ?? 'system'
      return (
        <div className="msg tool-result">
          <div className="msg-header">
            <span>{kind}</span>
          </div>
          <div className="msg-body">
            {userContent && <Markdown text={userContent} searchQuery={searchQuery} activeMatchIdx={activeMatchInItem} />}
          </div>
        </div>
      )
    }
    const imageBlocks = blocks.filter((b) => b.type === 'image')
    // Show the "queued" chip only while the turn is genuinely waiting behind
    // an in-flight turn: server-acknowledged (deliveryStatus === 'queued')
    // and not still in the optimistic pre-ack 'sending' state. Once the SDK
    // consumes it (deliveryStatus flips to 'consumed') the queued chip
    // disappears and a "processing" chip takes its place —but only while
    // the session is actively working, so historical consumed messages
    // after a reconnect don't re-trigger the indicator.
    const showQueued = !sending && deliveryStatus === 'queued'
    // Show processing only while the session is working AND the model
    // hasn't started responding yet. Once an assistant/result message
    // appears after this user turn, the model has moved on —hide the
    // indicator even if the session is still working on a subsequent turn.
    const showProcessing = !sending && deliveryStatus === 'consumed' && working && nextItemType !== 'assistant' && nextItemType !== 'result'
    return (
      <div className={`msg user${sending ? ' msg-sending' : ''}${showQueued ? ' msg-queued' : ''}`}>
        <div className="msg-header">
          <span><IconUser size={12} /> you</span>
          <MessageTimestamp ms={msg.receivedAt} />
          {sending && (
            <span
              className="msg-sending-indicator"
              title="Sending - waiting for the server to acknowledge"
              aria-label="Sending"
            >
              <span className="msg-sending-spinner" aria-hidden />
              <span className="msg-sending-label">sending</span>
            </span>
          )}
          {showQueued && (
            <span
              className="msg-queued-indicator"
              title="Queued - the assistant is finishing the current turn; this message will be picked up next"
              aria-label="Queued, waiting for the current turn to finish"
            >
              <span className="msg-queued-dot" aria-hidden />
              <span className="msg-queued-label">queued</span>
            </span>
          )}
          {showProcessing && (
            <span
              className="msg-processing-indicator"
              title="Processing - the model is working on this message"
              aria-label="Processing"
            >
              <span className="msg-processing-dot" aria-hidden />
              <span className="msg-processing-label">processing</span>
            </span>
          )}
        </div>
        <div className="msg-body">
          {imageBlocks.length > 0 && (
            <div className="msg-image-row">
              {imageBlocks.map((b, i) => (
                <BlockView key={`img-${i}`} block={b} />
              ))}
            </div>
          )}
          {userContent && <Markdown text={userContent} breaks searchQuery={searchQuery} activeMatchIdx={activeMatchInItem} />}
        </div>
      </div>
    )
  }

  if (type === 'assistant') {
    // The CLI emits a synthetic assistant message when an upstream API error
    // breaks the turn mid-response — most commonly "API Error: Connection
    // closed mid-response. The response above may be incomplete." It's a
    // transient network blip, not a tool/model failure, so render it with
    // the interrupted (amber `!`) divider vocabulary — the same visual the
    // user sees when they manually abort a turn — instead of a normal
    // assistant bubble that parrots the CLI's raw error text.
    //
    // Detection is gated on `msg.error` (or the explicit isApiErrorMessage
    // flag) so a NORMAL assistant reply that merely quotes the phrase — e.g.
    // an explanation of this very fix — is never mis-rendered. Only error-
    // flagged assistant messages can be the synthetic disconnect; for those,
    // two transports carry different markers:
    //   • History reload: the CLI's JSONL transcript has isApiErrorMessage
    //     (absent from the SDK's streamed type, so it only surfaces via
    //     history-reader parsing the on-disk log).
    //   • Live stream: the SDK omits that flag, but the body still carries
    //     the stable CLI string "Connection closed mid-response".
    // The raw text is kept in the title for debugging.
    if (msg.isApiErrorMessage === true || typeof msg.error === 'string') {
      const apiErrText = extractMessagePlainText(msg) ?? ''
      // Hard account-level 429 (not auto-retried by the SDK — that path
      // surfaces as a transient `api_retry` system frame). The assistant
      // `rate_limit` error is fatal: the turn was rejected, so render the
      // same red `.msg.result.error` divider already used for the
      // `system/error` 429 case, with the raw SDK text kept in the title for
      // debugging. A normal reply quoting "rate limit" is never mis-rendered
      // — this branch is gated on `msg.error === 'rate_limit'`.
      if (msg.error === 'rate_limit') {
        // Fall back to the `error` enum value when the SDK omitted a text
        // body — extractMessagePlainText only falls back to `msg.error` for
        // `system` frames (not assistant), so an empty body would otherwise
        // yield an empty tooltip and drop the only debugging clue.
        return <RateLimitErrorDivider title={apiErrText || msg.error || 'rate limit'} />
      }
      const isDisconnected =
        msg.isApiErrorMessage === true ||
        /connection closed mid-response/i.test(apiErrText)
      if (isDisconnected) {
        return (
          <div
            className="msg result interrupted"
            title={apiErrText}
            aria-label="connection interrupted"
          >
            <span className="result-mark" aria-hidden="true">!</span>
            <span className="result-meta">connection interrupted · reply may be incomplete, resend to continue</span>
          </div>
        )
      }
    }
    // Subagent assistant turns (from Task tool workers with
    // forwardSubagentText on) carry the same shape as main-thread
    // assistant turns but with a non-null parent_tool_use_id. Label
    // them distinctly so users can tell which model produced which
    // output —without this, a subagent's `tool_use: Bash` would look
    // identical to the main model running Bash.
    const isSubagent = msg.parent_tool_use_id != null
    // Suppress assistant messages with no visible content. The SDK can emit
    // a standalone assistant message whose only block is an empty
    // (signature-only) thinking block —BlockView renders it as null, but
    // the surrounding card would still paint an empty "— assistant" shell.
    // The visibility rule lives in willRenderEmpty so renderableItems can
    // drop these before they become empty Virtuoso items (see that fn).
    if (willRenderEmpty(msg, isCompactSummary, isResultConsumed)) return null
    // The CLI translates a 404 (model not found / no access) into an
    // assistant error message with error='model_not_found'. Offer a
    // one-click "Switch model" affordance instead of leaving the user to
    // decode the CLI's "Run /model" text (which doesn't apply to a web UI).
    const modelNotFound = msg.error === 'model_not_found'
    return (
      <div className={`msg assistant${isSubagent ? ' subagent' : ''}${modelNotFound ? ' msg-error-card' : ''}`}>
        <div className="msg-header">
          <span>{isSubagent ? 'subagent' : 'assistant'}</span>
          <MessageTimestamp ms={msg.receivedAt} />
          {msg.error && !modelNotFound && <span className="msg-header-error">{msg.error as string}</span>}
        </div>
        <div className="msg-body">
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} searchQuery={searchQuery} activeMatchIdx={blockActiveIdx[i]} toolResultActiveMatchIdx={toolResultActiveMatchIdx} />
          ))}
          {modelNotFound && onSwitchModel && (
            <button type="button" className="btn btn-sm msg-switch-model-btn" onClick={onSwitchModel}>
              Switch model
            </button>
          )}
        </div>
      </div>
    )
  }

  if (type === 'result') {
    const cost = typeof msg.total_cost_usd === 'number' ? `$${msg.total_cost_usd.toFixed(4)}` : ''
    const durMs = typeof msg.duration_ms === 'number' ? Math.round(msg.duration_ms) : null
    // Render sub-second durations as ms, —s as one-decimal seconds — a
    // bare "1234ms" reads slower than "1.2s" at a glance.
    const dur = durMs == null ? '' : durMs >= 1000 ? `${(durMs / 1000).toFixed(1)}s` : `${durMs}ms`
    const turns =
      typeof msg.num_turns === 'number' ? `${msg.num_turns} turn${msg.num_turns === 1 ? '' : 's'}` : ''
    // Token usage from the SDK's result payload. `input_tokens` is the
    // turn-accumulated prompt total and —per the Anthropic API —does NOT
    // include cache tokens, so the true input volume sums all three input
    // buckets. `output_tokens` is what the model actually generated.
    const usage = (msg as {
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number | null
        cache_creation_input_tokens?: number | null
      }
    }).usage
    const inTok = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      : 0
    const outTok = usage?.output_tokens ?? 0
    const tokens = inTok > 0 || outTok > 0 ? `${formatTokens(inTok)} in \u00b7 ${formatTokens(outTok)} out` : ''
    const meta = [turns, dur, tokens, cost].filter(Boolean).join(' \u00b7 ')
    return (
      <div
        className={`msg result${isInterrupted ? ' interrupted' : ''}`}
        aria-label={isInterrupted ? 'turn interrupted' : 'turn complete'}
      >
        <span className="result-mark" aria-hidden="true">{isInterrupted ? '!' : 'ok'}</span>
        {meta && <span className="result-meta">{meta}</span>}
      </div>
    )
  }

  if (type === 'system' && msg.subtype === 'error') {
    const raw = String(msg.error ?? 'unknown error')
    if (/429|rate.?limit/i.test(raw)) {
      return <RateLimitErrorDivider title="too many requests — message saved, send again" />
    }
    return (
      <div className="msg result error" title={raw} aria-label="system error">
        <span className="result-mark" aria-hidden="true">✕ error</span>
        <span className="result-meta">{raw}</span>
      </div>
    )
  }

  if (type === 'system' && msg.subtype === 'compact_boundary') {
    return <CompactBoundary msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'api_retry') {
    return <ApiRetryView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'local_command_output') {
    return <LocalCommandOutputView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'memory_recall') {
    return <MemoryRecallView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'permission_denied') {
    return <PermissionDeniedView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'informational') {
    return <InformationalView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'model_refusal_fallback') {
    return <ModelRefusalFallbackView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'model_refusal_no_fallback') {
    return <ModelRefusalNoFallbackView msg={msg} />
  }

  // `tool_use_summary` is a top-level type: a compact "what just happened"
  // one-liner the CLI emits after a tool cascade. Rendered as a subdued
  // summary line — the detailed tool cards above it stay untouched.
  if (type === 'tool_use_summary') {
    return <ToolUseSummaryView msg={msg} />
  }

  if (type === 'rate_limit_event') {
    return <RateLimitView msg={msg} />
  }

  return (
    <div className="msg system">
      <div className="msg-header">
        <span>
          {type}
          {msg.subtype ? ` · ${msg.subtype}` : ''}
        </span>
      </div>
    </div>
  )
})

/** Inline message timestamp shown in the header. Renders the clock time
 *  (HH:MM:SS) with the full date+time on hover. Returns null when the
 *  message has no server-stamped time (e.g. history restored from disk
 *  after a server restart) so we never show a misleading value. */
function MessageTimestamp({ ms }: { ms: number | undefined }) {
  if (ms == null) return null
  return (
    <Tooltip label={formatFullTimestamp(ms)} placement="top">
      <time className="msg-timestamp" dateTime={new Date(ms).toISOString()}>
        {formatClockTime(ms)}
      </time>
    </Tooltip>
  )
}

/** Recap / compact-boundary marker.
 *
 *  The SDK emits this when it has just summarised a chunk of the
 *  transcript to keep the context window in bounds. We render it as a
 *  horizontal rule with a short "Recap" label and token savings; the
 *  underlying summary string lives on the next SDK turn's system
 *  prompt, not in this message, but the metadata here is enough to
 *  give the user a visual cue that the preceding transcript has been
 *  compressed. */
/** Reverse server/exec.ts `escapeXml`. The `!` bash-mode synthetic message
 *  XML-escapes the command + stdout + stderr before embedding them in
 *  `<bash-input>` / `<bash-stdout>` / `<bash-stderr>` tags (so a stdout body
 *  containing `</bash-stdout>` can't break the tag slicing). `extractTag`
 *  pulls the escaped text back out verbatim; without un-escaping here, a `>`
 *  in command output would render as the literal `&gt;` (React sets it via
 *  textContent, which does NOT re-parse entities).
 *
 *  This MUST mirror `escapeXml` exactly — it only ever produces `&amp;`,
 *  `&lt;`, `&gt;`, so we only decode those three. Decoding other entities
 *  (`&quot;`, `&apos;`, …) would corrupt output that legitimately contains
 *  those literal strings. Order matters: `&amp;` is decoded LAST so
 *  `&amp;lt;` round-trips to `&lt;` (literal), not to `<` — mirroring how
 *  `escapeXml` encodes `&` first. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Extract the inner text of the first `<tag>...</tag>` in `s`, or null.
 *  Used to parse the <bash-*> tags the server injects for `!` mode. The
 *  returned text is run through `unescapeXml` so it matches what the
 *  server originally captured (see `escapeXml` in server/exec.ts). */
function extractTag(s: string, tag: string): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = s.indexOf(open)
  if (start < 0) return null
  const end = s.indexOf(close, start + open.length)
  if (end < 0) return null
  return unescapeXml(s.slice(start + open.length, end))
}

/** Render a `!` bash-mode synthetic message. Parses <bash-input>,
 *  <bash-exit code="...">, <bash-stdout>, <bash-stderr> tags and shows the
 *  command + output as a card resembling a Bash tool result. While the
 *  optimistic placeholder is in flight (only <bash-input>, no stdout), a
 *  spinner takes the output's place. */
function BashMessage({ text, sending, onAbort, searchQuery, activeMatchInItem }: {
  text: string
  sending?: boolean
  onAbort?: () => void
  searchQuery?: string
  activeMatchInItem?: number
}) {
  const command = extractTag(text, 'bash-input') ?? ''
  const stdout = extractTag(text, 'bash-stdout')
  const stderr = extractTag(text, 'bash-stderr')
  const q = searchQuery?.trim()
  const hasSearch = Boolean(q)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Determine which AnsiText (stdout / stderr) contains the active match
  // and what its local index is. Matches in the command itself are skipped
  // (the <code> element doesn't go through AnsiText).
  const { stdoutActiveIdx, stderrActiveIdx } = useMemo(() => {
    if (!q || activeMatchInItem == null || activeMatchInItem < 0) return { stdoutActiveIdx: undefined, stderrActiveIdx: undefined }
    const cmdMatches = countMatches(command, q)
    const stdoutMatches = stdout ? countMatches(stdout, q) : 0
    let remaining = activeMatchInItem - cmdMatches
    if (remaining < 0) return { stdoutActiveIdx: undefined, stderrActiveIdx: undefined }
    if (remaining < stdoutMatches) return { stdoutActiveIdx: remaining, stderrActiveIdx: undefined }
    remaining -= stdoutMatches
    if (stderr && remaining < countMatches(stderr, q)) return { stdoutActiveIdx: undefined, stderrActiveIdx: remaining }
    return { stdoutActiveIdx: undefined, stderrActiveIdx: undefined }
  }, [command, stdout, stderr, q, activeMatchInItem])

  // Scroll the active search <mark> into view inside the (potentially
  // scrollable) stdout/stderr <pre> containers.
  useEffect(() => {
    if (!hasSearch) return
    const el = bodyRef.current
    if (!el) return
    const active = el.querySelector('.search-hl-active')
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
  // <bash-exit code="0" timedOut="true" interrupted="true" truncated="true" />
  const exitMatch = text.match(/<bash-exit\s+code="(-?\d+)"([^/]*)\/?>/)
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null
  const exitAttrs = exitMatch?.[2] ?? ''
  const timedOut = exitAttrs.includes('timedOut="true"')
  const interrupted = exitAttrs.includes('interrupted="true"')
  const truncated = exitAttrs.includes('truncated="true"')
  const pending = stdout === null && !sending // server hasn't injected result yet
  const ok = exitCode === 0
  return (
    <div className="msg bash-msg" role="note" aria-label={`Shell command: ${command}`}>
      <div className="bash-msg-header">
        <span className="bash-msg-cmd">
          <span className="bash-msg-prompt" aria-hidden>$</span>
          <code>{command}</code>
        </span>
        {exitCode !== null && !pending && (
          <span className={`bash-msg-exit ${ok ? 'ok' : 'err'}`}>
            {timedOut ? 'timeout' : interrupted ? 'interrupted' : `exit ${exitCode}`}
          </span>
        )}
        {pending && (
          <span className="bash-msg-pending" aria-label="running">
            <span className="msg-sending-spinner" aria-hidden />
            {onAbort && (
              <button
                type="button"
                className="bash-msg-abort"
                onClick={onAbort}
                aria-label="Stop command"
                title="Stop command (Ctrl+C)"
              >
                <IconSquare size={11} />
                <span>Stop</span>
              </button>
            )}
          </span>
        )}
      </div>
      {(stdout || stderr || pending) && (
        <div className="bash-msg-body" ref={bodyRef}>
          {pending ? (
            <span className="bash-msg-pending-text">Running…</span>
          ) : (
            <>
              {stdout && (
                <div className="bash-msg-out bash-msg-out--stdout">
                  <span className="bash-msg-out-label">stdout</span>
                  <pre className="bash-msg-pre"><AnsiText text={stdout} searchQuery={searchQuery} activeMatchIdx={stdoutActiveIdx} /></pre>
                </div>
              )}
              {stderr && (
                <div className="bash-msg-out bash-msg-out--stderr">
                  <span className="bash-msg-out-label">stderr</span>
                  <pre className="bash-msg-pre"><AnsiText text={stderr} searchQuery={searchQuery} activeMatchIdx={stderrActiveIdx} /></pre>
                </div>
              )}
              {truncated && <div className="bash-msg-truncated">output truncated</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Render a synthetic `<task-notification>` user message — the harness's
 *  background-subagent result injection. Parses the `<status>`, `<summary>`,
 *  and `<result>` tags and shows the result body as a neutral card so it is
 *  never mistaken for a human-typed "you" bubble. Reuses the same `msg
 *  tool-result` styling as an orphan tool-result frame (no new CSS), with a
 *  header that names the origin and completion status. */
function TaskNotificationCard({ text, searchQuery, activeMatchIdx }: {
  text: string
  searchQuery?: string
  activeMatchIdx?: number
}) {
  const status = extractTag(text, 'status') ?? 'completed'
  const summary = extractTag(text, 'summary') ?? undefined
  const result = extractTag(text, 'result') ?? undefined
  return (
    <div className="msg tool-result task-notification">
      <div className="msg-header">
        <span>background task · {status}</span>
      </div>
      <div className="msg-body">
        {summary && <div style={{ marginBottom: result ? 6 : 0, opacity: 0.85 }}>{summary}</div>}
        {result && <Markdown text={result} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />}
      </div>
    </div>
  )
}

function CompactBoundary({ msg }: { msg: SdkMessage }) {
  const meta = (msg as { compact_metadata?: {
    trigger?: 'manual' | 'auto'
    pre_tokens?: number
    post_tokens?: number
    duration_ms?: number
  } }).compact_metadata ?? {}
  const pre = typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined
  const post = typeof meta.post_tokens === 'number' ? meta.post_tokens : undefined
  const trigger = meta.trigger === 'manual' ? 'manual' : 'auto'
  const savings =
    pre !== undefined && post !== undefined && pre > 0
      ? ` · saved ${Math.round(((pre - post) / pre) * 100)}%`
      : ''
  const duration =
    typeof meta.duration_ms === 'number' ? ` · ${Math.round(meta.duration_ms)}ms` : ''
  return (
    <div className="msg recap" role="separator" aria-label="Conversation recap / compact boundary">
      <span className="recap-label">
        <span aria-hidden>↘</span> Recap ({trigger})
      </span>
      <span className="recap-meta">
        {pre !== undefined && post !== undefined
          ? `${formatTokens(pre)} -> ${formatTokens(post)} tokens${savings}${duration}`
          : 'Conversation compacted to fit the context window.'}
      </span>
    </div>
  )
}

/** Fatal rate-limit / 429-rejection divider. Shared by the two paths that
 *  render a "you were rate limited — resend" cue so the mark, canned meta
 *  copy, and `.msg.result.error` styling can't drift apart:
 *    • `system/error` frames whose body matches `/429|rate.?limit/i`
 *    • assistant messages with `error: 'rate_limit'` (hard account-level 429
 *      that the SDK did NOT auto-retry — the auto-retry path surfaces as the
 *      transient `api_retry` amber divider instead).
 *  `title` carries the raw error text for debugging (hover); each caller
 *  decides what that should be (the system path uses the canned copy; the
 *  assistant path uses the extracted body, falling back to the `error` enum). */
function RateLimitErrorDivider({ title }: { title: string }) {
  return (
    <div className="msg result error" title={title} aria-label="rate limit error">
      <span className="result-mark" aria-hidden="true">✕ rate limited</span>
      <span className="result-meta">too many requests — message saved, send again</span>
    </div>
  )
}

/** Wire shape of an `api_retry` system frame. The fields are all
 *  optional from the renderer's perspective —older / partial frames
 *  may omit any of them —but the cast lives here once instead of at
 *  every read site. */
interface ApiRetryMessage {
  attempt?: number
  max_retries?: number
  retry_delay_ms?: number
  error_status?: number | null
  error?: string
}

/** Inline retry indicator. The server emits one `api_retry` frame per
 *  attempt with a snapshot of `retry_delay_ms`; rendering that number
 *  directly froze the countdown at e.g. "9s" until the next attempt
 *  landed. This component runs a local 1Hz clock so the user actually
 *  sees the seconds tick down.
 *
 *  Anchor strategy: we derive an absolute `deadline` (wall-clock ms at
 *  which the retry will fire) by combining the message's mount time
 *  with `retry_delay_ms`. The deadline is held in state and reset only
 *  when a fresh frame lands with a different `retry_delay_ms` — the
 *  reducer routes consecutive `api_retry` frames to the `mirror.apiRetry`
 *  slot (overwriting the previous), and MessageList renders that slot as a
 *  synthetic tail item with a stable id, so this component gets new props
 *  rather than remounting. Reading deadline-now is monotonic across that prop
 *  change; the previous baseline+delay split could briefly show a
 *  garbled number for one render after a new frame.
 *
 *  We stop the interval at remainingMs → 0 — the next attempt is in
 *  flight; either it succeeds (no more frames) or a new frame arrives
 *  and the effect restarts the timer. */
function ApiRetryView({ msg }: { msg: SdkMessage }) {
  const m = msg as unknown as ApiRetryMessage
  const attempt = m.attempt ?? 0
  const maxRetries = m.max_retries ?? 0
  const delayMs = m.retry_delay_ms ?? 0
  const errorStatus = m.error_status
  const errorKind = m.error ?? 'unknown'

  // We hold an absolute `deadline` (wall-clock ms at which the retry
  // fires) and a ticking `now`. Combining the two in a single state
  // object means a delayMs prop change updates both together —no
  // render where deadline is "new" but now is from the previous frame.
  //
  // Caveat: when `delayMs` changes mid-component-life (the reducer
  // overwrites the `apiRetry` slot with the new frame —see
  // `reducer.ts` applyMessage), there's a single render between prop change
  // and effect-firing where we still use the old deadline. React
  // batches the effect's setState into the same microtask, so visually
  // it's a flash at most a frame long. Building a "fresh deadline in
  // render" fallback would need `Date.now()` inside render, which
  // violates the pure-render rule.
  const [state, setState] = useState(() => {
    const now = Date.now()
    return { deadline: now + delayMs, now }
  })

  useEffect(() => {
    const start = Date.now()
    const deadline = start + delayMs
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing the message's delayMs prop into the local deadline is the explicit purpose of this effect, not an anti-pattern.
    setState({ deadline, now: start })
    if (delayMs <= 0) return
    // Clear the interval the first tick that crosses the deadline, so a
    // long-lived api_retry message that's already counted to "retrying
    // now— stops costing us a render per second forever. A new
    // api_retry frame with a different delayMs re-runs this effect
    // (deps include delayMs) and starts a fresh interval.
    const id = window.setInterval(() => {
      const now = Date.now()
      setState((prev) => ({ ...prev, now }))
      if (now >= deadline) window.clearInterval(id)
    }, 1000)
    return () => window.clearInterval(id)
  }, [delayMs])

  const remainingMs = Math.max(0, state.deadline - state.now)
  const seconds = Math.ceil(remainingMs / 1000)

  const label = errorStatus === 429
    ? 'rate limited'
    : errorStatus === 529
      ? 'overloaded'
      : errorKind === 'server_error'
        ? 'server error'
        : 'retrying'
  // Once we've ticked down to 0 the next attempt is mid-flight; "now"
  // is more honest than "in 0s".
  const phase = seconds > 0 ? `retrying in ${seconds}s` : 'retrying now'
  // Suppress the "/0" tail when max_retries is missing —better to
  // show just the attempt number than a nonsense fraction.
  const attemptText =
    maxRetries > 0 ? `attempt ${attempt}/${maxRetries}` : `attempt ${attempt}`
  return (
    <div className="msg result retry" aria-label="api retry">
      <span className="result-mark" aria-hidden="true"><IconClock size={12} /> {label}</span>
      <span className="result-meta">{phase} · {attemptText}</span>
    </div>
  )
}

/** Renders `system/local_command_output` — the text output of CLI-local
 *  commands typed by the user in the composer (`/usage`, `/voice`, …).
 *  The body is a plain string at the top level (`msg.content`), rendered
 *  assistant-style via Markdown per the SDK docs. Defensive: a non-string
 *  body (future SDK shape change) renders a muted fallback instead of
 *  crashing. */
function LocalCommandOutputView({ msg }: { msg: SdkMessage }) {
  const body = typeof msg.content === 'string' ? msg.content : ''
  if (!body) return null
  return (
    <div className="msg local-command-output" aria-label="command output">
      <div className="msg-header">
        <span>command output</span>
      </div>
      <div className="local-command-output-body">
        <Markdown text={body} />
      </div>
    </div>
  )
}

/** Renders `system/permission_denied` — a tool call was auto-denied WITHOUT
 *  an interactive permission prompt (dontAsk / auto-mode classifier, deny
 *  rules, headless auto-deny). The interactive 'ask' path surfaces via the
 *  permission dialog; this card is the only visibility the non-interactive
 *  deny path gets. Single subdued line (result-divider style) so a cascade
 *  of denied calls doesn't flood the transcript; the full rejection message
 *  the model saw rides on hover. */
function PermissionDeniedView({ msg }: { msg: SdkMessage }) {
  const m = msg as {
    tool_name?: unknown
    tool_use_id?: unknown
    agent_id?: unknown
    decision_reason_type?: unknown
    decision_reason?: unknown
    message?: unknown
  }
  const tool = typeof m.tool_name === 'string' && m.tool_name ? m.tool_name : 'tool'
  const reasonType = typeof m.decision_reason_type === 'string' ? m.decision_reason_type : undefined
  const reason = typeof m.decision_reason === 'string' ? m.decision_reason : undefined
  const detail = typeof m.message === 'string' ? m.message : undefined
  // 'rule' / 'mode' / 'classifier' / 'asyncAgent' — the deciding component.
  const reasonParts = [reasonType, reason].filter(Boolean).join(': ')
  return (
    <div className="msg result permission-denied" aria-label="tool call denied">
      <span className="result-mark" aria-hidden="true">✕ denied</span>
      <span className="result-meta" title={detail ?? undefined}>
        {tool}
        {reasonParts ? ` — ${reasonParts}` : ''}
      </span>
    </div>
  )
}

/** Renders `system/informational` — a generic text banner from the loop
 *  (hook block reason, slash-command output, non-error status line). Level
 *  drives prominence: 'info'/'notice' render as muted single lines;
 *  'suggestion'/'warning' get the stronger card treatment. `content` is
 *  plaintext per the SDK contract — render as text, not markdown. */
function InformationalView({ msg }: { msg: SdkMessage }) {
  const m = msg as { content?: unknown; level?: unknown; prevent_continuation?: unknown }
  const body = typeof m.content === 'string' ? m.content : ''
  if (!body) return null
  const level = typeof m.level === 'string' ? m.level : 'info'
  const prominent = level === 'warning' || level === 'suggestion'
  return (
    <div
      className={`msg informational${prominent ? ` informational--${level}` : ''}`}
      aria-label={`informational (${level})`}
    >
      {level === 'warning' && <span className="result-mark" aria-hidden="true">⚠</span>}
      <span className="informational-body">{body}</span>
    </div>
  )
}

/** Renders `system/model_refusal_fallback` — the primary model refused and
 *  the turn was retried once on the fallback model (the swap persists for
 *  the session). The refused leg's already-streamed partial messages are
 *  evicted by the reducer (retracted_message_uuids / assistant supersedes),
 *  so this card is the canonical record of what happened. `content` is the
 *  CLI's banner text; api_refusal_explanation is unstable prose shown as the
 *  detail line. */
function ModelRefusalFallbackView({ msg }: { msg: SdkMessage }) {
  const m = msg as {
    original_model?: unknown
    fallback_model?: unknown
    content?: unknown
    api_refusal_explanation?: unknown
    api_refusal_category?: unknown
  }
  const from = typeof m.original_model === 'string' && m.original_model ? m.original_model : 'primary model'
  const to = typeof m.fallback_model === 'string' && m.fallback_model ? m.fallback_model : 'fallback model'
  const body = typeof m.content === 'string' ? m.content : ''
  const explanation = typeof m.api_refusal_explanation === 'string' ? m.api_refusal_explanation : undefined
  const category = typeof m.api_refusal_category === 'string' ? m.api_refusal_category : undefined
  return (
    <div className="msg refusal-fallback" aria-label="model refusal fallback">
      <div className="msg-header">
        <span>
          refused by {from} — retrying on {to}
          {category ? ` (${category})` : ''}
        </span>
      </div>
      {body && <div className="refusal-fallback-body">{body}</div>}
      {explanation && (
        <div className="refusal-fallback-detail" title={explanation}>{explanation}</div>
      )}
    </div>
  )
}

/** Renders `system/model_refusal_no_fallback` — the primary model ended the
 *  stream with stop_reason "refusal" and NO retry ran (no fallback model is
 *  configured, or per-category routing declined the retry). Unlike
 *  model_refusal_fallback there is no retried leg, so no uuids are evicted —
 *  this card is the transcript's record of why the turn ended. `content` is
 *  the CLI's banner text; api_refusal_explanation is unstable prose shown as
 *  the detail line. */
function ModelRefusalNoFallbackView({ msg }: { msg: SdkMessage }) {
  const m = msg as {
    original_model?: unknown
    content?: unknown
    api_refusal_explanation?: unknown
    api_refusal_category?: unknown
  }
  const from = typeof m.original_model === 'string' && m.original_model ? m.original_model : 'primary model'
  const body = typeof m.content === 'string' ? m.content : ''
  const explanation = typeof m.api_refusal_explanation === 'string' ? m.api_refusal_explanation : undefined
  const category = typeof m.api_refusal_category === 'string' ? m.api_refusal_category : undefined
  return (
    <div className="msg refusal-fallback" aria-label="model refusal (no fallback)">
      <div className="msg-header">
        <span>
          refused by {from} — no fallback available
          {category ? ` (${category})` : ''}
        </span>
      </div>
      {body && <div className="refusal-fallback-body">{body}</div>}
      {explanation && (
        <div className="refusal-fallback-detail" title={explanation}>{explanation}</div>
      )}
    </div>
  )
}

/** Renders `tool_use_summary` — a compact one-line recap the CLI emits
 *  after a tool cascade (transcript compression). Subdued single line; the
 *  detailed tool cards above it are unaffected. */
function ToolUseSummaryView({ msg }: { msg: SdkMessage }) {
  const summary = typeof msg.summary === 'string' ? msg.summary : ''
  if (!summary) return null
  return (
    <div className="msg tool-use-summary" aria-label="tool use summary">
      <span className="tool-use-summary-mark" aria-hidden="true">Σ</span>
      <span className="tool-use-summary-body">{summary}</span>
    </div>
  )
}

/** Renders `system/memory_recall` — the auto-memory supervisor surfaced
 *  relevant memories into the current turn. Mirrors the CLI's
 *  "Recalled from memory" attachment so users can see what context was
 *  injected.
 *
 *  Select-mode file-backed entries carry only a path (the CLI lazy-loads
 *  bodies); this app deliberately has no memory-file read API, so those
 *  render as filename + scope badge with the full path on hover.
 *  Synthesize-mode entries and organization-scope URLs carry `content`,
 *  which renders as markdown. The `<synthesis:DIR>` sentinel path is shown
 *  as a "Synthesized summary" card with DIR as the source — never as a
 *  path. */
const MEMORY_RECALL_COLLAPSE_LIMIT = 4
const MEMORY_RECALL_PEEK = 3
const SYNTHESIS_PATH_RE = /^<synthesis:(.+)>$/

function memoryRecallPathLabel(path: string): { label: string; synthesisDir?: string } {
  const m = SYNTHESIS_PATH_RE.exec(path)
  if (m) return { label: m[1], synthesisDir: m[1] }
  // Organization-scope memories are https URLs — show the host, not the
  // (often very long) full URL.
  if (/^https:\/\//.test(path)) {
    try {
      return { label: new URL(path).hostname }
    } catch {
      /* fall through to basename handling */
    }
  }
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return { label: idx >= 0 ? path.slice(idx + 1) : path }
}

function MemoryRecallEntry({ entry }: { entry: { path: string; scope: string; content?: string } }) {
  const path = typeof entry.path === 'string' ? entry.path : String(entry?.path ?? '')
  const { label, synthesisDir } = memoryRecallPathLabel(path)
  const scope = String(entry?.scope ?? '')
  const content = typeof entry?.content === 'string' && entry.content ? entry.content : undefined
  if (synthesisDir !== undefined) {
    return (
      <li className="memory-recall-entry memory-recall-entry--synthesis">
        <div className="memory-recall-entry-head">
          <span className="memory-recall-name">Synthesized summary</span>
          {scope && <span className={`memory-recall-scope memory-recall-scope--${scope}`}>{scope}</span>}
        </div>
        <div className="memory-recall-source">{synthesisDir}</div>
        {content && (
          <div className="memory-recall-body">
            <Markdown text={content} />
          </div>
        )}
      </li>
    )
  }
  return (
    <li className="memory-recall-entry" title={path}>
      <div className="memory-recall-entry-head">
        <span className="memory-recall-name">{label || path}</span>
        {scope && <span className={`memory-recall-scope memory-recall-scope--${scope}`}>{scope}</span>}
      </div>
      {content && (
        <div className="memory-recall-body">
          <Markdown text={content} />
        </div>
      )}
    </li>
  )
}

function MemoryRecallView({ msg }: { msg: SdkMessage }) {
  const memories = Array.isArray(msg.memories) ? msg.memories : []
  const [expanded, setExpanded] = useState(false)
  const collapsible = memories.length > MEMORY_RECALL_COLLAPSE_LIMIT
  const visible = collapsible && !expanded ? memories.slice(0, MEMORY_RECALL_PEEK) : memories
  const modeLabel = msg.mode === 'synthesize' ? 'synthesized' : 'selected files'
  return (
    <div className="msg memory-recall" aria-label="recalled from memory">
      <div className="msg-header">
        <span>Recalled from memory · {modeLabel}</span>
      </div>
      {visible.length > 0 && (
        <ul className="memory-recall-list">
          {visible.map((entry, i) => (
            <MemoryRecallEntry key={`${i}-${typeof entry?.path === 'string' ? entry.path : i}`} entry={entry} />
          ))}
        </ul>
      )}
      {collapsible && (
        <button
          type="button"
          className="memory-recall-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : `+${memories.length - MEMORY_RECALL_PEEK} more`}
        </button>
      )}
    </div>
  )
}

/** Display names for `rate_limit_event.rateLimitType`. Unknown values fall
 *  back to the raw string — new SDK enum members should still read OK. */
const RATE_LIMIT_TYPE_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: '7-day limit',
  seven_day_opus: 'Opus 7-day',
  seven_day_sonnet: 'Sonnet 7-day',
  overage: 'Overage',
}

/** Inline card for `rate_limit_event` frames — a plan rate-limit state
 *  transition (`allowed` → `allowed_warning` → `rejected`). Static by
 *  design (unlike ApiRetryView): these windows reset on hour scales, so
 *  there is nothing meaningful to tick. `resetsAt` is Unix seconds. */
function RateLimitView({ msg }: { msg: SdkMessage }) {
  const info = msg.rate_limit_info ?? {}
  const status = info.status ?? 'allowed'
  const kind = info.rateLimitType ? RATE_LIMIT_TYPE_LABELS[info.rateLimitType] ?? info.rateLimitType : undefined
  const util =
    typeof info.utilization === 'number' && Number.isFinite(info.utilization)
      ? Math.round(info.utilization)
      : undefined
  // `resetsAt` unit isn't documented (experimental API). Epoch seconds is
  // the Anthropic convention for rate-limit resets, but sniffs for ms
  // (≥1e12) too so a unit change degrades to a still-sane clock time
  // instead of year 55000+.
  const resetsMs =
    typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) && info.resetsAt > 0
      ? info.resetsAt >= 1e12
        ? info.resetsAt
        : info.resetsAt * 1000
      : undefined
  const resets = resetsMs != null ? formatClockTime(resetsMs) : undefined

  const tone = status === 'rejected' ? 'danger' : status === 'allowed_warning' ? 'warn' : 'ok'
  const mark = status === 'rejected' ? '⛔ rate limited' : status === 'allowed_warning' ? '⚠ near limit' : '✓ within limit'
  const parts: string[] = []
  if (kind) parts.push(kind)
  if (util !== undefined) parts.push(`${util}% used`)
  if (resets) parts.push(status === 'rejected' ? `blocked until ${resets}` : `resets ${resets}`)
  if (info.isUsingOverage || info.overageInUse) parts.push('using extra usage')
  if (info.overageStatus) parts.push(String(info.overageStatus))

  return (
    <div className={`msg result rate-limit-card rate-limit-card--${tone}`} aria-label="rate limit status">
      <span className="result-mark" aria-hidden="true">{mark}</span>
      {parts.length > 0 && <span className="result-meta">{parts.join(' · ')}</span>}
    </div>
  )
}

/** The "continuation" half of a compact event.
 *
 *  After `system/compact_boundary`, the SDK pushes a synthetic user-role
 *  frame whose content is a prose summary of the previous conversation
 *  —it's the next turn's input prompt, but it wasn't type by the
 *  human. Rendering it as a "YOU" bubble is the behaviour this
 *  component exists to prevent: users see a huge wall of AI-authored
 *  text attributed to themselves and rightly get confused.
 *
 *  Collapsed by default (peek + expand) since the body is typically
 *  thousands of chars and the Recap divider above already told the user
 *  everything actionable. */
function CompactSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const charCount = text.length
  // Grab the first "Summary:" headline as a peek if we can — the SDK
  // template usually starts with boilerplate, then a Summary header.
  const peek = text.slice(0, 140).replace(/\s+/g, ' ').trim()
  return (
    <div className="msg compact-summary" role="note" aria-label="Conversation recap (context injected by SDK)">
      <div className="msg-header">
        <span>recap context · {charCount.toLocaleString()} chars</span>
        <button
          type="button"
          className="compact-summary-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>
      <div className="msg-body">
        {expanded ? (
          <Markdown text={text} />
        ) : (
          <div className="compact-summary-peek">{peek}</div>
        )}
      </div>
    </div>
  )
}

const StreamingOverlaySpacer = memo(function StreamingOverlaySpacer({ height }: { height: number }) {
  return <div className="virtuoso-streaming-spacer" style={{ height }} aria-hidden />
})

/** Max subagent chips shown before collapsing into "+N more". */
const MAX_VISIBLE_SUBAGENTS = 5

/** Self-ticking elapsed-time text. Isolating the 1Hz interval here means
 *  only this tiny text node re-renders each second — the parent WorkingBubble
 *  (and its subagent chip row) stay memoized and skip the per-second commit.
 *
 *  `startedAt` is the turn/subagent start timestamp (ms epoch). When absent
 *  (first frame before the server reports it) we fall back to mount time so
 *  the timer still advances. */
const ElapsedTimer = memo(function ElapsedTimer({
  startedAt,
  className,
}: {
  startedAt?: number
  className?: string
}) {
  // eslint-disable-next-line react-hooks/purity -- Date.now() in initializer is intentional
  const startedAtRef = useRef<number>(startedAt ?? Date.now())
  // eslint-disable-next-line react-hooks/refs -- reading ref in state initializer for initial value
  const [elapsedMs, setElapsedMs] = useState(() =>
    Date.now() - startedAtRef.current,
  )
  useEffect(() => {
    // Update the ref if the server provides a (new) timestamp after mount.
    if (startedAt) startedAtRef.current = startedAt
    const tick = () => setElapsedMs(Date.now() - startedAtRef.current)
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [startedAt])

  return (
    <span className={className} aria-label={`elapsed ${formatElapsed(elapsedMs)}`}>
      {formatElapsed(elapsedMs)}
    </span>
  )
})

export const WorkingBubble = memo(function WorkingBubble({
  startedAt,
  activeSubagents,
  tokenRate,
  thinkingTokens,
  activePhase,
  recapping,
  waiting,
  runningTaskCount,
  onOpenTasks,
  onOpenSubagent,
  active: _active,
  onDismissWaiting,
}: {
  startedAt?: number
  activeSubagents?: ActiveSubagent[]
  tokenRate?: number | null
  /** Live thinking-token estimate for the current thinking block
   *  (`system/thinking_tokens` frames — redacted-thinking progress, where
   *  tokenRate stays silent because no text deltas stream). Approximate;
   *  cleared at turn end. */
  thinkingTokens?: number | null
  activePhase?: import('../hooks/useChatStream').ActivePhase
  /** True while the CLI is compacting the transcript mid-turn (SDK
   *  `system/status` `status: 'compacting'`, mirrored from
   *  `session.compacting`). Overrides the phase label with a "Recap (auto)…"
   *  cue — the compaction produces no stream events, so without this the
   *  bubble would sit on a stale phase while the context window is
   *  compressed. */
  recapping?: boolean
  /** True when the parent turn has ended but `pending` background subagents
   *  are still in flight. The bubble stays mounted and shows "Waiting..."
   *  with calmed visuals instead of unmounting — surfacing that background
   *  work is ongoing after the turn. */
  waiting?: boolean
  /** Authoritative running background-task count (non-terminal,
   *  non-skipTranscript) from the session store. When > 0, renders a
   *  clickable count pill that calls `onOpenTasks`. */
  runningTaskCount?: number
  /** Opens the Tasks overlay. Wired by the host (Chat) to open TasksPanel. */
  onOpenTasks?: () => void
  /** When provided, each subagent chip becomes a button that calls this
   *  with the chip's toolUseId — the host (Chat) opens the overlay
   *  pointed at that subagent. */
  onOpenSubagent?: (toolUseId: string) => void
  /** Whether a turn is currently running in this panel. Defaults to true
   *  (callers that only mount the bubble around live work — SideChatDrawer —
   *  never hit the idle state). When false AND not waiting, the bubble is
   *  "idle": the turn ended and only a task-count remnant remains, so it
   *  collapses to a quiet pill with no "Working" label or animated dots. */
  active?: boolean
  /** Renders a dismiss ✕ in the Waiting state. Wired by the host (Chat) so
   *  the user can silence a phantom "Waiting..." banner — e.g. a task record
   *  the server never folded to terminal (the SDK exposes no task-list query
   *  and the server only evicts terminal records). */
  onDismissWaiting?: () => void
}) {
  const hasSubagents = activeSubagents && activeSubagents.length > 0
  const taskCount = runningTaskCount ?? 0
  const active = _active ?? true
  const idle = !active && !waiting

  return (
    <div
      className={`working-bar${hasSubagents ? ' working-bar-with-agents' : ''}${waiting ? ' working-bar-waiting' : ''}${idle ? ' working-bar-idle' : ''}`}
      aria-live="polite"
      aria-label={waiting ? 'Waiting for background tasks' : idle ? 'Background tasks running' : 'Assistant is working'}
    >
      {!idle && (
        <div className="working-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
      )}
      {!idle && (
        <span className="working-bar-label">
          {waiting
            ? 'Waiting...'
            : recapping
            ? 'Recap (auto)...'
            : activePhase === 'thinking'
            ? 'Thinking...'
            : activePhase === 'writing'
            ? 'Writing...'
            : activePhase
            ? `Calling ${activePhase.name}...`
            : 'Working'}
        </span>
      )}
      {/* The turn timer is only meaningful while the turn is active; hide it
          in the Waiting state (the parent turn has ended). Per-subagent chip
          timers below still show how long each background task has run. */}
      {!waiting && !idle && <ElapsedTimer startedAt={startedAt} className="working-timer" />}
      {!waiting && !idle && tokenRate != null && tokenRate > 0 && (
        <span className="working-rate">
          <IconZap size={12} aria-hidden /> {tokenRate} tok/s
        </span>
      )}
      {/* Redacted-thinking progress: no text deltas stream (tokenRate stays
          silent), so the SDK's own token estimate is the only signal. "~"
          marks it as an approximation of the current thinking block. */}
      {!waiting && !idle && thinkingTokens != null && thinkingTokens > 0 && tokenRate == null && (
        <span className="working-rate">
          <IconZap size={12} aria-hidden /> ~{formatTokens(thinkingTokens)} tok
        </span>
      )}
      {/* Background-task count pill — the clickable entry to the Tasks
          overlay. Shows the authoritative running count (not just
          transcript-tracked subagents); visible in both the active and
          Waiting states so a background task outliving its turn stays
          surfaced. */}
      {taskCount > 0 && onOpenTasks && (
        <button
          type="button"
          className="working-tasks"
          onClick={onOpenTasks}
          title={`${taskCount} background task${taskCount === 1 ? '' : 's'} running — click to open Tasks`}
          aria-label={`${taskCount} background task${taskCount === 1 ? '' : 's'} running`}
        >
          <IconListTodo size={12} aria-hidden />
          {taskCount}
        </button>
      )}
      {hasSubagents && (
        <span className="working-bar-sep" aria-hidden />
      )}
      {/* Show at most MAX_VISIBLE_SUBAGENTS chips to avoid overcrowding;
          a "+N more" badge shows the remainder count. Each chip's elapsed
          self-ticks via its own ElapsedTimer, so the bubble itself doesn't
          re-render every second. Pending chips (background subagent
          outliving its parent turn) get a muted visual via the
          subagent-chip-pending class; dismiss is in the overlay, not here. */}
      {activeSubagents?.slice(0, MAX_VISIBLE_SUBAGENTS).map((a) => {
        const clickable = !!onOpenSubagent
        const Tag = clickable ? 'button' : 'span'
        return (
          <Tag
            key={a.toolUseId}
            type={clickable ? 'button' : undefined}
            className={`subagent-chip${clickable ? ' subagent-chip-clickable' : ''}${a.status === 'pending' ? ' subagent-chip-pending' : ''}`}
            title={
              (clickable ? `Open subagent details - ${a.label}` : a.label) +
              (a.progressSummary ? ` — ${a.progressSummary}` : '')
            }
            onClick={clickable ? () => onOpenSubagent(a.toolUseId) : undefined}
          >
            <span className="subagent-chip-dots" aria-hidden>
              <span />
              <span />
            </span>
            <span className="subagent-chip-label">{a.label}</span>
            {a.startedAt != null && (
              <ElapsedTimer startedAt={a.startedAt} className="subagent-chip-timer" />
            )}
            {clickable && <span className="subagent-chip-open" aria-hidden><IconExternalLink size={12} /></span>}
          </Tag>
        )
      })}
      {activeSubagents && activeSubagents.length > MAX_VISIBLE_SUBAGENTS && (
        <span className="subagent-overflow">
          +{activeSubagents.length - MAX_VISIBLE_SUBAGENTS} more
        </span>
      )}
      {/* Dismiss ✕ for the Waiting state. The SDK exposes no task-list query
          and the server only evicts terminal records, so a task record that
          never folds to terminal would otherwise leave the Waiting banner
          mounted forever with no exit. Dismiss collapses the bubble to the
          quiet idle pill (the task count / TasksPanel entry survives) — the
          banner returns when a new waiting episode or turn begins. */}
      {waiting && onDismissWaiting && (
        <button
          type="button"
          className="working-dismiss"
          onClick={onDismissWaiting}
          aria-label="Dismiss waiting state"
          title="Dismiss — hide this banner (tasks stay visible in the Tasks panel)"
        >
          <IconX size={12} aria-hidden />
        </button>
      )}
    </div>
  )
})
