import { describe, expect, it, vi } from 'vitest'
import { createDisplayPrefSaver } from './display-pref-save'

describe('createDisplayPrefSaver', () => {
  it('serializes writes in click order', async () => {
    type Patch = { rowGap: string }
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const put = vi.fn(async (_path: string, body: Patch) => {
      order.push(body.rowGap)
      if (body.rowGap === 'comfortable') await firstGate
    })
    const saver = createDisplayPrefSaver<Patch>({
      put,
      onSaved: () => {},
      onError: () => {},
      refresh: async () => {},
    })

    const first = saver({ rowGap: 'comfortable' })
    const second = saver({ rowGap: 'airy' })

    // The second write must not start until the first settles — independent
    // fetches are not ordered across connections.
    await Promise.resolve()
    expect(put).toHaveBeenCalledTimes(1)

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['comfortable', 'airy'])
  })

  it('coalesces clicks that pile up behind an in-flight write', async () => {
    type Patch = { rowGap?: string; fontSize?: string }
    const writes: Patch[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const put = vi.fn(async (_path: string, body: Patch) => {
      writes.push(body)
      if (writes.length === 1) await firstGate
    })
    const saver = createDisplayPrefSaver<Patch>({
      put,
      onSaved: () => {},
      onError: () => {},
      refresh: async () => {},
    })

    const first = saver({ rowGap: 'comfortable' })
    // These land while the first write is still in flight; last-wins per key
    // must fold them into a single follow-up write.
    void saver({ rowGap: 'airy' })
    void saver({ rowGap: 'compact' })
    void saver({ fontSize: 'xlarge' })

    await Promise.resolve()
    expect(put).toHaveBeenCalledTimes(1)

    releaseFirst()
    await first

    expect(writes).toEqual([
      { rowGap: 'comfortable' },
      { rowGap: 'compact', fontSize: 'xlarge' },
    ])
  })

  it('reports only the keys a queued click has not superseded', async () => {
    type Patch = { rowGap?: string; fontSize?: string }
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const onSaved = vi.fn()
    const put = vi.fn(async (_path: string, body: Patch) => {
      if (body.fontSize === 'xlarge') await firstGate
    })
    const saver = createDisplayPrefSaver<Patch>({
      put,
      onSaved,
      onError: () => {},
      refresh: async () => {},
    })

    const first = saver({ rowGap: 'comfortable', fontSize: 'xlarge' })
    // A newer rowGap click is queued while the first write is in flight.
    void saver({ rowGap: 'airy' })
    releaseFirst()
    await first

    // The first write's fontSize landed and is reported; its rowGap is stale
    // and must be left to the queued write (which reports it next).
    expect(onSaved).toHaveBeenNthCalledWith(1, { fontSize: 'xlarge' })
    expect(onSaved).toHaveBeenNthCalledWith(2, { rowGap: 'airy' })
  })

  it('reports the saved patch after the write lands', async () => {
    type Patch = { fontSize: string }
    const onSaved = vi.fn()
    const saver = createDisplayPrefSaver<Patch>({
      put: async () => {},
      onSaved,
      onError: () => {},
      refresh: async () => {},
    })

    await saver({ fontSize: 'xlarge' })

    expect(onSaved).toHaveBeenCalledWith({ fontSize: 'xlarge' })
  })

  it('reports a failed write, reconciles from the server, and keeps the chain usable', async () => {
    type Patch = { fontSize: string }
    const onError = vi.fn()
    const onRefreshError = vi.fn()
    const onSaved = vi.fn()
    const refresh = vi.fn(async () => {})
    const put = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)
    const saver = createDisplayPrefSaver<Patch>({
      put,
      onSaved,
      onError,
      refresh,
      onRefreshError,
    })

    await saver({ fontSize: 'xlarge' })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }))
    expect(refresh).toHaveBeenCalledOnce()
    expect(onSaved).not.toHaveBeenCalled()

    // The chain is not poisoned: the next write still lands.
    await saver({ fontSize: 'large' })
    expect(onSaved).toHaveBeenCalledWith({ fontSize: 'large' })
  })

  it('does not treat a throwing success hook as a failed write', async () => {
    type Patch = { fontSize: string }
    const onError = vi.fn()
    const onSavedError = vi.fn()
    const refresh = vi.fn(async () => {})
    const saver = createDisplayPrefSaver<Patch>({
      put: async () => {},
      onSaved: () => { throw new Error('boom') },
      onSavedError,
      onError,
      refresh,
    })

    await saver({ fontSize: 'xlarge' })

    // The PUT succeeded; a success-hook bug must not look like a rejected
    // write (which would reconcile and flash the previous value).
    expect(onError).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(onSavedError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
  })

  it('reports a failed reconcile separately from the failed write', async () => {
    type Patch = { rowGap: string }
    const onError = vi.fn()
    const onRefreshError = vi.fn()
    const saver = createDisplayPrefSaver<Patch>({
      put: async () => { throw new Error('write failed') },
      onSaved: () => {},
      onError,
      refresh: async () => { throw new Error('refresh failed') },
      onRefreshError,
    })

    await saver({ rowGap: 'airy' })

    expect(onError).toHaveBeenCalledOnce()
    expect(onRefreshError).toHaveBeenCalledWith(expect.objectContaining({ message: 'refresh failed' }))
  })
})