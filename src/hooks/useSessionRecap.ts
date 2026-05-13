// Session recap hook — auto-fetches an AI summary when a session has
// been idle for ≥ 5 minutes since its last completed turn, and exposes
// it as a synthetic message that the caller splices into the transcript.
//
// "Idle" is defined off `session.lastTurnAt` (server-stamped on every
// `result` and pushed via session-update WS frames). New user messages
// bump that timestamp and reset the timer. Sessions that have never
// produced a turn don't trigger — there's nothing to recap.
//
// We dedupe with `lastViewed` (localStorage): once we've fetched a recap
// for a particular `lastTurnAt`, we don't fetch again until the session
// sees a fresher turn. The recap itself stays in the transcript across
// renders so the user can scroll back to it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './useApi'
import type { RecapResponse, RecapStats, SdkMessage } from '../types'

const LAST_VIEWED_KEY = 'claude-react-web:last-viewed'
const IDLE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

export interface RecapData {
  summary: string
  stats: RecapStats
  cached: boolean
  generatedAt: number
  fallback?: boolean
}

/** Synthetic message shape rendered inline by MessageList. The
 *  `type: 'recap'` tag is unique to this hook — no real SDK message
 *  uses it. `lastTurnAt` doubles as a stable key (one recap per turn). */
export interface RecapMessage extends SdkMessage {
  type: 'recap'
  uuid: string
  lastTurnAt: number
  state: 'loading' | 'ready' | 'error'
  recap?: RecapData
  error?: string
}

interface SessionRecap {
  /** Synthetic transcript message, or null when there's nothing to show. */
  message: RecapMessage | null
  /** Manual refresh — re-runs the fetch even if it's already shown. */
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

/** Write a single entry into the last-viewed map. Non-throwing. Also
 *  prunes entries older than 7 days so the map can't grow unbounded. */
function writeLastViewed(id: string, ts: number): void {
  try {
    const map = readLastViewed()
    map[id] = ts
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const k of Object.keys(map)) {
      if (map[k] < cutoff) delete map[k]
    }
    window.localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(map))
  } catch {
    /* storage disabled / full — best-effort */
  }
}

/**
 * @param sessionId   target session
 * @param lastTurnAt  server-stamped timestamp of the latest completed
 *                    turn; undefined → no recap is produced
 */
export function useSessionRecap(
  sessionId: string,
  lastTurnAt: number | undefined,
): SessionRecap {
  const [message, setMessage] = useState<RecapMessage | null>(null)
  const fetchAbortRef = useRef<AbortController | null>(null)

  /** Fire the recap fetch for `turnAt`. Manages loading/error state by
   *  mutating the synthetic message in place. Returns the AbortController
   *  so the caller's cleanup can cancel mid-flight. */
  const doFetch = useCallback(
    (turnAt: number) => {
      fetchAbortRef.current?.abort()
      const controller = new AbortController()
      fetchAbortRef.current = controller

      const baseMsg: RecapMessage = {
        type: 'recap',
        uuid: `recap:${sessionId}:${turnAt}`,
        lastTurnAt: turnAt,
        state: 'loading',
        session_id: sessionId,
      }
      setMessage(baseMsg)

      api
        .post<RecapResponse>(`/sessions/${sessionId}/recap`, undefined, { signal: controller.signal })
        .then((data) => {
          if (controller.signal.aborted) return
          setMessage({
            ...baseMsg,
            state: 'ready',
            recap: data,
          })
          writeLastViewed(sessionId, turnAt)
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          const msg = err instanceof Error ? err.message : String(err)
          console.warn('[recap] fetch failed:', msg)
          setMessage({
            ...baseMsg,
            state: 'error',
            error: msg,
          })
        })
    },
    [sessionId],
  )

  // Idle-watch effect.
  //
  // Re-runs whenever sessionId or lastTurnAt changes. Decides between
  //   1. nothing to do (no completed turn, or already viewed),
  //   2. fire now (idle threshold already passed),
  //   3. schedule a one-shot timer.
  // Stale-message clearing happens in a separate effect below — keeping
  // this effect free of setState calls satisfies the
  // react-hooks/set-state-in-effect rule.
  useEffect(() => {
    if (!lastTurnAt) return

    // Skip if we've already produced a recap for this exact turn — covers
    // both StrictMode double-mount (in-memory message has same lastTurnAt)
    // and hot reload (localStorage records the persisted view).
    const persistedSeen = readLastViewed()[sessionId] ?? 0
    if (persistedSeen >= lastTurnAt) return

    const elapsed = Date.now() - lastTurnAt
    const remaining = IDLE_THRESHOLD_MS - elapsed

    if (remaining <= 0) {
      // doFetch synchronously sets the loading message, which
      // implicitly replaces any stale (older-turn) recap on screen.
      // The lint rule below complains about indirect setState in
      // effects, but mount-with-already-elapsed-threshold is exactly
      // the case where we genuinely need to kick off side-effectful
      // work synchronously — we can't wait for a user event because
      // there isn't one. The alternative (deferring via
      // queueMicrotask) just hides the same setState from the linter
      // without changing the runtime behaviour.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      doFetch(lastTurnAt)
      return
    }

    const timer = setTimeout(() => {
      doFetch(lastTurnAt)
    }, remaining)
    return () => clearTimeout(timer)
  }, [sessionId, lastTurnAt, doFetch])

  // Hide any recap whose `lastTurnAt` no longer matches the current
  // input — covers both "user just sent a new message" (old summary
  // doesn't include the new turn) and "session was reset". Computed
  // rather than stored so we don't need a setState in an effect, which
  // the project's react-hooks lint rule forbids. The actual `message`
  // state stays around in memory so a re-mount with the same lastTurnAt
  // doesn't have to re-fetch.
  const visibleMessage = useMemo(() => {
    if (!message) return null
    if (lastTurnAt === undefined) return null
    if (message.lastTurnAt < lastTurnAt) return null
    return message
  }, [message, lastTurnAt])

  // Cancel any in-flight fetch on unmount.
  useEffect(() => {
    const ref = fetchAbortRef
    return () => {
      ref.current?.abort()
    }
  }, [])

  const refresh = useCallback(() => {
    if (!lastTurnAt) return
    doFetch(lastTurnAt)
  }, [lastTurnAt, doFetch])

  return { message: visibleMessage, refresh }
}
