import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLocalStorage, removeLocalStorageKey } from './useLocalStorage'

// Test-only normalizer: filters non-string entries from an array, preserving
// order; non-arrays collapse to []. Mirrors the MRU normalize policy the hook
// will be asked to apply at its three boundaries.
function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((x): x is string => typeof x === 'string')
}

beforeEach(() => {
  localStorage.clear()
})

describe('useLocalStorage', () => {
  it('returns initial value when no stored data exists', () => {
    const { result } = renderHook(() => useLocalStorage('key', 'default'))
    expect(result.current[0]).toBe('default')
  })

  it('returns stored value when localStorage has data', () => {
    localStorage.setItem('key', JSON.stringify('stored'))
    const { result } = renderHook(() => useLocalStorage('key', 'default'))
    expect(result.current[0]).toBe('stored')
  })

  it('persists new value to localStorage', () => {
    const { result } = renderHook(() => useLocalStorage('key', 'init'))
    act(() => result.current[1]('updated'))
    expect(result.current[0]).toBe('updated')
    expect(JSON.parse(localStorage.getItem('key')!)).toBe('updated')
  })

  it('supports functional update', () => {
    const { result } = renderHook(() => useLocalStorage('count', 0))
    act(() => result.current[1]((prev) => prev + 1))
    expect(result.current[0]).toBe(1)
    act(() => result.current[1]((prev) => prev + 1))
    expect(result.current[0]).toBe(2)
  })

  it('handles complex objects', () => {
    const initial = { name: 'test', items: [1, 2, 3] }
    const { result } = renderHook(() => useLocalStorage('obj', initial))
    expect(result.current[0]).toEqual(initial)

    const updated = { name: 'updated', items: [4, 5] }
    act(() => result.current[1](updated))
    expect(result.current[0]).toEqual(updated)
    expect(JSON.parse(localStorage.getItem('obj')!)).toEqual(updated)
  })

  it('handles arrays', () => {
    const { result } = renderHook(() => useLocalStorage<string[]>('arr', []))
    act(() => result.current[1](['a', 'b']))
    expect(result.current[0]).toEqual(['a', 'b'])
  })

  it('falls back to initial on corrupt localStorage data', () => {
    localStorage.setItem('bad', '{not json')
    const { result } = renderHook(() => useLocalStorage('bad', 'fallback'))
    expect(result.current[0]).toBe('fallback')
  })

  it('falls back to initial on null localStorage value', () => {
    // getItem returns null when key doesn't exist — treated as missing.
    const { result } = renderHook(() => useLocalStorage('missing', 42))
    expect(result.current[0]).toBe(42)
  })

  it('supports boolean initial value', () => {
    const { result } = renderHook(() => useLocalStorage('bool', true))
    expect(result.current[0]).toBe(true)
    act(() => result.current[1](false))
    expect(result.current[0]).toBe(false)
    expect(JSON.parse(localStorage.getItem('bool')!)).toBe(false)
  })

  it('persists value across re-renders with same key', () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useLocalStorage(key, 'init'),
      { initialProps: { key: 'shared' } },
    )
    act(() => result.current[1]('persisted'))
    rerender({ key: 'shared' })
    expect(result.current[0]).toBe('persisted')
  })

  // ── Validator ───────────────────────────────────────────────────

  it('falls back to initial when validator rejects the persisted value', () => {
    // A previous version stored an object, but this caller expects an array.
    localStorage.setItem('shape', JSON.stringify({ wrong: 'shape' }))
    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string')
    const { result } = renderHook(() =>
      useLocalStorage<string[]>('shape', [], { validate: isStringArray }),
    )
    expect(result.current[0]).toEqual([])
  })

  it('accepts valid persisted values when a validator is provided', () => {
    localStorage.setItem('valid-arr', JSON.stringify(['a', 'b']))
    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string')
    const { result } = renderHook(() =>
      useLocalStorage<string[]>('valid-arr', [], { validate: isStringArray }),
    )
    expect(result.current[0]).toEqual(['a', 'b'])
  })

  // ── Cross-instance same-tab sync (the multi-panel bug fix) ───────

  it('syncs in-process when one instance updates and another is mounted on the same key', () => {
    // Two independent hook instances backed by the same key — without
    // the in-process emitter, instance B's React state stays stale
    // until the next page load.
    const a = renderHook(() => useLocalStorage<string[]>('multi', []))
    const b = renderHook(() => useLocalStorage<string[]>('multi', []))

    act(() => a.result.current[1](['from-a']))

    expect(a.result.current[0]).toEqual(['from-a'])
    // The fix: B's React state must reflect A's write without re-mounting.
    expect(b.result.current[0]).toEqual(['from-a'])
  })

  it('still syncs when functional updates are used', () => {
    const a = renderHook(() => useLocalStorage<number>('counter', 0))
    const b = renderHook(() => useLocalStorage<number>('counter', 0))

    act(() => a.result.current[1]((prev) => prev + 1))
    act(() => a.result.current[1]((prev) => prev + 1))

    expect(b.result.current[0]).toBe(2)
  })

  it('reacts to cross-tab "storage" events on the same key', () => {
    const { result } = renderHook(() => useLocalStorage<string[]>('xtab', []))

    // Simulate another tab writing to the same key. In a real browser
    // the storage event only fires on OTHER tabs, but jsdom dispatches
    // whatever we ask it to.
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'xtab',
          newValue: JSON.stringify(['from-other-tab']),
        }),
      )
    })

    expect(result.current[0]).toEqual(['from-other-tab'])
  })

  it('ignores storage events for unrelated keys', () => {
    const { result } = renderHook(() => useLocalStorage<string>('our-key', 'a'))
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'someone-elses-key',
          newValue: JSON.stringify('intruder'),
        }),
      )
    })
    expect(result.current[0]).toBe('a')
  })

  it('drops a write that fails validation instead of reverting the whole value', () => {
    // One rejected field used to fall back to `initial`, taking the good fields
    // with it — a background image, its opacity and its remembered src all lost
    // because a single value didn't validate. The write is dropped now, loudly.
    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string')
    localStorage.setItem('gated', JSON.stringify(['keep', 'me']))
    const { result } = renderHook(() =>
      useLocalStorage<string[]>('gated', ['FACTORY'], { validate: isStringArray }),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    act(() => result.current[1]('not-an-array' as unknown as string[]))

    expect(result.current[0]).toEqual(['keep', 'me'])
    expect(localStorage.getItem('gated')).toBe('["keep","me"]')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('keeps a good local value when another tab writes garbage', () => {
    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string')
    localStorage.setItem('xtab-gate', JSON.stringify(['local', 'good']))
    const { result } = renderHook(() =>
      useLocalStorage<string[]>('xtab-gate', ['FACTORY'], { validate: isStringArray }),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'xtab-gate',
          newValue: JSON.stringify({ not: 'an array' }),
        }),
      )
    })

    expect(result.current[0]).toEqual(['local', 'good'])
    // And it must not re-persist: writing its fallback back would clobber the
    // shared key for every other tab.
    expect(localStorage.getItem('xtab-gate')).toBe('["local","good"]')
    warn.mockRestore()
  })

  // ── normalize ───────────────────────────────────────────────────

  it('normalizes initial reads, local updates, and cross-tab writes', () => {
    // Pre-seed a mixed array; normalize must filter at the read boundary.
    localStorage.setItem('norm', JSON.stringify(['keep', 42, 'also-keep']))
    const { result } = renderHook(() =>
      useLocalStorage<string[]>('norm', [], { normalize: normalizeStrings }),
    )
    expect(result.current[0]).toEqual(['keep', 'also-keep'])

    // Local update with a mixed array: normalize before persist.
    act(() => result.current[1](['x', 7, 'y'] as unknown as string[]))
    expect(result.current[0]).toEqual(['x', 'y'])
    expect(JSON.parse(localStorage.getItem('norm')!)).toEqual(['x', 'y'])

    // Cross-tab write with a mixed array: normalize on adoption.
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'norm',
          newValue: JSON.stringify(['a', 99, 'b']),
        }),
      )
    })
    expect(result.current[0]).toEqual(['a', 'b'])
  })

  // ── externalFailure: default 'ignore' on delete ─────────────────

  it('keeps the current value on delete by default', () => {
    localStorage.setItem('del-def', JSON.stringify(['a', 'b']))
    const { result } = renderHook(() =>
      useLocalStorage<string[]>('del-def', []),
    )
    expect(result.current[0]).toEqual(['a', 'b'])

    // Simulate another tab deleting the key: remove from our localStorage
    // (a real browser propagates the delete) and fire the storage event.
    localStorage.removeItem('del-def')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'del-def',
          newValue: null,
        }),
      )
    })

    // Default ignore: the mounted instance keeps its good value.
    expect(result.current[0]).toEqual(['a', 'b'])
  })

  // ── externalFailure: 'reset' on delete ──────────────────────────

  it('resets every instance on delete without re-persisting through echo', () => {
    localStorage.setItem('del-reset', JSON.stringify(['a', 'b']))
    const a = renderHook(() =>
      useLocalStorage<string[]>('del-reset', [], {
        normalize: normalizeStrings,
        externalFailure: 'reset',
      }),
    )
    const b = renderHook(() =>
      useLocalStorage<string[]>('del-reset', [], {
        normalize: normalizeStrings,
        externalFailure: 'reset',
      }),
    )

    // Spy AFTER mount so initial persist echoes are not counted.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    // Other tab deletes the key → propagates to our localStorage + event.
    localStorage.removeItem('del-reset')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'del-reset',
          newValue: null,
        }),
      )
    })

    expect(a.result.current[0]).toEqual([])
    expect(b.result.current[0]).toEqual([])
    // The deleted key must stay deleted: no instance echoes '[]' back.
    expect(localStorage.getItem('del-reset')).toBeNull()
    expect(setItemSpy).not.toHaveBeenCalled()
    setItemSpy.mockRestore()
  })

  it('resets on corrupt external JSON without overwriting the corrupt key', () => {
    localStorage.setItem('corrupt-ext', JSON.stringify(['good']))
    const { result } = renderHook(() =>
      useLocalStorage<string[]>('corrupt-ext', [], {
        normalize: normalizeStrings,
        externalFailure: 'reset',
      }),
    )
    expect(result.current[0]).toEqual(['good'])

    // Other tab writes corrupt JSON → lands in our localStorage + event.
    localStorage.setItem('corrupt-ext', '{bad json')
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'corrupt-ext',
          newValue: '{bad json',
        }),
      )
    })

    expect(result.current[0]).toEqual([])
    // The corrupt value written by the other tab must remain; our reset
    // must not echo '[]' back over it.
    expect(localStorage.getItem('corrupt-ext')).toBe('{bad json')
    expect(setItemSpy).not.toHaveBeenCalled()
    setItemSpy.mockRestore()
  })

  it('persists a real update after an external reset even if an instance bailed out', () => {
    localStorage.setItem('reset-then-update', JSON.stringify(['old']))
    const { result } = renderHook(() =>
      useLocalStorage<string[]>('reset-then-update', [], {
        normalize: normalizeStrings,
        externalFailure: 'reset',
      }),
    )
    expect(result.current[0]).toEqual(['old'])

    localStorage.removeItem('reset-then-update')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'reset-then-update',
          newValue: null,
        }),
      )
    })
    expect(result.current[0]).toEqual([])

    // A real user update must release suppression and persist normally.
    act(() => result.current[1](['fresh']))
    expect(result.current[0]).toEqual(['fresh'])
    expect(JSON.parse(localStorage.getItem('reset-then-update')!)).toEqual(['fresh'])
  })

  // ── removeLocalStorageKey: same-tab deletion notification ───────

  it('removeLocalStorageKey resets opted-in mounted instances immediately', () => {
    localStorage.setItem('rmkey', JSON.stringify(['data']))
    const a = renderHook(() =>
      useLocalStorage<string[]>('rmkey', [], {
        normalize: normalizeStrings,
        externalFailure: 'reset',
      }),
    )
    const b = renderHook(() =>
      useLocalStorage<string[]>('rmkey', [], {
        normalize: normalizeStrings,
        externalFailure: 'reset',
      }),
    )

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    // No StorageEvent is dispatched for the current tab — the helper must
    // notify same-tab listeners directly via the deletion sentinel.
    act(() => {
      removeLocalStorageKey('rmkey')
    })

    expect(a.result.current[0]).toEqual([])
    expect(b.result.current[0]).toEqual([])
    expect(localStorage.getItem('rmkey')).toBeNull()
    expect(setItemSpy).not.toHaveBeenCalled()
    setItemSpy.mockRestore()

    // A subsequent real update writes only the new value.
    act(() => a.result.current[1](['after-reset']))
    expect(a.result.current[0]).toEqual(['after-reset'])
    expect(b.result.current[0]).toEqual(['after-reset'])
    expect(JSON.parse(localStorage.getItem('rmkey')!)).toEqual(['after-reset'])
  })

  // ── normalize + multi-instance: no notification loop ────────────

  it('synchronizes normalized arrays between same-tab instances without a notification loop', () => {
    const a = renderHook(() =>
      useLocalStorage<string[]>('sync-norm', [], {
        normalize: normalizeStrings,
      }),
    )
    const b = renderHook(() =>
      useLocalStorage<string[]>('sync-norm', [], {
        normalize: normalizeStrings,
      }),
    )

    // Mixed-array update: A normalizes before persist, B receives the
    // already-normalized value via same-tab echo (no re-normalize on echo,
    // which would loop setValue→notify→setValue with fresh array refs).
    act(() => a.result.current[1](['x', 9, 'y'] as unknown as string[]))

    expect(a.result.current[0]).toEqual(['x', 'y'])
    expect(b.result.current[0]).toEqual(['x', 'y'])
    // The test reaching this assertion at all is the loop check: a
    // normalize-on-echo path would hit React's maximum update depth.
  })
})
