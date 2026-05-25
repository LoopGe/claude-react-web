import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLocalStorage } from './useLocalStorage'

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

  it('cross-tab storage events are gated by the validator', () => {
    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string')
    const { result } = renderHook(() =>
      useLocalStorage<string[]>('xtab-validated', ['initial'], { validate: isStringArray }),
    )

    // Another tab wrote garbage. Our hook should reject it and fall back
    // to `initial` rather than poison its React state.
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'xtab-validated',
          newValue: JSON.stringify({ not: 'an array' }),
        }),
      )
    })

    expect(result.current[0]).toEqual(['initial'])
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
})
