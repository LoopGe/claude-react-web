// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { CHIP_ATTR, CHIP_CLASS, renderTokens, serializeTokens } from './richPromptDom'
import { joinTokens, tokenize } from './pastedText'

describe('renderTokens', () => {
  it('renders literal text as text nodes', () => {
    const host = document.createElement('div')
    host.appendChild(renderTokens(document, [{ kind: 'text', text: 'a\nb' }]))
    expect(host.textContent).toBe('a\nb')
    expect(host.querySelector('span')).toBeNull()
  })

  it('renders a reference as a non-editable chip carrying its id', () => {
    const host = document.createElement('div')
    host.appendChild(
      renderTokens(document, [{ kind: 'ref', id: 7, label: '[Pasted text #7 +2 lines]' }]),
    )
    const chip = host.querySelector(`.${CHIP_CLASS}`)!
    expect(chip).not.toBeNull()
    expect(chip.getAttribute(CHIP_ATTR)).toBe('7')
    expect(chip.getAttribute('contenteditable')).toBe('false')
    expect(chip.textContent).toBe('[Pasted text #7 +2 lines]')
  })
})

describe('serializeTokens', () => {
  it('reads literal text and chips back out', () => {
    const host = document.createElement('div')
    host.appendChild(
      renderTokens(document, [
        { kind: 'text', text: 'hi ' },
        { kind: 'ref', id: 3, label: '[Pasted text #3]' },
        { kind: 'text', text: ' there' },
      ]),
    )
    expect(serializeTokens(host)).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'ref', id: 3, label: '[Pasted text #3]' },
      { kind: 'text', text: ' there' },
    ])
  })

  it('merges adjacent text nodes rather than emitting several tokens', () => {
    const host = document.createElement('div')
    host.append('a', 'b')
    host.appendChild(document.createTextNode('c'))
    expect(serializeTokens(host)).toEqual([{ kind: 'text', text: 'abc' }])
  })

  it('treats a lone <br> as an empty editor, not as a newline', () => {
    // A contenteditable emptied by select-all + delete keeps a <br> in the
    // DOM as the caret's host — otherwise the caret has nowhere to sit. That
    // <br> is structural, not content. Serializing it as '\n' puts a newline
    // the user never typed into the value, and the NEXT paste is spliced
    // after it, landing as a leading blank line in front of the pasted text.
    const host = document.createElement('div')
    host.appendChild(document.createElement('br'))
    expect(serializeTokens(host)).toEqual([])
  })

  it('reads a stray <br> back as a newline', () => {
    // Browsers and IMEs can still produce one behind our back; dropping it
    // would silently join two lines.
    const host = document.createElement('div')
    host.append('a', document.createElement('br'), 'b')
    expect(serializeTokens(host)).toEqual([{ kind: 'text', text: 'a\nb' }])
  })

  it('recurses into plain wrappers', () => {
    const host = document.createElement('div')
    const inner = document.createElement('span')
    inner.textContent = 'wrapped'
    host.appendChild(inner)
    expect(serializeTokens(host)).toEqual([{ kind: 'text', text: 'wrapped' }])
  })

  it('yields nothing for an empty editor', () => {
    expect(serializeTokens(document.createElement('div'))).toEqual([])
  })
})

describe('DOM round-trip', () => {
  let host: HTMLDivElement
  beforeEach(() => {
    host = document.createElement('div')
  })

  // The property that makes the contenteditable swap safe: whatever the user's
  // text is, pushing it through the DOM and back must return it unchanged.
  it('is the identity for any composer text', () => {
    const samples = [
      '',
      'plain',
      '[Pasted text #1]',
      'hi [Pasted text #1 +2 lines] there',
      'a[Pasted text #1]b',
      '[Pasted text #1][Pasted text #2]',
      'multi\nline [Pasted text #3 +9 lines]\ntail',
      'trailing newline\n',
      '[Pasted text #4] starts',
    ]
    for (const text of samples) {
      host.replaceChildren(renderTokens(document, tokenize(text)))
      expect(joinTokens(serializeTokens(host))).toBe(text)
    }
  })
})
