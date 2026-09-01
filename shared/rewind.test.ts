import { describe, expect, it } from 'vitest'
import { coerceRewindResult } from './rewind.js'

describe('coerceRewindResult', () => {
  it('passes through a well-formed success result', () => {
    expect(coerceRewindResult({
      canRewind: true,
      filesChanged: ['a.ts', 'b.ts'],
      insertions: 12,
      deletions: 4,
    })).toEqual({
      canRewind: true,
      filesChanged: ['a.ts', 'b.ts'],
      insertions: 12,
      deletions: 4,
    })
  })

  it('keeps a canRewind:false result with its error message', () => {
    expect(coerceRewindResult({ canRewind: false, error: 'checkpoints disabled' }))
      .toEqual({ canRewind: false, error: 'checkpoints disabled' })
  })

  it('defaults canRewind to false when the field is absent or not true', () => {
    expect(coerceRewindResult({})).toEqual({ canRewind: false })
    expect(coerceRewindResult({ canRewind: 'yes' })).toEqual({ canRewind: false })
  })

  it('drops non-string / empty entries from filesChanged', () => {
    expect(coerceRewindResult({
      canRewind: true,
      filesChanged: ['a.ts', '', 42, null, 'b.ts'],
    })).toEqual({ canRewind: true, filesChanged: ['a.ts', 'b.ts'] })
  })

  it('omits filesChanged entirely when no valid entries remain', () => {
    expect(coerceRewindResult({ canRewind: true, filesChanged: ['', 7] }))
      .toEqual({ canRewind: true })
    expect(coerceRewindResult({ canRewind: true, filesChanged: 'a.ts' }))
      .toEqual({ canRewind: true })
  })

  it('keeps only finite numeric insertions/deletions', () => {
    expect(coerceRewindResult({ canRewind: true, insertions: 3, deletions: '5' }))
      .toEqual({ canRewind: true, insertions: 3 })
    expect(coerceRewindResult({ canRewind: true, insertions: NaN, deletions: Infinity }))
      .toEqual({ canRewind: true })
  })

  it('keeps only finite numeric skippedLinks (real-run link-safety refusals)', () => {
    expect(coerceRewindResult({ canRewind: true, skippedLinks: 2 }))
      .toEqual({ canRewind: true, skippedLinks: 2 })
    expect(coerceRewindResult({ canRewind: true, skippedLinks: 0 }))
      .toEqual({ canRewind: true, skippedLinks: 0 })
    // dryRun previews never set it; a NaN from an older CLI is dropped.
    expect(coerceRewindResult({ canRewind: true }))
      .toEqual({ canRewind: true })
    expect(coerceRewindResult({ canRewind: true, skippedLinks: NaN }))
      .toEqual({ canRewind: true })
  })

  it('collapses entirely malformed input to a safe error result', () => {
    const expected = { canRewind: false, error: 'malformed rewind response' }
    expect(coerceRewindResult(null)).toEqual(expected)
    expect(coerceRewindResult('ok')).toEqual(expected)
    expect(coerceRewindResult(undefined)).toEqual(expected)
  })

  it('drops unknown keys', () => {
    expect(coerceRewindResult({ canRewind: true, extra: 'junk', nested: { a: 1 } }))
      .toEqual({ canRewind: true })
  })
})
