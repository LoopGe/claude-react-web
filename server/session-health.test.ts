import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionHealthMonitor } from './session-health'

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionHealthMonitor', () => {
  it('runs the GC tick hook on every interval', () => {
    vi.useFakeTimers()
    const onGcTick = vi.fn()
    const monitor = new SessionHealthMonitor({
      sessions: new Map(),
      workingStuckMs: 0,
      unload: vi.fn(async () => {}),
      onGcTick,
    })
    try {
      expect(onGcTick).not.toHaveBeenCalled()
      vi.advanceTimersByTime(60_000)
      expect(onGcTick).toHaveBeenCalledTimes(1)
    } finally {
      monitor.stop()
    }
    vi.advanceTimersByTime(60_000)
    expect(onGcTick).toHaveBeenCalledTimes(1)
  })
})
