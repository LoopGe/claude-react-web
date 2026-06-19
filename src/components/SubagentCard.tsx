// Subagent placeholder card — rendered in place of the default
// ToolUseBlock for Agent / Task / Explore tool calls.
//
// Acts as the persistent inline entry point to the SubagentOverlay
// (the per-panel right-side overlay that holds the subagent's full
// internal conversation). The user sees a one-line summary —
// status, elapsed, tool count — and clicks to open the overlay.

import { memo, useEffect, useState } from 'react'
import { useSubagentContext } from '../hooks/useSubagentContext'
import { formatElapsed } from '../utils/format'
import { ToolResultDetails } from './ToolCard'
import type { ToolResultEntry } from '../session-store/types'
import { IconCheck, IconCircleDot, IconAlertTriangle, IconChevronRight, IconExternalLink } from './icons/ToolIcons'

interface Props {
  toolUseId: string
  /** Fallback label — shown when the subagent hasn't been recorded in
   *  the index yet (stale state during a hard refresh, etc.). */
  fallbackLabel?: string
}

export const SubagentCard = memo(function SubagentCard({ toolUseId, fallbackLabel }: Props) {
  const ctx = useSubagentContext()
  // When rendered outside a SubagentProvider (e.g. tests, exports), fall
  // back to a minimal inline display rather than crashing.
  const record = ctx?.index.get(toolUseId)
  const status = record?.status ?? 'running'
  const label = record?.label ?? fallbackLabel ?? 'Subagent'
  const startedAt = record?.startedAt
  const endedAt = record?.endedAt
  const result = record?.result
  const isRunning = status === 'running'

  // Tick once a second while running so the elapsed display stays fresh.
  // Stops once endedAt is set — completed cards don't need re-renders.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isRunning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isRunning])

  const elapsedMs = startedAt
    ? (endedAt ?? now) - startedAt
    : null

  // Pre-computed in the reducer's updateIndexes — no message scanning needed.
  const toolCount = record?.toolCount ?? 0

  const statusIcon =
    status === 'running' ? <IconCircleDot size={12} />
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
      {result && <SubagentCardResult result={result} />}
    </div>
  )
})

/** Inline result section at the bottom of a merged subagent card — mirrors
 *  ToolCard's ToolCardResult. Renders the subagent's returned output (the
 *  Agent/Task/Explore tool_result that lands on the main thread) so the
 *  card is the subagent's complete surfacing in the transcript and the
 *  standalone orphan bubble can be suppressed. */
const SubagentCardResult = memo(function SubagentCardResult({ result }: { result: ToolResultEntry }) {
  return (
    <div className={`tool-card-result${result.isError ? ' tool-card-result-error' : ''}`}>
      <ToolResultDetails content={result.content} />
    </div>
  )
})
