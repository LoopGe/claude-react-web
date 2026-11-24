// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useRef, useState } from 'react'
import { render, fireEvent, act } from '@testing-library/react'
import { QuoteSelectionToolbar } from './QuoteSelectionToolbar'
import { RichPromptInput, type RichPromptHandle } from './RichPromptInput'
import { QUOTE_CHIP_ATTR, QUOTE_CHIP_CLASS } from '../utils/richPromptDom'
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
  function Harness() {
    const rootRef = useRef<HTMLDivElement>(null)
    const editorRef = useRef<HTMLDivElement & RichPromptHandle>(null)
    const [value, setValue] = useState('')
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
    const chip = container.querySelector(`.${QUOTE_CHIP_CLASS}`)!
    expect(chip).not.toBeNull()
    expect(chip.getAttribute(QUOTE_CHIP_ATTR)).toBe('> select me')
    expect(button()).toBeNull()
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
})
