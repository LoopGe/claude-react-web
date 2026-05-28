// React hook for the update-info endpoint.
//
// One instance is created near the top of <App> and shared down to
// <UpdateBanner> (top-of-page banner) and the About tab in
// <GlobalSettingsModal>. Both consumers see the same refresh state;
// clicking "Check now" in the modal updates the banner immediately.
//
// Auto-fetch policy: one fetch on mount when `enabled` flips true (gated
// on isConfigured at the call site so we don't probe before setup is
// done). No periodic polling — the user can hit "Check now" or restart
// the CLI to retrigger.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import type { UpdateInfo } from '../../shared/update-info'

interface UseUpdateInfo {
  info: UpdateInfo | null
  loading: boolean
  /** True only when the user explicitly asked for a fresh probe via
   *  `refresh()`. Lets the About tab show a separate spinner on the
   *  Check-now button without blocking the banner. */
  refreshing: boolean
  error: string | null
  refresh: () => void
}

export function useUpdateInfo(enabled: boolean): UseUpdateInfo {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Track whether a fetch is in flight so concurrent refresh() calls
  // (rapid clicks on Check-now) don't pile up. We also remember whether
  // the in-flight call was forced — a later force=true caller must NOT
  // be silently joined to an unforced probe (the server rev did the
  // same fix in update-checker.ts).
  const inFlightRef = useRef<{ force: boolean; controller: AbortController } | null>(null)
  const pendingForceRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Abort any in-flight fetch so its setState calls don't fire
      // against an unmounted component and the closure (response body,
      // captured DOM) can be released.
      inFlightRef.current?.controller.abort()
    }
  }, [])

  const fetchInfo = useCallback(async (forceArg: boolean): Promise<void> => {
    // The pending-force escalation is implemented as a loop rather than
    // a self-call: useCallback identifies the function via its closure,
    // and re-referencing `fetchInfo` inside its own body trips the
    // immutability lint (and would also pin a stale snapshot of self).
    // Looping keeps the same observable behavior — start a forced probe
    // immediately after the unforced one settles — without the cycle.
    let force = forceArg
    while (true) {
      if (inFlightRef.current) {
        // An unforced probe is mid-flight and the user just asked for
        // force. Mark a pending follow-up so we re-fire once the current
        // call settles. Multiple force clicks coalesce into a single
        // follow-up.
        if (force && !inFlightRef.current.force) pendingForceRef.current = true
        return
      }
      const controller = new AbortController()
      inFlightRef.current = { force, controller }
      if (force) setRefreshing(true)
      else setLoading(true)
      setError(null)
      let aborted = false
      try {
        const path = force ? '/update-info?force=1' : '/update-info'
        const next = await api.get<UpdateInfo>(path, { signal: controller.signal })
        if (mountedRef.current && !controller.signal.aborted) setInfo(next)
      } catch (err) {
        if (controller.signal.aborted) {
          aborted = true
        } else if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        inFlightRef.current = null
        if (mountedRef.current && !controller.signal.aborted) {
          setLoading(false)
          setRefreshing(false)
        }
      }
      if (aborted) return
      // A force was requested while an unforced probe was in flight —
      // honour it now so the user actually sees a fresh registry hit.
      if (pendingForceRef.current && mountedRef.current) {
        pendingForceRef.current = false
        force = true
        continue
      }
      return
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    // setState calls inside fetchInfo are intentional — same pattern
    // useGitStatus uses for its mount fetch. The "cascading renders"
    // warning is a generic heuristic; here the fetch is deliberately
    // initiated when the dependency flips.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch on enable
    void fetchInfo(false)
  }, [enabled, fetchInfo])

  const refresh = useCallback(() => {
    void fetchInfo(true)
  }, [fetchInfo])

  return { info, loading, refreshing, error, refresh }
}
