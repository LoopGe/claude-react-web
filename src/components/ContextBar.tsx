// Tiny progress bar showing how full the context window is.
//
// Pure display component — data arrives via the WebSocket hub
// (the server pushes a `context_usage` event periodically).
// No fetch calls, no timers, no polling.

import { memo, type CSSProperties } from 'react'
import type { ContextUsage } from '../hooks/useChatStream'
import { formatTokens } from '../utils/format'

interface Props {
  /** Latest usage snapshot from the WebSocket hub, or null if none yet. */
  usage: ContextUsage | null
}

export const ContextBar = memo(function ContextBar({ usage }: Props) {
  // Prefer rawMaxTokens (the model's real advertised context window) over
  // maxTokens (which may be reduced by compaction headroom reserves).
  const max = usage?.rawMaxTokens ?? usage?.maxTokens
  if (!usage || max == null || max <= 0) {
    return (
      <div className="ctx-bar ctx-bar-empty">
        <div className="ctx-bar-label">Context: —</div>
        <div className="ctx-bar-track" aria-hidden>
          <div
            className="ctx-bar-fill"
            style={{ ['--ctx-progress' as string]: 0 } as CSSProperties}
          />
        </div>
      </div>
    )
  }

  const used = usage.totalTokens ?? 0
  // Prefer SDK's percentage (it may weigh differently than raw tokens / max)
  // but fall back to a straight division if absent.
  const computedPct = usage.percentage ?? (used / max) * 100
  const bounded = Math.min(100, Math.max(0, computedPct))
  const level = bounded >= 90 ? 'danger' : bounded >= 70 ? 'warn' : 'ok'

  // Auto-compact warning: only render once we have a threshold (i.e. after
  // the first `result`) AND the user is far enough along that the nudge is
  // actionable (within 50% of the threshold). Mirrors the CLI's TokenWarning
  // "X% until auto-compact" line.
  const threshold = usage.autoCompactThreshold
  let warning: { percentLeft: number; level: 'ok' | 'warn' | 'danger' } | null = null
  if (typeof threshold === 'number' && threshold > 0) {
    const percentLeft = Math.max(0, Math.round(((threshold - used) / threshold) * 100))
    if (percentLeft <= 50) {
      warning = {
        percentLeft,
        level: percentLeft <= 15 ? 'danger' : percentLeft <= 30 ? 'warn' : 'ok',
      }
    }
  }

  return (
    <div className={`ctx-bar ctx-bar-${level}`}>
      <div className="ctx-bar-label">
        <span>
          Context
          {usage.model && <span className="ctx-bar-model" title={usage.model}>{usage.model}</span>}
        </span>
        <span className="ctx-bar-nums">
          {formatTokens(used)} / {formatTokens(max)}
          <span className="ctx-bar-pct"> · {bounded.toFixed(1)}%</span>
          {usage.outputTokens != null && usage.outputTokens > 0 && (
            <span className="ctx-bar-out" title={`Output tokens this call: ${formatTokens(usage.outputTokens)}`}>
              {' '}· {formatTokens(usage.outputTokens)} out
            </span>
          )}
          {usage.cacheReadTokens != null && usage.cacheReadTokens > 0 && (
            <span className="ctx-bar-cache" title={`Cache hit: ${formatTokens(usage.cacheReadTokens)} read · ${formatTokens(usage.cacheCreationTokens ?? 0)} written`}>
              {' '}· cache {formatTokens(usage.cacheReadTokens)}
            </span>
          )}
        </span>
      </div>
      <div className="ctx-bar-track" aria-hidden>
        <div
          className="ctx-bar-fill"
          style={{ ['--ctx-progress' as string]: bounded / 100 } as CSSProperties}
        />
      </div>
      {warning && (
        <div className={`ctx-bar-warning ctx-bar-warning-${warning.level}`}>
          {warning.percentLeft}% until auto-compact
        </div>
      )}
    </div>
  )
})
