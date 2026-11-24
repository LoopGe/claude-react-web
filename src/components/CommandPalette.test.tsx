import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { CommandPalette } from './CommandPalette'
import type { Shortcut } from '../hooks/useKeyboardShortcuts'
import { createMessageJumpTarget } from '../../shared/message-jump'
import type { MessageSearchHit } from '../../shared/search-results'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'

// The height-animation wiring (last describe) mocks the cap measure to controlled
// heights; the cap math itself is unit-tested in capped-height-measure.test.ts.
// The mock is inert (returns undefined) for the behavioral tests above, so the
// hook never tweens there.
const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

// happy-dom implements scrollIntoView natively; these tests replace it with a
// spy, and this puts the real method back so nothing leaks into other files.
const originalScrollIntoView = Element.prototype.scrollIntoView
afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView
  cleanup()
})

const shortcut = (description: string, combo: string): Shortcut => ({
  combo,
  handler: vi.fn(),
  description,
})

function setup() {
  const scrollIntoView = vi.fn()
  ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView
  const shortcuts = [
    shortcut('one', 'mod+1'),
    shortcut('two', 'mod+2'),
    shortcut('three', 'mod+3'),
  ]
  const onClose = vi.fn()
  render(
    <CommandPalette
      open
      onClose={onClose}
      shortcuts={shortcuts}
      sessions={[]}
      onSelectSession={vi.fn()}
      onSelectMessage={vi.fn()}
    />,
  )
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-palette-option]'))
  return { scrollIntoView, rows, shortcuts, onClose }
}

describe('message jump projection', () => {
  it('preserves both global and message-local match ordinals for preview navigation', () => {
    const hit: MessageSearchHit = {
      id: 's1:u1',
      sessionId: 's1',
      messageUuid: 'u1',
      messageIndex: 4,
      snippet: 'report.pdf',
      matchCount: 1,
      matchOrdinal: 7,
      messageMatchOrdinal: 0,
      lastModified: 10,
    }
    expect(createMessageJumpTarget(hit, 'report', 3)).toEqual({
      nonce: 3,
      sessionId: 's1',
      messageUuid: 'u1',
      query: 'report',
      matchOrdinal: 7,
      messageMatchOrdinal: 0,
    })
  })
})

describe('CommandPalette', () => {
  // Shared useListSelection wiring: hover only moves the highlight; the arrow
  // keys scroll the row they land on.
  it('hovers without scrolling and scrolls the row arrow navigation lands on', async () => {
    const { scrollIntoView, rows } = setup()
    await waitFor(() => expect(rows()).toHaveLength(3))
    // The mount effect scrolls row 0; only post-mount activity is under test.
    scrollIntoView.mockClear()

    fireEvent.mouseEnter(rows()[0])
    expect(rows()[0].className).toContain('selected')
    expect(scrollIntoView).not.toHaveBeenCalled()

    fireEvent.keyDown(document.querySelector('.palette-input')!, { key: 'ArrowDown' })
    expect(rows()[1].className).toContain('selected')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.instances[0]).toBe(rows()[1])
  })

  it('runs the highlighted command on Enter', async () => {
    const { rows, shortcuts, onClose } = setup()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const input = document.querySelector('.palette-input')!

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(shortcuts[1].handler).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('lists a described ctrl+` shortcut as a command with the formatted combo hint', async () => {
    // The terminal toggle's palette entry comes free from its description;
    // the hint must render the platform-fixed ctrl token, not raw lowercase.
    const platformDescriptor = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    try {
      const toggle = shortcut('Toggle terminal', 'ctrl+`')
      render(
        <CommandPalette
          open
          onClose={vi.fn()}
          shortcuts={[toggle]}
          sessions={[]}
          onSelectSession={vi.fn()}
          onSelectMessage={vi.fn()}
        />,
      )
      await waitFor(() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-palette-option]'))
        expect(rows).toHaveLength(1)
        expect(rows[0].textContent).toContain('Toggle terminal')
        expect(rows[0].querySelector('.palette-item-hint')?.textContent).toBe('Ctrl+`')
      })
      fireEvent.click(document.querySelector('[data-palette-option]')!)
      expect(toggle.handler).toHaveBeenCalled()
    } finally {
      if (platformDescriptor) Object.defineProperty(navigator, 'platform', platformDescriptor)
    }
  })

  it('omits a paletteHidden shortcut even when it has a description', async () => {
    // Capability-gated actions (e.g. the terminal toggle on an unsupported
    // host) stay registered but must not surface in the palette.
    const hidden = { ...shortcut('Toggle terminal', 'ctrl+`'), paletteHidden: true }
    const visible = shortcut('Command palette', 'mod+k')
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        shortcuts={[hidden, visible]}
        sessions={[]}
        onSelectSession={vi.fn()}
        onSelectMessage={vi.fn()}
      />,
    )
    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-palette-option]'))
      expect(rows).toHaveLength(1)
      expect(rows[0].textContent).toContain('Command palette')
      expect(rows[0].textContent).not.toContain('Toggle terminal')
    })
  })

  it('prefers paletteAction over the gated handler when present', async () => {
    // The terminal toggle's keydown handler is modal-gated; the palette must
    // invoke the unguarded paletteAction override so the row is not dead.
    const handler = vi.fn()
    const paletteAction = vi.fn()
    const toggle: Shortcut = { ...shortcut('Toggle terminal', 'ctrl+`'), handler, paletteAction }
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        shortcuts={[toggle]}
        sessions={[]}
        onSelectSession={vi.fn()}
        onSelectMessage={vi.fn()}
      />,
    )
    await waitFor(() => expect(document.querySelectorAll('[data-palette-option]')).toHaveLength(1))
    fireEvent.click(document.querySelector('[data-palette-option]')!)
    expect(paletteAction).toHaveBeenCalledOnce()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('CommandPalette height animation', () => {
  beforeEach(() => {
    measureMock.mockReset()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    stubResizeObserver()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)
  })

  afterEach(() => {
    clearResizeObserverStub()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function setupPalette() {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        shortcuts={[shortcut('one', 'mod+1'), shortcut('two', 'mod+2')]}
        sessions={[]}
        onSelectSession={vi.fn()}
        onSelectMessage={vi.fn()}
      />,
    )
  }

  it('tweens the list height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setupPalette()
    const list = document.querySelector<HTMLElement>('.palette-list')!
    const content = document.querySelector<HTMLElement>('.palette-list-content')!
    height = 300
    fireResize(content)
    expect(list.classList.contains('auto-height-animating')).toBe(true)
    expect(list.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    setupPalette()
    const list = document.querySelector<HTMLElement>('.palette-list')!
    const content = document.querySelector<HTMLElement>('.palette-list-content')!
    height = 300
    fireResize(content)
    expect(list.style.height).toBe('300px')
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      list.dispatchEvent(evt)
    })
    expect(list.classList.contains('auto-height-animating')).toBe(false)
    expect(list.style.height).toBe('')
  })
})
