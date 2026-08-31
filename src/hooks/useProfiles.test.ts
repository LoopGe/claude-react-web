import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useProfiles } from './useProfiles'
import { api } from './useApi'

vi.mock('./useApi', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }))

const PROFILES = {
  profiles: [
    { id: 'a', name: 'A', authTokenMasked: '****cdef', baseUrl: 'https://gw1', modelList: ['ma'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c', isActive: true },
    { id: 'b', name: 'B', authTokenMasked: '****1234', baseUrl: 'https://gw2', modelList: ['mb'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c', isActive: false },
  ],
  activeProfileId: 'a',
}

describe('useProfiles', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.post).mockReset()
    vi.mocked(api.put).mockReset()
    vi.mocked(api.delete).mockReset()
  })

  it('fetches and exposes profiles', async () => {
    vi.mocked(api.get).mockResolvedValue(PROFILES)
    const { result } = renderHook(() => useProfiles())
    await waitFor(() => expect(result.current.profiles).toHaveLength(2))
    expect(result.current.activeProfileId).toBe('a')
    expect(result.current.profiles[0].isActive).toBe(true)
  })

  it('calls activate on activate()', async () => {
    vi.mocked(api.get).mockResolvedValue(PROFILES)
    vi.mocked(api.post).mockResolvedValue({ ok: true })
    const { result } = renderHook(() => useProfiles())
    await waitFor(() => expect(result.current.profiles.length).toBeGreaterThan(0))
    await act(() => result.current.activate('b'))
    expect(api.post).toHaveBeenCalledWith('/profiles/activate', { profileId: 'b' })
  })

  it.each(['update', 'create', 'remove', 'activate'] as const)('dispatches crw-profiles-changed on %s', async (method) => {
    vi.mocked(api.get).mockResolvedValue(PROFILES)
    if (method === 'update') vi.mocked(api.put).mockResolvedValue({ ok: true })
    if (method === 'create') vi.mocked(api.post).mockResolvedValue({ profile: {} })
    if (method === 'remove') vi.mocked(api.delete).mockResolvedValue({ ok: true })
    if (method === 'activate') vi.mocked(api.post).mockResolvedValue({ ok: true })
    const events: Event[] = []
    const onEvent = (e: Event) => events.push(e)
    window.addEventListener('crw-profiles-changed', onEvent)
    try {
      const { result } = renderHook(() => useProfiles())
      await waitFor(() => expect(result.current.profiles.length).toBeGreaterThan(0))
      await act(() => (
        method === 'create' ? result.current.create({ name: 'N' })
          : method === 'update' ? result.current.update('b', {})
            : result.current[method]('b')
      ))
      expect(events.length).toBe(1)
    } finally {
      window.removeEventListener('crw-profiles-changed', onEvent)
    }
  })
})
