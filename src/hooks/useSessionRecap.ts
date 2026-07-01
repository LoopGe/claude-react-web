// Session recap hook — phase-driven trigger.
//
// The recap pipeline architecture:
//
//   ┌──────────┐  invariant: phase==='idle' before any generation runs
//   │ Server   │  RecapManager owns session.recap (in-memory only)
//   │          │  broadcasts on transitions via session-recap-update
//   │          │  AND inline on SessionInfo (via session-update)
//   └────┬─────┘
//        │  WS frames: session-update.recap, session-recap-update
//        ▼
//   ┌──────────┐
//   │ Client   │  reads session.recap from the SessionInfo prop
//   │          │  (App.tsx receives session-update → re-renders Chat)
//   │  this    │  decides when to ask for a fresh recap based on
//   │  hook    │    (phase === 'idle') AND (lastTurnAt is set)
//   │          │    AND (no fresh recap already covers it)
//   └──────────┘
//
// The client gate on phase is the primary trigger; the server's 409
// response is a defence-in-depth check for races. The "5 minutes idle"
// timer is a UX choice (don't summarise mid-thought) — it's a property
// of THIS hook only, not of the recap pipeline.

import { useCallback, useEffect, useRef } from 'react'
import { api } from './useApi'
import type { SessionInfo } from '../types'

/** How long after the last completed turn we wait before auto-firing
 *  the recap. The user is presumed to have moved on by then. Manual
 *  refresh (Alt+R) bypasses this. */
const IDLE_THRESHOLD_MS = 5 * 60 * 1000

export interface UseSessionRecapApi {
  /** Manually trigger a recap fetch. Bypasses the 5-minute idle timer
   *  (e.g. Alt+R). Still respects the server's phase gate — if the
   *  session isn't idle, the server returns 409 and the broadcast
   *  state stays unchanged. */
  refresh: () => void
}

/**
 * Drive recap auto-generation for one session.
 *
 * The hook reads `session.phase`, `session.lastTurnAt`, and
 * `session.recap` from the parent's SessionInfo (kept current by
 * App-level WebSocket session-update frames) and schedules a POST
 * /recap when:
 *
 *   - phase is 'idle' (no in-flight turn, no queued input, no
 *     pending permissions),
 *   - the session has at least one completed turn,
 *   - the history ring is non-empty (lastTurnAt is a fallible proxy —
 *     spawn() carries it forward on resume even when the transcript
 *     seed is empty, so gating on it alone would fire requestGenerate
 *     on an empty history and synthesize a misleading "No messages
 *     yet." popup; messageCount is the ground truth),
 *   - and no recap already covers it (status === 'ready' would mean
 *     a fresh one was just generated; 'pending' means one is in
 *     flight; both block; status === 'error' also blocks auto-retry,
 *     because looping on a failing recap wastes API calls — the user
 *     retries via Alt+R if they care).
 *
 * On any change to phase / lastTurnAt / recap, the previous timer is
 * cleared and a new one scheduled. So a user starting to type
 * cancels the pending recap before it fires; a generation result
 * landing flips the recap status to 'ready' and clears the timer.
 */
export function useSessionRecap(session: SessionInfo): UseSessionRecapApi {
  const fetchAbortRef = useRef<AbortController | null>(null)

  const doFetch = useCallback(() => {
    fetchAbortRef.current?.abort()
    const controller = new AbortController()
    fetchAbortRef.current = controller

    api
      .post(`/sessions/${session.id}/recap`, undefined, { signal: controller.signal })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        // The server's RecapManager broadcasts the error state via WS,
        // so we don't need to track it locally — the next session-update
        // will flip session.recap.status to 'error'. We only log here
        // for the rare case where the request fails before reaching the
        // manager (network drop, etc.).
        console.warn('[recap] fetch failed:', err instanceof Error ? err.message : String(err))
      })
  }, [session.id])

  // Auto-fire effect.
  //
  // Re-runs whenever any of the three driving fields change. The body
  // is structured as a series of early returns so the "happy path" case
  // (schedule a timer) sits at the bottom and reads top-to-bottom:
  // requirements first, then the action.
  useEffect(() => {
    // Primary gate: only the 'idle' phase is a safe moment to
    // summarise. The server enforces this too (returns 409 otherwise),
    // but gating here avoids a wasted round-trip and a transient
    // 'pending' state on session.recap.
    if (session.phase !== 'idle') return
    // No completed turn → nothing to summarise.
    if (!session.lastTurnAt) return
    // Empty history ring → nothing to summarise. lastTurnAt is a fallible
    // proxy (spawn() carries it on resume even with an empty transcript
    // seed), so without this gate the hook would fire requestGenerate on
    // an empty history and pop up "No messages yet." after a /clear or a
    // resume of a session whose transcript didn't seed.
    if (session.messageCount === 0) return
    // Already covered. The server clears session.recap to undefined on
    // every conversation mutation (RecapManager.invalidate), so a
    // present recap means "this is fresh for the current lastTurnAt".
    if (session.recap) return

    const elapsed = Date.now() - session.lastTurnAt
    const remaining = Math.max(0, IDLE_THRESHOLD_MS - elapsed)
    const timer = setTimeout(() => {
      doFetch()
    }, remaining)
    return () => clearTimeout(timer)
  }, [session.phase, session.lastTurnAt, session.messageCount, session.recap, doFetch])

  // Cancel any in-flight fetch on unmount so a stale response doesn't
  // race against the next mounted hook.
  useEffect(() => {
    const ref = fetchAbortRef
    return () => {
      ref.current?.abort()
    }
  }, [])

  const refresh = useCallback(() => {
    if (!session.lastTurnAt) return
    doFetch()
  }, [session.lastTurnAt, doFetch])

  return { refresh }
}
