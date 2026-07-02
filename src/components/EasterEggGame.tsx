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
// exported for unit tests
export const GROUND_Y = 168

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
  nightBlend: number // 0..1
  lastScoreTime: number
  frame: number
}

interface Obstacle {
  x: number
  w: number
  h: number
  kind: 'bug' | 'error' | 'warning' | 'bird'
  alt: number   // altitude above ground (0 = sits on ground)
  passed: boolean
  jumpedOver: boolean  // birds: true if the player cleared it while airborne
}

// exported for unit tests
export const PLAYER_H = 26
const PLAYER_W = 22
// exported for unit tests
export const PLAYER_X = 48
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

// exported for unit tests
export function makeInitialState(): GameState {
  return {
    status: 'ready',
    player: { y: GROUND_Y - PLAYER_H, vy: 0, grounded: true },
    speed: 4.5,
    groundOffset: 0,
    score: 0,
    obstacles: [],
    spawnIn: 60,
    nightBlend: 0,
    lastScoreTime: 0,
    frame: 0,
  }
}

// exported for unit tests
export const OBSTACLE_PROFILES = {
  bug:     { w: 26, h: 18 },
  error:   { w: 16, h: 26 },
  warning: { w: 18, h: 22 },
  bird:    { w: 24, h: 14, alt: 46 },
} as const

// Deterministic star field (LCG-seeded so positions don't jitter between frames).
const STARS: { x: number; y: number; r: number }[] = (() => {
  let seed = 1337
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const arr: { x: number; y: number; r: number }[] = []
  for (let i = 0; i < 26; i++) {
    arr.push({ x: Math.floor(rnd() * W), y: Math.floor(rnd() * (GROUND_Y - 30)) + 6, r: rnd() < 0.25 ? 1.4 : 0.8 })
  }
  return arr
})()

function spawnObstacle(s: GameState) {
  // Birds only appear after score 50, mixed in ~25% of the time. They fly at
  // an altitude the player can either pass under (grounded, no bonus) or jump
  // over (risky, +10). See the pass-scoring in updateRunning.
  const canBird = s.score > 50 && Math.random() < 0.25
  if (canBird) {
    const p = OBSTACLE_PROFILES.bird
    s.obstacles.push({ x: W + 10, w: p.w, h: p.h, kind: 'bird', alt: p.alt, passed: false, jumpedOver: false })
    return
  }
  const kinds: ('bug' | 'error' | 'warning')[] = ['bug', 'error', 'warning']
  const kind = kinds[Math.floor(Math.random() * kinds.length)]
  const p = OBSTACLE_PROFILES[kind]
  s.obstacles.push({ x: W + 10, w: p.w, h: p.h, kind, alt: 0, passed: false, jumpedOver: false })
}

// exported for unit tests
export function updateRunning(s: GameState) {
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
    const px = PLAYER_X + 3, py = s.player.y + 3
    const pw = PLAYER_W - 6, ph = PLAYER_H - 6
    const oxOverlap = px < o.x + o.w && px + pw > o.x
    // Track bird jump-over: airborne while x-overlapping. If no collision
    // follows, the player was above the bird (cleared it) → qualifies for +10.
    if (o.kind === 'bird' && !o.jumpedOver && oxOverlap && !s.player.grounded) {
      o.jumpedOver = true
    }
    if (!o.passed && o.x + o.w < PLAYER_X) {
      o.passed = true
      s.score += o.kind === 'bird' ? (o.jumpedOver ? 10 : 0) : 5
    }
    // hitbox (slightly forgiving). Obstacle spans y in
    // [GROUND_Y - o.alt - o.h, GROUND_Y - o.alt]. Player spans y in [py, py + ph].
    const oyHit = py + ph > GROUND_Y - o.alt - o.h && py < GROUND_Y - o.alt
    if (oxOverlap && oyHit) {
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

function drawObstacle(ctx: CanvasRenderingContext2D, o: Obstacle, c: { fg: string; muted: string }, frame: number) {
  const x = o.x, baseY = GROUND_Y
  ctx.save()
  if (o.kind === 'bird') {
    // Body/wings/beak are stroked with c.fg like the bug, so no extra color
    // literals are introduced here.
    const cy = baseY - o.alt - o.h / 2
    const flap = Math.sin(frame * 0.3) * 5
    ctx.strokeStyle = c.fg
    ctx.lineWidth = 1.6
    ctx.lineCap = 'round'
    // body
    ctx.beginPath()
    ctx.arc(x + o.w / 2, cy, 4, 0, Math.PI * 2)
    ctx.stroke()
    // wings (flap)
    ctx.beginPath()
    ctx.moveTo(x + o.w / 2 - 2, cy)
    ctx.lineTo(x + o.w / 2 - 10, cy - 4 - flap)
    ctx.moveTo(x + o.w / 2 + 2, cy)
    ctx.lineTo(x + o.w / 2 + 10, cy - 4 - flap)
    ctx.stroke()
    // beak
    ctx.beginPath()
    ctx.moveTo(x + o.w / 2 + 4, cy)
    ctx.lineTo(x + o.w / 2 + 8, cy + 1)
    ctx.lineTo(x + o.w / 2 + 4, cy + 2)
    ctx.stroke()
    ctx.restore()
    return
  }
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
  // (nightBlend * 0.85), so full night is an 85% darken. mixRgb guards non-hex.
  ctx.fillStyle = s.nightBlend > 0.01 ? mixRgb(c.bg, '#0b0e14', s.nightBlend * 0.85) : c.bg
  ctx.fillRect(0, 0, W, H)
  // Night sky: stars + moon, fading in with nightBlend. The `#f4f4f5` (moon/
  // stars) and `#0b0e14` (crescent shadow) literals are intentional — they
  // aren't theme tokens (no night-sky var exists), consistent with the
  // obstacle red/amber exception noted below.
  if (s.nightBlend > 0.01) {
    const a = s.nightBlend
    // moon (top-right), with a soft crescent shadow carved from the night bg.
    ctx.save()
    ctx.globalAlpha = a
    ctx.fillStyle = '#f4f4f5'
    ctx.beginPath()
    ctx.arc(W - 48, 34, 9, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = mixRgb(c.bg, '#0b0e14', s.nightBlend * 0.85)
    ctx.beginPath()
    ctx.arc(W - 44, 31, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    // stars (twinkle slightly via frame)
    ctx.save()
    ctx.fillStyle = '#f4f4f5'
    for (const st of STARS) {
      const tw = 0.6 + 0.4 * Math.sin((s.frame + st.x) * 0.05)
      ctx.globalAlpha = a * tw
      ctx.beginPath()
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }
  drawGround(ctx, s.groundOffset, c.muted)
  for (const o of s.obstacles) drawObstacle(ctx, o, c, s.frame)
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

  const colorsRef = useRef({ fg: '#333', muted: '#888', bg: '#fff' })
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
