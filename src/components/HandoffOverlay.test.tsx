import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { HandoffOverlay } from './HandoffOverlay'

afterEach(() => {
  vi.useRealTimers()
})

const noop = async () => true

describe('HandoffOverlay', () => {
  it('renders the handing-off label with a 0s counter on mount', () => {
    vi.useFakeTimers()
    const { container } = render(<HandoffOverlay onCancel={noop} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Handing off')
    // The counter sits OUTSIDE the aria-live region: a mutating live region
    // would re-announce every second of a wait that can run minutes.
    expect(status.textContent).not.toMatch(/\d+s/)
    expect(container.querySelector('.handoff-veil-elapsed')?.textContent).toBe('0s')
  })

  it('ticks the elapsed-seconds counter every second', () => {
    vi.useFakeTimers()
    const { container } = render(<HandoffOverlay onCancel={noop} />)
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
    const { container } = render(<HandoffOverlay onCancel={noop} />)
    act(() => {
      vi.advanceTimersByTime(75_000)
    })
    expect(container.querySelector('.handoff-veil-elapsed')?.textContent).toBe('01:15')
  })

  it('restarts the counter on a fresh mount (unmount IS the reset)', () => {
    // Chat mounts the pill conditionally per handoff; a second handoff must
    // start from 0s again, not continue the previous count.
    vi.useFakeTimers()
    const first = render(<HandoffOverlay onCancel={noop} />)
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    first.unmount()
    const { container } = render(<HandoffOverlay onCancel={noop} />)
    expect(container.querySelector('.handoff-veil-elapsed')?.textContent).toBe('0s')
  })

  it('offers a cancel button that fires onCancel once and stays disabled on success', async () => {
    // The wait can run up to ten minutes; cancel is the escape hatch. The
    // button disables during the POST and after success so a double-click
    // cannot race two cancel POSTs against the window's closing edge.
    const onCancel = vi.fn(async () => true)
    render(<HandoffOverlay onCancel={onCancel} />)
    const button = screen.getByRole('button', { name: /cancel handoff/i }) as HTMLButtonElement
    await act(async () => { fireEvent.click(button) })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('re-enables the cancel button when the cancel POST fails', async () => {
    // A failed cancel must not strand the user with a greyed-out button for
    // the rest of the wait — retry is the only escape hatch left.
    const onCancel = vi.fn(async () => false)
    render(<HandoffOverlay onCancel={onCancel} />)
    const button = screen.getByRole('button', { name: /cancel handoff/i }) as HTMLButtonElement
    await act(async () => { fireEvent.click(button) })
    expect(button.disabled).toBe(false)
    await act(async () => { fireEvent.click(button) })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
