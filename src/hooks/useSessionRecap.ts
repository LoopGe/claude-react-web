// Session recap hook.
//
// Tracks when a session was last viewed (in localStorage). When the user
// switches to a session they haven't looked at in 5+ minutes, auto-fetches
// an AI-generated recap from the server and exposes it for a banner.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import type { RecapResponse, RecapStats } from '../types'

const LAST_VIEWED_KEY = 'claude-react-web:last-viewed'
const STALE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

export interface RecapData {
  summary: string
  stats: RecapStats
  cached: boolean
  generatedAt: number
  fallback?: boolean
}

interface SessionRecap {
  recap: RecapData | null
  loading: boolean
  error: string | null
  visible: boolean
  dismiss: () => void
  refresh: () => void
}

/** Read the last-viewed map from localStorage. Non-throwing. */
function readLastViewed(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(LAST_VIEWED_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Write a single entry into the last-viewed map. Non-throwing. */
function writeLastViewed(id: string, ts: number): void {
  try {
    const map = readLastViewed()
    map[id] = ts
    // Prune entries older than 7 days to avoid unbounded growth.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const k of Object.keys(map)) {
      if (map[k] < cutoff) delete map[k]
    }
    window.localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(map))
  } catch {
    /* storage disabled / full — best-effort */
  }
}

export function useSessionRecap(sessionId: string, focused: boolean): SessionRecap {
  const [recap, setRecap] = useState<RecapData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const fetchedRef = useRef(false)
  const refreshAbortRef = useRef<AbortController | null>(null)

  // Auto-fetch on mount if the session is stale.
  useEffect(() => {
    const map = readLastViewed()
    const lastViewed = map[sessionId] ?? 0
    const neverViewed = lastViewed === 0
    const isStale = !neverViewed && (Date.now() - lastViewed > STALE_THRESHOLD_MS)

    if (!isStale) {
      // First visit (neverViewed) or recently viewed — just record
      // the visit timestamp. Only trigger a fetch when we've seen
      // this session before AND enough time has passed.
      writeLastViewed(sessionId, Date.now())
      return
    }
    if (fetchedRef.current) return
    fetchedRef.current = true

    const controller = new AbortController()
    setVisible(true)
    setLoading(true)
    setError(null)

    api
      .post<RecapResponse>(`/sessions/${sessionId}/recap`, undefined, { signal: controller.signal })
      .then((data) => {
        setRecap(data)
        // Only update the timestamp AFTER a successful fetch. If the
        // request fails (e.g. network error), leaving the old
        // timestamp ensures we'll retry on the next mount.
        writeLastViewed(sessionId, Date.now())
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return // unmounted — ignore
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('[recap] fetch failed:', msg)
        // Keep banner visible with error state — don't silently hide.
        setError(msg)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [sessionId])

  // Update last-viewed timestamp when focus changes.
  useEffect(() => {
    if (focused) writeLastViewed(sessionId, Date.now())
  }, [sessionId, focused])

  const dismiss = useCallback(() => setVisible(false), [])

  const refresh = useCallback(() => {
    // Abort any in-flight refresh so rapid clicks don't stack.
    refreshAbortRef.current?.abort()
    const controller = new AbortController()
    refreshAbortRef.current = controller
    setVisible(true)
    setLoading(true)
    setError(null)
    api
      .post<RecapResponse>(`/sessions/${sessionId}/recap`, undefined, { signal: controller.signal })
      .then((data) => setRecap(data))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('[recap] refresh failed:', msg)
        setError(msg)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
  }, [sessionId])

  return { recap, loading, error, visible, dismiss, refresh }
}
