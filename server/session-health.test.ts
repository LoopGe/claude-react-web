import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionHealthMonitor } from './session-health'
import type { Session } from './session-types.js'

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

  it('escalated force-unload passes terminated (not terminate)', () => {
    vi.useFakeTimers()
    const unload = vi.fn(async () => {})
    const s = { running: true, terminated: false, exiting: false, recovering: false,
      pendingTurns: 1, pending: new Map(), lastActivityAt: 0,
      history: [], subagentHistory: [], handle: {}, subscribers: new Map() } as unknown as Session
    const monitor = new SessionHealthMonitor({
      sessions: new Map([['s1', s]]), workingStuckMs: 1000, unload })
    try {
      vi.advanceTimersByTime(60_000)
      expect(unload).toHaveBeenCalledWith('s1', { terminated: true, reason: 'init_stuck' })
    } finally { monitor.stop() }
  })
})
