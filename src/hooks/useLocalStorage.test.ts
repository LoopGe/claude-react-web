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
})
