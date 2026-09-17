// @vitest-environment happy-dom
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

  it('reads a block container as a line break', () => {
    // `execCommand('insertText')` materialises a '\n' as a block element in
    // Chromium. Flattening blocks with no separator silently JOINS the lines,
    // so a multi-line paste reached the model as one run-on line.
    const host = document.createElement('div')
    host.innerHTML = 'one<div>two</div><div>three</div>'
    expect(joinTokens(serializeTokens(host))).toBe('one\ntwo\nthree')
  })

  it('does not open a leading break for a block that starts the value', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div>one</div><div>two</div>'
    expect(joinTokens(serializeTokens(host))).toBe('one\ntwo')
  })

  it('keeps an empty line held by a block-wrapped <br>', () => {
    // `<div><br></div>` is an EMPTY LINE: the block supplies the break and the
    // <br> is only how the empty line renders. Skipping both would join the
    // lines on either side of it.
    const host = document.createElement('div')
    host.innerHTML = '<div>line1</div><div><br></div><div>line2</div>'
    expect(joinTokens(serializeTokens(host))).toBe('line1\n\nline2')
  })

  it('treats a trailing block-wrapped <br> as a trailing newline', () => {
    // "abc" then Shift+Enter: Chromium produces abc<div><br></div>.
    const host = document.createElement('div')
    host.innerHTML = 'abc<div><br></div>'
    expect(joinTokens(serializeTokens(host))).toBe('abc\n')
  })

  it('keeps a LEADING empty line', () => {
    // Chromium's execCommand('insertText') builds exactly this for a paste
    // that begins with a blank line. The break must follow from the sibling
    // structure, not from "has anything been emitted yet" — that older rule
    // dropped the line entirely and the model received different text than
    // the user pasted.
    const host = document.createElement('div')
    host.innerHTML = '<div><br></div><div>foo</div>'
    expect(joinTokens(serializeTokens(host))).toBe('\nfoo')
  })

  it('keeps several leading empty lines', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div><br></div><div><br></div><div>foo</div>'
    expect(joinTokens(serializeTokens(host))).toBe('\n\nfoo')
  })

  it('breaks between a block and the text that follows it', () => {
    // The block is a line, so text after it starts a new one.
    const host = document.createElement('div')
    host.innerHTML = '<div>one</div>two'
    expect(joinTokens(serializeTokens(host))).toBe('one\ntwo')
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
