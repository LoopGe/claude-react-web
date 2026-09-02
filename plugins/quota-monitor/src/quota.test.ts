import { describe, expect, it } from 'vitest'
import { isTransientError, nextResetAt, resolveDisplay, toneForUtilization } from './quota.js'
import type { QuotaSnapshot } from './quota.js'

function snap(overrides: Partial<QuotaSnapshot>): QuotaSnapshot {
  return {
    platformId: 'volcengine',
    platformLabel: 'Ark',
    planKind: 'agent',
    planType: 'medium',
    tiers: [],
    balance: null,
    credentialStatus: 'valid',
    error: null,
    queriedAt: 0,
    success: true,
    ...overrides,
  }
}

describe('isTransientError', () => {
  it('classifies network errors and 5xx/429 as transient', () => {
    expect(isTransientError('Network error: fetch failed')).toBe(true)
    expect(isTransientError('API error (HTTP 500): boom')).toBe(true)
    expect(isTransientError('API error (HTTP 429): limit')).toBe(true)
    expect(isTransientError('request failed')).toBe(true)
  })

  it('treats 4xx / auth / unknown errors as deterministic (fail-safe)', () => {
    expect(isTransientError('Authentication failed (HTTP 403)')).toBe(false)
    expect(isTransientError('API error (HTTP 400, InvalidAuthorization)')).toBe(false)
    expect(isTransientError('something unexpected')).toBe(false)
    expect(isTransientError('')).toBe(false)
  })
})

describe('resolveDisplay (keep-last-good)', () => {
  it('refreshes lastGood on success', () => {
    const good = snap({ queriedAt: 1000 })
    const { data, lastGood } = resolveDisplay(good, null, 1000)
    expect(data).toBe(good)
    expect(lastGood?.data).toBe(good)
  })

  it('keeps last good value for a transient failure within the window', () => {
    const good = snap({ queriedAt: 1000 })
    const now = 1000 + 60_000 // within 10 min
    const { data, lastGood } = resolveDisplay(
      snap({ success: false, credentialStatus: 'error', error: 'API error (HTTP 500)' }),
      { data: good, at: 1000 },
      now,
    )
    expect(data).toBe(good)
    expect(lastGood?.data).toBe(good) // not cleared on transient
  })

  it('clears lastGood on a deterministic failure so stale quota never resurrects', () => {
    const good = snap({ queriedAt: 1000 })
    const { data, lastGood } = resolveDisplay(
      snap({ success: false, credentialStatus: 'expired', error: 'Authentication failed (HTTP 403)' }),
      { data: good, at: 1000 },
      2000,
    )
    expect(data).not.toBe(good)
    expect(lastGood).toBeNull()
  })

  it('stops masking a transient failure after the window expires', () => {
    const good = snap({ queriedAt: 1000 })
    const now = 1000 + 11 * 60_000 // past 10 min
    const { data } = resolveDisplay(
      snap({ success: false, credentialStatus: 'error', error: 'API error (HTTP 500)' }),
      { data: good, at: 1000 },
      now,
    )
    expect(data).not.toBe(good)
  })
})

describe('toneForUtilization', () => {
  it('maps thresholds like cc-switch', () => {
    expect(toneForUtilization(95)).toBe('danger')
    expect(toneForUtilization(90)).toBe('danger')
    expect(toneForUtilization(75)).toBe('warn')
    expect(toneForUtilization(69)).toBe('ok')
    expect(toneForUtilization(0)).toBe('ok')
  })
})

describe('nextResetAt', () => {
  const now = 1_800_000_000_000
  it('returns the earliest future reset across tiers', () => {
    const tiers = [
      { resets_at: new Date(now + 3_600_000).toISOString() },   // +1h
      { resets_at: null },
      { resets_at: new Date(now + 600_000).toISOString() },     // +10min
      { resets_at: new Date(now + 86_400_000).toISOString() },  // +1d
    ]
    expect(nextResetAt(tiers, now)).toBe(now + 600_000)
  })

  it('ignores already-passed / unparseable resets', () => {
    const tiers = [
      { resets_at: new Date(now - 3_600_000).toISOString() },   // past
      { resets_at: 'garbage' },
      { resets_at: null },
    ]
    expect(nextResetAt(tiers, now)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(nextResetAt([], now)).toBeNull()
  })
})