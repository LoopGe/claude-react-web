// Virtualised message transcript for one session.
//
// Uses react-virtuoso to render only the visible slice of messages,
// keeping DOM node count bounded regardless of transcript length.
// Keeps the list pinned to the bottom unless the user scrolls up — once
// they do, new messages append silently instead of yanking the viewport.
// Filters out `stream_event` partials (the final assistant message
// carries the complete content, so showing both just flickers).

import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Markdown } from './Markdown'
import { ToolUseBlock } from './ToolUseBlock'
import { PlanStatusProvider, PlanContentProvider, ToolStatusProvider, ToolResultProvider } from '../hooks/usePlanStatus'
import { ToolResultDetails } from './ToolCard'
import { QuestionAnswersProvider } from '../hooks/useQuestionAnswers'
import type { SdkMessage, Block } from '../types'
import type { SessionRecap } from '../../shared/session-info'
import { formatTokens, formatElapsed, formatJson, formatClockTime, formatFullTimestamp } from '../utils/format'
import { Tooltip } from './Tooltip'
import { useLocalStorage } from '../hooks/useLocalStorage'
import type { ActiveSubagent, PlanStatus, ToolResultEntry, ToolStatus, TranscriptItem } from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'
import { getBlocks, getEnterPlanToolUseIds } from '../session-store/normalize'
import { useSubagentContext } from '../hooks/useSubagentContext'
import { IconCopy, IconArrowDown, IconZap, IconSparkles, IconAlertTriangle, IconMessageCircle, IconDollar, IconClock, IconWrench, IconUser, IconExternalLink } from './icons/ToolIcons'
import { countMatches, extractPlainText } from '../search'

/** Re-export type for backward compatibility (types don't affect Fast Refresh). */
export type { ActiveSubagent } from '../session-store/types'

interface Props {
  items: TranscriptItem[]
  /** Server-pushed AI session recap. Lives on session.recap (NOT in the
   *  history). When present, rendered as a card pinned to the bottom of
   *  the transcript (after items, before the streaming footer) so it
   *  reads as the latest "narrator" entry. Three states drive the chrome:
   *  pending → loading skeleton, ready → summary + stats, error → retry
   *  hint. Undefined means "no recap to show". */
  recap?: SessionRecap
  /** When true, include `system` messages (init/status/etc.) in the
   *  rendered list. Errors (`subtype === 'error'`) are always shown
   *  regardless — those carry actual failure info users need to see. */
  showSystemEvents?: boolean
  /** False while the initial replay from the server is still buffering.
   *  When false, shows a loading skeleton instead of the empty-state
   *  message, preventing a flash of "no messages" on session switch. */
  replayReady?: boolean
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
  /** Local match index inside the active item — i.e. for the message
   *  pointed at by `searchActiveMsgIdx`, this names which of its
   *  matches is the user's current navigation target. Lets the
   *  renderer style ONE specific `<mark>` differently (warn-coloured
   *  background) instead of just "the whole message". -1 / undefined
   *  means "no active match in this item" (or the active hit lives in
   *  a different item). */
  searchActiveMatchInItem?: number
  /** Filter mode for parent_tool_use_id:
   *  - undefined / null: only show root messages (parent_tool_use_id == null).
   *    This is the default for the main transcript — subagent-internal
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
}

/** An item in the Virtuoso data array. Pre-computing isCompactSummary
 *  here avoids the renderable[i-1] look-back during itemContent.
 *  `itemIndex` maps back to the original items[] position for search
 *  result scrolling (search indices reference the full, unfiltered list). */
interface RenderableItem {
  /** Stable per-message id (SdkMessage uuid, or a synthetic fallback).
   *  Drives the new-message entrance-animation gate — see knownIdsRef. */
  id: string
  msg: SdkMessage
  isCompactSummary: boolean
  itemIndex: number
  /** Optimistic placeholder still in flight — drives the user bubble's
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
 *  which is too strict — a single line of streaming output can flip
 *  it false while the user clearly hasn't scrolled away. We override
 *  Virtuoso's verdict with this tolerance both in `atBottomStateChange`
 *  (so its `false` doesn't kill follow-mode) and in the scroll handler
 *  (so re-entering the band restores follow-mode). */
const NEAR_BOTTOM_PX = 200

/** Entrance-animation gate tunables (see the gate block in MessageList).
 *  MAX_ENTER_BATCH — only animate when the tail grows by at most this many
 *    ids at once; a larger jump means a bulk load (replay / page), not a
 *    live trickle.
 *  ENTER_MAX_AGE_MS — a tail id only animates if its receivedAt is within
 *    this window of now; filters disk-restored history whose timestamps are
 *    stale even if it somehow reaches the tail path.
 *  KNOWN_IDS_CAP — hard bound on the seen-id set for very long sessions. */
const MAX_ENTER_BATCH = 4
const ENTER_MAX_AGE_MS = 10_000
const KNOWN_IDS_CAP = 4000

export const MessageList = memo(function MessageList({ items, recap, showSystemEvents = false, replayReady = true, streamingContent, planStatus = EMPTY_PLAN_STATUS, planContent = EMPTY_PLAN_CONTENT, questionAnswers = EMPTY_QUESTION_ANSWERS, toolStatus = EMPTY_TOOL_STATUS, toolResults = EMPTY_TOOL_RESULTS, searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, parentToolUseIdFilter, loadOlder, hasOlder = false, loadingOlder = false }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // Captures Virtuoso's underlying scroll element so a ResizeObserver
  // can detect viewport shrink (TodoChecklist panel growing).
  const scrollerRef = useRef<HTMLElement | null>(null)
  // `atBottom` is state (not a ref) because the jump-to-bottom button's
  // visibility needs to re-render when it changes. The ref-mirror keeps
  // callbacks readable without a stale-closure dance.
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  // Debounced "should follow" ref — filters out transient isAtBottom=false
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
  const [followDebounceRaw] = useLocalStorage<number>(
    'claude-react-web:follow-debounce-ms',
    150,
  )
  const FOLLOW_DEBOUNCE_MS = Math.max(50, Math.min(500, Math.round(followDebounceRaw)))
  /** How many new messages have arrived since the user last saw the
   *  bottom. Badge number on the jump-to-bottom button. */
  const [unseenCount, setUnseenCount] = useState(0)
  const unseenCountRef = useRef(0)

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
  // their standalone orphan bubble is suppressed — same merge treatment as a
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
      const parent = (item.msg as Record<string, unknown>).parent_tool_use_id
      // Filter by parent_tool_use_id:
      //  - main transcript (filter == null): show only root messages
      //    — subagent children are surfaced via SubagentCard placeholders
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
        (showSystemEvents || !item.hiddenByDefault) &&
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
  }, [items, showSystemEvents, parentToolUseIdFilter, isResultConsumed])

  // --- Reverse infinite scroll: keep the viewport anchored on prepend ----
  // Virtuoso requires `firstItemIndex` to decrease by exactly the number of
  // items prepended, in the SAME render that grows `data` at the front —
  // otherwise the viewport jumps. We detect a front-prepend by checking
  // whether the previous first renderable message moved to a later index.
  //
  // Computed during render (refs, not state) so `firstItemIndex` and `data`
  // commit together. The `msg === prev` short-circuit makes this a no-op on
  // ordinary appends/streaming; the findIndex only runs on the rare prepend
  // or full-rebuild render. If a discarded concurrent render mutates the
  // ref, the next real render self-corrects (prev still matches) — worst
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
    // Empty list (session switch / cleared) — reset the anchor.
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
      // Previous first item is gone (replay rebuild / reset) — re-anchor.
      firstItemIndexRef.current = INITIAL_FIRST_ITEM_INDEX
    }
    prevFirstMsgRef.current = first
  }
  const firstItemIndex = firstItemIndexRef.current
  /* eslint-enable react-hooks/refs */

  // --- New-message entrance animation gate -------------------------------
  // Goal: play a one-shot "rise + blur-in" on messages that genuinely just
  // ARRIVED live — never on the initial replay, session switches, loadOlder
  // history prepends, the optimistic→echo user-message swap, or Virtuoso
  // re-mounting an off-screen row as the user scrolls.
  //
  // The discriminator is "a small batch of previously-unseen ids appended at
  // the TAIL of a non-empty list, each stamped with a recent wall-clock
  // receivedAt". That single rule excludes every non-arrival case:
  //   - initial replay / session switch → grows from empty (prevLen 0) or
  //     adds many ids at once → skipped by the prevLen>0 + batch-size guards.
  //   - loadOlder prepend → ids appear at the FRONT, not at indices >=
  //     prevLen → not tail-appends → skipped.
  //   - optimistic→echo swap → in-place replace at an existing index, list
  //     length unchanged → no index >= prevLen → skipped (the optimistic
  //     insert already animated the pop).
  //   - showSystemEvents toggle → inserts in the middle / re-adds known ids,
  //     and the ids were already seen → skipped.
  //   - scroll re-mount → id already in knownIdsRef and already consumed from
  //     enterIdsRef → skipped.
  // receivedAt recency disambiguates a freshly-typed first message (animate)
  // from a replayed single-message session (history timestamp is stale).
  const knownIdsRef = useRef<Set<string>>(new Set())
  const enterIdsRef = useRef<Set<string>>(new Set())
  const prevLenRef = useRef(0)
  /* eslint-disable react-hooks/refs -- ref reads/writes during render commit
     the enter-set together with `data`, mirroring the firstItemIndex block. */
  {
    const prevLen = prevLenRef.current
    const curLen = renderableItems.length
    // Tail-append candidates: ids at index >= prevLen that we've never seen.
    // Only consider when growing a non-empty list by a small delta (live
    // arrivals trickle in 1–2 at a time; bulk loads add many at once).
    const delta = curLen - prevLen
    const armed = replayReady && prevLen > 0 && delta > 0 && delta <= MAX_ENTER_BATCH
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

  // Fires when the user scrolls to the top. Pull the previous page of
  // history from disk if there's more and we're not already loading.
  const startReached = useCallback(() => {
    if (!loadOlder || !hasOlder || loadingOlder) return
    void loadOlder()
  }, [loadOlder, hasOlder, loadingOlder])

  // Reverse map: full items[] index → Virtuoso (renderableItems) index.
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
  // *not* `hiddenByDefault` / `showSystemEvents` — toggling system events
  // changes the rendered length without new messages arriving, which would
  // inflate the badge. Counting by parent dodges the same trap for the
  // main transcript: subagent-internal frames stream in continuously while
  // an Agent runs, but they're hidden in the main list, so they shouldn't
  // tick the badge there. (The overlay has its own MessageList instance
  // with the matching filter, so its badge counts correctly too.)
  const trackedCount = useMemo(() => {
    let count = 0
    for (const item of items) {
      const parent = (item.msg as Record<string, unknown>).parent_tool_use_id
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
      // Keep the ref in lockstep with state — the scroll-near-bottom
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

  // Streaming-content auto-follow. Virtuoso's `followOutput` only fires
  // when `data` changes, but streamingContent lives in the Footer slot —
  // its DOM grows every ~80ms flush without `data` changing, so without
  // this effect the typing text silently overflows below the viewport.
  // We bypass Virtuoso here and write scrollTop directly because the
  // Footer is not addressable via scrollToIndex (which targets items).
  // Mirrors the ResizeObserver branch: only re-pins when the user was
  // already at the bottom — if they scrolled up to read history mid-
  // stream, atBottomRef goes false and we stop fighting their scroll.
  //
  // The scrollTop write runs in a LAYOUT effect (synchronously after the DOM
  // mutation, BEFORE the browser paints) rather than a passive effect + rAF.
  // The old passive-effect + requestAnimationFrame path was deferred twice —
  // React runs passive effects after paint, and the rAF pushed the write to
  // the *next* frame again — so every 80ms flush painted one frame with the
  // grown footer but the bottom still off-screen, then yanked it back on the
  // following frame: a visible per-flush jitter. A layout effect pins the
  // bottom in the same frame the taller content is committed, so the bottom
  // never paints off-screen. Cost: one synchronous reflow per flush (~12/s),
  // which is cheap next to the visible jump it removes.
  useLayoutEffect(() => {
    if (streamingContent == null) return
    if (!atBottomRef.current) return
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [streamingContent])

  // Authoritative scroll-state listener — covers two cases that
  // Virtuoso's `atBottomStateChange` alone gets wrong:
  //
  //   1. RESTORE follow when the user scrolls back into the bottom
  //      band (distance < NEAR_BOTTOM_PX). Virtuoso only fires its
  //      callback at the pixel-perfect bottom; without this listener
  //      a scroll to e.g. distance=50 leaves follow disabled forever.
  //      This restoration is unconditional — it does NOT gate on
  //      `unseenCount`. Earlier the gate `unseenCount !== 0` made
  //      restoration impossible if no new messages arrived during
  //      the scroll-up window, leaving the user stuck out of follow
  //      with no feedback.
  //
  //   2. DISABLE follow IMMEDIATELY when the user actively scrolls
  //      up past the band (scrollTop decreasing AND distance >=
  //      NEAR_BOTTOM_PX). The 150 ms debounce in `atBottomStateChange`
  //      exists to filter Virtuoso's transient `false` during the
  //      scroll-to-bottom *animation* — but a real user-initiated
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
        // Re-enter the bottom band — restore follow + clear badge.
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
        // User dragged the viewport upward past the band — kill follow
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

  const scrollerRefCb = useCallback((ref: HTMLElement | Window | null) => {
    if (ref && ref instanceof HTMLElement) scrollerRef.current = ref
  }, [])

  const followOutput = useCallback(() => (shouldFollowRef.current ? 'auto' : false), [])

  const atBottomStateChange = useCallback((reportedAtBottom: boolean) => {
    // Virtuoso's at-bottom check is pixel-perfect; we use a NEAR_BOTTOM_PX
    // tolerance everywhere else (scroll handler, button visibility intent).
    // Without this override, a slight upward scroll inside the tolerance
    // band fires `false` here and starts the follow-disable timer — which
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
    // while the scroll animation settles — the debounce
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
    // hit to another even within the same message — without per-match
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
    return (
      <div
        className={isEntering ? 'virtuoso-item-wrapper msg-enter' : 'virtuoso-item-wrapper'}
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
        />
      </div>
    )
  }, [searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, handleEnterAnimationEnd])

  // Footer combines two optional rows pinned to the bottom of the
  // transcript: the streaming-typing bubble (live token deltas) and the
  // session-recap card. They're rendered together — phase-wise the recap
  // only fires when the session is idle, but the server doesn't enforce
  // that on the broadcast side, so we don't gate either on the other.
  const virtuosoComponents = useMemo(() => {
    const hasStreaming = streamingContent != null
    const hasRecap = recap != null
    // The Header slot shows a "loading older history" affordance pinned to
    // the top. Only relevant for the main transcript (loadOlder provided).
    const showOlderHeader = loadOlder != null && (loadingOlder || hasOlder)
    const components: Record<string, () => React.ReactElement> = {}
    if (showOlderHeader) {
      components.Header = () => <OlderHistoryHeader loading={loadingOlder} />
    }
    if (hasStreaming || hasRecap) {
      components.Footer = () => (
        <>
          {hasStreaming && <StreamingFooter content={streamingContent} />}
          {hasRecap && <RecapFooter recap={recap} />}
        </>
      )
    }
    return components
  }, [streamingContent, recap, loadOlder, loadingOlder, hasOlder])

  return (
    <PlanStatusProvider value={planStatus}>
    <PlanContentProvider value={planContent}>
    <QuestionAnswersProvider value={questionAnswers}>
    <ToolStatusProvider value={toolStatus}>
    <ToolResultProvider value={toolResults}>
    <ResultConsumedCtx.Provider value={isResultConsumed}>
    <div className="chat-messages-wrap">
      <div className="chat-messages">
        {renderableItems.length === 0 ? (
          <div className="chat-messages-empty">
            {replayReady
              ? 'Type a message below to start the conversation.'
              : 'Loading messages…'}
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
            itemContent={itemContent}
            components={virtuosoComponents}
            alignToBottom
          />
        )}
      </div>
      {!atBottom && (
        <button
          type="button"
          className="chat-jump-to-bottom"
          onClick={jumpToBottom}
          aria-label={unseenCount > 0 ? `Scroll to latest — ${unseenCount} new message${unseenCount === 1 ? '' : 's'}` : 'Scroll to latest messages'}
        >
          <IconArrowDown size={16} aria-hidden />
          {unseenCount > 0 && <span className="chat-jump-to-bottom-count" aria-hidden>{unseenCount}</span>}
        </button>
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

/** Top-of-transcript affordance for reverse infinite scroll. Renders a
 *  spinner while a page is loading, or a thin idle marker when older
 *  history exists but hasn't been requested yet (scrolling up triggers
 *  the fetch via Virtuoso's startReached). */
const OlderHistoryHeader = memo(function OlderHistoryHeader({ loading }: { loading: boolean }) {
  return (
    <div className="chat-older-history" aria-live="polite">
      {loading ? (
        <span className="chat-older-history-loading">
          <IconZap size={12} aria-hidden />
          Loading earlier messages…
        </span>
      ) : (
        <span className="chat-older-history-hint">Scroll up for earlier messages</span>
      )}
    </div>
  )
})

const StreamingFooter = memo(function StreamingFooter({ content }: { content: string }) {
  // Render the in-progress turn as PLAIN TEXT, not Markdown. The live turn
  // flushes a growing string ~12×/second; running the full ReactMarkdown +
  // syntax-highlight pipeline over the entire accumulated text on every
  // flush is the dominant per-frame cost during long generations. Plain
  // pre-wrapped text is effectively free to render and the prose reads the
  // same. The instant the turn settles this footer disappears and the text
  // re-renders once as a normal (memoized) Markdown assistant message — so
  // formatting/code-highlighting "snaps in" exactly when streaming ends.

  // The body is height-capped in CSS (.streaming-plain max-height) so a long
  // turn can't push the transcript off-screen. Once the content exceeds the
  // cap the body scrolls internally — but it would otherwise stay pinned at
  // the TOP, hiding the freshly-generated tail. Pin it to the bottom on every
  // content flush UNLESS the user has scrolled up inside the body to read
  // back (then we leave their position alone, matching the outer transcript's
  // follow behaviour).
  const bodyRef = useRef<HTMLDivElement>(null)
  // Whether to keep the body pinned to its latest line. Starts true and only
  // flips false when the USER scrolls up inside the body. We deliberately do
  // NOT infer this from the post-append scroll position: appending content
  // below grows scrollHeight WITHOUT moving scrollTop, so the moment the body
  // first overflows it reads as "far from the bottom" even though the user
  // never scrolled — which previously stranded the body at the TOP and broke
  // follow. Real scroll events fire only on user gestures (and on our own
  // programmatic pin, which lands at distance≈0 and keeps follow on), never
  // on plain content append, so they are the trustworthy signal.
  const followRef = useRef(true)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      // Tolerance band: treat "near the bottom" as "still following".
      followRef.current = distanceFromBottom <= 24
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (followRef.current) el.scrollTop = el.scrollHeight
  }, [content])

  return (
    <div className="virtuoso-footer-wrapper">
      <div className="msg msg-assistant streaming-msg">
        {/* aria-live polite + non-atomic so screen readers announce
            newly appended streaming text rather than re-reading the whole
            block on every token delta (rule: aria-live for live output). */}
        <div ref={bodyRef} className="msg-body assistant-body streaming-plain" aria-live="polite" aria-atomic="false">
          {content}
          <span className="streaming-cursor" />
        </div>
      </div>
    </div>
  )
})

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    // Fallback: select from a hidden textarea (Safari / HTTP).
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}

const MessageView = memo(function MessageView({
  msg,
  isCompactSummary,
  searchQuery,
  activeMatchInItem,
  sending,
  deliveryStatus,
}: {
  msg: SdkMessage
  isCompactSummary?: boolean
  searchQuery?: string
  /** Local match index inside this message — when set, the Markdown
   *  renderer marks the Nth `<mark>` as the active navigation target.
   *  Caller computes the index per-message and passes `undefined` (or
   *  -1) for messages that aren't the user's current focus. For
   *  multi-block assistant messages we walk the blocks here and rebase
   *  the index into per-block coordinates so each Markdown only sees
   *  the local sub-index. */
  activeMatchInItem?: number
  /** When true, render the user bubble with a "sending" spinner.
   *  Only meaningful for type='user' messages — propagated from the
   *  TranscriptItem's optimistic-placeholder flag. */
  sending?: boolean
  /** Queue-delivery state of a top-level user turn. 'queued' renders a
   *  "queued" chip (the SDK is busy and hasn't read this turn yet);
   *  'consumed' renders a brief "processing" chip; undefined renders
   *  nothing. Mutually exclusive with `sending` in practice (sending is
   *  the pre-ack optimistic state, deliveryStatus is post-ack). */
  deliveryStatus?: 'queued' | 'consumed'
}) {
  const type = msg.type

  // Whether this turn ended because the user interrupted it. Read directly
  // from the SDK result message's `terminal_reason` — the subprocess's
  // authoritative report of why the turn stopped (`aborted_streaming` /
  // `aborted_tools` are the two user-interrupt reasons). Because it lives on
  // `msg` itself, it survives Virtuoso unmount/remount; the old approach
  // stored it in transient component state seeded from a one-shot ref, so a
  // re-mounted result row lost the flag and flipped ⊘ back to ✓.
  const isInterrupted =
    type === 'result' &&
    (msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools')

  // Memoise the block list so the child `BlockView` / `ToolResultBlock`
  // memos actually hit. `getBlocks(msg)` returns a *fresh* array (and
  // fresh inner object) every call when `msg.message.content` is a
  // string — the common case for plain text messages. Without this
  // memo, every keystroke in the search box rebuilds every block of
  // every message, even though the underlying message hasn't changed.
  // Stable `msg` reference (the store hands us immutable items) →
  // stable `blocks` → stable `block` props → memos hit.
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
  // `return`), even though only the assistant branch consumes it —
  // calling it inside `if (type === 'assistant')` changes the hook
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
  // exact same instance — they can't drift. Read unconditionally per
  // rules-of-hooks even though only the user branch uses it.
  const isResultConsumed = useResultConsumed()

  if (type === 'user') {
    const userContent = extractUserText(msg)
    // Tool results that have been consumed by their card (generic ToolCard
    // inline merge, or PlanCard / QuestionCard) are suppressed here. Only
    // ORPHAN results — whose tool_use_id matched no card — fall through to
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
    //   1. It carries at least one `tool_result` block — the SDK uses
    //      the user role to feed tool output back to the model.
    //      Notably, top-level tool calls like `Agent` produce a user
    //      frame with `tool_result` but NO `parent_tool_use_id` (the
    //      result goes to the *main* thread; parent_tool_use_id is only
    //      set for subagent-internal tool hops).
    //   2. It has a non-null `parent_tool_use_id` — this is a subagent
    //      (Task/Agent worker) internal conversation message,
    //      forwarded only when `forwardSubagentText: true`.
    // Real user input always has neither: parent_tool_use_id is null
    // AND content is either a string or an array of text blocks.
    const isSubagent = (msg as Record<string, unknown>).parent_tool_use_id != null
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
    // consumes it (deliveryStatus flips to 'consumed') the chip disappears —
    // we deliberately do NOT render a persistent 'consumed/processing' chip,
    // since every message ends up consumed and that would clutter the whole
    // transcript. The chip vanishing IS the "now being processed" signal.
    const showQueued = !sending && deliveryStatus === 'queued'
    return (
      <div className={`msg user${sending ? ' msg-sending' : ''}${showQueued ? ' msg-queued' : ''}`}>
        <button
          className="msg-copy-btn"
          onClick={() => void copyToClipboard(userContent ?? '')}
          title="Copy message"
          aria-label="Copy message"
        >
          <IconCopy size={12} />
        </button>
        <div className="msg-header">
          <span><IconUser size={12} /> you</span>
          <MessageTimestamp ms={msg.receivedAt} />
          {sending && (
            <span
              className="msg-sending-indicator"
              title="Sending — waiting for the server to acknowledge"
              aria-label="Sending"
            >
              <span className="msg-sending-spinner" aria-hidden />
              <span className="msg-sending-label">sending…</span>
            </span>
          )}
          {showQueued && (
            <span
              className="msg-queued-indicator"
              title="Queued — the assistant is finishing the current turn; this message will be picked up next"
              aria-label="Queued, waiting for the current turn to finish"
            >
              <span className="msg-queued-dot" aria-hidden />
              <span className="msg-queued-label">queued</span>
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
    // output — without this, a subagent's `tool_use: Bash` would look
    // identical to the main model running Bash.
    const isSubagent = (msg as Record<string, unknown>).parent_tool_use_id != null
    const assistantText = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n\n')
    // Suppress assistant messages with no visible content. The SDK can emit
    // a standalone assistant message whose only block is an empty
    // (signature-only) thinking block — BlockView renders it as null, but
    // the surrounding card would still paint an empty "✦ assistant" shell.
    // The visibility rule lives in willRenderEmpty so renderableItems can
    // drop these before they become empty Virtuoso items (see that fn).
    if (willRenderEmpty(msg, isCompactSummary, isResultConsumed)) return null
    return (
      <div className={`msg assistant${isSubagent ? ' subagent' : ''}`}>
        {assistantText && (
          <button
            className="msg-copy-btn"
            onClick={() => void copyToClipboard(assistantText)}
            title="Copy message"
            aria-label="Copy message"
          >
            <IconCopy size={12} />
          </button>
        )}
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
    // Render sub-second durations as ms, ≥1s as one-decimal seconds — a
    // bare "1234ms" reads slower than "1.2s" at a glance.
    const dur = durMs == null ? '' : durMs >= 1000 ? `${(durMs / 1000).toFixed(1)}s` : `${durMs}ms`
    const turns =
      typeof msg.num_turns === 'number' ? `${msg.num_turns} turn${msg.num_turns === 1 ? '' : 's'}` : ''
    // Token usage from the SDK's result payload. `input_tokens` is the
    // turn-accumulated prompt total and — per the Anthropic API — does NOT
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
    const tokens = inTok > 0 || outTok > 0 ? `${formatTokens(inTok)} in · ${formatTokens(outTok)} out` : ''
    const meta = [turns, dur, tokens, cost].filter(Boolean).join(' · ')
    return (
      <div
        className={`msg result${isInterrupted ? ' interrupted' : ''}`}
        aria-label={isInterrupted ? 'turn interrupted' : 'turn complete'}
      >
        <span className="result-mark" aria-hidden="true">{isInterrupted ? '⊘' : '✓'}</span>
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
            <>Too many requests — the API rate limit was hit. Your message was saved; send it again in a moment.</>
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
        <span aria-hidden>✦</span> Recap ({trigger})
      </span>
      <span className="recap-meta">
        {pre !== undefined && post !== undefined
          ? `${formatTokens(pre)} → ${formatTokens(post)} tokens${savings}${duration}`
          : 'Conversation compacted to fit the context window.'}
      </span>
    </div>
  )
}

/** Wire shape of an `api_retry` system frame. The fields are all
 *  optional from the renderer's perspective — older / partial frames
 *  may omit any of them — but the cast lives here once instead of at
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
 *  We stop the interval at remainingMs ≤ 0 — the next attempt is in
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
  // object means a delayMs prop change updates both together — no
  // render where deadline is "new" but now is from the previous frame.
  //
  // Caveat: when `delayMs` changes mid-component-life (the reducer
  // replaces consecutive api_retry frames in place — see
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
    // now…" stops costing us a render per second forever. A new
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
  const phase = seconds > 0 ? `retrying in ${seconds}s` : 'retrying now…'
  // Suppress the "/0" tail when max_retries is missing — better to
  // show just the attempt number than a nonsense fraction.
  const attemptText =
    maxRetries > 0 ? `attempt ${attempt}/${maxRetries}` : `attempt ${attempt}`
  return (
    <div className="msg api-retry">
      <div className="msg-header">
        <span>{label} — {phase} ({attemptText})</span>
      </div>
    </div>
  )
}

/** The "continuation" half of a compact event.
 *
 *  After `system/compact_boundary`, the SDK pushes a synthetic user-role
 *  frame whose content is a prose summary of the previous conversation
 *  — it's the next turn's input prompt, but it wasn't typed by the
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
          <div className="compact-summary-peek">{peek}…</div>
        )}
      </div>
    </div>
  )
}

/** Rendering for the session.recap field, driven by its 3-state
 *  status discriminator from the shared SessionRecap type:
 *    pending → loading skeleton (LLM call in flight)
 *    ready   → AI summary + stats
 *    error   → failure message (Alt+R retries)
 *
 *  The card is anchored at the bottom of the transcript via Virtuoso's
 *  Footer slot — see virtuosoComponents above. It is NOT a synthetic
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
            <span>Summarising the last few minutes…</span>
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

  // status === 'ready' — summary and stats may still legitimately be
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

// Memoised because parent `MessageView` re-renders on every `searchQuery`
// keystroke (the prop is part of MessageView's memo signature). Without
// this memo, every block of every message rebuilds — `<Markdown>` parses
// markdown again, base64 `<img>` re-decodes, `<ToolUseBlock>` reconciles
// its tree — once per character the user types in the search box.
// The memo is shallow-equality-correct here: `MessageView` wraps its
// `getBlocks(msg)` call in `useMemo([msg])`, so `block` references are
// stable across `searchQuery` changes. (Without that wrapper this memo
// would silently miss for string-content messages, since `getBlocks`
// returns a fresh `[{type:'text', text}]` on every call for strings.)
const BlockView = memo(function BlockView({ block, searchQuery, activeMatchIdx }: { block: Block; searchQuery?: string; activeMatchIdx?: number }) {
  if (block.type === 'text' && typeof block.text === 'string') {
    return <Markdown text={block.text} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
  }
  if (block.type === 'image') {
    const source = block.source as { type: string; data?: string; media_type?: string } | undefined
    if (source?.type === 'base64' && source.data && source.media_type) {
      return (
        // decoding="async" lets the browser decode the (potentially large)
        // base64 image off the main thread so paint isn't blocked. We
        // intentionally do NOT plumb a `min-height` reservation here —
        // bounding decode-time CLS that way also permanently letterboxes
        // small images (e.g. a 32×32 icon paste) with empty whitespace,
        // which is more visually disruptive than the brief height-pop at
        // decode time.
        <img
          className="msg-image"
          src={`data:${source.media_type};base64,${source.data}`}
          alt="pasted image"
          decoding="async"
        />
      )
    }
    return <div className="tool-input">[image: invalid]</div>
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    // Empty thinking blocks carry no visible text — the model emitted a
    // (signature-only) thinking block for a turn that needed no reasoning
    // (common for trivial continuation prompts under interleaved thinking).
    // Rendering an empty "thinking (0 chars)" <details> is pure noise, so
    // skip it entirely.
    if (block.thinking.trim().length === 0) return null
    return (
      <details style={{ color: 'var(--fg-muted)', margin: '4px 0' }}>
        <summary style={{ cursor: 'pointer' }}>thinking ({block.thinking.length} chars)</summary>
        <pre style={{ marginTop: 6, color: 'var(--code-fg)' }}>{block.thinking}</pre>
      </details>
    )
  }
  if (block.type === 'tool_use') {
    return <ToolUseBlock block={block} />
  }
  return (
    <div className="tool-input">
      [{block.type}] {formatJson(block)}
    </div>
  )
})

// Standalone orphan-result bubble: a tool_result whose tool_use_id never
// matched a seeded generic tool card (so it couldn't be merged inline).
// Delegates formatting to the shared ToolResultDetails (also used by
// ToolCard) so the preview/truncation stays identical across both sites.
const ToolResultBlock = memo(function ToolResultBlock({ block }: { block: Block }) {
  return <ToolResultDetails content={block.content} />
})

function extractUserText(msg: SdkMessage): string | null {
  const content = msg.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = (content as Block[])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
    return text || null
  }
  return null
}

/** Predicate: has this tool_use_id's result already been consumed by a card
 *  (or a stateless marker), so its standalone orphan bubble must be
 *  suppressed? Four sources count:
 *   - `toolResults` — generic tool cards (Bash/Edit/Read/…) merge the result
 *     inline (ToolCard renders it at the bottom).
 *   - `planStatus`  — ExitPlanMode results are rendered by PlanCard.
 *   - `questionAnswers` — AskUserQuestion results are rendered by QuestionCard.
 *   - `enterPlanIds` — EnterPlanMode has no card and no lifecycle map (it
 *     renders as a stateless marker), but the SDK still emits a tool_result
 *     for it; suppress that stray result. Collected by scanning items.
 *   - `subagentResultIds` — Agent/Task/Explore results are merged inline into
 *     SubagentCard once captured (ActiveSubagent.result set), so the standalone
 *     bubble is suppressed exactly like a generic tool card. Only ids whose
 *     result has landed are passed in — a still-running subagent has no bubble
 *     to suppress.
 *  Both `willRenderEmpty` and MessageView's user branch use this same predicate
 *  via ResultConsumedCtx — they can't drift because there is one shared
 *  instance per render. */
function makeResultConsumed(
  toolResults: ReadonlyMap<string, ToolResultEntry>,
  planStatus: ReadonlyMap<string, PlanStatus>,
  questionAnswers: ReadonlyMap<string, QuestionAnswerEntry[]>,
  enterPlanIds: ReadonlySet<string>,
  subagentResultIds: ReadonlySet<string>,
): (id: string) => boolean {
  return (id) =>
    toolResults.has(id) ||
    planStatus.has(id) ||
    questionAnswers.has(id) ||
    enterPlanIds.has(id) ||
    subagentResultIds.has(id)
}

/** Context carrying the single result-consumed predicate instance for one
 *  render. MessageList builds it (makeResultConsumed) and provides it; both
 *  the item filter (willRenderEmpty, called directly with the same value) and
 *  MessageView (via useResultConsumed) read it. The default rejects every id
 *  — safe because a MessageView is only ever rendered inside MessageList's
 *  provider. */
const ResultConsumedCtx = createContext<(id: string) => boolean>(() => false)
function useResultConsumed(): (id: string) => boolean {
  return useContext(ResultConsumedCtx)
}

/** Would `MessageView` render nothing for this message? Mirrors the two
 *  `return null` branches inside MessageView (the merged-tool-result /
 *  subagent-heartbeat case and the no-visible-content assistant case) so
 *  `renderableItems` can drop these messages BEFORE they become Virtuoso
 *  items — otherwise each one leaves an empty `.virtuoso-item-wrapper`
 *  that still carries `padding-bottom: 14px`, doubling the visible gap
 *  after every tool call. MUST stay in lockstep with MessageView's null
 *  logic; both call this so they can't drift. */
function willRenderEmpty(
  msg: SdkMessage,
  isCompactSummary: boolean | undefined,
  isResultConsumed: (id: string) => boolean,
): boolean {
  const type = msg.type
  // Only user / assistant frames ever render empty; everything else
  // (system / result / …) always paints something. Skip block parsing.
  if (type !== 'user' && type !== 'assistant') return false

  const blocks = getBlocks(msg)

  if (type === 'user') {
    // Compact summary always renders a CompactSummary card.
    if (isCompactSummary) return false
    const userContent = extractUserText(msg)
    const allToolBlocks = blocks.filter((b) => b.type === 'tool_result')
    const toolBlocks = allToolBlocks.filter(
      (b) => typeof b.tool_use_id !== 'string' || !isResultConsumed(b.tool_use_id),
    )
    const isSubagent = (msg as Record<string, unknown>).parent_tool_use_id != null
    const isToolResult = allToolBlocks.length > 0
    const hasOrphanResults = toolBlocks.length > 0
    if (isToolResult || isSubagent) {
      // Mirror of MessageView's user-branch null check — empty iff there's
      // neither an orphan result to draw nor any stray user text.
      return !hasOrphanResults && !userContent
    }
    // Real user message — always rendered.
    return false
  }

  // assistant — mirror of MessageView's `hasVisibleContent` check.
  const hasVisibleContent =
    Boolean(msg.error) ||
    blocks.some((b) => {
      if (b.type === 'tool_use' || b.type === 'image') return true
      if (b.type === 'text') return typeof b.text === 'string' && b.text.trim().length > 0
      if (b.type === 'thinking') return typeof b.thinking === 'string' && b.thinking.trim().length > 0
      return true
    })
  return !hasVisibleContent
}



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
          ? 'Thinking…'
          : activePhase === 'writing'
          ? 'Writing…'
          : activePhase
          ? `Calling ${activePhase.name}…`
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
            title={clickable ? `Open subagent details — ${a.label}` : a.label}
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

