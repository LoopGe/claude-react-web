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
