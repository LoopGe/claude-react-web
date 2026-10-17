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

  it('rewrites the /summarize legacy alias to /compact', () => {
    // The CLI has no /summarize builtin — without the rewrite the literal
    // text would reach the model as a plain prompt (see outgoing-text.ts).
    const { text } = composeOutgoing('/summarize', expand)
    expect(text).toBe('/compact')
  })

  it('rewrites the alias case-insensitively and keeps trailing args', () => {
    const { text } = composeOutgoing('/SUMMARIZE focus on the bug fix', expand)
    expect(text).toBe('/compact focus on the bug fix')
  })

  it('leaves /summarize-x (never an alias) passing through verbatim', () => {
    const { text } = composeOutgoing('/summarize-x keep', expand)
    expect(text).toBe('/summarize-x keep')
  })

  it('rewrites the alias in the scheduled-send path too (same chokepoint)', () => {
    // The scheduled-send composition calls this same function — a deliberate
    // regression guard: the rewrite must not exist only in Chat.send().
    const { full } = composeOutgoing(' /summarize  ', expand)
    expect(full).toBe('/compact')
  })
})