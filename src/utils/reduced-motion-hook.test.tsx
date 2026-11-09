import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setAppMotionOff,
  subscribeMotionSuppressed,
  useMotionSuppressed,
  useOsPrefersReducedMotion,
} from './reduced-motion'

afterEach(() => {
  vi.unstubAllGlobals()
  setAppMotionOff(false)
})

/** Mutable matchMedia stub: reports the OS reduced-motion state and fires the
 *  registered change listeners when it flips. */
function stubMutableOs(initial: boolean): (next: boolean) => void {
  let matches = initial
  const handlers = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('prefers-reduced-motion') ? matches : false
    },
    media: query,
    addEventListener: (_type: string, cb: () => void) => handlers.add(cb),
    removeEventListener: (_type: string, cb: () => void) => handlers.delete(cb),
  }))
  return (next: boolean) => {
    matches = next
    handlers.forEach((handler) => handler())
  }
}

describe('useMotionSuppressed', () => {
  it('re-renders when the in-app Off preset flips', () => {
    const { result } = renderHook(() => useMotionSuppressed())
    expect(result.current).toBe(false)

    act(() => setAppMotionOff(true))
    expect(result.current).toBe(true)

    act(() => setAppMotionOff(false))
    expect(result.current).toBe(false)
  })
})

describe('useOsPrefersReducedMotion', () => {
  it('tracks the OS query reactively', () => {
    const setOs = stubMutableOs(false)
    const { result } = renderHook(() => useOsPrefersReducedMotion())
    expect(result.current).toBe(false)

    act(() => setOs(true))
    expect(result.current).toBe(true)

    act(() => setOs(false))
    expect(result.current).toBe(false)
  })
})

describe('late matchMedia availability', () => {
  it('attaches the OS listener when a later subscriber arrives after matchMedia appears', () => {
    vi.stubGlobal('matchMedia', undefined)
    const first = renderHook(() => useMotionSuppressed())

    const setOs = stubMutableOs(false)
    const { result } = renderHook(() => useMotionSuppressed())

    act(() => setOs(true))
    expect(result.current).toBe(true)

    first.unmount()
  })
})

describe('MediaQueryList reuse', () => {
  it('does not allocate a new MediaQueryList on every subscriber render', () => {
    const matchMedia = vi.fn((query: string) => ({
      get matches() {
        return false
      },
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    vi.stubGlobal('matchMedia', matchMedia)

    const { rerender } = renderHook(() => useMotionSuppressed())
    const callsAfterMount = matchMedia.mock.calls.length
    rerender()
    rerender()
    expect(matchMedia.mock.calls.length).toBe(callsAfterMount)
  })
})

describe('motion-suppression notifications', () => {
  it('does not notify when the OS already suppresses motion', () => {
    stubMutableOs(true)
    const listener = vi.fn()
    const unsubscribe = subscribeMotionSuppressed(listener)

    // The effective answer (suppressed) does not change, so subscribers must
    // not re-render.
    setAppMotionOff(true)
    expect(listener).not.toHaveBeenCalled()

    unsubscribe()
  })
})
