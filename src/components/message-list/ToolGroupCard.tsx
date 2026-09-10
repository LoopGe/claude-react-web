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
// or blocked turn is never hidden.

import { memo, useEffect, useMemo, useState, useId, useRef } from 'react'
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
import type { SdkMessage } from '../../types'

/** Grace period after the whole turn ends before a live group auto-folds,
 *  so results stay readable. Mid-turn tool gaps never collapse (see
 *  `wasLive && working` below). */
const SETTLE_HOLD_MS = 2200

export const ToolGroupCard = memo(function ToolGroupCard({
  members,
  memberItemIndices,
  activeMemberItemIndex,
  activeMatchInItem,
  searchQuery,
  working,
  closed = false,
}: {
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
  /** True when a non-foldable row (assistant text / thinking / a user message
   *  / AskUserQuestion) follows this group. The row model folds ALL
   *  consecutive tool-only rows into one group, so once a boundary row lands
   *  the group's membership is FINAL — future tool-only rows start a NEW
   *  group. Under that signal a settled group folds mid-turn instead of
   *  staying pinned open until the whole turn ends. Last row (nothing
   *  follows) is `false`, so live growth is still held open. */
  closed?: boolean
}) {
  const toolStatuses = useToolStatuses()
  const planStatuses = usePlanStatusMap()

  // Stable, page-unique id for the folded body, so the header button can point
  // aria-controls at it (multiple group cards can coexist in one transcript).
  const bodyId = useId()

  const toolBlocks = useMemo(
    () =>
      members.flatMap((m) =>
        getBlocks(m).filter((b) => b.type === 'tool_use'),
      ),
    [members],
  )

  const summary = useMemo(
    () => summarizeToolGroup(toolBlocks, toolStatuses, planStatuses),
    [toolBlocks, toolStatuses, planStatuses],
  )

  const hasSearchHit = useMemo(
    () => groupMayMatchSearch(toolBlocks, searchQuery),
    [toolBlocks, searchQuery],
  )
  const live = summary.anyRunning || summary.anyPendingInteractive
  // Latch: once the group is seen live, keep it "participating" in the
  // current turn even between sequential tools (result landed, next tool_use
  // not yet emitted). History mounts start false.
  //
  // The latch must reset at a turn boundary: `wasLive` persists across lines
  // of the SAME turn (gaps included), but if the user sends a NEW turn while
  // the group is still the visible tail row, a stale latch would flash the
  // previous turn's group back open. A working false→true transition starts a
  // fresh turn — drop the latch and let `live` re-latch it if it participates.
  const [wasLive, setWasLive] = useState(live)
  useEffect(() => {
    if (live) setWasLive(true)
  }, [live])
  const prevWorkingRef = useRef(working)
  useEffect(() => {
    if (working && !prevWorkingRef.current) setWasLive(false)
    prevWorkingRef.current = working
  }, [working])

  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const [settleHold, setSettleHold] = useState(false)

  // Post-turn grace: only when the session is no longer working AND this
  // group is no longer live AND it participated in the turn.
  const turnActive = working === true
  useEffect(() => {
    if (live || turnActive) {
      setSettleHold(false)
      return
    }
    if (!wasLive) return
    setSettleHold(true)
    const t = window.setTimeout(() => setSettleHold(false), SETTLE_HOLD_MS)
    return () => window.clearTimeout(t)
  }, [live, turnActive, wasLive])

  // open when:
  //  - live (running / pending) or search hit  — force
  //  - was live this turn, the turn is still working, and the group is NOT
  //    closed — no mid-turn fold while it may still grow
  //  - post-turn settle hold
  //  - user's last toggle on a fully settled group
  const open =
    hasSearchHit ||
    live ||
    (wasLive && turnActive && !closed) ||
    // The turn-end settle hold only applies to the still-open tail group; a
    // group already folded by boundary closure must NOT be reopened for it
    // (that would flash it open again 2.2s after the turn ends). Once the
    // user toggles (userOpen != null), their explicit choice wins over the
    // hold — a click to fold inside the grace window takes effect immediately.
    (userOpen == null && settleHold && !closed) ||
    (userOpen ?? false)

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
    <span className="tool-status tool-status-error" title="A tool in this group failed.">
      <IconAlertCircle size={12} />
      <span className="tool-status-label">failed</span>
    </span>
  ) : null

  return (
    <div
      className={
        'tool-group-card' +
        (summary.anyError ? ' tool-group-has-error' : '') +
        (summary.anyPendingInteractive && !summary.anyRunning ? ' tool-group-has-pending' : '')
      }
      data-state={open ? 'open' : 'closed'}
    >
      <div
        className="tool-group-summary-inner"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={`${summary.count} tool call${summary.count === 1 ? '' : 's'}${summary.nameSummary ? `: ${summary.nameSummary}` : ''}`}
        title={summary.nameSummary}
        onClick={() => setUserOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setUserOpen(!open)
          }
        }}
      >
        <span className="tool-group-chevron" aria-hidden>
          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        </span>
        <span className="tool-group-count" aria-hidden>
          {summary.count}
        </span>
        <span className="tool-group-names">{summary.nameSummary}</span>
        <span className="tool-card-spacer" />
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
        {members.map((m, mi) => {
          const isActive =
            activeMemberItemIndex != null && memberItemIndices[mi] === activeMemberItemIndex
          return getBlocks(m)
            .filter((b) => b.type === 'tool_use')
            .map((b, bi) => (
              <BlockView
                key={extractToolUseId(b) ?? `${mi}-${bi}`}
                block={b}
                searchQuery={searchQuery}
                activeMatchIdx={isActive ? activeMatchInItem : undefined}
                toolResultActiveMatchIdx={isActive ? activeMatchInItem : undefined}
              />
            ))
        })}
      </AnimatedCollapse>
    </div>
  )
})
