// Collapsible banner shown above MessageList when the user returns to a
// stale session. Displays an AI-generated recap of what happened so far
// plus compact stats (message count, cost, tools used). The user can
// expand/collapse, refresh, or dismiss.

import { useState } from 'react'
import type { RecapData } from '../hooks/useSessionRecap'

interface Props {
  recap: RecapData | null
  loading: boolean
  error: string | null
  onDismiss: () => void
  onRefresh: () => void
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

function formatDuration(ms: number): string {
  if (ms === 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

export function SessionRecapBanner({ recap, loading, error, onDismiss, onRefresh }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (loading) {
    return (
      <div className="session-recap session-recap--loading">
        <div className="session-recap-loading-bar" />
        <span className="session-recap-loading-text">Generating recap…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="session-recap session-recap--error">
        <span className="session-recap-error-text">⚠️ Recap unavailable: {error}</span>
        <div className="session-recap-actions">
          <button className="session-recap-btn" onClick={onRefresh} title="Retry" aria-label="Retry recap">
            ↻
          </button>
          <button className="session-recap-btn session-recap-btn--dismiss" onClick={onDismiss} title="Dismiss" aria-label="Dismiss recap">
            ✕
          </button>
        </div>
      </div>
    )
  }

  if (!recap) return null

  const { summary, stats, fallback } = recap
  const truncated = !expanded && summary.length > 120
  const display = truncated ? summary.slice(0, 120) + '…' : summary

  const duration = formatDuration(stats.durationMs)
  const toolCount = stats.toolsUsed.length

  return (
    <div className={`session-recap ${fallback ? 'session-recap--fallback' : ''}`}>
      <div className="session-recap-header">
        <span className="session-recap-label">
          {fallback ? '📋 Session recap' : '✨ Session recap'}
        </span>
        <div className="session-recap-actions">
          <button
            className="session-recap-btn"
            onClick={onRefresh}
            disabled={loading}
            title="Regenerate recap"
            aria-label="Regenerate recap"
          >
            ↻
          </button>
          <button
            className="session-recap-btn"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Collapse' : 'Expand'}
            aria-label={expanded ? 'Collapse recap' : 'Expand recap'}
          >
            {expanded ? '▾' : '▸'}
          </button>
          <button
            className="session-recap-btn session-recap-btn--dismiss"
            onClick={onDismiss}
            title="Dismiss"
            aria-label="Dismiss recap"
          >
            ✕
          </button>
        </div>
      </div>

      <p className="session-recap-summary">{display}</p>

      <div className="session-recap-stats">
        {stats.userTurns > 0 && (
          <span className="session-recap-stat">
            💬 {stats.userTurns} turn{stats.userTurns === 1 ? '' : 's'}
          </span>
        )}
        {stats.totalCostUsd > 0 && (
          <span className="session-recap-stat">💰 {formatCost(stats.totalCostUsd)}</span>
        )}
        {duration && (
          <span className="session-recap-stat">⏱ {duration}</span>
        )}
        {toolCount > 0 && (
          <span className="session-recap-stat">🔧 {toolCount} tool{toolCount === 1 ? '' : 's'}</span>
        )}
      </div>

      {expanded && toolCount > 0 && (
        <div className="session-recap-tools">
          {stats.toolsUsed.map((t) => (
            <span key={t} className="session-recap-tool">{t}</span>
          ))}
        </div>
      )}
    </div>
  )
}
