import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { RichPromptInput, type RichPromptHandle } from './RichPromptInput'
import { QUOTE_CHIP_ATTR, QUOTE_CHIP_CLASS, QUOTE_REMOVE_ATTR, MENTION_CHIP_CLASS } from '../utils/richPromptDom'
import { placeCaretAtOffset, offsetOf } from './richPromptCaret'
import { quoteTextOf } from '../utils/quote-text'

// RTL cleanup is registered globally in src/test-setup.ts (globals: false means
// it never self-registers); no per-file afterEach here.

function editor(container: HTMLElement): HTMLDivElement {
  return container.querySelector('[role="textbox"]') as HTMLDivElement
}

/** Simulate the browser setting the editor's text and leaving the caret at its
 *  end, then firing `input` (what a keystroke does). */
function typeText(el: HTMLDivElement, text: string) {
  el.textContent = text
  placeCaretAtOffset(el, text.length)
  fireEvent.input(el)
}

/** Insert `text` at the LIVE DOM selection (wherever the caret currently sits),
 *  leave the caret after it, and fire `input` — what a real keystroke does. Used
 *  to exercise typing immediately after a settled chip, where the browser appends
 *  separator-less text next to the chip. */
function typeAtCaret(el: HTMLDivElement, text: string) {
  const doc = el.ownerDocument
  const sel = doc.getSelection()!
  const range = sel.getRangeAt(0)
  range.deleteContents()
  const node = doc.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  fireEvent.input(el)
}

/** Current caret offset in VALUE space (the string `onChange` reports). */
function caretValueOffset(el: HTMLDivElement): number {
  const sel = el.ownerDocument.getSelection()!
  return offsetOf(el, sel.anchorNode!, sel.anchorOffset)
}

describe('RichPromptInput quote chip', () => {
  it('renders a restored draft blockquote as a settled chip (decoded excerpt, exact serialization)', () => {
    const { container } = render(
      <RichPromptInput value={'see\n\n> a\n> b\n\nnow'} onChange={vi.fn()} ariaLabel="Q" />,
    )
    const el = editor(container)
    const chip = el.querySelector(`.${QUOTE_CHIP_CLASS}`)!
    expect(chip).not.toBeNull()
    expect(chip.getAttribute('contenteditable')).toBe('false')
    expect(chip.getAttribute(QUOTE_CHIP_ATTR)).toBe('> a\n> b')
    expect(chip.querySelector('.quote-chip-text')!.textContent).toBe(quoteTextOf('> a\n> b'))
    // The editor's serialized value still round-trips the exact run.
    expect(el.textContent).toContain('a\nb') // decoded excerpt is what renders
  })

  it('keeps a forming blockquote editable while the caret is at its end', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(
      <RichPromptInput value=">" onChange={onChange} ariaLabel="Q" />,
    )
    const el = editor(container)
    placeCaretAtOffset(el, 1)
    typeText(el, '> q')
    expect(onChange).toHaveBeenLastCalledWith('> q')
    rerender(<RichPromptInput value="> q" onChange={onChange} ariaLabel="Q" />)
    // caret at the run end → whole run stays editable text, no atomic chip.
    expect(el.querySelector(`.${QUOTE_CHIP_CLASS}`)).toBeNull()
    expect(el.textContent).toBe('> q')
  })

  it('chipifies the run once the caret departs past its end (newline)', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(
      <RichPromptInput value="> q" onChange={onChange} ariaLabel="Q" />,
    )
    const el = editor(container)
    typeText(el, '> q\n')
    expect(onChange).toHaveBeenLastCalledWith('> q\n')
    rerender(<RichPromptInput value={'> q\n'} onChange={onChange} ariaLabel="Q" />)
    const chip = el.querySelector(`.${QUOTE_CHIP_CLASS}`)!
    expect(chip).not.toBeNull()
    expect(chip.getAttribute(QUOTE_CHIP_ATTR)).toBe('> q')
  })

  it('removes the whole run atomically when the chip is deleted from the DOM', () => {
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput value={'a\n\n> q\n\nb'} onChange={onChange} ariaLabel="Q" />,
    )
    const el = editor(container)
    el.querySelector(`.${QUOTE_CHIP_CLASS}`)!.remove()
    fireEvent.input(el)
    expect(onChange).toHaveBeenCalledWith('a\n\n\n\nb')
  })

  it('removes the exact run via the × button and reports the spliced value', () => {
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput value={'a\n\n> q\n\nb'} onChange={onChange} ariaLabel="Q" />,
    )
    const el = editor(container)
    const btn = el.querySelector(`[${QUOTE_REMOVE_ATTR}]`)!
    expect(btn).not.toBeNull()
    fireEvent.click(btn)
    expect(onChange).toHaveBeenCalledWith('a\n\n\n\nb')
    // The chip is gone from the rebuilt DOM.
    expect(el.querySelector(`.${QUOTE_CHIP_CLASS}`)).toBeNull()
  })

  it('copies the exact Markdown blockquote (not the decoded excerpt) when the selection touches a quote chip', () => {
    const { container } = render(
      <RichPromptInput value={'a\n\n> a\n> b\n\nz'} onChange={vi.fn()} ariaLabel="Q" />,
    )
    const el = editor(container)
    const chip = el.querySelector(`.${QUOTE_CHIP_CLASS}`)!
    // Select across the whole chip.
    const range = el.ownerDocument.createRange()
    range.setStartBefore(chip)
    range.setEndAfter(chip)
    const sel = el.ownerDocument.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    const setData = vi.fn()
    fireEvent.copy(el, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', '> a\n> b')
  })

  it('leaves a mention chip and a quote chip coexisting (mention path unaffected)', () => {
    const { container } = render(
      <RichPromptInput value={'@src/a.ts\n\n> q'} onChange={vi.fn()} ariaLabel="Q" />,
    )
    const el = editor(container)
    expect(el.querySelector(`.${MENTION_CHIP_CLASS}`)).not.toBeNull()
    expect(el.querySelector(`.${QUOTE_CHIP_CLASS}`)).not.toBeNull()
  })
})

describe('RichPromptInput quote chip — caret space after typing adjacent to a chip', () => {
  // The value `onChange` reports is `joinTokens(serializeTokens(el))`, whose
  // blank-line guard inserts `\n\n` between a quote run and separator-less prose.
  // The caret must be measured in THAT value space, not the raw DOM-serialization
  // space — otherwise the reconcile restores it before the inserted newlines and
  // subsequent keystrokes land in reverse order on separate lines.
  it('keeps the caret after the typed char when typing immediately after a settled quote chip', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(
      <RichPromptInput value="> q" onChange={onChange} ariaLabel="Q" />,
    )
    const el = editor(container)
    placeCaretAtOffset(el, 3) // caret at the settled chip's end
    typeAtCaret(el, 'x')
    expect(onChange).toHaveBeenLastCalledWith('> q\n\nx')
    rerender(<RichPromptInput value={'> q\n\nx'} onChange={onChange} ariaLabel="Q" />)
    // Caret must sit AFTER the 'x' (value offset 6), not between the inserted newlines.
    expect(caretValueOffset(el)).toBe('> q\n\nx'.length)

    // The next keystroke must append in typed order, not invert.
    typeAtCaret(el, 'y')
    expect(onChange).toHaveBeenLastCalledWith('> q\n\nxy')
    rerender(<RichPromptInput value={'> q\n\nxy'} onChange={onChange} ariaLabel="Q" />)
    expect(caretValueOffset(el)).toBe('> q\n\nxy'.length)
  })

  it('keeps typed order when typing after a quote chip that follows leading prose', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(
      <RichPromptInput value={'a\n\n> q'} onChange={onChange} ariaLabel="Q" />,
    )
    const el = editor(container)
    placeCaretAtOffset(el, 'a\n\n> q'.length) // caret at the chip's end
    typeAtCaret(el, 'x')
    expect(onChange).toHaveBeenLastCalledWith('a\n\n> q\n\nx')
    rerender(<RichPromptInput value={'a\n\n> q\n\nx'} onChange={onChange} ariaLabel="Q" />)
    expect(caretValueOffset(el)).toBe('a\n\n> q\n\nx'.length)

    typeAtCaret(el, 'y')
    expect(onChange).toHaveBeenLastCalledWith('a\n\n> q\n\nxy')
    rerender(<RichPromptInput value={'a\n\n> q\n\nxy'} onChange={onChange} ariaLabel="Q" />)
    expect(caretValueOffset(el)).toBe('a\n\n> q\n\nxy'.length)
  })
})

describe('RichPromptInput insertQuoteAtCaret (select-to-quote insert)', () => {
  function mount(value: string, onChange = vi.fn()) {
    const ref = createRef<HTMLDivElement & RichPromptHandle>()
    const { container } = render(
      <RichPromptInput value={value} onChange={onChange} editorRef={ref} ariaLabel="Q" />,
    )
    return { el: editor(container), handle: ref.current!, onChange }
  }

  it('inserts a settled quote chip into an empty draft', () => {
    const { el, handle, onChange } = mount('')
    handle.insertQuoteAtCaret('hello')
    expect(onChange).toHaveBeenLastCalledWith('> hello\n')
    const chip = el.querySelector(`.${QUOTE_CHIP_CLASS}`)!
    expect(chip).not.toBeNull()
    expect(chip.getAttribute(QUOTE_CHIP_ATTR)).toBe('> hello')
  })

  it('makes the run line-leading with a blank-line separator after mid-line prose', () => {
    const { el, handle, onChange } = mount('hello world')
    placeCaretAtOffset(el, 'hello world'.length)
    handle.insertQuoteAtCaret('q')
    expect(onChange).toHaveBeenLastCalledWith('hello world\n> q\n')
    expect(el.querySelector(`.${QUOTE_CHIP_CLASS}`)!.getAttribute(QUOTE_CHIP_ATTR)).toBe('> q')
  })

  it('inserts before existing prose with a blank-line separator', () => {
    const { el, handle, onChange } = mount('prose')
    placeCaretAtOffset(el, 0)
    handle.insertQuoteAtCaret('q')
    expect(onChange).toHaveBeenLastCalledWith('> q\n\nprose')
    expect(el.querySelector(`.${QUOTE_CHIP_CLASS}`)).not.toBeNull()
  })

  it('appends at the draft end when the editor has no live caret (blurred)', () => {
    const { el, handle, onChange } = mount('draft')
    // No selection inside the editor → insert at the end.
    el.ownerDocument.getSelection()!.removeAllRanges()
    handle.insertQuoteAtCaret('q')
    expect(onChange).toHaveBeenLastCalledWith('draft\n> q\n')
    expect(el.querySelector(`.${QUOTE_CHIP_CLASS}`)).not.toBeNull()
  })

  it('formats a multi-line selection as one multi-line quote run', () => {
    const { el, handle, onChange } = mount('')
    handle.insertQuoteAtCaret('line one\nline two')
    expect(onChange).toHaveBeenLastCalledWith('> line one\n> line two\n')
    expect(el.querySelector(`.${QUOTE_CHIP_CLASS}`)!.getAttribute(QUOTE_CHIP_ATTR)).toBe('> line one\n> line two')
  })

  it('inserts at the remembered mid-draft caret once the selection leaves the editor', () => {
    const { el, handle, onChange } = mount('hello world')
    // Caret mid-text; a caret move inside the editor is remembered.
    placeCaretAtOffset(el, 5)
    el.ownerDocument.dispatchEvent(new Event('selectionchange'))
    // Selecting transcript text moves the selection out of the editor.
    el.ownerDocument.getSelection()!.removeAllRanges()
    handle.insertQuoteAtCaret('q')
    expect(onChange).toHaveBeenLastCalledWith('hello\n> q\n\n world')
    expect(el.querySelector(`.${QUOTE_CHIP_CLASS}`)!.getAttribute(QUOTE_CHIP_ATTR)).toBe('> q')
  })

  it('tracks the latest caret, not the first remembered one', () => {
    const { el, handle, onChange } = mount('hello world')
    placeCaretAtOffset(el, 5)
    el.ownerDocument.dispatchEvent(new Event('selectionchange'))
    placeCaretAtOffset(el, 8)
    el.ownerDocument.dispatchEvent(new Event('selectionchange'))
    el.ownerDocument.getSelection()!.removeAllRanges()
    handle.insertQuoteAtCaret('q')
    expect(onChange).toHaveBeenLastCalledWith('hello wo\n> q\n\nrld')
  })

  it('clamps a remembered caret to a draft that has since shrunk', () => {
    const onChange = vi.fn()
    const ref = createRef<HTMLDivElement & RichPromptHandle>()
    const { rerender } = render(
      <RichPromptInput value="hello world" onChange={onChange} editorRef={ref} ariaLabel="Q" />,
    )
    const el = ref.current!
    placeCaretAtOffset(el, 8)
    el.ownerDocument.dispatchEvent(new Event('selectionchange'))
    // Selection leaves the editor, then the draft is replaced by a shorter one.
    el.ownerDocument.getSelection()!.removeAllRanges()
    rerender(<RichPromptInput value="hi" onChange={onChange} editorRef={ref} ariaLabel="Q" />)
    ref.current!.insertQuoteAtCaret('q')
    expect(onChange).toHaveBeenLastCalledWith('hi\n> q\n')
  })
})