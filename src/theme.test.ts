import { describe, it, expect } from 'vitest'
import {
  buildSessionAccentMap, BACKGROUND_BLUR_MAX, BACKGROUND_SRC_MAX, BACKGROUND_SURFACE_STEP,
  BACKGROUND_DEFAULT_SURFACE, BACKGROUND_OPACITY_STEP, BACKGROUND_DEFAULT_OPACITY,
  BACKGROUND_DEFAULT_BLUR, BACKGROUND_BLUR_STEP,
  isBackgroundSrc, isBackgroundSetting,
} from './theme'

describe('background slider defaults land on their step grid', () => {
  // A default off the grid is silently snapped by real browsers (range value
  // sanitization), so the thumb renders elsewhere and the shipped default
  // becomes unreachable. jsdom does NOT sanitize, so only this check catches it.
  const onGrid = (min: number, step: number, value: number) =>
    Math.abs(Math.round((value - min) / step) - (value - min) / step) < 1e-9

  it('puts Opacity, Blur and Content defaults on their own steps', () => {
    expect(onGrid(0, BACKGROUND_OPACITY_STEP, BACKGROUND_DEFAULT_OPACITY)).toBe(true)
    expect(onGrid(0, BACKGROUND_BLUR_STEP, BACKGROUND_DEFAULT_BLUR)).toBe(true)
    expect(onGrid(0, BACKGROUND_SURFACE_STEP, BACKGROUND_DEFAULT_SURFACE)).toBe(true)
  })
})

describe('isBackgroundSrc', () => {
  it('accepts a remote http(s) URL and a server-assigned upload name', () => {
    expect(isBackgroundSrc('https://example.com/bg.png')).toBe(true)
    expect(isBackgroundSrc('/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.png')).toBe(true)
  })
  it('rejects an upload path that is not a real server-assigned name', () => {
    // BackgroundPicker's delete-on-replace fetches this path. The browser
    // normalizes dot segments before the request leaves, so a permissive
    // prefix check turns a persisted string into an arbitrary same-origin
    // DELETE (e.g. /api/sessions/<id>) — bypassing the route's own containment.
    expect(isBackgroundSrc('/api/background/files/../../sessions/s1')).toBe(false)
    expect(isBackgroundSrc('/api/background/files/%2e%2e/sessions')).toBe(false)
    expect(isBackgroundSrc('/api/background/files/x.png')).toBe(false)
    expect(isBackgroundSrc('/api/background/files/deadbeef.png.sh')).toBe(false)
    expect(isBackgroundSrc('file:///C:/bg.png')).toBe(false)
    expect(isBackgroundSrc('')).toBe(false)
  })
})

describe('buildSessionAccentMap', () => {
  const colors = { s1: '#7b8cde', s2: '#e07080' }

  it('builds a per-session override map for pickable skins', () => {
    const map = buildSessionAccentMap(colors, 'default')
    expect(map.size).toBe(2)
    expect(map.get('s1')).toEqual({
      '--accent': '#7b8cde',
      '--accent-strong': '#5b6fc7',
      '--on-accent': expect.any(String),
    })
    expect(map.get('s2')).toEqual({
      '--accent': '#e07080',
      '--accent-strong': '#c45465',
      '--on-accent': expect.any(String),
    })
  })

  it('returns an empty map when the skin locks the accent (Anthropic)', () => {
    // Per-session inline --accent would override the skin's locked brand
    // accent at the element level, so they must be suppressed.
    const map = buildSessionAccentMap(colors, 'anthropic')
    expect(map.size).toBe(0)
  })

  it('returns an empty map when the skin locks the accent (HC)', () => {
    const map = buildSessionAccentMap(colors, 'hc')
    expect(map.size).toBe(0)
  })

  it('defaults to unlocked when no skin is given', () => {
    const map = buildSessionAccentMap(colors)
    expect(map.size).toBe(2)
  })

  it('returns an empty map for undefined input', () => {
    expect(buildSessionAccentMap(undefined, 'default').size).toBe(0)
  })
})

describe('isBackgroundSetting', () => {
  it('accepts a none setting', () => {
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85 })).toBe(true)
  })
  it('accepts a custom setting with an http(s) src', () => {
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: 'https://example.com/bg.png' }, opacity: 0.7 })).toBe(true)
  })
  it('rejects a custom pref whose src is empty', () => {
    // `{kind:'custom', src:''}` is the picker's mid-gesture state, never a
    // persisted one — see isBackgroundSetting's docs. Accepting it would let a
    // half-selection become the app's durable background state.
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: '' }, opacity: 0.85 })).toBe(false)
  })
  it('accepts a custom src right up to the length cap and rejects beyond it', () => {
    const root = 'https://example.com/'
    expect(isBackgroundSetting({
      pref: { kind: 'custom', src: root + 't'.repeat(BACKGROUND_SRC_MAX - root.length) }, opacity: 0.85,
    })).toBe(true)
    expect(isBackgroundSetting({
      pref: { kind: 'custom', src: root + 't'.repeat(BACKGROUND_SRC_MAX - root.length + 1) }, opacity: 0.85,
    })).toBe(false)
  })
  it('accepts only an applicable image reference — remote http(s) or an upload', () => {
    expect(isBackgroundSetting({
      pref: { kind: 'custom', src: '/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.png' }, opacity: 0.85,
    })).toBe(true)
    // A shape the picker would never offer (and which cannot load in a
    // browser-served page) must not survive a load or a lastSrc restore.
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: 'file:///C:/bg.png' }, opacity: 0.85 })).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, lastSrc: 'file:///C:/bg.png' })).toBe(false)
  })
  it('treats a missing surface as the default and rejects an out-of-range one', () => {
    // Same optional-field rule as blur: prefs saved before the Content slider
    // existed must keep loading intact.
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, surface: 0.88 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, surface: -0.01 })).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, surface: 1.01 })).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, surface: 'x' })).toBe(false)
  })
  it('treats a missing blur as the default and rejects an out-of-range one', () => {
    // Prefs saved before the blur control existed must keep loading — a
    // required field here would collapse the whole setting and take the
    // user's wallpaper down with it.
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, blur: 12 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, blur: -1 })).toBe(false)
    expect(isBackgroundSetting({
      pref: { kind: 'none' }, opacity: 0.85, blur: BACKGROUND_BLUR_MAX + 1,
    })).toBe(false)
  })
  it('accepts the full 0–1 opacity range', () => {
    // Fully transparent chrome is a legitimate choice at the bottom.
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 1 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: -0.01 })).toBe(false)
  })
  it('accepts a remembered lastSrc beside any pref, and rejects a malformed one', () => {
    expect(isBackgroundSetting({
      pref: { kind: 'none' }, opacity: 0.85, lastSrc: 'https://example.com/bg.png',
    })).toBe(true)
    expect(isBackgroundSetting({
      pref: { kind: 'custom', src: 'https://example.com/bg.png' }, opacity: 0.85, lastSrc: 42,
    })).toBe(false)
  })
  it('rejects a corrupt / hand-edited value', () => {
    expect(isBackgroundSetting(null)).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'custom' }, opacity: 0.7 })).toBe(false) // missing src
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 2 })).toBe(false)      // opacity out of range
    expect(isBackgroundSetting({ pref: { kind: 'weird' }, opacity: 0.5 })).toBe(false)
  })
})
