import { describe, it, expect } from 'vitest'
import { composeOutgoing } from './outgoing-text'
import { expandPastedTextRefs } from './pastedText'

describe('composeOutgoing', () => {
  const expand = (text: string) => text.replace('[Pasted text #1]', 'THE BODY')

  it('returns the trimmed composer text as both text and full', () => {
    expect(composeOutgoing('  hello  ', expand)).toEqual({
      text: 'hello',
      full: 'hello',
    })
  })

  it('expands pasted-text references so no placeholder reaches the model', () => {
    const { text, full } = composeOutgoing('[Pasted text #1]', expand)
    expect(text).toBe('THE BODY')
    expect(full).toBe('THE BODY')
  })

  it('does not trim the pasted body itself', () => {
    // Trim happens before expansion, so the user's pasted text keeps its own
    // leading/trailing whitespace instead of being clipped at the edges.
    const texts = { 1: { id: 1, content: '  kept  ' } }
    const { text } = composeOutgoing('  [Pasted text #1]  ', (t) =>
      expandPastedTextRefs(t, texts),
    )
    expect(text).toBe('  kept  ')
  })

  it('passes /summarize through verbatim (legacy alias dropped)', () => {
    // The alias died with the app-side compact flow: /compact is the CLI's
    // native pass-through and /handoff is the app-side continuation flow —
    // neither claims /summarize. A stray /summarize reaching the model is
    // benign (the model just answers in-band); no rewrite keeps the composer
    // honest about what will actually be sent.
    const { text } = composeOutgoing('/summarize', expand)
    expect(text).toBe('/summarize')
  })

  it('passes /summarize with args through verbatim (no case-sensitive surprises)', () => {
    const { text } = composeOutgoing('/SUMMARIZE focus on the bug fix', expand)
    expect(text).toBe('/SUMMARIZE focus on the bug fix')
  })

  it('passes /summarize-x through verbatim', () => {
    const { text } = composeOutgoing('/summarize-x keep', expand)
    expect(text).toBe('/summarize-x keep')
  })

  it('passes /summarize through in the scheduled-send path too (same chokepoint)', () => {
    // The scheduled-send composition calls this same function — a deliberate
    // regression guard: whatever alias behavior exists must not live only in
    // Chat.send().
    const { full } = composeOutgoing(' /summarize  ', expand)
    expect(full).toBe('/summarize')
  })
})

describe('composeOutgoing quote opacity', () => {
  const expand = (text: string) => text.replace('[Pasted text #1]', 'THE BODY')

  it('leaves a quoted paste-ref literal (never expanded)', () => {
    // The anti-goal: a `[Pasted text #N]`-shaped string INSIDE a blockquote run
    // is quoted prose, not a live reference — splicing paste content into it
    // would resurrect an attachment the user only quoted.
    const input = '> [Pasted text #1]\n\nafter'
    expect(composeOutgoing(input, expand)).toEqual({ text: input, full: input })
  })

  it('expands a paste-ref outside the quote but not the quoted one', () => {
    const { text, full } = composeOutgoing('[Pasted text #1]\n\n> [Pasted text #1]', expand)
    expect(text).toBe('THE BODY\n\n> [Pasted text #1]')
    expect(full).toBe('THE BODY\n\n> [Pasted text #1]')
  })

  it('preserves a quote run’s leading indent through trim', () => {
    // Up to three leading spaces are part of the run (`^ {0,3}>`); a whole-string
    // trim would strip them and change the run's serialized text.
    const { text } = composeOutgoing('   > quoted', expand)
    expect(text).toBe('   > quoted')
  })

  it('preserves a quote run’s trailing interior whitespace through trim', () => {
    const { text } = composeOutgoing('> quoted   ', expand)
    expect(text).toBe('> quoted   ')
  })

  it('still trims outer whitespace beyond the quote run', () => {
    const { text } = composeOutgoing('\n\n> quoted\n\n', expand)
    expect(text).toBe('> quoted')
  })

  it('preserves interior whitespace of a multi-line quote run', () => {
    const input = '> a\n>   b\n\nafter'
    expect(composeOutgoing(input, expand)).toEqual({ text: input, full: input })
  })

  it('keeps a quoted file-handle string literal (no expansion path touches it)', () => {
    const input = '> [File "a.pdf" id=x size=3]\n\nafter'
    expect(composeOutgoing(input, expand)).toEqual({ text: input, full: input })
  })
})
