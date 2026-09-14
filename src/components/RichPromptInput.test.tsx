import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { RichPromptInput } from './RichPromptInput'
import { CHIP_CLASS } from '../utils/richPromptDom'

afterEach(() => cleanup())

function editor(container: HTMLElement): HTMLDivElement {
  return container.querySelector('[role="textbox"]') as HTMLDivElement
}

describe('RichPromptInput', () => {
  it('renders literal text', () => {
    const { container } = render(
      <RichPromptInput value="hello" onChange={vi.fn()} ariaLabel="Message" />,
    )
    expect(editor(container).textContent).toBe('hello')
  })

  it('renders a reference as a non-editable chip', () => {
    const { container } = render(
      <RichPromptInput
        value="hi [Pasted text #2 +9 lines]"
        onChange={vi.fn()}
        ariaLabel="Message"
      />,
    )
    const chip = container.querySelector(`.${CHIP_CLASS}`)!
    expect(chip).not.toBeNull()
    expect(chip.getAttribute('data-pasted-ref')).toBe('2')
    expect(chip.getAttribute('contenteditable')).toBe('false')
  })

  it('reports the serialized text as a chip is removed from the DOM', () => {
    // Stands in for Backspace-with-native-chip-deletion: the browser removes
    // the chip element, then fires `input`. We assert the round-trip, not how
    // the deletion happened.
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput value="a [Pasted text #1] b" onChange={onChange} ariaLabel="Message" />,
    )
    const el = editor(container)
    el.querySelector(`.${CHIP_CLASS}`)!.remove()
    fireEvent.input(el)
    expect(onChange).toHaveBeenCalledWith('a  b')
  })

  it('reports typed text with the reference preserved', () => {
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput value="[Pasted text #1]" onChange={onChange} ariaLabel="Message" />,
    )
    const el = editor(container)
    el.appendChild(document.createTextNode(' tail'))
    fireEvent.input(el)
    expect(onChange).toHaveBeenCalledWith('[Pasted text #1] tail')
  })

  it('does not touch the DOM when the incoming value already matches it', () => {
    // Re-rendering identical content would move the caret on every keystroke.
    const { container, rerender } = render(
      <RichPromptInput value="abc" onChange={vi.fn()} ariaLabel="Message" />,
    )
    const el = editor(container)
    rerender(<RichPromptInput value="abc" onChange={vi.fn()} ariaLabel="Message" />)
    expect(editor(container)).toBe(el)
  })

  it('rebuilds the DOM when the value changes from outside', () => {
    const { container, rerender } = render(
      <RichPromptInput value="one" onChange={vi.fn()} ariaLabel="Message" />,
    )
    rerender(<RichPromptInput value="two" onChange={vi.fn()} ariaLabel="Message" />)
    expect(editor(container).textContent).toBe('two')
  })

  it('exposes the editor through editorRef', () => {
    const ref = { current: null as HTMLDivElement | null }
    render(
      <RichPromptInput value="x" onChange={vi.fn()} ariaLabel="Message" editorRef={ref} />,
    )
    expect(ref.current?.getAttribute('role')).toBe('textbox')
  })

  it('does not rewrite the DOM during IME composition and reports the value on compositionend', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(
      <RichPromptInput value="abc" onChange={onChange} ariaLabel="Message" />,
    )
    const el = editor(container)

    // Start IME composition — the browser is showing a candidate list.
    fireEvent(el, new Event('compositionstart', { bubbles: true }))

    // A value change arrives from the parent while composition is in flight.
    // The composingRef guard must prevent the DOM from being rewritten,
    // otherwise the IME candidate window would collapse.
    rerender(
      <RichPromptInput value="xyz" onChange={onChange} ariaLabel="Message" />,
    )
    expect(editor(container).textContent).toBe('abc')

    // Finish composition. The component should now report the serialized DOM
    // text through onChange.
    el.textContent = 'abxyz'
    fireEvent(el, new Event('compositionend', { bubbles: true }))
    expect(onChange).toHaveBeenCalledWith('abxyz')
  })
})
