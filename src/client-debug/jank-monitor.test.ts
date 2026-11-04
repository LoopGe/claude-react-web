// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
    expect(s.retained).toEqual({ frameGaps: 0, longTasks: 0, marks: 0 })
    expect(s.maxGapMs).toBe(0)
    expect(s.secondsSinceLast).toBeNull()
  })

  it('install is idempotent', () => {
    installJankMonitor()
    // A second install must not stack a second rAF loop / observer.
    expect(() => installJankMonitor()).not.toThrow()
    expect(getJankSummary().retained).toEqual({ frameGaps: 0, longTasks: 0, marks: 0 })
  })

  it('summary reports counts and max gap', () => {
    installJankMonitor()
    markJank('repro start')
    const s = getJankSummary()
    expect(s.retained.marks).toBe(1)
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

  it('keeps marks older than the 60s ring horizon', () => {
    // A reproduction can outlive the window; the start anchor is the mark the
    // workflow exists to correlate against, so marks are cap-trimmed only.
    const clock = vi.spyOn(performance, 'now')
    clock.mockReturnValueOnce(0).mockReturnValueOnce(120_000)
    markJank('repro start')
    markJank('repro end')
    clock.mockRestore()
    expect(getRecentJankEvents().marks.map((m) => m.label)).toEqual(['repro start', 'repro end'])
  })

  it('reset clears everything and allows re-install', () => {
    installJankMonitor()
    markJank('x')
    resetJankMonitorForTests()
    expect(getJankSummary().retained.marks).toBe(0)
    expect(() => installJankMonitor()).not.toThrow()
  })
})
