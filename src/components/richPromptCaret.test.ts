import { describe, it, expect } from 'vitest'
import { slashWordBefore, caretOnFirstLine, offsetOf, placeCaretAtOffset } from './richPromptCaret'

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

describe('offsetOf and placeCaretAtOffset round-trip', () => {
  /** `x ` + a chip + ` y`, with the chip carrying a real reference id. */
  function makeChipEditor(): { el: HTMLDivElement; chip: HTMLElement } {
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    document.body.appendChild(el)
    el.appendChild(document.createTextNode('x '))
    const chip = document.createElement('span')
    chip.className = 'pasted-text-chip'
    chip.setAttribute('contenteditable', 'false')
    chip.setAttribute('data-pasted-ref', '1')
    chip.textContent = '[Pasted text #1]'
    el.appendChild(chip)
    el.appendChild(document.createTextNode(' y'))
    return { el, chip }
  }

  it('honours a stop point INSIDE a chip', () => {
    // A real double-click on a chip selects inside it — its inner text node is
    // the selection container. Ignoring the stop there made offsetOf sum the
    // whole value, so the context menu disabled Cut/Copy over a visible
    // selection and Paste spliced at the very end of the draft.
    const { el, chip } = makeChipEditor()
    const chipText = chip.firstChild as Text
    // 'x ' is 2 chars, so the chip starts at 2; +8 is inside its label.
    expect(offsetOf(el, chipText, 8)).toBe(10)
  })

  it('reports the offset AFTER a chip, not the end of the value', () => {
    const { el } = makeChipEditor()
    // The caret sits after the chip: container is the editor, offset is the
    // index just past the chip element.
    expect(offsetOf(el, el, 2)).toBe(18)
  })

  it('puts the caret AFTER a chip when the target is the chip segment end', () => {
    // The end of the chip's text means "after the chip". Placing it before
    // sends the next keystroke in front of the reference the user just
    // inserted. `setStartAfter` reports as (parent, indexPastTheChip), and
    // `setStartBefore` as (parent, indexOfTheChip) — the index is what
    // distinguishes them.
    const { el, chip } = makeChipEditor()
    expect(placeCaretAtOffset(el, 18)).toBe(true)
    const range = document.getSelection()!.getRangeAt(0)
    const chipIndex = Array.prototype.indexOf.call(el.childNodes, chip)
    expect(range.startContainer).toBe(el)
    expect(range.startOffset).toBe(chipIndex + 1)
  })

  it('round-trips the offsets that have a reachable DOM position', () => {
    // Offsets strictly inside a chip have none: a `contenteditable=false`
    // element cannot hold the caret, so only the boundaries around it are
    // reachable. Everything else in the value must round-trip exactly.
    const { el } = makeChipEditor()
    for (const target of [0, 1, 2, 18, 19, 20]) {
      expect(placeCaretAtOffset(el, target)).toBe(true)
      const sel = document.getSelection()!
      expect(offsetOf(el, sel.anchorNode!, sel.anchorOffset)).toBe(target)
    }
  })
})
