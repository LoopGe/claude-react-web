import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useStreamingRegionMotion } from './transitions'

// Pins the JS half of the streaming region's exit contract (the presence /
// unmount half lives in MessageList.test.tsx; the CSS half — the mount-only
// max-height grow — lives in chat.css). The exit's stagger shape IS the fix
// for the "message card snaps at the end of the streaming footer's exit"
// bug (see useStreamingRegionMotion's docstring for the harness-measured
// defects of the old single 180ms keyframe): the height collapse must start
// from the element's measured height on the ease-ENTER curve (decelerating
// tail — the RO→spacer pipeline's easiest target), delayed 90ms behind the
// 110ms fade so the shrinking box never squashes a still-visible bubble, and
// it must NOT use ease-exit (the old accelerating tail put the largest
// per-frame deltas exactly where the pipeline lags). In jsdom/happy-dom the
// height tween is 0→0, so none of this is observable through rendering —
// dropping or mistyping a key here fails nothing else.
//
// Also pins the mount invariants: `height: 'auto'` must sit in BOTH initial
// and animate (identical targets = motion skips the mount height animation,
// leaving the CSS max-height grow the sole height animator — a null-origin
// mount target would make motion measure the box mid-grow and tween inline
// height for 180ms, fighting the CSS animation and clipping early flushes),
// and the y distances mirror --motion-distance-lg (14px).

const STAGGER = {
  opacity: { duration: 0.11, ease: [0.4, 0, 1, 1] },
  y: { duration: 0.11, ease: [0.4, 0, 1, 1] },
  height: { duration: 0.16, ease: [0.22, 1, 0.36, 1], delay: 0.09 },
}

// useReducedMotion is mocked (not left to happy-dom's matchMedia) so the
// reduced-motion branch — a hand-maintained duplicate of the normal variants —
// gets the same pinning. Without this, dropping the height:'auto' restore
// there fails nothing and a duration-0 exit interrupted by a same-key
// re-entry strands inline height: 0 for the rest of the turn.
const reduceState = vi.hoisted(() => ({ reduce: false }))
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>()
  return { ...actual, useReducedMotion: () => reduceState.reduce }
})

describe('useStreamingRegionMotion exit stagger', () => {
  it('exits with the staggered fade-then-collapse shape (ease-ENTER height, 90ms delay)', () => {
    const { result } = renderHook(() => useStreamingRegionMotion())
    const { initial, animate, exit } = result.current.region

    expect(exit.height).toBe(0)
    expect(exit.opacity).toBe(0)
    expect(exit.y).toBe(14) // sinks --motion-distance-lg, mirroring the mount rise
    expect(exit.transition).toEqual(STAGGER)

    // Mount no-op invariant: height in BOTH initial and animate, so motion
    // never tweens height while streaming (CSS owns the grow).
    expect(initial.height).toBe('auto')
    expect(animate.height).toBe('auto')
    // The rise mirrors --motion-distance-lg / --motion-duration-base.
    expect(initial.y).toBe(14)
    expect(animate.y).toBe(0)
  })

  it('reduced-motion branch snaps instantly and restores height on re-entry', () => {
    reduceState.reduce = true
    try {
      const { result } = renderHook(() => useStreamingRegionMotion())
      const { animate, exit } = result.current.region
      expect(exit.height).toBe(0)
      expect(exit.transition).toEqual({ duration: 0 })
      // The restore: without height:'auto' here, an interrupted duration-0
      // exit strands the exit-applied inline height: 0.
      expect(animate.height).toBe('auto')
      expect(animate.transition).toEqual({ duration: 0 })
    } finally {
      reduceState.reduce = false
    }
  })
})
