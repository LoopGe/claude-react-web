// Per-page-load probe: which brand "Open in …" targets are installed on the
// machine running the server (GET /open-path/apps; the server probes real
// launch candidates — see availableAppsFor in server/routes/open-path.ts).
//
// Drives the session context-menu Open-in entries — a target the server
// cannot launch must never be offered (the POST would 404). The loopback
// question (may this client use the route at all) is the separate
// useOpenPathCapability probe; both gates must pass for an entry to render.
//
// One fetch per page load, module-cached: the answer cannot change without a
// reload (installing an app mid-session doesn't re-probe — same tradeoff as
// useOpenPathCapability). A FAILED probe is not an authoritative "nothing is
// installed" answer — report [] to this caller but clear the memo so the
// next mount retries; only a real { apps: [...] } response persists.

import { useEffect, useState } from 'react'
import { api } from './useApi'
import { OPEN_PATH_APP_TARGETS, type OpenPathAppsPayload, type OpenPathTarget } from '../../shared/open-path'

let cached: OpenPathTarget[] | null = null
let inflight: Promise<OpenPathTarget[]> | null = null

function probe(): Promise<OpenPathTarget[]> {
  if (!inflight) {
    inflight = api
      .get<OpenPathAppsPayload>('/open-path/apps')
      .then((r) => {
        // A 200 with a reshaped body (proxy error page, mid-restart server)
        // is a FAILURE, not "nothing installed": throw so the catch below
        // clears the memo and the next mount retries.
        if (!Array.isArray(r.apps)) throw new Error('malformed /open-path/apps payload')
        const apps = r.apps.filter((id): id is OpenPathTarget =>
          typeof id === 'string' && (OPEN_PATH_APP_TARGETS as readonly string[]).includes(id))
        cached = apps
        return apps
      })
      .catch((err: unknown) => {
        console.warn('[open-path] apps probe failed, assuming none:', err)
        // A failed probe must not hide the entries for the whole page
        // lifetime (mirrors useOpenPathCapability's retry semantics).
        inflight = null
        return []
      })
  }
  return inflight
}

/** The brand targets installed on the server machine, in catalog order;
 *  `null` while the probe is in flight; `[]` when none are available. */
export function useOpenPathApps(): OpenPathTarget[] | null {
  const [apps, setApps] = useState<OpenPathTarget[] | null>(cached)
  useEffect(() => {
    if (cached !== null) return
    let cancelled = false
    probe().then((v) => {
      if (!cancelled) setApps(v)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return apps
}

/** Test-only: clear the module cache between tests. */
export function __resetOpenPathAppsForTest(): void {
  cached = null
  inflight = null
}
