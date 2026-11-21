// formatCombo: pretty-printing for the palette / shortcut-help hints.
// Runs in the node environment (src/utils/**/*.test.ts): navigator is absent
// by default, which is the Windows branch. The Mac branch is exercised by
// stubbing globalThis.navigator with a Mac platform (the same lazy-read
// contract client-platform.ts documents).
import { afterEach, describe, expect, it } from 'vitest'
import { formatCombo } from './format-combo'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function stubPlatform(platform: string) {
  Object.defineProperty(globalThis, 'navigator', { value: { platform }, configurable: true })
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else Reflect.deleteProperty(globalThis, 'navigator')
})

describe('formatCombo (Windows / generic platform)', () => {
  it('renders mod as Ctrl', () => {
    expect(formatCombo('mod+k')).toBe('Ctrl+K')
  })

  it('renders the platform-fixed ctrl token as Ctrl', () => {
    expect(formatCombo('ctrl+`')).toBe('Ctrl+`')
  })

  it('renders the platform-fixed meta token as Meta (not Ctrl)', () => {
    expect(formatCombo('meta+k')).toBe('Meta+K')
  })

  it('keeps modifier order and the backquote key verbatim', () => {
    expect(formatCombo('ctrl+shift+`')).toBe('Ctrl+Shift+`')
  })

  it('still renders alt / shift combos', () => {
    expect(formatCombo('alt+shift+e')).toBe('Alt+Shift+E')
  })
})

describe('formatCombo (Mac platform)', () => {
  it('renders mod as ⌘', () => {
    stubPlatform('MacIntel')
    expect(formatCombo('mod+shift+e')).toBe('⌘⇧E')
  })

  it('renders ctrl as ⌃ (distinct from ⌘)', () => {
    stubPlatform('MacIntel')
    expect(formatCombo('ctrl+`')).toBe('⌃`')
  })

  it('renders meta as ⌘', () => {
    stubPlatform('MacIntel')
    expect(formatCombo('meta+k')).toBe('⌘K')
  })

  it('still renders alt as ⌥', () => {
    stubPlatform('MacIntel')
    expect(formatCombo('alt+r')).toBe('⌥R')
  })
})
