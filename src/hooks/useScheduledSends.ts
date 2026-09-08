// Per-session scheduled-send state. Poll-based: the server fires sends on
// its own clock and broadcasts the resulting user message over the normal
// message stream, so this hook only needs to (a) show what is still
// pending/counting down and (b) reconcile to the server's authoritative
// sent/failed state shortly after a fire time passes. Cross-tab changes
// are absorbed by a light poll while anything is pending.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './useApi'
import type { ScheduledSend, ScheduledSendBody } from '../../shared/scheduled-send'

export interface ScheduledSendsApi {
  schedules: ScheduledSend[]
  now: number
  schedule: (fireAt: number, body: ScheduledSendBody) => Promise<void>
  cancel: (id: string) => Promise<void>
  dismiss: (id: string) => Promise<void>
  hasPending: boolean
}

/** Poll cadence while the session has pending schedules. */
const POLL_MS = 3_000

export function useScheduledSends(sessionId: string): ScheduledSendsApi {
  const [schedules, setSchedules] = useState<ScheduledSend[]>([])
  const [now, setNow] = useState(() => Date.now())
  const refreshingRef = useRef(false)
  /** Earliest pending fireAt we already reconciled past — guards the
   *  crossing effect so it fires once per distinct fire time, not on every
   *  one-second tick while a late-firing schedule lingers. */
  const reconciledRef = useRef<number>(Infinity)

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    try {
      const res = await api.get<{ schedules: ScheduledSend[] }>(`/sessions/${sessionId}/schedules`)
      setSchedules(res.schedules)
    } catch {
      // session gone / network — leave last known list; poll stops naturally
    } finally {
      refreshingRef.current = false
    }
  }, [sessionId])

  // Initial load when the session changes. Uses an async IIFE with a
  // cancelled flag so the setState inside refresh() happens after an await
  // (not synchronously in the effect body), satisfying the
  // react-hooks/set-state-in-effect lint rule.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!cancelled) await refresh()
    })()
    return () => { cancelled = true }
  }, [refresh])

  const pending = useMemo(() => schedules.filter((s) => s.status === 'pending'), [schedules])

  // Countdown clock + poll while anything is pending.
  useEffect(() => {
    if (pending.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    const poll = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(t); clearInterval(poll) }
  }, [pending.length, refresh])

  // The moment the earliest pending fire time passes, reconcile immediately
  // so a sent/failed transition removes/red-flags the chip without waiting
  // for the next poll tick.
  const earliestFire = useMemo(() => {
    if (pending.length === 0) return Infinity
    return Math.min(...pending.map((s) => s.fireAt))
  }, [pending])

  useEffect(() => {
    if (earliestFire === Infinity) {
      reconciledRef.current = Infinity
      return
    }
    if (now < earliestFire) return
    if (reconciledRef.current === earliestFire) return
    reconciledRef.current = earliestFire
    void refresh()
  }, [now, earliestFire, refresh])

  const schedule = useCallback(async (fireAt: number, body: ScheduledSendBody) => {
    await api.post<{ schedule: ScheduledSend }>(`/sessions/${sessionId}/schedules`, { fireAt, ...body })
    await refresh()
  }, [sessionId, refresh])

  const cancel = useCallback(async (id: string) => {
    setSchedules((prev) => prev.filter((s) => s.id !== id))
    try { await api.delete(`/sessions/${sessionId}/schedules/${id}`) } catch { /* reconcile later */ }
  }, [sessionId])

  const dismiss = useCallback(async (id: string) => {
    setSchedules((prev) => prev.filter((s) => s.id !== id))
    try { await api.delete(`/sessions/${sessionId}/schedules/${id}`) } catch { /* reconcile later */ }
  }, [sessionId])

  return {
    schedules,
    now,
    schedule,
    cancel,
    dismiss,
    hasPending: pending.length > 0,
  }
}
