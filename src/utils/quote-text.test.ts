import { describe, expect, it } from 'vitest'
import { formatQuoteText, messageQuoteRanges, offsetInQuoteLine, quoteTextOf } from './quote-text.js'

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

describe('offsetInQuoteLine', () => {
  it('catches the forming-quote gesture: caret after a lone blank marker', () => {
    // `> ` decodes to blank, so messageQuoteRanges excludes it — but a paste-ref
    // dropped here WOULD be swallowed once its label makes the run non-blank.
    expect(offsetInQuoteLine('> ', 2)).toBe(true)
    expect(offsetInQuoteLine('>', 1)).toBe(true)
  })

  it('is true with the caret inside or at the end of a non-blank quote line', () => {
    expect(offsetInQuoteLine('> hello', 4)).toBe(true)
    expect(offsetInQuoteLine('> hello', 7)).toBe(true)
  })

  it('is false with the caret at/before the marker (a ref there stays live)', () => {
    // Inserting in front of the `>` breaks the line-leading marker, so the ref
    // is not swallowed — the collapse policy may keep it.
    expect(offsetInQuoteLine('> hello', 0)).toBe(false)
    expect(offsetInQuoteLine('  > hi', 2)).toBe(false)
    expect(offsetInQuoteLine('  > hi', 3)).toBe(true)
  })

  it('is false on an unquoted line or an inline greater-than', () => {
    expect(offsetInQuoteLine('plain', 3)).toBe(false)
    expect(offsetInQuoteLine('a > b', 4)).toBe(false)
    expect(offsetInQuoteLine('', 0)).toBe(false)
  })

  it('rejects a four-space indent (not a quote marker)', () => {
    expect(offsetInQuoteLine('    > x', 5)).toBe(false)
  })

  it('reads the caret’s own line, not the whole run', () => {
    // Caret on the prose line after a run → not a quote line.
    expect(offsetInQuoteLine('> q\nafter', 5)).toBe(false)
    // Caret at the end of the quote line, before its break → still quoted.
    expect(offsetInQuoteLine('> q\nafter', 3)).toBe(true)
    // Second line of a multi-line run: past its own marker → true; at/before
    // that line's marker → false (a ref there splits the run, stays live).
    expect(offsetInQuoteLine('> a\n> b', 6)).toBe(true)
    expect(offsetInQuoteLine('> a\n> b', 4)).toBe(false)
  })

  it('treats CRLF and unicode separators as line boundaries (matches ^ with m)', () => {
    expect(offsetInQuoteLine('> a\r\n> b', 7)).toBe(true)
    const ls = String.fromCharCode(0x2028)
    const ps = String.fromCharCode(0x2029)
    expect(offsetInQuoteLine('> a' + ls + '> b', 6)).toBe(true)
    expect(offsetInQuoteLine('> a' + ps + '> b', 6)).toBe(true)
    // Caret on the blank line right after a run's trailing break → not quoted.
    expect(offsetInQuoteLine('> q\n', 4)).toBe(false)
  })
})
