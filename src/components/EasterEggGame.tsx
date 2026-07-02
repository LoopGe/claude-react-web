import { useEffect, useRef } from 'react'

// Hidden easter-egg mini-game: a Chrome-offline-dino-style endless runner
// themed after this app. The player is the same sparkle glyph used in the
// empty state; obstacles are bugs / errors / warnings. See
// docs/superpowers/specs/2026-07-02-easter-egg-dino-game-design.md.
//
// Self-contained: pure canvas + rAF + WebAudio + localStorage. No props
// beyond onExit. Scoped per MessageList instance.

const W = 600
const H = 200
const GROUND_Y = 168

type Status = 'ready' | 'running' | 'paused' | 'gameOver'

interface Player {
  y: number // top of sprite; ground = GROUND_Y - PLAYER_H
  vy: number
  grounded: boolean
}

interface GameState {
  status: Status
  player: Player
  speed: number
  groundOffset: number
  score: number
  obstacles: Obstacle[]
  spawnIn: number
  night: boolean
  nightBlend: number // 0..1
  lastScoreTime: number
}

interface Obstacle {
  x: number
  w: number
  h: number
  kind: 'bug' | 'error' | 'warning'
  passed: boolean
}

const PLAYER_H = 26
const PLAYER_W = 22
const PLAYER_X = 48

function makeInitialState(): GameState {
  return {
    status: 'ready',
    player: { y: GROUND_Y - PLAYER_H, vy: 0, grounded: true },
    speed: 4.5,
    groundOffset: 0,
    score: 0,
    obstacles: [],
    spawnIn: 60,
    night: false,
    nightBlend: 0,
    lastScoreTime: 0,
  }
}

function drawSparkle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.6
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx, cy - r)
  ctx.lineTo(cx, cy + r)
  ctx.moveTo(cx - r, cy)
  ctx.lineTo(cx + r, cy)
  ctx.moveTo(cx - r * 0.7, cy - r * 0.7)
  ctx.lineTo(cx + r * 0.7, cy + r * 0.7)
  ctx.moveTo(cx + r * 0.7, cy - r * 0.7)
  ctx.lineTo(cx - r * 0.7, cy + r * 0.7)
  ctx.stroke()
  ctx.restore()
}

function drawGround(ctx: CanvasRenderingContext2D, offset: number, color: string) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.setLineDash([6, 6])
  ctx.lineDashOffset = -offset
  ctx.beginPath()
  ctx.moveTo(0, GROUND_Y + 14)
  ctx.lineTo(W, GROUND_Y + 14)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = 0.5
  for (let x = -((offset) % 24); x < W; x += 24) {
    ctx.beginPath()
    ctx.moveTo(x, GROUND_Y + 18)
    ctx.lineTo(x, GROUND_Y + 26)
    ctx.stroke()
  }
  ctx.restore()
}

interface ThemeColors {
  fg: string
  muted: string
  bg: string
  accent: string
}

function renderFrame(ctx: CanvasRenderingContext2D, s: GameState, c: ThemeColors) {
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = c.bg
  ctx.fillRect(0, 0, W, H)
  drawGround(ctx, s.groundOffset, c.muted)
  drawSparkle(ctx, PLAYER_X + PLAYER_W / 2, s.player.y + PLAYER_H / 2, 9, c.fg)
  ctx.fillStyle = c.muted
  ctx.font = '12px system-ui, sans-serif'
  ctx.textAlign = 'center'
  if (s.status === 'ready') {
    ctx.fillText('Press Space / Click to start', W / 2, 40)
  }
}

export function EasterEggGame({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<GameState>(makeInitialState())
  const rafRef = useRef<number | null>(null)

  const colorsRef = useRef({ fg: '#333', muted: '#888', bg: '#fff', accent: '#0a0' })
  useEffect(() => {
    const el = document.documentElement
    const cs = getComputedStyle(el)
    colorsRef.current = {
      fg: cs.getPropertyValue('--fg').trim() || '#333',
      muted: cs.getPropertyValue('--fg-muted').trim() || '#888',
      bg: cs.getPropertyValue('--bg').trim() || '#fff',
      accent: cs.getPropertyValue('--accent').trim() || '#0a0',
    }
  }, [])

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
      if (s.status === 'ready' || s.status === 'running') {
        s.groundOffset = (s.groundOffset + s.speed) % 10000
      }
      renderFrame(ctx, s, colorsRef.current)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [])

  return (
    <div className="easter-egg-game">
      <canvas
        ref={canvasRef}
        aria-label="Easter egg sparkle dino game"
      />
      <div className="easter-egg-game-toolbar">
        <button className="easter-egg-game-btn" aria-label="Exit game" onClick={onExit}>✕ Exit</button>
      </div>
    </div>
  )
}
