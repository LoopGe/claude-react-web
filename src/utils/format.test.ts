import { describe, it, expect } from 'vitest'
import { formatRelativeTime } from './format'

describe('formatRelativeTime', () => {
  // Pin "now" so tests are deterministic regardless of when they run.
  const now = Date.parse('2026-05-25T12:00:00.000Z')

  function iso(deltaMs: number): string {
    return new Date(now - deltaMs).toISOString()
  }

  it('returns "just now" for the entire first minute', () => {
    // The [45s, 60s) range used to bug out and return "0m ago"
    // because the threshold was 45s but `Math.floor(sec/60)` is 0
    // until exactly 60s. Lock the fix: the whole [0s, 60s) range is
    // "just now".
    expect(formatRelativeTime(iso(0), now)).toBe('just now')
    expect(formatRelativeTime(iso(20_000), now)).toBe('just now') // 20s
    expect(formatRelativeTime(iso(44_000), now)).toBe('just now') // 44s
    expect(formatRelativeTime(iso(45_000), now)).toBe('just now') // 45s — was buggy
    expect(formatRelativeTime(iso(50_000), now)).toBe('just now') // 50s — was buggy
    expect(formatRelativeTime(iso(59_000), now)).toBe('just now') // 59s — was buggy
    expect(formatRelativeTime(iso(59_999), now)).toBe('just now') // last instant under 60s
  })

  it('returns minutes for sub-hour ages', () => {
    expect(formatRelativeTime(iso(60_000), now)).toBe('1m ago') // exact 60s boundary
    expect(formatRelativeTime(iso(5 * 60_000), now)).toBe('5m ago')
    expect(formatRelativeTime(iso(59 * 60_000), now)).toBe('59m ago')
  })

  it('returns hours for sub-day ages', () => {
    expect(formatRelativeTime(iso(60 * 60_000), now)).toBe('1h ago')
    expect(formatRelativeTime(iso(3 * 60 * 60_000), now)).toBe('3h ago')
    expect(formatRelativeTime(iso(23 * 60 * 60_000), now)).toBe('23h ago')
  })

  it('returns "yesterday" for ~1 day', () => {
    expect(formatRelativeTime(iso(24 * 60 * 60_000), now)).toBe('yesterday')
  })

  it('returns days then weeks', () => {
    expect(formatRelativeTime(iso(2 * 24 * 60 * 60_000), now)).toBe('2d ago')
    expect(formatRelativeTime(iso(6 * 24 * 60 * 60_000), now)).toBe('6d ago')
    expect(formatRelativeTime(iso(7 * 24 * 60 * 60_000), now)).toBe('1w ago')
    expect(formatRelativeTime(iso(28 * 24 * 60 * 60_000), now)).toBe('4w ago')
  })

  it('falls back to a localized date for ages older than ~5 weeks', () => {
    // Past the relative-time horizon — we just need a non-empty string,
    // not the exact format which is locale-dependent.
    const result = formatRelativeTime(iso(60 * 24 * 60 * 60_000), now)
    expect(result).not.toBe('')
    expect(result).not.toMatch(/ago/)
  })

  it('treats future timestamps as "just now" rather than negative durations', () => {
    expect(formatRelativeTime(iso(-5_000), now)).toBe('just now')
  })

  it('returns empty string for falsy or invalid input', () => {
    expect(formatRelativeTime('', now)).toBe('')
    expect(formatRelativeTime(undefined, now)).toBe('')
    expect(formatRelativeTime(null, now)).toBe('')
    expect(formatRelativeTime('not a date', now)).toBe('')
  })
})
