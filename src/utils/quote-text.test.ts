import { describe, expect, it } from 'vitest'
import { formatQuoteText, messageQuoteRanges, quoteTextOf } from './quote-text.js'

describe('formatQuoteText', () => {
  it('prefixes every line of a multi-line selection', () => {
    expect(formatQuoteText('alpha\nbeta')).toBe('> alpha\n> beta')
  })

  it('normalizes CRLF before prefixing', () => {
    expect(formatQuoteText('alpha\r\nbeta')).toBe('> alpha\n> beta')
  })

  it('normalizes a lone CR as a line break', () => {
    expect(formatQuoteText('alpha\rbeta')).toBe('> alpha\n> beta')
  })

  it('keeps an empty line as a bare marker', () => {
    expect(formatQuoteText('a\n\nb')).toBe('> a\n> \n> b')
  })

  it('prefixes a single line', () => {
    expect(formatQuoteText('hello')).toBe('> hello')
  })

  it('formats empty input as one bare marker line', () => {
    expect(formatQuoteText('')).toBe('> ')
  })
})

describe('quoteTextOf', () => {
  it('strips one marker per line', () => {
    expect(quoteTextOf('> a\n> b')).toBe('a\nb')
  })

  it('keeps one marker of a nested quote', () => {
    expect(quoteTextOf('>> deep')).toBe('> deep')
  })

  it('normalizes CRLF', () => {
    expect(quoteTextOf('> a\r\n> b')).toBe('a\nb')
  })

  it('strips a marker indented by up to three spaces', () => {
    expect(quoteTextOf('   > a')).toBe('a')
  })

  it('leaves a four-space indent untouched', () => {
    expect(quoteTextOf('    > a')).toBe('    > a')
  })

  it('strips the marker without a following space', () => {
    expect(quoteTextOf('>a')).toBe('a')
  })

  it('strips a tab after the marker', () => {
    expect(quoteTextOf('>\ta')).toBe('a')
  })

  it('strips only one space after the marker', () => {
    expect(quoteTextOf('>  a')).toBe(' a')
  })

  it('decodes a bare marker to an empty line', () => {
    expect(quoteTextOf('>')).toBe('')
  })

  it('leaves unquoted text unchanged', () => {
    expect(quoteTextOf('plain text')).toBe('plain text')
  })
})

describe('messageQuoteRanges', () => {
  it('finds a line-leading run anywhere in the text', () => {
    const text = 'intro\n> q1\n> q2\noutro'
    const ranges = messageQuoteRanges(text)
    expect(ranges).toEqual([{ start: 6, end: 15 }])
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe('> q1\n> q2')
  })

  it('does not treat an inline greater-than as a run', () => {
    expect(messageQuoteRanges('prose> x')).toEqual([])
    expect(messageQuoteRanges('a > b')).toEqual([])
  })

  it('accepts up to three leading spaces', () => {
    expect(messageQuoteRanges('  > q')).toEqual([{ start: 0, end: 5 }])
  })

  it('rejects a four-space indent', () => {
    expect(messageQuoteRanges('    > q')).toEqual([])
  })

  it('excludes a run that decodes to blank', () => {
    expect(messageQuoteRanges('> \n> ')).toEqual([])
    expect(messageQuoteRanges('>')).toEqual([])
  })

  it('does not treat a horizontal rule as a quote', () => {
    expect(messageQuoteRanges('----')).toEqual([])
  })

  it('returns separate ranges for runs split by prose', () => {
    expect(messageQuoteRanges('> a\nprose\n> b')).toEqual([
      { start: 0, end: 3 },
      { start: 10, end: 13 },
    ])
  })

  it('splits runs at a blank line', () => {
    expect(messageQuoteRanges('> a\n\n> b')).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 8 },
    ])
  })

  it('excludes the trailing line break from a run', () => {
    expect(messageQuoteRanges('> q\nafter')).toEqual([{ start: 0, end: 3 }])
  })

  it('joins continuation lines with their own indent', () => {
    expect(messageQuoteRanges('> a\n  > b')).toEqual([{ start: 0, end: 9 }])
  })

  it('recognizes a nested quote as one run', () => {
    expect(messageQuoteRanges('>> a\n>> b')).toEqual([{ start: 0, end: 9 }])
  })

  it('recognizes markers without a following space', () => {
    expect(messageQuoteRanges('>a\n>b')).toEqual([{ start: 0, end: 5 }])
  })

  // Spans index the ORIGINAL text: CRLF pairs keep both code units.
  it('reports offsets in the original CRLF text', () => {
    const text = 'x\r\n> a\r\n> b'
    const ranges = messageQuoteRanges(text)
    expect(ranges).toEqual([{ start: 3, end: 11 }])
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe('> a\r\n> b')
  })

  // UTF-16 code units, not code points: an astral char advances the offset by 2.
  it('reports UTF-16 offsets after astral characters', () => {
    const text = '😀\n> q'
    const ranges = messageQuoteRanges(text)
    expect(ranges).toEqual([{ start: 3, end: 6 }])
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe('> q')
  })

  it('returns no ranges for empty text', () => {
    expect(messageQuoteRanges('')).toEqual([])
  })
})