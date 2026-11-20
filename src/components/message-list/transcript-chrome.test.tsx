import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { OlderHistoryFloat } from './transcript-chrome'

describe('OlderHistoryFloat', () => {
  it('stays hidden (no is-visible, no content) when idle', () => {
    const { container } = render(<OlderHistoryFloat loading={false} error={null} onRetry={() => {}} />)
    const wrap = container.querySelector('.chat-older-float')
    expect(wrap).toBeTruthy()
    // Always mounted (stable aria-live region, CSS transition both ways) —
    // but visually hidden until a page is loading or a page failed.
    expect(wrap!.classList.contains('is-visible')).toBe(false)
    expect(wrap!.textContent).not.toContain('Loading earlier messages')
  })

  it('shows the loading pill while a page is in flight', () => {
    const { container } = render(<OlderHistoryFloat loading error={null} onRetry={() => {}} />)
    const wrap = container.querySelector('.chat-older-float')!
    expect(wrap.classList.contains('is-visible')).toBe(true)
    expect(wrap.textContent).toContain('Loading earlier messages')
    // No retry affordance while the request is still running.
    expect(wrap.querySelector('.chat-older-float-retry')).toBeNull()
  })

  it('shows the failure pill with a retry action and invokes onRetry on click', () => {
    const onRetry = vi.fn()
    const { container } = render(
      <OlderHistoryFloat loading={false} error="Couldn't load earlier messages" onRetry={onRetry} />,
    )
    const wrap = container.querySelector('.chat-older-float')!
    expect(wrap.classList.contains('is-visible')).toBe(true)
    expect(wrap.textContent).toContain("Couldn't load earlier messages")
    const retry = wrap.querySelector('.chat-older-float-retry') as HTMLButtonElement | null
    expect(retry).toBeTruthy()
    fireEvent.click(retry!)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('loading takes precedence over a stale error (retry in flight → pill, no retry button)', () => {
    const { container } = render(
      <OlderHistoryFloat loading error="Couldn't load earlier messages" onRetry={() => {}} />,
    )
    const wrap = container.querySelector('.chat-older-float')!
    expect(wrap.textContent).toContain('Loading earlier messages')
    expect(wrap.textContent).not.toContain("Couldn't load earlier messages")
    expect(wrap.querySelector('.chat-older-float-retry')).toBeNull()
  })
})
