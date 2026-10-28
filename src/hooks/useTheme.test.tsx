// happy-dom via environmentMatchGlobs (src/** → happy-dom). The hook writes
// inline accent custom properties on <html> and reads localStorage, so it
// needs a DOM — no per-file pragma required.
//
// The accent is seeded through the hook itself (setAccentColor), never by
// guessing the localStorage key, so these tests pin the hook's own contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useTheme } from './useTheme'

describe('useTheme — accent lock on skins', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    // A hook left mounted by an earlier case keeps its effects live across
    // cases (useLocalStorage syncs same-tab writes), so clear explicitly —
    // the same pattern as useBackground.test.ts.
    cleanup()
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
