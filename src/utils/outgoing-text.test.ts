import { describe, it, expect } from 'vitest'
import { attachmentsPreamble, composeOutgoing } from './outgoing-text'
import { expandPastedTextRefs } from './pastedText'
import type { Attachment } from '../hooks/useAttachments'

function att(path: string): Attachment {
  return { path, name: path, size: 0 }
}

describe('attachmentsPreamble', () => {
  it('is empty when nothing is attached', () => {
    expect(attachmentsPreamble([])).toBe('')
  })

  it('names a single attachment in the singular', () => {
    expect(attachmentsPreamble([att('/a/x.ts')])).toBe(
      'Attached file (absolute path — use the Read tool to open):\n- /a/x.ts\n\n',
    )
  })

  it('names several attachments in the plural', () => {
    expect(attachmentsPreamble([att('/a/x.ts'), att('/a/y.ts')])).toBe(
      'Attached files (absolute paths — use the Read tool to open):\n- /a/x.ts\n- /a/y.ts\n\n',
    )
  })
})

describe('composeOutgoing', () => {
  const expand = (text: string) => text.replace('[Pasted text #1]', 'THE BODY')

  it('returns the trimmed composer text as both text and full when nothing is attached', () => {
    expect(composeOutgoing('  hello  ', [], expand)).toEqual({
      text: 'hello',
      full: 'hello',
    })
  })

  it('prepends the preamble to full but leaves text bare', () => {
    const { text, full } = composeOutgoing('hello', [att('/a/x.ts')], expand)
    expect(text).toBe('hello')
    expect(full).toBe(
      'Attached file (absolute path — use the Read tool to open):\n- /a/x.ts\n\nhello',
    )
  })

  it('expands pasted-text references so no placeholder reaches the model', () => {
    const { text, full } = composeOutgoing('[Pasted text #1]', [], expand)
    expect(text).toBe('THE BODY')
    expect(full).toBe('THE BODY')
  })

  it('expands references inside the preamble-prefixed full text', () => {
    const { full } = composeOutgoing('[Pasted text #1]', [att('/a/x.ts')], expand)
    expect(full).not.toContain('[Pasted text #1]')
    expect(full.endsWith('THE BODY')).toBe(true)
  })

  it('does not trim the pasted body itself', () => {
    // Trim happens before expansion, so the user's pasted text keeps its own
    // leading/trailing whitespace instead of being clipped at the edges.
    const texts = { 1: { id: 1, content: '  kept  ' } }
    const { text } = composeOutgoing('  [Pasted text #1]  ', [], (t) =>
      expandPastedTextRefs(t, texts),
    )
    expect(text).toBe('  kept  ')
  })
})
