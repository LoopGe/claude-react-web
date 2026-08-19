import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useHeldModifiers } from './useHeldModifiers'

function fire(key: string, opts: Partial<KeyboardEventInit> = {}, type: 'keydown' | 'keyup' = 'keydown') {
  window.dispatchEvent(new KeyboardEvent(type, { key, ...opts }))
}

describe('useHeldModifiers', () => {
  it('tracks Ctrl while held and clears on release', () => {
    const { result } = renderHook(() => useHeldModifiers())
    act(() => fire('Control', { ctrlKey: true }))
    expect(result.current.ctrlOrMeta).toBe(true)
    act(() => fire('Control', { ctrlKey: false }, 'keyup'))
    expect(result.current.ctrlOrMeta).toBe(false)
  })

  it('tracks Meta (Cmd) on Mac as ctrlOrMeta', () => {
    const { result } = renderHook(() => useHeldModifiers())
    act(() => fire('Meta', { metaKey: true }))
    expect(result.current.ctrlOrMeta).toBe(true)
    act(() => fire('Meta', { metaKey: false }, 'keyup'))
    expect(result.current.ctrlOrMeta).toBe(false)
  })

  it('tracks Alt while held and clears on release', () => {
    const { result } = renderHook(() => useHeldModifiers())
    act(() => fire('Alt', { altKey: true }))
    expect(result.current.alt).toBe(true)
    act(() => fire('Alt', { altKey: false }, 'keyup'))
    expect(result.current.alt).toBe(false)
  })

  it('keeps the hint while a second key is pressed inside the modifier', () => {
    const { result } = renderHook(() => useHeldModifiers())
    act(() => fire('Control', { ctrlKey: true }))
    act(() => fire('1', { ctrlKey: true }))
    expect(result.current.ctrlOrMeta).toBe(true)
    act(() => fire('Control', { ctrlKey: false }, 'keyup'))
    expect(result.current.ctrlOrMeta).toBe(false)
  })

  it('stays idle through plain typing', () => {
    const { result } = renderHook(() => useHeldModifiers())
    act(() => fire('a'))
    act(() => fire('b'))
    expect(result.current).toEqual({ ctrlOrMeta: false, alt: false })
  })

  it('resets both flags on window blur', () => {
    const { result } = renderHook(() => useHeldModifiers())
    act(() => fire('Alt', { altKey: true }))
    expect(result.current.alt).toBe(true)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current).toEqual({ ctrlOrMeta: false, alt: false })
  })

  it('removes listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useHeldModifiers())
    unmount()
    // Every listener registered in the effect must be torn down — otherwise
    // a leaked keydown handler would keep writing state after unmount.
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('keyup', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('blur', expect.any(Function))
    removeSpy.mockRestore()
  })
})
