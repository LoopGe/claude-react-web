// Tiny progress bar showing how full the context window is.
//
// Pure display component — data arrives via the per-session SSE stream
// (the server pushes a `context_usage` event every 10 SDK messages).
// No fetch calls, no timers, no polling.

import type { ContextUsage } from '../hooks/useChatStream'

interface Props {
  /** Latest usage snapshot from the SSE stream, or null if none yet. */
  usage: ContextUsage | null
}

export function ContextBar({ usage }: Props) {
  if (!usage || usage.maxTokens == null || usage.maxTokens <= 0) {
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
  const max = usage.maxTokens
  // Prefer SDK's percentage (it may weigh differently than raw tokens / max)
  // but fall back to a straight division if absent.
  const computedPct = usage.percentage ?? (used / max) * 100
  const bounded = Math.min(100, Math.max(0, computedPct))
  const level = bounded >= 90 ? 'danger' : bounded >= 70 ? 'warn' : 'ok'

  return (
    <div className={`ctx-bar ctx-bar-${level}`}>
      <div className="ctx-bar-label">
        <span>Context</span>
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
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}
