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
const GRAVITY = 0.9
// JUMP_V is added in Task 6 when jump input is wired (noUnusedLocals flags it otherwise).

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

const OBSTACLE_PROFILES = {
  bug:     { w: 26, h: 18 },
  error:   { w: 16, h: 26 },
  warning: { w: 18, h: 22 },
} as const

function spawnObstacle(s: GameState) {
  const kinds: ('bug' | 'error' | 'warning')[] = ['bug', 'error', 'warning']
  const kind = kinds[Math.floor(Math.random() * kinds.length)]
  const p = OBSTACLE_PROFILES[kind]
  s.obstacles.push({ x: W + 10, w: p.w, h: p.h, kind, passed: false })
}

function updateRunning(s: GameState) {
  // physics
  s.player.vy += GRAVITY
  s.player.y += s.player.vy
  const floor = GROUND_Y - PLAYER_H
  if (s.player.y >= floor) {
    s.player.y = floor
    s.player.vy = 0
    s.player.grounded = true
  } else {
    s.player.grounded = false
  }
  // score over time
  const now = performance.now()
  if (now - s.lastScoreTime >= 100) {
    s.score += 1
    s.lastScoreTime = now
  }
  // difficulty ramp
  const tier = Math.floor(s.score / 100)
  s.speed = Math.min(4.5 + tier * 0.5, 11)
  // spawning
  s.spawnIn -= 1
  if (s.spawnIn <= 0) {
    spawnObstacle(s)
    const base = 90 - tier * 4
    s.spawnIn = Math.max(45, base + Math.floor(Math.random() * 40))
  }
  // move obstacles + collision + pass scoring
  for (const o of s.obstacles) o.x -= s.speed
  for (const o of s.obstacles) {
    if (!o.passed && o.x + o.w < PLAYER_X) {
      o.passed = true
      s.score += 5
    }
    // hitbox (slightly forgiving). Obstacle sits on the ground, spanning
    // y in [GROUND_Y - o.h, GROUND_Y]. Player spans y in [py, py + ph].
    const px = PLAYER_X + 3, py = s.player.y + 3
    const pw = PLAYER_W - 6, ph = PLAYER_H - 6
    const oxHit = px < o.x + o.w && px + pw > o.x
    const oyHit = py + ph > GROUND_Y - o.h // py < GROUND_Y always true
    if (oxHit && oyHit) {
      s.status = 'gameOver'
      // (high-score persistence + sound are added in Task 5)
    }
  }
  s.obstacles = s.obstacles.filter(o => o.x + o.w > -20)
}

function drawObstacle(ctx: CanvasRenderingContext2D, o: Obstacle, c: { fg: string; muted: string; accent: string }) {
  const x = o.x, baseY = GROUND_Y
  ctx.save()
  if (o.kind === 'bug') {
    ctx.strokeStyle = c.fg
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.arc(x + o.w / 2, baseY - o.h + 4, 4, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x + o.w / 2, baseY - o.h + 8)
    ctx.lineTo(x + o.w / 2, baseY)
    ctx.stroke()
  } else {
    // Intentional semantic literals: error=red, warning=amber. These are
    // not theme tokens (no red/amber exists in the var(--*) set), so they
    // bypass the "use CSS variables" convention by design-spec exception.
    const color = o.kind === 'error' ? '#e5484d' : '#f5a623'
    ctx.strokeStyle = color
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(x + o.w / 2, baseY - o.h)
    ctx.lineTo(x + o.w, baseY)
    ctx.lineTo(x, baseY)
    ctx.closePath()
    ctx.stroke()
    ctx.fillStyle = color
    ctx.font = 'bold 11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('!', x + o.w / 2, baseY - 4)
  }
  ctx.restore()
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
  for (const o of s.obstacles) drawObstacle(ctx, o, c)
  drawSparkle(ctx, PLAYER_X + PLAYER_W / 2, s.player.y + PLAYER_H / 2, 9, c.fg)
  ctx.fillStyle = c.muted
  ctx.font = '12px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('Score ' + s.score, 12, 20)
  ctx.textAlign = 'center'
  if (s.status === 'ready') {
    ctx.fillText('Press Space / Click to start', W / 2, 40)
  } else if (s.status === 'gameOver') {
    ctx.fillStyle = c.fg
    ctx.font = 'bold 16px system-ui, sans-serif'
    ctx.fillText('Game Over', W / 2, 40)
    ctx.fillStyle = c.muted
    ctx.font = '12px system-ui, sans-serif'
    ctx.fillText('Press Space / Click to restart', W / 2, 60)
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
      if (s.status === 'running') {
        updateRunning(s)
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
