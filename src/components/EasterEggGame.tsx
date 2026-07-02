import { useEffect, useRef, useState } from 'react'
import {
  W, H, JUMP_V_MIN,
  makeInitialState, updateRunning, renderFrame,
  playBeep, playCrashSound,
  readHi, writeHi, readMuted, writeMuted,
  type Status, type GameState, type ThemeColors,
} from './easter-egg-game/engine'

// Hidden easter-egg mini-game: a Chrome-offline-dino-style endless runner
// themed after this app. The player is the same sparkle glyph used in the
// empty state; obstacles are bugs / errors / warnings. See
// docs/superpowers/specs/2026-07-02-easter-egg-dino-game-design.md.
//
// Self-contained: pure canvas + rAF + WebAudio + localStorage. No props
// beyond onExit. Scoped per MessageList instance. Pure game logic lives in
// ./easter-egg-game/engine.ts; this file holds only the React component.

export function EasterEggGame({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<GameState>(makeInitialState())
  const rafRef = useRef<number | null>(null)

  const audioRef = useRef<AudioContext | null>(null)
  const [muted, setMuted] = useState(readMuted())
  const mutedRef = useRef(readMuted())
  const hiRef = useRef(readHi())
  const newBestRef = useRef(false)
  const reducedMotionRef = useRef(
    typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  const setMutedAll = (v: boolean) => { mutedRef.current = v; setMuted(v); writeMuted(v) }

  function resetGame(startRunning: boolean) {
    const next = makeInitialState()
    if (startRunning) {
      next.status = 'running'
      next.lastScoreTime = performance.now()
    }
    stateRef.current = next
    newBestRef.current = false
  }

  function jump() {
    const s = stateRef.current
    if (s.status === 'ready') { s.status = 'running'; s.lastScoreTime = performance.now() }
    if (s.status === 'gameOver') { resetGame(true); return }
    if (s.status === 'paused') { s.status = 'running'; return }
    if (s.status === 'running' && s.player.grounded) {
      s.player.vy = JUMP_V_MIN
      s.player.grounded = false
      s.player.holding = true
      s.player.holdFrames = 0
      playBeep(audioRef, mutedRef.current)
    }
  }

  function releaseJump() {
    const s = stateRef.current
    if (s.status === 'running') s.player.holding = false
  }

  const jumpRef = useRef(jump)
  useEffect(() => { jumpRef.current = jump })
  const releaseJumpRef = useRef(releaseJump)
  useEffect(() => { releaseJumpRef.current = releaseJump })

  const colorsRef = useRef<ThemeColors>({ fg: '#333', muted: '#888', bg: '#fff' })
  useEffect(() => {
    const el = document.documentElement
    const cs = getComputedStyle(el)
    colorsRef.current = {
      fg: cs.getPropertyValue('--fg').trim() || '#333',
      muted: cs.getPropertyValue('--fg-muted').trim() || '#888',
      bg: cs.getPropertyValue('--bg').trim() || '#fff',
    }
  }, [])

  // Close the AudioContext on unmount so repeated open/close of the game
  // doesn't leak contexts (browsers cap concurrent instances).
  useEffect(() => () => { void audioRef.current?.close().catch(() => {}) }, [])

  // main loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)

    // Fixed-timestep simulation: updateRunning is a per-frame fixed-delta step
    // (gravity/obstacle motion/spawn timing all assume ~60fps). Driving it once
    // per rAF makes the whole sim run 2-2.4x faster on 120/144Hz displays while
    // score accrues on real time — unplayable on high-refresh screens. Instead
    // accumulate real elapsed time and step the sim at a fixed 1000/60ms, so
    // the number of physics steps per second is display-independent. Render
    // once per rAF. Clamp large gaps (tab was backgrounded) so we don't run a
    // huge catch-up burst, and cap steps/frame to avoid a spiral of death.
    const STEP_MS = 1000 / 60
    let last = performance.now()
    let acc = 0
    const loop = (now: number) => {
      const s = stateRef.current
      let dt = now - last
      last = now
      if (dt > 200) dt = STEP_MS // tab was away — don't catch up a multi-second burst
      acc += dt
      let steps = 0
      while (acc >= STEP_MS && steps < 5) {
        s.frame += 1
        if (s.status === 'ready' || s.status === 'running') {
          s.groundOffset = (s.groundOffset + s.speed) % 10000
        }
        if (s.status === 'running') {
          const before = s.status
          updateRunning(s)
          const after = s.status as Status
          // reduced-motion: snap day/night instead of the smooth lerp.
          if (reducedMotionRef.current) {
            s.nightBlend = Math.floor(s.score / 100) % 2
          }
          // running → gameOver transition: record high score + play crash.
          if (before === 'running' && after === 'gameOver') {
            if (s.score > hiRef.current) {
              hiRef.current = s.score
              writeHi(s.score)
              newBestRef.current = true
            } else {
              newBestRef.current = false
            }
            playCrashSound(audioRef, mutedRef.current)
          }
        }
        acc -= STEP_MS
        steps += 1
      }
      if (steps >= 5) acc = 0 // discard leftover instead of spiraling
      renderFrame(ctx, s, colorsRef.current, hiRef.current, newBestRef.current)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [])

  // keyboard: Space/Up to jump, Escape to exit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.key === 'ArrowUp' || e.key === ' ') {
        if (e.repeat) return
        e.preventDefault()
        jumpRef.current()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onExit()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.key === 'ArrowUp' || e.key === ' ') {
        releaseJumpRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [onExit])

  // Release the variable-jump hold on pointer up anywhere (not just on the
  // canvas), so the jump cuts correctly even if the pointer drags off-canvas.
  useEffect(() => {
    const onUp = () => releaseJumpRef.current()
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchend', onUp)
    window.addEventListener('touchcancel', onUp)
    return () => {
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchend', onUp)
      window.removeEventListener('touchcancel', onUp)
    }
  }, [])

  // auto-pause when the user clicks outside this panel or the window loses focus
  useEffect(() => {
    const root = canvasRef.current
    const panel = root?.closest('.chat-panel')
    const onMouseDown = (e: MouseEvent) => {
      if (stateRef.current.status !== 'running') return
      if (panel && !panel.contains(e.target as Node)) {
        stateRef.current.status = 'paused'
      }
    }
    const onBlur = () => {
      if (stateRef.current.status === 'running') {
        stateRef.current.status = 'paused'
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('blur', onBlur)
    }
    // refs are stable and the panel is resolved once at mount
  }, [])

  return (
    <div className="easter-egg-game">
      <canvas
        ref={canvasRef}
        aria-label="Easter egg sparkle dino game"
        onMouseDown={() => jumpRef.current()}
        onTouchStart={(e) => { e.preventDefault(); jumpRef.current() }}
      />
      <div className="easter-egg-game-toolbar">
        <button className="easter-egg-game-btn" aria-label="Toggle sound" onClick={() => setMutedAll(!mutedRef.current)}>{muted ? '🔇' : '🔊'}</button>
        <button className="easter-egg-game-btn" aria-label="Exit game" onClick={onExit}>✕ Exit</button>
      </div>
    </div>
  )
}
