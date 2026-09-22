// Verifies `closeByTag` — the programmatic dismiss path used when a
// permission/question is resolved and the lingering `requireInteraction`
// OS notification must go away.
//
// Two surfaces to cover:
//   - Service Worker notifications (shown via `registration.showNotification`)
//     are closed through `registration.getNotifications({ tag })`.
//   - Plain `new Notification()` fallbacks (SW unavailable) are closed from a
//     tag → Notification map that `notify()` populates.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { RefObject } from 'react'

import { useNotifications } from './useNotifications'

// ── Notification stub ────────────────────────────────────────────────
// happy-dom ships a Notification impl; replace it with a spy-friendly class
// so we can assert `close()` and capture constructed instances.
class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
  static instances: FakeNotification[] = []
  onclick: (() => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  // Mirror the spec: close() queues the close event. Firing it inline
  // exercises the onclose/map-eviction interaction the production code
  // relies on (and would catch an identity check that runs against a map
  // already overwritten by a replacement).
  close = vi.fn(() => {
    this.onclose?.()
  })
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this)
  }
}

function stubNotification(permission: NotificationPermission = 'granted') {
  FakeNotification.permission = permission
  FakeNotification.instances = []
  FakeNotification.requestPermission = vi.fn(async () => permission as NotificationPermission)
  vi.stubGlobal('Notification', FakeNotification)
}

function makeSwReg(getNotifications: () => Promise<Array<{ close: () => void }>>) {
  return {
    current: {
      active: { postMessage: vi.fn() },
      getNotifications: vi.fn(getNotifications),
    } as unknown as ServiceWorkerRegistration,
  } as RefObject<ServiceWorkerRegistration | null>
}

describe('useNotifications.closeByTag', () => {
  beforeEach(() => {
    localStorage.clear()
    stubNotification('granted')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('closes every Service Worker notification matching the tag', async () => {
    const n1 = { close: vi.fn() }
    const n2 = { close: vi.fn() }
    const getNotifications = vi.fn(async () => [n1, n2])
    const swRegRef = makeSwReg(getNotifications)

    const { result } = renderHook(() => useNotifications({ swRegRef }))
    // Enable the master switch — already-granted permission skips the
    // request flow and flips `enabled` on (plus a test notification).
    await act(async () => {
      await result.current.toggle(true)
    })
    await act(async () => {
      await result.current.closeByTag('s1:perm')
    })

    expect(getNotifications).toHaveBeenCalledWith({ tag: 's1:perm' })
    expect(n1.close).toHaveBeenCalledTimes(1)
    expect(n2.close).toHaveBeenCalledTimes(1)
  })

  it('closes a plain fallback notification created by notify() and drops it from the map', async () => {
    const { result } = renderHook(() => useNotifications())
    await act(async () => {
      await result.current.toggle(true)
    })
    act(() => {
      result.current.notify({ title: 'needs permission', tag: 's2:perm' })
    })
    expect(FakeNotification.instances).toHaveLength(2) // toggle's test notif + ours
    const target = FakeNotification.instances[1]!

    await act(async () => {
      await result.current.closeByTag('s2:perm')
    })
    expect(target.close).toHaveBeenCalledTimes(1)

    // Second close is a no-op — the entry is gone from the map and must
    // not throw or double-close.
    await act(async () => {
      await result.current.closeByTag('s2:perm')
    })
    expect(target.close).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for an unknown tag', async () => {
    const getNotifications = vi.fn(async () => [])
    const swRegRef = makeSwReg(getNotifications)
    const { result } = renderHook(() => useNotifications({ swRegRef }))
    await act(async () => {
      await result.current.toggle(true)
    })
    await expect(
      act(async () => {
        await result.current.closeByTag('nope')
      }),
    ).resolves.toBeUndefined()
    expect(getNotifications).toHaveBeenCalledWith({ tag: 'nope' })
  })

  it('ignores untagged notify() calls (nothing to close later)', async () => {
    const { result } = renderHook(() => useNotifications())
    await act(async () => {
      await result.current.toggle(true)
    })
    act(() => {
      result.current.notify({ title: 'turn complete' }) // no tag
    })
    // closeByTag with any tag must not close the untagged notification.
    await act(async () => {
      await result.current.closeByTag('s1')
    })
    const untagged = FakeNotification.instances[1]!
    expect(untagged.close).not.toHaveBeenCalled()
  })

  it('closes the previous plain notification when the same tag is reused', async () => {
    const { result } = renderHook(() => useNotifications())
    await act(async () => {
      await result.current.toggle(true)
    })
    act(() => {
      result.current.notify({ title: 'first', tag: 's1:perm', requireInteraction: true })
    })
    const first = FakeNotification.instances[1]!
    act(() => {
      result.current.notify({ title: 'second', tag: 's1:perm', requireInteraction: true })
    })
    const second = FakeNotification.instances[2]!
    // The first is now unreachable via the map — it must have been closed
    // at replace time, otherwise it can never be dismissed.
    expect(first.close).toHaveBeenCalledTimes(1)
    // And closeByTag still reaches the current one.
    await act(async () => {
      await result.current.closeByTag('s1:perm')
    })
    expect(second.close).toHaveBeenCalledTimes(1)
  })

  it('evicts the map entry when the notification closes on its own', async () => {
    const { result } = renderHook(() => useNotifications())
    await act(async () => {
      await result.current.toggle(true)
    })
    act(() => {
      result.current.notify({ title: 'temp', tag: 's1' })
    })
    const n = FakeNotification.instances[1]!
    // Simulate the browser closing it (user dismiss / auto-hide).
    act(() => {
      n.onclose?.()
    })
    // closeByTag must no-op — the entry is gone and must not double-close.
    await act(async () => {
      await result.current.closeByTag('s1')
    })
    expect(n.close).not.toHaveBeenCalled()
  })

  it('continues closing remaining SW notifications when one close() throws', async () => {
    const n1 = { close: vi.fn(() => { throw new Error('detached') }) }
    const n2 = { close: vi.fn() }
    const getNotifications = vi.fn(async () => [n1, n2])
    const swRegRef = makeSwReg(getNotifications)

    const { result } = renderHook(() => useNotifications({ swRegRef }))
    await act(async () => {
      await result.current.toggle(true)
    })
    await act(async () => {
      await result.current.closeByTag('s1:perm')
    })
    expect(n1.close).toHaveBeenCalledTimes(1)
    // The second must still be closed despite the first throwing.
    expect(n2.close).toHaveBeenCalledTimes(1)
  })

  it('does not close a notification that reused the tag while closeByTag was awaiting', async () => {
    let resolveGet!: (v: Array<{ close: () => void }>) => void
    const stale = { close: vi.fn() }
    const fresh = { close: vi.fn() }
    const getNotifications = vi.fn(
      () => new Promise<Array<{ close: () => void }>>((r) => { resolveGet = r }),
    )
    const swRegRef = makeSwReg(getNotifications)

    const { result } = renderHook(() => useNotifications({ swRegRef }))
    await act(async () => {
      await result.current.toggle(true)
    })

    // Start closeByTag — it suspends on getNotifications.
    let closePromise!: Promise<void>
    act(() => {
      closePromise = result.current.closeByTag('s1:perm')
    })
    // A NEW permission notification reuses the tag while the close is in flight.
    act(() => {
      result.current.notifyWithActions({
        title: 'new perm',
        tag: 's1:perm',
        requireInteraction: true,
        actions: [{ action: 'allow', title: 'Allow' }],
        data: { permissionId: 'p2' },
      })
    })
    // Now the deferred getNotifications resolves. Report BOTH — the stale
    // one the caller wants gone and the fresh one that reused the tag. The
    // epoch guard must skip the whole batch (closing either would be wrong:
    // `fresh` is the new request, and the `stale` handle is ambiguous after
    // the same-tag replace).
    await act(async () => {
      resolveGet([stale, fresh])
      await closePromise
    })
    expect(stale.close).not.toHaveBeenCalled()
    expect(fresh.close).not.toHaveBeenCalled()
  })

  it('notify() reports whether it actually displayed (false when disabled)', async () => {
    const { result } = renderHook(() => useNotifications())
    // Master switch is off by default — notify must no-op and say so.
    let shown!: boolean
    act(() => {
      shown = result.current.notify({ title: 'x', tag: 's1:perm' })
    })
    expect(shown).toBe(false)
    expect(FakeNotification.instances).toHaveLength(0)

    await act(async () => {
      await result.current.toggle(true)
    })
    act(() => {
      shown = result.current.notify({ title: 'x', tag: 's1:perm' })
    })
    expect(shown).toBe(true)
  })

  it('notifyWithActions falls back to plain notify() when SW postMessage throws', async () => {
    const postMessage = vi.fn(() => { throw new Error('InvalidStateError') })
    const swRegRef = {
      current: {
        active: { postMessage },
        getNotifications: vi.fn(async () => []),
      } as unknown as ServiceWorkerRegistration,
    } as RefObject<ServiceWorkerRegistration | null>

    const { result } = renderHook(() => useNotifications({ swRegRef }))
    await act(async () => {
      await result.current.toggle(true)
    })
    let shown!: boolean
    act(() => {
      shown = result.current.notifyWithActions({
        title: 'needs permission',
        tag: 's1:perm',
        requireInteraction: true,
        actions: [{ action: 'allow', title: 'Allow' }],
        data: { permissionId: 'p1' },
      })
    })
    expect(postMessage).toHaveBeenCalledTimes(1)
    // Fell back to a plain Notification so the alert is not lost.
    expect(shown).toBe(true)
    expect(FakeNotification.instances.length).toBeGreaterThan(0)
  })

  it('notifyWithActions SW success closes a prior plain notification under the same tag', async () => {
    // First show falls back to plain (SW not active yet).
    const postMessage = vi.fn()
    const swRegRef = {
      current: {
        active: null, // inactive → plain fallback
        getNotifications: vi.fn(async () => []),
      } as unknown as ServiceWorkerRegistration,
    } as RefObject<ServiceWorkerRegistration | null>
    const { result } = renderHook(() => useNotifications({ swRegRef }))
    await act(async () => {
      await result.current.toggle(true)
    })
    act(() => {
      result.current.notifyWithActions({
        title: 'first',
        tag: 's1:perm',
        requireInteraction: true,
        actions: [{ action: 'allow', title: 'Allow' }],
        data: { permissionId: 'p1' },
      })
    })
    const plain = FakeNotification.instances[1]!

    // SW becomes active; next show takes the SW path.
    ;(swRegRef.current as unknown as { active: unknown }).active = { postMessage }
    act(() => {
      result.current.notifyWithActions({
        title: 'second',
        tag: 's1:perm',
        requireInteraction: true,
        actions: [{ action: 'allow', title: 'Allow' }],
        data: { permissionId: 'p2' },
      })
    })
    expect(postMessage).toHaveBeenCalledTimes(1)
    // The stale plain fallback must not linger beside the SW toast.
    expect(plain.close).toHaveBeenCalledTimes(1)
  })

  it('notifyWithActions SW→plain fallback closes a prior SW notification under the same tag', async () => {
    // First show goes through SW successfully.
    const staleSw = { close: vi.fn() }
    const postMessage = vi.fn()
    const getNotifications = vi.fn(async () => [staleSw])
    const swRegRef = {
      current: {
        active: { postMessage },
        getNotifications,
      } as unknown as ServiceWorkerRegistration,
    } as RefObject<ServiceWorkerRegistration | null>
    const { result } = renderHook(() => useNotifications({ swRegRef }))
    await act(async () => {
      await result.current.toggle(true)
    })
    act(() => {
      result.current.notifyWithActions({
        title: 'pA',
        tag: 's1:perm',
        requireInteraction: true,
        actions: [{ action: 'allow', title: 'Allow' }],
        data: { permissionId: 'pA' },
      })
    })

    // SW dies (update cycle) — postMessage now throws.
    postMessage.mockImplementation(() => { throw new Error('InvalidStateError') })
    act(() => {
      result.current.notifyWithActions({
        title: 'pB',
        tag: 's1:perm',
        requireInteraction: true,
        actions: [{ action: 'allow', title: 'Allow' }],
        data: { permissionId: 'pB' },
      })
    })
    // Fell back to a plain Notification…
    expect(FakeNotification.instances.length).toBeGreaterThan(1)
    // …and the stale SW toast (pA's superseded buttons) is torn down.
    await act(async () => {
      await Promise.resolve()
    })
    expect(staleSw.close).toHaveBeenCalledTimes(1)
  })
})
