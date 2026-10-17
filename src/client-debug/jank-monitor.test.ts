// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  installJankMonitor,
  markJank,
  getJankSummary,
  getRecentJankEvents,
  resetJankMonitorForTests,
} from './jank-monitor'

beforeEach(() => {
  resetJankMonitorForTests()
})

describe('jank-monitor', () => {
  it('summary starts clean with no events', () => {
    installJankMonitor()
    const s = getJankSummary()
    expect(s.last60s).toEqual({ frameGaps: 0, longTasks: 0 })
    expect(s.total).toEqual({ frameGaps: 0, longTasks: 0, marks: 0 })
    expect(s.maxGapMs).toBe(0)
    expect(s.secondsSinceLast).toBeNull()
  })

  it('install is idempotent', () => {
    installJankMonitor()
    // A second install must not stack a second rAF loop / observer.
    expect(() => installJankMonitor()).not.toThrow()
    expect(getJankSummary().total).toEqual({ frameGaps: 0, longTasks: 0, marks: 0 })
  })

  it('summary reports counts and max gap', () => {
    installJankMonitor()
    markJank('repro start')
    const s = getJankSummary()
    expect(s.total.marks).toBe(1)
    // No synthetic frame gaps have been produced by the rAF loop in the test
    // environment — maxGap 0 until a real stall occurs.
    expect(s.maxGapMs).toBe(0)
  })

  it('getRecentJankEvents returns the mark with its label', () => {
    installJankMonitor()
    markJank('scroll-up began')
    const events = getRecentJankEvents()
    expect(events.marks).toHaveLength(1)
    expect(events.marks[0].label).toBe('scroll-up began')
    expect(events.gaps).toEqual([])
  })

  it('marks ring is capped (oldest evicted)', () => {
    installJankMonitor()
    for (let i = 0; i < 60; i++) markJank(`mark-${i}`)
    const events = getRecentJankEvents()
    expect(events.marks).toHaveLength(50)
    expect(events.marks[0].label).toBe('mark-10')
    expect(events.marks[49].label).toBe('mark-59')
  })

  it('reset clears everything and allows re-install', () => {
    installJankMonitor()
    markJank('x')
    resetJankMonitorForTests()
    expect(getJankSummary().total.marks).toBe(0)
    expect(() => installJankMonitor()).not.toThrow()
  })
})
