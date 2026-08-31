import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useModelOptions } from './useModelOptions'
import { api } from './useApi'

vi.mock('./useApi', () => ({ api: { get: vi.fn() } }))

describe('useModelOptions', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    // readRecentModels() reads localStorage; jsdom starts empty.
    window.localStorage.clear()
  })

  it('returns modelGroups from /config alongside models', async () => {
    vi.mocked(api.get).mockResolvedValue({
      models: ['m1'],
      modelGroups: [{ id: 'g1', name: 'Flagship', opus: 'm1', main: 'opus' }],
    })
    const { result } = renderHook(() => useModelOptions('s1', true))
    await waitFor(() => expect(result.current.modelGroups.length).toBe(1))
    expect(result.current.modelGroups[0]).toMatchObject({ id: 'g1', name: 'Flagship', opus: 'm1' })
    expect(result.current.models.map((m) => m.id)).toEqual(['m1'])
  })

  it('defaults modelGroups to [] when the response omits it', async () => {
    vi.mocked(api.get).mockResolvedValue({ models: ['m1'] })
    const { result } = renderHook(() => useModelOptions('s1', true))
    await waitFor(() => expect(result.current.models.length).toBe(1))
    expect(result.current.modelGroups).toEqual([])
  })

  it('uses profile models when profileId is provided', async () => {
    vi.mocked(api.get).mockResolvedValue({
      profiles: [
        { id: 'p1', modelList: ['px1', 'px2'], modelGroups: [{ id: 'g2', name: 'Pro', opus: 'px1', main: 'opus' }] },
      ],
    })
    const { result } = renderHook(() => useModelOptions('s1', true, 'p1'))
    await waitFor(() => expect(result.current.models.length).toBe(2))
    expect(result.current.models.map((m) => m.id)).toEqual(['px1', 'px2'])
    expect(result.current.defaultModel).toBe('px1')
    expect(result.current.modelGroups[0]).toMatchObject({ id: 'g2', name: 'Pro', opus: 'px1' })
    // Should NOT have called /config
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.get).toHaveBeenCalledWith('/profiles', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('refetches on reopen so profile edits made mid-session appear', async () => {
    vi.mocked(api.get).mockResolvedValue({
      profiles: [{ id: 'p1', modelList: ['old'], modelGroups: [] }],
    })
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useModelOptions('s1', enabled, 'p1'),
      { initialProps: { enabled: true } },
    )
    await waitFor(() => expect(result.current.models.map((m) => m.id)).toEqual(['old']))

    // The user edits the profile in Settings while the picker is closed,
    // then reopens the picker. The list must reflect the edit without a
    // page reload.
    vi.mocked(api.get).mockResolvedValue({
      profiles: [{ id: 'p1', modelList: ['old', 'new'], modelGroups: [] }],
    })
    rerender({ enabled: false })
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.models.map((m) => m.id)).toEqual(['old', 'new']))
  })

  it('refetches when the profiles-changed event fires while enabled', async () => {
    // SettingsPanel path: enabled stays true, so there is no open/close
    // gesture — the event is the only invalidation signal.
    vi.mocked(api.get).mockResolvedValue({
      profiles: [{ id: 'p1', modelList: ['old'], modelGroups: [] }],
    })
    const { result } = renderHook(() => useModelOptions('s1', true, 'p1'))
    await waitFor(() => expect(result.current.models.map((m) => m.id)).toEqual(['old']))

    vi.mocked(api.get).mockResolvedValue({
      profiles: [{ id: 'p1', modelList: ['old', 'added'], modelGroups: [] }],
    })
    await act(async () => {
      window.dispatchEvent(new Event('crw-profiles-changed'))
    })
    await waitFor(() => expect(result.current.models.map((m) => m.id)).toEqual(['old', 'added']))
  })

  it('does not show the previous profile\'s models while refetching after a profile switch', async () => {
    // One controllable resolver, reassigned on every fetch call, so each
    // phase of the test can resolve exactly the in-flight fetch.
    let resolveFetch: (v: unknown) => void = () => {}
    vi.mocked(api.get).mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve }),
    )
    const { result, rerender } = renderHook(
      ({ profileId }: { profileId?: string }) => useModelOptions('s1', true, profileId),
      { initialProps: { profileId: 'p1' as string | undefined } },
    )
    resolveFetch({ profiles: [{ id: 'p1', modelList: ['p1-model'], modelGroups: [] }] })
    await waitFor(() => expect(result.current.models.map((m) => m.id)).toEqual(['p1-model']))

    // Switch profile: the refetch for p2 is still pending, so the old
    // profile's list must NOT be shown as if it were p2's.
    rerender({ profileId: 'p2' })
    expect(result.current.models).toEqual([])

    resolveFetch({ profiles: [{ id: 'p2', modelList: ['p2-model'], modelGroups: [] }] })
    await waitFor(() => expect(result.current.models.map((m) => m.id)).toEqual(['p2-model']))
  })

  it('falls back to /config when profileId is not provided', async () => {
    vi.mocked(api.get).mockResolvedValue({
      models: ['c1'],
      modelGroups: [{ id: 'g1', name: 'Default', opus: 'c1', main: 'opus' }],
    })
    const { result } = renderHook(() => useModelOptions('s1', true))
    await waitFor(() => expect(result.current.models.length).toBe(1))
    expect(result.current.models.map((m) => m.id)).toEqual(['c1'])
    expect(api.get).toHaveBeenCalledWith('/config', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('falls back to /config when profileId does not match any profile', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/profiles') {
        return { profiles: [{ id: 'other', modelList: ['ox1'], modelGroups: [] }] }
      }
      return { models: ['c1', 'c2'], modelGroups: [{ id: 'g1', name: 'Default', opus: 'c1', main: 'opus' }] }
    })
    const { result } = renderHook(() => useModelOptions('s1', true, 'missing-profile'))
    await waitFor(() => expect(result.current.models.length).toBe(2))
    expect(result.current.models.map((m) => m.id)).toEqual(['c1', 'c2'])
    expect(result.current.defaultModel).toBe('c1')
    expect(api.get).toHaveBeenCalledWith('/profiles', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(api.get).toHaveBeenCalledWith('/config', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
})
