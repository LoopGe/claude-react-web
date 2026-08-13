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

  it('does NOT auto-resume a transiently-terminated session (canRetryResume) either', () => {
    // Terminated sessions are NEVER auto-resumed. Recoverable (canRetryResume)
    // ones open to the composer's Resume / Fork-from-last-completed choice
    // banner instead — the user decides how to continue, never the app.
    expect(shouldAutoResumeOnSelect({ running: false, terminated: true, canRetryResume: true })).toBe(false)
  })

  it('keeps a transiently-terminated + slept session dormant on auto restore', () => {
    // Now false for the same "terminated never auto-resumes" reason — the
    // canRetryResume flag no longer grants an auto-resume on open.
    expect(
      shouldAutoResumeOnSelect(
        { running: false, terminated: true, canRetryResume: true, slept: true },
        { auto: true },
      ),
    ).toBe(false)
  })
})
