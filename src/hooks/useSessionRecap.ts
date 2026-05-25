// Session recap hook — triggers an AI summary when a session has been
// idle for ≥ 5 minutes since its last completed turn.
//
// The recap is persisted server-side as a synthetic message in the
// session history. The server broadcasts it via WebSocket so all tabs
// see it, and it survives page refresh via replay.
//
// This hook manages the idle timer and loading state. While a fetch is
// in flight it exposes a synthetic `loadingMessage` that the caller can
// splice into the transcript for immediate visual feedback.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './useApi'
import type { SdkMessage } from '../types'

const IDLE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

/** Synthetic loading message rendered by RecapMessageView. The
 *  `type: 'recap'` tag is unique — no real SDK message uses it. */
export interface RecapMessage extends SdkMessage {
  type: 'recap'
  uuid: string
  state: 'loading' | 'ready' | 'error'
  recap?: { summary: string; stats: Record<string, unknown> }
  error?: string
}

interface SessionRecap {
  /** Fire a recap fetch now (e.g. Alt+R shortcut). */
  refresh: () => void
  /** Loading message to splice into the transcript, or null. */
  loadingMessage: RecapMessage | null
}

/**
 * @param sessionId   target session
 * @param lastTurnAt  server-stamped timestamp of the latest completed
 *                    turn; undefined → no recap is triggered
 */
export function useSessionRecap(
  sessionId: string,
  lastTurnAt: number | undefined,
): SessionRecap {
  const [isLoading, setIsLoading] = useState(false)
  const fetchAbortRef = useRef<AbortController | null>(null)

  const loadingMessage = useMemo<RecapMessage | null>(() => {
    if (!isLoading) return null
    return {
      type: 'recap',
      uuid: `recap:loading:${sessionId}`,
      session_id: sessionId,
      state: 'loading',
    }
  }, [isLoading, sessionId])

  /** Fire the recap endpoint. The server persists the result as a
   *  synthetic message and broadcasts it — we just track loading state. */
  const doFetch = useCallback(
    () => {
      fetchAbortRef.current?.abort()
      const controller = new AbortController()
      fetchAbortRef.current = controller

      setIsLoading(true)

      api
        .post(`/sessions/${sessionId}/recap`, undefined, { signal: controller.signal })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          console.warn('[recap] fetch failed:', err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          setIsLoading(false)
        })
    },
    [sessionId],
  )

  // Idle-watch effect.
  //
  // Re-runs whenever sessionId or lastTurnAt changes. Decides between
  //   1. nothing to do (no completed turn),
  //   2. fire now (idle threshold already passed),
  //   3. schedule a one-shot timer.
  useEffect(() => {
    if (!lastTurnAt) return

    const elapsed = Date.now() - lastTurnAt
    const remaining = IDLE_THRESHOLD_MS - elapsed

    // Always defer so setState inside doFetch doesn't run synchronously in the effect body
    const timer = setTimeout(() => {
      doFetch()
    }, Math.max(0, remaining))
    return () => clearTimeout(timer)
  }, [sessionId, lastTurnAt, doFetch])

  // Cancel any in-flight fetch on unmount.
  useEffect(() => {
    const ref = fetchAbortRef
    return () => {
      ref.current?.abort()
    }
  }, [])

  const refresh = useCallback(() => {
    if (!lastTurnAt) return
    doFetch()
  }, [lastTurnAt, doFetch])

  return { refresh, loadingMessage }
}
