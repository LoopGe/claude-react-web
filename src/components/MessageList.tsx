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
import { SessionCwdProvider } from '../hooks/useSessionCwd'
import type { SdkMessage } from '../types'
import { formatTokens, formatElapsed, formatClockTime, formatFullTimestamp } from '../utils/format'
import { Tooltip } from './Tooltip'
import { useLocalStorage } from '../hooks/useLocalStorage'
import type { ActiveSubagent, PlanStatus, ToolResultEntry, ToolStatus, TranscriptItem } from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'
import { getBlocks, getEnterPlanToolUseIds } from '../session-store/normalize'
import { useSubagentContext } from '../hooks/useSubagentContext'
import { useWorkflowContext } from '../hooks/useWorkflowContext'
import { IconArrowDown, IconZap, IconUser, IconExternalLink, IconSquare } from './icons/ToolIcons'
import { countMatches, extractPlainText, extractMessagePlainText } from '../search'
import { BlockView, ToolResultBlock } from './message-list/blocks'
import { OlderHistoryHeader, StreamingFooter } from './message-list/transcript-chrome'
import { Skeleton } from './Skeleton'
import { ChatEmptyState } from './ChatEmptyState'
import { EasterEggGame } from './EasterEggGame'
import { AnsiText } from './AnsiText'
import { ResultConsumedCtx, useResultConsumed } from './message-list/result-consumed-context'
import { extractUserText, makeResultConsumed, willRenderEmpty } from './message-list/rendering'

/** Re-export type for backward compatibility (types don't affect Fast Refresh). */
export type { ActiveSubagent } from '../session-store/types'

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
   *  When false, shows a loading skeleton instead of the empty-state
   *  message, preventing a flash of "no messages" on session switch. */
  replayReady?: boolean
  /** Stable key for the owning transcript (session id in the main chat).
   *  When provided, a ready transcript gets one subtle reveal on mount/load. */
  transcriptRevealKey?: string
  /** Accumulated text from streaming deltas. When non-null, a live
   *  "typing" bubble is rendered at the bottom of the transcript. */
  streamingContent?: string | null
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
   *  user message"). The callback identity is stable for the component's
   *  lifetime, so the parent can register it once. */
  onRegisterNavigate?: (fn: (dir: 'prev' | 'next') => void) => void
  /** Override the empty-state content shown when there are no messages and
   *  replay is ready. Defaults to a generic "Type a message below to start
   *  the conversation." prompt. Side Chat overrides this to communicate the
   *  ephemeral nature of the drawer. */
  emptyStateContent?: ReactNode
  /** Called when the user clicks "Switch model" on a model_not_found error
   *  message. The parent opens its model picker / settings so the user can
   *  pick a valid model without leaving the transcript. */
  onSwitchModel?: () => void
  /** Called when the visible range of messages changes. Reports the
   *  top-most visible item index (in data-array space). Used by the
   *  search system to find the nearest match to the viewport. */
  onVisibleRangeChange?: (topIdx: number) => void
  /** Force-stop the current in-flight `!`/`!!` command. Wired to the "stop"
   *  button on a pending bash card. Undefined when no abort surface is
   *  available (e.g. Side Chat drawer renders its own MessageList without it). */
  onAbortBash?: () => void
  /** Owning session's cwd. Provided to nested tool cards via SessionCwd
   *  context so EditToolView can resolve real file line numbers via
   *  /api/edit-locate. Undefined when no cwd is in scope. */
  cwd?: string
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

export const MessageList = memo(function MessageList({ items, working, clearing, replayReady = true, transcriptRevealKey, streamingContent, planStatus = EMPTY_PLAN_STATUS, planContent = EMPTY_PLAN_CONTENT, questionAnswers = EMPTY_QUESTION_ANSWERS, toolStatus = EMPTY_TOOL_STATUS, toolResults = EMPTY_TOOL_RESULTS, searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, parentToolUseIdFilter, loadOlder, hasOlder = false, loadingOlder = false, onRegisterNavigate, emptyStateContent, onSwitchModel, onAbortBash, onVisibleRangeChange, cwd }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // Captures Virtuoso's underlying scroll element so a ResizeObserver
  // can detect viewport shrink (TodoChecklist panel growing).
  const scrollerRef = useRef<HTMLElement | null>(null)
  const streamingRegionRef = useRef<HTMLDivElement | null>(null)
  // --- /clear veil ----------------------------------------------------
  // The panel-level `.panel-clearing-veil` (rendered by PanelSlot above
  // this component) now owns the overlay + fade-out. MessageList just
  // applies `.chat-messages-clearing` (see messagesClassName below) so
  // content stays blurred/dimmed under the veil while `clearing` is true.
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
  // follow-disable debounce —see the scroll-listener effect for why.
  const lastScrollTopRef = useRef(0)
  // Latches true the first time the user issues an intentional scroll
  // (any upward scroll, or any scroll that lands away from bottom).
  // The post-mount bottom-anchor catch-up effect stops snapping once
  // this is true so we never fight a legitimate user scroll.
  const userInitiatedScrollRef = useRef(false)
  // One-shot guard set by `jumpToBottom` and consumed by the scroll handler
  // on its very next event. The instant scrollTo in jumpToBottom fires an
  // asynchronous native 'scroll' event; if streaming growth moves the real
  // bottom past the captured scrollTop before that event fires, the handler's
  // 'preserve' geometry sync would otherwise see geometry.atBottom=false,
  // downgrade atBottomRef back to false, and re-show the jump button —
  // disarming the streaming ResizeObserver re-pin path the jump just armed.
  // Consuming the guard makes the optimistic atBottomRef=true survive that
  // single event. No timer safety-clear: rAF/setTimeout can fire before the
  // queued scroll-event task and prematurely clear the guard; consume-on-event
  // is reliable, and the no-event case (scrollTo no-op) is unreachable while
  // the jump button is visible (only shown when not at bottom → scrollTo
  // always moves → an event always fires).
  const jumpScrollRef = useRef(false)
  const [followDebounceRaw] = useLocalStorage<number>(
    'claude-react-web:follow-debounce-ms',
    150,
  )
  const FOLLOW_DEBOUNCE_MS = Math.max(50, Math.min(500, Math.round(followDebounceRaw)))
  /** How many new messages have arrived since the user last saw the
   *  bottom. Badge number on the jump-to-bottom button. */
  const [unseenCount, setUnseenCount] = useState(0)
  const unseenCountRef = useRef(0)

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
      clearFollowTimer()
      shouldFollowRef.current = false
      return
    }

    if (followMode === 'disable-debounced' && followTimerRef.current == null) {
      followTimerRef.current = setTimeout(() => {
        followTimerRef.current = null
        const el = scrollerRef.current
        if (!el) {
          setCanJumpToBottom(false)
          setBottomState(false)
          shouldFollowRef.current = false
          return
        }

        const geometry = getBottomGeometry(el)
        setCanJumpToBottom(geometry.canJumpToBottom)
        setBottomState(geometry.atBottom)
        if (geometry.atBottom) {
          clearUnseen()
          shouldFollowRef.current = true
        } else {
          shouldFollowRef.current = false
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
    const geometry = getBottomGeometry(el)
    const delayAway = modeWhenAway === 'confirm-away' && !geometry.atBottom && atBottomRef.current
    setCanJumpToBottom(delayAway ? false : geometry.canJumpToBottom)
    syncBottomState(
      geometry.atBottom,
      geometry.atBottom ? 'restore' : modeWhenAway === 'confirm-away' ? 'disable-debounced' : modeWhenAway,
    )
    return geometry
  }, [syncBottomState])

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
        if (record.result) set.add(id)
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
  }, [items, parentToolUseIdFilter, isResultConsumed])

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
    const armed = replayReady && delta > 0 && delta <= MAX_ENTER_BATCH
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

  // Consume an entrance flag exactly once: clear it from the set when the
  // animation ends and strip the class off the DOM node directly, so a
  // scroll-driven re-mount of the same row can't replay it.
  const handleEnterAnimationEnd = useCallback((e: React.AnimationEvent<HTMLDivElement>) => {
    const id = e.currentTarget.dataset.enterId
    if (id) enterIdsRef.current.delete(id)
    e.currentTarget.classList.remove('msg-enter')
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
    if (!loadOlder || !hasOlder || loadingOlder) return
    void loadOlder()
  }, [loadOlder, hasOlder, loadingOlder])

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
  useEffect(() => {
    const delta = trackedCount - lastCountRef.current
    lastCountRef.current = trackedCount
    if (delta <= 0) return
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

  // Post-mount bottom-anchor catch-up. Virtuoso aligns the last item to the
  // viewport bottom using ESTIMATED row heights (initialTopMostItemIndex +
  // alignToBottom). When real heights settle and exceed the estimates —
  // common for tool cards, subagent cards, and code blocks — scrollHeight
  // grows downward but scrollTop stays put. The gap that opens isn't a user
  // scroll-away; it's a measurement artifact. But Virtuoso reports it as
  // atBottomStateChange(false), the debounced disable path flips atBottom
  // to false 150ms later, and nothing ever re-anchors because no new items
  // arrive (e.g. a completed subagent's transcript inside SubagentOverlay).
  //
  // Fix: for a short window after mount, observe row-size mutations inside
  // the scroller's content. While the user hasn't scrolled yet (tracked via
  // userInitiatedScrollRef in the scroll handler), keep snapping scrollTop
  // to scrollHeight on each measurement step. Once the user scrolls
  // intentionally, we stop and never interfere again for this MessageList
  // lifetime.
  //
  // The effect re-runs as scrollerRef is assigned by scrollerRefCb because
  // scrollerRefCb is in the deps of the wrapping effect — we instead poll
  // briefly on first mount until the scroller exists, then attach the
  // observer. Simpler than threading a state setter through scrollerRefCb.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    if (userInitiatedScrollRef.current) return

    let cancelled = false
    let mo: MutationObserver | null = null
    let stopTimer: ReturnType<typeof setTimeout> | null = null
    let attachAttempts = 0
    let lastScrollHeight = 0

    const snapIfGrew = () => {
      if (cancelled || userInitiatedScrollRef.current) return
      const el = scrollerRef.current
      if (!el) return
      const sh = el.scrollHeight
      if (sh > lastScrollHeight) {
        lastScrollHeight = sh
        // Direct assignment (not scrollTo) so we don't queue a smooth
        // animation that the next mutation could interrupt. Virtuoso's
        // atBottomStateChange will re-fire on this scrollTop change and
        // the geometry-based atBottom path restores cleanly.
        el.scrollTop = el.scrollHeight
      }
    }

    const attach = () => {
      if (cancelled) return
      const el = scrollerRef.current
      if (!el) {
        // Virtuoso hasn't called scrollerRefCb yet. Retry next frame, but
        // give up after a few attempts to avoid leaking on never-mount.
        if (attachAttempts++ < 30) requestAnimationFrame(attach)
        return
      }
      lastScrollHeight = el.scrollHeight
      // One immediate snap in case rows mounted between scroller-ready and
      // this attach (e.g. synchronous initial layout pass).
      snapIfGrew()
      mo = new MutationObserver(snapIfGrew)
      // childList catches items mounting; attributes (style) catches
      // Virtuoso's row-height updates after measurement.
      mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
      // Safety: stop the catch-up after 2s no matter what. By then either
      // measurements have settled or the user has interacted; continuing
      // to snap would risk fighting legitimate user intent.
      stopTimer = setTimeout(() => {
        cancelled = true
        mo?.disconnect()
        mo = null
      }, 2000)
    }

    attach()

    return () => {
      cancelled = true
      if (stopTimer != null) clearTimeout(stopTimer)
      mo?.disconnect()
    }
  }, [])

  useEffect(() => {
    const el = streamingRegionRef.current
    if (!el) {
      setStreamingOverlayHeight(0)
      return
    }

    const updateHeight = () => {
      const height = Math.ceil(el.getBoundingClientRect().height)
      setStreamingOverlayHeight((prev) => (prev === height ? prev : height))
      if (atBottomRef.current) scrollScrollerToBottom('auto')
    }

    updateHeight()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(updateHeight)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasVisibleStreamingContent, scrollScrollerToBottom])

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
      // The jump's instant scrollTo fires one async 'scroll' event. Consume
      // the guard and skip the geometry sync for that single event so the
      // optimistic atBottomRef=true from jumpToBottom survives a same-frame
      // streaming growth spurt (which would otherwise make geometry.atBottom
      // briefly false and downgrade the re-pin path the jump just armed).
      // The jump is a downward programmatic scroll, so skipping also correctly
      // bypasses the user-intent latch (which only fires on upward scrolls).
      if (jumpScrollRef.current) {
        jumpScrollRef.current = false
        return
      }
      const isScrollingUp = el.scrollTop < prevScrollTop
      // Latch the user-intent flag: any upward scroll is unambiguously the
      // user driving (programmatic snap-to-bottom only ever increases
      // scrollTop). Once latched, the post-mount catch-up effect stops.
      if (isScrollingUp) userInitiatedScrollRef.current = true
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

  const jumpToBottom = useCallback(() => {
    // Jump-to-bottom is a "catch me up" action, not a cinematic pan. Two
    // reasons it must NOT use `behavior: 'smooth'`:
    //
    // 1. Stale target. `el.scrollTo({ top: el.scrollHeight, smooth })`
    //    captures `scrollHeight` at click time and animates toward that
    //    pixel over hundreds of ms. While the animation runs, any content
    //    growth (streaming text mirroring into the spacer Footer, Virtuoso
    //    row-height measurement settling, lazy images/code blocks) moves
    //    the real bottom past the captured target. The animation then
    //    lands short — and nothing corrects it, because atBottomRef is
    //    still false at that instant, so the streaming ResizeObserver's
    //    `if (atBottomRef.current) scrollScrollerToBottom('auto')` re-pin
    //    guard skips. That was the "sometimes doesn't scroll to bottom"
    //    bug: it failed exactly when content grew during the animation
    //    window, i.e. during active streaming.
    //
    // 2. Follow gap. The user had scrolled up (shouldFollowRef=false,
    //    latched). The old jump never re-enabled follow, so even when the
    //    smooth scroll happened to land, a new message arriving before
    //    atBottomStateChange(true) restored follow left the viewport a
    //    hair above the new bottom.
    //
    // Fix: instant scroll (no animation window → no stale target) plus
    // optimistic follow re-enable. Setting atBottomRef=true arms the
    // existing streaming ResizeObserver re-pin path for subsequent growth;
    // shouldFollowRef=true lets Virtuoso's followOutput track new appends.
    // clearFollowTimer cancels any pending disable-debounced timer from
    // the prior scroll-up so it can't flip follow back off mid-jump.
    shouldFollowRef.current = true
    setBottomState(true)
    setCanJumpToBottom(false)
    clearFollowTimer()
    // Arm the one-shot guard so the async 'scroll' event from the instant
    // scrollTo below doesn't downgrade the optimistic atBottomRef=true via
    // the scroll handler's 'preserve' geometry sync (see jumpScrollRef). The
    // guard is consumed on the handler's very next event.
    jumpScrollRef.current = true
    scrollScrollerToBottom('auto')
    clearUnseen()
  }, [clearFollowTimer, clearUnseen, scrollScrollerToBottom, setBottomState])

  // --- Scroll to previous / next user message ----------------------------
  // Data-array (0-based, Virtuoso `scrollToIndex` space) indices of every
  // *real* user message — the same discriminator MessageView uses to pick
  // the "msg user" bubble branch: a root frame (no parent_tool_use_id), not
  // a compact-summary, carrying no tool_result block. Recomputed only when
  // the rendered list changes.
  const userMsgIndices = useMemo(() => {
    const out: number[] = []
    for (let i = 0; i < renderableItems.length; i++) {
      const it = renderableItems[i]
      const msg = it.msg
      if (msg.type !== 'user') continue
      if (it.isCompactSummary) continue
      if (msg.parent_tool_use_id != null) continue
      const hasToolResult = getBlocks(msg).some((b) => b.type === 'tool_result')
      if (hasToolResult) continue
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

  // Top-most visible data index, tracked from Virtuoso's `rangeChanged`.
  // rangeChanged reports indices in OFFSET space (dataIndex + firstItemIndex),
  // so we subtract firstItemIndex to get back to the `scrollToIndex` space.
  // Kept in a ref (read by the navigate callback, never rendered).
  const topVisibleIdxRef = useRef(0)
  const firstItemIndexValRef = useRef(firstItemIndex)
  useEffect(() => {
    firstItemIndexValRef.current = firstItemIndex
  }, [firstItemIndex])
  const handleRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
    const idx = range.startIndex - firstItemIndexValRef.current
    topVisibleIdxRef.current = idx
    onVisibleRangeChange?.(idx)
  }, [onVisibleRangeChange])

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
    // Disable follow so the programmatic scroll doesn't fight auto-follow
    // (mirrors the search-result scroll path).
    shouldFollowRef.current = false
    virtuosoRef.current?.scrollToIndex({ index: target, behavior: 'smooth', align: 'start' })
  }, [])

  // Expose the navigator to the parent (Chat —App — session context menu).
  useEffect(() => {
    onRegisterNavigate?.(navigate)
  }, [onRegisterNavigate, navigate])

  const scrollerRefCb = useCallback((ref: HTMLElement | Window | null) => {
    const prev = scrollerRef.current
    if (prev && prev !== ref) prev.classList.remove('chat-virtuoso-scroller')
    if (ref && ref instanceof HTMLElement) {
      ref.classList.add('chat-virtuoso-scroller')
      scrollerRef.current = ref
      syncBottomGeometry(ref, 'confirm-away')
      return
    }
    scrollerRef.current = null
    syncBottomGeometry(null)
  }, [syncBottomGeometry])

  // New settled message arrives → Virtuoso calls followOutput → we return
  // 'auto' (instant), NOT 'smooth'. A smooth follow creates a ~300ms
  // animation window during which the viewport is momentarily not at
  // bottom. The scroll handler effect re-attaches on every
  // renderableItems.length change and calls syncBottomGeometry(el,
  // 'confirm-away'); during that window it sees dist>0, arms the 150ms
  // follow-disable debounce, and that debounce fires mid-follow — flipping
  // shouldFollow=false AND atBottomRef=false. That disables both this
  // followOutput (for the NEXT append) and the streaming ResizeObserver
  // instant re-pin, so the view stays/lags short of the new message's
  // bottom. Instant follow closes the window: dist returns to 0 in the same
  // frame, confirm-away restores instead of arming, and both backstops stay
  // armed. (The live typing bubble is pinned separately by the streaming
  // ResizeObserver, so this only affects settled-message appends — the
  // standard chat-UI snap-to-new-message.)
  const followOutput = useCallback(() => (shouldFollowRef.current ? 'auto' : false), [])

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
    // armed in the gate block above. Consume it HERE — delete from the ref
    // the moment we read it — so the class is applied to exactly one render
    // of this row. Relying solely on `animationend` to clear the flag (the
    // old approach) leaked: if Virtuoso unmounted the item before the
    // animation finished (user scrolled it out of the viewport), the event
    // never fired, the id stayed in the ref, and scrolling back remounted
    // the row with `msg-enter` still set — replaying the blur+rise entrance
    // every time the row re-entered the viewport. Deleting on first render
    // guarantees a re-mount renders without the class regardless of whether
    // `animationend` ever ran. `onAnimationEnd` below is kept only to strip
    // the DOM class promptly (a no-op on the ref after this point).
    const isEntering = enterIdsRef.current.delete(item.id) || enterIdsRef.current.has(item.id)
    if (isEntering) enterIdsRef.current.delete(item.id)
    const className = [
      'virtuoso-item-wrapper',
      item.id === firstItemId ? 'transcript-first-item' : '',
      item.id === lastItemId ? 'transcript-last-item' : '',
      isEntering ? 'msg-enter' : '',
    ].filter(Boolean).join(' ')
    return (
      <div
        className={className}
        data-enter-id={isEntering ? item.id : undefined}
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
  }, [searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, handleEnterAnimationEnd, working, firstItemId, lastItemId, nextItemTypeMap, onSwitchModel, onAbortBash])

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
    const showOlderHeader = loadOlder != null && (loadingOlder || hasOlder)
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
  }, [streamingOverlayHeight, loadOlder, loadingOlder, hasOlder])

  return (
    <SessionCwdProvider value={cwd}>
    <PlanStatusProvider value={planStatus}>
    <PlanContentProvider value={planContent}>
    <QuestionAnswersProvider value={questionAnswers}>
    <ToolStatusProvider value={toolStatus}>
    <ToolResultProvider value={toolResults}>
    <ResultConsumedCtx.Provider value={isResultConsumed}>
    <div className="chat-messages-wrap">
      <div className="chat-messages-stage">
      <div ref={messagesElRef} key={transcriptRevealKey} className={messagesClassName} onAnimationEnd={handleTranscriptRevealEnd}>
        {renderableItems.length === 0 ? (
          <div className="chat-messages-empty">
            {replayReady
              ? (emptyStateContent ?? (gameOpen
                  ? <EasterEggGame onExit={closeEasterEgg} />
                  : <ChatEmptyState onUnlockEasterEgg={openEasterEgg} />))
              : <Skeleton rows={3} className="chat-messages-skeleton" />}
          </div>
        ) : (
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
        )}
      </div>
      {canJumpToBottom && !atBottom && (
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
    </ToolResultProvider>
    </ToolStatusProvider>
    </QuestionAnswersProvider>
    </PlanContentProvider>
    </PlanStatusProvider>
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

  // Active-match plumbing for multi-text-block assistant messages.
  // Each text block runs its OWN rehype highlighter, so we have to
  // rebase the message-local match index into per-block coordinates:
  // figure out how many matches each text block contributes and pass
  // the correct sub-index to the one containing the active hit. Other
  // blocks get `undefined` so their <mark>s render at the default
  // colour. We compute per-block counts on the same `extractPlainText`
  // view the highlighter uses, so the sums line up with what the
  // user can actually navigate to.
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
      if (b.type !== 'text' || typeof b.text !== 'string') continue
      const n = countMatches(extractPlainText(b.text), q)
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
          {userContent && <Markdown text={userContent} searchQuery={searchQuery} activeMatchIdx={activeMatchInItem} />}
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
    const isRateLimit = /429|rate.?limit/i.test(raw)
    const message = isRateLimit
      ? 'too many requests — message saved, send again'
      : raw
    return (
      <div className="msg result error" title={message} aria-label={isRateLimit ? 'rate limit error' : 'system error'}>
        <span className="result-mark" aria-hidden="true">{isRateLimit ? '✕ rate limited' : '✕ error'}</span>
        <span className="result-meta">{message}</span>
      </div>
    )
  }

  if (type === 'system' && msg.subtype === 'compact_boundary') {
    return <CompactBoundary msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'api_retry') {
    return <ApiRetryView msg={msg} />
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
 *  reducer replaces consecutive `api_retry` frames in place
 *  (`reducer.ts:298-300`) so this component gets new props rather than
 *  remounting. Reading deadline-now is monotonic across that prop
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
  // replaces consecutive api_retry frames in place —see
  // `reducer.ts:298-300`), there's a single render between prop change
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
      <span className="result-mark" aria-hidden="true">⏳ {label}</span>
      <span className="result-meta">{phase} · {attemptText}</span>
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
  activePhase,
  onOpenSubagent,
}: {
  startedAt?: number
  activeSubagents?: ActiveSubagent[]
  tokenRate?: number | null
  activePhase?: import('../hooks/useChatStream').ActivePhase
  /** When provided, each subagent chip becomes a button that calls this
   *  with the chip's toolUseId — the host (Chat) opens the overlay
   *  pointed at that subagent. */
  onOpenSubagent?: (toolUseId: string) => void
}) {
  const hasSubagents = activeSubagents && activeSubagents.length > 0

  return (
    <div
      className={`working-bar${hasSubagents ? ' working-bar-with-agents' : ''}`}
      aria-live="polite"
      aria-label="Assistant is working"
    >
      <div className="working-dots" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <span className="working-bar-label">
        {activePhase === 'thinking'
          ? 'Thinking...'
          : activePhase === 'writing'
          ? 'Writing...'
          : activePhase
          ? `Calling ${activePhase.name}...`
          : 'Working'}
      </span>
      <ElapsedTimer startedAt={startedAt} className="working-timer" />
      {tokenRate != null && tokenRate > 0 && (
        <span className="working-rate">
          <IconZap size={12} aria-hidden /> {tokenRate} tok/s
        </span>
      )}
      {hasSubagents && (
        <span className="working-bar-sep" aria-hidden />
      )}
      {/* Show at most MAX_VISIBLE_SUBAGENTS chips to avoid overcrowding;
          a "+N more" badge shows the remainder count. Each chip's elapsed
          self-ticks via its own ElapsedTimer, so the bubble itself doesn't
          re-render every second. */}
      {activeSubagents?.slice(0, MAX_VISIBLE_SUBAGENTS).map((a) => {
        const clickable = !!onOpenSubagent
        const Tag = clickable ? 'button' : 'span'
        return (
          <Tag
            key={a.toolUseId}
            type={clickable ? 'button' : undefined}
            className={`subagent-chip${clickable ? ' subagent-chip-clickable' : ''}`}
            title={clickable ? `Open subagent details - ${a.label}` : a.label}
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
    </div>
  )
})
