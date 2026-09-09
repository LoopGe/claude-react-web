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
import { formatElapsed } from '../utils/format'
import { BackgroundToolButton, ToolResultSection } from './ToolCard'
import { GridClipEnter } from './GridClipEnter'
import { AnimatedCollapse, AnimatedDetails } from './AnimatedCollapse'
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

  // Tick once a second while running so the elapsed display stays fresh.
  // Stops once the record is no longer live (pending/done/interrupted/
  // rejected) — completed/waiting cards don't need re-renders. A 'background'
  // record is still live (the async subagent is still working) even though
  // the async-detector advances endedAt to the latest child frame, so the
  // timer must keep ticking and elapsedMs uses `now` (not endedAt) while
  // isRunning.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isRunning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isRunning])

  const elapsedMs = startedAt
    ? (isRunning ? now : (endedAt ?? now)) - startedAt
    : null

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
          {elapsedMs != null && (
            <span className="subagent-card-elapsed">{formatElapsed(elapsedMs)}</span>
          )}
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

/** Expandable list of a subagent's internal tool calls. The running call (if
 *  any) is surfaced as a highlighted line at the top; completed calls are
 *  rows that expand to reveal their result. The whole section opens while the
 *  subagent is live and collapses when it settles (via AnimatedDetails'
 *  `open` prop), but stays user-toggleable. */
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

  // ALL in-flight calls, not just the first: a subagent routinely issues
  // several tool_use blocks in one frame, and taking only `find()` while the
  // row list excludes every running call made the others unreachable anywhere
  // on the card until their results landed.
  const runningCalls = useMemo(() => calls.filter((c) => c.status === 'running'), [calls])
  // Rows list ONLY settled calls: in-flight ones are surfaced by the highlight
  // block above, and rendering them in both places showed the same tool twice.
  // Once a result lands the call flips to success/error and joins the rows.
  const settled = useMemo(() => calls.filter((c) => c.status !== 'running'), [calls])
  const doneCount = settled.length

  // Arrival gate for the row list: track which child ids we've already
  // rendered AS ROWS so a genuinely new row plays the grid-clip entrance,
  // while rows present at first mount (a card scrolled back into view, a
  // replay rebuild) do NOT replay it. Mirrors the useEnterOnArrival pattern
  // the card already uses for its actions/progress rows — the gate lives in
  // this persistent parent, never in the conditionally-mounted GridClipEnter.
  //
  // Keyed on `settled` (not `calls`): a call is born `running` — surfaced by
  // the highlight line, not as a row — and only becomes a row once it settles.
  // Marking it seen while it was still running would consume its arrival, so
  // the row would pop in with no animation at the moment it actually appears.
  //
  // The set is SEEDED during the first render (not in the post-commit effect):
  // otherwise every row present at mount counts as an arrival and GridClipEnter
  // — which seeds `revealing` from `entering` — replays the reveal. SubagentCard
  // lives in the virtualized transcript, so that re-animated the whole list on
  // every scroll-back. Seeding mirrors how useEnterOnArrival captures its
  // initial value into prevRef.
  const seenRef = useRef<Set<string> | null>(null)
  const firstRender = seenRef.current === null
  if (seenRef.current === null) {
    seenRef.current = new Set(settled.map((c) => c.toolUseId))
  }
  const seen = seenRef.current
  const enteringIds = new Set<string>()
  if (!firstRender) {
    for (const c of settled) {
      if (!seen.has(c.toolUseId)) enteringIds.add(c.toolUseId)
    }
  }
  useEffect(() => {
    for (const c of settled) seen.add(c.toolUseId)
  }, [settled, seen])

  // Only a LIVE record may advertise in-flight work. The reducer's turn-end
  // sweep settles running child calls on the sync-orphan path, but three other
  // transitions to a terminal status (dismiss, the pending-timeout sweep,
  // task-notification completion) can leave a `running` row behind — without
  // this guard a finished subagent rendered pulsing dots and an accent
  // "· running" count forever.
  const showLive = live && runningCalls.length > 0

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
      {/* In-flight calls highlighted at the top while live. Wrapped in an
          AnimatedCollapse so the block eases in when work starts and eases out
          when the last call settles, instead of snapping. Every running call
          gets a line — a subagent often fires several tools in one frame, and
          showing only the first hid the rest until they finished. */}
      <AnimatedCollapse open={showLive} durationMs={160}>
        {runningCalls.map((c) => (
          <div
            key={c.toolUseId}
            className="subagent-child-live"
            title={`${c.toolName} ${c.argSummary}`.trim()}
          >
            <span className="subagent-child-live-dots" aria-hidden><i /><i /><i /></span>
            <span className="subagent-child-live-name">{c.toolName}</span>
            {c.argSummary && (
              <span className="subagent-child-live-arg">{c.argSummary}</span>
            )}
          </div>
        ))}
      </AnimatedCollapse>
      <ul className="subagent-child-rows">
        {settled.map((c) => (
          <SubagentChildRow key={c.toolUseId} call={c} entering={enteringIds.has(c.toolUseId)} />
        ))}
      </ul>
    </AnimatedDetails>
  )
})

/** One child tool-call row: status dot + tool name + arg preview, expandable
 *  to show the captured tool_result inline. The running call is NOT expandable
 *  (no result yet) — it renders as a plain row (the live highlight above
 *  already surfaces it). A newly-arrived row glides open via GridClipEnter;
 *  its result reveals via ToolResultSection's own entrance animation. */
const SubagentChildRow = memo(function SubagentChildRow({ call, entering }: { call: SubagentChildCall; entering: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const canExpand = call.status !== 'running' && !!call.result
  const statusClass =
    call.status === 'success' ? 'success' : call.status === 'error' ? 'error' : 'running'
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
          title={canExpand ? (expanded ? 'Collapse result' : 'Show result') : call.toolName}
          data-expanded={expanded}
        >
          <span className={`subagent-child-dot subagent-child-dot-${statusClass}`} aria-hidden />
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
