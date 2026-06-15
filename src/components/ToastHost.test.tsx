// Verifies the interactive (clickable) toast paths added to ToastHost:
//   1. `onClick` without `actionLabel` — message itself becomes a button
//      that fires onClick AND auto-dismisses.
//   2. `onClick` with `actionLabel` — dedicated action button; clicking
//      it fires onClick AND auto-dismisses; the message stays plain text.
//   3. Dismiss button still dismisses without firing onClick (so a user can
//      kill the notification without triggering the jump action).

import { useEffect, useRef } from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { ToastHost } from './ToastHost'
import { useToast } from '../hooks/useToast'

function Harness({ onMount }: { onMount: (toast: ReturnType<typeof useToast>) => void }) {
  const toast = useToast()
  // Fire exactly once, AFTER the first render commits. Calling onMount
  // during render is NOT safe: onMount pushes a toast (setToasts in the
  // provider), which re-renders this child, which calls onMount again ?
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