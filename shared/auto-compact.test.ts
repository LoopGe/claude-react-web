import { describe, expect, it } from 'vitest'
import { windowForAutoCompactThreshold } from './auto-compact'

// Mirrors the CLI's threshold formula (server: computeAutoCompactThreshold):
//   threshold = window - min(maxOutputTokens, 20000) - 13000
// windowForAutoCompactThreshold is its inverse. These tests pin the exact
// integer arithmetic so a regression in either direction is caught here.

describe('windowForAutoCompactThreshold', () => {
  it('inverts the CLI threshold formula (window = threshold + headroom)', () => {
    // maxOutputTokens 32000 ≥ 20000 floor → headroom = 20000 + 13000 = 33000
    expect(windowForAutoCompactThreshold(167000, 32000)).toBe(200000)
  })

  it('assumes the 20000 output floor when maxOutputTokens is absent', () => {
    expect(windowForAutoCompactThreshold(167000)).toBe(200000)
  })

  it('uses a sub-floor maxOutputTokens as-is (smaller headroom)', () => {
    // maxOutputTokens 8000 < 20000 → headroom = 8000 + 13000 = 21000
    expect(windowForAutoCompactThreshold(167000, 8000)).toBe(188000)
  })

  it('round-trips: threshold → window → same threshold', () => {
    // The window the client would POST for a 50% marker on a 200k model:
    // threshold = 100000, maxOutputTokens = 8000 → window = 100000 + 21000.
    const window = windowForAutoCompactThreshold(100000, 8000)
    expect(window).toBe(121000)
    // Server derives the threshold back: window - 8000 - 13000 = 100000.
    expect(window - 8000 - 13000).toBe(100000)
  })

  it('clamps a degenerate negative sum to zero', () => {
    expect(windowForAutoCompactThreshold(-40000, 32000)).toBe(0)
  })
})
