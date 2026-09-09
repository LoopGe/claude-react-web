// Subagent placeholder card — rendered in place of the default
// ToolUseBlock for Agent / Task / Explore tool calls.
//
// Acts as the persistent inline entry point to the SubagentOverlay
// (the per-panel right-side overlay that holds the subagent's full
// internal conversation). The user sees a one-line summary —
// status, elapsed, tool count — and clicks to open the overlay.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useSubagentContext } from '../hooks/useSubagentContext'
import { useBackgroundTool } from '../hooks/useBackgroundTool'
import { useEnterOnArrival } from '../hooks/useEnterOnArrival'
import { ElapsedTimer } from './ElapsedTimer'
import { BackgroundToolButton, ToolResultSection } from './ToolCard'
import { GridClipEnter } from './GridClipEnter'
import { AnimatedDetails } from './AnimatedCollapse'
import type { SubagentChildCall } from '../session-store/types'
import { IconCheck, IconCircleDot, IconAlertTriangle, IconChevronRight, IconExternalLink } from './icons/ToolIcons'

interface Props {
  toolUseId: string
  /** Fallback label — shown when the subagent hasn't been recorded in
   *  the index yet (stale state during a hard refresh, etc.). */
  fallbackLabel?: string
}

export const SubagentCard = memo(function SubagentCard({ toolUseId, fallbackLabel }: Props) {
  const ctx = useSubagentContext()
  // Session-level per-tool background action (same context the Bash card
  // reads). Only used for synchronous subagents — see the actions row below.
  const backgroundTool = useBackgroundTool()
  // When rendered outside a SubagentProvider (e.g. tests, exports), fall
  // back to a minimal inline display rather than crashing.
  const record = ctx?.index.get(toolUseId)
  const status = record?.status ?? 'running'
  const label = record?.label ?? fallbackLabel ?? 'Subagent'
  const startedAt = record?.startedAt
  const endedAt = record?.endedAt
  const result = record?.result
  const resultEntering = useEnterOnArrival(result)
  const isAsync = record?.isAsync
  // Both 'running' (synchronous, pre-tool_result) and 'background' (async,
  // ack landed but still working) are live states — the elapsed timer must
  // keep ticking for either. 'pending' (the post-turn-end form of
  // 'background') is still in-flight but the parent turn has ended, so the
  // timer stops and elapsed freezes at the last-known endedAt — the
  // completion signal will refresh endedAt when it lands.
  const isRunning = status === 'running' || status === 'background'
  // Arrival gates for the two mid-turn rows that mount/dismount while the
  // card is live (the synchronous backgournd-action row and the ~30s
  // progress summary line). `useEnterOnArrival` arms each only on a genuine
  // null → non-null transition during THIS mounted card's lifetime — not on
  // a Virtuoso scroll-back remount, where `record`/`progressSummary` are
  // already present and the row would otherwise replay its grid-clip
  // entrance every time the transcript scrolls through the card. Mirrors
  // the existing `resultEntering` gate above.
  const showActions = record != null && status === 'running' && !isAsync && backgroundTool
  const showProgress = !!record?.progressSummary && isRunning
  const actionsEntering = useEnterOnArrival(showActions ? record : null)
  const progressEntering = useEnterOnArrival(showProgress ? record?.progressSummary : null)

  // The elapsed display self-ticks inside <ElapsedTimer> (a memoized leaf), so
  // a running subagent no longer re-renders this whole card — and its child
  // tool-call list — once per second inside the virtualized transcript.
  // `live={isRunning}` carries the async nuance: a 'background' record is still
  // working even though the reducer advances its endedAt to the latest child
  // frame, so it must keep counting from `now` rather than freeze at endedAt.

  // Pre-computed in the reducer's updateIndexes — no message scanning needed.
  const toolCount = record?.toolCount ?? 0

  // Structured child-call list (方案B): the subagent's internal tool calls,
  // indexed in the reducer. Rendered as an expandable list inside the card.
  const childToolCalls = record?.childToolCalls
  const hasChildren = !!childToolCalls && childToolCalls.length > 0

  const statusIcon =
    status === 'running' || status === 'background' || status === 'pending' || status === 'dismissed' ? <IconCircleDot size={12} />
    : status === 'done' ? <IconCheck size={12} />
    : <IconAlertTriangle size={12} />

  const handleOpen = () => {
    if (!ctx) return
    ctx.open(toolUseId)
  }

  return (
    <div className={`subagent-card subagent-card-${status}`}>
      <button
        type="button"
        className="subagent-card-header"
        onClick={handleOpen}
        disabled={!ctx}
        title={ctx ? `Open subagent details — ${label}` : 'Subagent details unavailable'}
      >
        <span className="subagent-card-marker" aria-hidden><IconChevronRight size={12} /></span>
        <span className="subagent-card-title">Subagent</span>
        <span className="subagent-card-label">{label}</span>
        <span className="subagent-card-meta">
          <span className="subagent-card-status" aria-label={status}>
            {statusIcon}
          </span>
          {isAsync != null && (
            <span
              className={`subagent-card-mode subagent-card-mode-${isAsync ? 'async' : 'sync'}`}
              title={isAsync ? 'Background/async — the subagent runs independently and the result returns immediately' : 'Synchronous — the parent agent waits for this subagent to finish'}
            >
              {isAsync ? 'async' : 'sync'}
            </span>
          )}
          <ElapsedTimer
            startedAt={startedAt}
            endedAt={endedAt}
            live={isRunning}
            className="subagent-card-elapsed"
          />
          {toolCount > 0 && (
            <span className="subagent-card-tools">
              {toolCount} {toolCount === 1 ? 'tool' : 'tools'}
            </span>
          )}
          <span className="subagent-card-open" aria-hidden><IconExternalLink size={12} /></span>
        </span>
      </button>
      {/* Per-card background action for a SYNCHRONOUS in-flight subagent
          (status 'running' — the parent turn is blocked on it). The header
          above is a single <button> (drill-in), so a nested button would be
          invalid; this row is a sibling instead. 'background' / 'pending'
          records are already async (isBackgrounded or post-turn-end) —
          nothing to detach. Requires a POSITIVE record: the defaulted
          'running' status for a missing record (stale hard-refresh index)
          is absence of data, not evidence the subagent is live — an action
          must not gate on it. Clicking detaches exactly this subagent via
          POST /tasks/background { toolUseId } and the turn continues. */}
      {showActions && (
        <GridClipEnter entering={actionsEntering}>
          <div className="subagent-card-actions">
            <BackgroundToolButton
              onClick={() => backgroundTool(toolUseId)}
              title="Background this subagent — the turn continues while it runs in the background task list (Alt+B backgrounds every running task)"
              ariaLabel="Background this subagent"
            />
          </div>
        </GridClipEnter>
      )}
      {/* Present-tense progress summary (agentProgressSummaries —
          task_progress.summary, ~every 30s). Only shown while the subagent
          is live; the record clears it when the task reaches a terminal
          state, so a finished card doesn't show stale progress text. */}
      {showProgress && (
        <GridClipEnter entering={progressEntering}>
          <div className="subagent-card-progress" title={record?.progressSummary ?? ''}>
            {record?.progressSummary}
          </div>
        </GridClipEnter>
      )}
      {/* Structured child-call list: which internal tools the subagent ran,
          each with its status + expandable result. Auto-expands while the
          subagent is live (running/background) and auto-collapses once it
          settles; the user can toggle either way. Rendered above the final
          result so the flow reads top-to-bottom: what it did → what it
          returned. */}
      {hasChildren && (
        // `pending` counts as live here (unlike the elapsed timer, which
        // freezes): an async subagent whose parent turn ended keeps streaming
        // child frames, so the list must stay open while rows are still
        // arriving instead of auto-collapsing mid-work.
        <SubagentChildList
          calls={childToolCalls!}
          live={isRunning || status === 'pending'}
        />
      )}
      {result && <ToolResultSection result={result} entering={resultEntering} />}
    </div>
  )
})

/** Expandable list of a subagent's internal tool calls.
 *
 *  ONE list, in place: every call is a row from the moment its tool_use
 *  lands. A running row pulses; when the tool_result arrives the SAME row
 *  flips its status dot and becomes expandable. Previously running and
 *  settled lived in two DOM regions, so a fast tool flickered (live
 *  highlight mounts → 160ms collapse → 240ms row reveal). Merging them
 *  removes the rebuild; entrance animation fires only when a new
 *  toolUseId first appears.
 *
 *  The whole section opens while the subagent is live and collapses when
 *  it settles (via AnimatedDetails' `open` prop), but stays
 *  user-toggleable. */
const SubagentChildList = memo(function SubagentChildList({
  calls,
  live,
}: {
  calls: SubagentChildCall[]
  live: boolean
}) {
  // Auto-expand while live, auto-collapse when settled — but let the user
  // override. `userToggled` tracks a manual open/close so the live→settled
  // transition doesn't yank the panel out from under a user who opened it.
  const [open, setOpen] = useState(live)
  const [userToggled, setUserToggled] = useState(false)
  useEffect(() => {
    if (!userToggled) setOpen(live)
  }, [live, userToggled])

  const doneCount = useMemo(
    () => calls.reduce((n, c) => n + (c.status === 'running' ? 0 : 1), 0),
    [calls],
  )
  const hasRunning = doneCount < calls.length

  // Arrival gate for the row list: track which child ids we've already
  // rendered so a genuinely new row plays the grid-clip entrance, while
  // rows present at first mount (a card scrolled back into view, a replay
  // rebuild) do NOT replay it. Mirrors the useEnterOnArrival pattern the
  // card already uses for its actions/progress rows — the gate lives in
  // this persistent parent, never in the conditionally-mounted
  // GridClipEnter.
  //
  // Keyed on `calls` (the moment a tool_use lands), NOT on settle: a row
  // now mounts as `running` and stays mounted through the status flip, so
  // the entrance must fire once at first appearance. Seeding during the
  // first render — not in the post-commit effect — keeps scroll-back
  // remounts from replaying the reveal (GridClipEnter seeds `revealing`
  // from `entering`). SubagentCard lives in the virtualized transcript,
  // so an unseeded gate re-animated the whole list on every scroll
  // through the card. Mirrors how useEnterOnArrival captures its initial
  // value into prevRef.
  const seenRef = useRef<Set<string> | null>(null)
  const firstRender = seenRef.current === null
  if (seenRef.current === null) {
    seenRef.current = new Set(calls.map((c) => c.toolUseId))
  }
  const seen = seenRef.current
  const enteringIds = new Set<string>()
  if (!firstRender) {
    for (const c of calls) {
      if (!seen.has(c.toolUseId)) enteringIds.add(c.toolUseId)
    }
  }
  useEffect(() => {
    for (const c of calls) seen.add(c.toolUseId)
  }, [calls, seen])

  // Only a LIVE record may advertise in-flight work. The reducer's turn-end
  // sweep settles running child calls on the sync-orphan path, but three other
  // transitions to a terminal status (dismiss, the pending-timeout sweep,
  // task-notification completion) can leave a `running` row behind — without
  // this guard a finished subagent rendered pulsing dots and an accent
  // "· running" count forever. The stranded row stays visible (so the tool
  // isn't hidden) but its pulse is suppressed via `pulse={showLive}`.
  const showLive = live && hasRunning

  const summary = (
    <span className="subagent-children-summary">
      <span className="subagent-children-marker" aria-hidden><IconChevronRight size={11} /></span>
      <span className="subagent-children-label">tool calls</span>
      <span className={`subagent-children-count${showLive ? ' subagent-children-count-live' : ''}`}>
        {doneCount}/{calls.length}{showLive ? ' · running' : ''}
      </span>
    </span>
  )

  return (
    <AnimatedDetails
      className="subagent-children"
      open={open}
      onOpenChange={(next) => { setUserToggled(true); setOpen(next) }}
      summary={summary}
      summaryClassName="subagent-children-summary-btn"
      contentClassName="subagent-children-content"
    >
      <ul className="subagent-child-rows">
        {calls.map((c) => (
          <SubagentChildRow
            key={c.toolUseId}
            call={c}
            entering={enteringIds.has(c.toolUseId)}
            pulse={showLive}
          />
        ))}
      </ul>
    </AnimatedDetails>
  )
})

/** One child tool-call row: status indicator + tool name + arg preview,
 *  expandable once the captured tool_result lands. Running rows are not
 *  expandable (no result yet) and pulse while the parent subagent is live.
 *  A newly-arrived row glides open via GridClipEnter; its result reveals
 *  via ToolResultSection's own entrance animation.
 *
 *  Status flip is in-place: the same `<li>` / button stay mounted and only
 *  the dot class + expandability change, so a fast tool never rebuilds. */
const SubagentChildRow = memo(function SubagentChildRow({
  call,
  entering,
  pulse,
}: {
  call: SubagentChildCall
  entering: boolean
  /** Whether a running row should animate its pulse. False on a settled
   *  parent record so a stranded `running` child doesn't pulse forever. */
  pulse: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = call.status === 'running'
  const canExpand = !isRunning && !!call.result
  const statusClass = isRunning
    ? 'running'
    : call.status === 'success'
      ? 'success'
      : 'error'
  // Arm the result's reveal only on a genuine user expand during this mounted
  // row's lifetime (never replay it on a scroll-back remount where expanded
  // seeds false anyway) — gate mirrors the card's other useEnterOnArrival rows.
  const resultEntering = useEnterOnArrival(expanded && call.result ? call.result : null)

  return (
    <li className={`subagent-child-row subagent-child-row-${statusClass}`}>
      <GridClipEnter entering={entering}>
        <button
          type="button"
          className="subagent-child-row-head"
          onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
          disabled={!canExpand}
          aria-expanded={canExpand ? expanded : undefined}
          aria-busy={isRunning || undefined}
          title={canExpand ? (expanded ? 'Collapse result' : 'Show result') : call.toolName}
          data-expanded={expanded}
        >
          <span
            className={`subagent-child-dot subagent-child-dot-${statusClass}${isRunning && pulse ? ' subagent-child-dot-pulse' : ''}`}
            aria-hidden
          />
          <span className="subagent-child-name">{call.toolName}</span>
          {call.argSummary && <span className="subagent-child-arg">{call.argSummary}</span>}
          {canExpand && (
            <span className="subagent-child-chevron" aria-hidden><IconChevronRight size={11} /></span>
          )}
        </button>
      </GridClipEnter>
      {canExpand && expanded && call.result && (
        <div className="subagent-child-result">
          <ToolResultSection result={call.result} entering={resultEntering} />
        </div>
      )}
    </li>
  )
})
