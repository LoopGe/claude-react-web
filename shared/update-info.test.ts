import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  isStableVersion,
  isUpdateAppliedToDisk,
  isUpdateNagNeeded,
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

describe('isUpdateNagNeeded', () => {
  // The client helper is a thin reader over the server-computed
  // `updateAppliedToDisk` field (the SSOT lives in update-checker.ts
  // withInstalledOverlay, exercised by server tests). These tests cover the
  // combination logic only.
  const info = (over: Partial<{ hasUpdate: boolean; latest: string; updateAppliedToDisk: boolean }> = {}) => ({
    hasUpdate: true,
    latest: '0.6.0',
    ...over,
  }) as import('./update-info.js').UpdateInfo

  it('nags when hasUpdate is true and the update is not yet on disk', () => {
    expect(isUpdateNagNeeded(info({ updateAppliedToDisk: false }))).toBe(true)
  })

  it('nags when updateAppliedToDisk is absent (field not overlaid → fall back to nagging)', () => {
    expect(isUpdateNagNeeded(info({ updateAppliedToDisk: undefined }))).toBe(true)
  })

  it('does NOT nag when the update is already applied to disk (restart pending)', () => {
    // The reported bug: hasUpdate stays true vs the stale running `current`,
    // but the on-disk version already satisfies latest. The server sets
    // updateAppliedToDisk=true, which suppresses the nag in every tab.
    expect(isUpdateNagNeeded(info({ updateAppliedToDisk: true }))).toBe(false)
  })

  it('never nags when hasUpdate is already false', () => {
    expect(isUpdateNagNeeded(info({ hasUpdate: false, updateAppliedToDisk: true }))).toBe(false)
  })

  it('never nags when latest is missing', () => {
    expect(isUpdateNagNeeded(info({ latest: undefined as unknown as string }))).toBe(false)
  })

  it('handles null/undefined info', () => {
    expect(isUpdateNagNeeded(null)).toBe(false)
    expect(isUpdateNagNeeded(undefined)).toBe(false)
  })
})

describe('isUpdateAppliedToDisk', () => {
  // Thin reader over the server field — the malformed/prerelease/behind
  // logic is covered by the server-side withInstalledOverlay tests.
  const info = (over: Partial<{ updateAppliedToDisk: boolean }> = {}) =>
    ({ updateAppliedToDisk: false, ...over }) as import('./update-info.js').UpdateInfo

  it('reads the field true', () => {
    expect(isUpdateAppliedToDisk(info({ updateAppliedToDisk: true }))).toBe(true)
  })

  it('reads the field false', () => {
    expect(isUpdateAppliedToDisk(info({ updateAppliedToDisk: false }))).toBe(false)
  })

  it('false when the field is absent (not overlaid)', () => {
    expect(isUpdateAppliedToDisk(info({ updateAppliedToDisk: undefined }))).toBe(false)
  })

  it('handles null/undefined info', () => {
    expect(isUpdateAppliedToDisk(null)).toBe(false)
    expect(isUpdateAppliedToDisk(undefined)).toBe(false)
  })
})
