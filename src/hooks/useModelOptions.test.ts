import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
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
})
