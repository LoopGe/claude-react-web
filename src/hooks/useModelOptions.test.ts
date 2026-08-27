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
})
