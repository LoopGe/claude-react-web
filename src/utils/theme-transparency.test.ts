// @vitest-environment happy-dom
// src/utils/** otherwise maps to node (see vitest.config.ts); applyTransparency
// touches document.documentElement, so this file opts back into a DOM.
import { describe, it, expect, afterEach } from 'vitest'
import { applyTransparency, TRANSPARENCY_KEY } from './theme'

afterEach(() => {
  document.documentElement.removeAttribute('data-transparency')
})

describe('applyTransparency', () => {
  it('removes the attribute in glass mode — the default look', () => {
    document.documentElement.setAttribute('data-transparency', 'opaque')
    applyTransparency('glass')
    expect(document.documentElement.hasAttribute('data-transparency')).toBe(false)
  })

  it('stamps data-transparency="off" in no-frost mode', () => {
    applyTransparency('no-frost')
    expect(document.documentElement.getAttribute('data-transparency')).toBe('off')
  })

  it('stamps data-transparency="opaque" in opaque mode', () => {
    applyTransparency('opaque')
    expect(document.documentElement.getAttribute('data-transparency')).toBe('opaque')
  })

  it('keeps the existing namespaced localStorage key for migration', () => {
    expect(TRANSPARENCY_KEY).toMatch(/^claude-react-web:/)
  })
})
