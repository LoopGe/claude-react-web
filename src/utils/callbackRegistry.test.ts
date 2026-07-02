import { describe, expect, it, vi } from 'vitest'
import { createCallbackRegistry } from './callbackRegistry'

describe('createCallbackRegistry', () => {
  it('register makes the callback retrievable, and the returned unregister removes it', () => {
    const reg = createCallbackRegistry<() => void>()
    const fn = vi.fn()

    const unregister = reg.register('s1', fn)
    expect(reg.has('s1')).toBe(true)
    expect(reg.get('s1')).toBe(fn)

    unregister()
    expect(reg.has('s1')).toBe(false)
    expect(reg.get('s1')).toBeUndefined()
  })

  it('unregister is idempotent', () => {
    const reg = createCallbackRegistry<() => void>()
    const unregister = reg.register('s1', () => {})
    unregister()
    expect(() => unregister()).not.toThrow()
    expect(reg.has('s1')).toBe(false)
  })

  // Regression: the original App.tsx ref-Map pattern only ever `.set()` and
  // never `.delete()`, so closing a session left its callback closure pinned
  // in the Map forever. The fix returns an unregister that cleans up — but a
  // naive `delete` races with rapid re-registration: effect cleanup for the
  // OLD callback can run AFTER the NEW one registered, deleting the fresh
  // entry. The unregister must only delete when the entry is still the one it
  // registered (stale-guard).
  it('stale unregister does not clobber a newer registration (StrictMode / rapid remount safe)', () => {
    const reg = createCallbackRegistry<() => void>()
    const old = vi.fn()
    const next = vi.fn()

    const unregisterOld = reg.register('s1', old)
    // A newer mount registers before the old one's cleanup runs.
    reg.register('s1', next)
    expect(reg.get('s1')).toBe(next)

    // Old effect cleanup fires late — must NOT delete the new entry.
    unregisterOld()
    expect(reg.has('s1')).toBe(true)
    expect(reg.get('s1')).toBe(next)
  })

  it('unregister from a different key does not affect the registered key', () => {
    const reg = createCallbackRegistry<() => void>()
    const a = vi.fn()
    const b = vi.fn()

    const unregA = reg.register('s1', a)
    reg.register('s2', b)

    unregA()
    expect(reg.has('s1')).toBe(false)
    expect(reg.get('s2')).toBe(b)
  })

  it('delete removes a key directly (used on session-removed)', () => {
    const reg = createCallbackRegistry<() => void>()
    reg.register('s1', () => {})
    reg.register('s2', () => {})

    reg.delete('s1')
    expect(reg.has('s1')).toBe(false)
    expect(reg.has('s2')).toBe(true)
  })
})
