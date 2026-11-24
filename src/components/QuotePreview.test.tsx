import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { QuotePreview } from './QuotePreview'
import { QUOTE_CHIP_CLASS } from '../utils/richPromptDom'

// HoverPopover needs matchMedia + ResizeObserver; mirror its own test harness.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  media: '',
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}))

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []
  callback: ResizeObserverCallback
  observed: Element[] = []
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ResizeObserverMock.instances.push(this)
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  unobserve() {}
  disconnect() {}
  fire() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  ResizeObserverMock.instances = []
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('QuotePreview', () => {
  it('renders the DECODED excerpt (no > markers) with a quote mark', () => {
    const { container } = render(<QuotePreview text={'> a\n> b'} />)
    const chip = container.querySelector(`.${QUOTE_CHIP_CLASS}`)!
    expect(chip).not.toBeNull()
    const text = chip.querySelector('.quote-chip-text')!
    expect(text.textContent).toBe('a\nb')
    expect(chip.querySelector('.quote-chip-mark')).not.toBeNull()
  })

  it('is inert without a removal prop (no remove button)', () => {
    const { container } = render(<QuotePreview text="> q" />)
    expect(container.querySelector('[data-quote-remove]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('.quote-chip-marker')).not.toBeNull()
    expect(container.querySelector(`.${QUOTE_CHIP_CLASS}`)!.hasAttribute('data-removable')).toBe(false)
  })

  it('shows a remove button for the removable variant and calls onRemove on click', () => {
    const onRemove = vi.fn()
    const { container } = render(
      <QuotePreview text="> q" removal={{ label: 'Remove quote', onRemove }} />,
    )
    const chip = container.querySelector(`.${QUOTE_CHIP_CLASS}`)!
    expect(chip.hasAttribute('data-removable')).toBe(true)
    const btn = container.querySelector('button.quote-chip-remove')!
    expect(btn).not.toBeNull()
    expect(btn.getAttribute('aria-label')).toBe('Remove quote')
    fireEvent.click(btn)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('opens a full-text popover only when the excerpt is clipped', () => {
    const { container } = render(<QuotePreview text={'> a very long quoted line'} />)
    const chip = container.querySelector(`.${QUOTE_CHIP_CLASS}`)! as HTMLElement
    const source = chip.querySelector('.quote-chip-text')! as HTMLElement

    // Not clipped → hover does not open a popover.
    Object.defineProperty(source, 'scrollWidth', { value: 50, configurable: true })
    Object.defineProperty(source, 'clientWidth', { value: 100, configurable: true })
    act(() => {
      for (const o of ResizeObserverMock.instances) o.fire()
    })
    fireEvent.pointerEnter(chip)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(document.querySelector('.hover-pop')).toBeNull()

    // Clipped → the same hover opens the full-text popover.
    fireEvent.pointerLeave(chip)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    Object.defineProperty(source, 'scrollWidth', { value: 400, configurable: true })
    Object.defineProperty(source, 'clientWidth', { value: 100, configurable: true })
    act(() => {
      for (const o of ResizeObserverMock.instances) o.fire()
    })
    fireEvent.pointerEnter(chip)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    const pop = document.querySelector('.hover-pop')
    expect(pop).not.toBeNull()
    expect(pop!.textContent).toBe('a very long quoted line')
  })
})
