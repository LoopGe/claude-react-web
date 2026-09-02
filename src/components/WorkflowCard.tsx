// Workflow placeholder card — rendered in place of the default ToolUseBlock for
// Workflow tool calls (the multi-agent orchestration tool).
//
// Mirrors SubagentCard's shape (one-line summary: status, elapsed, child count)
// but reads from the Workflow context (activeWorkflows index) instead of the
// subagent index, and opens the WorkflowOverlay (two-column phase tree +
// messages) rather than the single-conversation SubagentOverlay.
//
// The card is the persistent inline entry point: once the Workflow's tool_result
// lands the record is KEPT (status flips to done/interrupted) so the overlay
// stays reopenable — same keep-on-complete discipline as SubagentCard.

import { memo, useEffect, useState } from 'react'
import { useWorkflowContext } from '../hooks/useWorkflowContext'
import { useEnterOnArrival } from '../hooks/useEnterOnArrival'
import { formatElapsed } from '../utils/format'
import { ToolResultSection } from './ToolCard'
import {
  IconCheck,
  IconCircleDot,
  IconAlertTriangle,
  IconChevronRight,
  IconExternalLink,
  IconWorkflow,
} from './icons/ToolIcons'

interface Props {
  toolUseId: string
  /** Fallback label — shown when the Workflow hasn't been recorded in the
   *  index yet (stale state during a hard refresh, etc.). */
  fallbackLabel?: string
}

export const WorkflowCard = memo(function WorkflowCard({ toolUseId, fallbackLabel }: Props) {
  const ctx = useWorkflowContext()
  // When rendered outside a WorkflowProvider (tests, exports), fall back to a
  // minimal inline display rather than crashing — same defensive pattern as
  // SubagentCard.
  const record = ctx?.index.get(toolUseId)
  const status = record?.status ?? 'running'
  const label = record?.label ?? fallbackLabel ?? 'Workflow'
  const startedAt = record?.startedAt
  const endedAt = record?.endedAt
  const result = record?.result
  const resultEntering = useEnterOnArrival(result)
  const childCount = record?.childAgents.length ?? 0
  const phaseCount = record?.phases.length ?? 0
  const isRunning = status === 'running'
  const remote = record?.remote === true
  const sessionUrl = record?.sessionUrl

  // Tick once a second while running so the elapsed display stays fresh.
  // Stops once endedAt is set — completed cards don't need re-renders.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isRunning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isRunning])

  const elapsedMs = startedAt ? (endedAt ?? now) - startedAt : null

  const statusIcon =
    status === 'running' ? <IconCircleDot size={12} />
    : status === 'done' ? <IconCheck size={12} />
    : <IconAlertTriangle size={12} />

  const handleOpen = () => {
    if (!ctx) return
    ctx.open(toolUseId)
  }

  return (
    <div className={`workflow-card workflow-card-${status}`}>
      <button
        type="button"
        className="workflow-card-header"
        onClick={handleOpen}
        disabled={!ctx}
        title={ctx ? `Open workflow details — ${label}` : 'Workflow details unavailable'}
      >
        <span className="workflow-card-marker" aria-hidden><IconChevronRight size={12} /></span>
        <span className="workflow-card-icon" aria-hidden><IconWorkflow size={14} /></span>
        <span className="workflow-card-title">Workflow</span>
        <span className="workflow-card-label">{label}</span>
        <span className="workflow-card-meta">
          {remote && (
            <span className="workflow-card-remote" title="Running in a remote cloud session">
              remote
            </span>
          )}
          {phaseCount > 0 && (
            <span className="workflow-card-phase" title="Declared phases">
              {phaseCount} phase{phaseCount === 1 ? '' : 's'}
            </span>
          )}
          {childCount > 0 && (
            <span className="workflow-card-agents" title="Spawned agents">
              {childCount} agent{childCount === 1 ? '' : 's'}
            </span>
          )}
          <span className="workflow-card-status" aria-label={status}>
            {statusIcon}
          </span>
          {elapsedMs != null && (
            <span className="workflow-card-elapsed">{formatElapsed(elapsedMs)}</span>
          )}
          <span className="workflow-card-open" aria-hidden><IconExternalLink size={12} /></span>
        </span>
      </button>
      {remote && sessionUrl && (
        <a
          className="workflow-card-remote-link"
          href={sessionUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={`Open remote session — ${sessionUrl}`}
        >
          <IconExternalLink size={12} />
          <span>Open remote session</span>
        </a>
      )}
      {result && <ToolResultSection result={result} entering={resultEntering} />}
    </div>
  )
})
