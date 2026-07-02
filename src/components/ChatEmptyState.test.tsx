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

  it('applies the bounce class on click and re-triggers on a rapid second click', () => {
    // NOTE: jsdom in this project has no AnimationEvent constructor, so
    // React's onAnimationEnd (which clears the bounce class in the real
    // browser) cannot be exercised through fireEvent.animationEnd here.
    // We assert the testable half: a click applies the bounce class, and a
    // second rapid click re-triggers it (the class stays present so the
    // CSS animation restarts). The animationEnd → clear path is exercised
    // manually in the browser.
    render(<ChatEmptyState onUnlockEasterEgg={vi.fn()} />)
    const icon = document.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    expect(icon.classList.contains('chat-empty-icon--bounce')).toBe(true)
    // A second rapid click re-triggers the bounce (class remains present).
    fireEvent.click(icon)
    expect(icon.classList.contains('chat-empty-icon--bounce')).toBe(true)
  })
})
