import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDedupGuard, shouldMountWorkingBubble, shouldOfferBackgroundAction } from './task-actions'
import { computeWaiting, countTaskActivity } from '../session-store/normalize'
import type { TaskRecordUi } from '../types'

function task(overrides: Partial<TaskRecordUi> = {}): TaskRecordUi {
  return { taskId: 't', description: 'work', status: 'running', updatedAt: 0, ...overrides }
}

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

describe('shouldMountWorkingBubble', () => {
  const base = {
    turnActive: false,
    terminated: false,
    taskCount: 0,
    hasTranscriptBackground: false,
    hasLiveSyncSubagent: false,
  }

  it('mounts for a live turn', () => {
    expect(shouldMountWorkingBubble({ ...base, turnActive: true })).toBe(true)
  })

  it('mounts outside a turn while a task record or a background subagent remains', () => {
    expect(shouldMountWorkingBubble({ ...base, taskCount: 2 })).toBe(true)
    expect(shouldMountWorkingBubble({ ...base, hasTranscriptBackground: true })).toBe(true)
    expect(shouldMountWorkingBubble({ ...base, hasLiveSyncSubagent: true })).toBe(true)
  })

  it('does not mount when idle with nothing running', () => {
    expect(shouldMountWorkingBubble(base)).toBe(false)
  })

  it('never mounts on a terminated session while the only reason is leftover work', () => {
    for (const live of ['taskCount', 'hasTranscriptBackground', 'hasLiveSyncSubagent'] as const) {
      const args = { ...base, terminated: true, [live]: live === 'taskCount' ? 5 : true }
      expect(shouldMountWorkingBubble(args)).toBe(false)
    }
  })

  it('honors turnActive ungated — the gate relies on Chat never pairing it with terminated', () => {
    // Documented reliance, not an accident: `turnActive` is deliberately not
    // wrapped in `!terminated` (same shape as shouldOfferBackgroundAction), and
    // that is only safe because Chat cannot produce turnActive on a dead
    // session — the server reports `working=false`, the `activePhase` term
    // carries its own `!terminated`, and pendingTurnSince's effect clears the
    // bridge the moment the session terminates. If this assertion ever starts
    // looking wrong, check that effect first.
    expect(shouldMountWorkingBubble({ ...base, terminated: true, turnActive: true })).toBe(true)
  })

  // The invariant the removed `waiting` disjunct rested on: `waiting` implies a
  // mount, so listing it in the gate was dead logic. The counts are derived from
  // the REAL rule (countTaskActivity) rather than assumed — the superset relation
  // itself is asserted where it is owned (session-store/normalize.test.ts), and
  // this test would fail if the implication stopped holding for any task set the
  // store can actually produce (e.g. only ambient housekeeping running: all > 0
  // but indicator === 0, so Waiting is false and the gate must not be asked to
  // explain it).
  it('is implied by computeWaiting for every task set the store can produce', () => {
    const sets: TaskRecordUi[][] = [
      [],
      [task({ status: 'running' })],
      [task({ status: 'running', ambient: true })],
      [task({ status: 'running', skipTranscript: true })],
      [task({ status: 'paused' })],
      [task({ status: 'completed' })],
      [task({ status: 'running', ambient: true }), task({ status: 'paused' })],
      [task({ status: 'killed', skipTranscript: true }), task({ status: 'running' })],
    ]
    for (const set of sets) {
      const { all: taskCount, indicator: indicatorCount } = countTaskActivity(set)
      for (const turnActive of [false, true]) {
        for (const terminated of [false, true]) {
          for (const hasTranscriptBackground of [false, true]) {
            for (const hasLiveSyncSubagent of [false, true]) {
              const waiting = computeWaiting({ turnActive, terminated, runningCount: indicatorCount, hasTranscriptBackground })
              if (!waiting) continue
              expect(
                shouldMountWorkingBubble({ turnActive, terminated, taskCount, hasTranscriptBackground, hasLiveSyncSubagent }),
              ).toBe(true)
            }
          }
        }
      }
    }
  })

  it("mounts for the drawer's zeroed task leg exactly as its old hand-rolled gate did", () => {
    // SideChatDrawer keeps its own inputs (no optimistic bridge, no activePhase
    // leg, task leg zeroed) but must go through THIS predicate. Pinned against
    // the expression it replaced so that equivalence can't silently rot:
    //   old gate = working || (!working && !terminated && hasBackgroundSubagent)
    for (const working of [false, true]) {
      for (const terminated of [false, true]) {
        for (const hasBackgroundSubagent of [false, true]) {
          const oldGate = working || (!working && !terminated && hasBackgroundSubagent)
          expect(
            shouldMountWorkingBubble({
              turnActive: working,
              terminated,
              taskCount: 0,
              hasTranscriptBackground: hasBackgroundSubagent,
              hasLiveSyncSubagent: false,
            }),
          ).toBe(oldGate)
        }
      }
    }
  })
})
