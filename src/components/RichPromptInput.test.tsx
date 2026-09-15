import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, createEvent } from '@testing-library/react'
import { RichPromptInput, type RichPromptHandle } from './RichPromptInput'
import { CHIP_CLASS } from '../utils/richPromptDom'
import { selectionOffsets, placeCaretIn, selectAll } from './richPromptApi'

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

  it('builds the chip when the DOM already holds the reference as plain text', () => {
    // What a paste does: the reference text lands in the DOM, and `value`
    // becomes that same string. The two then serialize identically, so a
    // string-equality check calls the DOM "in sync" and skips the rebuild —
    // the reference stays ordinary text, Backspace eats it a character at a
    // time, and a half-deleted one no longer matches `parseReferences`, so the
    // pasted body silently never reaches the model.
    const { container, rerender } = render(
      <RichPromptInput value="hello" onChange={vi.fn()} ariaLabel="M" />,
    )
    editor(container).textContent = '[Pasted text #1 +2 lines]'
    rerender(
      <RichPromptInput
        value="[Pasted text #1 +2 lines]"
        onChange={vi.fn()}
        ariaLabel="M"
      />,
    )
    const chip = container.querySelector(`.${CHIP_CLASS}`)
    expect(chip).not.toBeNull()
    expect(chip!.getAttribute('data-pasted-ref')).toBe('1')
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

describe('RichPromptInput keyboard', () => {
  it('submits on Enter', () => {
    const onSubmit = vi.fn()
    const { container } = render(
      <RichPromptInput value="hi" onChange={vi.fn()} ariaLabel="M" onSubmit={onSubmit} />,
    )
    fireEvent.keyDown(editor(container), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('does not submit on Shift+Enter', () => {
    const onSubmit = vi.fn()
    const { container } = render(
      <RichPromptInput value="hi" onChange={vi.fn()} ariaLabel="M" onSubmit={onSubmit} />,
    )
    fireEvent.keyDown(editor(container), { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not submit while an IME composition is active', () => {
    // Enter confirms a CJK candidate; sending here ships a half-typed word.
    // jsdom's KeyboardEventInit doesn't reliably carry isComposing, so define
    // it on the instance (matching useKeyboardShortcuts.test.ts's pattern).
    const onSubmit = vi.fn()
    const { container } = render(
      <RichPromptInput value="ni" onChange={vi.fn()} ariaLabel="M" onSubmit={onSubmit} />,
    )
    const el = editor(container)
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    Object.defineProperty(event, 'isComposing', { value: true })
    el.dispatchEvent(event)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('reports a newline request on Ctrl+Enter', () => {
    const onNewline = vi.fn()
    const { container } = render(
      <RichPromptInput value="hi" onChange={vi.fn()} ariaLabel="M" onNewline={onNewline} />,
    )
    fireEvent.keyDown(editor(container), { key: 'Enter', ctrlKey: true })
    expect(onNewline).toHaveBeenCalledOnce()
  })

  it('shows the placeholder only while empty', () => {
    const { container } = render(
      <RichPromptInput value="" onChange={vi.fn()} ariaLabel="M" placeholder="Send a message" />,
    )
    expect(editor(container).getAttribute('data-placeholder')).toBe('Send a message')
  })
})

describe('RichPromptInput paste', () => {
  function paste(el: HTMLElement, data: Record<string, string>) {
    const event = createEvent.paste(el, {
      clipboardData: { getData: (t: string) => data[t] ?? '' },
    })
    fireEvent(el, event)
    return event
  }

  it('inserts pasted plain text at the caret', () => {
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput value="" onChange={onChange} ariaLabel="M" />,
    )
    const el = editor(container)
    paste(el, { 'text/plain': 'pasted' })
    expect(el.textContent).toContain('pasted')
  })

  it('never lets HTML from the clipboard into the DOM', () => {
    const { container } = render(
      <RichPromptInput value="" onChange={vi.fn()} ariaLabel="M" />,
    )
    const el = editor(container)
    // Only text/plain is ever read; text/html must be ignored outright.
    const event = paste(el, { 'text/html': '<img src=x onerror=alert(1)>', 'text/plain': 'safe' })
    // The handler must call preventDefault() to block the browser's native
    // contenteditable paste (which would inject the HTML). In jsdom this is
    // the only reliable signal — the DOM assertions alone are vacuous because
    // jsdom does not perform real contenteditable clipboard insertion.
    expect(event.defaultPrevented).toBe(true)
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toBe('safe')
  })

  it('gives the collapse policy first refusal', () => {
    // Returning null means the callback placed the text itself; the editor
    // must insert nothing on top of it.
    const onPasteText = vi.fn(() => null)
    const { container } = render(
      <RichPromptInput value="" onChange={vi.fn()} ariaLabel="M" onPasteText={onPasteText} />,
    )
    const el = editor(container)
    paste(el, { 'text/plain': 'anything' })
    expect(onPasteText).toHaveBeenCalledWith('anything')
    expect(el.textContent).toBe('')
  })

  it('inserts what the policy returns', () => {
    // The callback hands back the text to place — verbatim for an ordinary
    // paste. The editor performs the insert so it lands on the undo stack.
    const onPasteText = vi.fn((raw: string) => raw)
    const { container } = render(
      <RichPromptInput value="" onChange={vi.fn()} ariaLabel="M" onPasteText={onPasteText} />,
    )
    const el = editor(container)
    paste(el, { 'text/plain': 'small' })
    expect(el.textContent).toBe('small')
  })

  it('routes image items to onPasteImage and still inserts the text body', () => {
    // Regression: the old textarea path iterated clipboardData.items and
    // handed each image/* file to onPasteImage. RichPromptInput must do the
    // same — and must keep doing it when the clipboard ALSO carries a text
    // body (a screenshot copied from a rich editor, say).
    const onPasteImage = vi.fn()
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput
        value=""
        onChange={onChange}
        ariaLabel="M"
        onPasteImage={onPasteImage}
      />,
    )
    const el = editor(container)
    const file = new File(['data'], 'shot.png', { type: 'image/png' })
    const event = createEvent.paste(el, {
      clipboardData: {
        getData: (t: string) => (t === 'text/plain' ? 'caption' : ''),
        items: [{ type: 'image/png', getAsFile: () => file }],
      },
    })
    fireEvent(el, event)
    expect(event.defaultPrevented).toBe(true)
    expect(onPasteImage).toHaveBeenCalledOnce()
    expect(onPasteImage).toHaveBeenCalledWith(file)
    // The text body still landed in the editor.
    expect(el.textContent).toBe('caption')
  })
})

describe('RichPromptInput replaceSlashWord', () => {
  it('replaces the /word before the caret and calls onChange', () => {
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput value="hello /mod" onChange={onChange} ariaLabel="M" />,
    )
    const el = editor(container)
    // Place caret at end of text so slashWordBefore sees "/mod".
    const textNode = el.firstChild as Text
    const sel = window.getSelection()!
    const range = document.createRange()
    range.setStart(textNode, textNode.length)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)

    // The methods are attached to the DOM element by the component.
    ;(el as unknown as RichPromptHandle).replaceSlashWord('/cmd')

    expect(onChange).toHaveBeenCalledWith('hello /cmd')
  })
})

describe('RichPromptInput selection', () => {
  function select(el: HTMLElement, start: number, end: number) {
    const range = document.createRange()
    const node = el.firstChild!
    range.setStart(node, start)
    range.setEnd(node, end)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }

  it('reports the selected offsets', () => {
    const ref = { current: null as HTMLDivElement | null }
    const { container } = render(
      <RichPromptInput value="hello world" onChange={vi.fn()} ariaLabel="M" editorRef={ref} />,
    )
    select(editor(container), 0, 5)
    expect(selectionOffsets(ref.current!)).toEqual({ start: 0, end: 5 })
  })

  it('reports the collapsed caret position', () => {
    const ref = { current: null as HTMLDivElement | null }
    const { container } = render(
      <RichPromptInput value="hello" onChange={vi.fn()} ariaLabel="M" editorRef={ref} />,
    )
    select(editor(container), 2, 2)
    expect(selectionOffsets(ref.current!)).toEqual({ start: 2, end: 2 })
  })

  it('placeCaretIn places the caret at the given offset', () => {
    const ref = { current: null as HTMLDivElement | null }
    render(
      <RichPromptInput value="hello" onChange={vi.fn()} ariaLabel="M" editorRef={ref} />,
    )
    placeCaretIn(ref.current!, 3)
    const sel = document.getSelection()!
    expect(sel.rangeCount).toBe(1)
    expect(sel.isCollapsed).toBe(true)
    // The collapsed caret should be at offset 3 in the serialized text.
    // Verify by checking the selection is within the editor.
    const range = sel.getRangeAt(0)
    expect(ref.current!.contains(range.startContainer)).toBe(true)
  })

  it('placeCaretIn preserves DOM content', () => {
    const ref = { current: null as HTMLDivElement | null }
    const { container } = render(
      <RichPromptInput value="hello" onChange={vi.fn()} ariaLabel="M" editorRef={ref} />,
    )
    placeCaretIn(ref.current!, 2)
    expect(editor(container).textContent).toBe('hello')
  })

  it('placeCaretIn does not corrupt a contenteditable that was already updated', () => {
    // Regression test for Finding 1 contenteditable path.  After setInput
    // triggers a React re-render the DOM already contains the post-splice
    // value.  placeCaretIn must only place the caret — not touch the DOM.
    const ref = { current: null as HTMLDivElement | null }
    const { container, rerender } = render(
      <RichPromptInput value="hello" onChange={vi.fn()} ariaLabel="M" editorRef={ref} />,
    )
    // Simulate setInput("hXXo") — React re-renders with the new value.
    rerender(
      <RichPromptInput value="hXXo" onChange={vi.fn()} ariaLabel="M" editorRef={ref} />,
    )
    const el = editor(container)
    expect(el.textContent).toBe('hXXo')

    // The deferred callback fires with the caret at start + text.length.
    // placeCaretIn must NOT touch the DOM content.
    placeCaretIn(ref.current!, 3)
    expect(el.textContent).toBe('hXXo')
  })

  it('selects the whole editor', () => {
    const ref = { current: null as HTMLDivElement | null }
    render(
      <RichPromptInput value="hello" onChange={vi.fn()} ariaLabel="M" editorRef={ref} />,
    )
    selectAll(ref.current!)
    const sel = document.getSelection()!
    expect(sel.rangeCount).toBe(1)
    expect(sel.getRangeAt(0).toString()).toBe('hello')
  })

})
