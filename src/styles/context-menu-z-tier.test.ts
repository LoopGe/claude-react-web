// @vitest-environment node
// Pins the context menu's stacking tier. The shared ContextMenu portals to
// <body> and can be spawned from INSIDE a modal (the PDF zoom preset menu in
// the resource / upload PDF viewers): at --z-overlay (1000) it paints below
// the --z-modal (2000) card, invisible and mouse-inoperable. A dedicated
// --z-menu tier above modal (and below toast, so notifications win) keeps it
// visible and clickable there. The floating-surface registry dismisses
// unrelated open menus when a dialog opens, so the raised tier only paints
// above a modal the menu was actually spawned from.

import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

/** Numeric value of a z-tier token from the last :root block declaring it. */
function zTier(token: string): number {
  const roots = parseBlocks(readCss('tokens.css')).filter((b) => b.sel === ':root')
  const raw = roots.map((b) => b.tokens[token]).filter((v) => v !== undefined).pop()
  expect(raw, `tokens.css :root declares ${token}`).toBeTruthy()
  const value = Number(raw)
  expect(Number.isFinite(value), `${token} is a plain number`).toBe(true)
  return value
}

describe('context menu z-tier', () => {
  it('orders overlay < modal < menu < toast < tooltip', () => {
    expect(zTier('--z-overlay')).toBeLessThan(zTier('--z-modal'))
    expect(zTier('--z-modal')).toBeLessThan(zTier('--z-menu'))
    expect(zTier('--z-menu')).toBeLessThan(zTier('--z-toast'))
    expect(zTier('--z-toast')).toBeLessThan(zTier('--z-tooltip'))
  })

  it('.ctx-menu rides the menu tier, not the overlay tier', () => {
    const rule = parseBlocks(readCss('session-list.css')).find((b) => b.sel === '.ctx-menu')
    expect(rule, '.ctx-menu must exist').toBeTruthy()
    expect(rule!.decls['z-index']).toBe('var(--z-menu)')
  })
})