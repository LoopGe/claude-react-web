import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTopCardMotion } from './transitions'

// Pins the JS half of the recap exit-collapse contract (the CSS half lives in
// src/styles/recap-collapse-residual.test.tsx). The exit collapses
// `height: 0`, but the glass shell's 2px border is NOT part of the animated
// value and the parent stack's 8px gap belongs to the parent — both kept
// occupying layout until AnimatePresence unmounted the ghost, so the
// transcript visibly jumped at the animation's last frame. The exit must
// therefore also zero border-width and cancel the gap with a negative
// margin-bottom, both on the height's own timing (the box folds as a unit);
// the animate target must restore the rest values so an aborted exit
// recovers the shell, same as the height:'auto' restore.

const HEIGHT_TIMING = { duration: 0.2, ease: [0.22, 1, 0.36, 1], delay: 0.09 }

// useReducedMotion is mocked (not left to happy-dom's matchMedia) so the
// reduced-motion branch — a hand-maintained duplicate of the normal variants —
// gets the same residual-key pinning. Without this, dropping or mistyping the
// keys there fails nothing and re-breaks the last frame under reduced motion.
const reduceState = vi.hoisted(() => ({ reduce: false }))
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return { ...actual, useReducedMotion: () => reduceState.reduce }
})

describe('useTopCardMotion collapse residuals', () => {
  it('exit zeroes the shell border and cancels the stack gap on the height timing', () => {
    const { result } = renderHook(() => useTopCardMotion())
    const exit = result.current.card.exit
    expect(exit.height).toBe(0)
    expect(exit.borderWidth).toBe(0)
    expect(exit.marginBottom).toBe(-8)
    const t = exit.transition as Record<string, unknown>
    for (const key of ['height', 'borderWidth', 'marginBottom']) {
      expect(t[key], `exit transition for ${key} must match the height tween`).toEqual(
        HEIGHT_TIMING,
      )
    }
  })

  it('animate restores the rest values (aborted-exit recovery)', () => {
    const { result } = renderHook(() => useTopCardMotion())
    const animate = result.current.card.animate
    expect(animate.height).toBe('auto')
    expect(animate.borderWidth).toBe(2)
    expect(animate.marginBottom).toBe(0)
  })

  it('reduced-motion branch carries the same residual keys (instant)', () => {
    reduceState.reduce = true
    try {
      const { result } = renderHook(() => useTopCardMotion())
      const { animate, exit } = result.current.card
      expect(exit.height).toBe(0)
      expect(exit.borderWidth).toBe(0)
      expect(exit.marginBottom).toBe(-8)
      expect(animate.height).toBe('auto')
      expect(animate.borderWidth).toBe(2)
      expect(animate.marginBottom).toBe(0)
    } finally {
      reduceState.reduce = false
    }
  })
})
