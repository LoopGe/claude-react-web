// Referential-stability tests for `useSessionCommands`.
//
// The hook memoizes one `SessionCommands` instance per `SessionStore` (a
// module-level WeakMap keyed by the store instance, not by session id string).
// Every caller for a given session — the synchronizer, message components,
// the composer — shares the SAME factory result so optimistic-delivery
// callbacks keep a stable identity across re-renders.
//
// These tests pin that contract directly: same session → same instance across
// hook re-invocations and `rerender`; different session → different instance;
// and a store that leaves and re-enters the registry gets a fresh instance
// (the WeakMap entry is GC'd when the old store is no longer retained).
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useSessionCommands } from './useSessionCommands'
import { sessionStoreRegistry } from '../session-store/registry'

afterEach(async () => {
  await sessionStoreRegistry.clear()
})

describe('useSessionCommands referential stability', () => {
  it('returns the same SessionCommands instance for the same session across calls and re-renders', () => {
    const SID = 'cmds-stable'
    const { result, rerender } = renderHook(() => useSessionCommands(SID))

    const first = result.current
    expect(first).toBe(result.current)

    // A second hook instance for the same session shares the WeakMap entry.
    const { result: second } = renderHook(() => useSessionCommands(SID))
    expect(second.current).toBe(first)

    // Re-rendering the original hook does not create a new instance.
    rerender()
    expect(result.current).toBe(first)
  })

  it('returns distinct instances for different sessions', () => {
    const a = renderHook(() => useSessionCommands('cmds-a'))
    const b = renderHook(() => useSessionCommands('cmds-b'))
    expect(a.result.current).not.toBe(b.result.current)
  })

  it('creates a fresh instance after the store is deleted and re-created', async () => {
    const SID = 'cmds-recreated'
    const { result } = renderHook(() => useSessionCommands(SID))
    const first = result.current

    // Delete the store from the registry — the WeakMap entry keyed on the OLD
    // SessionStore instance is now unreachable. A new getOrCreate call mints a
    // new SessionStore instance, so the next useSessionCommands call must
    // produce a different SessionCommands.
    await sessionStoreRegistry.delete(SID)

    const after = renderHook(() => useSessionCommands(SID))
    expect(after.result.current).not.toBe(first)
  })
})
