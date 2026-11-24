import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { RichPromptInput } from './RichPromptInput'
import { QUOTE_CHIP_ATTR, QUOTE_CHIP_CLASS, QUOTE_REMOVE_ATTR, MENTION_CHIP_CLASS } from '../utils/richPromptDom'
import { placeCaretAtOffset } from './richPromptCaret'
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