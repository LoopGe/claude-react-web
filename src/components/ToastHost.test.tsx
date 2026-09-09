// Verifies the interactive (clickable) toast paths added to ToastHost:
//   1. `onClick` without `actionLabel` → message itself becomes a button
//      that fires onClick AND auto-dismisses.
//   2. `onClick` with `actionLabel` → dedicated action button; clicking
//      it fires onClick AND auto-dismisses; the message stays plain text.
//   3. Dismiss button still dismisses without firing onClick (so a user can
//      kill the notification without triggering the jump action).

import { useEffect, useRef } from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { ToastHost, STACK_PEEK } from './ToastHost'
import { useToast } from '../hooks/useToast'

function Harness({ onMount }: { onMount: (toast: ReturnType<typeof useToast>) => void }) {
  const toast = useToast()
  // Fire exactly once, AFTER the first render commits. Calling onMount
  // during render is NOT safe: onMount pushes a toast (setToasts in the
  // provider), which re-renders this child, which calls onMount again →
  // an infinite render loop that pins the CPU and hangs the test worker.
  // A mount effect with a ref guard schedules the toast once and lets the
  // render settle. testing-library flushes effects inside act(), so the
  // toast is present by the time render() returns.
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    onMount(toast)
  }, [toast, onMount])
  return <ToastHost />
}

function setup(onMount: (toast: ReturnType<typeof useToast>) => void) {
  return render(
    <ToastProvider>
      <Harness onMount={onMount} />
    </ToastProvider>,
  )
}

afterEach(() => cleanup())

describe('ToastHost — interactive toasts', () => {
  it('whole message is clickable when onClick is set without actionLabel', async () => {
    const onClick = vi.fn()
    setup((toast) => {
      toast.info('Open session abc123', { onClick })
    })
    // The message text lives inside a <button> now, so it should be
    // queryable by role.
    const btn = screen.getByRole('button', { name: 'Open session abc123' })
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledOnce()
    // After clicking, the toast is dismissed after the exit animation.
    await waitFor(() => expect(screen.queryByText('Open session abc123')).toBeNull())
  })

  it('renders a separate action button when actionLabel is provided', async () => {
    const onClick = vi.fn()
    setup((toast) => {
      toast.error("Couldn't resume session: oops", {
        actionLabel: 'Open',
        onClick,
      })
    })
    // Message stays plain text — querying by exact text should match
    // a non-button node.
    const msg = screen.getByText("Couldn't resume session: oops")
    expect(msg.tagName).toBe('SPAN')

    const action = screen.getByRole('button', { name: 'Open' })
    fireEvent.click(action)
    expect(onClick).toHaveBeenCalledOnce()
    // Toast dismissed after the exit animation.
    await waitFor(() => expect(screen.queryByText("Couldn't resume session: oops")).toBeNull())
  })

  it('dismisses without firing onClick', async () => {
    const onClick = vi.fn()
    setup((toast) => {
      toast.info('Tap to open', { onClick })
    })
    const dismiss = screen.getByRole('button', { name: /Dismiss Info/i })
    fireEvent.click(dismiss)
    expect(onClick).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Tap to open')).toBeNull())
  })
})

describe('ToastHost — title/body hierarchy & pile stacking', () => {
  it('renders title above body when title is provided', () => {
    setup((toast) => {
      toast.info('Approve or deny: Bash', { title: 'dev-chat needs permission' })
    })
    expect(document.querySelector('.toast-title')?.textContent).toBe('dev-chat needs permission')
    expect(document.querySelector('.toast-message')?.textContent).toBe('Approve or deny: Bash')
  })

  it('renders a bare message as the main text when no title is given', () => {
    setup((toast) => {
      toast.success('Settings applied')
    })
    expect(screen.getByText('Settings applied')).toBeTruthy()
    expect(document.querySelector('.toast-title')).toBeNull()
  })

  it('stacks newest toast in front with older shells peeking below', () => {
    setup((toast) => {
      toast.info('A', { title: 'First' })
      toast.info('B', { title: 'Second' })
      toast.info('C', { title: 'Third' })
    })
    const shells = document.querySelectorAll<HTMLElement>('.toast-shell')
    expect(shells).toHaveLength(3)
    // Newest first in DOM (the front of the pile).
    expect(shells[0].querySelector('.toast-title')?.textContent).toBe('Third')
    expect(shells[1].querySelector('.toast-title')?.textContent).toBe('Second')
    expect(shells[2].querySelector('.toast-title')?.textContent).toBe('First')
    // Positioned as a pile. Cards are same height here, so tops step down
    // by STACK_PEEK (in jsdom offsetHeight is 0, which collapses the
    // measured formula to the uniform-height case).
    expect(shells[0].style.top).toBe('0px')
    expect(shells[1].style.top).toBe(`${STACK_PEEK}px`)
    expect(shells[2].style.top).toBe(`${STACK_PEEK * 2}px`)
    // Front has the highest z-index so it covers the older cards.
    const z0 = Number(getComputedStyle(shells[0]).zIndex)
    const z1 = Number(getComputedStyle(shells[1]).zIndex)
    const z2 = Number(getComputedStyle(shells[2]).zIndex)
    expect(z0).toBeGreaterThan(z1)
    expect(z1).toBeGreaterThan(z2)
  })

  it('evicts the oldest toast from the back when exceeding the cap', async () => {
    setup((toast) => {
      toast.info('A', { title: 'Oldest' })
      toast.info('B', { title: 'Middle' })
      toast.info('C', { title: 'Newest' })
      toast.info('D', { title: 'Overflow' }) // pushes over MAX_TOASTS (3)
    })
    // The oldest (A, at the back) is marked exiting / removed; the three
    // newest remain.
    await waitFor(() => {
      const titles = [...document.querySelectorAll('.toast-title')].map((n) => n.textContent)
      expect(titles).not.toContain('Oldest')
    })
    const titles = [...document.querySelectorAll('.toast-title')].map((n) => n.textContent)
    expect(titles).toEqual(['Overflow', 'Newest', 'Middle'])
  })

  it('draws the full-bg countdown fill only for auto-dismissing toasts', () => {
    setup((toast) => {
      toast.info('Timed', { title: 'Fast' })
      toast.info('Sticky', { title: 'Hold', durationMs: 0 })
    })
    const timedShell = [...document.querySelectorAll('.toast-shell')].find(
      (s) => s.querySelector('.toast-title')?.textContent === 'Fast',
    )
    const stickyShell = [...document.querySelectorAll('.toast-shell')].find(
      (s) => s.querySelector('.toast-title')?.textContent === 'Hold',
    )
    expect(timedShell?.querySelector('.toast-progress')).toBeTruthy()
    expect(stickyShell?.querySelector('.toast-progress')).toBeNull()
  })

  it('pushes a shorter back card down behind a taller front card so it still peeks', () => {
    // Simulate measured heights: two-line (title+body) cards are taller
    // than single-line cards. The front card is the NEWEST (pushed last).
    const spy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (!this.classList?.contains('toast-shell')) return 0
        return this.querySelector('.toast-title') ? 64 : 40
      })
    setup((toast) => {
      toast.info('Short back') // no title → 40px in the mock
      toast.info('Tall front', { title: 'Headline' }) // title → 64px
    })
    try {
      const shells = document.querySelectorAll<HTMLElement>('.toast-shell')
      // Front at 0; the back card is pushed down by the height difference so
      // its bottom still peeks STACK_PEEK below the front — if it were at
      // the uniform 10px it would sit wholly inside the taller front card.
      expect(shells[0].style.top).toBe('0px')
      expect(shells[1].style.top).toBe(`${64 + STACK_PEEK - 40}px`)
    } finally {
      spy.mockRestore()
    }
  })
})