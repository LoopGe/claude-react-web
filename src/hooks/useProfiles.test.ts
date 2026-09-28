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

  it('create() resolves with the created profile from the POST response', async () => {
    vi.mocked(api.get).mockResolvedValue(PROFILES)
    const created = { id: 'p_new', name: 'N', isActive: false }
    vi.mocked(api.post).mockResolvedValue({ profile: created })
    const { result } = renderHook(() => useProfiles())
    await waitFor(() => expect(result.current.profiles.length).toBeGreaterThan(0))
    let out: unknown
    await act(async () => { out = await result.current.create({ name: 'N' }) })
    expect(out).toEqual(created)
  })

  it('create() during an in-flight refresh still lands the post-create snapshot', async () => {
    // GET #1 (mount) is issued, then create fires. Its refresh must NOT dedup
    // into GET #1 — that snapshot predates the POST and would leave `profiles`
    // without the created profile (the accordion would pin to a missing id).
    const stale = { profiles: [{ id: 'a', name: 'A', isActive: true }], activeProfileId: 'a' }
    const fresh = {
      profiles: [{ id: 'a', name: 'A', isActive: true }, { id: 'p_new', name: 'N', isActive: false }],
      activeProfileId: 'a',
    }
    let resolveStale: () => void = () => {}
    let resolveFresh: () => void = () => {}
    vi.mocked(api.get)
      .mockImplementationOnce(() => new Promise((r) => { resolveStale = () => r(stale as never) }))
      .mockImplementationOnce(() => new Promise((r) => { resolveFresh = () => r(fresh as never) }))
    vi.mocked(api.post).mockResolvedValue({ profile: { id: 'p_new', name: 'N', isActive: false } })
    const { result } = renderHook(() => useProfiles())
    await act(async () => {
      const creating = result.current.create({ name: 'N' })
      resolveStale() // the pre-POST GET completes while create awaits its POST
      // Wait for the fresh GET (post-POST) rather than spinning a fixed
      // number of microtask flushes — the chain depth may change.
      await vi.waitFor(() => expect(vi.mocked(api.get)).toHaveBeenCalledTimes(2))
      resolveFresh()
      await creating
    })
    expect(result.current.profiles.some((p) => p.id === 'p_new')).toBe(true)
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
      await act(() => {
        if (method === 'create') void result.current.create({ name: 'N' })
        else if (method === 'update') void result.current.update('b', {})
        else void result.current[method]('b')
      })
      expect(events.length).toBe(1)
    } finally {
      window.removeEventListener('crw-profiles-changed', onEvent)
    }
  })
})
