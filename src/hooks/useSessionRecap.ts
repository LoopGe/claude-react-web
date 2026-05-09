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

  // Auto-fetch on mount if the session is stale.
  useEffect(() => {
    const map = readLastViewed()
    const lastViewed = map[sessionId] ?? 0
    const isStale = Date.now() - lastViewed > STALE_THRESHOLD_MS

    // Always update the timestamp on mount (session is now visible).
    writeLastViewed(sessionId, Date.now())

    if (!isStale || fetchedRef.current) return
    fetchedRef.current = true
    setVisible(true)
    setLoading(true)
    setError(null)

    api
      .post<RecapResponse>(`/sessions/${sessionId}/recap`)
      .then((data) => {
        setRecap(data)
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        // 503 = dormant session — show a muted message instead of hiding.
        if (msg.includes('503') || msg.toLowerCase().includes('dormant')) {
          setRecap({ summary: 'Resume this session to see a recap.', stats: emptyStats, cached: false, generatedAt: Date.now(), fallback: true })
        } else {
          setError(msg)
          setVisible(false)
        }
      })
      .finally(() => setLoading(false))
    // Only run on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Update last-viewed timestamp when focus changes.
  useEffect(() => {
    if (focused) writeLastViewed(sessionId, Date.now())
  }, [sessionId, focused])

  const dismiss = useCallback(() => setVisible(false), [])

  const refresh = useCallback(() => {
    setVisible(true)
    setLoading(true)
    setError(null)
    api
      .post<RecapResponse>(`/sessions/${sessionId}/recap`)
      .then((data) => setRecap(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [sessionId])

  return { recap, loading, error, visible, dismiss, refresh }
}

const emptyStats: RecapStats = {
  messageCount: 0,
  userTurns: 0,
  assistantTurns: 0,
  totalCostUsd: 0,
  durationMs: 0,
  toolsUsed: [],
}
