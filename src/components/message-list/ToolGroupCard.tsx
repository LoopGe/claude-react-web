// Collapsible container for a folded run of tool-only assistant rows
// (see ./transcript-rows.ts foldToolGroupRows).
//
// Settled groups collapse to a one-line header; a running tool or pending
// Plan/Question keeps the group open. Search force-expands only when the
// group's own name/input may match (tool results force-expand themselves
// via ToolResultDetails). Children are existing BlockView / ToolUseBlock
// cards — no tool view is rewritten.
//
// Collapsed header still surfaces running / waiting / failed so a failure
// or blocked turn is never hidden. The automatic post-turn fold also waits
// out a pointer resting on the card or a selection running through it — see
// isEngaged.
//
// A group of ONE tool keeps the chrome too. It does stack a second header on
// the inner ToolCard, which is a real cost — but vertical space is the
// scarcer resource here: folded, ANY single tool is one 36px line, whether it
// carries an empty Read header or a 40-line Edit diff plus its result body.
// Rendering a lone tool bare would put that payload back in the transcript.

import { memo, useEffect, useMemo, useReducer, useRef, useState, useId } from 'react'
import { AnimatedCollapse } from '../AnimatedCollapse'
import { BlockView } from './blocks'
import { usePlanStatusMap, useToolStatuses } from '../../hooks/usePlanStatus'
import { groupMayMatchSearch, summarizeToolGroup } from './tool-grouping'
import { extractToolUseId, getBlocks } from '../../session-store/normalize'
import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronRight,
  IconLoader,
  IconMessageQuestion,
} from '../icons/ToolIcons'
import type { Block, SdkMessage } from '../../types'
import type { ActiveSubagent, WorkflowRecord } from '../../session-store/types'

/** Grace period after the whole turn ends before a live group auto-folds,
 *  so results stay readable. Mid-turn tool gaps never collapse (see
 *  `wasLive && turnActive` below). */
const SETTLE_HOLD_MS = 2200

/** How often to re-ask whether the user is still on the card once the grace
 *  period has elapsed. Short enough that letting go feels like it folds
 *  immediately, long enough to be free. */
const ENGAGED_RECHECK_MS = 300

/** How long the failed member stays tinted after the badge points at it. */
const FLASH_MS = 1400

/** AnimatedCollapse's default open animation (240ms) plus a frame. */
const REVEAL_AFTER_FOLD_MS = 260

interface ToolGroupCardProps {
  members: SdkMessage[]
  memberItemIndices: number[]
  activeMemberItemIndex?: number
  activeMatchInItem?: number
  searchQuery?: string
  /** Session turn-in-flight flag from MessageList. A group that was live
   *  stays expanded for the whole turn (tool gaps included); only after
   *  the turn ends does the settle-hold collapse fire — UNLESS `closed` is
   *  true (see below). */
  working?: boolean
  /** Lifecycle records for tools that never appear in the generic toolStatus
   *  map. Passed as props rather than read from their contexts because the
   *  subagent context value also carries `messages` and so changes on every
   *  streaming flush — consuming it here would re-render every group card in
   *  the transcript per token. These two maps are identity-stable. */
  subagentStatuses?: ReadonlyMap<string, ActiveSubagent>
  workflowStatuses?: ReadonlyMap<string, WorkflowRecord>
  /** True when a non-foldable row (assistant text / thinking / a user message
   *  / AskUserQuestion) follows this group. The row model folds ALL
   *  consecutive tool-only rows into one group, so once a boundary row lands
   *  the group's membership is FINAL — future tool-only rows start a NEW
   *  group. Under that signal a settled group folds mid-turn instead of
   *  staying pinned open until the whole turn ends. Last row (nothing
   *  follows) is `false`, so live growth is still held open. */
  closed?: boolean
}

// ── Fold state machine ───────────────────────────────────────────────────
//
// Three signals decide whether a group is open, and they arrive on different
// clocks: per-tool status (context), the session's turn flag (prop), and a
// timer. Keeping them in one reducer means the transitions are named and read
// in one place instead of being spread across a pile of latch effects.

interface FoldState {
  /** Latch: this group had a running tool / pending decision at some point
   *  during the CURRENT turn. Survives the gaps between sequential tools
   *  (result landed, next tool_use not yet emitted); reset when a new turn
   *  starts so a previous turn's tail group can't flash back open. */
  wasLive: boolean
  /** Post-turn grace window is running (see SETTLE_HOLD_MS). */
  held: boolean
  /** The user's explicit toggle. `null` = follow the automatic policy. */
  userOpen: boolean | null
  /** Last observed `working`, so a false→true edge (= new turn) is visible
   *  to the reducer without a companion ref. */
  prevWorking: boolean
}

type FoldEvent =
  | { type: 'sync'; live: boolean; working: boolean }
  | { type: 'hold'; on: boolean }
  | { type: 'toggle'; open: boolean }

function foldReducer(state: FoldState, event: FoldEvent): FoldState {
  switch (event.type) {
    case 'sync': {
      let wasLive = state.wasLive || event.live
      // A working false→true edge starts a NEW turn: drop the latch. Applied
      // after the live latch so a turn boundary wins on a simultaneous
      // commit; if the group really is live, the next sync re-latches it.
      if (event.working && !state.prevWorking) wasLive = false
      if (wasLive === state.wasLive && event.working === state.prevWorking) return state
      return { ...state, wasLive, prevWorking: event.working }
    }
    case 'hold':
      return state.held === event.on ? state : { ...state, held: event.on }
    case 'toggle':
      return state.userOpen === event.open ? state : { ...state, userOpen: event.open }
  }
}

/** True when a non-collapsed text selection intersects `el`. */
function selectionTouches(el: HTMLElement | null): boolean {
  if (!el) return false
  const sel = window.getSelection?.()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
  for (let i = 0; i < sel.rangeCount; i++) {
    if (el.contains(sel.getRangeAt(i).commonAncestorContainer)) return true
  }
  return false
}

/** Is the user currently *on* this card — pointer over it, or a selection
 *  running through it? Asked at the moment the fold would happen, so it needs
 *  no state, no listeners, and costs nothing for the hundreds of cards that
 *  are not about to fold. `:hover` also covers the case a pointer-enter
 *  listener would miss: a stationary cursor that the card grew underneath. */
function isEngaged(el: HTMLElement | null): boolean {
  if (!el) return false
  return el.matches(':hover') || selectionTouches(el)
}

function initFoldState({ live, working }: { live: boolean; working: boolean }): FoldState {
  // A group that mounts already live counts as having participated; mounting
  // mid-turn is not a turn boundary (prevWorking seeds from the current flag).
  return { wasLive: live, held: false, userOpen: null, prevWorking: working }
}

function ToolGroupCardInner({
  members,
  memberItemIndices,
  activeMemberItemIndex,
  activeMatchInItem,
  searchQuery,
  working,
  subagentStatuses,
  workflowStatuses,
  closed = false,
}: ToolGroupCardProps) {
  const toolStatuses = useToolStatuses()
  const planStatuses = usePlanStatusMap()

  // Stable, page-unique id for the folded body, so the header button can point
  // aria-controls at it (multiple group cards can coexist in one transcript).
  const bodyId = useId()

  // One pass over the members' content: the per-member split renders the body,
  // the flattened list feeds the header summary / search probe. `getBlocks`
  // allocates a fresh array per call, so this must not run in render twice.
  const perMember = useMemo<Block[][]>(
    () => members.map((m) => getBlocks(m).filter((b) => b.type === 'tool_use')),
    [members],
  )
  const toolBlocks = useMemo(() => perMember.flat(), [perMember])

  const summary = useMemo(
    () => summarizeToolGroup(toolBlocks, toolStatuses, planStatuses, subagentStatuses, workflowStatuses),
    [toolBlocks, toolStatuses, planStatuses, subagentStatuses, workflowStatuses],
  )

  const hasSearchHit = useMemo(
    () => groupMayMatchSearch(toolBlocks, searchQuery),
    [toolBlocks, searchQuery],
  )
  const live = summary.anyRunning || summary.anyPendingInteractive
  const turnActive = working === true

  const [fold, dispatch] = useReducer(foldReducer, { live, working: turnActive }, initFoldState)

  useEffect(() => {
    dispatch({ type: 'sync', live, working: turnActive })
  }, [live, turnActive])

  const cardRef = useRef<HTMLDivElement | null>(null)

  // Post-turn grace: only when the session is no longer working AND this
  // group is no longer live AND it participated in the turn.
  useEffect(() => {
    if (live || turnActive) {
      dispatch({ type: 'hold', on: false })
      return
    }
    if (!fold.wasLive) return
    dispatch({ type: 'hold', on: true })
    let timer = 0
    const foldNow = () => {
      // Collapsing what someone is reading (or is mid-selection over) is the
      // one moment this animation actively gets in the way. Wait them out
      // instead — polling only ever runs for the single card that is both in
      // its grace window and under the cursor.
      if (isEngaged(cardRef.current)) {
        timer = window.setTimeout(foldNow, ENGAGED_RECHECK_MS)
        return
      }
      dispatch({ type: 'hold', on: false })
    }
    timer = window.setTimeout(foldNow, SETTLE_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [live, turnActive, fold.wasLive])

  // Automatic policy, used until the user expresses a preference:
  //  - participated in this turn and can still grow → no mid-turn fold
  //  - post-turn settle hold
  // A boundary-closed group is FINAL: it is neither pinned open for the rest
  // of the turn nor reopened by the hold (that flashed it open 2.2s after the
  // turn ended).
  const autoOpen = !closed && ((fold.wasLive && turnActive) || fold.held)

  // Search hits and live state are hard overrides — a folded running tool or
  // a folded pending plan would hide a turn the user has to act on. Anything
  // softer than that yields to an explicit toggle, so clicking the header
  // always does something visible.
  const open = hasSearchHit || live || (fold.userOpen ?? autoOpen)

  // Expand (if needed) and point at the member that failed. The flash is
  // transient on purpose: it answers "which one?" at the moment it is asked,
  // while the card's own error badge remains the standing signal.
  const [flashToolUseId, setFlashToolUseId] = useState<string | null>(null)
  const revealTimersRef = useRef<number[]>([])
  useEffect(() => () => revealTimersRef.current.forEach(window.clearTimeout), [])

  const revealFirstError = () => {
    const target = summary.firstErrorToolUseId
    if (!target) return
    revealTimersRef.current.forEach(window.clearTimeout)
    revealTimersRef.current = []
    const wasOpen = open
    if (!wasOpen) dispatch({ type: 'toggle', open: true })
    setFlashToolUseId(target)
    revealTimersRef.current.push(
      window.setTimeout(() => setFlashToolUseId(null), FLASH_MS),
      // Scrolling before the fold animation settles measures a row that is
      // still growing and lands short, so wait it out when we just opened.
      // `block: 'nearest'` is a no-op when the card is already on screen —
      // the common case for a small group, and the one where yanking the
      // transcript would be unwelcome.
      window.setTimeout(() => {
        const members = cardRef.current?.querySelectorAll('[data-member-tool-use-id]') ?? []
        for (const el of members) {
          if (el.getAttribute('data-member-tool-use-id') === target) {
            el.scrollIntoView({ block: 'nearest' })
            return
          }
        }
      }, wasOpen ? 0 : REVEAL_AFTER_FOLD_MS),
    )
  }

  const badge = summary.anyRunning ? (
    <span className="tool-status tool-status-running" title="A tool in this group is still running.">
      <IconLoader size={12} />
      <span className="tool-status-label">running</span>
    </span>
  ) : summary.anyPendingInteractive ? (
    // Its own class, not tool-status-running: nothing is in flight here, and
    // the running rule spins the glyph (IconMessageQuestion isn't rotationally
    // symmetric, so it visibly wobbles).
    <span
      className="tool-status tool-status-waiting"
      title="Waiting on you — a plan or question in this group needs a decision."
    >
      <IconMessageQuestion size={12} />
      <span className="tool-status-label">waiting</span>
    </span>
  ) : summary.anyError ? (
    // Clickable: knowing the group failed is only half an answer when the body
    // holds a dozen cards. This takes the user to the one that did.
    <button
      type="button"
      className="tool-status tool-status-error tool-group-failed-jump"
      title="A tool in this group failed — show it."
      aria-label="Show the tool call that failed"
      onClick={revealFirstError}
    >
      <IconAlertCircle size={12} />
      <span className="tool-status-label">failed</span>
    </button>
  ) : null

  return (
    <div
      ref={cardRef}
      className={
        'tool-group-card' +
        (summary.anyPendingInteractive && !summary.anyRunning ? ' tool-group-has-pending' : '')
      }
      data-state={open ? 'open' : 'closed'}
    >
      {/* Two targets, so a real <button> for each rather than one role=button
          row with a nested control (invalid, and it would swallow the jump). */}
      <div className="tool-group-summary-inner">
        <button
          type="button"
          className="tool-group-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${summary.count} tool call${summary.count === 1 ? '' : 's'}${summary.fullSummary ? `: ${summary.fullSummary}` : ''}`}
          onClick={() => dispatch({ type: 'toggle', open: !open })}
        >
          <span className="tool-group-chevron" aria-hidden>
            {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          </span>
          {/* The tally is the group's one count signal — but on a single call
              it only ever reads "1", which the entry beside it already
              implies. Give the width to the target instead. */}
          {summary.count > 1 && (
            <span className="tool-group-count" aria-hidden>
              {summary.count}
            </span>
          )}
          {/* `title` only where it earns its keep: this is a nowrap ellipsis
              line AND the budget may have dropped a tail, so hover is the way
              to see the rest. AT gets the same list via aria-label above. */}
          <span className="tool-group-names" title={summary.fullSummary}>
            {summary.entries.map((entry, i) => (
              <span key={`${entry.name}-${i}`}>
                {i > 0 ? ' · ' : ''}
                <span className="tool-group-entry-name">
                  {entry.target || entry.extra === 0
                    ? entry.name
                    : `${entry.name}×${entry.extra + 1}`}
                </span>
                {entry.target ? (
                  <>
                    {' '}
                    <span className="tool-group-entry-target">{entry.target}</span>
                  </>
                ) : null}
                {entry.target && entry.extra > 0 ? ` +${entry.extra}` : ''}
              </span>
            ))}
            {summary.overflow > 0 ? ` +${summary.overflow}` : ''}
          </span>
        </button>
        {badge}
      </div>
      {/* Animated height fold. unmountOnExit=false keeps children mounted so
          nested ToolCard / PlanCard / permission state survives a fold. */}
      <AnimatedCollapse
        open={open}
        unmountOnExit={false}
        className="tool-group-collapse"
        contentClassName="tool-group-body"
        id={bodyId}
      >
        {perMember.map((blocks, mi) => {
          const isActive =
            activeMemberItemIndex != null && memberItemIndices[mi] === activeMemberItemIndex
          return blocks.map((b, bi) => {
            const toolUseId = extractToolUseId(b)
            // The wrapper exists so the header's failed badge has something to
            // scroll to and tint — the tool views themselves are untouched.
            return (
              <div
                key={toolUseId ?? `${mi}-${bi}`}
                className={
                  'tool-group-member' +
                  (toolUseId && toolUseId === flashToolUseId ? ' tool-group-member-flash' : '')
                }
                data-member-tool-use-id={toolUseId ?? undefined}
              >
                <BlockView
                  block={b}
                  searchQuery={searchQuery}
                  activeMatchIdx={isActive ? activeMatchInItem : undefined}
                  toolResultActiveMatchIdx={isActive ? activeMatchInItem : undefined}
                />
              </div>
            )
          })
        })}
      </AnimatedCollapse>
    </div>
  )
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** `foldToolGroupRows` rebuilds `members` / `memberItemIndices` as fresh
 *  arrays on every row-model build, and the row model is rebuilt on every
 *  streaming flush. A default shallow compare therefore never hits, so every
 *  group card in the transcript re-rendered on every token. The lifecycle
 *  maps this card reads from context ARE identity-stable while nothing about
 *  them changes (see the session store's toolStatus identity tests), so
 *  comparing the two arrays by content is what makes the memo real. */
function propsEqual(a: ToolGroupCardProps, b: ToolGroupCardProps): boolean {
  return (
    a.working === b.working &&
    a.closed === b.closed &&
    a.searchQuery === b.searchQuery &&
    a.activeMemberItemIndex === b.activeMemberItemIndex &&
    a.activeMatchInItem === b.activeMatchInItem &&
    a.subagentStatuses === b.subagentStatuses &&
    a.workflowStatuses === b.workflowStatuses &&
    sameItems(a.members, b.members) &&
    sameItems(a.memberItemIndices, b.memberItemIndices)
  )
}

export const ToolGroupCard = memo(ToolGroupCardInner, propsEqual)
