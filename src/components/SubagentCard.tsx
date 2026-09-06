// Subagent placeholder card — rendered in place of the default
// ToolUseBlock for Agent / Task / Explore tool calls.
//
// Acts as the persistent inline entry point to the SubagentOverlay
// (the per-panel right-side overlay that holds the subagent's full
// internal conversation). The user sees a one-line summary —
// status, elapsed, tool count — and clicks to open the overlay.

import { memo, useEffect, useState } from 'react'
import { useSubagentContext } from '../hooks/useSubagentContext'
import { useBackgroundTool } from '../hooks/useBackgroundTool'
import { useEnterOnArrival } from '../hooks/useEnterOnArrival'
import { formatElapsed } from '../utils/format'
import { BackgroundToolButton, ToolResultSection } from './ToolCard'
import { GridClipEnter } from './GridClipEnter'
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
      {result && <ToolResultSection result={result} entering={resultEntering} />}
    </div>
  )
})
