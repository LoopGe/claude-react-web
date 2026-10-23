// Virtualised message transcript for one session.
//
// Uses react-virtuoso to render only the visible slice of messages,
// keeping DOM node count bounded regardless of transcript length.
// Keeps the list pinned to the bottom unless the user scrolls up — once
// they do, new messages append silently instead of yanking the viewport.
// Filters out `stream_event` partials (the final assistant message
// carries the complete content, so showing both just flickers).

import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { prefersReducedMotion } from '../utils/reduced-motion'
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso'
import { MeasuredItem } from './message-list/MeasuredItem'
import { lookupRowHeight, ROW_HEIGHT_FALLBACK_PX } from '../utils/row-height-cache'
import { PlanStatusProvider, PlanContentProvider, ToolStatusProvider, ToolResultProvider } from '../hooks/usePlanStatus'
import { QuestionAnswersProvider } from '../hooks/useQuestionAnswers'
import { TaskInfoProvider } from '../hooks/useTaskInfo'
import { McpAppsProvider } from '../hooks/useMcpApps'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { SessionCwdProvider } from '../hooks/useSessionCwd'
import { BackgroundToolProvider } from '../hooks/useBackgroundTool'
import { buildTaskStateMapFromItems, mergeTaskList, type TasklistSnapshotPayload } from '../utils/task-events'
import { cx } from '../utils/cx'
import type { ActiveSubagent, PlanStatus, ToolResultEntry, ToolStatus, TranscriptItem } from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'
import { getEnterPlanToolUseIds, isHumanUserMessage } from '../session-store/normalize'
import { useOptionalSessionField } from '../session-store/selectors'
import { useSubagentContext } from '../hooks/useSubagentContext'
import { useWorkflowContext } from '../hooks/useWorkflowContext'
import { StreamingFooter, type StreamingFooterVariant } from './message-list/transcript-chrome'
import { OverlayStreamingRegion } from './message-list/OverlayStreamingRegion'
import { ChatEmptyState } from './ChatEmptyState'
import { ErrorBoundary } from './ErrorBoundary'
import { ResultConsumedCtx } from './message-list/result-consumed-context'
import { extractUserText, makeResultConsumed, toolResultConsumedKey } from './message-list/rendering'
import { MessageView } from './message-list/MessageView'
import { userBodyFoldKey } from './message-list/fold-key'
import { countMatches } from '../search'
import { ToolGroupCard } from './message-list/ToolGroupCard'
import { BottomOverlaySpacer } from './message-list/views/frame-views'
import {
  advanceRowAnchor,
  buildTranscriptRows,
  initialRowAnchor,
  shouldLoadOlder,
  type RowAnchor,
  type TranscriptRow,
} from './message-list/transcript-rows'
import { useSubagentSyntheticRows } from './message-list/useSubagentSyntheticRows'
import { TRANSCRIPT_REVEAL_ROW_CLASS, TRANSCRIPT_ROW_CLASS, useTranscriptAnimations } from './message-list/useTranscriptAnimations'
import { useTranscriptScroll } from './message-list/useTranscriptScroll'
/** The easter-egg game only mounts after a triple-click on the empty state's
 *  icon, so it is not shipped in the entry chunk: its chunk is fetched once
 *  the empty state is on screen (see the prefetch effect in MessageList). */
type EasterEggModule = typeof import('./EasterEggGame')
let easterEggModule: EasterEggModule | null = null
const loadEasterEggGame = (): Promise<EasterEggModule> =>
  import('./EasterEggGame').then((mod) => {
    easterEggModule = mod
    return mod
  })
const EasterEggGame = lazy(() => {
  const loaded = easterEggModule
  if (loaded) {
    // Already fetched: a thenable that resolves synchronously lets React.lazy
    // render the game in this very commit (its initializer re-checks the
    // status right after `.then`). A real promise would suspend first, and
    // React then holds the empty fallback for its ~300 ms reveal throttle.
    const ready = { default: loaded.EasterEggGame }
    return { then: (resolve: (value: typeof ready) => void) => resolve(ready) } as unknown as Promise<typeof ready>
  }
  return loadEasterEggGame().then((mod) => ({ default: mod.EasterEggGame }))
})

/** Re-export type for backward compatibility (types don't affect Fast Refresh). */
export type { ActiveSubagent } from '../session-store/types'
/** `WorkingBubble` moved to ./message-list/WorkingBubble — it is turn-scoped
 *  panel chrome, not a transcript row. Re-exported here so the panels that
 *  render both keep a single import site. The panels mount the
 *  `LiveWorkingBubble` leaf, which subscribes to the live-turn telemetry
 *  itself (see there). */
export { WorkingBubble, LiveWorkingBubble } from './message-list/WorkingBubble'

/** Stable empty sentinel for `itemToVirtIdx` while no search is live. Same
 *  referential-stability rationale: a fresh `new Map()` per streaming flush would
 *  change identity and re-fire the seek effect (which then early-returns) many
 *  times per second for nothing. */
const EMPTY_VIRT_IDX = new Map<number, number>()

/** Where the live turn's text renders. 'overlay' (default): the capped
 *  bottom-overlay bubble in `.chat-bottom-stack` (current behavior).
 *  'inline': an in-flow tail row at the end of the Virtuoso list — grows
 *  with the turn, scrolls with the transcript, scrollable back through
 *  (the card-era feel). Selected by the module constant; a future UI
 *  setting threads through the `streamingMode` prop. See
 *  docs/superpowers/specs/2026-09-29-dual-mode-streaming-render-design.md.
 *  Derived from StreamingFooterVariant (transcript-chrome.tsx — the
 *  renderer's own contract) so the mode seam and the footer placement stay
 *  one union: a third value added there flows here automatically. */
export type StreamingRenderMode = StreamingFooterVariant
export const DEFAULT_STREAMING_RENDER_MODE: StreamingRenderMode = 'overlay'

/** Virtualization key of the inline streaming tail row. A module constant
 *  distinct from every message uuid, so the finalized row that replaces it
 *  can never collide in React's key space. */
const STREAMING_ROW_KEY = 'live-turn-streaming'

/** Commit band for the bottom-stack height (see the hysteresis comment on the
 *  measuring effect): sub-4px wobble never re-fires the spacer re-pin. */
const BOTTOM_STACK_COMMIT_HYSTERESIS_PX = 4

/** The inline-mode live turn as a Virtuoso data element. NOT a TranscriptRow:
 *  it has no message, no itemIndex, no plainText — consumers that iterate
 *  rows (`renderableItems`) never see it. Narrow with `'kind' in item`
 *  (TranscriptRow carries no `kind` field, so the negative branch of the
 *  narrow is TranscriptRow). */
interface StreamingRowItem {
  kind: 'streaming'
  content: string
}
type VirtuosoItem = TranscriptRow | StreamingRowItem
/** Type predicate for the inline streaming tail row. Runtime-exact: rows
 *  built by buildTranscriptRows never carry a `kind` property. A type
 *  predicate (not an inline `'kind' in x && x.kind === 'streaming'` check)
 *  because TS's composite in+negative narrowing does not exclude
 *  StreamingRowItem from the else branch — the predicate narrows both ways. */
const isStreamingRowItem = (item: VirtuosoItem): item is StreamingRowItem => 'kind' in item

/** Scroll-navigation surface registered by MessageList and held by the parent
 *  (Chat) for the pinned-header dropdown, the right-click menu, and the
 *  App-level Alt+↑/↓ and Ctrl/⌘+↑/↓ shortcuts. `to(index)` jumps to a
 *  specific renderable item (used by the dropdown); `prev`/`next` step to
 *  the adjacent user message; `prevTurn`/`nextTurn` step to the adjacent
 *  turn's final assistant message; `toBottom` re-pins the viewport to the
 *  live bottom and re-arms follow. */
export interface ScrollNavigator {
  prev: () => void
  next: () => void
  /** Jump to the previous turn's final assistant message (Ctrl/⌘+↑). */
  prevTurn: () => void
  /** Jump to the next turn's final assistant message (Ctrl/⌘+↓). */
  nextTurn: () => void
  to: (index: number) => void
  toBottom: () => void
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
  /** Whether a tool group holding a running tool auto-expands and stays
   *  open through the turn (the transcript's `autoExpandRunningGroups` UI
   *  pref, resolved by the caller as session override ?? global default).
   *  False keeps running groups folded — only their header badge changes;
   *  every fold path is unchanged. Defaults to true. Only meaningful while
   *  `toolGroupCards` is on. */
  autoExpandRunningGroups?: boolean
  /** Whether user bubbles and assistant cards render their `.msg-header`
   *  row (label + timestamp + sending/queued/processing indicators) — the
   *  `showMessageHeaders` UI pref, resolved by the caller as session
   *  override ?? global default. False renders those cards as bare
   *  content. Defaults to true. */
  showMessageHeaders?: boolean
  /** True while a /clear is in flight (trigger → session-cleared frame).
   *  Adds a blur-fade-out to the transcript and a "Clearing…" veil so the
   *  ~1.7s server teardown+respawn reads as an intentional transition
   *  instead of a frozen screen followed by a hard snap to empty. */
  clearing?: boolean
  /** Bottom-anchored overlay content rendered *below* the live streaming
   *  bubble inside `.chat-bottom-stack` (currently the task checklist and the
   *  monitor bar). Lives here rather than in Chat so its measured height can
   *  share the streaming region's spacer + re-pin machinery — one source of
   *  truth for "how much room the bottom of the transcript must reserve". */
  bottomOverlay?: React.ReactNode
  /** False while the initial replay from the server is still buffering.
   *  Gates the transcript reveal animation (the one-shot entrance fade on
   *  keyed messages) so it only fires once the replayed content has landed.
   *  No longer gates a loading skeleton — an empty transcript shows the
   *  empty-state immediately (the local /clear X→Y swap mints a fresh,
   *  history-less session; showing a skeleton there until replay-done
   *  arrived was a visible glitch under the clearing veil). */
  replayReady?: boolean
  /** True while the transcript is still settling for this session: the
   *  initial replay hasn't completed, the IDB cold-load may still prepend
   *  rows, or a tail-first backfill burst is draining. During that window the
   *  measured visible-top index churns with every prepended chunk, so the
   *  pinned "current question" header's parent notification is FROZEN (the
   *  internal visible-top tracking keeps running — navigation and search are
   *  unaffected) and exactly one notification fires when the gate lifts.
   *  User-driven loadOlder paging is deliberately NOT covered: the pin must
   *  follow the viewport the user is actively scrolling. */
  transcriptSettling?: boolean
  /** Stable key for the owning transcript (session id in the main chat).
   *  When provided, a ready transcript gets one subtle reveal on mount/load. */
  transcriptRevealKey?: string
  /** False while the hosting panel is in the keep-alive cache (not in the
   *  open view). The hide→show transitions drive the row-entrance replay:
   *  re-showing a cached panel replays the per-row cascade over the persisted
   *  DOM. Optional — callers without a caching parent (overlays, dialogs)
   *  omit it and only the natural mount animation plays. */
  panelVisible?: boolean
  /** Owning session id. When provided, the live streaming text is subscribed
   *  from the store (useOptionalSessionField) instead of flowing down as a
   *  prop — by the OverlayStreamingRegion leaf in overlay mode, so the
   *  12.5 Hz LIVE_TURN_FLUSH re-renders only that leaf (not this component,
   *  not the Chat body above it); by this component in inline mode, where
   *  the text is row data. When omitted (tests, static transcripts) the
   *  `streamingContent` prop below is used directly. */
  sessionId?: string
  /** Accumulated text from streaming deltas. Only read when `sessionId` is
   *  NOT provided (prop-fed mode). When non-null, a live "typing" bubble is
   *  rendered at the bottom of the transcript. */
  streamingContent?: string | null
  /** Which streaming render mode this transcript uses. Defaults to the
   *  module constant (currently 'overlay'). Exists as a prop so tests can
   *  force either mode and a future UI setting can thread through without
   *  touching internals. */
  streamingMode?: StreamingRenderMode
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
   *  provided AND `hasOlder` is true, scrolling to the top triggers it.
   *  Also the Retry action on the float's failure pill. */
  loadOlder?: () => Promise<number>
  /** Whether older history may exist on disk before the first shown message.
   *  Gates the scroll-to-top trigger (the float renders from loading/error
   *  alone, so this no longer gates any UI). */
  hasOlder?: boolean
  /** Seq of the oldest message in the store's seq window (null while the
   *  window is empty) — the render anchor of the seq protocol. Task 9
   *  consumes it: virtuoso's `firstItemIndex` starts at this value and is
   *  then moved by rendered-row counts (advanceRowAnchor's frontShift), so a
   *  prepended page and its anchor commit in the same render. Overlays pass
   *  nothing and keep the legacy 1e6 anchor. */
  oldestSeq?: number | null
  /** True while a loadOlder() request is in flight (gates the scroll-up
   *  trigger against double-fires; drives the top loading pill). */
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
  /** Extra node injected into the DEFAULT empty state (rendered inside
   *  ChatEmptyState below the subtitle) — the environment section showing
   *  the session's spawned-with MCP servers / plugins. Ignored when
   *  `emptyStateContent` overrides the default (Side Chat, SubagentOverlay),
   *  and the easter-egg game branch never sees it. Callers must pass a
   *  referentially stable node — an inline element fails this component's
   *  memo() shallow compare on every parent render. */
  emptyStateExtra?: ReactNode
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
  /** Server-derived full-transcript fold (useTaskList). Merged UNDER the
   *  window fold — window entries win per id. null/undefined degrade to
   *  window-only (pre-snapshot behavior). Lets TaskMutationView resolve
   *  subjects for updates whose create is out of the retained window. */
  tasklist?: TasklistSnapshotPayload | null
}

/** Stable empty-Map sentinels. Using `= new Map()` in the parameter
 *  defaults below would allocate a fresh Map on every render and defeat
 *  React.memo equality whenever a parent omits these props. */
const EMPTY_PLAN_STATUS: ReadonlyMap<string, PlanStatus> = new Map()
const EMPTY_PLAN_CONTENT: ReadonlyMap<string, string> = new Map()
const EMPTY_QUESTION_ANSWERS: ReadonlyMap<string, QuestionAnswerEntry[]> = new Map()
const EMPTY_TOOL_STATUS: ReadonlyMap<string, ToolStatus> = new Map()
const EMPTY_TOOL_RESULTS: ReadonlyMap<string, ToolResultEntry> = new Map()

/** Return a `Set` whose *identity* is stable as long as its *contents* are
 *  unchanged.
 *
 *  Plain `useMemo(() => new Set(...), [dep])` rebuilds a brand-new Set on
 *  every dep change even when the derived contents are identical (e.g.
 *  `items` got a new array reference from a streaming token flush that
 *  didn't add any EnterPlanMode).
 *
 *  The value of that stability is NOT the context any more — the context
 *  value is the identity-stable `resultConsumedCtx` wrapper and never
 *  changes (see below). It is `buildTranscriptRows`'s `useMemo`, which lists
 *  `isResultConsumed` among its deps: a spurious new Set would make the
 *  predicate a new function and force a full O(n) row-model rebuild for a
 *  change that alters no row's fate. Keep this — deleting it because "the
 *  context never changes anyway" re-introduces those rebuilds.
 *
 *  This guard compares the candidate to the previously-returned Set (same
 *  size + every element of the candidate already present in the previous)
 *  and reuses the previous reference when equal, so the predicate identity
 *  only changes when its answer would actually change. */
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

export const MessageList = memo(function MessageList({ items, working, toolGroupCards = true, autoExpandRunningGroups = true, showMessageHeaders = true, clearing, bottomOverlay, replayReady = true, transcriptSettling = false, transcriptRevealKey, panelVisible, sessionId, streamingContent, streamingMode, planStatus = EMPTY_PLAN_STATUS, planContent = EMPTY_PLAN_CONTENT, questionAnswers = EMPTY_QUESTION_ANSWERS, toolStatus = EMPTY_TOOL_STATUS, toolResults = EMPTY_TOOL_RESULTS, searchQuery, searchActiveMsgIdx, searchActiveMatchInItem, parentToolUseIdFilter, subagent, loadOlder, hasOlder = false, oldestSeq, loadingOlder = false, onRegisterNavigate, onUserMessagesChange, emptyStateContent, emptyStateExtra, expectHistory, onSwitchModel, onAbortBash, onVisibleRangeChange, onPinnedUserMessageChange, cwd, onBackgroundTool, tasklist }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // Overlay scrollbar: hides the native bar and floats a thumb over
  // .chat-messages (the scroller's parent). DOM-non-invasive, so the direct
  // scrollTop/scrollHeight measurements in useTranscriptScroll are untouched.
  // Handed to the hook, which owns the scroller element and attaches it from
  // the same ref callback that captures it.
  const setOsScroller = useOverlayScrollbar({ autoHide: 'leave' })
  const bottomStackRef = useRef<HTMLDivElement | null>(null)
  const bottomOverlayRef = useRef<HTMLDivElement | null>(null)
  // --- /clear blur ----------------------------------------------------
  // MessageList applies `.chat-messages-clearing` (see messagesClassName
  // below) while `clearing` is true — the view-only blur that signals a
  // clear in progress during the POST. There is no panel-level veil anymore;
  // the fresh session Y plays `.entering` on mount.
  // A single committed number on purpose: the stack and the overlay it
  // contains are resized by the SAME ResizeObserver burst (a fold moves both
  // in lockstep), so separate `useState`s meant two state writes per frame for
  // the length of every tween. One atomic write halves the RO-driven commits.
  // (`stack` covers the live streaming bubble above the overlay too. The
  // overlay itself is still observed, but only as a TRIGGER for the stack
  // re-read — its height value has no consumer since the jump-to-bottom
  // button was removed.)
  //
  // Measured: a 14-frame composer fold produces 28 commits — one for this
  // update, one for `useTranscriptScroll`'s spacer-keyed geometry sync. The RO
  // firing per frame is not itself a defect: a CSS height transition IS a new
  // size each frame, and the spacer must track it or the reserved room desyncs
  // (the sync's own writes are value-guarded, so a fold that changes nothing
  // observable commits nothing). The win here is removing the duplicate write,
  // not eliminating the per-frame one. The hook's listener registration is
  // deliberately kept OFF this state so the fold can't churn its listeners.
  const [bottomStackHeight, setBottomStackHeight] = useState(0)
  // Easter-egg: triple-clicking the empty-state sparkle swaps in a hidden
  // dino-style game. Local UI state only — no session/persistence concerns.
  const [gameOpen, setGameOpen] = useState(false)
  // Stable identities so EasterEggGame's [onExit]-keyed keydown effect
  // doesn't tear down/re-register on every parent re-render.
  const openEasterEgg = useCallback(() => setGameOpen(true), [])
  const closeEasterEgg = useCallback(() => setGameOpen(false), [])
  // Long user-message body expansion. Lifted HERE rather than inside
  // FoldableBody: Virtuoso unmounts rows that scroll out of the window, and
  // a fresh mount must come back already-expanded if the user expanded it
  // before. Keyed by userBodyFoldKey(msg) — CONTENT, not row id — because
  // ackUserMessage re-keys the optimistic placeholder from pendingId to the
  // server uuid after the POST resolves, and a row-id key would miss that
  // swap and snap the body shut mid-send (review finding). Set (not array)
  // → toggle is O(1) and idempotent; replaced wholesale per toggle so
  // React's identity check drives the itemContent re-render. Cleared on
  // transcriptRevealKey change (session switch / overlay retarget) —
  // expansions from one transcript are meaningless in the next.
  const [expandedBodies, setExpandedBodies] = useState<ReadonlySet<string>>(() => new Set())
  const toggleBodyExpanded = useCallback((foldKey: string) => {
    setExpandedBodies((prev) => {
      const next = new Set(prev)
      if (next.has(foldKey)) next.delete(foldKey)
      else next.add(foldKey)
      return next
    })
  }, [])
  // Clear expansions when the transcript identity changes (session switch /
  // overlay retarget). Stale keys from one transcript can never match rows
  // in the next (content-keyed), but they would otherwise accumulate for
  // the panel's lifetime. Render-phase adjustment (setState-during-render
  // for the SAME component), not an effect: React's documented "adjust
  // state on prop change" pattern, and it avoids the extra commit-per-mount
  // an effect would cost.
  const [prevRevealKey, setPrevRevealKey] = useState(transcriptRevealKey)
  if (prevRevealKey !== transcriptRevealKey) {
    setPrevRevealKey(transcriptRevealKey)
    if (expandedBodies.size > 0) setExpandedBodies(new Set())
  }
  // Which streaming render mode this transcript uses. Defaults to the module
  // constant (currently 'overlay') so production behavior is unchanged; the
  // prop exists for tests and a future UI setting.
  const resolvedMode = streamingMode ?? DEFAULT_STREAMING_RENDER_MODE
  // Live-turn text. In OVERLAY mode (the default) this component does not
  // read it at all: the capped bubble, its 12.5 Hz `streamingContent`
  // subscription and its AnimatePresence exit live in the
  // OverlayStreamingRegion leaf rendered into `.chat-bottom-stack` below, so
  // a LIVE_TURN_FLUSH re-renders only that leaf. (The scroll machinery never
  // needed this render either: the stack's ResizeObserver sees the bubble's
  // DOM growth and publishes `bottomStackHeight` itself.) In INLINE mode the
  // text IS row data — it becomes the tail element of Virtuoso's `data` —
  // so only then does MessageList subscribe (an inert subscription in
  // overlay mode). Same "" → null rule as the overlay: an empty pre-text
  // liveTurn renders no row. Prop-fed callers (no `sessionId`) use the prop.
  const inlineStoreStreamingContent = useOptionalSessionField(
    resolvedMode === 'inline' ? sessionId : undefined,
    'streamingContent',
  )
  const inlineStreamingSource = resolvedMode !== 'inline'
    ? null
    : sessionId != null ? inlineStoreStreamingContent : streamingContent
  const liveStreamingContent = inlineStreamingSource && inlineStreamingSource.length > 0 ? inlineStreamingSource : null

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

  // The result-consumed predicate. TWO identities, on purpose:
  //
  //  `isResultConsumed` is rebuilt whenever any source Map/Set changes, and
  //  its identity is a `buildTranscriptRows` dependency — rows must vanish
  //  the moment their tool_result is merged into a card (invariant I3).
  //
  //  `resultConsumedCtx` is the CONTEXT VALUE and is identity-stable for the
  //  life of the component. Every MessageView reads it via `useResultConsumed`,
  //  and a fresh function per Map change churns the context, which re-renders
  //  every mounted MessageView and defeats its own `memo`. Measured on a
  //  20-row window: 13 MessageView re-renders per tool_result with churn, 0
  //  with a stable value, identical row output (pinned by
  //  `result-consumed-identity.test.tsx`). This is the same intent
  //  `useStableSet` above documents — "the context value only changes when the
  //  predicate would actually answer differently" — carried to its conclusion:
  //  the wrapper delegates to the current predicate, so the identity never
  //  changes AND any render that does happen always sees fresh truth.
  //
  //  Stability alone would go too far the other way — a row that stays
  //  MOUNTED across a predicate flip would keep its stale filtered output —
  //  so MessageView also gets `consumedKey` as a memo signal. See
  //  `toolResultConsumedKey`.
  //
  //  The two stay separate because collapsing them would be a behavior
  //  regression: a stable identity in `buildTranscriptRows`'s dep list would
  //  stop the rebuild that drops the row, leaving a merged tool_result on
  //  screen.
  const isResultConsumed = useMemo(
    () => makeResultConsumed(toolResults, planStatus, questionAnswers, enterPlanIds, subagentResultIds, workflowResultIds),
    [toolResults, planStatus, questionAnswers, enterPlanIds, subagentResultIds, workflowResultIds],
  )
  // Latest predicate behind a ref; the context value is the one stable
  // wrapper below. The ref is written during render (not in an effect) so a
  // MessageView committing in the SAME pass as a tool_result reads the truth
  // for that pass — an effect would leave it one commit stale. Mirrors the
  // render-time ref use in `useStableSet` and the row-anchor block below.
  /* eslint-disable react-hooks/refs -- intentional render-time ref use for referential stability */
  const isResultConsumedRef = useRef(isResultConsumed)
  isResultConsumedRef.current = isResultConsumed
  /* eslint-enable react-hooks/refs */
  const resultConsumedCtx = useCallback(
    (id: string) => isResultConsumedRef.current(id),
    [],
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
      toolGroupCards,
    }),
    [items, parentToolUseIdFilter, isResultConsumed, leadingItems, trailingItems, toolGroupCards],
  )

  // The easter-egg game can only open from the default empty state, so fetch
  // its lazy chunk once that state is on screen: the triple-click then swaps
  // the game in at once, instead of showing nothing until the chunk lands.
  //
  // `items.length === 0` is the load-bearing half: the default empty state is
  // for a transcript with NO DATA, not for "data exists but nothing rendered".
  // The orphan-`result` guard in transcript-rows.ts can drop the last renderable
  // row of a session that does have history (e.g. a spawn-failure footer) —
  // keying the empty state on `renderableItems` alone would paint "Start a
  // conversation" over a failed session and arm the easter-egg prefetch there.
  const showsDefaultEmptyState =
    items.length === 0 && renderableItems.length === 0 && (!expectHistory || replayReady) && emptyStateContent == null
  useEffect(() => {
    // A failed prefetch is ignored here: opening the game runs the lazy
    // import itself.
    if (showsDefaultEmptyState) loadEasterEggGame().catch(() => {})
  }, [showsDefaultEmptyState])

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
  //
  // `topVisibleIdxRef` / `lastEmittedTopRef` live in the same DATA space the
  // anchor shifts, so a FRONT insert/removal must rebase them IN THIS BLOCK —
  // the `items-changed re-emit` effect below reads the ref after this render
  // commits, and a prepend without a rebase would resolve the pin (and
  // prev/next navigation) N rows too old until the next rangeChanged.
  // Known limit: MID-LIST row-count changes above the viewport (tool-group
  // fold/unfold, EVICT_MESSAGES) shift indices without moving the front, so
  // they don't rebase here — same staleness as before this rebase existed;
  // the next genuine rangeChanged re-measures and self-corrects. Declared
  // here because the rebase runs during render, before their old declaration
  // sites further down.
  const topVisibleIdxRef = useRef(0)
  const lastEmittedTopRef = useRef<number | null>(null)
  // Last user-message index that prev/next navigation targeted. Navigation
  // advances from HERE rather than from the live visible top, because a seek is
  // animated: a second same-direction press while the first is still in flight
  // would otherwise read a lagging top, recompute the SAME target and be
  // swallowed (measured: nine rapid "next" presses all targeted one message).
  // Invalidated whenever the user scrolls the transcript by hand (the hook's
  // `onUserScrollIntent`) or the list is rebuilt.
  const navCursorRef = useRef<number | null>(null)
  /* eslint-disable react-hooks/refs */
  // Task 9: the anchor lives in the server seq space. `oldestSeq` (the seq of
  // the first message that reached the ordered log — slot-routed frames are
  // skipped in the window's derivation) seeds the anchor on the initial build
  // and on re-anchors; ordinary prepends move it by RENDERED ROW count inside
  // advanceRowAnchor, never by the seq delta. `firstItemIndex = nextRowAnchor.index`
  // below therefore starts at oldestSeq and stays exact against the row grid
  // from then on — which is what makes `rangeStart - firstItemIndex` the true
  // row distance to the window top (shouldLoadOlder's arithmetic).
  const nextRowAnchor = advanceRowAnchor(rowAnchorRef.current, renderableItems, oldestSeq ?? null)
  rowAnchorRef.current = nextRowAnchor
  if (nextRowAnchor.frontShift != null) {
    topVisibleIdxRef.current += nextRowAnchor.frontShift
    if (lastEmittedTopRef.current != null) lastEmittedTopRef.current += nextRowAnchor.frontShift
    if (navCursorRef.current != null) navCursorRef.current += nextRowAnchor.frontShift
  } else {
    // Whole-list rebuild (replay replace / clear swap / emptied): the index
    // space is invalid. Reset and wait for the next real measurement.
    topVisibleIdxRef.current = 0
    lastEmittedTopRef.current = null
    navCursorRef.current = null
  }
  /* eslint-enable react-hooks/refs */
  const firstItemIndex = nextRowAnchor.index

  // Entrance animations (row-level msg-enter + whole-transcript reveal). The
  // gate bookkeeping runs during render so an armed flag commits with the row
  // it belongs to — see useTranscriptAnimations for the cases that must NOT
  // animate.
  const {
    messagesElRef,
    isTranscriptRevealPending,
    reveal: revealSnapshot,
    isRowEntering,
    enterNodeRef,
    handleEnterAnimationEnd,
    handleRevealRowAnimationEnd,
  } = useTranscriptAnimations({
    rows: renderableItems,
    replayReady,
    transcriptRevealKey,
  })
  // Reverse map: full items[] index —Virtuoso (renderableItems) index.
  // Needed because search indices reference the full, unfiltered list.
  //
  // Built ONLY while a search is live. Its sole consumer is the seek-to-active-
  // match effect below, but `renderableItems` gets a new identity on every
  // streaming flush, so an ungated memo walked the whole transcript (plus every
  // folded group's member list) many times per second for a map nobody read.
  //
  // The gate is deliberately `query || activeIdx >= 0`, not just the query.
  // Both props are debounced the same way (`searchActiveMsgIdx` is read out of
  // `searchMatches`, which is memoized on the same debounced query), so that is
  // NOT the asymmetry. The asymmetry is in how Chat wires them: the query prop
  // is `searchOpen ? debouncedQuery : ''`, which zeroes in the commit that
  // closes the bar, while the active-index prop has no `searchOpen` gate and
  // stays >= 0 until the emptied query finishes propagating. Keying on both
  // means the seek can never read an empty map in that window.
  // Search state lives in refs so `itemContent` stays identity-stable across
  // query changes. Virtuoso re-renders every row when itemContent's identity
  // changes — which on a search keystroke meant a mass re-render that shifted
  // Virtuoso's offsetTop and flashed all cards ("Ctrl+F 全部卡片闪烁").
  // Rows that need highlighting re-render via the searchTick field on
  // virtuosoData (see below); non-matching rows see no data change and skip.
  /* eslint-disable react-hooks/refs -- render-time ref write; documented above:
     itemContent must read the LATEST search state without being recreated. */
  const searchRef = useRef({ searchQuery, searchActiveMsgIdx, searchActiveMatchInItem })
  searchRef.current = { searchQuery, searchActiveMsgIdx, searchActiveMatchInItem }
  /* eslint-enable react-hooks/refs */
  const searchLive = !!searchQuery?.trim() || (searchActiveMsgIdx != null && searchActiveMsgIdx >= 0)
  const itemToVirtIdx = useMemo(() => {
    if (!searchLive) return EMPTY_VIRT_IDX
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
  }, [renderableItems, searchLive])

  // The scroll hook needs to report the visible-top row, and the thing that
  // consumes that report (`emitVisibleTop`, further down) needs `seekToIndex`
  // — which the hook produces. Break the cycle with a stable forwarder whose
  // target is filled in once both halves exist.
  const emitVisibleTopRef = useRef<((offsetIndex: number) => void) | null>(null)
  const forwardVisibleTop = useCallback((offsetIndex: number) => {
    emitVisibleTopRef.current?.(offsetIndex)
  }, [])
  // The hook's seek resolves rows through the OFFSET-space `data-item-index`
  // stamps, so it needs the current `firstItemIndex` anchor. The anchor VALUE
  // is computed below, in the render block that rebases it on front shifts;
  // the ref is synced to it by the effect further down. Declared here — before
  // the hook — so the hook can receive it (same pattern as emitVisibleTopRef).
  const firstItemIndexValRef = useRef(firstItemIndex)

  // Scroll behaviour (L3) lives in `message-list/useTranscriptScroll.ts`:
  // bottom-follow gate, the rAF follow animation and the three re-pin
  // backstops. `bottomStackHeight` stays here because it also drives the
  // Footer spacer below.
  const {
    following,
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
    transcriptRevealKey,
    bottomStackHeight,
    firstItemIndexRef: firstItemIndexValRef,
    onVisibleTopChange: forwardVisibleTop,
    onUserScrollIntent: () => { navCursorRef.current = null },
    panelVisible,
  })

  // Row-entrance cascade on keep-alive re-show — ALL re-showing panels. The
  // sweep animates every visible row wrapper once per hide/show cycle (dedup
  // by MESSAGE id — Virtuoso's settle re-renders replace wrapper ELEMENTS, so
  // an element flag would re-animate the same message on every replacement),
  // with a top-down spatial stagger; rows carrying their own `msg-enter`
  // entrance (genuinely-new live arrivals) are skipped; reduced motion skips
  // everything. Per the user's trade-off call, the cascade applies
  // unconditionally and bottom-pinning after a switch is best-effort.
  //
  // Known debt: this is a second, rAF-scanned entrance system beside
  // useTranscriptAnimations (which owns the fresh-mount reveal). A future
  // refactor should fold re-show replay into that hook as a container-class
  // mode so entrance semantics have one home.
  const rowReplayRef = useRef<{
    raf: number | null
    animatedIds: Set<string>
    lastKey: string | undefined
    /** Timestamp of the last hide; null = no hide since mount/swap. */
    lastHiddenAt: number | null
    emptyPasses: number
  }>({
    raf: null,
    animatedIds: new Set(),
    lastKey: undefined,
    lastHiddenAt: null,
    emptyPasses: 0,
  })
  useEffect(() => {
    const el = messagesElRef.current
    if (!el) return
    const state = rowReplayRef.current
    // Transcript identity change: the keyed div below remounts and its rows
    // play the whole-transcript reveal — never cascade on top of it.
    const keyChanged = state.lastKey !== transcriptRevealKey
    state.lastKey = transcriptRevealKey
    if (keyChanged) {
      state.animatedIds.clear()
      state.lastHiddenAt = null
      if (state.raf != null) cancelAnimationFrame(state.raf)
      return
    }
    if (panelVisible === false) {
      state.lastHiddenAt = performance.now()
      state.animatedIds.clear()
      // Best-effort element-flag clear: wrappers Virtuoso REUSES across the
      // hide must not keep a flag that would block the next sweep (the two
      // dedup layers have to agree at the layer boundary).
      el.querySelectorAll<HTMLElement>('.virtuoso-item-wrapper').forEach((w) => {
        delete w.dataset.crwReplay
      })
      return
    }
    // Visible (or a caller that never passes the prop — treated as visible).
    // Sweep only after an actual hide; the first visibility and transcript
    // swaps own their entrances. (StrictMode's double mount run also lands
    // here with lastHiddenAt === null and correctly does nothing.)
    if (state.lastHiddenAt != null) {
      state.lastHiddenAt = null
      if (prefersReducedMotion()) return
      if (state.raf != null) cancelAnimationFrame(state.raf)
      const styles = getComputedStyle(document.documentElement)
      const duration = parseFloat(styles.getPropertyValue('--motion-duration-moderate')) || 240
      const easing = styles.getPropertyValue('--motion-ease-standard').trim() || 'cubic-bezier(0.22, 1, 0.36, 1)'
      const deadline = performance.now() + 500
      const tick = () => {
        if (performance.now() > deadline) return
        // Batch reads before writes: interleaving gBCR reads with dataset
        // writes forces a style recalc per wrapper per tick (layout thrash
        // on exactly the frame that should feel instant).
        const vr = el.getBoundingClientRect()
        const pending: { w: HTMLElement; delay: number }[] = []
        el.querySelectorAll<HTMLElement>('.virtuoso-item-wrapper').forEach((w) => {
          // Two dedup layers, because wrappers fall into two failure modes:
          //  - Rows WITH a message id: Virtuoso's settle re-renders replace
          //    wrapper ELEMENTS (an element flag dies with it), so the same
          //    message must be deduped by id (survives element churn).
          //  - Rows WITHOUT one (task cards, system rows): only the element
          //    flag can dedup them — without it they would be re-animated on
          //    every sweep tick, each restart snapping opacity back to 0
          //    ("消息卡片抖动").
          if (w.dataset.crwReplay === '1') return
          const mid = w.querySelector('[data-message-id]')?.getAttribute('data-message-id') ?? ''
          if (mid && state.animatedIds.has(mid)) return
          // Optimistic sends: skip the transient row (its server-echo
          // replacement renders settled by design); the echo lands after the
          // sweep's dedup would double-animate the swap.
          if (mid.startsWith('optimistic:')) return
          const r = w.getBoundingClientRect()
          if (r.bottom <= vr.top || r.top >= vr.bottom) return
          const delay = Math.min(Math.max(0, Math.round((r.top - vr.top) / 40)) * 20, 300)
          pending.push({ w, delay })
          w.dataset.crwReplay = '1'
          if (mid) state.animatedIds.add(mid)
        })
        // A pass that finds nothing twice in a row means the settle is done —
        // stop burning frames instead of running out the whole deadline.
        if (pending.length === 0 && ++state.emptyPasses >= 2) return
        state.emptyPasses = 0
        for (const { w, delay } of pending) {
          // A row carrying its own msg-enter entrance (genuinely-new live
          // arrival during the window) must not be double-animated.
          if (w.classList.contains('msg-enter')) continue
          w.animate(
            [
              { opacity: 0, transform: 'translateY(-14px)' },
              { opacity: 1, transform: 'translateY(0px)' },
            ],
            { duration, delay, easing, fill: 'backwards' },
          )
        }
        state.raf = requestAnimationFrame(tick)
      }
      state.raf = requestAnimationFrame(tick)
    }
    return () => {
      if (state.raf != null) cancelAnimationFrame(state.raf)
    }
  }, [panelVisible, transcriptRevealKey])

  // Scroll to the active search result when it changes.
  const prevSearchActiveRef = useRef<number>(-1)
  useEffect(() => {
    if (searchActiveMsgIdx == null || searchActiveMsgIdx < 0) return
    if (searchActiveMsgIdx === prevSearchActiveRef.current) return
    prevSearchActiveRef.current = searchActiveMsgIdx
    const virtIdx = itemToVirtIdx.get(searchActiveMsgIdx)
    // A search jump is not a user-message navigation: drop the cursor so a
    // later prev/next re-anchors on whatever the user actually scrolled to.
    navCursorRef.current = null
    if (virtIdx != null) seekToIndex(virtIdx, 'center')
  }, [searchActiveMsgIdx, itemToVirtIdx, seekToIndex])

  // Measure the bottom overlay stack (live streaming bubble + task cards) and
  // publish its committed height. The stack is ALWAYS mounted, so the observer
  // attaches once and any child resize — a task appears, the card expands, the
  // bubble grows — re-fires it, with no dependency on what is inside.
  // useLayoutEffect, not useEffect: the Footer spacer is gated on the height
  // being > 0, so measuring after paint would leave the first frame with no
  // reserved room — the newest settled message would sit behind the cards for
  // that frame. Both observed elements are rendered unconditionally, so a ref
  // is always assigned by the time this runs.
  //
  // One observer and one `setState` for the whole stack (see bottomStackHeight
  // above): the stack and the overlay inside it resize together, so observing
  // the overlay is only a trigger for the stack re-read. The read is
  // `max(rect, scrollHeight)`:
  // under the 45% cap the border box is the ancestor's, while the dock/task list
  // inside can still paint taller — reserving just the clamped box would let the
  // overflow cover the last messages.
  //
  // Hysteresis on the commit: every committed height re-fires the spacer
  // layout effect in useTranscriptScroll, whose re-pin is an INSTANT
  // scrollTop write. The streaming bubble's height wobbles by 1–3px per
  // frame (line rounding, row re-measures), so without a band those frames
  // each hard-wrote scrollTop — the viewport was glued to the bottom with
  // native momentum and rubber-band killed (the 吸附感 report; measured in
  // the live app: bottomStackHeight 229→151 across ~10 frames, one pin per
  // frame). Heights within the band are an invisible reservation error (the
  // overlay has padding; follow-invariant corrects on the user's next
  // scroll); a genuine stack change always clears it.
  useLayoutEffect(() => {
    const el = bottomStackRef.current
    if (!el) return
    // Also watch the overlay + dock: once the stack is clamped at 45%, a
    // dock-only grow (preview, chips) changes scrollHeight but not the
    // border box, so a stack-only RO would go silent and leave the spacer
    // stale.
    const dock = el.querySelector<HTMLElement>('.chat-dock')
    const overlay = el.querySelector<HTMLElement>('.chat-bottom-overlay')

    const readHeight = (node: HTMLElement) =>
      Math.ceil(Math.max(node.getBoundingClientRect().height, node.scrollHeight))

    const updateHeight = () => {
      const stack = readHeight(el)
      setBottomStackHeight((prev) => {
        if (prev === stack) return prev
        if (Math.abs(stack - prev) < BOTTOM_STACK_COMMIT_HYSTERESIS_PX) return prev
        return stack
      })
    }

    updateHeight()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(updateHeight)
    ro.observe(el)
    if (dock) ro.observe(dock)
    if (overlay) ro.observe(overlay)
    return () => ro.disconnect()
  }, [])

  // --- Scroll to previous / next user message / turn-final reply ----------
  // ONE pass over the rows derives BOTH navigation target lists, so the
  // "a human user message ends a turn" boundary rule lives in exactly one
  // place (a second copy would drift):
  //   - userMsgIndices: data-array (0-based, Virtuoso `scrollToIndex` space)
  //     indices of every *real* user message — the same discriminator
  //     MessageView uses to pick the "msg user" bubble branch: a genuine
  //     human-typed top-level turn (no parent_tool_use_id, no tool_result,
  //     not synthetic). Synthetic user-role frames (task notifications, peer
  //     messages, …) are excluded so the pin header and
  //     navigate-to-user-message never target an injection.
  //   - turnFinalAssistantIndices: each turn's LAST top-level assistant
  //     message — the agent's final reply of each round, the target of
  //     prevTurn/nextTurn. A turn is the run between two HUMAN user
  //     messages: tool_result frames don't end it (the model keeps replying
  //     after tool output), and SDK auto-continuation user frames aren't
  //     human, so an auto-continued chain counts as one round ending at its
  //     true last assistant message. Sidechain frames (parent_tool_use_id
  //     set — subagent / Skill-fork output) are skipped the same way. A
  //     trailing in-progress turn commits its current last assistant
  //     message — the best available target while it streams.
  const { userMsgIndices, turnFinalAssistantIndices } = useMemo(() => {
    const users: number[] = []
    const turnFinals: number[] = []
    let lastAssistant: number | null = null
    for (let i = 0; i < renderableItems.length; i++) {
      const it = renderableItems[i]
      if (it.isCompactSummary) continue
      const msg = it.msg
      if (msg.type === 'user') {
        if (!isHumanUserMessage(msg)) continue
        users.push(i)
        if (lastAssistant != null) {
          turnFinals.push(lastAssistant)
          lastAssistant = null
        }
        continue
      }
      if (msg.type === 'assistant' && msg.parent_tool_use_id == null) lastAssistant = i
    }
    if (lastAssistant != null) turnFinals.push(lastAssistant)
    return { userMsgIndices: users, turnFinalAssistantIndices: turnFinals }
  }, [renderableItems])
  // Mirrors in refs so the (stable) navigate callback reads the latest lists
  // without being re-created — keeps its registered identity constant. Synced
  // in an effect (not during render) to respect the refs-in-render rule.
  const userMsgIndicesRef = useRef<number[]>(userMsgIndices)
  useEffect(() => {
    userMsgIndicesRef.current = userMsgIndices
  }, [userMsgIndices])
  const turnFinalAssistantIndicesRef = useRef<number[]>(turnFinalAssistantIndices)
  useEffect(() => {
    turnFinalAssistantIndicesRef.current = turnFinalAssistantIndices
  }, [turnFinalAssistantIndices])
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
  // Kept in a ref (read by the navigate callback, never rendered). Declared
  // next to the anchor block above, which rebases it on front shifts.
  // (Declared before useTranscriptScroll above — the hook's seek reads it.)
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
  // Frozen-notification gate: while the transcript is settling (initial
  // replay / tail-first backfill burst / IDB cold-load), every prepended
  // chunk churns the measured visible top, so the pin would flip with each
  // one. emitPinned keeps its internal bookkeeping off during the gate — it
  // early-returns BEFORE touching lastPinnedIdRef, so the ref keeps holding
  // the last value the PARENT actually saw and the settle-lift emit can
  // reconcile against it. Internal tracking is NOT frozen: topVisibleIdxRef
  // stays fresh for prev/next navigation and onVisibleRangeChange stays live
  // for search. The gate mirrors the prop into the ref DURING RENDER (the
  // React-documented adjust-state-on-prop-change pattern; render precedes
  // children's commit callbacks, so a Virtuoso rangeChanged firing for the
  // very commit that engages the freeze already sees it) — a passive-effect
  // sync would let one commit's worth of churned emissions leak through.
  const settlingRef = useRef(transcriptSettling)
  /* eslint-disable react-hooks/refs */
  if (settlingRef.current !== transcriptSettling) settlingRef.current = transcriptSettling
  /* eslint-enable react-hooks/refs */
  const emitPinned = useCallback(
    (topIdx: number) => {
      if (settlingRef.current) return
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
  // Settle-lift: when the gate opens, emit once with the (rebased) visible
  // top so the header appears with the settled value instead of replaying
  // every intermediate flip. Dedup makes this a no-op when the parent already
  // holds the same pin. Invariant this relies on: lastPinnedIdRef and the
  // parent's state move together everywhere except the transcriptRevealKey
  // reset below — which only re-runs within one mount for overlay retargets
  // (no pin consumer); the main panel remounts <Chat key={session.id}> per
  // session, so a "stale parent pin behind a nulled ref" strand cannot be
  // reached and the lift doesn't need to bypass the dedup.
  useEffect(() => {
    if (transcriptSettling) return
    emitPinned(topVisibleIdxRef.current)
  }, [transcriptSettling, emitPinned])
  // Publish "what is the user looking at" to the three consumers that care:
  // the pinned question header, search's nearest-match, and prev/next
  // user-message navigation. Input is Virtuoso's OFFSET space; the conversion
  // to data space lives here so it happens exactly once. (lastEmittedTopRef /
  // topVisibleIdxRef are declared at the anchor block above, which rebases
  // them on front shifts.)
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
      // Pull the previous page of history when the visible window rides close
      // to the top of the list. (Virtuoso's `startReached` requires
      // items[0].index === 0 in offset space, which only holds at the true
      // transcript start — the anchor is `oldestSeq`, so mid-history
      // scroll-ups never trip it.) `range.startIndex` is in offset
      // space already, so it compares against `firstItemIndex` directly.
      // Main-transcript views only — sub-views (SubagentOverlay /
      // WorkflowOverlay drill-ins) render a slice of the same already-paged
      // window and must not re-trigger paging on their own. The discriminators
      // are the subview markers themselves (`parentToolUseIdFilter` /
      // `subagent`), NOT `sessionId`: the main transcript and the Side Chat
      // drawer both pass a sessionId AND a working `loadOlder`.
      if (
        parentToolUseIdFilter == null &&
        !subagent &&
        shouldLoadOlder({
          rangeStart: range.startIndex,
          firstItemIndex: firstItemIndexValRef.current,
          hasOlder,
          loadingOlder,
          itemCount: renderableItems.length,
        })
      ) {
        void loadOlder?.()
      }
      // `range.startIndex` is the first RENDERED row, and
      // `increaseViewportBy.top` deliberately renders ~600px above the fold —
      // so it is NOT the visible top. Measure the real one and keep the
      // reported range only as a fallback for when nothing is measurable yet
      // (no scroller, or an empty list).
      emitVisibleTop(getVisibleTopIndex() ?? range.startIndex)
    },
    [parentToolUseIdFilter, subagent, emitVisibleTop, getVisibleTopIndex, hasOlder, loadingOlder, loadOlder, renderableItems.length],
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
    navCursorRef.current = null
    emitPinned(topVisibleIdxRef.current)
  }, [transcriptRevealKey, emitPinned])

  // Every programmatic user-message jump (prev/next AND the dropdown's
  // `to`) parks the navigation cursor on the target, so a following
  // same-direction press steps from there instead of from the transient top.
  const navigateToIndex = useCallback((target: number) => {
    navCursorRef.current = target
    seekToIndex(target, 'start')
  }, [seekToIndex])

  const navigate = useCallback((dir: 'prev' | 'next', kind: 'user' | 'turn' = 'user') => {
    // 'user' walks human user messages (Alt+↑/↓); 'turn' walks each turn's
    // final assistant message (Ctrl/⌘+↑/↓). Both share one cursor and one
    // anchoring rule — see navigateToIndex's comment.
    const indices = kind === 'turn' ? turnFinalAssistantIndicesRef.current : userMsgIndicesRef.current
    if (indices.length === 0) return
    // Anchor on the furthest-progressed of the live top and the last target:
    // while a seek is in flight the live top lags, so a naive `index < top`
    // re-selects the message the previous press already aimed at. `min`/`max`
    // by direction keeps each press advancing one target.
    const cursor = navCursorRef.current
    const anchor = cursor == null
      ? topVisibleIdxRef.current
      : dir === 'prev' ? Math.min(topVisibleIdxRef.current, cursor) : Math.max(topVisibleIdxRef.current, cursor)
    let target: number | undefined
    if (dir === 'prev') {
      // Last target strictly above the anchor.
      for (let i = indices.length - 1; i >= 0; i--) {
        if (indices[i] < anchor) { target = indices[i]; break }
      }
    } else {
      // First target strictly below the anchor.
      for (let i = 0; i < indices.length; i++) {
        if (indices[i] > anchor) { target = indices[i]; break }
      }
    }
    if (target == null) return
    navigateToIndex(target)
  }, [navigateToIndex])

  // Expose the navigator to the parent (Chat —App — session context menu +
  // pinned-header dropdown + Alt/Ctrl+arrows shortcuts). Object form so
  // callers get every jump in one stable registration.
  useEffect(() => {
    onRegisterNavigate?.({
      prev: () => navigate('prev'),
      next: () => navigate('next'),
      prevTurn: () => navigate('prev', 'turn'),
      nextTurn: () => navigate('next', 'turn'),
      to: navigateToIndex,
      toBottom: jumpToBottom,
    })
  }, [onRegisterNavigate, navigate, navigateToIndex, jumpToBottom])

  const itemContent = useCallback((_index: number, virtuosoItem: VirtuosoItem) => {
    // Search state read from a ref (not closure) so this callback stays
    // identity-stable across query changes — see searchRef above.
    const { searchQuery: sq, searchActiveMsgIdx: sami, searchActiveMatchInItem: samii } = searchRef.current
    if (isStreamingRowItem(virtuosoItem)) {
      // Inline-mode live turn row (spec §1). No data-message-id, no
      // enter-animation hooks, no reveal snapshot: it is not a message and
      // unmounts at finalize. Fresh content arrives via the item (the data
      // array is rebuilt per flush in inline mode).
      return (
        <div className={TRANSCRIPT_ROW_CLASS}>
          {/* key=variant: remounts on a variant flip so useMergedRef's
              first-render ref capture (mergedRef.ts) stays correct. */}
          <StreamingFooter key="inline" content={virtuosoItem.content} variant="inline" />
        </div>
      )
    }
    // Rebind to a const carrying the narrowed TranscriptRow type: closures
    // below (handleRowAnimationEnd) reset parameter narrowing, and every
    // `item.` reference in the body stays untouched by this rename.
    const item = virtuosoItem
    // Only pipe `activeMatchInItem` into the message that actually
    // contains the active navigation target. Every other message gets
    // `undefined` so its <mark>s render at the default colour. This
    // is what lets the user visually tell "next match" jumps from one
    // hit to another even within the same message —without per-match
    // resolution we'd be stuck at message granularity.
    const isActiveItem =
      sami != null &&
      sami >= 0 &&
      item.itemIndex === sami
    const activeMatchInItem = isActiveItem ? samii : undefined
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
    // Reveal snapshot membership is decided at the flip (see the hook): rows
    // in the snapshot play the staggered entrance; rows mounting later are
    // live arrivals and keep their msg-enter semantics. The stagger delay is
    // frozen per row at flip time.
    const isRevealRow = revealSnapshot?.rowIds.has(item.id) ?? false
    const revealStagger = revealSnapshot?.staggerById.get(item.id) ?? 0
    const className = cx(
      TRANSCRIPT_ROW_CLASS,
      item.id === firstItemId ? 'transcript-first-item' : '',
      item.id === lastItemId ? 'transcript-last-item' : '',
      isEntering ? 'msg-enter' : '',
      isRevealRow ? TRANSCRIPT_REVEAL_ROW_CLASS : '',
    )
    // Fold inputs for a real-user row, computed on the CANONICAL search
    // view: countMatches over item.plainText is the exact predicate Chat's
    // match counter uses (types.ts documents plainText as the search SSOT),
    // so force-open fires exactly when a <mark> exists in this body — a
    // raw-substring probe over the markdown source diverges (queries
    // spanning "**" find marks but no substring) and would leave the
    // navigated-to mark clipped under the fold.
    const isHumanRow = isHumanUserMessage(item.msg)
    // Key construction joins the FULL message text (multi-MB on a big
    // paste) — only pay for it when the Set can actually hold it. With an
    // empty Set, has() is false for every candidate, so '' is a correct
    // always-miss answer. The toggle side computes its key on click inside
    // MessageView, so the empty→non-empty transition never misses.
    const foldKey = isHumanRow && expandedBodies.size > 0 ? userBodyFoldKey(item.msg) : ''
    // Search force-open is deliberately independent of foldKey (which is
    // '' while the Set is empty): gate on row humanness directly so it
    // works with an empty expansion Set — the common case.
    const foldSearchHit =
      isHumanRow &&
      !!sq?.trim() &&
      countMatches(item.plainText, sq.trim()) > 0
    // Only forward `searchQuery` to rows that actually carry a match (or
    // whose plainText is unknown). When the query changes, non-matching rows
    // keep `undefined` — their memo'd MessageView/ToolGroupCard see no prop
    // change and skip the re-render.
    const searchQueryForRow =
      !sq?.trim()
        ? undefined
        : item.plainText == null || countMatches(item.plainText, sq.trim()) > 0
          ? sq
          : undefined
    // Which transcript item holds the active search match, when it landed
    // inside THIS row's tool group. The per-member gating (which member gets
    // activeMatchInItem) is owned inside ToolGroupCard.
    const groupMemberIndices = item.toolGroup?.memberItemIndices
    const activeGroupMemberIdx =
      searchActiveMsgIdx != null &&
      searchActiveMsgIdx >= 0 &&
      groupMemberIndices?.includes(searchActiveMsgIdx)
        ? searchActiveMsgIdx
        : undefined
    const rowBody = item.toolGroup ? (
          <ToolGroupCard
            members={item.toolGroup.members}
            memberItemIndices={item.toolGroup.memberItemIndices}
            searchQuery={searchQueryForRow}
            working={working}
            autoExpandRunningGroups={autoExpandRunningGroups}
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
            activeMemberItemIndex={activeGroupMemberIdx}
            // Ungated here by design: ToolGroupCard gates per member
            // internally (only the member whose itemIndex matches
            // activeMemberItemIndex forwards it as activeMatchIdx).
            activeMatchInItem={searchActiveMatchInItem}
          />
        ) : (
          <MessageView
            msg={item.msg}
            isCompactSummary={item.isCompactSummary}
            searchQuery={searchQueryForRow}
            activeMatchInItem={activeMatchInItem}
            sending={item.sending}
            deliveryStatus={item.deliveryStatus}
            working={working}
            nextItemType={nextItemTypeMap.get(item.id)}
            showMessageHeaders={showMessageHeaders}
            onSwitchModel={onSwitchModel}
            onAbortBash={onAbortBash}
            foldExpanded={expandedBodies.has(foldKey)}
            foldSearchHit={foldSearchHit}
            onToggleFold={toggleBodyExpanded}
            // Memo signal for the orphan-bubble filter. The predicate is
            // shared over an identity-stable context (see resultConsumedCtx),
            // so without this prop a row that stays mounted across a predicate
            // flip — a frame carrying user text beside its tool_results, which
            // willRenderEmpty deliberately keeps — would keep drawing the
            // bubble that was just merged into its card.
            consumedKey={toolResultConsumedKey(item.msg, resultConsumedCtx)}
          />
        )
    // One handler per row, dispatched by animationName: an element plays
    // ONE animation (the cascade winner), and its animationend tells us which.
    // transcript-item-reveal → record the snapshot row's finish (shrinks the
    // reveal; closes it at the last row); anything else on an entering row →
    // the msg-enter one-shot cleanup.
    const handleRowAnimationEnd = isEntering || isRevealRow
      ? (e: React.AnimationEvent<HTMLDivElement>) => {
          if (e.animationName === 'transcript-item-reveal') {
            handleRevealRowAnimationEnd(item.id)
          } else if (isEntering && e.target === e.currentTarget) {
            handleEnterAnimationEnd(e)
          }
        }
      : undefined
    return (
      <div
        className={className}
        style={{ '--reveal-stagger': `${revealStagger}ms` } as CSSProperties}
        data-message-id={item.id}
        data-enter-id={isEntering ? item.id : undefined}
        ref={isEntering ? enterNodeRef : undefined}
        onAnimationEnd={handleRowAnimationEnd}
      >
        {rowBody}
      </div>
    )
    // The two lifecycle indexes must be deps, not just reads: when a subagent
    // settles, a stale closure would leave its group card reading the old map
    // (and so still showing `running`). Both change only on subagent/workflow
    // events, unlike the context values that carry `messages`.
    // revealSnapshot: the reveal row class + frozen stagger come from the
    // flip-time snapshot; identity-stable between reveals.
    // resultConsumedCtx: identity-stable (useCallback []), listed because
    // itemContent reads it for `consumedKey` — a no-op for invalidation.
  }, [isRowEntering, handleEnterAnimationEnd, handleRevealRowAnimationEnd, enterNodeRef, working, showMessageHeaders, autoExpandRunningGroups, firstItemId, lastItemId, nextItemTypeMap, onSwitchModel, onAbortBash, expandedBodies, toggleBodyExpanded, subagentCtx?.index, workflowCtx?.index, revealSnapshot, resultConsumedCtx])

  // Key rows by their stable message id instead of Virtuoso's default
  // (offset-space index).
  //
  // `renderableItems` is NOT append-only: it's derived from `items` through
  // the parent_tool_use_id filter AND `willRenderEmpty(…, isResultConsumed)`,
  // AND `pushRow`'s orphan-`result` guard (transcript-rows.ts — drops a turn's
  // result footer once its user/assistant rows are gone). `isResultConsumed`
  // keeps changing during a turn (toolResults, planStatus, questionAnswers,
  // subagentResultIds, …). So a row that has already rendered can disappear
  // from the MIDDLE of the list — once its result gets merged into the owning
  // tool card, or (for a result footer) once its turn's content vanishes.
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
  // rows keep their measured heights. `item.id` is the SdkMessage uuid (or
  // a synthetic id for SubagentOverlay's injected prompt+result rows) and
  // is unique within a list — the same id the entrance-animation gate and
  // `nextItemTypeMap` already rely on.
  const computeItemKey = useCallback(
    (_index: number, item: VirtuosoItem) => ('kind' in item ? STREAMING_ROW_KEY : item.id),
    [],
  )

  const messagesClassName = [
    'chat-messages',
    isTranscriptRevealPending && 'chat-messages-reveal-pending',
    // Declarative reveal phase: the snapshot rows animate via their own
    // `transcript-reveal-row` class (applied in itemContent from the same
    // state), so this class and the row classes commit in ONE React pass —
    // a DOM-written class gets stripped by the next className re-render
    // before the animation starts (the intermittent group-switch reveal
    // skip).
    revealSnapshot != null && 'chat-messages-reveal',
    clearing && 'chat-messages-clearing',
  ]
    .filter(Boolean)
    .join(' ')

  // Inline mode appends the live turn as a TAIL data row. Overlay mode returns
  // `renderableItems` ITSELF, so Virtuoso's `data` identity stays per-items
  // stable there — the per-flush rebuild is inline-only (spec §Risks). The
  // memo keeps that guarantee exact: a rebuild happens ONLY when the stream
  // text (or the rows, or the mode) actually changes — unrelated re-renders
  // during a turn (task-card ResizeObserver commits, toolStatus/toolResults
  // map updates, fold toggles) reuse the same array identity. The tail
  // append never shifts an existing row's index, so `itemToVirtIdx` /
  // `nextItemTypeMap` / entrance-gating (all built from `renderableItems`)
  // stay valid; `handleRangeChanged` reads only `range.startIndex` (a number —
  // a tail append can never become startIndex while rows exist), so it needs
  // no guard.
  // Search tick: increments when the debounced query changes. Injected into
  // matching items so Virtuoso re-renders ONLY those rows (non-matching items
  // see no data change and skip). Without this, itemContent's stability means
  // rows never re-render and marks never appear; with a full-list rewrite the
  // mass re-render flashes all cards.
  const searchTick = useMemo(() => (searchQuery?.trim() ? searchQuery : ''), [searchQuery])
  const virtuosoData: VirtuosoItem[] = useMemo(() => {
    const base: VirtuosoItem[] =
      resolvedMode === 'inline' && liveStreamingContent != null
        ? [...renderableItems, { kind: 'streaming', content: liveStreamingContent }]
        : renderableItems
    if (!searchTick) return base
    // Shallow-copy only matching items (new object identity = Virtuoso
    // re-render). Non-matching items keep their identity.
    let copied = false
    const out: VirtuosoItem[] = new Array(base.length)
    for (let i = 0; i < base.length; i++) {
      const it = base[i]
      if ('kind' in it) { out[i] = it; continue }
      const matches = it.plainText == null || countMatches(it.plainText, searchTick.trim()) > 0
      if (matches) {
        if (!copied) { for (let j = 0; j < i; j++) out[j] = base[j]; copied = true }
        out[i] = { ...it, searchTick } as TranscriptRow
      } else {
        out[i] = it
      }
    }
    return copied ? out : base
  }, [renderableItems, resolvedMode, liveStreamingContent, searchTick])

  // Virtuoso Footer is reserved for transcript metadata and invisible bottom
  // breathing room. The bottom overlay stack (live streaming bubble + task
  // cards) is an overlay, so the spacer lets settled messages scroll underneath
  // it instead of being obscured.
  // Per-row height estimates feeding Virtuoso's `heightEstimates` — the
  // measured-height cache (see row-height-cache.ts for the consumption
  // semantics). DATA-space indexed (the library applies the firstItemIndex
  // offset internally; verified against 4.18.6), one entry per data item.
  // Consumed by Virtuoso only while its size tree is empty — i.e. at the
  // remount boundaries this cache exists for; mid-mount re-renders drop the
  // array (harmless: Virtuoso's own size cache covers that case).
  const heightEstimates: number[] = useMemo(
    () =>
      virtuosoData.map((item) => {
        const cached = 'kind' in item ? undefined : lookupRowHeight(item.id)
        return cached ?? ROW_HEIGHT_FALLBACK_PX
      }),
    [virtuosoData],
  )

  const virtuosoComponents = useMemo(() => {
    const components: Components<VirtuosoItem> = {}
    // Wrapper that records measured row heights into the cache. Module-scope
    // component (identity-stable), so this memo re-creating the object never
    // remounts items.
    components.Item = MeasuredItem as Components<VirtuosoItem>['Item']
    if (bottomStackHeight > 0) {
      components.Footer = () => (
        <BottomOverlaySpacer height={bottomStackHeight} />
      )
    }
    return components
  }, [bottomStackHeight])

  // Fold the TaskCreate/TaskUpdate stream into a Map<taskId, TaskState> so
  // the inline TaskMutationView card can resolve a TaskUpdate's subject
  // (set at create time, not repeated in the update input). `items[i].msg`
  // is lockstep-equal to the session's message log (reducer.applyMessage
  // appends both arrays in tandem), so folding from items mirrors what
  // TodoChecklist does with stream.messages.
  //
  // Window fold ⊕ server snapshot: the snapshot supplies creates the window
  // cannot see (beyond the ring/memory cap); window entries win per id.
  // Referential stability via useMemo keyed on both inputs.
  //
  // `...FromItems` rather than `buildTaskStateMap(items.map(it => it.msg))`:
  // `items` gets a new identity on every streaming flush, so the `.map()` was
  // allocating a fresh N-element array many times per second to feed a
  // function that only iterates. The fold also short-circuits on a cheap probe
  // now, so a session with no Task* events no longer indexes every
  // tool_result in the transcript per flush.
  const taskInfoMap = useMemo(
    () => mergeTaskList(tasklist, buildTaskStateMapFromItems(items)),
    [items, tasklist],
  )

  // The default empty state. Also the easter-egg game's error fallback, so a
  // failed game chunk shows exactly what the panel shows without the game.
  const defaultEmptyState = <ChatEmptyState onUnlockEasterEgg={openEasterEgg} env={emptyStateExtra} />

  return (
    <SessionCwdProvider value={cwd}>
    <BackgroundToolProvider value={onBackgroundTool}>
    <PlanStatusProvider value={planStatus}>
    <PlanContentProvider value={planContent}>
    <QuestionAnswersProvider value={questionAnswers}>
    <ToolStatusProvider value={toolStatus}>
    <ToolResultProvider value={toolResults}>
    <TaskInfoProvider value={taskInfoMap}>
    <McpAppsProvider sessionId={sessionId}>
    <ResultConsumedCtx.Provider value={resultConsumedCtx}>
    {/* data-following mirrors the follow gate for the test suite's
        FOLLOWING/AWAY assertions (see useTranscriptScroll's setFollowing) —
        no runtime CSS or JS reads it; drop it with the tests if the
        assertion surface ever moves. */}
    <div className="chat-messages-wrap" data-following={following ? 'true' : 'false'}>
      <div className="chat-messages-stage">
      <div ref={messagesElRef} key={transcriptRevealKey} className={messagesClassName}>
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
          data={virtuosoData}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={virtuosoData.length > 0 ? virtuosoData.length - 1 : 0}
          followOutput={followOutput}
          atBottomStateChange={atBottomStateChange}
          rangeChanged={handleRangeChanged}
          itemContent={itemContent}
          computeItemKey={computeItemKey}
          components={virtuosoComponents}
          heightEstimates={heightEstimates}
          // Report item-size changes synchronously inside the ResizeObserver
          // callback instead of deferring one frame. The default deferral is
          // the visible half of the scroll-up jitter: a row mounts, the frame
          // PAINTS with the stale estimate, and only the next frame's rAF
          // applies the corrected size + compensating scrollBy — one visible
          // bounce per row mount, ~±20-95px measured. Sync reporting lands
          // the size change and its compensation before paint (RO callbacks
          // run in the rendering steps), so the correction is invisible.
          skipAnimationFrameInResizeObserver
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
        {/* The empty-state block, gated on "nothing rendered" AND — for the
            DEFAULT "Start a conversation" stack — "no transcript data".
            `emptyStateContent` (Side Chat / SubagentOverlay) still shows on
            "nothing rendered" alone: a custom empty state is a legitimate
            answer to "this view has no rows", whereas the new-chat stack is
            only for a transcript with no items at all. Without the
            `items.length` half, a session whose every row is filtered out —
            e.g. a lone orphan `result` dropped by transcript-rows.ts — would
            paint "Start a conversation" over real history and arm the
            easter-egg prefetch on it. */}
        {renderableItems.length === 0 &&
          (!expectHistory || replayReady) &&
          (emptyStateContent != null || items.length === 0) && (
          <div className="chat-messages-empty">
            {/* Like the lazy Settings / Git / Tasks panels, the lazy game is
                paired with an ErrorBoundary: a rejected chunk degrades to "no
                game" instead of reaching App's per-panel boundary. The
                resetKey is constant: React.lazy caches the rejection, so a
                retry can only rethrow, and the children-identity reset would
                retry on every MessageList render. */}
            {emptyStateContent ?? (gameOpen
                ? (
                  <ErrorBoundary resetKey="easter-egg" fallback={defaultEmptyState}>
                    <Suspense fallback={null}><EasterEggGame onExit={closeEasterEgg} /></Suspense>
                  </ErrorBoundary>
                )
                : defaultEmptyState)}
          </div>
        )}
      </div>
      <div className="chat-bottom-stack" ref={bottomStackRef}>
        {/* Overlay-mode live bubble: a leaf that owns the streamingContent
            subscription + AnimatePresence exit (renders nothing until text
            arrives). */}
        {resolvedMode === 'overlay' && (
          <OverlayStreamingRegion sessionId={sessionId} streamingContent={streamingContent} />
        )}
        <div className="chat-bottom-overlay" ref={bottomOverlayRef}>
          {bottomOverlay}
        </div>
      </div>
      </div>
    </div>
    </ResultConsumedCtx.Provider>
    </McpAppsProvider>
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
