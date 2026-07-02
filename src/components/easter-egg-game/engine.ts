// Pure, React-free game engine for the hidden easter-egg mini-game
// (a Chrome-offline-dino-style endless runner themed after this app).
// Extracted from EasterEggGame.tsx so that file exports only the React
// component (react-refresh/only-export-components). See
// docs/superpowers/specs/2026-07-02-easter-egg-dino-game-design.md.

export const W = 600
export const H = 200
// exported for unit tests
export const GROUND_Y = 168

export type Status = 'ready' | 'running' | 'paused' | 'gameOver'

export interface Player {
  y: number // top of sprite; ground = GROUND_Y - PLAYER_H
  vy: number
  grounded: boolean
  holding: boolean     // variable jump: button held while ascending
  holdFrames: number   // frames of boost applied so far (caps at MAX_HOLD_FRAMES)
}

export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  color: string
}

export interface Firework {
  phase: 'rising' | 'burst'
  x: number
  y: number
  vy: number
  targetY: number
  color: string
  particles: Particle[]
}

export interface GameState {
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
  fireworks: Firework[]
  prevTier: number
  fireworkBurstsLeft: number
  fireworkCooldown: number
}

export interface Obstacle {
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
export const PLAYER_W = 22
// exported for unit tests
export const PLAYER_X = 48
export const GRAVITY = 0.9
export const JUMP_V = -13.5
export const JUMP_V_MIN = -9.5       // tap (short hop)
export const MAX_HOLD_FRAMES = 10    // frames of boost to reach full jump
export const JUMP_BOOST_PER_FRAME = (JUMP_V - JUMP_V_MIN) / MAX_HOLD_FRAMES

// --- Persisted high score + mute preference ---------------------------------
export const HI_KEY = 'crw_easter_egg_hi'
export const MUTE_KEY = 'crw_easter_egg_muted'

export function readHi(): number {
  try { return parseInt(localStorage.getItem(HI_KEY) || '0', 10) || 0 } catch { return 0 }
}
export function writeHi(v: number) {
  try { localStorage.setItem(HI_KEY, String(v)) } catch { /* ignore */ }
}
export function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
}
export function writeMuted(v: boolean) {
  try { localStorage.setItem(MUTE_KEY, v ? '1' : '0') } catch { /* ignore */ }
}

// --- Color mixing (for day/night background blend) --------------------------
export function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
// mixRgb blends hex color `a` toward hex color `b` by `t`. If either input is
// not a hex string (e.g. theme resolved to `rgb(...)`), returns `a` unchanged
// so canvas fillStyle stays valid (no `rgb(NaN,...)`).
export function mixRgb(a: string, b: string, t: number): string {
  if (!a.startsWith('#') || !b.startsWith('#')) return a
  const [r1, g1, b1] = hexToRgb(a); const [r2, g2, b2] = hexToRgb(b)
  return `rgb(${Math.round(lerp(r1, r2, t))},${Math.round(lerp(g1, g2, t))},${Math.round(lerp(b1, b2, t))})`
}

// --- WebAudio (crash sound + jump beep) ---
export type AudioRef = { current: AudioContext | null }

export function ensureAudioContext(audioRef: AudioRef): AudioContext | null {
  if (audioRef.current) {
    // Browsers auto-suspend the AudioContext when the tab is backgrounded; if
    // we never resume() it, every subsequent beep/crash is silent. Resume on
    // each use (a no-op when already running) so SFX come back after the user
    // returns to the tab. Fire-and-forget — the call needs a user gesture,
    // which playBeep/playCrashSound always run inside.
    if (audioRef.current.state === 'suspended') {
      void audioRef.current.resume().catch(() => {})
    }
    return audioRef.current
  }
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    const ac = new Ctor()
    audioRef.current = ac
    if (ac.state === 'suspended') void ac.resume().catch(() => {})
    return ac
  } catch { return null }
}

export function playCrashSound(audioRef: AudioRef, muted: boolean) {
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
export function playBeep(audioRef: AudioRef, muted: boolean) {
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
    player: { y: GROUND_Y - PLAYER_H, vy: 0, grounded: true, holding: false, holdFrames: 0 },
    speed: 4.5,
    groundOffset: 0,
    score: 0,
    obstacles: [],
    spawnIn: 60,
    nightBlend: 0,
    lastScoreTime: 0,
    frame: 0,
    fireworks: [],
    prevTier: 0,
    fireworkBurstsLeft: 0,
    fireworkCooldown: 0,
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
export const STARS: { x: number; y: number; r: number }[] = (() => {
  let seed = 1337
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const arr: { x: number; y: number; r: number }[] = []
  for (let i = 0; i < 26; i++) {
    arr.push({ x: Math.floor(rnd() * W), y: Math.floor(rnd() * (GROUND_Y - 30)) + 6, r: rnd() < 0.25 ? 1.4 : 0.8 })
  }
  return arr
})()

export function spawnObstacle(s: GameState) {
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

// Firework burst colors. Intentional festive literals, not theme tokens (no
// celebration-sky var exists) — spec exception like the obstacle red/amber set.
const FIREWORK_COLORS = ['#ff5a5a', '#ffd166', '#06d6a0', '#4cc9f0', '#f4f4f5']
function spawnFirework(s: GameState) {
  const x = 80 + Math.random() * (W - 160)
  const targetY = 20 + Math.random() * 70
  const color = FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)]
  s.fireworks.push({
    phase: 'rising',
    x,
    y: GROUND_Y,
    vy: -(3.5 + Math.random() * 1.5),
    targetY,
    color,
    particles: [],
  })
}

// exported for unit tests
export function updateRunning(s: GameState) {
  // physics
  s.player.vy += GRAVITY
  // Variable jump: while the jump button is held and the player is still
  // ascending, add lift up to MAX_HOLD_FRAMES (tap = JUMP_V_MIN, hold = JUMP_V).
  if (s.player.holding && s.player.vy < 0 && s.player.holdFrames < MAX_HOLD_FRAMES) {
    s.player.vy += JUMP_BOOST_PER_FRAME
    s.player.holdFrames += 1
  }
  s.player.y += s.player.vy
  const floor = GROUND_Y - PLAYER_H
  if (s.player.y >= floor) {
    s.player.y = floor
    s.player.vy = 0
    s.player.grounded = true
    s.player.holding = false
    s.player.holdFrames = 0
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
    const oxOverlap = px < o.x + o.w - 2 && px + pw > o.x + 2
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
    const oyHit = py + ph > GROUND_Y - o.alt - o.h + 2 && py < GROUND_Y - o.alt - 2
    if (oxOverlap && oyHit) {
      s.status = 'gameOver'
      // (high-score persistence + sound are handled in the rAF loop where
      // component refs are in scope; kept out of this pure physics fn.)
      break
    }
  }
  s.obstacles = s.obstacles.filter(o => o.x + o.w > -20)
  // Fireworks: trigger when entering the first night of each 1000-point block
  // (tier 1, 11, 21, … = tier % 10 === 1). Stagger 5 bursts over ~2s.
  if (tier !== s.prevTier && tier % 10 === 1) {
    s.fireworkBurstsLeft = 5
    s.fireworkCooldown = 0
  }
  s.prevTier = tier
  if (s.fireworkBurstsLeft > 0) {
    s.fireworkCooldown -= 1
    if (s.fireworkCooldown <= 0) {
      spawnFirework(s)
      s.fireworkBurstsLeft -= 1
      s.fireworkCooldown = 22
    }
  }
  // update fireworks: rising shells ascend leaving a trail, then burst into
  // randomized particle clouds (varied count + speed → not the same each time).
  for (const fw of s.fireworks) {
    if (fw.phase === 'rising') {
      fw.y += fw.vy
      // trail spark
      fw.particles.push({
        x: fw.x + (Math.random() - 0.5) * 2,
        y: fw.y,
        vx: 0,
        vy: 0.3,
        life: 12,
        maxLife: 12,
        color: fw.color,
      })
      if (fw.y <= fw.targetY) {
        fw.phase = 'burst'
        const count = 20 + Math.floor(Math.random() * 12) // 20–31
        const baseSpeed = 1.2 + Math.random() * 1.6
        for (let i = 0; i < count; i++) {
          const ang = (Math.PI * 2 * i) / count + Math.random() * 0.3
          const sp = baseSpeed * (0.6 + Math.random() * 0.8)
          const life = 40 + Math.floor(Math.random() * 20)
          fw.particles.push({
            x: fw.x,
            y: fw.y,
            vx: Math.cos(ang) * sp,
            vy: Math.sin(ang) * sp,
            life,
            maxLife: life,
            color: fw.color,
          })
        }
      }
    } else {
      for (const p of fw.particles) {
        p.vy += 0.08
        p.x += p.vx
        p.y += p.vy
        p.life -= 1
      }
      fw.particles = fw.particles.filter(p => p.life > 0 && p.y < GROUND_Y)
    }
  }
  s.fireworks = s.fireworks.filter(fw => fw.phase === 'rising' || fw.particles.length > 0)
  // day/night blend — smooth lerp toward the tier-parity target. The loop
  // snaps this instantly when prefers-reduced-motion is set.
  const nightTarget = tier % 2 === 1 ? 1 : 0
  s.nightBlend = lerp(s.nightBlend, nightTarget, 0.02)
}

export function drawObstacle(ctx: CanvasRenderingContext2D, o: Obstacle, c: { fg: string; muted: string }, frame: number) {
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
    // body: fills the height of the box
    ctx.beginPath()
    ctx.ellipse(x + o.w / 2, cy, 5, o.h / 2 - 1, 0, 0, Math.PI * 2)
    ctx.stroke()
    // wings span the width, flapping
    ctx.beginPath()
    ctx.moveTo(x + o.w / 2 - 4, cy)
    ctx.lineTo(x + 1, cy - 3 - flap)
    ctx.moveTo(x + o.w / 2 + 4, cy)
    ctx.lineTo(x + o.w - 1, cy - 3 - flap)
    ctx.stroke()
    // beak
    ctx.beginPath()
    ctx.moveTo(x + o.w / 2 + 5, cy)
    ctx.lineTo(x + o.w / 2 + 9, cy + 1)
    ctx.lineTo(x + o.w / 2 + 5, cy + 2)
    ctx.stroke()
    ctx.restore()
    return
  }
  if (o.kind === 'bug') {
    // Body fills the w×h box so the visible size matches the hitbox.
    const bx = x + o.w / 2
    const by = baseY - o.h / 2
    ctx.strokeStyle = c.fg
    ctx.lineWidth = 1.6
    // body
    ctx.beginPath()
    ctx.ellipse(bx, by, o.w / 2 - 2, o.h / 2 - 1, 0, 0, Math.PI * 2)
    ctx.stroke()
    // legs
    ctx.beginPath()
    ctx.moveTo(bx - o.w / 2 + 3, by - 1); ctx.lineTo(bx - o.w / 2 - 2, by + 3)
    ctx.moveTo(bx - o.w / 2 + 3, by + 1); ctx.lineTo(bx - o.w / 2 - 2, by + 5)
    ctx.moveTo(bx + o.w / 2 - 3, by - 1); ctx.lineTo(bx + o.w / 2 + 2, by + 3)
    ctx.moveTo(bx + o.w / 2 - 3, by + 1); ctx.lineTo(bx + o.w / 2 + 2, by + 5)
    ctx.stroke()
    // antennae
    ctx.beginPath()
    ctx.moveTo(bx - 3, by - o.h / 2 + 2); ctx.lineTo(bx - 5, by - o.h / 2 - 3)
    ctx.moveTo(bx + 3, by - o.h / 2 + 2); ctx.lineTo(bx + 5, by - o.h / 2 - 3)
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

export function drawSparkle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
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

export function drawGround(ctx: CanvasRenderingContext2D, offset: number, color: string) {
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

export interface ThemeColors {
  fg: string
  muted: string
  bg: string
}

export function renderFrame(
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
  // Fireworks (celebration on the first night of each 1000-point block).
  if (s.fireworks.length > 0) {
    ctx.save()
    for (const fw of s.fireworks) {
      // rising shell: a bright dot at the shell position
      if (fw.phase === 'rising') {
        ctx.globalAlpha = 1
        ctx.fillStyle = fw.color
        ctx.beginPath()
        ctx.arc(fw.x, fw.y, 2.4, 0, Math.PI * 2)
        ctx.fill()
      }
      // trail + burst particles
      for (const p of fw.particles) {
        ctx.globalAlpha = Math.max(0, p.life / p.maxLife)
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2)
        ctx.fill()
      }
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
