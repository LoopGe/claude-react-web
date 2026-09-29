// Lazy fetch of the DETAILED context-usage breakdown (categories: system
// prompt / tools / MCP / memory / skills) for the ContextOrb popover.
//
// The WS-pushed lite snapshot that feeds the bar carries no categories — the
// breakdown only exists on the blocking `GET /sessions/:id/context-usage`
// control read. So the fetch fires ONLY while the popover is open (`enabled`):
// opening it is an explicit request, same principle as SettingsPanel's
// "opening the Context tab IS the request for the breakdown". A per-session
// TTL cache keeps repeated open/close cycles from hammering the
// subprocess-serialized control channel (each open within the window reuses
// the last payload); every open STILL paints instantly from cache when warm.
// Concurrent fetches are deduped by sequence, a close/unmount aborts the
// in-flight one.
//
// Merge semantics live at the call site (`{ ...detailed, ...liveLite }`) —
// identical to SettingsPanel: live lite fields win, categories survive.

import { useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import type { ContextUsage } from './useChatStream'

/** How long a fetched breakdown may serve later opens of the SAME session
 *  without a fresh control round-trip. Context shifts between turns, so
 *  this bounds staleness rather than being a session-long cache. */
const DETAILED_CACHE_TTL_MS = 60_000

const cache = new Map<string, { usage: ContextUsage; at: number }>()

/** Test seam: the cache is module-level by design (survives popover
 *  unmount/remount); tests that need a cold start clear it. */
export function __clearDetailedContextUsageCache(): void {
  cache.clear()
}

export interface DetailedContextUsageState {
  /** The detailed payload from the last successful fetch, or null. */
  detailed: ContextUsage | null
  /** True while a fetch is in flight. */
  loading: boolean
  /** True when the last fetch failed (aborted-by-close does NOT count). */
  error: boolean
  /** Re-run the fetch (error hint's retry link) — always bypasses the cache. */
  retry: () => void
}

export function useDetailedContextUsage(sessionId: string, enabled: boolean): DetailedContextUsageState {
  const [detailed, setDetailed] = useState<ContextUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  // Monotonic token: only the LATEST request may write state — a superseded
  // response landing last must not overwrite fresh numbers (same shape as
  // SettingsPanel's usageFetchSeqRef).
  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  // Retry re-arms the effect by bumping the nonce into its deps.
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!enabled) return
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const seq = ++seqRef.current
    // Deferred through setTimeout(0) so the synchronous setLoading never
    // runs during the effect body (react-hooks/set-state-in-effect — same
    // shape as SettingsPanel's loadDetailedUsage defer).
    const t = setTimeout(() => {
      const hit = cache.get(sessionId)
      if (hit && Date.now() - hit.at < DETAILED_CACHE_TTL_MS) {
        setDetailed(hit.usage)
        setError(false)
        setLoading(false)
        return
      }
      setLoading(true)
      api
        .get<{ usage: unknown }>(`/sessions/${sessionId}/context-usage`, { signal: ac.signal })
        .then((r) => {
          if (seq !== seqRef.current) return
          const fetched = r.usage as ContextUsage | null
          if (fetched) cache.set(sessionId, { usage: fetched, at: Date.now() })
          setDetailed(fetched)
          setError(false)
        })
        .catch(() => {
          if (seq !== seqRef.current) return
          if (ac.signal.aborted) return // closed/unmounted — not a failure
          setError(true)
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false)
        })
    }, 0)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [sessionId, enabled, nonce])

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  return { detailed, loading, error, retry: () => setNonce((n) => n + 1) }
}
