// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { readTextSelection, selectedText, TEXT_INTERACTION_SOURCE, TEXT_INTERACTION_EXCLUDE } from './text-selection'

// Build a mounted transcript-style root with one or more marked sources.
function makeRoot(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

function source(html: string, attrs = ''): string {
  return `<div ${TEXT_INTERACTION_SOURCE} ${attrs}>${html}</div>`
}

// Select the entire contents of `el` through the real document selection.
function selectContents(el: Element): Selection {
  const sel = document.getSelection()!
  sel.removeAllRanges()
  const range = document.createRange()
  range.selectNodeContents(el)
  sel.addRange(range)
  return sel
}

function firstText(el: Element): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  return walker.nextNode() as Text
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.getSelection()?.removeAllRanges()
})

describe('readTextSelection', () => {
  it('returns the source and range for a single non-collapsed selection in one source', () => {
    const root = makeRoot(source('<p>hello world</p>'))
    const src = root.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    const sel = selectContents(src)
    const result = readTextSelection(root, sel)
    expect(result).not.toBeNull()
    expect(result!.source).toBe(src)
    expect(selectedText(result!)).toBe('hello world')
  })

  it('returns null for a collapsed selection', () => {
    const root = makeRoot(source('<p>hello</p>'))
    const src = root.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    const text = firstText(src)
    const sel = document.getSelection()!
    sel.removeAllRanges()
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 2)
    sel.addRange(range)
    expect(readTextSelection(root, sel)).toBeNull()
  })

  it('returns null across two sources', () => {
    const root = makeRoot(source('<p>first</p>') + source('<p>second</p>'))
    const [a, b] = [...root.querySelectorAll(`[${TEXT_INTERACTION_SOURCE}]`)]
    const sel = document.getSelection()!
    sel.removeAllRanges()
    const range = document.createRange()
    range.setStart(firstText(a!), 0)
    range.setEnd(firstText(b!), 6)
    sel.addRange(range)
    expect(readTextSelection(root, sel)).toBeNull()
  })

  it('returns null when the selection is in no source', () => {
    const root = makeRoot('<p>plain</p>')
    const sel = selectContents(root.querySelector('p')!)
    expect(readTextSelection(root, sel)).toBeNull()
  })

  it('returns null when the source is outside the root', () => {
    const root = makeRoot('')
    const outside = makeRoot(source('<p>elsewhere</p>'))
    const sel = selectContents(outside.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!)
    expect(readTextSelection(root, sel)).toBeNull()
  })

  it('returns null when a source ancestor is excluded', () => {
    const root = makeRoot(`<div ${TEXT_INTERACTION_EXCLUDE}>${source('<p>hidden chrome</p>')}</div>`)
    const src = root.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    const sel = selectContents(src)
    expect(readTextSelection(root, sel)).toBeNull()
  })

  it('returns null when a source ancestor is hidden', () => {
    const root = makeRoot(`<div hidden>${source('<p>gone</p>')}</div>`)
    const src = root.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    const sel = selectContents(src)
    expect(readTextSelection(root, sel)).toBeNull()
  })

  it('returns null when a source ancestor is inert', () => {
    const root = makeRoot(`<div inert>${source('<p>inert</p>')}</div>`)
    const src = root.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    const sel = selectContents(src)
    expect(readTextSelection(root, sel)).toBeNull()
  })

  it('returns null for a null selection', () => {
    const root = makeRoot(source('<p>x</p>'))
    expect(readTextSelection(root, null)).toBeNull()
  })
})

describe('selectedText projection', () => {
  function project(html: string): string | null {
    const root = makeRoot(source(html))
    const src = root.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    const result = readTextSelection(root, selectContents(src))
    return result === null ? null : selectedText(result)
  }

  it('preserves block boundaries between paragraphs', () => {
    expect(project('<p>alpha</p><p>beta</p>')).toBe('alpha\nbeta')
  })

  it('preserves list item boundaries', () => {
    expect(project('<ul><li>one</li><li>two</li></ul>')).toBe('one\ntwo')
  })

  it('collapses soft line breaks to spaces outside pre', () => {
    expect(project('<p>line one\nline two</p>')).toBe('line one line two')
  })

  it('preserves newlines inside pre', () => {
    expect(project('<pre style="white-space: pre">a\nb\nc</pre>')).toBe('a\nb\nc')
  })

  it('preserves newlines inside pre-wrap', () => {
    expect(project('<div style="white-space: pre-wrap">a\nb</div>')).toBe('a\nb')
  })

  it('projects table cells to tabs and rows to newlines', () => {
    expect(project('<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>'))
      .toBe('a\tb\nc\td')
  })

  it('drops button chrome outside code', () => {
    expect(project('<p>keep<button>Copy</button> tail</p>')).toBe('keep tail')
  })

  it('keeps a button inside code (inline code affordance)', () => {
    expect(project('<p><code>run<button>x</button></code></p>')).toBe('runx')
  })

  it('drops katex-mathml, aria-hidden and sr-only chrome', () => {
    expect(project(
      '<p>math<span class="katex-mathml">x^2</span><span aria-hidden="true">icon</span><span class="sr-only">screen reader</span> end</p>',
    )).toBe('math end')
  })

  it('drops data-text-interaction-exclude chrome (tool-card badge / attachment chip)', () => {
    expect(project(
      `<p>output<span ${TEXT_INTERACTION_EXCLUDE} class="tool-status">done</span><span ${TEXT_INTERACTION_EXCLUDE} class="msg-file-chip">file.ts 2 KB</span> rest</p>`,
    )).toBe('output rest')
  })

  it('keeps mention-chip text (user content, not chrome) even though it is a button', () => {
    expect(project('<p>see <button class="msg-mention-chip">@src/a.ts</button> ok</p>'))
      .toBe('see @src/a.ts ok')
  })

  it('drops an excluded fold summary (AnimatedDetails chrome)', () => {
    expect(project(
      `<details><summary ${TEXT_INTERACTION_EXCLUDE}>show 3 more lines</summary><div>body text</div></details>`,
    )).toBe('body text')
  })

  it('returns null for a whitespace-only projection', () => {
    expect(project('<p>   </p>')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(project('<p>  padded  </p>')).toBe('padded')
  })

  it('projects a partial text-node range', () => {
    const root = makeRoot(source('<p>hello world</p>'))
    const src = root.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    const text = firstText(src)
    const sel = document.getSelection()!
    sel.removeAllRanges()
    const range = document.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 11)
    sel.addRange(range)
    const result = readTextSelection(root, sel)!
    expect(selectedText(result)).toBe('world')
  })
})
