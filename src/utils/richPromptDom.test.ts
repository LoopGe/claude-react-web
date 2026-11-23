// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  CHIP_ATTR,
  CHIP_CLASS,
  MENTION_CHIP_ATTR,
  MENTION_CHIP_CLASS,
  domRepresentsValue,
  renderTokens,
  serializeTokens,
} from './richPromptDom'
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
      '@src/a.ts hi',
      '@bob [Pasted text #1] @src/a.ts',
      'see @"my dir/" now',
      '[Pasted text #1] @dir/ tail',
    ]
    for (const text of samples) {
      host.replaceChildren(renderTokens(document, tokenize(text)))
      expect(joinTokens(serializeTokens(host))).toBe(text)
    }
  })
})

describe('mention chips', () => {
  let host: HTMLDivElement
  beforeEach(() => {
    host = document.createElement('div')
  })

  it('renders a mention as a non-editable chip carrying its encoded path and dir', () => {
    host.appendChild(
      renderTokens(document, [
        { kind: 'mention', text: '@src/a.ts', path: 'src/a.ts', dir: false },
      ]),
    )
    const chip = host.querySelector(`.${MENTION_CHIP_CLASS}`)!
    expect(chip).not.toBeNull()
    expect(chip.getAttribute('contenteditable')).toBe('false')
    expect(chip.getAttribute('data-dir')).toBe('0')
    expect(decodeURIComponent(chip.getAttribute(MENTION_CHIP_ATTR)!)).toBe('src/a.ts')
    expect(chip.textContent).toBe('@src/a.ts')
    // A mention chip is NOT a paste-ref chip.
    expect(chip.hasAttribute(CHIP_ATTR)).toBe(false)
  })

  it('marks a directory mention with data-dir=1', () => {
    host.appendChild(
      renderTokens(document, [
        { kind: 'mention', text: '@"my dir/"', path: 'my dir', dir: true },
      ]),
    )
    const chip = host.querySelector(`.${MENTION_CHIP_CLASS}`)!
    expect(chip.getAttribute('data-dir')).toBe('1')
    expect(decodeURIComponent(chip.getAttribute(MENTION_CHIP_ATTR)!)).toBe('my dir')
    expect(chip.textContent).toBe('@"my dir/"')
  })

  it('serializes a mention chip back to its token via the data attrs', () => {
    host.appendChild(
      renderTokens(document, [
        { kind: 'text', text: 'see ' },
        { kind: 'mention', text: '@"my dir/"', path: 'my dir', dir: true },
        { kind: 'text', text: ' now' },
      ]),
    )
    expect(serializeTokens(host)).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'mention', text: '@"my dir/"', path: 'my dir', dir: true },
      { kind: 'text', text: ' now' },
    ])
  })

  it('round-trips a mixed text + mention + paste-ref token list', () => {
    const tokens = tokenize('@bob [Pasted text #1] @src/a.ts')
    host.replaceChildren(renderTokens(document, tokens))
    expect(serializeTokens(host)).toEqual(tokens)
    expect(joinTokens(serializeTokens(host))).toBe('@bob [Pasted text #1] @src/a.ts')
  })

  it('treats a mention chip as one opaque segment for caret measurement', async () => {
    const { offsetOf } = await import('../components/richPromptCaret')
    host.replaceChildren(
      renderTokens(document, [
        { kind: 'text', text: 'hi ' },
        { kind: 'mention', text: '@src/a.ts', path: 'src/a.ts', dir: false },
        { kind: 'text', text: ' tail' },
      ]),
    )
    // Caret at the start of the trailing text node sits past the whole chip.
    const tail = host.lastChild as Text
    expect(offsetOf(host, tail, 0)).toBe('hi @src/a.ts'.length)
  })
})

describe('domRepresentsValue caret gate', () => {
  let host: HTMLDivElement
  beforeEach(() => {
    host = document.createElement('div')
  })

  it('accepts a forming mention as TEXT when the caret is at its end', () => {
    host.replaceChildren(renderTokens(document, [{ kind: 'text', text: '@sr' }]))
    const tokens = tokenize('@sr')
    // caret at offset 3 (the end of the forming word) → must stay editable text.
    expect(domRepresentsValue(host, tokens, 3)).toBe(true)
    // …and a chip in the DOM would NOT represent the forming word.
    host.replaceChildren(renderTokens(document, tokens))
    expect(domRepresentsValue(host, tokens, 3)).toBe(false)
  })

  it('accepts a forming mention as TEXT when the caret is inside it', () => {
    host.replaceChildren(renderTokens(document, [{ kind: 'text', text: 'hi @sr' }]))
    const tokens = tokenize('hi @sr')
    expect(domRepresentsValue(host, tokens, 5)).toBe(true) // inside '@sr'
  })

  it('expects a CHIP once the caret has departed past the mention end', () => {
    const tokens = tokenize('@sr ')
    // DOM still holds the settled mention as plain text → not in sync.
    host.replaceChildren(renderTokens(document, [{ kind: 'text', text: '@sr ' }]))
    expect(domRepresentsValue(host, tokens, 4)).toBe(false)
    // A real chip + trailing space IS in sync.
    host.replaceChildren(renderTokens(document, tokens))
    expect(domRepresentsValue(host, tokens, 4)).toBe(true)
  })

  it('expects a CHIP when the caret sits at the mention start (not forming it)', () => {
    const tokens = tokenize('@sr')
    host.replaceChildren(renderTokens(document, tokens))
    expect(domRepresentsValue(host, tokens, 0)).toBe(true)
  })

  it('expects CHIPs for every mention when no caret is given (settled default)', () => {
    const tokens = tokenize('@a @b')
    host.replaceChildren(renderTokens(document, tokens))
    expect(domRepresentsValue(host, tokens)).toBe(true)
    host.replaceChildren(renderTokens(document, [{ kind: 'text', text: '@a @b' }]))
    expect(domRepresentsValue(host, tokens)).toBe(false)
  })

  it('still requires paste-ref structure regardless of caret', () => {
    // '[Pasted text #1]' is 16 chars; ' @a' follows, so '@a' spans [17, 19].
    const tokens = tokenize('[Pasted text #1] @a')
    // caret departed (0): both the ref and the mention are expected as chips.
    host.replaceChildren(renderTokens(document, tokens))
    expect(domRepresentsValue(host, tokens, 0)).toBe(true)
    // caret at the end of '@a' (19): the mention demotes to text, the ref stays a chip.
    host.replaceChildren(
      renderTokens(document, [
        { kind: 'ref', id: 1, label: '[Pasted text #1]' },
        { kind: 'text', text: ' @a' },
      ]),
    )
    expect(domRepresentsValue(host, tokens, 19)).toBe(true)
    // a plain-text ref is never in sync, even with the caret inside the mention.
    host.replaceChildren(
      renderTokens(document, [{ kind: 'text', text: '[Pasted text #1] @a' }]),
    )
    expect(domRepresentsValue(host, tokens, 19)).toBe(false)
  })
})
