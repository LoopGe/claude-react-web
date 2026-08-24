import { describe, it, expect } from 'vitest'
import { escapeAction, POST_INTERRUPT_SUPPRESS_MS } from './escape-action'

describe('escapeAction', () => {
  it('interrupts while the focused session is working', () => {
    expect(
      escapeAction({ working: true, now: 10_000, lastInterruptedAt: 0 }),
    ).toBe('interrupt')
  })

  it('interrupting wins even inside the post-interrupt suppression window', () => {
    // A second turn started (or never ended) right after an interrupt —
    // working is checked first, so the suppression window can never mask a
    // live interrupt.
    expect(
      escapeAction({ working: true, now: 10_100, lastInterruptedAt: 10_000 }),
    ).toBe('interrupt')
  })

  it('a single clean press while idle opens the resume picker', () => {
    expect(
      escapeAction({ working: false, now: 10_000, lastInterruptedAt: 0 }),
    ).toBe('resume')
  })

  it('suppresses the trailing press of a double-tap right after an interrupt', () => {
    // Interrupt fired at t=10_000; the impatient second press lands at
    // t=10_300 — inside the window, so nothing happens.
    expect(
      escapeAction({ working: false, now: 10_300, lastInterruptedAt: 10_000 }),
    ).toBe('none')
  })

  it('re-opens the resume picker after the suppression window elapses', () => {
    expect(
      escapeAction({ working: false, now: 10_000 + POST_INTERRUPT_SUPPRESS_MS, lastInterruptedAt: 10_000 }),
    ).toBe('resume')
  })

  it('treats a stale interrupt timestamp (0) as long past', () => {
    // Boot state: lastInterruptedAt is 0, `now` is any realistic epoch ms.
    expect(
      escapeAction({ working: false, now: 1_700_000_000_000, lastInterruptedAt: 0 }),
    ).toBe('resume')
  })
})
