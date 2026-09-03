// @vitest-environment jsdom
// This file needs the DOM (document.documentElement, localStorage,
// window.matchMedia) so it overrides the utils→node default from
// vitest.config.ts. matchMedia is not implemented by jsdom, so each test
// that exercises 'system' resolution installs its own mock via spy.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  applyTheme,
  applySkin,
  getStoredTheme,
  getStoredSkin,
  toggleTheme,
  isAccentLocked,
  isBackgroundLocked,
  type Skin,
} from './theme'

const THEME_KEY = 'claude-react-web:theme'
const SKIN_KEY = 'claude-react-web:skin'

/** Install a matchMedia mock that reports the given OS light preference. */
function mockOS(prefersLight: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    const matches =
      query === '(prefers-color-scheme: light)' ? prefersLight : false
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList
  })
}

describe('getStoredTheme', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to "dark" when unset', () => {
    expect(getStoredTheme()).toBe('dark')
  })

  it('accepts the three modes', () => {
    for (const v of ['light', 'dark', 'system'] as const) {
      window.localStorage.setItem(THEME_KEY, v)
      expect(getStoredTheme()).toBe(v)
    }
  })

  it('rejects unknown values and falls back to dark', () => {
    window.localStorage.setItem(THEME_KEY, 'neon')
    expect(getStoredTheme()).toBe('dark')
  })
})

describe('applyTheme — system resolves via OS, dark/light pass through', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.restoreAllMocks()
  })
  afterEach(() => vi.restoreAllMocks())

  it('"system" resolves to light/dark from the OS preference', () => {
    mockOS(true)
    applyTheme('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    mockOS(false)
    applyTheme('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('"dark" and "light" pass through unchanged', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('toggleTheme', () => {
  beforeEach(() => {
    // toggleTheme calls applyTheme, which for 'system' probes matchMedia.
    mockOS(false)
  })
  afterEach(() => vi.restoreAllMocks())

  it('cycles dark -> light -> system -> dark', () => {
    expect(toggleTheme('dark')).toBe('light')
    expect(toggleTheme('light')).toBe('system')
    expect(toggleTheme('system')).toBe('dark')
  })
})

describe('getStoredSkin', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to "default" when unset', () => {
    expect(getStoredSkin()).toBe('default')
  })

  it('accepts "hc" (High Contrast skin)', () => {
    window.localStorage.setItem(SKIN_KEY, 'hc')
    expect(getStoredSkin()).toBe('hc')
  })

  it('accepts the legacy skins', () => {
    for (const v of ['default', 'glow', 'anthropic'] as const) {
      window.localStorage.setItem(SKIN_KEY, v)
      expect(getStoredSkin()).toBe(v)
    }
  })

  it('rejects unknown values and falls back to default', () => {
    window.localStorage.setItem(SKIN_KEY, 'neon')
    expect(getStoredSkin()).toBe('default')
  })
})

describe('applySkin', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-skin')
    window.localStorage.clear()
  })

  it('"hc" sets data-skin="hc" on <html> and persists it', () => {
    applySkin('hc')
    expect(document.documentElement.getAttribute('data-skin')).toBe('hc')
    expect(window.localStorage.getItem(SKIN_KEY)).toBe('hc')
  })

  it('"default" removes the data-skin attribute entirely', () => {
    applySkin('hc')
    expect(document.documentElement.getAttribute('data-skin')).toBe('hc')
    applySkin('default')
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false)
  })

  it('each skin sets its own attribute value', () => {
    for (const v of ['glow', 'anthropic', 'hc'] as const) {
      applySkin(v as Skin)
      expect(document.documentElement.getAttribute('data-skin')).toBe(v)
    }
  })
})

describe('isAccentLocked', () => {
  it('locks the accent for the Anthropic and HC skins', () => {
    expect(isAccentLocked('anthropic')).toBe(true)
    expect(isAccentLocked('hc')).toBe(true)
  })

  it('locks the accent for soft-hc', () => {
    expect(isAccentLocked('soft-hc')).toBe(true)
  })

  it('leaves the accent pickable for the default and glow skins', () => {
    expect(isAccentLocked('default')).toBe(false)
    expect(isAccentLocked('glow')).toBe(false)
  })

  it('treats absent/unknown skin as unlocked', () => {
    expect(isAccentLocked(undefined)).toBe(false)
    expect(isAccentLocked(null)).toBe(false)
    expect(isAccentLocked('neon' as Skin)).toBe(false)
  })
})

describe('isBackgroundLocked', () => {
  it('is false for the expressive skins', () => {
    expect(isBackgroundLocked('default')).toBe(false)
    expect(isBackgroundLocked('glow')).toBe(false)
  })
  it('is true for the branded / a11y skins', () => {
    expect(isBackgroundLocked('anthropic')).toBe(true)
    expect(isBackgroundLocked('hc')).toBe(true)
    expect(isBackgroundLocked('soft-hc')).toBe(true)
  })
  it('stays in lockstep with the accent lock', () => {
    for (const s of ['default', 'glow', 'anthropic', 'hc', 'soft-hc'] as const) {
      expect(isBackgroundLocked(s)).toBe(isAccentLocked(s))
    }
  })
})
