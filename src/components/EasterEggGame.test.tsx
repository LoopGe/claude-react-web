import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EasterEggGame } from './EasterEggGame'
import { updateRunning, makeInitialState, GROUND_Y, OBSTACLE_PROFILES } from './easter-egg-game/engine'

describe('EasterEggGame', () => {
  it('renders the canvas and a close button that calls onExit', () => {
    const onExit = vi.fn()
    const { container, unmount } = render(<EasterEggGame onExit={onExit} />)
    expect(container.querySelector('canvas')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Exit game'))
    expect(onExit).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('renders a ready-state prompt', () => {
    render(<EasterEggGame onExit={vi.fn()} />)
    // The ready prompt is drawn on canvas (not DOM text), so just assert the
    // game container renders. (Canvas text isn't queryable in jsdom.)
    expect(document.querySelector('.easter-egg-game')).toBeTruthy()
  })
})

describe('updateRunning scoring', () => {
  // Run updateRunning frames until the obstacle is past the player (culled)
  // or the game ends. `opts.forceY`, if set, pins the player's y each frame
  // before updateRunning to simulate a held jump or grounded stance.
  function runUntilPast(opts: {
    kind: 'bug' | 'error' | 'warning' | 'bird'
    forceY?: number | null
  }) {
    const s = makeInitialState()
    s.status = 'running'
    s.lastScoreTime = performance.now() // suppress time-based +1
    s.spawnIn = 1e9 // suppress new spawns during the test
    const p = OBSTACLE_PROFILES[opts.kind]
    s.obstacles = [{
      x: 610, w: p.w, h: p.h, kind: opts.kind,
      alt: opts.kind === 'bird' ? (p as { alt?: number }).alt ?? 0 : 0,
      passed: false, jumpedOver: false,
    } as ReturnType<typeof makeInitialState>['obstacles'][number]]
    for (let i = 0; i < 400 && s.obstacles.length > 0; i++) {
      if (opts.forceY != null) {
        s.player.y = opts.forceY
        s.player.vy = 0
        s.player.grounded = false
      }
      updateRunning(s)
      // `updateRunning` may mutate s.status to 'gameOver', but TS keeps the
      // post-assignment narrowing of 'running' since it can't see through the
      // call — cast to widen.
      if ((s.status as string) === 'gameOver') break
    }
    return s
  }

  it('ground obstacle passed gives +5', () => {
    // A grounded player collides with the bug (player y-band overlaps the
    // bug's), so pin the player airborne above the bug's height band
    // [GROUND_Y - h, GROUND_Y] = [150, 168]. y=100 → py=103, py+ph=123 < 150.
    const s = runUntilPast({ kind: 'bug', forceY: 100 })
    expect(s.status).toBe('running')
    expect(s.score).toBe(5)
  })

  it('bird passed under (grounded) gives +0', () => {
    const s = runUntilPast({ kind: 'bird' }) // grounded player passes under
    expect(s.status).toBe('running')
    expect(s.score).toBe(0)
  })

  it('bird jumped over (airborne above it) gives +10', () => {
    // Pin the player high enough to clear the bird's altitude band
    // [GROUND_Y - alt - h, GROUND_Y - alt] = [108, 122]. y=20 is well above.
    const s = runUntilPast({ kind: 'bird', forceY: 20 })
    expect(s.status).toBe('running')
    expect(s.score).toBe(10)
  })

  it('bird struck mid-air ends the game with no pass bonus', () => {
    // Pin the player inside the bird's altitude band so it collides.
    const s = runUntilPast({ kind: 'bird', forceY: GROUND_Y - 60 })
    expect(s.status).toBe('gameOver')
    expect(s.score).toBe(0)
  })
})
