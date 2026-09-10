// Fetch-on-open release notes for the What's New dialog. Mirrors the
// in-flight coalescing of useUpdateInfo: rapid re-mounts (dialog toggle,
// StrictMode) share one request. Abort on unmount / arg change so a slow
// GitHub response can't setState after teardown.

import { useEffect, useState } from 'react'
import { api } from './useApi'
import type { ReleaseNote } from '../../shared/update-info'

export function useReleaseNotes(
  enabled: boolean,
  from: string | undefined,
  to: string | undefined,
): { releases: ReleaseNote[] | null; loading: boolean; error: string | null } {
  const [releases, setReleases] = useState<ReleaseNote[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !from || !to) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api
      .get<{ releases: ReleaseNote[]; error?: string }>(
        `/release-notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { signal: controller.signal },
      )
      .then((next) => {
        if (controller.signal.aborted) return
        // A server-side degradation (GitHub down) arrives 200 + error;
        // surface it in the same slot as a transport failure.
        setReleases(next.releases)
        if (next.error) setError(next.error)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [enabled, from, to])

  return { releases, loading, error }
}
