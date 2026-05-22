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
import type { SdkMessage } from '../types'

interface Props {
  toolUseId: string
  /** Fallback label — shown when the subagent hasn't been recorded in
   *  the index yet (stale state during a hard refresh, etc.). */
  fallbackLabel?: string
}


function countToolUses(messages: readonly SdkMessage[], toolUseId: string): number {
  let count = 0
  for (const m of messages) {
    if ((m as Record<string, unknown>).parent_tool_use_id !== toolUseId) continue
    if (m.type !== 'assistant') continue
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<{ type?: string }>) {
      if (b.type === 'tool_use') count++
    }
  }
  return count
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

  const toolCount = ctx ? countToolUses(ctx.messages, toolUseId) : 0

  const statusIcon =
    status === 'running' ? '●'
    : status === 'done' ? '✓'
    : status === 'rejected' ? '⚠'
    : '⚠'

  const handleOpen = () => {
    if (!ctx) return
    ctx.open(toolUseId)
  }

  return (
    <button
      type="button"
      className={`subagent-card subagent-card-${status}`}
      onClick={handleOpen}
      disabled={!ctx}
      title={ctx ? `Open subagent details — ${label}` : 'Subagent details unavailable'}
    >
      <span className="subagent-card-marker" aria-hidden>▸</span>
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
        <span className="subagent-card-open" aria-hidden>↗</span>
      </span>
    </button>
  )
})
