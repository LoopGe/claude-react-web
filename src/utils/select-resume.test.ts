import { describe, it, expect } from 'vitest'
import { shouldAutoResumeOnSelect } from './select-resume'

describe('shouldAutoResumeOnSelect', () => {
  it('resumes a plain dormant session on an automatic restore (page refresh)', () => {
    // Passive dormancy (server restart / crash) auto-recovers on refresh.
    expect(shouldAutoResumeOnSelect({ running: false }, { auto: true })).toBe(true)
  })

  it('does NOT wake a deliberately-slept session on an automatic restore', () => {
    // Regression: URL-hash restore on refresh used to wake a slept grouped
    // member via handleSelect's grouped-branch resume. Auto opens must leave
    // it dormant so its panel shows the empty-state + Resume button.
    expect(shouldAutoResumeOnSelect({ running: false, slept: true }, { auto: true })).toBe(false)
  })

  it('wakes a deliberately-slept session on an explicit click', () => {
    expect(shouldAutoResumeOnSelect({ running: false, slept: true })).toBe(true)
    expect(shouldAutoResumeOnSelect({ running: false, slept: true }, { auto: false })).toBe(true)
  })

  it('does not resume a running session', () => {
    expect(shouldAutoResumeOnSelect({ running: true })).toBe(false)
    expect(shouldAutoResumeOnSelect({ running: true, slept: true }, { auto: true })).toBe(false)
  })

  it('does not resume a hard-terminated session', () => {
    expect(shouldAutoResumeOnSelect({ running: false, terminated: true, canRetryResume: false })).toBe(false)
  })

  it('retries a transiently-terminated session (canRetryResume)', () => {
    expect(shouldAutoResumeOnSelect({ running: false, terminated: true, canRetryResume: true })).toBe(true)
  })

  it('keeps a transiently-terminated + slept session dormant on auto restore', () => {
    expect(
      shouldAutoResumeOnSelect(
        { running: false, terminated: true, canRetryResume: true, slept: true },
        { auto: true },
      ),
    ).toBe(false)
  })
})
