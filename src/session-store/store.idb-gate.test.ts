// The subscribe gate must not be hostage to a hung IndexedDB open.
//
// `openDb()` can stay pending indefinitely: when another tab holds an older
// DB version, the upgrade is `blocked` — the callback is informational and the
// underlying promise is not cancellable — so `initIdb()` never settles. The
// store's `idbReady` flag gates useChatStream's WS subscribe, so an unbounded
// wait would leave the panel with NO subscription at all (a blank transcript),
// which is strictly worse than losing the IDB cache. This file pins the bound.

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A never-resolving open stands in for the blocked-upgrade case.
const { hangingOpenDb } = vi.hoisted(() => ({
  hangingOpenDb: vi.fn(() => new Promise<never>(() => {})),
}))
vi.mock('./idb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./idb')>()),
  openDb: hangingOpenDb,
}))

import { SessionStore } from './store'

describe('SessionStore: the IDB gate is bounded', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hangingOpenDb.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles idbReady after the timeout when the IDB open never resolves', async () => {
    const store = new SessionStore('s-hung-idb')
    expect(store.getSnapshot().idbReady).toBe(false)

    // Advance past the bound: the gate opens even though the open is hung.
    await vi.advanceTimersByTimeAsync(2100)
    expect(store.getSnapshot().idbReady).toBe(true)
    await store.idbReady
  })

  it('settles immediately (and clears the timer) when the IDB open resolves', async () => {
    const store = new SessionStore('s-fast-idb')
    await vi.runAllTimersAsync()
    expect(store.getSnapshot().idbReady).toBe(true)
    // No timer left armed: the settle path cleared it.
    expect(vi.getTimerCount()).toBe(0)
  })
})
