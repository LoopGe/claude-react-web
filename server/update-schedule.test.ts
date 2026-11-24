import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateSchedule, resolveUpdateScheduleConfig, type UpdateScheduleConfig } from './update-schedule.js'

// Semantics reference: DSH apps/desktop/src/update-schedule.ts — completion-based
// deadline, ×2 failure backoff capped at maxBackoffMs, ±jitter uniform, coalescing.

function cfg(intervalMs: number, maxBackoffMs = 100_000, jitter = 0.2): UpdateScheduleConfig {
  return { intervalMs, maxBackoffMs, jitter }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('resolveUpdateScheduleConfig', () => {
  it('returns null for interval 0 (periodic checking disabled)', () => {
    expect(resolveUpdateScheduleConfig(0)).toBeNull()
  })

  it('clamps a nonzero interval below 60s up to 60s', () => {
    expect(resolveUpdateScheduleConfig(30_000)).toEqual({ intervalMs: 60_000, maxBackoffMs: 3_600_000, jitter: 0.2 })
  })

  it('derives maxBackoffMs as 4x the interval (floor 1h) with 0.2 jitter', () => {
    expect(resolveUpdateScheduleConfig(43_200_000)).toEqual({ intervalMs: 43_200_000, maxBackoffMs: 172_800_000, jitter: 0.2 })
    expect(resolveUpdateScheduleConfig(60_000)).toEqual({ intervalMs: 60_000, maxBackoffMs: 3_600_000, jitter: 0.2 })
  })
})

describe('UpdateSchedule', () => {
  let clock: number
  const now = () => clock
  const advance = async (ms: number) => { clock += ms; await vi.advanceTimersByTimeAsync(ms) }

  beforeEach(() => {
    vi.useFakeTimers()
    clock = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms the next deadline when the check SETTLES, not when it starts', async () => {
    const d = deferred<string>()
    const check = vi.fn(() => d.promise)
    const s = new UpdateSchedule({ check, failed: () => false, current: () => 'current' }, cfg(10_000), () => 0.5, now)

    const p = s.check()
    expect(check).toHaveBeenCalledTimes(1)
    await advance(400)
    expect(check).toHaveBeenCalledTimes(1) // still in flight — no deadline yet
    d.resolve('ok')
    await p // completion at clock=400 arms deadline 400 + 10_000

    await advance(9999)
    expect(check).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(check).toHaveBeenCalledTimes(2)
    s.dispose()
  })

  it('doubles the delay on consecutive failures and resets on success', async () => {
    let result = 'err'
    const check = vi.fn(async () => result)
    // maxBackoff far above the doubling sequence so the cap never binds here
    // (the cap has its own test); random 0.5 → wait = base exactly.
    const s = new UpdateSchedule({ check, failed: (r) => r === 'err', current: () => 'current' }, cfg(10_000, 1_000_000), () => 0.5, now)

    await s.check() // failure 1 → delay 20_000
    await advance(19_999)
    expect(check).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(check).toHaveBeenCalledTimes(2) // failure 2 → delay 40_000
    await advance(39_999)
    expect(check).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(check).toHaveBeenCalledTimes(3) // failure 3 → delay 80_000
    await advance(79_999)
    expect(check).toHaveBeenCalledTimes(3)
    await advance(1)
    expect(check).toHaveBeenCalledTimes(4) // failure 4 → delay 160_000

    result = 'ok'
    await advance(159_999)
    expect(check).toHaveBeenCalledTimes(4)
    await advance(1)
    expect(check).toHaveBeenCalledTimes(5) // success → delay reset to 10_000
    await advance(9999)
    expect(check).toHaveBeenCalledTimes(5)
    await advance(1)
    expect(check).toHaveBeenCalledTimes(6)
    s.dispose()
  })

  it('caps the randomized delay at maxBackoffMs', async () => {
    const check = vi.fn(async () => 'err')
    // random () => 1 → delay = min(maxBackoffMs, base * 1.2); base doubles 10k→20k→40k(cap)
    const s = new UpdateSchedule({ check, failed: () => true, current: () => 'current' }, cfg(10_000, 40_000), () => 1, now)

    await s.check() // base 20_000 → wait min(40_000, 24_000) = 24_000
    await advance(23_999)
    expect(check).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(check).toHaveBeenCalledTimes(2) // base 40_000 → wait min(40_000, 48_000) = 40_000
    await advance(39_999)
    expect(check).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(check).toHaveBeenCalledTimes(3) // base capped 40_000 → wait 40_000 again
    await advance(40_000)
    expect(check).toHaveBeenCalledTimes(4)
    s.dispose()
  })

  it('applies the jitter lower bound with a 1000ms floor', async () => {
    const check = vi.fn(async () => 'ok')
    const s = new UpdateSchedule({ check, failed: () => false, current: () => 'current' }, cfg(10_000), () => 0, now)
    await s.check() // random 0 → wait max(1000, 10_000 * 0.8) = 8000
    await advance(7999)
    expect(check).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(check).toHaveBeenCalledTimes(2)
    s.dispose()

    const check2 = vi.fn(async () => 'ok')
    const s2 = new UpdateSchedule({ check: check2, failed: () => false, current: () => 'current' }, cfg(1000), () => 0, now)
    await s2.check() // delay 1000 * 0.8 = 800 → floor 1000
    await advance(999)
    expect(check2).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(check2).toHaveBeenCalledTimes(2)
    s2.dispose()
  })

  it('coalesces concurrent checks into one probe', async () => {
    const d = deferred<string>()
    const check = vi.fn(() => d.promise)
    const s = new UpdateSchedule({ check, failed: () => false, current: () => 'current' }, cfg(10_000), () => 0.5, now)
    const p1 = s.check()
    const p2 = s.check()
    expect(check).toHaveBeenCalledTimes(1)
    d.resolve('ok')
    expect(await p1).toBe('ok')
    expect(await p2).toBe('ok')
    s.dispose()
  })

  it('returns current() without probing when not due, and manual bypasses the deadline', async () => {
    const check = vi.fn(async () => 'ok')
    const current = vi.fn(() => 'current')
    const s = new UpdateSchedule({ check, failed: () => false, current }, cfg(10_000), () => 0.5, now)
    await s.check() // arms deadline +10_000
    expect(await s.check()).toBe('current') // not due, non-manual
    expect(check).toHaveBeenCalledTimes(1)
    expect(current).toHaveBeenCalledTimes(1)
    await s.check(true) // manual bypasses
    expect(check).toHaveBeenCalledTimes(2)
    expect(check).toHaveBeenLastCalledWith(true)
    s.dispose()
  })

  it('arm() schedules one future check without probing now', async () => {
    const check = vi.fn(async () => 'ok')
    const s = new UpdateSchedule({ check, failed: () => false, current: () => 'current' }, cfg(10_000), () => 0.5, now)
    s.arm()
    expect(check).not.toHaveBeenCalled()
    await advance(9999)
    expect(check).not.toHaveBeenCalled()
    await advance(1)
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenLastCalledWith(false) // timer-driven checks are not manual
    s.dispose()
  })

  it('dispose() cancels the pending deadline and rejects new work', async () => {
    const check = vi.fn(async () => 'ok')
    const s = new UpdateSchedule({ check, failed: () => false, current: () => 'current' }, cfg(10_000), () => 0.5, now)
    s.arm()
    s.dispose()
    await advance(20_000)
    expect(check).not.toHaveBeenCalled()
    await expect(s.check()).rejects.toThrow('disposed')
  })
})