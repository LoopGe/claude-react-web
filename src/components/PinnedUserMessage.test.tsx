import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
import { PinnedUserMessage } from './PinnedUserMessage'

// vitest runs with `globals: false`, so @testing-library/react's auto-cleanup
// never registers. Tear down between tests to avoid leaked DOM/listeners.
afterEach(() => {
  cleanup()
})

describe('PinnedUserMessage', () => {
  it('renders a pinned-user-message body button carrying the text and title', () => {
    const { container } = render(<PinnedUserMessage text="What is the plan?" onClick={() => {}} />)
    const root = container.querySelector('.pinned-user-message')
    expect(root).not.toBeNull()
    // The clickable body is a <button> inside the root <div>.
    const body = root?.querySelector('.pinned-user-message-body')
    expect(body?.tagName).toBe('BUTTON')
    expect(body?.getAttribute('title')).toBe('What is the plan?')
    // type="button" so it never submits a form.
    expect(body?.getAttribute('type')).toBe('button')
    expect(root?.querySelector('.pinned-user-message-text')?.textContent).toBe('What is the plan?')
  })

  it('applies the clearing class while a /clear is in flight', () => {
    const { container } = render(<PinnedUserMessage text="x" clearing onClick={() => {}} />)
    expect(container.querySelector('.pinned-user-message')?.className).toContain('pinned-user-message-clearing')
  })

  it('fires onClick when the body is clicked', () => {
    const onClick = vi.fn()
    const { container } = render(<PinnedUserMessage text="x" onClick={onClick} />)
    fireEvent.click(container.querySelector('.pinned-user-message-body')!)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('keeps the button mounted through the exit animation, then unmounts (AnimatePresence)', async () => {
    // Open/close motion is driven by motion.button + AnimatePresence. Smoke
    // test that AnimatePresence retains the node while exiting and removes it
    // after. The retention assertion (not just the eventual unmount) guards
    // against motion short-circuiting the exit in jsdom and unmounting
    // instantly. See the matching RecapWindow test for the same rationale.
    function Harness({ open }: { open: boolean }) {
      return (
        <AnimatePresence>
          {open && <PinnedUserMessage key="pinned" text="x" onClick={() => {}} />}
        </AnimatePresence>
      )
    }
    const { container, rerender } = render(<Harness open={true} />)
    expect(container.querySelector('.pinned-user-message')).not.toBeNull()

    rerender(<Harness open={false} />)
    expect(container.querySelector('.pinned-user-message')).not.toBeNull()

    await waitFor(() => {
      expect(container.querySelector('.pinned-user-message')).toBeNull()
    })
  })
})
