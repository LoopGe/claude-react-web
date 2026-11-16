import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useLiquidGlass } from './useLiquidGlass'
import { applyTransparency, TRANSPARENCY_KEY } from '../utils/theme'

const observe = vi.fn()
const disconnect = vi.fn()

class ResizeObserverStub {
  observe = observe
  disconnect = disconnect
}

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-transparency')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  observe.mockClear()
  disconnect.mockClear()
})

describe('useLiquidGlass transparency gating', () => {
  it('does not start displacement-map generation or persist storage in opaque mode', () => {
    window.localStorage.setItem(TRANSPARENCY_KEY, '"opaque"')
    document.documentElement.dataset.transparency = 'opaque'
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    vi.stubGlobal('CSS', { supports: vi.fn(() => true) })
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/157.0.0.0 Safari/537.36')
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const target = document.createElement('div')

    const { result } = renderHook(() => useLiquidGlass({ current: target }))

    expect(result.current.supported).toBe(false)
    expect(observe).not.toHaveBeenCalled()
    expect(raf).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('stops an active observer when the document becomes opaque', async () => {
    window.localStorage.setItem(TRANSPARENCY_KEY, '"glass"')
    vi.stubGlobal('CSS', { supports: vi.fn(() => true) })
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/157.0.0.0 Safari/537.36')
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('requestAnimationFrame', vi.fn())
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const target = document.createElement('div')
    const { result } = renderHook(() => useLiquidGlass({ current: target }))
    expect(result.current.supported).toBe(true)
    expect(observe).toHaveBeenCalledOnce()

    act(() => applyTransparency('opaque'))

    await waitFor(() => expect(result.current.supported).toBe(false))
    expect(disconnect).toHaveBeenCalled()
  })
})
