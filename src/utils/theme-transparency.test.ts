// @vitest-environment happy-dom
// src/utils/** otherwise maps to node (see vitest.config.ts); applyTransparency
// touches document.documentElement, so this file opts back into a DOM.
import { describe, it, expect, afterEach } from 'vitest'
import { applyTransparency, TRANSPARENCY_KEY } from './theme'

afterEach(() => {
  document.documentElement.removeAttribute('data-transparency')
})

describe('applyTransparency', () => {
  it('removes the attribute when on — the default look', () => {
    document.documentElement.setAttribute('data-transparency', 'off')
    applyTransparency(true)
    expect(document.documentElement.hasAttribute('data-transparency')).toBe(false)
  })

  it('stamps data-transparency="off" when off', () => {
    applyTransparency(false)
    expect(document.documentElement.getAttribute('data-transparency')).toBe('off')
  })

  it('is keyed for a boolean localStorage flag under the app namespace', () => {
    expect(TRANSPARENCY_KEY).toMatch(/^claude-react-web:/)
  })
})
