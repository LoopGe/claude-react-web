// @vitest-environment happy-dom
// Branch-order tests for useRecapSettle — the settle trigger depends on
// telling a user close (recap data stays) apart from a server invalidation
// (recap data gone), and on cancelling mid-flight when /clear starts or the
// window reopens before the restart chain fires.

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRecapSettle } from './useRecapSettle'

/** Wait long enough for a full double-rAF restart chain to have fired (or
 *  demonstrably not fired) under happy-dom's timer-driven rAF. Generous:
 *  under parallel-suite load a single frame can take far longer than the
 *  nominal 16ms. */
const settleFrames = () => new Promise((resolve) => setTimeout(resolve, 250))
// Positive assertions ride waitFor's retry loop; give it headroom too — a
// loaded runner must not turn a correct trigger into a flaky failure.
const SETTLE_WAIT = { timeout: 4000 }

type Props = { open: boolean; hasRecap: boolean; clearing: boolean }

function renderSettle(initial: Props) {
  return renderHook(({ open, hasRecap, clearing }: Props) => useRecapSettle(open, hasRecap, clearing), {
    initialProps: initial,
  })
}

describe('useRecapSettle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('plays the settle on a user close (recap data stays on the session)', async () => {
    const { result, rerender } = renderSettle({ open: true, hasRecap: true, clearing: false })
    await act(async () => {
      rerender({ open: false, hasRecap: true, clearing: false })
    })
    await waitFor(() => expect(result.current.settleActive).toBe(true), SETTLE_WAIT)
  })

  it('does not settle on a server invalidation (recap data gone with the close)', async () => {
    const { result, rerender } = renderSettle({ open: true, hasRecap: true, clearing: false })
    await act(async () => {
      rerender({ open: false, hasRecap: false, clearing: false })
    })
    await settleFrames()
    expect(result.current.settleActive).toBe(false)
  })

  it('cancels a mid-flight settle when /clear starts', async () => {
    const { result, rerender } = renderSettle({ open: true, hasRecap: true, clearing: false })
    await act(async () => {
      rerender({ open: false, hasRecap: true, clearing: false })
    })
    await waitFor(() => expect(result.current.settleActive).toBe(true), SETTLE_WAIT)
    await act(async () => {
      rerender({ open: false, hasRecap: true, clearing: true })
    })
    expect(result.current.settleActive).toBe(false)
    // The restart chain (if one was pending) must not resurrect the class.
    await settleFrames()
    expect(result.current.settleActive).toBe(false)
  })

  it('cuts a settle short when the server invalidates mid-flight', async () => {
    const { result, rerender } = renderSettle({ open: true, hasRecap: true, clearing: false })
    await act(async () => {
      rerender({ open: false, hasRecap: true, clearing: false })
    })
    await waitFor(() => expect(result.current.settleActive).toBe(true), SETTLE_WAIT)
    await act(async () => {
      rerender({ open: false, hasRecap: false, clearing: false })
    })
    expect(result.current.settleActive).toBe(false)
  })

  it('cancels the pending restart when the window reopens before it fires', async () => {
    const { result, rerender } = renderSettle({ open: true, hasRecap: true, clearing: false })
    // Close (schedules the double-rAF restart) then reopen before any rAF
    // fires — both in the same task, so the chain is still pending.
    await act(async () => {
      rerender({ open: false, hasRecap: true, clearing: false })
      rerender({ open: true, hasRecap: true, clearing: false })
    })
    await settleFrames()
    expect(result.current.settleActive).toBe(false)
  })

  it('animationend removes the settle class only for the settle keyframe', async () => {
    const { result, rerender } = renderSettle({ open: true, hasRecap: true, clearing: false })
    await act(async () => {
      rerender({ open: false, hasRecap: true, clearing: false })
    })
    await waitFor(() => expect(result.current.settleActive).toBe(true), SETTLE_WAIT)
    // The transcript bubbles many animations (msg-enter, reveal rows, …) —
    // those must not touch the settle class.
    act(() => result.current.handleAnimationEnd('msg-enter'))
    expect(result.current.settleActive).toBe(true)
    act(() => result.current.handleAnimationEnd('transcript-settle-up'))
    expect(result.current.settleActive).toBe(false)
  })
})
