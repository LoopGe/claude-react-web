import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import { emitProfilesChanged } from '../utils/profiles-events'
import type { ProviderProfile } from '../types/config'

export interface ProfilesData {
  profiles: ProviderProfile[]
  activeProfileId?: string
  refresh: () => Promise<void>
  create: (input: Record<string, unknown>) => Promise<void>
  update: (id: string, input: Record<string, unknown>) => Promise<void>
  remove: (id: string) => Promise<void>
  activate: (id: string, restartSessions?: string[]) => Promise<{
    activeProfileId?: string
    restarted?: string[]
    skipped?: string[]
  }>
}

export function useProfiles(): ProfilesData {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>()
  const inFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current
    const p = api.get<{ profiles: ProviderProfile[]; activeProfileId: string }>('/profiles')
      .then((data) => {
        setProfiles(data.profiles ?? [])
        setActiveProfileId(data.activeProfileId)
      })
      .catch(() => {})
    inFlight.current = p
    try { await p } finally { inFlight.current = null }
    return p
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Every successful mutation refreshes this instance AND emits the
  // invalidation event so sibling consumers (e.g. useModelOptions in a
  // mounted SettingsPanel — a hook instance we can't reach from here)
  // drop their cached profile-derived data and refetch.
  const create = useCallback(async (input: Record<string, unknown>) => {
    await api.post('/profiles', input)
    await refresh()
    emitProfilesChanged()
  }, [refresh])

  const update = useCallback(async (id: string, input: Record<string, unknown>) => {
    await api.put(`/profiles/${id}`, input)
    await refresh()
    emitProfilesChanged()
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    await api.delete(`/profiles/${id}`)
    await refresh()
    emitProfilesChanged()
  }, [refresh])

  const activate = useCallback(async (id: string, restartSessions?: string[]): Promise<{
    activeProfileId?: string
    restarted?: string[]
    skipped?: string[]
  }> => {
    const res = await api.post<{ activeProfileId?: string; restarted?: string[]; skipped?: string[] }>(
      '/profiles/activate', {
        profileId: id,
        ...(restartSessions && restartSessions.length > 0 ? { restartSessions } : {}),
      },
    )
    await refresh()
    emitProfilesChanged()
    return res ?? {}
  }, [refresh])

  return { profiles, activeProfileId, refresh, create, update, remove, activate }
}
