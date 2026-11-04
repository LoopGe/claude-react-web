import { describe, expect, it } from 'vitest'
import { isTurnChangesSummary } from './turn-changes.js'

const summary = {
  resultUuid: 'r1',
  assistantUuid: 'a1',
  total: 1,
  added: 2,
  deleted: 1,
  files: [{ path: 'src/a.ts', display: 'src/a.ts', status: 'modified' as const, additions: 2, deletions: 1 }],
}

describe('isTurnChangesSummary', () => {
  it('accepts a well-formed summary', () => {
    expect(isTurnChangesSummary(summary)).toBe(true)
  })

  it('accepts binary and oversized file flags', () => {
    expect(isTurnChangesSummary({
      ...summary,
      files: [{ path: 'a.bin', display: 'a.bin', status: 'modified', additions: 0, deletions: 0, binary: true, oversized: true }],
    })).toBe(true)
  })

  it('rejects a bad status', () => {
    expect(isTurnChangesSummary({ ...summary, files: [{ ...summary.files[0], status: 'changed' }] })).toBe(false)
  })

  it('rejects negative or non-integer counts', () => {
    expect(isTurnChangesSummary({ ...summary, added: -1 })).toBe(false)
    expect(isTurnChangesSummary({ ...summary, total: 1.5 })).toBe(false)
  })

  it('rejects empty ids and a non-array files field', () => {
    expect(isTurnChangesSummary({ ...summary, resultUuid: '' })).toBe(false)
    expect(isTurnChangesSummary({ ...summary, assistantUuid: '' })).toBe(false)
    expect(isTurnChangesSummary({ ...summary, files: 'nope' })).toBe(false)
  })

  it('rejects a file with an invalid binary flag', () => {
    expect(isTurnChangesSummary({ ...summary, files: [{ ...summary.files[0], binary: false }] })).toBe(false)
  })
})