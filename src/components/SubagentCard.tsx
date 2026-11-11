// Compact subagent summary — rendered in place of the default ToolUseBlock
// for Agent / Task / Explore calls. The header opens SubagentOverlay, which
// owns the full conversation, tool history, and result; the inline card only
// summarizes current work and never grows with the number of child tools.

import { memo, useMemo } from 'react'
import { useSubagentContext } from '../hooks/useSubagentContext'
import { useBackgroundTool } from '../hooks/useBackgroundTool'
import { useEnterOnArrival } from '../hooks/useEnterOnArrival'
import { ElapsedTimer } from './ElapsedTimer'
import { HoverHint } from './HoverHint'
import { BackgroundToolButton } from './ToolCard'
import { GridClipEnter } from './GridClipEnter'
import type { SubagentChildCall } from '../session-store/types'
import { IconCheck, IconAlertTriangle, IconExternalLink } from './icons/ToolIcons'

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
  const isAsync = record?.isAsync
  // 'pending' is still in-flight but the parent turn has ended, so the timer
  // stays frozen at the last-known endedAt. Child activity can continue.
  const isRunning = status === 'running' || status === 'background'

  const showActions = record != null && status === 'running' && !isAsync && backgroundTool
  const showProgress = !!record?.progressSummary && isRunning
  const actionsEntering = useEnterOnArrival(showActions ? record : null)
  const progressEntering = useEnterOnArrival(showProgress ? record?.progressSummary : null)

  // Pre-computed in the reducer's updateIndexes — no message scanning needed.
  const toolCount = record?.toolCount ?? 0
  const childToolCalls = record?.childToolCalls
  const latestChild = useMemo(() => {
    if (!isRunning && status !== 'pending') return undefined
    const calls = childToolCalls ?? []
    let latest: SubagentChildCall | undefined = calls[calls.length - 1]
    // Parallel calls can settle out of order. Prefer the newest still-running
    // call over a newer settled one so the activity line never looks idle
    // while one of the subagent's tools is actually still in flight.
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i].status === 'running') {
        latest = calls[i]
        break
      }
    }
    return latest
  }, [childToolCalls, isRunning, status])

  const handleOpen = () => {
    if (!ctx) return
    ctx.open(toolUseId)
  }

  const terminalStatusIcon = status === 'done'
    ? <IconCheck size={12} />
    : status === 'rejected' || status === 'interrupted'
      ? <IconAlertTriangle size={12} />
      : null

  return (
    <div className={`subagent-card subagent-card-${status}`}>
      <button
        type="button"
        className="subagent-card-header"
        onClick={handleOpen}
        disabled={!ctx}
        title={ctx ? `Open subagent details — ${label}` : 'Subagent details unavailable'}
      >
        <span className="subagent-card-status" role="img" aria-label={`Subagent status: ${status}`}>
          {terminalStatusIcon
            ? <span className="subagent-card-status-icon" aria-hidden>{terminalStatusIcon}</span>
            : <span className="subagent-card-status-dot" aria-hidden />}
        </span>
        <span className="subagent-card-label">{label}</span>
        <span className="subagent-card-title">Subagent</span>
        <span className="subagent-card-meta">
          {isAsync != null && (
            <HoverHint
              label={isAsync
                ? 'Background/async — the subagent runs independently and the result returns immediately'
                : 'Synchronous — the parent agent waits for this subagent to finish'}
              side="top"
            >
              <span className={`subagent-card-mode subagent-card-mode-${isAsync ? 'async' : 'sync'}`}>
                {isAsync ? 'async' : 'sync'}
              </span>
            </HoverHint>
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
      {/* Per-card background action for a SYNCHRONOUS in-flight subagent.
          The header is a single button, so the action is a sibling row. */}
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
      {/* Present-tense progress summary (agentProgressSummaries). Terminal
          records clear it; pending keeps only the latest child activity. */}
      {showProgress && (
        <GridClipEnter entering={progressEntering}>
          <HoverHint label={record?.progressSummary ?? ''} side="top" disabled={!record?.progressSummary}>
            <div className="subagent-card-progress">
              {record?.progressSummary}
            </div>
          </HoverHint>
        </GridClipEnter>
      )}
      {/* One non-interactive activity line. The full ordered tool history and
          every result remain available through the header's detail drawer. */}
      {latestChild && (
        <div
          className={`subagent-card-latest subagent-child-row-${latestChild.status}`}
          aria-busy={latestChild.status === 'running' || undefined}
        >
          <span
            className={`subagent-child-dot subagent-child-dot-${latestChild.status}${latestChild.status === 'running' ? ' subagent-child-dot-pulse' : ''}`}
            aria-hidden
          />
          <span className="subagent-child-name">{latestChild.toolName}</span>
          {latestChild.argSummary && <span className="subagent-child-arg">{latestChild.argSummary}</span>}
        </div>
      )}
    </div>
  )
})
