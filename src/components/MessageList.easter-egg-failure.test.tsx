import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'

// A failed EasterEggGame chunk (a deploy replaced its hash, the network
// dropped) must degrade to "no game" instead of taking the panel down. In its
// own file because the failure is a module mock: the lazy component's payload
// is module-level, and MessageList.test.tsx needs the real game to load.
//
// Import attempts are counted because vitest's mocker shares one callstack per
// importing module: a second import() of a factory-mocked module issued while
// the first is still in flight skips the factory and loads the REAL module. The
// test therefore lets MessageList's mount-time prefetch fail before it opens
// the game, and checks that the game's own import went through the factory.
const gameImport = vi.hoisted(() => ({ attempts: 0 }))
vi.mock('./EasterEggGame', () => {
  gameImport.attempts++
  throw new Error('Failed to fetch dynamically imported module')
})

// Real Virtuoso needs measured DOM; the empty state renders outside it.
vi.mock('react-virtuoso', () => ({
  Virtuoso: () => <div data-testid="virtuoso-mock" />,
}))

// Import AFTER the mocks.
import { MessageList } from './MessageList'
import { ErrorBoundary } from './ErrorBoundary'

describe('MessageList — easter-egg chunk failure', () => {
  it('falls back to the empty state and never reaches the panel-level boundary', async () => {
    // React reports every error a boundary catches through console.error.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const panelError = vi.fn()
    // App.tsx wraps each ChatPanel in an ErrorBoundary like this one; a
    // rejected game import used to land there and replace the whole panel
    // with "Something went wrong".
    const { container } = render(
      <ErrorBoundary onError={panelError}>
        <MessageList items={[]} />
      </ErrorBoundary>,
    )
    // The empty state's prefetch tried the chunk; let that attempt settle.
    await waitFor(() => expect(gameImport.attempts).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const icon = container.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon); fireEvent.click(icon); fireEvent.click(icon)
    // The game branch mounted and suspended on its import: the empty state is
    // gone, so the one awaited below can only be the post-rejection fallback.
    expect(container.querySelector('.chat-empty')).toBeNull()

    await waitFor(() => expect(container.querySelector('.chat-messages-empty .chat-empty')).not.toBeNull())
    expect(gameImport.attempts).toBe(2)
    expect(container.textContent).toContain('Start a conversation')
    expect(container.querySelector('.easter-egg-game')).toBeNull()
    expect(container.textContent).not.toContain('Something went wrong')
    expect(panelError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
