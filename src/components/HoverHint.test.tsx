import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { HoverHint } from './HoverHint'

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

describe('HoverHint', () => {
  it('shows its label on hover without wrapping the trigger', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <HoverHint label="Hint text">
          <button type="button">Trigger</button>
        </HoverHint>,
      )
      const button = container.querySelector('button')!
      // The old Tooltip wrapper is what caused the per-surface layout hacks.
      expect(container.querySelector('.tt-wrap')).toBeNull()
      expect(button.getAttribute('title')).toBeNull()
      fireEvent.pointerEnter(button)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      const pop = document.querySelector('.hover-pop')
      expect(pop?.getAttribute('role')).toBe('tooltip')
      expect(pop?.textContent).toBe('Hint text')
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves the trigger element and its handlers', () => {
    const onClick = vi.fn()
    const { container } = render(
      <HoverHint label="Hint">
        <button type="button" onClick={onClick}>Trigger</button>
      </HoverHint>,
    )
    fireEvent.click(container.querySelector('button')!)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('merges an existing child ref with the anchor ref', () => {
    const childRef = createRef<HTMLButtonElement>()
    render(
      <HoverHint label="Hint">
        <button type="button" ref={childRef}>Trigger</button>
      </HoverHint>,
    )
    expect(childRef.current).toBeInstanceOf(HTMLButtonElement)
  })

  it('renders nothing while disabled', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <HoverHint label="Hint" disabled>
          <button type="button">Trigger</button>
        </HoverHint>,
      )
      fireEvent.pointerEnter(container.querySelector('button')!)
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(document.querySelector('.hover-pop')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})