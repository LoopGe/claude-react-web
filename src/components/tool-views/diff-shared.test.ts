import { describe, it, expect } from 'vitest'
import { countDiffDelta } from './diff-shared'

describe('countDiffDelta', () => {
  it('counts pure additions', () => {
    expect(countDiffDelta('', 'a\nb')).toEqual({ add: 2, del: 0 })
  })

  it('counts pure deletions', () => {
    expect(countDiffDelta('a\nb', '')).toEqual({ add: 0, del: 2 })
  })

  it('counts a replacement as del + add', () => {
    expect(countDiffDelta('old line', 'new line')).toEqual({ add: 1, del: 1 })
  })

  it('reports no change for identical text', () => {
    expect(countDiffDelta('same\nlines', 'same\nlines')).toEqual({ add: 0, del: 0 })
  })

  it('ignores unchanged context lines', () => {
    // Insert a line between two kept lines: +1, no deletes
    expect(countDiffDelta('a\nb', 'a\nx\nb')).toEqual({ add: 1, del: 0 })
  })
})
