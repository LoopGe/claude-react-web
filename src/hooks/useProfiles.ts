import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import type { ProviderProfile } from '../types/config'

export interface ProfilesData {
  profiles: ProviderProfile[]
  activeProfileId?: string
  refresh: () => Promise<void>
  create: (input: Record<string, unknown>) => Promise<void>
  update: (id: string, input: Record<string, unknown>) => Promise<void>
  remove: (id: string) => Promise<void>
  activate: (id: string) => Promise<void>
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

  const create = useCallback(async (input: Record<string, unknown>) => {
    await api.post('/profiles', input)
    await refresh()
  }, [refresh])

  const update = useCallback(async (id: string, input: Record<string, unknown>) => {
    await api.put(`/profiles/${id}`, input)
    await refresh()
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    await api.delete(`/profiles/${id}`)
    await refresh()
  }, [refresh])

  const activate = useCallback(async (id: string) => {
    await api.post('/profiles/activate', { profileId: id })
    await refresh()
  }, [refresh])

  return { profiles, activeProfileId, refresh, create, update, remove, activate }
}
