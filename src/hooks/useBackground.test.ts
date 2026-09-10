import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useBackground, resolveActiveVideoSrc } from './useBackground'
import { BACKGROUND_DEFAULT_BLUR, BACKGROUND_DEFAULT_SURFACE, BACKGROUND_KEY } from '../theme'

function cssVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name)
}

const VIDEO_SRC = '/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.mp4'
const IMAGE_SRC = '/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.png'

function seed(value: unknown): void {
  window.localStorage.setItem(BACKGROUND_KEY, JSON.stringify(value))
}

describe('useBackground', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.style.removeProperty('--app-bg-image')
    document.documentElement.style.removeProperty('--app-chrome-alpha')
    document.documentElement.style.removeProperty('--app-chrome-blur')
    document.documentElement.style.removeProperty('--app-surface-alpha')
    document.body.classList.remove('has-bg')
  })
  afterEach(() => {
    // Without this a hook left mounted by an earlier case keeps reacting to the
    // next case's localStorage writes (useLocalStorage syncs same-tab writes),
    // so a later case's `has-bg` expectation is decided by a stale skin.
    cleanup()
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

  it('applies the chrome blur, defaulting a stored setting that predates it', () => {
    const { result } = renderHook(() => useBackground('default'))
    act(() => result.current.setSetting({ pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 0.7 }))
    expect(cssVar('--app-chrome-blur')).toBe(`${BACKGROUND_DEFAULT_BLUR}px`)

    act(() => result.current.setSetting({ ...result.current.setting, blur: 3 }))
    expect(cssVar('--app-chrome-blur')).toBe('3px')
  })

  it('applies the content-surface alpha, defaulting a pref that predates it', () => {
    const { result } = renderHook(() => useBackground('default'))
    act(() => result.current.setSetting({ pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 0.7 }))
    expect(cssVar('--app-surface-alpha')).toBe(`${Math.round(BACKGROUND_DEFAULT_SURFACE * 100)}%`)

    act(() => result.current.setSetting({ ...result.current.setting, surface: 0.5 }))
    expect(cssVar('--app-surface-alpha')).toBe('50%')
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
    window.localStorage.setItem(BACKGROUND_KEY, JSON.stringify({ pref: { kind: 'bogus' }, opacity: 9 }))
    const { result } = renderHook(() => useBackground('default'))
    expect(result.current.setting).toEqual({ pref: { kind: 'none' }, opacity: 0.85 })
  })

  describe('video wallpapers', () => {
    it('hands a video to the <video> layer instead of the CSS background', () => {
      seed({ pref: { kind: 'custom', src: VIDEO_SRC, media: 'video' }, opacity: 0.8 })
      const { result } = renderHook(() => useBackground('default'))

      expect(result.current.activeVideoSrc).toBe(VIDEO_SRC)
      // The image slot must be cleared, or a stale wallpaper would sit behind
      // the video and reappear if the element ever failed to paint.
      expect(cssVar('--app-bg-image')).toBe('none')
      expect(document.body.classList.contains('has-bg')).toBe(true)
    })

    it('keeps rendering an image pref through the CSS background', () => {
      seed({ pref: { kind: 'custom', src: IMAGE_SRC, media: 'image' }, opacity: 0.8 })
      const { result } = renderHook(() => useBackground('default'))

      expect(result.current.activeVideoSrc).toBeNull()
      expect(cssVar('--app-bg-image')).toBe(`url("${IMAGE_SRC}")`)
    })

    it('treats a media-less legacy pref as an image', () => {
      seed({ pref: { kind: 'custom', src: IMAGE_SRC }, opacity: 0.8 })
      const { result } = renderHook(() => useBackground('default'))

      expect(result.current.activeVideoSrc).toBeNull()
      expect(cssVar('--app-bg-image')).toBe(`url("${IMAGE_SRC}")`)
    })

    it('suppresses the video under a background-locked skin, keeping the stored choice', () => {
      seed({ pref: { kind: 'custom', src: VIDEO_SRC, media: 'video' }, opacity: 0.8 })
      const { result } = renderHook(() => useBackground('hc'))

      expect(result.current.activeVideoSrc).toBeNull()
      expect(document.body.classList.contains('has-bg')).toBe(false)
      expect(result.current.setting.pref).toEqual({ kind: 'custom', src: VIDEO_SRC, media: 'video' })
    })

    it('refuses to hand a non-video src to the <video> layer', () => {
      // Exercised through the policy directly, not through a seeded store: the
      // validator already rejects this shape, so a seeded test would pass for
      // the wrong reason and leave the guard itself unpinned. It is the last
      // thing between an image file and the player if a caller ever passes an
      // unvalidated setting.
      expect(resolveActiveVideoSrc(
        { pref: { kind: 'custom', src: IMAGE_SRC, media: 'video' }, opacity: 0.8 }, 'default',
      )).toBeNull()
      expect(resolveActiveVideoSrc(
        { pref: { kind: 'custom', src: VIDEO_SRC, media: 'video' }, opacity: 0.8 }, 'default',
      )).toBe(VIDEO_SRC)
    })

    it('clears the video when the setting is switched back to none', () => {
      seed({ pref: { kind: 'custom', src: VIDEO_SRC, media: 'video' }, opacity: 0.8 })
      const { result } = renderHook(() => useBackground('default'))
      expect(result.current.activeVideoSrc).toBe(VIDEO_SRC)

      act(() => result.current.setSetting({ ...result.current.setting, pref: { kind: 'none' } }))
      expect(result.current.activeVideoSrc).toBeNull()
      expect(cssVar('--app-bg-image')).toBe('none')
    })
  })
})
