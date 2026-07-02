import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChatEmptyState } from './ChatEmptyState'

describe('ChatEmptyState easter-egg trigger', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); cleanup() })

  it('renders the title and icon with no prop', () => {
    render(<ChatEmptyState />)
    expect(screen.getByText('Start a conversation')).toBeTruthy()
    expect(document.querySelector('.chat-empty-icon')).toBeTruthy()
  })

  it('calls onUnlockEasterEgg after 3 rapid clicks', () => {
    const onUnlock = vi.fn()
    render(<ChatEmptyState onUnlockEasterEgg={onUnlock} />)
    const icon = document.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    fireEvent.click(icon)
    fireEvent.click(icon)
    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it('does NOT unlock when clicks are slower than 800ms', () => {
    const onUnlock = vi.fn()
    render(<ChatEmptyState onUnlockEasterEgg={onUnlock} />)
    const icon = document.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    vi.advanceTimersByTime(900)
    fireEvent.click(icon)
    vi.advanceTimersByTime(900)
    fireEvent.click(icon)
    expect(onUnlock).not.toHaveBeenCalled()
  })

  it('resets the count after a slow gap so a later triple-click still unlocks', () => {
    const onUnlock = vi.fn()
    render(<ChatEmptyState onUnlockEasterEgg={onUnlock} />)
    const icon = document.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    vi.advanceTimersByTime(900) // chain breaks
    fireEvent.click(icon)
    fireEvent.click(icon)
    fireEvent.click(icon)
    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it('drives the bounce via the Web Animations API on each click', () => {
    // The bounce is played through `el.animate` (WAAPI) rather than a toggled
    // CSS class, so it lives outside the CSS `animation` cascade and cannot
    // restart the `chat-empty-item-in` entrance (the old class-toggle approach
    // played two animations per click: the bounce, then a spurious entrance
    // replay). jsdom doesn't run animations, so we assert the call itself: each
    // click invokes animate once, and a rapid re-click cancels the prior run
    // before starting a fresh one.
    render(<ChatEmptyState onUnlockEasterEgg={vi.fn()} />)
    const icon = document.querySelector('.chat-empty-icon') as HTMLElement
    const cancel = vi.fn()
    const animateSpy = vi.fn(() => ({ cancel }) as unknown as Animation)
    ;(icon as unknown as { animate: typeof animateSpy }).animate = animateSpy

    fireEvent.click(icon)
    expect(animateSpy).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()

    // A second rapid click cancels the in-flight bounce, then re-triggers.
    fireEvent.click(icon)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(animateSpy).toHaveBeenCalledTimes(2)
  })
})
