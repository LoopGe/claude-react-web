import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { HandoffOverlay } from './HandoffOverlay'

afterEach(() => {
  vi.useRealTimers()
})

describe('HandoffOverlay', () => {
  it('renders the handing-off label with a 0s counter on mount', () => {
    vi.useFakeTimers()
    const { container } = render(<HandoffOverlay />)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Handing off')
    // The counter sits OUTSIDE the aria-live region: a mutating live region
    // would re-announce every second of a wait that can run tens of seconds.
    expect(status.textContent).not.toMatch(/\d+s/)
    expect(container.querySelector('.handoff-veil-elapsed')?.textContent).toBe('0s')
  })

  it('ticks the elapsed-seconds counter every second', () => {
    vi.useFakeTimers()
    const { container } = render(<HandoffOverlay />)
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(screen.getByRole('status').textContent).toContain('Handing off')
    expect(container.querySelector('.handoff-veil-elapsed')?.textContent).toBe('12s')
  })

  it('formats long waits with the app-wide formatElapsed convention', () => {
    // ≥60s switches to zero-padded m:ss (formatElapsed) — the same format
    // every other elapsed readout in the app uses (WorkingBubble, TasksPanel…).
    vi.useFakeTimers()
    const { container } = render(<HandoffOverlay />)
    act(() => {
      vi.advanceTimersByTime(75_000)
    })
    expect(container.querySelector('.handoff-veil-elapsed')?.textContent).toBe('01:15')
  })

  it('restarts the counter on a fresh mount (unmount IS the reset)', () => {
    // Chat mounts the pill conditionally per handoff; a second handoff must
    // start from 0s again, not continue the previous count.
    vi.useFakeTimers()
    const first = render(<HandoffOverlay />)
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    first.unmount()
    const { container } = render(<HandoffOverlay />)
    expect(container.querySelector('.handoff-veil-elapsed')?.textContent).toBe('0s')
  })
})
