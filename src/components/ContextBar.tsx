// Tiny progress bar showing how full the context window is.
//
// Pure display component — data arrives via the WebSocket hub
// (the server pushes a `context_usage` event periodically).
// No fetch calls, no timers, no polling.

import { memo } from 'react'
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
          <div className="ctx-bar-fill" style={{ width: '0%' }} />
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
        </span>
      </div>
      <div className="ctx-bar-track" aria-hidden>
        <div className="ctx-bar-fill" style={{ width: `${bounded}%` }} />
      </div>
    </div>
  )
})
