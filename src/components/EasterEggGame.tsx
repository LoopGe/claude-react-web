import { useEffect, useRef, useState } from 'react'

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
const JUMP_V = -13.5

// --- Persisted high score + mute preference ---------------------------------
const HI_KEY = 'crw_easter_egg_hi'
const MUTE_KEY = 'crw_easter_egg_muted'

function readHi(): number {
  try { return parseInt(localStorage.getItem(HI_KEY) || '0', 10) || 0 } catch { return 0 }
}
function writeHi(v: number) {
  try { localStorage.setItem(HI_KEY, String(v)) } catch { /* ignore */ }
}
function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
}
function writeMuted(v: boolean) {
  try { localStorage.setItem(MUTE_KEY, v ? '1' : '0') } catch { /* ignore */ }
}

// --- Color mixing (for day/night background blend) --------------------------
function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
// mixRgb blends hex color `a` toward hex color `b` by `t`. If either input is
// not a hex string (e.g. theme resolved to `rgb(...)`), returns `a` unchanged
// so canvas fillStyle stays valid (no `rgb(NaN,...)`).
function mixRgb(a: string, b: string, t: number): string {
  if (!a.startsWith('#') || !b.startsWith('#')) return a
  const [r1, g1, b1] = hexToRgb(a); const [r2, g2, b2] = hexToRgb(b)
  return `rgb(${Math.round(lerp(r1, r2, t))},${Math.round(lerp(g1, g2, t))},${Math.round(lerp(b1, b2, t))})`
}

// --- WebAudio (crash sound + jump beep) ---
type AudioRef = { current: AudioContext | null }

function ensureAudioContext(audioRef: AudioRef): AudioContext | null {
  if (audioRef.current) return audioRef.current
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    audioRef.current = new Ctor()
    return audioRef.current
  } catch { return null }
}

function playCrashSound(audioRef: AudioRef, muted: boolean) {
  if (muted) return
  const ac = ensureAudioContext(audioRef)
  if (!ac) return
  try {
    const buf = ac.createBuffer(1, ac.sampleRate * 0.25, ac.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
    const src = ac.createBufferSource(); src.buffer = buf
    const gain = ac.createGain(); gain.gain.value = 0.12
    src.connect(gain); gain.connect(ac.destination)
    src.start()
  } catch { /* ignore */ }
}

// Short ~660Hz square-wave blip for jumps. Mirrors playCrashSound's shape
// (generic AudioRef + muted flag) so it can be called from the component
// without touching AudioContext directly.
function playBeep(audioRef: AudioRef, muted: boolean) {
  if (muted) return
  const ac = ensureAudioContext(audioRef)
  if (!ac) return
  try {
    const osc = ac.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 660
    const gain = ac.createGain()
    gain.gain.setValueAtTime(0.08, ac.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.12)
    osc.connect(gain); gain.connect(ac.destination)
    osc.start()
    osc.stop(ac.currentTime + 0.12)
  } catch { /* ignore */ }
}

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
      // (high-score persistence + sound are handled in the rAF loop where
      // component refs are in scope; kept out of this pure physics fn.)
      break
    }
  }
  s.obstacles = s.obstacles.filter(o => o.x + o.w > -20)
  // day/night blend — smooth lerp toward the tier-parity target. The loop
  // snaps this instantly when prefers-reduced-motion is set.
  const nightTarget = tier % 2 === 1 ? 1 : 0
  s.nightBlend = lerp(s.nightBlend, nightTarget, 0.02)
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

function renderFrame(
  ctx: CanvasRenderingContext2D,
  s: GameState,
  c: ThemeColors,
  hi: number,
  newBest: boolean,
) {
  ctx.clearRect(0, 0, W, H)
  // Day/night background. `#0b0e14` is an intentional fixed darkening target
  // (not a theme token — no night-specific var exists); spec exception like
  // the obstacle red/amber literals. One-step blend: bg toward #0b0e14 by
  // (nightBlend * 0.6), so full night is a 60% darken. mixRgb guards non-hex.
  ctx.fillStyle = s.nightBlend > 0.01 ? mixRgb(c.bg, '#0b0e14', s.nightBlend * 0.6) : c.bg
  ctx.fillRect(0, 0, W, H)
  drawGround(ctx, s.groundOffset, c.muted)
  for (const o of s.obstacles) drawObstacle(ctx, o, c)
  drawSparkle(ctx, PLAYER_X + PLAYER_W / 2, s.player.y + PLAYER_H / 2, 9, c.fg)
  ctx.fillStyle = c.muted
  ctx.font = '12px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('Score ' + s.score, 12, 20)
  ctx.textAlign = 'right'
  ctx.fillText('Best ' + hi, W - 12, 20)
  ctx.textAlign = 'center'
  if (s.status === 'ready') {
    ctx.fillText('Press Space / Click to start', W / 2, 40)
  } else if (s.status === 'paused') {
    ctx.fillStyle = c.fg
    ctx.fillText('Paused', W / 2, 70)
    ctx.fillStyle = c.muted
    ctx.fillText('Click or press Space to resume', W / 2, 90)
  } else if (s.status === 'gameOver') {
    ctx.fillStyle = c.fg
    ctx.font = 'bold 16px system-ui, sans-serif'
    ctx.fillText('Game Over', W / 2, 40)
    ctx.fillStyle = c.muted
    ctx.font = '12px system-ui, sans-serif'
    ctx.fillText(newBest ? 'NEW BEST!' : 'Best ' + hi, W / 2, 58)
    ctx.fillText('Press Space / Click to restart', W / 2, 76)
  }
}

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
    if (startRunning) next.status = 'running'
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
