// Fetch-on-open release notes for the What's New dialog. Rapid re-mounts (dialog
// toggle, StrictMode) each fire their own request — the SERVER coalesces them —
// and an abort on unmount / arg change keeps a slow GitHub response from landing
// after teardown.
//
// State is a request-scoped snapshot keyed by (from, to, includeFrom) and read
// through src/utils/request-snapshot.ts — the same model as useDiagnostics: the
// effect owns the fetch (so nothing sets state in its body), and `loading` is
// derived from whether the current key has settled.

import { useEffect, useState } from 'react'
import { api } from './useApi'
import type { ReleaseNote } from '../../shared/update-info'
import { snapshotFailed, snapshotLoaded, snapshotView, type RequestSnapshot } from '../utils/request-snapshot'

// The key covers the INCLUSIVITY too: `(0.7.3, 0.7.3]` and `[0.7.3, 0.7.3]`
// are different ranges, and the snapshot slot is tagged by request key — leave
// it out and flipping the flag settles on the previous range's answer.
const requestKey = (from: string, to: string, includeFrom: boolean) =>
  `${from}→${to}→${includeFrom ? 'inc' : 'exc'}`

export function useReleaseNotes(
  enabled: boolean,
  from: string | undefined,
  to: string | undefined,
  /** Make the lower bound inclusive (`[from, to]`) instead of exclusive
   *  (`(from, to]`). The About tab's "what did the version I'm running
   *  bring" query passes from === to with this set. */
  includeFrom = false,
): { releases: ReleaseNote[] | null; loading: boolean; error: string | null } {
  const [snapshot, setSnapshot] = useState<RequestSnapshot<ReleaseNote[]> | null>(null)
  const key = enabled && from && to ? requestKey(from, to, includeFrom) : null

  useEffect(() => {
    if (key === null || !from || !to) return
    const controller = new AbortController()
    api
      .get<{ releases: ReleaseNote[]; error?: string }>(
        `/release-notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
          (includeFrom ? '&includeFrom=1' : ''),
        { signal: controller.signal },
      )
      .then((next) => {
        if (controller.signal.aborted) return
        // A server-side degradation (GitHub down) arrives 200 + error. The notes
        // are still worth rendering, so both travel together in one snapshot —
        // the dialog shows the list and the failure is not a separate state.
        setSnapshot(snapshotLoaded(key, next.releases, next.error ?? null))
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setSnapshot((prev) => snapshotFailed(prev, key, err instanceof Error ? err.message : String(err)))
      })
    return () => controller.abort()
  }, [key, enabled, from, to, includeFrom])

  const view = snapshotView(snapshot, key)
  return { releases: view.data, loading: view.loading, error: view.error }
}
