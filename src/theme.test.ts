import { describe, it, expect } from 'vitest'
import { buildSessionAccentMap, isBackgroundSetting } from './theme'

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
  it('rejects a corrupt / hand-edited value', () => {
    expect(isBackgroundSetting(null)).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'custom' }, opacity: 0.7 })).toBe(false) // missing src
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 2 })).toBe(false)      // opacity out of range
    expect(isBackgroundSetting({ pref: { kind: 'weird' }, opacity: 0.5 })).toBe(false)
  })
})
