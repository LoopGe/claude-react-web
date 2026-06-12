// Virtualised message transcript for one session.
//
// Uses react-virtuoso to render only the visible slice of messages,
// keeping DOM node count bounded regardless of transcript length.
// Keeps the list pinned to the bottom unless the user scrolls up 闂?once
// they do, new messages append silently instead of yanking the viewport.
// Filters out `stream_event` partials (the final assistant message
// carries the complete content, so showing both just flickers).

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Markdown } from './Markdown'
import { PlanStatusProvider, PlanContentProvider, ToolStatusProvider, ToolResultProvider } from '../hooks/usePlanStatus'
import { QuestionAnswersProvider } from '../hooks/useQuestionAnswers'
import type { SdkMessage } from '../types'
import type { SessionRecap } from '../../shared/session-info'
import { formatTokens, formatElapsed, formatClockTime, formatFullTimestamp } from '../utils/format'
import { Tooltip } from './Tooltip'
import { useLocalStorage } from '../hooks/useLocalStorage'
import type { ActiveSubagent, PlanStatus, ToolResultEntry, ToolStatus, TranscriptItem } from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'
import { getBlocks, getEnterPlanToolUseIds } from '../session-store/normalize'
import { useSubagentContext } from '../hooks/useSubagentContext'
import { IconArrowDown, IconZap, IconSparkles, IconAlertTriangle, IconMessageCircle, IconDollar, IconClock, IconWrench, IconUser, IconExternalLink } from './icons/ToolIcons'
import { countMatches, extractPlainText } from '../search'
import { BlockView, ToolResultBlock } from './message-list/blocks'
import { OlderHistoryHeader, StreamingFooter } from './message-list/transcript-chrome'
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
  /** Server-pushed AI session recap. Lives on session.recap (NOT in the
   *  history). When present, rendered as a card pinned to the bottom of
   *  the transcript (after items, before the streaming footer) so it
   *  reads as the latest "narrator" entry. Three states drive the chrome:
   *  pending 闂?loading skeleton, ready 闂?summary + stats, error 闂?retry
   *  hint. Undefined means "no recap to show". */
  recap?: SessionRecap
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
  /** Local match index inside the active item 闂?i.e. for the message
   *  pointed at by `searchActiveMsgIdx`, this names which of its
   *  matches is the user's current navigation target. Lets the
   *  renderer style ONE specific `<mark>` differently (warn-coloured
   *  background) instead of just "the whole message". -1 / undefined
   *  means "no active match in this item" (or the active hit lives in
   *  a different item). */
  searchActiveMatchInItem?: number
  /** Filter mode for parent_tool_use_id:
   *  - undefined / null: only show root messages (parent_tool_use_id == null).
   *    This is the default for the main transcript 闂?subagent-internal
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
}

/** An item in the Virtuoso data array. Pre-computing isCompactSummary
 *  here avoids the renderable[i-1] look-back during itemContent.
 *  `itemIndex` maps back to the original items[] position for search
 *  result scrolling (search indices reference the full, unfiltered list). */
interface RenderableItem {
  /** Stable per-message id (SdkMessage uuid, or a synthetic fallback).
   *  Drives the new-message entrance-animation gate 闂?see knownIdsRef. */
  id: string
  msg: SdkMessage
  isCompactSummary: boolean
  itemIndex: number
  /** Optimistic placeholder still in flight 闂?drives the user bubble's
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

/** Distance from the bottom (px) within which we treat the user as
 *  "still at the bottom" for follow-mode and the jump-to-bottom button.
 *  Virtuoso's own atBottomStateChange uses pixel-perfect detection,
 *  which is too strict 闂?a single line of streaming output can flip
 *  it false while the user clearly hasn't scrolled away. We override
 *  Virtuoso's verdict with this tolerance both in `atBottomStateChange`
 *  (so its `false` doesn't kill follow-mode) and in the scroll handler
 *  (so re-entering the band restores follow-mode). */
const NEAR_BOTTOM_PX = 200

/** Entrance-animation gate tunables (see the gate block in MessageList).
 *  MAX_ENTER_BATCH 闂?only animate when the tail grows by at most this many
 *    ids at once; a larger jump means a bulk load (replay / page), not a
 *    live trickle.
 *  ENTER_MAX_AGE_MS 闂?a tail id only animates if its receivedAt is within
 *    this window of now; filters disk-restored history whose timestamps are
 *    stale even if it somehow reaches the tail path.
 *  KNOWN_IDS_CAP 闂?hard bound on the seen-id set for very long sessions. */
const MAX_ENTER_BATCH = 4
const ENTER_MAX_AGE_MS = 10_000
const KNOWN_IDS_CAP = 4000
const STREAMING_EXIT_MS = 180

export const MessageList = memo(function MessageList({ items, recap, working, replayReady = true, transcriptRevealKey, streamingContent, planStatus = EMPTY_PLAN_STATUS, planContent = EMPTY_PLAN_CONTENT, questionAnswers = EMPTY_QUESTION_ANSWERS, toolStatus = EMPTY_TOOL_STATUS, toolResults = EMPTY_TOOL_RESULTS, searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, parentToolUseIdFilter, loadOlder, hasOlder = false, loadingOlder = false, onRegisterNavigate }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // Captures Virtuoso's underlying scroll element so a ResizeObserver
  // can detect viewport shrink (TodoChecklist panel growing).
  const scrollerRef = useRef<HTMLElement | null>(null)
  // `atBottom` is state (not a ref) because the jump-to-bottom button's
  // visibility needs to re-render when it changes. The ref-mirror keeps
  // callbacks readable without a stale-closure dance.
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  // Debounced "should follow" ref 闂?filters out transient isAtBottom=false
  // spikes that Virtuoso emits during rapid/batch item additions (the
  // scroll-to-bottom animation hasn't settled yet, so Virtuoso's internal
  // isAtBottom momentarily flips false). Only after isAtBottom stays false
  // for FOLLOW_DEBOUNCE_MS do we actually stop following.
  const shouldFollowRef = useRef(true)
  const followTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks the previous scrollTop so the scroll handler can detect
  // *user-driven* upward scrolls (scrollTop decreasing) and bypass the
  // follow-disable debounce 闂?see the scroll-listener effect for why.
  const lastScrollTopRef = useRef(0)
  const [followDebounceRaw] = useLocalStorage<number>(
    'claude-react-web:follow-debounce-ms',
    150,
  )
  const FOLLOW_DEBOUNCE_MS = Math.max(50, Math.min(500, Math.round(followDebounceRaw)))
  /** How many new messages have arrived since the user last saw the
   *  bottom. Badge number on the jump-to-bottom button. */
  const [unseenCount, setUnseenCount] = useState(0)
  const unseenCountRef = useRef(0)
  const liveStreamingContent = streamingContent ?? null
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
  const enterPlanIds = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) {
      for (const id of getEnterPlanToolUseIds(it.msg)) set.add(id)
    }
    return set
  }, [items])

  // Subagent (Agent/Task/Explore) results are merged inline into SubagentCard
  // once captured (record.result set). Fold those ids into the predicate so
  // their standalone orphan bubble is suppressed 闂?same merge treatment as a
  // generic tool card. Only ids whose result has actually landed count; a
  // still-running subagent has no result bubble to suppress yet.
  const subagentCtx = useSubagentContext()
  const subagentResultIds = useMemo(() => {
    const set = new Set<string>()
    if (subagentCtx) {
      for (const [id, record] of subagentCtx.index) {
        if (record.result) set.add(id)
      }
    }
    return set
  }, [subagentCtx])

  const isResultConsumed = useMemo(
    () => makeResultConsumed(toolResults, planStatus, questionAnswers, enterPlanIds, subagentResultIds),
    [toolResults, planStatus, questionAnswers, enterPlanIds, subagentResultIds],
  )

  const renderableItems: RenderableItem[] = useMemo(() => {
    const out: RenderableItem[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const parent = item.msg.parent_tool_use_id
      // Filter by parent_tool_use_id:
      //  - main transcript (filter == null): show only root messages
      //    闂?subagent children are surfaced via SubagentCard placeholders
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
          itemIndex: i,
          sending: item.sending,
          deliveryStatus: item.deliveryStatus,
          receivedAt: item.receivedAt,
        })
      }
    }
    return out
  }, [items, parentToolUseIdFilter, isResultConsumed])

  // --- Reverse infinite scroll: keep the viewport anchored on prepend ----
  // Virtuoso requires `firstItemIndex` to decrease by exactly the number of
  // items prepended, in the SAME render that grows `data` at the front 闂?  // otherwise the viewport jumps. We detect a front-prepend by checking
  // whether the previous first renderable message moved to a later index.
  //
  // Computed during render (refs, not state) so `firstItemIndex` and `data`
  // commit together. The `msg === prev` short-circuit makes this a no-op on
  // ordinary appends/streaming; the findIndex only runs on the rare prepend
  // or full-rebuild render. If a discarded concurrent render mutates the
  // ref, the next real render self-corrects (prev still matches) 闂?worst
  // case a single missed adjustment, never compounding drift.
  const INITIAL_FIRST_ITEM_INDEX = 1_000_000
  const firstItemIndexRef = useRef(INITIAL_FIRST_ITEM_INDEX)
  const prevFirstMsgRef = useRef<SdkMessage | null>(null)
  const first = renderableItems.length > 0 ? renderableItems[0].msg : null
  // Reading and mutating these refs DURING render is deliberate and required:
  // Virtuoso needs `firstItemIndex` to commit in the SAME render that grows
  // `data` at the front, which a post-render effect can't guarantee (the
  // viewport would jump for one frame). The mutation is idempotent w.r.t. the
  // current render and self-corrects on the next one (see the block comment
  // above), so it's safe despite the rule. Disabled narrowly for this block.
  /* eslint-disable react-hooks/refs */
  if (first == null) {
    // Empty list (session switch / cleared) 闂?reset the anchor.
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
      // Previous first item is gone (replay rebuild / reset) 闂?re-anchor.
      firstItemIndexRef.current = INITIAL_FIRST_ITEM_INDEX
    }
    prevFirstMsgRef.current = first
  }
  const firstItemIndex = firstItemIndexRef.current
  /* eslint-enable react-hooks/refs */

  // --- New-message entrance animation gate -------------------------------
  // Goal: play a one-shot "rise + blur-in" on messages that genuinely just
  // ARRIVED live 闂?never on the initial replay, session switches, loadOlder
  // history prepends, the optimistic闂佹剚鍋呮慨鈧琧ho user-message swap, or Virtuoso
  // re-mounting an off-screen row as the user scrolls.
  //
  // The discriminator is "a small batch of previously-unseen ids appended at
  // the TAIL of a non-empty list, each stamped with a recent wall-clock
  // receivedAt". That single rule excludes every non-arrival case:
  //   - initial replay / session switch 闂?grows from empty (prevLen 0) or
  //     adds many ids at once 闂?skipped by the prevLen>0 + batch-size guards.
  //   - loadOlder prepend 闂?ids appear at the FRONT, not at indices >=
  //     prevLen 闂?not tail-appends 闂?skipped.
  //   - optimistic闂佹剚鍋呮慨鈧琧ho swap 闂?in-place replace at an existing index, list
  //     length unchanged 闂?no index >= prevLen 闂?skipped (the optimistic
  //     insert already animated the pop).
  //   - scroll re-mount 闂?id already in knownIdsRef and already consumed from
  //     enterIdsRef 闂?skipped.
  // receivedAt recency disambiguates a freshly-typed first message (animate)
  // from a replayed single-message session (history timestamp is stale).
  const knownIdsRef = useRef<Set<string>>(new Set())
  const enterIdsRef = useRef<Set<string>>(new Set())
  const prevLenRef = useRef(0)
  // Tracks the id of the last renderable item so the gate can detect an
  // in-place echo replacement (optimistic id 闂?server uuid at the same
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
    // trickle in 1闂? at a time; bulk loads add many at once).
    //
    // prevLen may be 0 for the very first message in a session 闂?that case
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
    // Always record every current id so a later in-place swap / re-mount of
    // the same message is recognised as already-seen and never re-animates.
    for (const it of renderableItems) knownIdsRef.current.add(it.id)
    // Bound the set so a multi-thousand-message session doesn't leak ids.
    if (knownIdsRef.current.size > KNOWN_IDS_CAP) {
      const live = new Set(renderableItems.map((it) => it.id))
      for (const id of enterIdsRef.current) live.add(id)
      knownIdsRef.current = live
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

  // Reverse map: full items[] index 闂?Virtuoso (renderableItems) index.
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
  // *not* `hiddenByDefault` 闂?system messages are filtered by default,
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
      if (unseenCountRef.current !== 0) {
        unseenCountRef.current = 0
        setUnseenCount(0)
      }
    } else {
      // Keep the ref in lockstep with state 闂?the scroll-near-bottom
      // handler reads `unseenCountRef.current` to decide whether to
      // clear. Updating only state would leave the ref at 0 and the
      // handler would silently no-op, leaving the badge stuck.
      unseenCountRef.current += delta
      setUnseenCount(unseenCountRef.current)
    }
  }, [trackedCount])

  // Viewport-shrink trigger: the TodoChecklist panel appears/grows below
  // the scroll container, which eats vertical space. Without this
  // effect, the bottom messages slide above the fold and `atBottom`
  // silently flips false, so future followOutput stops working.
  // ResizeObserver re-pins to bottom whenever the viewport shrinks
  // *and* the user was already at the bottom.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastHeight = el.clientHeight
    const ro = new ResizeObserver(() => {
      if (!scrollerRef.current) return
      const now = scrollerRef.current.clientHeight
      const shrunk = now < lastHeight
      lastHeight = now
      if (shrunk && atBottomRef.current) {
        virtuosoRef.current?.scrollToIndex({ index: renderableItems.length - 1, behavior: 'auto' })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [renderableItems.length])

  // Authoritative scroll-state listener 闂?covers two cases that
  // Virtuoso's `atBottomStateChange` alone gets wrong:
  //
  //   1. RESTORE follow when the user scrolls back into the bottom
  //      band (distance < NEAR_BOTTOM_PX). Virtuoso only fires its
  //      callback at the pixel-perfect bottom; without this listener
  //      a scroll to e.g. distance=50 leaves follow disabled forever.
  //      This restoration is unconditional 闂?it does NOT gate on
  //      `unseenCount`. Earlier the gate `unseenCount !== 0` made
  //      restoration impossible if no new messages arrived during
  //      the scroll-up window, leaving the user stuck out of follow
  //      with no feedback.
  //
  //   2. DISABLE follow IMMEDIATELY when the user actively scrolls
  //      up past the band (scrollTop decreasing AND distance >=
  //      NEAR_BOTTOM_PX). The 150 ms debounce in `atBottomStateChange`
  //      exists to filter Virtuoso's transient `false` during the
  //      scroll-to-bottom *animation* 闂?but a real user-initiated
  //      scroll-up is not that. Waiting 150 ms means the very next
  //      data item (tool_result, new assistant turn) lands during the
  //      window with `shouldFollowRef` still true and yanks the user
  //      back to the bottom. Detecting scrollTop decrease lets us
  //      bypass the debounce on genuine user input.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop
    const handler = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const isNearBottom = distanceFromBottom < NEAR_BOTTOM_PX
      const prevScrollTop = lastScrollTopRef.current
      lastScrollTopRef.current = el.scrollTop
      const isScrollingUp = el.scrollTop < prevScrollTop

      if (isNearBottom) {
        // Re-enter the bottom band 闂?restore follow + clear badge.
        if (followTimerRef.current != null) {
          clearTimeout(followTimerRef.current)
          followTimerRef.current = null
        }
        shouldFollowRef.current = true
        if (!atBottomRef.current) {
          atBottomRef.current = true
          setAtBottom(true)
        }
        if (unseenCountRef.current !== 0) {
          unseenCountRef.current = 0
          setUnseenCount(0)
        }
      } else if (isScrollingUp && shouldFollowRef.current) {
        // User dragged the viewport upward past the band 闂?kill follow
        // now, before the pending data-item arrival uses it.
        if (followTimerRef.current != null) {
          clearTimeout(followTimerRef.current)
          followTimerRef.current = null
        }
        shouldFollowRef.current = false
      }
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [renderableItems.length])

  // Clean up the follow debounce timer on unmount.
  useEffect(() => () => {
    if (followTimerRef.current != null) clearTimeout(followTimerRef.current)
  }, [])

  const jumpToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' })
    unseenCountRef.current = 0
    setUnseenCount(0)
  }, [])

  // --- Scroll to previous / next user message ----------------------------
  // Data-array (0-based, Virtuoso `scrollToIndex` space) indices of every
  // *real* user message 闂?the same discriminator MessageView uses to pick
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
  // without being re-created 闂?keeps its registered identity constant. Synced
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
    topVisibleIdxRef.current = range.startIndex - firstItemIndexValRef.current
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
    // Disable follow so the programmatic scroll doesn't fight auto-follow
    // (mirrors the search-result scroll path).
    shouldFollowRef.current = false
    virtuosoRef.current?.scrollToIndex({ index: target, behavior: 'smooth', align: 'start' })
  }, [])

  // Expose the navigator to the parent (Chat 闂?App 闂?session context menu).
  useEffect(() => {
    onRegisterNavigate?.(navigate)
  }, [onRegisterNavigate, navigate])

  const scrollerRefCb = useCallback((ref: HTMLElement | Window | null) => {
    if (ref && ref instanceof HTMLElement) scrollerRef.current = ref
  }, [])

  const followOutput = useCallback(() => (shouldFollowRef.current ? 'smooth' : false), [])

  const atBottomStateChange = useCallback((reportedAtBottom: boolean) => {
    // Virtuoso's at-bottom check is pixel-perfect; we use a NEAR_BOTTOM_PX
    // tolerance everywhere else (scroll handler, button visibility intent).
    // Without this override, a slight upward scroll inside the tolerance
    // band fires `false` here and starts the follow-disable timer 闂?which
    // racing against the scroll handler's restoration produces the bug
    // where follow flickers off seconds after the user thought they were
    // safely back at the bottom.
    let isAtBottom = reportedAtBottom
    if (!isAtBottom) {
      const el = scrollerRef.current
      if (el) {
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distance < NEAR_BOTTOM_PX) isAtBottom = true
      }
    }
    // UI state: update immediately for jump-to-bottom button.
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    if (isAtBottom && unseenCountRef.current !== 0) {
      unseenCountRef.current = 0
      setUnseenCount(0)
    }
    // Debounced follow state: only stop following after
    // isAtBottom stays false for FOLLOW_DEBOUNCE_MS. During
    // batch item additions Virtuoso transiently reports false
    // while the scroll animation settles 闂?the debounce
    // filters those out so the follow chain doesn't break.
    if (isAtBottom) {
      if (followTimerRef.current != null) {
        clearTimeout(followTimerRef.current)
        followTimerRef.current = null
      }
      shouldFollowRef.current = true
    } else {
      if (followTimerRef.current == null) {
        followTimerRef.current = setTimeout(() => {
          followTimerRef.current = null
          shouldFollowRef.current = false
        }, FOLLOW_DEBOUNCE_MS)
      }
    }
  }, [FOLLOW_DEBOUNCE_MS])

  const itemContent = useCallback((_index: number, item: RenderableItem) => {
    // Only pipe `activeMatchInItem` into the message that actually
    // contains the active navigation target. Every other message gets
    // `undefined` so its <mark>s render at the default colour. This
    // is what lets the user visually tell "next match" jumps from one
    // hit to another even within the same message 闂?without per-match
    // resolution we'd be stuck at message granularity.
    const isActiveItem =
      searchActiveMsgIdx != null &&
      searchActiveMsgIdx >= 0 &&
      item.itemIndex === searchActiveMsgIdx
    const activeMatchInItem = isActiveItem ? searchActiveMatchInItem : undefined
    // One-shot entrance animation for genuinely-new arrivals. The flag is
    // set during render (gate block above) and cleared on animationend, so a
    // scroll-driven re-mount of the same row renders without the class.
    const isEntering = enterIdsRef.current.has(item.id)
    const className = [
      'virtuoso-item-wrapper',
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
          nextItemType={renderableItems[_index + 1]?.msg?.type}
        />
      </div>
    )
  }, [searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, handleEnterAnimationEnd, working, renderableItems])

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
  const messagesClassName = isTranscriptRevealPending
    ? 'chat-messages chat-messages-reveal-pending'
    : 'chat-messages'
  const visibleStreamingContent = nextStreamingPresence.content
  const streamingRegionClassName = nextStreamingPresence.exiting
    ? 'chat-streaming-region exiting'
    : 'chat-streaming-region'
  /* eslint-enable react-hooks/refs */

  // Virtuoso Footer is reserved for transcript metadata that belongs after
  // the message history. Live streaming text is rendered outside the
  // virtualized message area so it can behave as a separate region.
  const virtuosoComponents = useMemo(() => {
    const hasRecap = recap != null
    // The Header slot shows a "loading older history" affordance pinned to
    // the top. Only relevant for the main transcript (loadOlder provided).
    const showOlderHeader = loadOlder != null && (loadingOlder || hasOlder)
    const components: Record<string, () => React.ReactElement> = {}
    if (showOlderHeader) {
      components.Header = () => <OlderHistoryHeader loading={loadingOlder} />
    }
    if (hasRecap) {
      components.Footer = () => <RecapFooter recap={recap} />
    }
    return components
  }, [recap, loadOlder, loadingOlder, hasOlder])

  return (
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
              ? 'Type a message below to start the conversation.'
              : 'Loading messages...'}
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
            // (actual 闂?estimated). That one-frame scroll correction shifts the
            // streaming footer bubble as a block 闂?the "闂佽桨鑳剁换婵堢礊鐎ｎ剚宕夐柛鎰絻琚? jitter. By
            // pre-rendering tail items offscreen they're already measured before
            // becoming the anchor, so no post-insert scroll correction happens.
            // Rows are memoized, so the extra offscreen DOM is cheap.
            increaseViewportBy={{ top: 0, bottom: 600 }}
            alignToBottom
          />
        )}
      </div>
      {!atBottom && (
        <button
          type="button"
          className="chat-jump-to-bottom"
          onClick={jumpToBottom}
          aria-label={unseenCount > 0 ? `Scroll to latest 闂?${unseenCount} new message${unseenCount === 1 ? '' : 's'}` : 'Scroll to latest messages'}
        >
          <IconArrowDown size={16} aria-hidden />
          {unseenCount > 0 && <span className="chat-jump-to-bottom-count" aria-hidden>{unseenCount}</span>}
        </button>
      )}
      </div>
      {visibleStreamingContent != null && (
        <div className={streamingRegionClassName} aria-hidden={nextStreamingPresence.exiting}>
          <StreamingFooter content={visibleStreamingContent} />
        </div>
      )}
    </div>
    </ResultConsumedCtx.Provider>
    </ToolResultProvider>
    </ToolStatusProvider>
    </QuestionAnswersProvider>
    </PlanContentProvider>
    </PlanStatusProvider>
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
}: {
  msg: SdkMessage
  isCompactSummary?: boolean
  searchQuery?: string
  /** Local match index inside this message 闂?when set, the Markdown
   *  renderer marks the Nth `<mark>` as the active navigation target.
   *  Caller computes the index per-message and passes `undefined` (or
   *  -1) for messages that aren't the user's current focus. For
   *  multi-block assistant messages we walk the blocks here and rebase
   *  the index into per-block coordinates so each Markdown only sees
   *  the local sub-index. */
  activeMatchInItem?: number
  /** When true, render the user bubble with a "sending" spinner.
   *  Only meaningful for type='user' messages 闂?propagated from the
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
}) {
  const type = msg.type

  // Whether this turn ended because the user interrupted it. Read directly
  // from the SDK result message's `terminal_reason` 闂?the subprocess's
  // authoritative report of why the turn stopped (`aborted_streaming` /
  // `aborted_tools` are the two user-interrupt reasons). Because it lives on
  // `msg` itself, it survives Virtuoso unmount/remount; the old approach
  // stored it in transient component state seeded from a one-shot ref, so a
  // re-mounted result row lost the flag and flipped 闂?back to 闂?
  const isInterrupted =
    type === 'result' &&
    (msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools')

  // Memoise the block list so the child `BlockView` / `ToolResultBlock`
  // memos actually hit. `getBlocks(msg)` returns a *fresh* array (and
  // fresh inner object) every call when `msg.message.content` is a
  // string 闂?the common case for plain text messages. Without this
  // memo, every keystroke in the search box rebuilds every block of
  // every message, even though the underlying message hasn't changed.
  // Stable `msg` reference (the store hands us immutable items) 闂?  // stable `blocks` 闂?stable `block` props 闂?memos hit.
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
  // `return`), even though only the assistant branch consumes it 闂?  // calling it inside `if (type === 'assistant')` changes the hook
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

  // The result-consumed predicate is built ONCE by MessageList and shared via
  // context, so willRenderEmpty (the item filter) and this render path use the
  // exact same instance 闂?they can't drift. Read unconditionally per
  // rules-of-hooks even though only the user branch uses it.
  const isResultConsumed = useResultConsumed()

  if (type === 'user') {
    const userContent = extractUserText(msg)
    // Tool results that have been consumed by their card (generic ToolCard
    // inline merge, or PlanCard / QuestionCard) are suppressed here. Only
    // ORPHAN results 闂?whose tool_use_id matched no card 闂?fall through to
    // the standalone bubble below, so no result is ever silently dropped.
    const allToolBlocks = blocks.filter((b) => b.type === 'tool_result')
    const toolBlocks = allToolBlocks.filter(
      (b) => typeof b.tool_use_id !== 'string' || !isResultConsumed(b.tool_use_id),
    )

    // Synthetic "conversation summary" frame that the SDK injects right
    // after compact_boundary. It has role=user because the model will
    // consume it as the next turn's input, but the human never typed it.
    // Render it collapsed, wired to the preceding Recap divider.
    if (isCompactSummary) {
      return <CompactSummary text={userContent ?? ''} />
    }

    // A `user` frame is synthetic (i.e. NOT typed by the human) in two
    // overlapping cases:
    //   1. It carries at least one `tool_result` block 闂?the SDK uses
    //      the user role to feed tool output back to the model.
    //      Notably, top-level tool calls like `Agent` produce a user
    //      frame with `tool_result` but NO `parent_tool_use_id` (the
    //      result goes to the *main* thread; parent_tool_use_id is only
    //      set for subagent-internal tool hops).
    //   2. It has a non-null `parent_tool_use_id` 闂?this is a subagent
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
              <ToolResultBlock key={i} block={b} />
            ))}
          </div>
        </div>
      )
    }

    // Real user message
    const imageBlocks = blocks.filter((b) => b.type === 'image')
    // Show the "queued" chip only while the turn is genuinely waiting behind
    // an in-flight turn: server-acknowledged (deliveryStatus === 'queued')
    // and not still in the optimistic pre-ack 'sending' state. Once the SDK
    // consumes it (deliveryStatus flips to 'consumed') the queued chip
    // disappears and a "processing" chip takes its place 闂?but only while
    // the session is actively working, so historical consumed messages
    // after a reconnect don't re-trigger the indicator.
    const showQueued = !sending && deliveryStatus === 'queued'
    // Show processing only while the session is working AND the model
    // hasn't started responding yet. Once an assistant/result message
    // appears after this user turn, the model has moved on 闂?hide the
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
              title="Sending 闂?waiting for the server to acknowledge"
              aria-label="Sending"
            >
              <span className="msg-sending-spinner" aria-hidden />
              <span className="msg-sending-label">sending</span>
            </span>
          )}
          {showQueued && (
            <span
              className="msg-queued-indicator"
              title="Queued 闂?the assistant is finishing the current turn; this message will be picked up next"
              aria-label="Queued, waiting for the current turn to finish"
            >
              <span className="msg-queued-dot" aria-hidden />
              <span className="msg-queued-label">queued</span>
            </span>
          )}
          {showProcessing && (
            <span
              className="msg-processing-indicator"
              title="Processing 闂?the model is working on this message"
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
    // Subagent assistant turns (from Task tool workers with
    // forwardSubagentText on) carry the same shape as main-thread
    // assistant turns but with a non-null parent_tool_use_id. Label
    // them distinctly so users can tell which model produced which
    // output 闂?without this, a subagent's `tool_use: Bash` would look
    // identical to the main model running Bash.
    const isSubagent = msg.parent_tool_use_id != null
    // Suppress assistant messages with no visible content. The SDK can emit
    // a standalone assistant message whose only block is an empty
    // (signature-only) thinking block 闂?BlockView renders it as null, but
    // the surrounding card would still paint an empty "闂?assistant" shell.
    // The visibility rule lives in willRenderEmpty so renderableItems can
    // drop these before they become empty Virtuoso items (see that fn).
    if (willRenderEmpty(msg, isCompactSummary, isResultConsumed)) return null
    return (
      <div className={`msg assistant${isSubagent ? ' subagent' : ''}`}>
        <div className="msg-header">
          <span>{isSubagent ? 'subagent' : 'assistant'}</span>
          <MessageTimestamp ms={msg.receivedAt} />
          {msg.error && <span className="msg-header-error">{msg.error as string}</span>}
        </div>
        <div className="msg-body">
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} searchQuery={searchQuery} activeMatchIdx={blockActiveIdx[i]} />
          ))}
        </div>
      </div>
    )
  }

  if (type === 'result') {
    const cost = typeof msg.total_cost_usd === 'number' ? `$${msg.total_cost_usd.toFixed(4)}` : ''
    const durMs = typeof msg.duration_ms === 'number' ? Math.round(msg.duration_ms) : null
    // Render sub-second durations as ms, 闂?s as one-decimal seconds 闂?a
    // bare "1234ms" reads slower than "1.2s" at a glance.
    const dur = durMs == null ? '' : durMs >= 1000 ? `${(durMs / 1000).toFixed(1)}s` : `${durMs}ms`
    const turns =
      typeof msg.num_turns === 'number' ? `${msg.num_turns} turn${msg.num_turns === 1 ? '' : 's'}` : ''
    // Token usage from the SDK's result payload. `input_tokens` is the
    // turn-accumulated prompt total and 闂?per the Anthropic API 闂?does NOT
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
    return (
      <div className={`msg error${isRateLimit ? ' rate-limit' : ''}`}>
        <div className="msg-header">
          <span>{isRateLimit ? 'rate limited' : 'error'}</span>
        </div>
        <div className="msg-body">
          {isRateLimit ? (
            <>Too many requests 闂?the API rate limit was hit. Your message was saved; send it again in a moment.</>
          ) : (
            raw
          )}
        </div>
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
          {msg.subtype ? ` 閻?${msg.subtype}` : ''}
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
      ? ` 閻?saved ${Math.round(((pre - post) / pre) * 100)}%`
      : ''
  const duration =
    typeof meta.duration_ms === 'number' ? ` 閻?${Math.round(meta.duration_ms)}ms` : ''
  return (
    <div className="msg recap" role="separator" aria-label="Conversation recap / compact boundary">
      <span className="recap-label">
        <span aria-hidden>↘</span> Recap ({trigger})
      </span>
      <span className="recap-meta">
        {pre !== undefined && post !== undefined
          ? `${formatTokens(pre)} 闂?${formatTokens(post)} tokens${savings}${duration}`
          : 'Conversation compacted to fit the context window.'}
      </span>
    </div>
  )
}

/** Wire shape of an `api_retry` system frame. The fields are all
 *  optional from the renderer's perspective 闂?older / partial frames
 *  may omit any of them 闂?but the cast lives here once instead of at
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
 *  when a fresh frame lands with a different `retry_delay_ms` 闂?the
 *  reducer replaces consecutive `api_retry` frames in place
 *  (`reducer.ts:298-300`) so this component gets new props rather than
 *  remounting. Reading deadline-now is monotonic across that prop
 *  change; the previous baseline+delay split could briefly show a
 *  garbled number for one render after a new frame.
 *
 *  We stop the interval at remainingMs 闂?0 闂?the next attempt is in
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
  // object means a delayMs prop change updates both together 闂?no
  // render where deadline is "new" but now is from the previous frame.
  //
  // Caveat: when `delayMs` changes mid-component-life (the reducer
  // replaces consecutive api_retry frames in place 闂?see
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
    // now闂? stops costing us a render per second forever. A new
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
    ? 'Rate limited'
    : errorStatus === 529
      ? 'Overloaded'
      : errorKind === 'server_error'
        ? 'Server error'
        : 'Retrying'
  // Once we've ticked down to 0 the next attempt is mid-flight; "now"
  // is more honest than "in 0s".
  const phase = seconds > 0 ? `retrying in ${seconds}s` : 'retrying now'
  // Suppress the "/0" tail when max_retries is missing 闂?better to
  // show just the attempt number than a nonsense fraction.
  const attemptText =
    maxRetries > 0 ? `attempt ${attempt}/${maxRetries}` : `attempt ${attempt}`
  return (
    <div className="msg api-retry">
      <div className="msg-header">
        <span>{label} 闂?{phase} ({attemptText})</span>
      </div>
    </div>
  )
}

/** The "continuation" half of a compact event.
 *
 *  After `system/compact_boundary`, the SDK pushes a synthetic user-role
 *  frame whose content is a prose summary of the previous conversation
 *  闂?it's the next turn's input prompt, but it wasn't typed by the
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
  // Grab the first "Summary:" headline as a peek if we can 闂?the SDK
  // template usually starts with boilerplate, then a Summary header.
  const peek = text.slice(0, 140).replace(/\s+/g, ' ').trim()
  return (
    <div className="msg compact-summary" role="note" aria-label="Conversation recap (context injected by SDK)">
      <div className="msg-header">
        <span>recap context 閻?{charCount.toLocaleString()} chars</span>
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

/** Rendering for the session.recap field, driven by its 3-state
 *  status discriminator from the shared SessionRecap type:
 *    pending 闂?loading skeleton (LLM call in flight)
 *    ready   闂?AI summary + stats
 *    error   闂?failure message (Alt+R retries)
 *
 *  The card is anchored at the bottom of the transcript via Virtuoso's
 *  Footer slot 闂?see virtuosoComponents above. It is NOT a synthetic
 *  SDK message; the previous design (recap as a `type:'recap'` message
 *  spliced into history) was replaced because:
 *    1. recap is metadata about the session, not part of the
 *       conversation tape.
 *    2. recapManager's lifecycle (in-memory only, invalidated on every
 *       conversation mutation) is incompatible with the persistent
 *       message ring's append-only semantics.
 */
const RecapFooter = memo(function RecapFooter({ recap }: { recap: SessionRecap }) {
  if (recap.status === 'pending') {
    return (
      <div className="virtuoso-footer-wrapper">
        <div className="msg recap-msg recap-msg--loading" role="note" aria-label="Generating session recap">
          <div className="msg-header">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconSparkles size={14} /> Session recap</span>
          </div>
          <div className="msg-body recap-msg-loading-body">
            <span className="recap-msg-loading-bar" aria-hidden />
            <span>Summarising the last few minutes...</span>
          </div>
        </div>
      </div>
    )
  }

  if (recap.status === 'error') {
    return (
      <div className="virtuoso-footer-wrapper">
        <div className="msg recap-msg recap-msg--error" role="note">
          <div className="msg-header">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconAlertTriangle size={14} /> Recap unavailable</span>
          </div>
          <div className="msg-body">{recap.error ?? 'Unknown error'}</div>
        </div>
      </div>
    )
  }

  // status === 'ready' 闂?summary and stats may still legitimately be
  // missing if the server constructed the ready frame defensively;
  // bail rather than render a half-card.
  if (!recap.summary || !recap.stats) return null
  const { summary, stats } = recap

  return (
    <div className="virtuoso-footer-wrapper">
      <div className="msg recap-msg" role="note" aria-label="Session recap">
        <div className="msg-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconSparkles size={14} /> Session recap</span>
        </div>
        <div className="msg-body">
          <Markdown text={summary} />
          <div className="recap-msg-stats">
            {stats.userTurns > 0 && (
              <span className="recap-msg-stat">
                <IconMessageCircle size={12} /> {stats.userTurns} turn{stats.userTurns === 1 ? '' : 's'}
              </span>
            )}
            {stats.totalCostUsd > 0 && (
              <span className="recap-msg-stat"><IconDollar size={12} /> {formatCost(stats.totalCostUsd)}</span>
            )}
            {stats.durationMs > 0 && (
              <span className="recap-msg-stat"><IconClock size={12} /> {formatElapsed(stats.durationMs)}</span>
            )}
            {stats.toolsUsed.length > 0 && (
              <span className="recap-msg-stat"><IconWrench size={12} /> {stats.toolsUsed.length} tool{stats.toolsUsed.length === 1 ? '' : 's'}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/** Max subagent chips shown before collapsing into "+N more". */
const MAX_VISIBLE_SUBAGENTS = 5

/** Self-ticking elapsed-time text. Isolating the 1Hz interval here means
 *  only this tiny text node re-renders each second 闂?the parent WorkingBubble
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
   *  with the chip's toolUseId 闂?the host (Chat) opens the overlay
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
            title={clickable ? `Open subagent details 闂?${a.label}` : a.label}
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
