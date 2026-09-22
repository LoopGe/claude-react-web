// Behavior for the global reconnect toast (replaces the App-level
// "Reconnecting to server..." banner):
//   1. hubStatus enters 'reconnecting'  → sticky info toast
//   2. hubStatus reaches 'online'      → dismiss sticky + success toast
//      (only 'online' — a 'connecting' retry hop is still offline)
//   3. manual ✕ (onDismiss)             → never re-push while still offline
//   4. capacity pressure                → sticky survives (ToastProvider
//      never evicts durationMs:0; covered in ToastProvider.test.tsx)
//   5. 'connecting' / plain 'online'    → silent (no episode, no toast)
//
// Only `useWsHubStatus` is mocked (no real WebSocket). ToastProvider is the
// real thing so assertions run against actual show/dismiss.

import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ToastProvider } from '../components/ToastProvider'
import { useToast, useToastList } from './useToast'
import type { WsHubStatus } from './useWsHub'

// Mutable status backed by a real subscription. A plain `() => hubStatus`
// mock returns the module-level variable but never tells React to
// re-render, so a component under test that is NOT a descendant of the
// element being bumped would silently keep its previous render — assertions
// on it would pass vacuously. useSyncExternalStore + publishStatus makes a
// status flip actually reach every subscriber.
let hubStatus: WsHubStatus = 'online'
const statusListeners = new Set<() => void>()
function publishStatus(next: WsHubStatus) {
  hubStatus = next
  statusListeners.forEach((l) => l())
}
vi.mock('./useWsHub', () => ({
  useWsHubStatus: () =>
    useSyncExternalStore(
      (cb: () => void) => {
        statusListeners.add(cb)
        return () => statusListeners.delete(cb)
      },
      () => hubStatus,
    ),
}))

// Import AFTER the mock so the hook picks up the mocked module.
import { useReconnectToasts } from './useReconnectToasts'
import { ReconnectToasts } from '../components/ReconnectToasts'

const RECONNECT_MSG = 'Reconnecting to server...'
const RECONNECTED_MSG = 'Reconnected'

type ToastApi = ReturnType<typeof useToast>

function HookOnly() {
  useReconnectToasts()
  return null
}

function Harness({
  onToasts,
  apiRef,
  rerenderRef,
  hookToggle = true,
}: {
  onToasts?: (messages: string[]) => void
  apiRef?: { current: ToastApi | null }
  rerenderRef?: { current: () => void }
  /** When false, only the list probe mounts — used to unmount the hook
   *  under a SHARED ToastProvider (unmount-cleanup coverage). */
  hookToggle?: boolean
}) {
  const toasts = useToastList()
  const api = useToast()
  const [n, setN] = useState(0)
  const [hookMounted, setHookMounted] = useState(hookToggle)

  useEffect(() => {
    if (apiRef) apiRef.current = api
    if (rerenderRef) rerenderRef.current = () => setN((x) => x + 1)
  }, [apiRef, rerenderRef, api])

  useEffect(() => {
    onToasts?.(toasts.filter((t) => !t.exiting).map((t) => t.message))
  }, [toasts, onToasts])
  return (
    <div>
      <button type="button" onClick={() => setHookMounted(false)}>
        unmount-hook
      </button>
      <button type="button" onClick={() => setHookMounted(true)}>
        remount-hook
      </button>
      {hookMounted ? <HookOnly /> : null}
      <ul data-testid="toasts" data-n={n}>
        {toasts
          .filter((t) => !t.exiting)
          .map((t) => (
            <li key={t.id} data-id={t.id}>
              {t.message}
            </li>
          ))}
      </ul>
    </div>
  )
}

function setup(opts?: { strict?: boolean; initialStatus?: WsHubStatus }) {
  hubStatus = opts?.initialStatus ?? 'online'
  let latest: string[] = []
  const apiRef: { current: ToastApi | null } = { current: null }
  const rerenderRef: { current: () => void } = { current: () => {} }
  const tree = (
    <ToastProvider>
      <Harness
        onToasts={(messages) => {
          latest = messages
        }}
        apiRef={apiRef}
        rerenderRef={rerenderRef}
      />
    </ToastProvider>
  )
  const utils = render(opts?.strict ? <StrictMode>{tree}</StrictMode> : tree)
  const messages = () => latest
  const setStatus = (s: WsHubStatus) => {
    act(() => publishStatus(s))
  }
  return { ...utils, messages, setStatus, apiRef, rerenderRef }
}

beforeEach(() => {
  hubStatus = 'online'
})

describe('useReconnectToasts', () => {
  it('shows a sticky "Reconnecting to server..." when hubStatus becomes reconnecting', () => {
    const { messages, setStatus } = setup()
    act(() => setStatus('reconnecting'))
    expect(messages()).toContain(RECONNECT_MSG)
  })

  it('stays mounted (sticky) — message still present after a no-op re-render', () => {
    const { messages, setStatus, rerenderRef } = setup()
    act(() => setStatus('reconnecting'))
    act(() => rerenderRef.current())
    expect(messages()).toContain(RECONNECT_MSG)
  })

  it('dismisses the reconnect toast and shows "Reconnected" when back online', () => {
    const { messages, setStatus } = setup()
    act(() => setStatus('reconnecting'))
    expect(messages()).toContain(RECONNECT_MSG)
    act(() => setStatus('online'))
    expect(messages()).not.toContain(RECONNECT_MSG)
    expect(messages()).toContain(RECONNECTED_MSG)
  })

  it('does not toast on initial connecting or plain online', () => {
    hubStatus = 'connecting'
    const { messages, setStatus } = setup()
    expect(messages()).toEqual([])
    act(() => setStatus('online'))
    expect(messages()).toEqual([])
  })

  it('does not toast when staying in reconnecting across re-renders', () => {
    const { messages, setStatus } = setup()
    act(() => setStatus('reconnecting'))
    const countAfterFirst = messages().filter((m) => m === RECONNECT_MSG).length
    act(() => setStatus('reconnecting'))
    expect(messages().filter((m) => m === RECONNECT_MSG)).toHaveLength(countAfterFirst)
    expect(countAfterFirst).toBe(1)
  })

  it('does not re-push after the user manually dismisses the sticky toast', () => {
    const { messages, setStatus, apiRef, rerenderRef, container } = setup()
    act(() => setStatus('reconnecting'))
    const id = container.querySelector('li[data-id]')?.getAttribute('data-id')
    expect(id).toBeTruthy()
    act(() => apiRef.current!.dismiss(id!))
    act(() => rerenderRef.current())
    expect(messages()).not.toContain(RECONNECT_MSG)
    act(() => apiRef.current!.info('something else'))
    act(() => rerenderRef.current())
    expect(messages()).not.toContain(RECONNECT_MSG)
    expect(messages()).toContain('something else')
  })

  it('keeps the sticky through a connecting retry hop and only announces recovery on online', () => {
    const { messages, setStatus } = setup()
    act(() => setStatus('reconnecting'))
    act(() => setStatus('connecting'))
    expect(messages()).toContain(RECONNECT_MSG)
    expect(messages()).not.toContain(RECONNECTED_MSG)
    act(() => setStatus('online'))
    expect(messages()).not.toContain(RECONNECT_MSG)
    expect(messages()).toContain(RECONNECTED_MSG)
  })

  it('programmatic dismiss on reconnect does not poison the next episode', () => {
    const { messages, setStatus } = setup()
    act(() => setStatus('reconnecting'))
    act(() => setStatus('online'))
    expect(messages()).toContain(RECONNECTED_MSG)
    act(() => setStatus('reconnecting'))
    expect(messages().filter((m) => m === RECONNECT_MSG).length).toBeGreaterThan(0)
  })

  it('shows exactly one toast under StrictMode mount-while-reconnecting', () => {
    const { messages } = setup({ strict: true, initialStatus: 'reconnecting' })
    expect(messages().filter((m) => m === RECONNECT_MSG)).toHaveLength(1)
  })

  it('unmounting the hook while offline dismisses the sticky (shared provider)', () => {
    const { messages, setStatus } = setup()
    act(() => setStatus('reconnecting'))
    expect(messages()).toContain(RECONNECT_MSG)

    // Unmount ONLY the hook, under the same ToastProvider the list reads.
    act(() => {
      screen.getByRole('button', { name: 'unmount-hook' }).click()
    })
    expect(messages()).not.toContain(RECONNECT_MSG)

    // Remount offline: exactly one sticky — the cleanup must have
    // dismissed the first instance's, or we'd see an orphan plus a new one.
    act(() => {
      screen.getByRole('button', { name: 'remount-hook' }).click()
    })
    expect(messages().filter((m) => m === RECONNECT_MSG)).toHaveLength(1)
  })
})

describe('ReconnectToasts live region', () => {
  function renderLive(opts?: { initialStatus?: WsHubStatus }) {
    hubStatus = opts?.initialStatus ?? 'online'
    const rerenderRef: { current: () => void } = { current: () => {} }
    render(
      <ToastProvider>
        <ReconnectToasts />
        <Harness rerenderRef={rerenderRef} />
      </ToastProvider>,
    )
    const live = document.querySelector('[role="status"]')
    expect(live).toBeTruthy()
    const setStatus = (s: WsHubStatus) => {
      act(() => publishStatus(s))
    }
    const rerender = () => act(() => rerenderRef.current())
    return { live: live!, setStatus, rerender }
  }

  it('mutates the always-mounted region for outage AND recovery', () => {
    // ToastHost inserts nodes with text already present (unreliable for
    // some SR/browser combos). This region must stay mounted and only
    // change its text — and it must carry "Reconnected" too, not just
    // the outage string.
    const { live, setStatus } = renderLive()
    expect(live.textContent).toBe('')

    setStatus('reconnecting')
    expect(live.textContent).toBe(RECONNECT_MSG)

    setStatus('online')
    expect(live.textContent).toBe(RECONNECTED_MSG)
  })

  it('keeps the text stable across unrelated re-renders (no spurious SR announcement)', () => {
    // The live region must only mutate at outage/recovery boundaries.
    // Recomputing the text from a ref that an effect resets would flip
    // "Reconnected" → "" on the next unrelated render, which some SRs
    // announce as a second, empty utterance.
    const { live, setStatus, rerender } = renderLive()
    setStatus('reconnecting')
    expect(live.textContent).toBe(RECONNECT_MSG)
    rerender()
    expect(live.textContent).toBe(RECONNECT_MSG)

    setStatus('online')
    expect(live.textContent).toBe(RECONNECTED_MSG)
    rerender()
    expect(live.textContent).toBe(RECONNECTED_MSG)
    rerender()
    expect(live.textContent).toBe(RECONNECTED_MSG)
  })

  it('keeps the outage text through a connecting retry hop, then announces recovery', () => {
    const { live, setStatus } = renderLive()
    setStatus('reconnecting')
    expect(live.textContent).toBe(RECONNECT_MSG)
    // 'connecting' is still offline — the text must not clear here, or the
    // retry hop would read as a recovery.
    setStatus('connecting')
    expect(live.textContent).toBe(RECONNECT_MSG)
    setStatus('online')
    expect(live.textContent).toBe(RECONNECTED_MSG)
  })

  it('shows the outage text when the region mounts during reconnecting', () => {
    // Mount-during-reconnect: the region must carry the outage text even
    // though there was no prior render to transition from.
    const { live } = renderLive({ initialStatus: 'reconnecting' })
    expect(live.textContent).toBe(RECONNECT_MSG)
  })

  it('does not clear a prior recovery when a later hop returns to online', () => {
    // After an episode closes, the region must go quiet — no further
    // mutations at all. Clearing "Reconnected" back to '' on some later
    // non-outage online would be a second mutation, which some SRs announce
    // as an empty utterance.
    const { live, setStatus } = renderLive()
    setStatus('reconnecting')
    setStatus('online')
    expect(live.textContent).toBe(RECONNECTED_MSG)

    setStatus('connecting')
    expect(live.textContent).toBe(RECONNECTED_MSG)
    setStatus('online')
    expect(live.textContent).toBe(RECONNECTED_MSG)
  })
})
