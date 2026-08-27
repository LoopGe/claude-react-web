import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS, createSampler } from './sampler.js'
import type { RawSnapshot } from './collect.js'

describe('createSampler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('samples on the configured interval and emits payloads', async () => {
    vi.useFakeTimers()
    const collect = vi.fn(async (): Promise<RawSnapshot> => ({ cpu: { currentLoad: 10 } }))
    const emitPayload = vi.fn()
    const sampler = createSampler({ collect, emitPayload })

    sampler.activate({ 'system-stats.claude-react-web.intervalMs': 200 })
    expect(collect).not.toHaveBeenCalled() // nothing until the first interval elapses
    await vi.advanceTimersByTimeAsync(200)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(emitPayload).toHaveBeenCalledTimes(1) // cpu row → non-empty payload
    await vi.advanceTimersByTimeAsync(200)
    expect(collect).toHaveBeenCalledTimes(2)
    sampler.deactivate()
  })

  it('clamps a sub-MIN interval up to MIN so it cannot tight-loop', async () => {
    vi.useFakeTimers()
    const collect = vi.fn(async (): Promise<RawSnapshot> => ({ cpu: { currentLoad: 10 } }))
    const emitPayload = vi.fn()
    const sampler = createSampler({ collect, emitPayload })

    sampler.activate({ 'system-stats.claude-react-web.intervalMs': 5 })
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1)
    expect(collect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(collect).toHaveBeenCalledTimes(1)
    sampler.deactivate()
  })

  it('clamps an above-2^31 interval down to MAX so setTimeout cannot wrap to 1ms', async () => {
    vi.useFakeTimers()
    const collect = vi.fn(async (): Promise<RawSnapshot> => ({ cpu: { currentLoad: 10 } }))
    const emitPayload = vi.fn()
    const sampler = createSampler({ collect, emitPayload })

    sampler.activate({ 'system-stats.claude-react-web.intervalMs': 2_147_483_648 })
    // If the value reached setTimeout unwrapped, Node would clamp it to 1ms and
    // we'd see a sample here. The clamp must hold it off.
    await vi.advanceTimersByTimeAsync(1000)
    expect(collect).not.toHaveBeenCalled()
    expect(MAX_INTERVAL_MS).toBeLessThan(2 ** 31 - 1)
    sampler.deactivate()
  })

  it('does not reschedule after deactivate, even when a collect is in flight', async () => {
    vi.useFakeTimers()
    let release!: (s: RawSnapshot) => void
    const collect = vi.fn(
      () => new Promise<RawSnapshot>((resolve) => { release = resolve }),
    )
    const emitPayload = vi.fn()
    const sampler = createSampler({ collect, emitPayload })

    sampler.activate({ 'system-stats.claude-react-web.intervalMs': 200 })
    await vi.advanceTimersByTimeAsync(200) // first push starts; collect is pending
    expect(collect).toHaveBeenCalledTimes(1)
    sampler.deactivate() // lands while collect is in flight
    release({ cpu: { currentLoad: 10 } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(collect).toHaveBeenCalledTimes(1) // no reschedule → no further samples
    sampler.deactivate()
  })
})
