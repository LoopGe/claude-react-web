import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchConfig,
  fetchModelOptions,
  invalidateModelOptions,
  peekConfig,
  peekModelOptions,
  resetModelOptionsStoreForTest,
  subscribeModelOptions,
} from './modelOptionsStore'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn() } }))

describe('modelOptionsStore', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    resetModelOptionsStoreForTest()
    window.localStorage.clear()
  })

  it('dedupes concurrent fetchConfig calls into one request', async () => {
    vi.mocked(api.get).mockResolvedValue({ models: ['m1'], modelGroups: [] })
    const [a, b] = await Promise.all([fetchConfig(), fetchConfig()])
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('force refetches past a cached config', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ models: ['old'] })
    await fetchConfig()
    vi.mocked(api.get).mockResolvedValueOnce({ models: ['new'] })
    const r = await fetchConfig({ force: true })
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(r.models).toEqual(['new'])
    expect(peekConfig()?.models).toEqual(['new'])
  })

  it('derives the active-profile model snapshot from /config', async () => {
    vi.mocked(api.get).mockResolvedValue({
      models: ['c1', 'c1', 'c2'],
      modelGroups: [{ id: 'g1', name: 'Flagship', opus: 'c1' }],
    })
    const snap = await fetchModelOptions()
    expect(api.get).toHaveBeenCalledWith('/config')
    expect(snap.models.map((m) => m.id)).toEqual(['c1', 'c2'])
    expect(snap.defaultModel).toBe('c1')
    expect(snap.modelGroups).toHaveLength(1)
    expect(peekModelOptions()).toEqual(snap)
  })

  it('loads a pinned profile from /profiles and caches it separately', async () => {
    vi.mocked(api.get).mockResolvedValue({
      profiles: [{ id: 'p1', modelList: ['px1'], modelGroups: [] }],
    })
    const snap = await fetchModelOptions('p1')
    expect(api.get).toHaveBeenCalledWith('/profiles')
    expect(snap.models.map((m) => m.id)).toEqual(['px1'])
    // Cached: a second peek/read does not refetch.
    vi.mocked(api.get).mockClear()
    await fetchModelOptions('p1')
    expect(api.get).not.toHaveBeenCalled()
  })

  it('keeps profile snapshots independent so a switch never shows the old list', async () => {
    vi.mocked(api.get).mockResolvedValue({
      profiles: [{ id: 'p1', modelList: ['p1-model'], modelGroups: [] }],
    })
    await fetchModelOptions('p1')
    // p2 has never been fetched — empty, not p1's list.
    expect(peekModelOptions('p2')).toBeNull()
  })

  it('notifies subscribers when a fetch lands', async () => {
    const seen: number[] = []
    const unsub = subscribeModelOptions(() => seen.push(1))
    vi.mocked(api.get).mockResolvedValue({ models: ['m1'] })
    await fetchModelOptions()
    expect(seen.length).toBeGreaterThan(0)
    unsub()
  })

  it('invalidate drops the cache so the next fetch hits the network', async () => {
    vi.mocked(api.get).mockResolvedValue({ models: ['old'] })
    await fetchModelOptions()
    invalidateModelOptions()
    expect(peekModelOptions()).toBeNull()
    vi.mocked(api.get).mockResolvedValue({ models: ['new'] })
    const snap = await fetchModelOptions()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(snap.models.map((m) => m.id)).toEqual(['new'])
  })

  it('discards a pre-invalidate response that lands after the new generation', async () => {
    let resolveSlow: (v: unknown) => void = () => {}
    vi.mocked(api.get).mockImplementationOnce(
      () => new Promise((resolve) => { resolveSlow = resolve }),
    )
    const slow = fetchModelOptions()
    invalidateModelOptions()
    vi.mocked(api.get).mockResolvedValueOnce({ models: ['fresh'] })
    const fresh = await fetchModelOptions()
    expect(fresh.models.map((m) => m.id)).toEqual(['fresh'])
    // The slow pre-invalidate response lands last — must not clobber 'fresh'.
    resolveSlow({ models: ['stale'] })
    await slow
    expect(peekModelOptions()?.models.map((m) => m.id)).toEqual(['fresh'])
  })

  it('does not cache the active-profile fallback under a missing pinned key', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/profiles') {
        return { profiles: [{ id: 'other', modelList: ['ox1'], modelGroups: [] }] }
      }
      return { models: ['active-1'], modelGroups: [] }
    })
    const snap = await fetchModelOptions('missing')
    // Ephemeral fallback is returned for this call…
    expect(snap.models.map((m) => m.id)).toEqual(['active-1'])
    // …but NOT stored under 'missing' (that would poison later peeks).
    expect(peekModelOptions('missing')).toBeNull()
  })

  it('keeps the previous snapshot when a force refetch fails', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ models: ['good'], modelGroups: [] })
    await fetchModelOptions()
    vi.mocked(api.get).mockRejectedValueOnce(new Error('network'))
    await expect(fetchModelOptions(undefined, { force: true })).rejects.toThrow()
    expect(peekModelOptions()?.models.map((m) => m.id)).toEqual(['good'])
  })
})
