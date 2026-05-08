// Tiny progress bar showing how full the context window is.
//
// Data comes from the server-side `Query.getContextUsage()` wrapper; we
// poll it once at mount and then again after every `result` message that
// lands in <Chat />. Callers pass the `refreshKey` they want us to react to
// (typically `lastResultAt` — whatever changes when a new turn completes).

import { useEffect, useState } from 'react'
import { api } from '../hooks/useApi'

interface UsageResponse {
  usage?: {
    totalTokens?: number
    maxTokens?: number
    percentage?: number
    model?: string
  }
}

interface Props {
  sessionId: string
  /** Whenever this value changes we refetch usage. */
  refreshKey: number
  /** Skip the fetch entirely when the session isn't running — its SDK
   *  subprocess is already closed and /context-usage returns 410. */
  running: boolean
}

export function ContextBar({ sessionId, refreshKey, running }: Props) {
  const [used, setUsed] = useState<number | null>(null)
  const [max, setMax] = useState<number | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!running) return
    let cancelled = false
    api
      .get<UsageResponse>(`/sessions/${sessionId}/context-usage`)
      .then((r) => {
        if (cancelled) return
        const u = r.usage
        setUsed(typeof u?.totalTokens === 'number' ? u.totalTokens : null)
        setMax(typeof u?.maxTokens === 'number' ? u.maxTokens : null)
        setPct(typeof u?.percentage === 'number' ? u.percentage : null)
        setErr(null)
      })
      .catch((e) => {
        if (cancelled) return
        // The SDK throws `context usage is only supported in streaming input
        // mode` on freshly-created sessions before the first turn. Suppress
        // that specific error silently; surface anything else as a compact
        // bar-less notice.
        const msg = (e as Error).message ?? 'usage unavailable'
        setErr(msg)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshKey, running])

  if (err && used == null) {
    // First load failed — hide the bar entirely. A subsequent successful
    // refetch (after the first completed turn) will unhide it.
    return null
  }

  if (used == null || max == null || max <= 0) {
    return (
      <div className="ctx-bar ctx-bar-empty">
        <div className="ctx-bar-label">Context: —</div>
        <div className="ctx-bar-track" aria-hidden>
          <div className="ctx-bar-fill" style={{ width: '0%' }} />
        </div>
      </div>
    )
  }

  // Prefer SDK's percentage (it may weigh differently than raw tokens / max)
  // but fall back to a straight division if absent.
  const computedPct = pct ?? (used / max) * 100
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
