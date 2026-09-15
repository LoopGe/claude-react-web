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

  it('counts a <br> as one character, matching serializeTokens', () => {
    // serializeTokens reads <br> as '\n' (one character).  Range.toString()
    // returns '' for <br>, so a measurement built on Range.toString().length
    // would miss it.  This test pins the real divergence between DOM and
    // serialized value.
    const el = makeEditor()
    el.appendChild(document.createTextNode('line1'))
    el.appendChild(document.createElement('br'))
    const after = document.createTextNode('line2')
    el.appendChild(after)

    // Serialized value: "line1\nline2"  →  offset of "line2" start = 6
    // A naive Range.toString().length would give 5 (misses the \n).
    const off = offsetOf(el, after, 0)
    expect(off).toBe(6)
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
