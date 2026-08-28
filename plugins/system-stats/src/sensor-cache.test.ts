import { afterEach, describe, expect, it, vi } from 'vitest'
import { withSensorCache } from './sensor-cache.js'

describe('withSensorCache', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves the cached value within the TTL and re-queries after it elapses', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => 27)
    const cached = withSensorCache(probe, 1000)

    expect(await cached()).toBe(27)
    expect(await cached()).toBe(27) // within TTL → no re-query
    expect(probe).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1001)
    expect(await cached()).toBe(27)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent calls while a query is in flight', async () => {
    let release!: (v: number) => void
    const probe = vi.fn(() => new Promise<number>((r) => { release = r }))
    const cached = withSensorCache(probe, 1000)

    const p1 = cached()
    const p2 = cached()
    expect(probe).toHaveBeenCalledTimes(1) // one in-flight query shared
    release(42)
    expect(await p1).toBe(42)
    expect(await p2).toBe(42)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('caches an undefined result too (machine without a readable temperature)', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => undefined as number | undefined)
    const cached = withSensorCache(probe, 1000)

    expect(await cached()).toBeUndefined()
    expect(await cached()).toBeUndefined() // still cached
    expect(probe).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1001)
    await cached()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('recovers after the probe rejects', async () => {
    vi.useFakeTimers()
    const probe = vi
      .fn<() => Promise<number | undefined>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(30)
    const cached = withSensorCache(probe, 1000)

    await expect(cached()).rejects.toThrow('boom')
    await vi.advanceTimersByTimeAsync(1) // hasCached=false → re-queries immediately
    expect(await cached()).toBe(30)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('forwards the abort signal to the underlying probe on a cache miss', async () => {
    const ac = new AbortController()
    const probe = vi.fn(async () => 27)
    const cached = withSensorCache(probe, 1000)
    await cached(ac.signal)
    expect(probe).toHaveBeenCalledWith(ac.signal)
  })
})
