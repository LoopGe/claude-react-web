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
import type { PublishedVersions, UpdateActionResult, UpdateInfo } from '../../shared/update-info'

/** Server allows up to 120s for `npm i -g`; give the client request room
 *  beyond that so it doesn't time out before npm does. */
const UPDATE_TIMEOUT_MS = 130_000

interface UseUpdateInfo {
  info: UpdateInfo | null
  loading: boolean
  /** True only when the user explicitly asked for a fresh probe via
   *  `refresh()`. Lets the About tab show a separate spinner on the
   *  Check-now button without blocking the banner. */
  refreshing: boolean
  error: string | null
  /** Force a fresh probe. With no argument, probes the registry the server
   *  has persisted (`?force=1`). Pass `registryOverride` to instead probe a
   *  URL the user has type but not yet saved (`?registry=<url>`) — used by
   *  the setup wizard and the About tab's "Check now" so the result reflects
   *  the in-progress edit rather than the stale saved value. An empty string
   *  is a meaningful override ("test the disabled state"), distinct from
   *  `undefined` (probe the saved value). */
  refresh: (registryOverride?: string) => void
  /** True while POST /api/update is in flight. */
  updating: boolean
  /** Trigger the in-app update. With no argument, installs `@latest` (the
   *  dist-tag upgrade path). Pass a concrete `version` to pin a specific
   *  published release (the version switcher's downgrade / forward-pin).
   *  Resolves with the action result, or throws on failure. */
  update: (version?: string) => Promise<UpdateActionResult>
  /** Published-versions list for the version switcher, or null before the
   *  first fetch completes. Fetched on demand via `fetchVersions()` — never
   *  auto-fetched on mount (it's a heavier packument read the banner/About
   *  view don't need). */
  versions: PublishedVersions | null
  /** True while the versions list is being fetched (first load or refresh). */
  versionsLoading: boolean
  /** Error from the most recent versions fetch; surfaced in the switcher. */
  versionsError: string | null
  /** Fetch the published-versions list. Idempotent: a concurrent call joins
   *  the in-flight one rather than stacking requests. Pass `true` to force a
   *  refresh bypassing the server cache. */
  fetchVersions: (force?: boolean) => void
}

export function useUpdateInfo(enabled: boolean): UseUpdateInfo {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Published-versions list for the version switcher. Separate state from
  // `info` (different endpoint, heavier fetch, on-demand only).
  const [versions, setVersions] = useState<PublishedVersions | null>(null)
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  // In-flight guard for the versions fetch, mirroring inFlightRef: rapid
  // clicks on "Switch version" coalesce into one request.
  const versionsInFlightRef = useRef<AbortController | null>(null)
  // Track whether a fetch is in flight so concurrent refresh() calls
  // (rapid clicks on Check-now) don't pile up. We also remember whether
  // the in-flight call was forced — a later force=true caller must NOT
  // be silently joined to an unforced probe (the server rev did the
  // same fix in update-checker.ts).
  const inFlightRef = useRef<{ force: boolean; controller: AbortController } | null>(null)
  // A force/override probe requested while the unforced mount probe was
  // still in flight. We remember the override value too (not just a bool)
  // so the escalated follow-up probes the URL the user actually type,
  // rather than collapsing to a plain `?force=1` against the saved value.
  const pendingForceRef = useRef<{ override?: string } | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Abort any in-flight fetch so its setState calls don't fire
      // against an unmounted component and the closure (response body,
      // captured DOM) can be released.
      inFlightRef.current?.controller.abort()
      versionsInFlightRef.current?.abort()
    }
  }, [])

  const fetchInfo = useCallback(
    async (forceArg: boolean, overrideArg?: string): Promise<void> => {
      // The pending-force escalation is implemented as a loop rather than
      // a self-call: useCallback identifies the function via its closure,
      // and re-referencing `fetchInfo` inside its own body trips the
      // immutability lint (and would also pin a stale snapshot of self).
      // Looping keeps the same observable behavior — start a forced probe
      // immediately after the unforced one settles — without the cycle.
      //
      // `override` (when not undefined) probes a caller-supplied registry
      // URL via `?registry=<url>` instead of the saved value; it always
      // implies a forced/blocking probe.
      let force = forceArg
      let override = overrideArg
      while (true) {
        if (inFlightRef.current) {
          // An unforced probe is mid-flight and the user just asked for a
          // force/override. Mark a pending follow-up so we re-fire once the
          // current call settles. Multiple clicks coalesce into a single
          // follow-up; the latest override wins.
          if ((force || override !== undefined) && !inFlightRef.current.force) {
            pendingForceRef.current = { override }
          }
          return
        }
        const controller = new AbortController()
        inFlightRef.current = { force: force || override !== undefined, controller }
        if (force || override !== undefined) setRefreshing(true)
        else setLoading(true)
        setError(null)
        let aborted = false
        try {
          const path =
            override !== undefined
              ? `/update-info?registry=${encodeURIComponent(override)}`
              : force
                ? '/update-info?force=1'
                : '/update-info'
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
        // A force/override was requested while an unforced probe was in
        // flight — honour it now so the user actually sees a fresh hit.
        if (pendingForceRef.current && mountedRef.current) {
          const pending = pendingForceRef.current
          pendingForceRef.current = null
          force = true
          override = pending.override
          continue
        }
        return
      }
    },
    [],
  )

  useEffect(() => {
    if (!enabled) return
    // setState calls inside fetchInfo are intentional — same pattern
    // useGitStatus uses for its mount fetch: the fetch is deliberately
    // initiated when the dependency flips.
    void fetchInfo(false)
  }, [enabled, fetchInfo])

  const refresh = useCallback(
    (registryOverride?: string) => {
      void fetchInfo(true, registryOverride)
    },
    [fetchInfo],
  )

  const updatingRef = useRef(false)
  const update = useCallback(async (version?: string): Promise<UpdateActionResult> => {
    // Guard against double-clicks driving two POSTs (the server also rejects
    // concurrent installs with 409, but this avoids the round-trip).
    if (updatingRef.current) {
      throw new Error('update already in progress')
    }
    updatingRef.current = true
    if (mountedRef.current) {
      setUpdating(true)
      setError(null)
    }
    try {
      // No version → no body (the original dist-tag upgrade path). A concrete
      // version → `{ version }` so the server pins the install; the server
      // validates it against its published-versions list before npm runs.
      return await api.post<UpdateActionResult>(
        '/update',
        version ? { version } : undefined,
        { timeoutMs: UPDATE_TIMEOUT_MS },
      )
    } finally {
      updatingRef.current = false
      if (mountedRef.current) setUpdating(false)
    }
  }, [])

  const fetchVersions = useCallback((force = false): void => {
    // Coalesce concurrent calls: a request already in flight satisfies the
    // next caller without stacking a second fetch.
    if (versionsInFlightRef.current) return
    const controller = new AbortController()
    versionsInFlightRef.current = controller
    if (mountedRef.current) {
      setVersionsLoading(true)
      setVersionsError(null)
    }
    api
      .get<PublishedVersions>(`/update-info/versions${force ? '?force=1' : ''}`, {
        signal: controller.signal,
      })
      .then((next) => {
        if (mountedRef.current && !controller.signal.aborted) setVersions(next)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        if (mountedRef.current) {
          setVersionsError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        versionsInFlightRef.current = null
        if (mountedRef.current && !controller.signal.aborted) setVersionsLoading(false)
      })
  }, [])

  return {
    info,
    loading,
    refreshing,
    error,
    refresh,
    updating,
    update,
    versions,
    versionsLoading,
    versionsError,
    fetchVersions,
  }
}
