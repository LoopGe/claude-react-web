import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { RichPromptInput } from './RichPromptInput'
import { MENTION_CHIP_ATTR, MENTION_CHIP_SELECTOR } from '../utils/richPromptDom'
import { placeCaretAtOffset } from './richPromptCaret'

// RTL cleanup is registered globally in src/test-setup.ts (globals: false means
// it never self-registers); no per-file afterEach here.

function editor(container: HTMLElement): HTMLDivElement {
  return container.querySelector('[role="textbox"]') as HTMLDivElement
}

/** Simulate the browser inserting `text` into the editor's single text node and
 *  leaving the caret at its end, then firing `input` (what a keystroke does). */
function typeText(el: HTMLDivElement, text: string) {
  el.textContent = text
  placeCaretAtOffset(el, text.length)
  fireEvent.input(el)
}

describe('RichPromptInput mention chipification', () => {
  it('keeps a forming @mention editable while the caret is at its end', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(
      <RichPromptInput value="@" onChange={onChange} ariaLabel="M" />,
    )
    const el = editor(container)
    placeCaretAtOffset(el, 1)

    // Type 's' then 'r' — every prefix of an unquoted mention is grammatically
    // complete, so a context-free reconcile would chipify on the 2nd keystroke.
    typeText(el, '@sr')
    expect(onChange).toHaveBeenLastCalledWith('@sr')
    rerender(<RichPromptInput value="@sr" onChange={onChange} ariaLabel="M" />)

    // The forming word stays ordinary text: no atomic chip under the caret.
    expect(el.querySelector(MENTION_CHIP_SELECTOR)).toBeNull()
    expect(el.textContent).toBe('@sr')

    // Backspace deletes ONE character (text), not the whole mention (chip).
    const textNode = el.firstChild as Text
    textNode.data = '@s'
    placeCaretAtOffset(el, 2)
    fireEvent.input(el)
    expect(onChange).toHaveBeenLastCalledWith('@s')
  })

  it('chipifies a settled mention once a space departs the caret past its end', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(
      <RichPromptInput value="@" onChange={onChange} ariaLabel="M" />,
    )
    const el = editor(container)
    placeCaretAtOffset(el, 1)
    typeText(el, '@sr')
    rerender(<RichPromptInput value="@sr" onChange={onChange} ariaLabel="M" />)
    expect(el.querySelector(MENTION_CHIP_SELECTOR)).toBeNull()

    // Insert a space: the caret now sits past the mention's end → it settles.
    typeText(el, '@sr ')
    expect(onChange).toHaveBeenLastCalledWith('@sr ')
    rerender(<RichPromptInput value="@sr " onChange={onChange} ariaLabel="M" />)

    const chip = el.querySelector(MENTION_CHIP_SELECTOR)
    expect(chip).not.toBeNull()
    expect(decodeURIComponent(chip!.getAttribute(MENTION_CHIP_ATTR)!)).toBe('sr')
    expect(chip!.getAttribute('data-dir')).toBe('0')
    expect(chip!.textContent).toBe('@sr')
    expect(el.textContent).toBe('@sr ')
  })

  it('keeps a settled mention as a chip when the caret rests at its start', () => {
    // Reconcile is value-driven (deps [value, ref]), so a caret move alone never
    // re-runs it — departure is observed on the next value change. Here an edit
    // leaves the caret at the mention's START (offset 2 of 'x @sr '); the gate is
    // start-exclusive, so a caret resting before a settled chip does not demote it.
    const onChange = vi.fn()
    const { container, rerender } = render(
      <RichPromptInput value="@sr " onChange={onChange} ariaLabel="M" />,
    )
    const el = editor(container)
    typeText(el, 'x @sr ')
    placeCaretAtOffset(el, 2) // start of '@sr', not forming it
    rerender(<RichPromptInput value="x @sr " onChange={onChange} ariaLabel="M" />)
    const chip = el.querySelector(MENTION_CHIP_SELECTOR)
    expect(chip).not.toBeNull()
    expect(el.textContent).toBe('x @sr ')
  })

  it('renders a picked mention as a chip immediately (caret departed past its end)', () => {
    // A pick splices the canonical mention plus a trailing space and restores
    // the caret AFTER the space, so the mention is settled on the very next
    // reconcile — no extra keystroke needed. (The trailing space is the pick's
    // caret-departure mechanism; see Task 4 replaceAtWord.)
    const onChange = vi.fn()
    const { container, rerender } = render(
      <RichPromptInput value="" onChange={onChange} ariaLabel="M" />,
    )
    const el = editor(container)
    typeText(el, '@src/a.ts ')
    expect(onChange).toHaveBeenLastCalledWith('@src/a.ts ')
    rerender(<RichPromptInput value="@src/a.ts " onChange={onChange} ariaLabel="M" />)

    const chip = el.querySelector(MENTION_CHIP_SELECTOR)
    expect(chip).not.toBeNull()
    expect(decodeURIComponent(chip!.getAttribute(MENTION_CHIP_ATTR)!)).toBe('src/a.ts')
    expect(chip!.getAttribute('data-dir')).toBe('0')
    expect(chip!.getAttribute('contenteditable')).toBe('false')
    expect(chip!.textContent).toBe('@src/a.ts')
  })

  it('renders a restored draft mention as a chip when the editor is unfocused', () => {
    // No caret (editor not focused) → every mention is settled → chips. This is
    // the draft-restore path: sessionStorage holds the plain string, tokenize
    // re-derives the chips, no body map needed.
    const { container } = render(
      <RichPromptInput value='see @"my dir/" now' onChange={vi.fn()} ariaLabel="M" />,
    )
    const el = editor(container)
    const chip = el.querySelector(MENTION_CHIP_SELECTOR)
    expect(chip).not.toBeNull()
    expect(decodeURIComponent(chip!.getAttribute(MENTION_CHIP_ATTR)!)).toBe('my dir')
    expect(chip!.getAttribute('data-dir')).toBe('1')
    expect(el.textContent).toBe('see @"my dir/" now')
  })

  it('reports a settled chip click with its decoded path and dir flag', () => {
    const onMentionClick = vi.fn()
    const { container } = render(
      <RichPromptInput value="see @src/a.ts now" onChange={vi.fn()} ariaLabel="M" onMentionClick={onMentionClick} />,
    )
    const el = editor(container)
    fireEvent.click(el.querySelector(MENTION_CHIP_SELECTOR)!)
    expect(onMentionClick).toHaveBeenCalledTimes(1)
    expect(onMentionClick).toHaveBeenCalledWith({ path: 'src/a.ts', dir: false })
  })

  it('decodes a quoted directory chip path on click', () => {
    const onMentionClick = vi.fn()
    const { container } = render(
      <RichPromptInput value='@"my dir/" ' onChange={vi.fn()} ariaLabel="M" onMentionClick={onMentionClick} />,
    )
    const el = editor(container)
    fireEvent.click(el.querySelector(MENTION_CHIP_SELECTOR)!)
    expect(onMentionClick).toHaveBeenCalledWith({ path: 'my dir', dir: true })
  })

  it('does not report clicks on ordinary editor text', () => {
    const onMentionClick = vi.fn()
    const { container } = render(
      <RichPromptInput value="plain text" onChange={vi.fn()} ariaLabel="M" onMentionClick={onMentionClick} />,
    )
    fireEvent.click(editor(container))
    expect(onMentionClick).not.toHaveBeenCalled()
  })

  it('reports the serialized mention text when a chip is removed from the DOM', () => {
    // Stands in for atomic Backspace on a settled chip: the browser removes the
    // chip element, then fires input. The mention text round-trips out.
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput value="a @src/a.ts b" onChange={onChange} ariaLabel="M" />,
    )
    const el = editor(container)
    el.querySelector(MENTION_CHIP_SELECTOR)!.remove()
    fireEvent.input(el)
    expect(onChange).toHaveBeenCalledWith('a  b')
  })
})
