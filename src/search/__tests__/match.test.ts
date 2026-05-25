import { describe, it, expect } from 'vitest'
import { findRanges, countMatches } from '../match'

describe('findRanges', () => {
  it('returns empty for empty inputs', () => {
    expect(findRanges('', 'foo')).toEqual([])
    expect(findRanges('foo', '')).toEqual([])
    expect(findRanges('', '')).toEqual([])
  })

  it('finds non-overlapping matches in document order', () => {
    expect(findRanges('foo bar foo baz foo', 'foo')).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
      { start: 16, end: 19 },
    ])
  })

  it('is case-insensitive by default', () => {
    expect(findRanges('Hello WORLD', 'world')).toEqual([{ start: 6, end: 11 }])
    expect(findRanges('Hello WORLD', 'Hello')).toEqual([{ start: 0, end: 5 }])
  })

  it('respects the caseSensitive option', () => {
    expect(findRanges('Foo foo FOO', 'foo', { caseSensitive: true })).toEqual([
      { start: 4, end: 7 },
    ])
  })

  it('escapes regex metacharacters', () => {
    // None of these should be interpreted as regex syntax.
    expect(findRanges('a.b a.b', '.')).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ])
    expect(findRanges('a*b', 'a*b')).toEqual([{ start: 0, end: 3 }])
    expect(findRanges('hello (world)', '(world)')).toEqual([{ start: 6, end: 13 }])
    expect(findRanges('back\\slash', '\\')).toEqual([{ start: 4, end: 5 }])
  })

  it('handles overlapping potential matches by stepping past each one', () => {
    // "aa" inside "aaaa" — non-overlapping matches yield two hits, not three.
    expect(findRanges('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })
})

describe('countMatches', () => {
  it('mirrors findRanges length for the common path', () => {
    const text = 'Find the foo and FOO and FOO again'
    const ranges = findRanges(text, 'foo')
    expect(countMatches(text, 'foo')).toBe(ranges.length)
    expect(countMatches(text, 'foo')).toBe(3)
  })

  it('handles null/undefined text gracefully', () => {
    expect(countMatches(null, 'foo')).toBe(0)
    expect(countMatches(undefined, 'foo')).toBe(0)
    expect(countMatches('foo', '')).toBe(0)
  })
})
