import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  isStableVersion,
  isVersionNewer,
  parseSemver,
} from './update-info.js'

describe('parseSemver', () => {
  it('parses a plain major.minor.patch', () => {
    expect(parseSemver('0.5.8')).toEqual({ major: 0, minor: 5, patch: 8, prerelease: false })
  })

  it('detects a prerelease suffix', () => {
    expect(parseSemver('1.0.0-rc.1')?.prerelease).toBe(true)
    expect(parseSemver('1.0.0-beta')?.prerelease).toBe(true)
  })

  it('ignores build metadata but still parses', () => {
    expect(parseSemver('1.2.3+build.42')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: false,
    })
  })

  it('returns null for malformed input', () => {
    expect(parseSemver('not-a-version')).toBeNull()
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('')).toBeNull()
  })
})

describe('isStableVersion', () => {
  it('true for a plain release', () => {
    expect(isStableVersion('0.5.8')).toBe(true)
  })

  it('false for a prerelease', () => {
    expect(isStableVersion('1.0.0-rc.1')).toBe(false)
    expect(isStableVersion('1.0.0-beta.2')).toBe(false)
  })

  it('false for malformed input', () => {
    expect(isStableVersion('garbage')).toBe(false)
  })
})

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('0.5.8', '0.5.7')).toBeGreaterThan(0)
    expect(compareSemver('0.5.7', '0.5.8')).toBeLessThan(0)
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareSemver('0.5.8', '0.5.8')).toBe(0)
  })

  it('sorts a list into descending order when used with b-a', () => {
    const list = ['0.5.7', '0.5.9', '0.5.8', '0.6.0', '0.5.8-rc.1']
    const desc = [...list].sort((a, b) => compareSemver(b, a))
    expect(desc).toEqual(['0.6.0', '0.5.9', '0.5.8', '0.5.8-rc.1', '0.5.7'])
  })

  it('pushes unparseable inputs to the end without throwing', () => {
    expect(compareSemver('garbage', '1.0.0')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0', 'garbage')).toBeLessThan(0)
    expect(compareSemver('garbage', 'garbage')).toBe(0)
  })
})

describe('isVersionNewer (regression guard)', () => {
  it('still works for the upgrade path', () => {
    expect(isVersionNewer('0.5.8', '0.5.9')).toBe(true)
    expect(isVersionNewer('0.5.9', '0.5.8')).toBe(false)
  })

  it('never treats a prerelease as newer', () => {
    expect(isVersionNewer('0.5.8', '0.5.9-rc.1')).toBe(false)
  })
})
