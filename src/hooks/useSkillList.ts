// Shared filesystem skill list + global policy read (GET /skills). Both
// Skills-tab consumers — the session policy card and the loaded-skill rows —
// resolve through here so the fetch, error and staleness handling live in
// one place instead of drifting per caller.

import { useLayoutEffect, useState } from 'react'
import { api } from './useApi'
import type { SkillLoadMode, SkillRecord } from '../../shared/skills'

export interface SkillListState {
  /** Raw list — callers filter/resolve to their own needs (the policy card
   *  drops invalid skills; the rows keep them previewable). */
  skills: SkillRecord[]
  policy: { mode: SkillLoadMode; enabledSkills: string[] } | null
  /** True once the first response (success or failure) settled. */
  loaded: boolean
  error: string | null
}

type SkillListResponse = {
  skills: SkillRecord[]
  policy: NonNullable<SkillListState['policy']>
}

/** In-flight reads keyed by cwd. The Skills tab mounts two consumers that
 *  need the same byte-identical read — share the request instead of
 *  double-fetching. Entries are dropped on settle so a later re-read
 *  (cwd switch back, remount) always goes to the server. */
const inflight = new Map<string, Promise<SkillListResponse>>()

function fetchSkillList(cwd?: string): Promise<SkillListResponse> {
  const key = cwd ?? ''
  let req = inflight.get(key)
  if (!req) {
    const cwdParam = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    // In-flight sharing only: the entry is dropped once the request settles,
    // so a later read (remount, cwd switch back) always goes to the server.
    req = api
      .get<SkillListResponse>(`/skills${cwdParam}`)
      .finally(() => inflight.delete(key))
    inflight.set(key, req)
  }
  return req
}

export function useSkillList(cwd?: string): SkillListState {
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [policy, setPolicy] = useState<SkillListState['policy']>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Layout effect, not passive: the cleanup (which marks the old read stale)
  // must run at commit time — a passive cleanup would leave a microtask
  // window where a stale response still passes the `active` check.
  /* eslint-disable react-hooks/set-state-in-effect -- the clean-slate reset
     must land with the cwd commit; a passive reset would let the previous
     workspace's list render (and stay interactive) for a frame */
  useLayoutEffect(() => {
    let active = true
    // A cwd change starts from a clean slate: the previous workspace's list
    // must not stay rendered (and interactive) while the new read is in
    // flight or if it fails.
    setSkills([])
    setPolicy(null)
    setLoaded(false)
    setError(null)
    fetchSkillList(cwd)
      .then((r) => {
        if (!active) return
        setSkills(r.skills)
        setPolicy(r.policy)
        setLoaded(true)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!active) return
        setError((e as Error).message || 'Failed to load skills')
        setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [cwd])
  /* eslint-enable react-hooks/set-state-in-effect */

  return { skills, policy, loaded, error }
}
