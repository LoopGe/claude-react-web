import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import { emitProfilesChanged, onProfilesChanged } from '../utils/profiles-events'
import type { ProviderProfile } from '../types/config'

export interface ProfilesData {
  profiles: ProviderProfile[]
  activeProfileId?: string
  refresh: () => Promise<void>
  create: (input: Record<string, unknown>) => Promise<ProviderProfile | undefined>
  update: (id: string, input: Record<string, unknown>) => Promise<void>
  remove: (id: string) => Promise<void>
  activate: (id: string, restartSessions?: string[]) => Promise<{
    activeProfileId?: string
    restarted?: string[]
    skipped?: string[]
  }>
}

// Module-scoped generation timeline shared by ALL hook instances: profiles
// are global state, and sibling consumers (ProfileSwitcher refreshes on the
// crw-profiles-changed event) must discard their pre-write in-flight GETs
// when some other instance mutates — a per-instance counter would leave that
// hole open.
let profilesFetchGeneration = 0

export function useProfiles(): ProfilesData {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>()
  // Every mutation bumps the shared generation, so a GET that was already in
  // flight when the mutation fired — its snapshot predates the write — can
  // never land. Without the guard, the mutation's refresh() dedups into that
  // stale GET and `profiles` misses the mutation's effect (e.g. the settings
  // tab pins its accordion to a created id that no card has).
  const inFlight = useRef<{ promise: Promise<void>; generation: number } | null>(null)

  const refresh = useCallback(async () => {
    if (inFlight.current && inFlight.current.generation === profilesFetchGeneration) {
      return inFlight.current.promise
    }
    const generation = profilesFetchGeneration
    const p = api.get<{ profiles: ProviderProfile[]; activeProfileId: string }>('/profiles')
      .then((data) => {
        // A mutation (here or in a sibling instance) bumped the generation
        // after this GET was issued: its snapshot is pre-write and must not
        // clobber the newer state.
        if (generation !== profilesFetchGeneration) return
        setProfiles(data.profiles ?? [])
        setActiveProfileId(data.activeProfileId)
      })
      .catch(() => {})
    inFlight.current = { promise: p, generation }
    try { await p } finally {
      // Identity guard: a superseding refresh may already have replaced the
      // record — this (older) one must not clear it.
      if (inFlight.current?.promise === p) inFlight.current = null
    }
    return p
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Self-heal on sibling mutations. Every instance listens for
  // `crw-profiles-changed`; the generation guard turns the listener's
  // refresh() into a FRESH GET whenever the instance's own in-flight GET was
  // suppressed as pre-write, so an instance that never mutates (the session
  // profile select, the settings tab) can never sit on a stale-or-empty
  // snapshot. This instance's own emits dedup into the mutation's refresh.
  useEffect(() => onProfilesChanged(() => { void refresh() }), [refresh])

  // Shared mutation tail. Every successful mutation bumps the shared
  // generation (invalidating any pre-write GET, here and in sibling
  // instances), emits the invalidation event BEFORE refetching — so this
  // instance's own post-mutation GET and every listener's dedup into one
  // request — and refreshes. One helper so a new mutation cannot forget the
  // bump, the emit, or the refresh.
  const mutate = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    const res = await run()
    profilesFetchGeneration += 1
    emitProfilesChanged()
    await refresh()
    return res
  }, [refresh])

  // Resolves with the created profile (the server echoes it back, 201) so
  // callers can focus/expand the fresh card. Undefined when the response
  // shape is unexpected.
  const create = useCallback((input: Record<string, unknown>): Promise<ProviderProfile | undefined> =>
    mutate(async () => {
      const res = await api.post<{ profile?: ProviderProfile }>('/profiles', input)
      return res?.profile
    }), [mutate])

  const update = useCallback((id: string, input: Record<string, unknown>): Promise<void> =>
    mutate(() => api.put(`/profiles/${id}`, input).then(() => undefined)), [mutate])

  const remove = useCallback((id: string): Promise<void> =>
    mutate(() => api.delete(`/profiles/${id}`).then(() => undefined)), [mutate])

  const activate = useCallback((id: string, restartSessions?: string[]): Promise<{
    activeProfileId?: string
    restarted?: string[]
    skipped?: string[]
  }> =>
    mutate(async () => {
      const res = await api.post<{ activeProfileId?: string; restarted?: string[]; skipped?: string[] }>(
        '/profiles/activate', {
          profileId: id,
          ...(restartSessions && restartSessions.length > 0 ? { restartSessions } : {}),
        },
      )
      return res ?? {}
    }), [mutate])

  return { profiles, activeProfileId, refresh, create, update, remove, activate }
}
