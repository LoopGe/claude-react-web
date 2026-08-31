import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDedupGuard, shouldOfferBackgroundAction } from './task-actions'

describe('createDedupGuard', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('blocks a second acquire while a key is held', () => {
    const g = createDedupGuard(2000)
    expect(g.tryAcquire('a')).toBe(true)
    expect(g.tryAcquire('a')).toBe(false)
  })

  it('releases the key only after the hold window on releaseAfter', () => {
    vi.useFakeTimers()
    const g = createDedupGuard(2000)
    expect(g.tryAcquire('a')).toBe(true)
    g.releaseAfter('a')
    vi.advanceTimersByTime(1999)
    expect(g.tryAcquire('a')).toBe(false) // still held
    vi.advanceTimersByTime(1)
    expect(g.tryAcquire('a')).toBe(true) // released after the window
  })

  it('releases immediately on releaseNow (failure path → retry allowed)', () => {
    vi.useFakeTimers()
    const g = createDedupGuard(2000)
    expect(g.tryAcquire('a')).toBe(true)
    g.releaseNow('a')
    expect(g.tryAcquire('a')).toBe(true)
  })

  it('dispose makes the guard inert: holds cancelled, later operations no-op', () => {
    vi.useFakeTimers()
    const g = createDedupGuard(2000)
    expect(g.tryAcquire('a')).toBe(true)
    g.releaseAfter('a')
    g.dispose()
    // The pending hold's timer is cancelled — advancing time can't revive it.
    vi.advanceTimersByTime(5000)
    // A disposed guard never re-arms (e.g. a late in-flight POST resolving
    // after unmount must not schedule a fresh hold timer) and never accepts
    // new acquires. dispose is idempotent.
    expect(g.tryAcquire('a')).toBe(false)
    g.releaseAfter('a')
    vi.advanceTimersByTime(5000)
    expect(g.tryAcquire('a')).toBe(false)
    g.releaseNow('a')
    expect(g.tryAcquire('a')).toBe(false)
    expect(() => g.dispose()).not.toThrow()
  })

  it('reset() re-arms after dispose() — StrictMode simulated unmount must not kill the guard', () => {
    // React StrictMode (dev) runs an effect's cleanup right after its first
    // mount, then re-runs the effect. Chat disposes the dedup guard in that
    // cleanup; without a re-arm the guard stays inert and every "background"
    // click silently no-ops. reset() is called in the effect body to undo the
    // spurious dispose.
    const g = createDedupGuard(2000)
    expect(g.tryAcquire('a')).toBe(true)
    g.releaseNow('a')
    g.dispose()
    expect(g.tryAcquire('a')).toBe(false) // inert once disposed
    g.reset()
    expect(g.tryAcquire('a')).toBe(true) // re-armed for the real mount
  })
})

describe('shouldOfferBackgroundAction', () => {
  it('offers the action during a live turn', () => {
    expect(shouldOfferBackgroundAction({ turnActive: true, terminated: false, hasLiveSyncSubagent: false })).toBe(true)
  })

  it('offers the action during an auto-continuation turn with a live sync subagent (turnActive false)', () => {
    // The SDK's auto-continuation turn after a task-notification has
    // session.working=false and (with includePartialMessages off) no
    // activePhase — but a synchronous subagent is genuinely mid-flight.
    expect(shouldOfferBackgroundAction({ turnActive: false, terminated: false, hasLiveSyncSubagent: true })).toBe(true)
  })

  it('does NOT offer on a terminated session even with a live-looking subagent record', () => {
    expect(shouldOfferBackgroundAction({ turnActive: false, terminated: true, hasLiveSyncSubagent: true })).toBe(false)
  })

  it('does not offer when idle with nothing running', () => {
    expect(shouldOfferBackgroundAction({ turnActive: false, terminated: false, hasLiveSyncSubagent: false })).toBe(false)
  })
})
