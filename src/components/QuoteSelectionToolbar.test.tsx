// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useRef, useState } from 'react'
import { render, fireEvent, act } from '@testing-library/react'
import { QuoteSelectionToolbar } from './QuoteSelectionToolbar'
import { RichPromptInput, type RichPromptHandle } from './RichPromptInput'
import { QUOTE_CHIP_ATTR,
  QUOTE_CHIP_SELECTOR, serializeTokens } from '../utils/richPromptDom'
import { joinTokens } from '../utils/pastedText'
import { placeCaretAtOffset } from './richPromptCaret'
import { TEXT_INTERACTION_SOURCE } from '../utils/text-selection'

// The toolbar reads the selection from a native `selectionchange` listener; the
// setState it triggers flushes through async act (a sync act leaves the portal
// commit for a later tick, so the button would not be queryable yet).
async function selectionChange(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'))
  })
}

function select(el: Element): void {
  const sel = document.getSelection()!
  sel.removeAllRanges()
  const range = document.createRange()
  range.selectNodeContents(el)
  sel.addRange(range)
}

function button(): HTMLElement | null {
  return document.querySelector('[aria-label="Quote selection"]')
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.getSelection()?.removeAllRanges()
})

describe('QuoteSelectionToolbar show / dismiss', () => {
  function setup(onQuote = vi.fn()) {
    const rootRef = { current: null as HTMLElement | null }
    const utils = render(
      <div
        ref={(el) => {
          rootRef.current = el
        }}
      >
        <div {...{ [TEXT_INTERACTION_SOURCE]: '' }}>
          <p>quoted passage</p>
        </div>
        <div {...{ [TEXT_INTERACTION_SOURCE]: '' }}>
          <p>another source</p>
        </div>
        <QuoteSelectionToolbar rootRef={rootRef} onQuote={onQuote} />
      </div>,
    )
    const sources = utils.container.querySelectorAll(`[${TEXT_INTERACTION_SOURCE}]`)
    return { ...utils, rootRef, sources, onQuote }
  }

  it('shows the Quote button for a valid single-source selection', async () => {
    const { sources } = setup()
    select(sources[0]!)
    await selectionChange()
    expect(button()).not.toBeNull()
  })

  it('does not show for a collapsed selection', async () => {
    const { sources } = setup()
    const text = sources[0]!.querySelector('p')!.firstChild as Text
    const sel = document.getSelection()!
    sel.removeAllRanges()
    const range = document.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 1)
    sel.addRange(range)
    await selectionChange()
    expect(button()).toBeNull()
  })

  it('does not show for a cross-source selection', async () => {
    const { sources } = setup()
    const a = sources[0]!.querySelector('p')!.firstChild as Text
    const b = sources[1]!.querySelector('p')!.firstChild as Text
    const sel = document.getSelection()!
    sel.removeAllRanges()
    const range = document.createRange()
    range.setStart(a, 0)
    range.setEnd(b, 7)
    sel.addRange(range)
    await selectionChange()
    expect(button()).toBeNull()
  })

  it('dismisses on Escape', async () => {
    const { sources } = setup()
    select(sources[0]!)
    await selectionChange()
    expect(button()).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(button()).toBeNull()
  })

  it('dismisses when the selection clears', async () => {
    const { sources } = setup()
    select(sources[0]!)
    await selectionChange()
    expect(button()).not.toBeNull()
    await act(async () => {
      document.getSelection()!.removeAllRanges()
    })
    await selectionChange()
    expect(button()).toBeNull()
  })

  it('dismisses on pointerdown elsewhere', async () => {
    const { sources } = setup()
    select(sources[0]!)
    await selectionChange()
    expect(button()).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(button()).toBeNull()
  })

  it('click hands the projected text to onQuote and dismisses', async () => {
    const onQuote = vi.fn()
    const { sources } = setup(onQuote)
    select(sources[0]!)
    await selectionChange()
    fireEvent.click(button()!)
    expect(onQuote).toHaveBeenCalledWith('quoted passage')
    expect(button()).toBeNull()
  })
})

describe('QuoteSelectionToolbar click inserts a composer quote chip', () => {
  function Harness({ initial = '' }: { initial?: string }) {
    const rootRef = useRef<HTMLDivElement>(null)
    const editorRef = useRef<HTMLDivElement & RichPromptHandle>(null)
    const [value, setValue] = useState(initial)
    return (
      <div ref={rootRef}>
        <div {...{ [TEXT_INTERACTION_SOURCE]: '' }}>
          <p>select me</p>
        </div>
        <RichPromptInput value={value} onChange={setValue} editorRef={editorRef} ariaLabel="Q" />
        <QuoteSelectionToolbar
          rootRef={rootRef}
          onQuote={(text) => editorRef.current?.insertQuoteAtCaret(text)}
        />
      </div>
    )
  }

  it('inserts a settled quote chip carrying the selected text', async () => {
    const { container } = render(<Harness />)
    const src = container.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    select(src)
    await selectionChange()
    fireEvent.click(button()!)
    const chip = container.querySelector(QUOTE_CHIP_SELECTOR)!
    expect(chip).not.toBeNull()
    expect(chip.getAttribute(QUOTE_CHIP_ATTR)).toBe('> select me')
    expect(button()).toBeNull()
  })

  it('lands the chip at the remembered mid-draft caret, not appended at the end', async () => {
    const { container } = render(<Harness initial="hello world" />)
    const editorEl = container.querySelector('[role="textbox"]') as HTMLDivElement
    // The user was typing mid-draft; the caret is remembered before they select
    // transcript text (which blurs the editor).
    placeCaretAtOffset(editorEl, 5)
    document.dispatchEvent(new Event('selectionchange'))
    const src = container.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    select(src)
    await selectionChange()
    fireEvent.click(button()!)
    // The quote is spliced at offset 5 (after "hello"), NOT at the draft end.
    expect(joinTokens(serializeTokens(editorEl))).toBe('hello\n> select me\n\n world')
    expect(container.querySelector(QUOTE_CHIP_SELECTOR)!.getAttribute(QUOTE_CHIP_ATTR)).toBe('> select me')
  })
})

describe('QuoteSelectionToolbar placement', () => {
  it('prefers above the selection and clamps into the visible bounds', async () => {
    const rootRef = { current: null as HTMLElement | null }
    render(
      <div
        ref={(el) => {
          rootRef.current = el
        }}
      >
        <div {...{ [TEXT_INTERACTION_SOURCE]: '' }}>
          <p>quoted</p>
        </div>
        <QuoteSelectionToolbar rootRef={rootRef} onQuote={vi.fn()} />
      </div>,
    )
    const root = rootRef.current!
    const src = root.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    // Mock geometry: root spans the viewport; the selection sits mid-screen.
    const rect = (x: number, y: number, w: number, h: number): DOMRect =>
      ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) }) as DOMRect
    // rAF runs synchronously so a resize re-places within the act() flush.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 600))
    vi.spyOn(src, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 600))
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(400)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600)
    // Prototype-level: the toolbar snapshots the range with cloneRange(), so the
    // mock must live on the prototype to survive the clone.
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([rect(100, 300, 200, 20)] as unknown as DOMRectList)
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(rect(100, 300, 200, 20))
    select(src)
    await selectionChange()
    const btn = button()!
    expect(btn).not.toBeNull()
    // Button size mocked so placement math is deterministic.
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 60, 24))
    // Re-run placement via a resize event.
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    // Above preferred: selection top 300 - gap 8 - height 24 = 268.
    expect(btn.style.top).toBe('268px')
    // Centered horizontally over the selection: (100 + 300 - 60) / 2 = 170.
    expect(btn.style.left).toBe('170px')
    expect(btn.style.visibility).toBe('visible')
  })

  it('caps the button above the composer when the below fallback would overlap it', async () => {
    const rootRef = { current: null as HTMLElement | null }
    render(
      <div
        ref={(el) => {
          rootRef.current = el
        }}
      >
        <div {...{ [TEXT_INTERACTION_SOURCE]: '' }}>
          <p>quoted</p>
        </div>
        <div className="chat-composer">composer</div>
        <QuoteSelectionToolbar rootRef={rootRef} onQuote={vi.fn()} />
      </div>,
    )
    const root = rootRef.current!
    const src = root.querySelector(`[${TEXT_INTERACTION_SOURCE}]`)!
    const composer = root.querySelector('.chat-composer')!
    const rect = (x: number, y: number, w: number, h: number): DOMRect =>
      ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 600))
    vi.spyOn(src, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 600))
    // Composer occupies the lower band; its top (150) caps the visible bounds.
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue(rect(0, 150, 400, 450))
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(400)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600)
    // A tall selection near the top: above does not fit, so the below fallback
    // is used — and it must clamp to stay above the composer.
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([rect(100, 20, 200, 100)] as unknown as DOMRectList)
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(rect(100, 20, 200, 100))
    select(src)
    await selectionChange()
    const btn = button()!
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 60, 24))
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    // below = selection bottom 120 + gap 8 = 128, clamped to composer.top 150 -
    // button height 24 = 126 (without the composer cap it would sit at 128).
    expect(btn.style.top).toBe('126px')
    expect(btn.style.visibility).toBe('visible')
  })
})
