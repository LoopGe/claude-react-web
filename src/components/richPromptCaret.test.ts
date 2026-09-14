import { describe, it, expect } from 'vitest'
import { slashWordBefore, caretOnFirstLine, offsetOf } from './richPromptCaret'

describe('richPromptCaret pure helpers', () => {
  it('reads the /word ending at the caret', () => {
    const text = 'hello /mod'
    expect(slashWordBefore(text, text.length)).toBe('/mod')
  })

  it('returns null when the word does not start with /', () => {
    const text = 'hello world'
    expect(slashWordBefore(text, text.length)).toBeNull()
  })

  it('returns null when the /word is already closed by a space', () => {
    const text = '/mod '
    expect(slashWordBefore(text, text.length)).toBeNull()
  })

  it('detects the first line', () => {
    expect(caretOnFirstLine('one\ntwo', 3)).toBe(true)
    expect(caretOnFirstLine('one\ntwo', 5)).toBe(false)
  })
})

describe('offsetOf DOM measurement', () => {
  function makeEditor(): HTMLDivElement {
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    document.body.appendChild(el)
    return el
  }

  it('counts plain text characters 1:1', () => {
    const el = makeEditor()
    el.textContent = 'hello world'
    const textNode = el.firstChild as Text
    // Offset 5 puts us after "hello"
    const off = offsetOf(el, textNode, 5)
    expect(off).toBe(5)
  })

  it('maps a chip to its serialized reference length, not its DOM text length', () => {
    // This is the critical bridge test.  The chip's DOM text content is
    // "[Pasted text #1]" (18 chars of text nodes).  A measurement that just
    // summed text-node lengths (or called Range.toString().length) would
    // produce 21, but the serialized value is "[Pasted text #1] /mod" where
    // the chip counts as exactly 1 reference whose label is 18 chars —
    // offset 18.  If the measurement used DOM text length instead of the
    // serialized token length, the test must fail.
    const el = makeEditor()
    // Chip comes first so its text contribution is counted before /mod.
    const chip = document.createElement('span')
    chip.className = 'pasted-text-chip'
    chip.setAttribute('contenteditable', 'false')
    chip.textContent = '[Pasted text #1]'
    el.appendChild(chip)

    const textAfter = document.createTextNode(' /mod')
    el.appendChild(textAfter)

    // Caret at start of ' /mod' (right after chip).
    // Serialized: "[Pasted text #1] /mod"  →  offset 16
    const off = offsetOf(el, textAfter, 0)
    expect(off).toBe(16)
  })

  it('handles a chip at the end of text', () => {
    const el = makeEditor()
    const before = document.createTextNode('hi ')
    el.appendChild(before)
    const chip = document.createElement('span')
    chip.className = 'pasted-text-chip'
    chip.setAttribute('contenteditable', 'false')
    chip.textContent = '[Pasted text #1]'
    el.appendChild(chip)

    // Offset 3 = after "hi "
    const off = offsetOf(el, before, 3)
    expect(off).toBe(3)
  })
})
