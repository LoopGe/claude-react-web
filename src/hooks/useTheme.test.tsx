// happy-dom via environmentMatchGlobs (src/** → happy-dom). The hook writes
// inline accent custom properties on <html> and reads localStorage, so it
// needs a DOM — no per-file pragma required.
//
// The accent is seeded through the hook itself (setAccentColor), never by
// guessing the localStorage key, so these tests pin the hook's own contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTheme } from './useTheme'

describe('useTheme — accent lock on skins', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    // Global cleanup (src/test-setup.ts) already unmounts every hook between
    // cases. What it cannot undo is the state this hook writes OUTSIDE React:
    // same-tab localStorage keys, the inline --accent* custom properties on
    // <html>, and the data-skin attribute — all of which survive unmount.
    // Clear those so each case starts from a clean document.
    window.localStorage.clear()
    document.documentElement.style.removeProperty('--accent')
    document.documentElement.style.removeProperty('--accent-strong')
    document.documentElement.style.removeProperty('--on-accent')
    document.documentElement.removeAttribute('data-skin')
  })

  it('clears inline accent overrides when the skin locks the accent', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setAccentColor('#ff0000'))
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ff0000')
    act(() => result.current.setSkin('brutalist'))
    const root = document.documentElement.style
    expect(root.getPropertyValue('--accent')).toBe('')
    expect(root.getPropertyValue('--accent-strong')).toBe('')
    expect(root.getPropertyValue('--on-accent')).toBe('')
  })
  it('restores the user accent when switching back to an unlocked skin', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setAccentColor('#ff0000'))
    act(() => result.current.setSkin('brutalist'))
    act(() => result.current.setSkin('default'))
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ff0000')
  })
})
