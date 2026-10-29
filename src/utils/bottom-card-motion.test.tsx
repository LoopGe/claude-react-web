import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBottomCardMotion } from './transitions'

// Pins the JS half of the bottom-overlay cards' exit-collapse contract
// (TodoChecklist / MonitorBar / WorkingBubble via BottomCardMotion). The exit
// collapses `height: 0` with the staggered fade-then-collapse timing — but
// the collapse is not the whole contract: an exit ABORTED mid-collapse (the
// same key re-appears inside the ~250ms exit window — e.g. the task list
// empties at a user turn and a TaskCreate repopulates it right after) leaves
// the wrapper's inline height frozen at whatever mid-collapse value motion
// had reached. `animate` must therefore restore `height: 'auto'` — the same
// aborted-exit recovery useTopCardMotion (top-card-motion.test.tsx) and
// useStreamingRegionMotion already carry; without it the stuck wrapper is
// TALLER than the card inside it and the difference paints as a blank band
// between the card and the composer (the "空白 between TaskList and input"
// report). `initial` carries it too so the mount is a height no-op (motion
// skips a target equal to the latest value; a null-origin mount target would
// make motion measure the box and tween inline height on every mount) —
// the same reasoning documented on useStreamingRegionMotion.

const STAGGERED_EXIT = {
  opacity: { duration: 0.11, ease: [0.4, 0, 1, 1] },
  y: { duration: 0.11, ease: [0.4, 0, 1, 1] },
  height: { duration: 0.16, ease: [0.22, 1, 0.36, 1], delay: 0.09 },
}

// useReducedMotion is mocked (not left to happy-dom's matchMedia) so the
// reduced-motion branch — a hand-maintained duplicate of the normal variants —
// gets the same residual-key pinning. Without this, dropping or mistyping the
// keys there fails nothing and re-breaks the aborted-exit recovery under
// reduced motion.
const reduceState = vi.hoisted(() => ({ reduce: false }))
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return { ...actual, useReducedMotion: () => reduceState.reduce }
})

describe('useBottomCardMotion aborted-exit recovery', () => {
  it('animate restores height:auto so an aborted exit cannot strand a stuck wrapper height', () => {
    const { result } = renderHook(() => useBottomCardMotion())
    const animate = result.current.card.animate as Record<string, unknown>
    expect(animate.height).toBe('auto')
  })

  it('initial carries height:auto so the mount is a height no-op', () => {
    const { result } = renderHook(() => useBottomCardMotion())
    const initial = result.current.card.initial as Record<string, unknown>
    expect(initial.height).toBe('auto')
  })

  it('exit collapses height:0 on the staggered fade-then-collapse timing', () => {
    const { result } = renderHook(() => useBottomCardMotion())
    const exit = result.current.card.exit as Record<string, unknown>
    expect(exit.height).toBe(0)
    expect(exit.opacity).toBe(0)
    expect(exit.transition).toEqual(STAGGERED_EXIT)
  })

  it('reduced-motion branch carries the same residual keys (instant)', () => {
    reduceState.reduce = true
    try {
      const { result } = renderHook(() => useBottomCardMotion())
      const { initial, animate, exit } = result.current.card as Record<string, Record<string, unknown>>
      expect(initial.height).toBe('auto')
      expect(animate.height).toBe('auto')
      expect(exit.height).toBe(0)
      expect(exit.transition).toEqual({ duration: 0 })
    } finally {
      reduceState.reduce = false
    }
  })
})
