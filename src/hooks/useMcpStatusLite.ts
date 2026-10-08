import { useCallback, useEffect, useState } from 'react'
import { api } from './useApi'
import type { McpServerStatus } from '../types'

/** name → connection status, for the empty-state env chips. */
export type McpStatusLite = Record<string, McpServerStatus['status']>

/** Light per-session MCP status read for the empty-state chips.
 *
 *  mcp-status is a hang-prone SDK control read — SettingsPanel wraps it with
 *  timeouts and snapshot baselines for the same reason. Here: a 4s timeout,
 *  and any failure degrades to an empty map (chips simply show no status
 *  dot rather than an error state — the authoritative status surface remains
 *  the SettingsPanel MCP tab). Fetches only while `active` (running
 *  session); dormant / terminated sessions never fetch, and a manual
 *  `refresh()` re-reads after a toggle / reconnect. */
export function useMcpStatusLite(
  sessionId: string | undefined,
  active: boolean,
): { statuses: McpStatusLite; loading: boolean; refresh: () => void } {
  const [statuses, setStatuses] = useState<McpStatusLite>({})
  const [tick, setTick] = useState(0)
  // `loading` is DERIVED (current fetch key ≠ last settled key) rather than a
  // flipped boolean: setting state synchronously inside the effect body trips
  // react-hooks/set-state-in-effect. The key covers sessionId + tick, so the
  // mount fetch counts as in-flight too (a tick-only comparison would miss
  // it — both are 0 at mount). `refresh()` bumps tick → loading flips true
  // until the fetch settles (success or silent-degrade failure).
  const fetchKey = active && sessionId ? `${sessionId}|${tick}` : null
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const loading = fetchKey !== null && fetchKey !== settledKey

  useEffect(() => {
    if (!active || !sessionId) return
    const ac = new AbortController()
    let cancelled = false
    api
      .get<{ mcp: McpServerStatus[] }>(`/sessions/${sessionId}/mcp-status`, {
        signal: ac.signal,
        timeoutMs: 4000,
      })
      .then((r) => {
        if (cancelled) return
        const next: McpStatusLite = {}
        for (const s of r.mcp ?? []) next[s.name] = s.status
        setStatuses(next)
        setSettledKey(`${sessionId}|${tick}`)
      })
      // Silent degrade: the empty state is a glanceable surface, not the
      // authority — no dot beats a spurious error card here.
      .catch(() => {
        if (cancelled) return
        setSettledKey(`${sessionId}|${tick}`)
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [active, sessionId, tick])

  return { statuses, loading, refresh }
}
