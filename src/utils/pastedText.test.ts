import { describe, it, expect } from 'vitest'
import {
  PASTED_TEXT_COLLAPSE_LINES,
  expandPastedTextRefs,
  formatPastedTextRef,
  getPastedTextRefNumLines,
  joinTokens,
  normalizePastedText,
  parseReferences,
  planPaste,
  shouldCollapsePaste,
  tokenize,
  type PastedTextMap,
} from './pastedText'

/** Build the side map the composer holds while placeholders are in the text. */
function mapOf(...entries: Array<[number, string]>): PastedTextMap {
  return Object.fromEntries(entries.map(([id, content]) => [id, { id, content }]))
}

describe('getPastedTextRefNumLines', () => {
  it('counts newlines, not lines', () => {
    // Deliberate: "line1\nline2\nline3" is three lines but reports +2, matching
    // the count the original implementation shipped with.
    expect(getPastedTextRefNumLines('line1\nline2\nline3')).toBe(2)
  })

  it('returns 0 for a single line with no newline', () => {
    expect(getPastedTextRefNumLines('one line')).toBe(0)
  })

  it('returns 0 for the empty string', () => {
    expect(getPastedTextRefNumLines('')).toBe(0)
  })

  it('treats CRLF and bare CR as one newline each', () => {
    expect(getPastedTextRefNumLines('a\r\nb\rc')).toBe(2)
  })
})

describe('formatPastedTextRef', () => {
  it('omits the line count when there are no newlines', () => {
    expect(formatPastedTextRef(1, 0)).toBe('[Pasted text #1]')
  })

  it('renders the line count for multi-line pastes', () => {
    expect(formatPastedTextRef(1, 1178)).toBe('[Pasted text #1 +1178 lines]')
  })
})

describe('parseReferences', () => {
  it('finds a pasted-text ref with its id and offset', () => {
    expect(parseReferences('hello [Pasted text #3 +10 lines] world')).toEqual([
      { id: 3, match: '[Pasted text #3 +10 lines]', index: 6 },
    ])
  })

  it('finds a pasted-text ref that carries no line count', () => {
    const refs = parseReferences('[Pasted text #2]')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.id).toBe(2)
  })

  it('returns every ref in document order', () => {
    const refs = parseReferences('[Pasted text #1 +2 lines] and [Pasted text #2]')
    expect(refs.map((r) => r.id)).toEqual([1, 2])
  })

  // Only `[Pasted text #N]` is ever emitted by this app. Matching the sibling
  // ref kinds Claude Code supports ([Image #N], [...Truncated text...]) would
  // let a user-typed `[Image #1]` collide with pasted text #1 and get spliced
  // with the wrong content.
  it('ignores inline image refs', () => {
    expect(parseReferences('look [Image #4] here')).toEqual([])
  })

  it('ignores truncated-text refs', () => {
    expect(parseReferences('a [...Truncated text #5 +50 lines...] b')).toEqual([])
  })

  it('ignores text that is not a reference', () => {
    expect(parseReferences('just a [note] about #3 lines')).toEqual([])
  })

  it('ignores id 0, which is never allocated', () => {
    expect(parseReferences('[Pasted text #0]')).toEqual([])
  })
})

describe('expandPastedTextRefs', () => {
  it('replaces a pasted-text ref with its stored content', () => {
    const texts = mapOf([1, 'the real content'])
    expect(expandPastedTextRefs('before [Pasted text #1] after', texts)).toBe(
      'before the real content after',
    )
  })

  it('replaces every ref when several are present', () => {
    const texts = mapOf([1, 'AAA'], [2, 'BBB'])
    expect(
      expandPastedTextRefs('[Pasted text #1] mid [Pasted text #2 +5 lines]', texts),
    ).toBe('AAA mid BBB')
  })

  it('does not splice content into a same-numbered inline image ref', () => {
    // `[Image #1]` is not a ref this app emits, but a user can type one. It
    // must not be filled with pasted text #1's content just because the ids
    // happen to line up.
    const texts = mapOf([1, 'pasted body'])
    expect(expandPastedTextRefs('see [Image #1]', texts)).toBe('see [Image #1]')
  })

  it('leaves a ref alone when its content is missing', () => {
    expect(expandPastedTextRefs('x [Pasted text #9] y', {})).toBe('x [Pasted text #9] y')
  })

  it('does not expand a placeholder-looking string that came from pasted content', () => {
    // The injected content itself contains something that looks like a ref.
    // Splicing at offsets computed from the ORIGINAL input means it must
    // survive verbatim rather than being expanded a second time.
    const texts = mapOf(
      [1, 'see [Pasted text #2 +3 lines] inside'],
      [2, 'SHOULD NOT APPEAR'],
    )
    expect(expandPastedTextRefs('x [Pasted text #1] y', texts)).toBe(
      'x see [Pasted text #2 +3 lines] inside y',
    )
  })

  it('returns the input untouched when there are no refs', () => {
    expect(expandPastedTextRefs('plain text', mapOf([1, 'x']))).toBe('plain text')
  })
})

describe('normalizePastedText', () => {
  it('folds CRLF and bare CR down to LF', () => {
    expect(normalizePastedText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('expands tabs to four spaces', () => {
    expect(normalizePastedText('a\tb')).toBe('a    b')
  })

  it('leaves already-normal text alone', () => {
    expect(normalizePastedText('a\nb')).toBe('a\nb')
  })

  it('reports the same line count before and after folding', () => {
    // The label is derived from the stored text, so folding must not change
    // the number the user sees.
    const raw = 'a\r\nb\r\nc'
    expect(getPastedTextRefNumLines(normalizePastedText(raw))).toBe(
      getPastedTextRefNumLines(raw),
    )
  })
})

describe('planPaste', () => {
  it('leaves a small paste uncollapsed and hands back the raw text', () => {
    expect(planPaste('one\ntwo')).toEqual({
      collapsed: false,
      normalized: 'one\ntwo',
      numLines: 1,
    })
  })

  it('marks a large paste as collapsing and counts its lines', () => {
    const big = 'x\n'.repeat(30)
    expect(planPaste(big)).toEqual({ collapsed: true, normalized: big, numLines: 30 })
  })

  it('normalizes for the caller even when it does not collapse', () => {
    // The caller stores/inserts `normalized`, so the `+N lines` label and the
    // stored body are always derived from the same string.
    expect(planPaste('a\r\nb')).toEqual({ collapsed: false, normalized: 'a\nb', numLines: 1 })
  })
})

describe('tokenize', () => {
  it('splits literal text from references', () => {
    expect(tokenize('hi [Pasted text #1 +2 lines] there')).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'ref', id: 1, label: '[Pasted text #1 +2 lines]' },
      { kind: 'text', text: ' there' },
    ])
  })

  it('yields one text token when there is no reference', () => {
    expect(tokenize('plain')).toEqual([{ kind: 'text', text: 'plain' }])
  })

  it('yields nothing for empty text', () => {
    expect(tokenize('')).toEqual([])
  })

  it('handles references at either end with no surrounding text', () => {
    expect(tokenize('[Pasted text #2]')).toEqual([
      { kind: 'ref', id: 2, label: '[Pasted text #2]' },
    ])
    expect(tokenize('[Pasted text #2]tail')).toEqual([
      { kind: 'ref', id: 2, label: '[Pasted text #2]' },
      { kind: 'text', text: 'tail' },
    ])
  })

  it('handles adjacent references with no text between them', () => {
    expect(tokenize('[Pasted text #1][Pasted text #2]')).toEqual([
      { kind: 'ref', id: 1, label: '[Pasted text #1]' },
      { kind: 'ref', id: 2, label: '[Pasted text #2]' },
    ])
  })

  it('treats an id-0 pseudo-reference as plain text, matching parseReferences', () => {
    expect(tokenize('[Pasted text #0]')).toEqual([
      { kind: 'text', text: '[Pasted text #0]' },
    ])
  })
})

describe('joinTokens', () => {
  // The editor round-trips through the DOM, so this has to hold exactly —
  // anything lossy here silently corrupts the composer contents.
  it('round-trips every shape of text', () => {
    const samples = [
      '',
      'plain',
      '[Pasted text #1]',
      'hi [Pasted text #1 +2 lines] there',
      'a[Pasted text #1]b',
      '[Pasted text #1][Pasted text #2]',
      'multi\nline [Pasted text #3 +9 lines]\ntail',
      '[Pasted text #0]',
    ]
    for (const text of samples) {
      expect(joinTokens(tokenize(text))).toBe(text)
    }
  })
})

describe('tokenize mentions', () => {
  it('splits a leading mention from the text that follows it', () => {
    expect(tokenize('@src/a.ts hi')).toEqual([
      { kind: 'mention', text: '@src/a.ts', path: 'src/a.ts', dir: false },
      { kind: 'text', text: ' hi' },
    ])
  })

  it('parses a quoted path with spaces and a directory marker', () => {
    expect(tokenize('see @"my dir/" now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'mention', text: '@"my dir/"', path: 'my dir', dir: true },
      { kind: 'text', text: ' now' },
    ])
  })

  it('keeps the raw matched text (identity) while normalizing path/dir', () => {
    // A hand-typed backslash path serializes verbatim (joinTokens identity);
    // only `path` is normalized. Canonicalization of the TEXT happens at pick
    // time via formatFileMention, not here.
    expect(tokenize('@src\\a.ts')).toEqual([
      { kind: 'mention', text: '@src\\a.ts', path: 'src/a.ts', dir: false },
    ])
  })

  it('does not match an @ without a preceding whitespace boundary', () => {
    expect(tokenize('email@x')).toEqual([{ kind: 'text', text: 'email@x' }])
  })

  it('does not match a bare @ with nothing after it', () => {
    expect(tokenize('@')).toEqual([{ kind: 'text', text: '@' }])
    expect(tokenize('hi @')).toEqual([{ kind: 'text', text: 'hi @' }])
  })

  it('chipifies prose mentions too (DSH parity, no path-shape constraint)', () => {
    expect(tokenize('@bob')).toEqual([
      { kind: 'mention', text: '@bob', path: 'bob', dir: false },
    ])
  })

  it('interleaves mentions and paste-refs in document order', () => {
    expect(tokenize('@bob [Pasted text #1] @src/a.ts')).toEqual([
      { kind: 'mention', text: '@bob', path: 'bob', dir: false },
      { kind: 'text', text: ' ' },
      { kind: 'ref', id: 1, label: '[Pasted text #1]' },
      { kind: 'text', text: ' ' },
      { kind: 'mention', text: '@src/a.ts', path: 'src/a.ts', dir: false },
    ])
  })

  it('lets the earlier-starting token win an overlap (no double-count)', () => {
    // `@a[Pasted` is one unquoted mention run; the ref starting inside it is
    // swallowed, and the remainder stays literal text. Identity still holds.
    const text = '@a[Pasted text #1]'
    expect(joinTokens(tokenize(text))).toBe(text)
  })
})

describe('joinTokens mentions', () => {
  it('round-trips mixed mention + paste-ref text exactly', () => {
    const samples = [
      '@src/a.ts hi',
      '@bob [Pasted text #1] @src/a.ts',
      'see @"my dir/" now',
      '@src\\a.ts',
      'email@x',
      '@a[Pasted text #1]',
      '[Pasted text #1] @dir/ tail',
      '@"a b" @"c d"',
    ]
    for (const text of samples) {
      expect(joinTokens(tokenize(text))).toBe(text)
    }
  })
})

describe('tokenize quotes', () => {
  it('recognizes a line-leading blockquote run as ONE quote token', () => {
    expect(tokenize('> hello')).toEqual([{ kind: 'quote', text: '> hello' }])
  })

  it('keeps a multi-line run as one token carrying the exact span', () => {
    expect(tokenize('> a\n> b\n> c')).toEqual([{ kind: 'quote', text: '> a\n> b\n> c' }])
  })

  it('keeps nested >> markers verbatim (no normalization)', () => {
    expect(tokenize('> outer\n>> inner')).toEqual([
      { kind: 'quote', text: '> outer\n>> inner' },
    ])
  })

  it('keeps a run with no space after > verbatim', () => {
    expect(tokenize('>hello')).toEqual([{ kind: 'quote', text: '>hello' }])
  })

  it('keeps trailing whitespace verbatim (no trim)', () => {
    expect(tokenize('> hello   ')).toEqual([{ kind: 'quote', text: '> hello   ' }])
  })

  it('splits a run that follows prose, leaving the break in the text token', () => {
    expect(tokenize('prose\n> quote')).toEqual([
      { kind: 'text', text: 'prose\n' },
      { kind: 'quote', text: '> quote' },
    ])
  })

  it('splits a run that precedes prose, leaving the break in the text token', () => {
    expect(tokenize('> quote\nprose')).toEqual([
      { kind: 'quote', text: '> quote' },
      { kind: 'text', text: '\nprose' },
    ])
  })

  it('recognizes two runs separated by a blank line as two tokens', () => {
    expect(tokenize('> a\n\n> b')).toEqual([
      { kind: 'quote', text: '> a' },
      { kind: 'text', text: '\n\n' },
      { kind: 'quote', text: '> b' },
    ])
  })

  it('does NOT chipify an inline > mid-line', () => {
    expect(tokenize('prose > inline')).toEqual([{ kind: 'text', text: 'prose > inline' }])
  })

  it('recognizes an indented run (up to three leading spaces)', () => {
    expect(tokenize('  > hi')).toEqual([{ kind: 'quote', text: '  > hi' }])
  })

  it('swallows a mention inside the run (the quote is atomic)', () => {
    expect(tokenize('> see @src/a.ts')).toEqual([
      { kind: 'quote', text: '> see @src/a.ts' },
    ])
  })

  it('leaves a blank decoded run as ordinary text', () => {
    expect(tokenize('> ')).toEqual([{ kind: 'text', text: '> ' }])
  })

  it('keeps CRLF inside a run verbatim (UTF-16 span, not normalized)', () => {
    expect(tokenize('> a\r\n> b')).toEqual([{ kind: 'quote', text: '> a\r\n> b' }])
  })
})

describe('joinTokens quotes', () => {
  // The load-bearing invariant: the exact-run token + faithful join reproduce
  // the source for every shape, so the DOM editor never corrupts the composer.
  it('round-trips every pinned quote shape exactly', () => {
    const samples = [
      '> hello', // simple run
      '> a\n> b\n> c', // multi-line run
      '> outer\n>> inner', // nested >>
      '>hello', // missing space after >
      '> hello   ', // trailing whitespace
      'prose\n> quote', // run after prose
      '> quote\nprose', // run before prose
      '> a\n\n> b', // two adjacent runs
      'prose > inline', // inline > (not a token)
      '  > hi', // indented run
      '> a\r\n> b', // CRLF run
      'prose\r> q', // lone-CR line boundary
      'prose' + String.fromCharCode(0x2028) + '> q', // unicode line boundary
      '> see @src/a.ts', // mention swallowed by the run
      '> [Pasted text #1]', // ref-shaped text stays literal inside the run
      '@bob\n> q\n\ntail', // mention + quote + prose interleave
    ]
    for (const text of samples) {
      expect(joinTokens(tokenize(text))).toBe(text)
    }
  })

  // The line-leading / blank-line guarantees apply when COMPOSING new tokens
  // (a quote spliced next to prose that carries no break of its own). On
  // tokenize output the surrounding text already carries the breaks, so the
  // guards never fire and the round-trip above stays exact.
  it('inserts a leading newline when a composed quote would start mid-line', () => {
    expect(
      joinTokens([
        { kind: 'text', text: 'prose' },
        { kind: 'quote', text: '> q' },
      ]),
    ).toBe('prose\n> q')
  })

  it('inserts a blank line between a composed quote and following prose', () => {
    expect(
      joinTokens([
        { kind: 'quote', text: '> q' },
        { kind: 'text', text: 'prose' },
      ]),
    ).toBe('> q\n\nprose')
  })

  it('applies both guarantees around a mid-line composed quote', () => {
    expect(
      joinTokens([
        { kind: 'text', text: 'prose' },
        { kind: 'quote', text: '> q' },
        { kind: 'text', text: 'more' },
      ]),
    ).toBe('prose\n> q\n\nmore')
  })

  it('adds no leading newline when the preceding text already ends in a break', () => {
    expect(
      joinTokens([
        { kind: 'text', text: 'prose\n' },
        { kind: 'quote', text: '> q' },
      ]),
    ).toBe('prose\n> q')
  })

  it('adds no separator when the following prose already starts with a break', () => {
    expect(
      joinTokens([
        { kind: 'quote', text: '> q' },
        { kind: 'text', text: '\nprose' },
      ]),
    ).toBe('> q\nprose')
  })

  it('adds no leading newline for a quote at the very start', () => {
    expect(joinTokens([{ kind: 'quote', text: '> q' }])).toBe('> q')
  })
})

describe('shouldCollapsePaste', () => {
  it('collapses a paste that reaches the line threshold', () => {
    // The threshold is expressed in newlines — the same number the
    // `+N lines` label shows — so 15 newlines is 15 in the label.
    expect(shouldCollapsePaste('x\n'.repeat(PASTED_TEXT_COLLAPSE_LINES))).toBe(true)
  })

  it('leaves a paste one line under the threshold inline', () => {
    expect(shouldCollapsePaste('x\n'.repeat(PASTED_TEXT_COLLAPSE_LINES - 1))).toBe(false)
  })

  it('leaves a few short lines inline', () => {
    expect(shouldCollapsePaste('one\ntwo\nthree')).toBe(false)
  })

  it('collapses a single enormous line on character count alone', () => {
    // One line never trips the newline threshold, but a multi-hundred-KB
    // string in a controlled textarea is the case the cap exists for.
    expect(shouldCollapsePaste('x'.repeat(50_000))).toBe(true)
  })

  it('leaves a long-but-ordinary single line inline', () => {
    expect(shouldCollapsePaste('x'.repeat(1_000))).toBe(false)
  })
})
