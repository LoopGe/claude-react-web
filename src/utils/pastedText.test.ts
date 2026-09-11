import { describe, it, expect } from 'vitest'
import {
  PASTED_TEXT_COLLAPSE_LINES,
  expandPastedTextRefs,
  formatPastedTextRef,
  getPastedTextRefNumLines,
  normalizePastedText,
  parseReferences,
  planPaste,
  refKeyAction,
  refRanges,
  shouldCollapsePaste,
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

describe('refKeyAction', () => {
  const text = `hi ${'[Pasted text #1 +2 lines]'}`
  const START = 3
  const END = text.length

  it('deletes the whole reference on Backspace at its end', () => {
    expect(refKeyAction(text, END, 'Backspace')).toEqual({
      kind: 'delete',
      from: START,
      to: END,
    })
  })

  it('deletes the whole reference on Delete at its start', () => {
    expect(refKeyAction(text, START, 'Delete')).toEqual({
      kind: 'delete',
      from: START,
      to: END,
    })
  })

  it('steps the caret over the whole reference on ArrowLeft from its end', () => {
    expect(refKeyAction(text, END, 'ArrowLeft')).toEqual({ kind: 'move', caret: START })
  })

  it('steps the caret over the whole reference on ArrowRight from its start', () => {
    expect(refKeyAction(text, START, 'ArrowRight')).toEqual({ kind: 'move', caret: END })
  })

  it('returns null when the caret is not against a reference', () => {
    expect(refKeyAction('hello', 5, 'Backspace')).toBeNull()
    expect(refKeyAction(text, 1, 'Backspace')).toBeNull()
    expect(refKeyAction(text, 1, 'ArrowLeft')).toBeNull()
  })

  it('returns null for a key it does not own', () => {
    expect(refKeyAction(text, END, 'ArrowUp')).toBeNull()
  })

  it('returns null for a caret in the middle of a reference', () => {
    expect(refKeyAction(text, 10, 'Backspace')).toBeNull()
  })
})

describe('refRanges', () => {
  it('reports the half-open range of each reference', () => {
    expect(refRanges('ab [Pasted text #1 +2 lines] cd')).toEqual([
      { id: 1, start: 3, end: 3 + '[Pasted text #1 +2 lines]'.length },
    ])
  })

  it('reports nothing for text with no references', () => {
    expect(refRanges('plain text')).toEqual([])
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
