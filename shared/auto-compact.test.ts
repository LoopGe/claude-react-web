import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD_PCT,
  autoCompactWindowForPct,
  clampAutoCompactThresholdPct,
  windowForAutoCompactThreshold,
} from './auto-compact'

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

describe('clampAutoCompactThresholdPct', () => {
  it('defaults to 85 and clamps to the marker range 20–100', () => {
    expect(DEFAULT_AUTO_COMPACT_THRESHOLD_PCT).toBe(85)
    expect(clampAutoCompactThresholdPct(85)).toBe(85)
    expect(clampAutoCompactThresholdPct(10)).toBe(20)
    expect(clampAutoCompactThresholdPct(150)).toBe(100)
  })

  it('falls back to the default for missing / non-finite values', () => {
    expect(clampAutoCompactThresholdPct(undefined)).toBe(85)
    expect(clampAutoCompactThresholdPct(Number.NaN)).toBe(85)
  })
})

describe('autoCompactWindowForPct', () => {
  it('lands the CLI threshold at 85% of a 1M window', () => {
    // threshold want = 850000; window = 850000 + 20000 + 13000 = 883000
    expect(autoCompactWindowForPct(85, 1_000_000, 32_000)).toBe(883000)
    // CLI derives back: 883000 - 20000 - 13000 = 850000 = 85% of 1M.
    expect(883000 - 20000 - 13000).toBe(850_000)
  })

  it('returns 0 (leave auto) when the inverse would exceed the model window', () => {
    // 0.85 × 200k + 33k = 203000 > 200000 → not achievable; do NOT pin the
    // window itself (that would stick at 83.5% across a later 1M switch).
    expect(autoCompactWindowForPct(85, 200_000, 32_000)).toBe(0)
  })

  it('clampToWindow keeps the drag path committable on small windows', () => {
    expect(autoCompactWindowForPct(85, 200_000, 32_000, { clampToWindow: true })).toBe(200_000)
  })

  it('returns 0 for a non-positive context window', () => {
    expect(autoCompactWindowForPct(85, 0)).toBe(0)
  })
})
