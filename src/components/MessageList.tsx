// Virtualised message transcript for one session.
//
// Uses react-virtuoso to render only the visible slice of messages,
// keeping DOM node count bounded regardless of transcript length.
// Keeps the list pinned to the bottom unless the user scrolls up — once
// they do, new messages append silently instead of yanking the viewport.
// Filters out `stream_event` partials (the final assistant message
// carries the complete content, so showing both just flickers).

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { PlanStatusProvider, PlanContentProvider, ToolStatusProvider, ToolResultProvider } from '../hooks/usePlanStatus'
import { QuestionAnswersProvider } from '../hooks/useQuestionAnswers'
import { TaskInfoProvider } from '../hooks/useTaskInfo'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { SessionCwdProvider } from '../hooks/useSessionCwd'
import { BackgroundToolProvider } from '../hooks/useBackgroundTool'
import type { SdkMessage } from '../types'
import { buildTaskStateMap } from '../utils/task-events'
import type { ActiveSubagent, PlanStatus, ToolResultEntry, ToolStatus, TranscriptItem } from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'
import { getEnterPlanToolUseIds, isHumanUserMessage } from '../session-store/normalize'
import { useSubagentContext } from '../hooks/useSubagentContext'
import { useWorkflowContext } from '../hooks/useWorkflowContext'
import { IconArrowDown } from './icons/ToolIcons'
import { OlderHistoryHeader, StreamingFooter } from './message-list/transcript-chrome'
import { ChatEmptyState } from './ChatEmptyState'
import { EasterEggGame } from './EasterEggGame'
import { ResultConsumedCtx } from './message-list/result-consumed-context'
import { extractUserText, makeResultConsumed } from './message-list/rendering'
import { MessageView } from './message-list/MessageView'
import { ToolGroupCard } from './message-list/ToolGroupCard'
import { StreamingOverlaySpacer } from './message-list/views/frame-views'
import {
  advanceRowAnchor,
  buildTranscriptRows,
  initialRowAnchor,
  type RowAnchor,
  type TranscriptRow,
} from './message-list/transcript-rows'
import { useSubagentSyntheticRows } from './message-list/useSubagentSyntheticRows'
import { useTranscriptAnimations } from './message-list/useTranscriptAnimations'
import { useTranscriptScroll } from './message-list/useTranscriptScroll'

/** Re-export type for backward compatibility (types don't affect Fast Refresh). */
export type { ActiveSubagent } from '../session-store/types'
/** `WorkingBubble` moved to ./message-list/WorkingBubble — it is turn-scoped
 *  panel chrome, not a transcript row. Re-exported here so the panels that
 *  render both keep a single import site. */
export { WorkingBubble } from './message-list/WorkingBubble'

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
  /** Whether consecutive tool-only rows fold into collapsible group cards
   *  (the transcript's `toolGroupCards` UI pref, resolved by the caller as
   *  session override ?? global default). False renders every tool row as
   *  its own card with no fold chrome. Defaults to true. */
  toolGroupCards?: boolean
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
  /** The subagent record this list is the inner conversation OF. Set by
   *  SubagentOverlay alongside `parentToolUseIdFilter`; the row model uses it
   *  to synthesise the two rows the parent filter can't reach — the input
   *  prompt (never echoed as a child frame for an async subagent) and, for a
   *  synchronous subagent, the reply (which lands as the Agent tool_result on
   *  the MAIN thread). See `useSubagentSyntheticRows`.
   *
   *  Deliberately an explicit prop rather than something read off the subagent
   *  context by `parentToolUseIdFilter`: WorkflowOverlay filters by a child
   *  agent's tool_use id inside the same provider, and must NOT grow these
   *  synthetic rows. */
  subagent?: ActiveSubagent | null
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

/** Stable empty-Map sentinels. Using `= new Map()` in the parameter
 *  defaults below would allocate a fresh Map on every render and defeat
 *  React.memo equality whenever a parent omits these props. */
const EMPTY_PLAN_STATUS: ReadonlyMap<string, PlanStatus> = new Map()
const EMPTY_PLAN_CONTENT: ReadonlyMap<string, string> = new Map()
const EMPTY_QUESTION_ANSWERS: ReadonlyMap<string, QuestionAnswerEntry[]> = new Map()
const EMPTY_TOOL_STATUS: ReadonlyMap<string, ToolStatus> = new Map()
const EMPTY_TOOL_RESULTS: ReadonlyMap<string, ToolResultEntry> = new Map()

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

export const MessageList = memo(function MessageList({ items, working, toolGroupCards = true, clearing, replayReady = true, transcriptRevealKey, streamingContent, apiRetry, planStatus = EMPTY_PLAN_STATUS, planContent = EMPTY_PLAN_CONTENT, questionAnswers = EMPTY_QUESTION_ANSWERS, toolStatus = EMPTY_TOOL_STATUS, toolResults = EMPTY_TOOL_RESULTS, searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, parentToolUseIdFilter, subagent, loadOlder, hasOlder = false, loadingOlder = false, onRegisterNavigate, onUserMessagesChange, emptyStateContent, expectHistory, onSwitchModel, onAbortBash, onVisibleRangeChange, onPinnedUserMessageChange, cwd, onBackgroundTool }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // Overlay scrollbar: hides the native bar and floats a thumb over
  // .chat-messages (the scroller's parent). DOM-non-invasive, so the direct
  // scrollTop/scrollHeight measurements in useTranscriptScroll are untouched.
  // Handed to the hook, which owns the scroller element and attaches it from
  // the same ref callback that captures it.
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

  // Rows the parent_tool_use_id filter can't reach: a subagent's input prompt
  // and (for a synchronous one) its reply. Empty for every non-subagent list.
  const { leadingItems, trailingItems } = useSubagentSyntheticRows(
    parentToolUseIdFilter,
    subagent ?? undefined,
    items,
  )

  // The row model (L1) lives in `message-list/transcript-rows.ts` — a pure
  // module, so "which rows exist, in what order, under what identity" is
  // answered the same way for the main transcript and for every overlay that
  // reuses this component, and is unit-testable without a DOM.
  const { rows: renderableItems, firstItemId, lastItemId, nextItemTypeMap } = useMemo(
    () => buildTranscriptRows({
      items,
      parentToolUseIdFilter,
      isResultConsumed,
      leadingItems,
      trailingItems,
      apiRetry,
      toolGroupCards,
    }),
    [items, parentToolUseIdFilter, isResultConsumed, leadingItems, trailingItems, apiRetry, toolGroupCards],
  )

  // --- Reverse infinite scroll: keep the viewport anchored on prepend ----
  // The offset arithmetic lives in `advanceRowAnchor` (see transcript-rows.ts
  // for why it keys on row id and how it distinguishes a front prepend from a
  // front removal). Held in a ref and folded DURING render — not in an effect
  // — because Virtuoso needs `firstItemIndex` to commit in the same render
  // that grows `data` at the front, otherwise the viewport jumps for a frame.
  // The fold is idempotent w.r.t. the current render and self-corrects on the
  // next one, so a discarded concurrent render costs at most one missed
  // adjustment and never compounds.
  const rowAnchorRef = useRef<RowAnchor>(initialRowAnchor())
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
  const nextRowAnchor = advanceRowAnchor(rowAnchorRef.current, renderableItems)
  rowAnchorRef.current = nextRowAnchor
  /* eslint-enable react-hooks/refs */
  const firstItemIndex = nextRowAnchor.index

  // Entrance animations (row-level msg-enter + whole-transcript reveal). The
  // gate bookkeeping runs during render so an armed flag commits with the row
  // it belongs to — see useTranscriptAnimations for the cases that must NOT
  // animate.
  const {
    messagesElRef,
    isTranscriptRevealPending,
    handleTranscriptRevealEnd,
    isRowEntering,
    enterNodeRef,
    handleEnterAnimationEnd,
  } = useTranscriptAnimations({
    rows: renderableItems,
    replayReady,
    transcriptRevealKey,
  })
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
      const row = renderableItems[vi]
      if (row.toolGroup) {
        // Every member's items[] index must resolve to the group row so
        // search seek-to-match lands on the folded card.
        for (const ii of row.toolGroup.memberItemIndices) map.set(ii, vi)
      } else {
        map.set(row.itemIndex, vi)
      }
    }
    return map
  }, [renderableItems])

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
  // The scroll hook needs to report the visible-top row, and the thing that
  // consumes that report (`emitVisibleTop`, further down) needs `seekToIndex`
  // — which the hook produces. Break the cycle with a stable forwarder whose
  // target is filled in once both halves exist.
  const emitVisibleTopRef = useRef<((offsetIndex: number) => void) | null>(null)
  const forwardVisibleTop = useCallback((offsetIndex: number) => {
    emitVisibleTopRef.current?.(offsetIndex)
  }, [])

  // Scroll behaviour (L3) lives in `message-list/useTranscriptScroll.ts`:
  // bottom-follow gate, jump-to-bottom state, unseen badge, the rAF follow
  // animation and the three re-pin backstops. `streamingOverlayHeight` stays
  // here because it also drives the Footer spacer below.
  const {
    atBottom,
    canJumpToBottom,
    unseenCount,
    scrollerRefCb,
    followOutput,
    atBottomStateChange,
    jumpToBottom,
    seekToIndex,
    getVisibleTopIndex,
  } = useTranscriptScroll({
    virtuosoRef,
    setOsScroller,
    rowCount: renderableItems.length,
    itemCount: items.length,
    trackedCount,
    transcriptRevealKey,
    streamingOverlayHeight,
    onVisibleTopChange: forwardVisibleTop,
  })

  // Scroll to the active search result when it changes.
  const prevSearchActiveRef = useRef<number>(-1)
  useEffect(() => {
    if (searchActiveMsgIdx == null || searchActiveMsgIdx < 0) return
    if (searchActiveMsgIdx === prevSearchActiveRef.current) return
    prevSearchActiveRef.current = searchActiveMsgIdx
    const virtIdx = itemToVirtIdx.get(searchActiveMsgIdx)
    if (virtIdx != null) seekToIndex(virtIdx, 'center')
  }, [searchActiveMsgIdx, itemToVirtIdx, seekToIndex])

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
  // Publish "what is the user looking at" to the three consumers that care:
  // the pinned question header, search's nearest-match, and prev/next
  // user-message navigation. Input is Virtuoso's OFFSET space; the conversion
  // to data space lives here so it happens exactly once.
  const lastEmittedTopRef = useRef<number | null>(null)
  const emitVisibleTop = useCallback(
    (offsetIndex: number) => {
      const idx = offsetIndex - firstItemIndexValRef.current
      if (lastEmittedTopRef.current === idx) return
      lastEmittedTopRef.current = idx
      topVisibleIdxRef.current = idx
      onVisibleRangeChange?.(idx)
      emitPinned(idx)
    },
    [onVisibleRangeChange, emitPinned],
  )
  useEffect(() => {
    emitVisibleTopRef.current = emitVisibleTop
  }, [emitVisibleTop])
  const handleRangeChanged = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      // `range.startIndex` is the first RENDERED row, and
      // `increaseViewportBy.top` deliberately renders ~600px above the fold —
      // so it is NOT the visible top. Measure the real one and keep the
      // reported range only as a fallback for when nothing is measurable yet
      // (no scroller, or an empty list).
      emitVisibleTop(getVisibleTopIndex() ?? range.startIndex)
    },
    [emitVisibleTop, getVisibleTopIndex],
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
    seekToIndex(target, 'start')
  }, [seekToIndex])

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

  const itemContent = useCallback((_index: number, item: TranscriptRow) => {
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
    const isEntering = isRowEntering(item.id)
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
        {item.toolGroup ? (
          <ToolGroupCard
            members={item.toolGroup.members}
            memberItemIndices={item.toolGroup.memberItemIndices}
            searchQuery={searchQuery}
            working={working}
            // Agent/Task/Explore and Workflow are absent from toolStatus by
            // design; without their own maps the header would read every
            // settled one as still running (and never fold the group).
            subagentStatuses={subagentCtx?.index}
            workflowStatuses={workflowCtx?.index}
            // A group is closed the moment a non-foldable row follows it:
            // nextItemTypeMap holds an entry for every folded row that is NOT
            // the last one (consecutive eligible rows were folded into the
            // same group), so its presence here means a boundary row landed.
            closed={nextItemTypeMap.has(item.id)}
            activeMemberItemIndex={
              searchActiveMsgIdx != null &&
              searchActiveMsgIdx >= 0 &&
              item.toolGroup.memberItemIndices.includes(searchActiveMsgIdx)
                ? searchActiveMsgIdx
                : undefined
            }
            activeMatchInItem={
              searchActiveMsgIdx != null &&
              searchActiveMsgIdx >= 0 &&
              item.toolGroup.memberItemIndices.includes(searchActiveMsgIdx)
                ? searchActiveMatchInItem
                : undefined
            }
          />
        ) : (
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
        )}
      </div>
    )
    // The two lifecycle indexes must be deps, not just reads: when a subagent
    // settles, a stale closure would leave its group card reading the old map
    // (and so still showing `running`). Both change only on subagent/workflow
    // events, unlike the context values that carry `messages`.
  }, [searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, isRowEntering, handleEnterAnimationEnd, enterNodeRef, working, firstItemId, lastItemId, nextItemTypeMap, onSwitchModel, onAbortBash, subagentCtx?.index, workflowCtx?.index])

  // Key rows by their stable message id instead of Virtuoso's default
  // (offset-space index).
  //
  // `renderableItems` is NOT append-only: it's derived from `items` through
  // the parent_tool_use_id filter AND `willRenderEmpty(…, isResultConsumed)`,
  // and `isResultConsumed` keeps changing during a turn (toolResults,
  // planStatus, questionAnswers, subagentResultIds, …). So a row that has
  // already rendered can disappear from the MIDDLE of the list once its
  // result gets merged into the owning tool card.
  //
  // With index keys, a mid-list removal makes React re-map every following
  // DOM node one slot up: the node that was rendering message N now renders
  // message N+1, keeping N's already-measured height and mounted subtree
  // state (expanded/collapsed tool cards, scroll positions inside diff
  // bodies). Virtuoso's size cache is index-based and can't be told about a
  // middle removal — `firstItemIndex` only expresses front insert/remove — so
  // every offset past the removal point is computed from a neighbour's
  // height. Scrolling into that region reserved the wrong space and painted
  // blank.
  //
  // Keying by id makes React preserve each row's node across mid-list
  // mutations, so only the removed row's DOM goes away and the surviving
  // rows keep their measured heights. `item.id` is the SdkMessage uuid (or a
  // synthetic id for the api_retry divider / SubagentOverlay's injected
  // prompt+result rows) and is unique within a list — the same id the
  // entrance-animation gate and `nextItemTypeMap` already rely on.
  const computeItemKey = useCallback(
    (_index: number, item: TranscriptRow) => item.id,
    [],
  )

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
          computeItemKey={computeItemKey}
          components={virtuosoComponents}
          // Pre-render ~600px of items on BOTH sides of the fold.
          //
          // bottom: a new tail item (e.g. a tool card arriving mid-stream)
          // mounts at an estimated height, so totalHeight is wrong for one
          // frame; the ResizeObserver then corrects it and `followOutput`
          // re-pins to bottom, yanking scrollTop by (actual — estimated).
          // That one-frame scroll correction shifts the streaming footer
          // bubble as a block — the "streaming footer" jitter. Pre-rendering
          // tail items offscreen means they're already measured before
          // becoming the anchor, so no post-insert correction happens.
          //
          // top: with zero upward overscan a scroll-up had to mount AND
          // measure the incoming rows inside the scroll frame. Transcript
          // rows are expensive (Markdown, syntax-highlighted tool output,
          // DiffView, nested SubagentCards) and the render lands a frame or
          // more late, so the band above the fold painted empty — the
          // "scrolling up shows a blank screen" report. Worst in the
          // SubagentOverlay drawer, whose min(50%, 640px) width makes every
          // row taller (more wrapping) and whose transcript is almost
          // entirely tool cards. Rows are memoized, so the extra offscreen
          // DOM is cheap.
          increaseViewportBy={{ top: 600, bottom: 600 }}
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

