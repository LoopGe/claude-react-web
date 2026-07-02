import { useEffect, useRef, useState } from 'react'
import {
  W, H, JUMP_V,
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
    if (s.status === 'paused') { s.status = 'running'; return } // resume, no jump this press
    if (s.status === 'running' && s.player.grounded) {
      s.player.vy = JUMP_V
      s.player.grounded = false
      playBeep(audioRef, mutedRef.current)
    }
  }

  const jumpRef = useRef(jump)
  useEffect(() => { jumpRef.current = jump })

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

    const loop = () => {
      const s = stateRef.current
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
        e.preventDefault()
        jumpRef.current()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onExit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit])

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
        onClick={() => jumpRef.current()}
        onTouchStart={(e) => { e.preventDefault(); jumpRef.current() }}
      />
      <div className="easter-egg-game-toolbar">
        <button className="easter-egg-game-btn" aria-label="Toggle sound" onClick={() => setMutedAll(!mutedRef.current)}>{muted ? '🔇' : '🔊'}</button>
        <button className="easter-egg-game-btn" aria-label="Exit game" onClick={onExit}>✕ Exit</button>
      </div>
    </div>
  )
}
