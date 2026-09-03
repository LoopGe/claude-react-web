import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBackground } from './useBackground'

function cssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name)
}

describe('useBackground', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.style.removeProperty('--app-bg-image')
    document.documentElement.style.removeProperty('--app-chrome-alpha')
    document.body.classList.remove('has-bg')
  })
  afterEach(() => {
    window.localStorage.clear()
    document.body.classList.remove('has-bg')
  })

  it('defaults to none and leaves the document untouched', () => {
    const { result } = renderHook(() => useBackground('default'))
    expect(result.current.setting).toEqual({ pref: { kind: 'none' }, opacity: 0.85 })
    expect(cssVar('--app-bg-image')).toBe('none')
    expect(cssVar('--app-chrome-alpha')).toBe('100%')
    expect(document.body.classList.contains('has-bg')).toBe(false)
  })

  it('does not enable the effect while a custom pref has an empty src', () => {
    const { result } = renderHook(() => useBackground('default'))
    act(() => result.current.setSetting({ pref: { kind: 'custom', src: '' }, opacity: 0.7 }))
    expect(document.body.classList.contains('has-bg')).toBe(false)
    expect(cssVar('--app-bg-image')).toBe('none')
  })

  it('applies a custom URL under the default skin', () => {
    const { result } = renderHook(() => useBackground('default'))
    act(() => result.current.setSetting({ pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 0.7 }))
    expect(cssVar('--app-bg-image')).toBe('url("https://ex.com/bg.png")')
    expect(cssVar('--app-chrome-alpha')).toBe('70%')
    expect(document.body.classList.contains('has-bg')).toBe(true)
  })

  it('suppresses the effect under a locked skin but keeps the pref', () => {
    const { result, rerender } = renderHook(({ skin }: { skin: 'default' | 'hc' }) => useBackground(skin), {
      initialProps: { skin: 'default' },
    })
    act(() => result.current.setSetting({ pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 0.7 }))
    expect(document.body.classList.contains('has-bg')).toBe(true)
    rerender({ skin: 'hc' })
    expect(document.body.classList.contains('has-bg')).toBe(false)
    expect(cssVar('--app-bg-image')).toBe('none')
    expect(result.current.setting.pref).toEqual({ kind: 'custom', src: 'https://ex.com/bg.png' })
  })

  it('auto-sets default opacity when picking an image at max opacity', () => {
    const { result } = renderHook(() => useBackground('default'))
    act(() => result.current.setSetting({ pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 1 }))
    expect(result.current.setting.opacity).toBe(0.85)
  })

  it('persists and restores a corrupt value as the default', () => {
    window.localStorage.setItem('claude-react-web:background', JSON.stringify({ pref: { kind: 'bogus' }, opacity: 9 }))
    const { result } = renderHook(() => useBackground('default'))
    expect(result.current.setting).toEqual({ pref: { kind: 'none' }, opacity: 0.85 })
  })
})
