// Per-page-load probe: is this browser on the machine running the server?
//
// Drives the session-header project popover — the Reveal-in-Finder /
// Open-in-Terminal actions execute on the SERVER (they spawn `open` /
// `xdg-open` in this process, see server/routes/open-path.ts, which enforces
// the same rule per request from the TCP peer address). A remote browser tab
// must not render them.
//
// One fetch per page load, module-cached: the answer cannot change without a
// reload, because it is a function of the origin the tab was opened against
// (a tab on http://localhost:3456 always hits the server from loopback; a tab
// on a LAN address never does).

import { useEffect, useState } from 'react'
import { api } from './useApi'
import type { OpenPathCapability } from '../../shared/open-path'

let cached: boolean | null = null
let inflight: Promise<boolean> | null = null

function probe(): Promise<boolean> {
  if (!inflight) {
    inflight = api
      .get<OpenPathCapability>('/open-path/capability')
      .then((r) => {
        cached = r.local
        return r.local
      })
      .catch((err) => {
        console.warn('[open-path] capability probe failed, assuming remote:', err)
        // A FAILED probe is not an authoritative "remote" answer — don't let
        // a one-off hiccup (server restarting, transient timeout) hide the
        // actions for the whole page lifetime. Report false to this caller
        // but clear the memo so the next popover mount retries; only a real
        // { local: false } response persists in `cached`.
        inflight = null
        return false
      })
  }
  return inflight
}

/** `true` — show the open-in-Finder/Terminal actions; `false` — hide them;
 *  `null` — probe still in flight. */
export function useOpenPathCapability(): boolean | null {
  const [local, setLocal] = useState<boolean | null>(cached)
  useEffect(() => {
    if (cached !== null) return
    let cancelled = false
    probe().then((v) => {
      if (!cancelled) setLocal(v)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return local
}

/** Test-only: clear the module cache between tests. */
export function __resetOpenPathCapabilityForTest(): void {
  cached = null
  inflight = null
}
