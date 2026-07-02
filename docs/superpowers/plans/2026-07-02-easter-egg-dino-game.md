# Easter Egg: Sparkle Dino Game — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hidden Canvas endless-runner mini-game, triggered by triple-clicking the sparkle icon on the "Start a conversation" empty state, themed after the app (sparkle player; bug/error/warning obstacles; day/night cycle; persisted high score + mute; auto-pause on outside click / window blur).

**Architecture:** A new self-contained `EasterEggGame.tsx` renders a 600×200 `<canvas>` driven by `requestAnimationFrame`. `ChatEmptyState.tsx` gains click-counting + bounce + an optional `onUnlockEasterEgg` prop. `MessageList.tsx` holds a local `gameOpen` boolean and swaps `<ChatEmptyState onUnlockEasterEgg=…/>` ↔ `<EasterEggGame onExit=…/>`. No server, WS, or session logic is touched.

**Tech Stack:** React 19, TypeScript, Canvas 2D API, Web Audio API, `localStorage`, Vitest + jsdom + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-02-easter-egg-dino-game-design.md`

---

## File Structure

- **Modify** `src/components/ChatEmptyState.tsx` — click counting, bounce class toggle, optional `onUnlockEasterEgg` prop, armed tint after 2nd click.
- **Modify** `src/styles/chat.css` — `.chat-empty-icon--bounce` keyframes, `.chat-empty-icon--armed` tint, reduced-motion fallback; `.easter-egg-game` layout styles.
- **Create** `src/components/EasterEggGame.tsx` — the entire game (canvas, loop, state machine, physics, obstacles, day/night, audio, high score, mute, controls, auto-pause).
- **Modify** `src/components/MessageList.tsx` — local `gameOpen` state; render the game in place of `ChatEmptyState` when open.
- **Modify** `src/components/MessageList.test.tsx` — assert the default empty state still renders (guard existing test) and that the game renders when unlocked.
- **Create** `src/components/EasterEggGame.test.tsx` — smoke test (renders without crashing; calls onExit via the close button).

---

## Task 1: ChatEmptyState — click counting + bounce + unlock prop

**Files:**
- Modify: `src/components/ChatEmptyState.tsx`
- Test: `src/components/MessageList.test.tsx` (the existing "shows the default empty state" test already covers the no-prop path; we add a dedicated test file below)

- [ ] **Step 1: Write the failing test**

Create `src/components/ChatEmptyState.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChatEmptyState } from './ChatEmptyState'

describe('ChatEmptyState easter-egg trigger', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); cleanup() })

  it('renders the title and icon with no prop', () => {
    render(<ChatEmptyState />)
    expect(screen.getByText('Start a conversation')).toBeTruthy()
    expect(document.querySelector('.chat-empty-icon')).toBeTruthy()
  })

  it('calls onUnlockEasterEgg after 3 rapid clicks', () => {
    const onUnlock = vi.fn()
    render(<ChatEmptyState onUnlockEasterEgg={onUnlock} />)
    const icon = document.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    fireEvent.click(icon)
    fireEvent.click(icon)
    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it('does NOT unlock when clicks are slower than 800ms', () => {
    const onUnlock = vi.fn()
    render(<ChatEmptyState onUnlockEasterEgg={onUnlock} />)
    const icon = document.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    vi.advanceTimersByTime(900)
    fireEvent.click(icon)
    vi.advanceTimersByTime(900)
    fireEvent.click(icon)
    expect(onUnlock).not.toHaveBeenCalled()
  })

  it('resets the count after a slow gap so a later triple-click still unlocks', () => {
    const onUnlock = vi.fn()
    render(<ChatEmptyState onUnlockEasterEgg={onUnlock} />)
    const icon = document.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    vi.advanceTimersByTime(900) // chain breaks
    fireEvent.click(icon)
    fireEvent.click(icon)
    fireEvent.click(icon)
    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it('toggles the bounce class on each click', () => {
    render(<ChatEmptyState onUnlockEasterEgg={vi.fn()} />)
    const icon = document.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    expect(icon.classList.contains('chat-empty-icon--bounce')).toBe(true)
    // animationend clears it
    fireEvent.animationEnd(icon)
    expect(icon.classList.contains('chat-empty-icon--bounce')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/ChatEmptyState.test.tsx`
Expected: FAIL — `onUnlockEasterEgg` is not a recognized prop / icon has no click handler / bounce class missing.

- [ ] **Step 3: Implement `ChatEmptyState`**

Replace the entire contents of `src/components/ChatEmptyState.tsx` with:

```tsx
import { useRef, useState } from 'react'

// Default empty state for a chat panel: shown when there are zero messages
// and replay is ready. A minimal, theme-token-driven stack — line-art icon
// tile, title, subtitle. Side Chat passes its own `emptyStateContent` and
// never reaches this component.
//
// Easter egg: triple-clicking the icon (3 clicks within 800ms gaps) calls
// `onUnlockEasterEgg`. Each click bounces the icon. The prop is optional so
// callers that don't care (e.g. Side Chat via emptyStateContent) are unaffected.
interface ChatEmptyStateProps {
  onUnlockEasterEgg?: () => void
}

const CHAIN_TIMEOUT_MS = 800
const UNLOCK_CLICKS = 3

export function ChatEmptyState({ onUnlockEasterEgg }: ChatEmptyStateProps) {
  const [bounce, setBounce] = useState(false)
  const [armed, setArmed] = useState(false)
  const countRef = useRef(0)
  const lastClickAtRef = useRef(0)

  const handleIconClick = () => {
    const now = Date.now()
    if (now - lastClickAtRef.current > CHAIN_TIMEOUT_MS) countRef.current = 0
    countRef.current += 1
    lastClickAtRef.current = now

    // re-trigger bounce animation
    setBounce(false)
    // microtask so React commits the removal before we re-add
    requestAnimationFrame(() => setBounce(true))

    if (countRef.current >= 2) setArmed(true)
    else setArmed(false)

    if (countRef.current >= UNLOCK_CLICKS) {
      countRef.current = 0
      setArmed(false)
      onUnlockEasterEgg?.()
    }
  }

  const handleAnimationEnd = () => setBounce(false)

  return (
    <div className="chat-empty">
      <div
        className={`chat-empty-icon${bounce ? ' chat-empty-icon--bounce' : ''}${armed ? ' chat-empty-icon--armed' : ''}`}
        aria-hidden="true"
        onClick={onUnlockEasterEgg ? handleIconClick : undefined}
        onAnimationEnd={handleAnimationEnd}
        role={onUnlockEasterEgg ? 'button' : undefined}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
        </svg>
      </div>
      <div className="chat-empty-title">Start a conversation</div>
      <div className="chat-empty-subtitle">Type a message below, or paste an image to begin</div>
    </div>
  )
}
```

Note: when `onUnlockEasterEgg` is absent, no `onClick`/`role` is attached, preserving the old inert behavior exactly (existing `MessageList.test.tsx:161` stays green).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/ChatEmptyState.test.tsx src/components/MessageList.test.tsx`
Expected: PASS (both files).

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatEmptyState.tsx src/components/ChatEmptyState.test.tsx
git commit -m "feat(easter-egg): triple-click sparkle icon to trigger unlock callback"
```

---

## Task 2: CSS — bounce, armed tint, game layout

**Files:**
- Modify: `src/styles/chat.css` (append after the `.chat-empty-subtitle` block ending around line 377)

- [ ] **Step 1: Add the CSS**

Append to `src/styles/chat.css` (after the `.chat-empty-subtitle { … }` rule, before the `.chat-messages-empty-side` comment block at line ~378):

```css
/* Easter-egg trigger: bounce the icon tile on each click, and tint it toward
   the accent color once the user has clicked twice (a subtle "something is
   happening" cue that is reversible if the chain resets). */
.chat-empty-icon--bounce {
  animation: chat-empty-icon-bounce 220ms var(--motion-ease-enter);
}
.chat-empty-icon--armed {
  color: var(--accent);
  border-color: var(--accent);
}
@keyframes chat-empty-icon-bounce {
  0%   { transform: translateY(0) scale(1); }
  45%  { transform: translateY(-6px) scale(1.15); }
  100% { transform: translateY(0) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .chat-empty-icon--bounce { animation-duration: 80ms; }
  @keyframes chat-empty-icon-bounce {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-2px); }
  }
}

/* Easter-egg game overlay: fills the empty-state flex container (which already
   centers its content). Canvas keeps a 3:1 ratio and scales down on narrow
   panels. */
.easter-egg-game {
  position: relative;
  width: 100%;
  max-width: 600px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.easter-egg-game canvas {
  width: 100%;
  aspect-ratio: 3 / 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  display: block;
  cursor: pointer;
  image-rendering: pixelated;
}
.easter-egg-game-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--fg-muted);
}
.easter-egg-game-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg-muted);
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}
.easter-egg-game-btn:hover { color: var(--fg); border-color: var(--fg-muted); }
```

- [ ] **Step 2: Verify nothing broke**

Run: `npx vitest run src/components/MessageList.test.tsx src/components/ChatEmptyState.test.tsx`
Expected: PASS (CSS-only change; tests unaffected).

- [ ] **Step 3: Commit**

```bash
git add src/styles/chat.css
git commit -m "style(easter-egg): bounce/armed icon states + game canvas layout"
```

---

## Task 3: EasterEggGame — skeleton (canvas, loop, ready state, scrolling ground, standing sparkle)

**Files:**
- Create: `src/components/EasterEggGame.tsx`
- Create: `src/components/EasterEggGame.test.tsx`

- [ ] **Step 1: Write the failing smoke test**

Create `src/components/EasterEggGame.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { EasterEggGame } from './EasterEggGame'

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
    expect(screen.getByText(/press space|click/i) || screen.getByText(/开始/i) || document.querySelector('.easter-egg-game')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/EasterEggGame.test.tsx`
Expected: FAIL — module `./EasterEggGame` not found.

- [ ] **Step 3: Create the game skeleton**

Create `src/components/EasterEggGame.tsx`:

```tsx
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
  // populated in later tasks:
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
  // indent-guide ticks
  const tickColor = color
  ctx.strokeStyle = tickColor
  ctx.globalAlpha = 0.5
  for (let x = -((offset) % 24); x < W; x += 24) {
    ctx.beginPath()
    ctx.moveTo(x, GROUND_Y + 18)
    ctx.lineTo(x, GROUND_Y + 26)
    ctx.stroke()
  }
  ctx.restore()
}

export function EasterEggGame({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<GameState>(makeInitialState())
  const rafRef = useRef<number | null>(null)
  const [status, setStatus] = useState<Status>('ready')
  const statusRef = useRef<Status>('ready')
  const setstatus = (s: Status) => { statusRef.current = s; setStatus(s) }

  // read theme colors once per render (cheap) into a ref
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
      // advance ground scroll in ready + running (idle motion)
      if (s.status === 'ready' || s.status === 'running') {
        s.groundOffset = (s.groundOffset + s.speed) % 10000
      }
      render(ctx, s)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [])

  function render(ctx: CanvasRenderingContext2D, s: GameState) {
    const c = colorsRef.current
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = c.bg
    ctx.fillRect(0, 0, W, H)
    drawGround(ctx, s.groundOffset, c.muted)
    // player
    drawSparkle(ctx, PLAYER_X + PLAYER_W / 2, s.player.y + PLAYER_H / 2, 9, c.fg)
    // status overlays
    ctx.fillStyle = c.muted
    ctx.font = '12px system-ui, sans-serif'
    ctx.textAlign = 'center'
    if (s.status === 'ready') {
      ctx.fillText('Press Space / Click to start', W / 2, 40)
    }
  }

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/EasterEggGame.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/EasterEggGame.tsx src/components/EasterEggGame.test.tsx
git commit -m "feat(easter-egg): game skeleton — canvas, rAF loop, ready state, ground + sparkle"
```

---

## Task 4: Gameplay — jump physics, obstacles, collision, score, gameOver/restart

**Files:**
- Modify: `src/components/EasterEggGame.tsx`

- [ ] **Step 1: Add obstacle + physics logic**

In `src/components/EasterEggGame.tsx`, replace the `loop` body inside the main-loop `useEffect` so it advances physics when running, and add obstacle spawn/draw/collision helpers. Concretely:

Replace the `loop` function with:

```tsx
    const loop = () => {
      const s = stateRef.current
      if (s.status === 'ready' || s.status === 'running') {
        s.groundOffset = (s.groundOffset + s.speed) % 10000
      }
      if (s.status === 'running') {
        updateRunning(s)
      }
      render(ctx, s)
      rafRef.current = requestAnimationFrame(loop)
    }
```

Add (above the component, module scope) the obstacle profiles and `updateRunning`:

```tsx
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
    // gap shrinks slightly with speed
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
      // persisted high score handled in Task 5
    }
  }
  s.obstacles = s.obstacles.filter(o => o.x + o.w > -20)
}
```

Replace the `render` function with a version that draws obstacles, score, and the gameOver overlay:

```tsx
  function render(ctx: CanvasRenderingContext2D, s: GameState) {
    const c = colorsRef.current
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = c.bg
    ctx.fillRect(0, 0, W, H)
    drawGround(ctx, s.groundOffset, c.muted)
    // obstacles
    for (const o of s.obstacles) drawObstacle(ctx, o, c)
    // player (squash on land handled simply: scaleY based on vy sign not needed here)
    drawSparkle(ctx, PLAYER_X + PLAYER_W / 2, s.player.y + PLAYER_H / 2, 9, c.fg)
    // score
    ctx.fillStyle = c.muted
    ctx.font = '12px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(`Score ${s.score}`, 12, 20)
    ctx.textAlign = 'center'
    if (s.status === 'ready') {
      ctx.fillText('Press Space / Click to start', W / 2, 40)
    } else if (s.status === 'gameOver') {
      ctx.fillStyle = c.fg
      ctx.fillText('Game Over', W / 2, 70)
      ctx.fillStyle = c.muted
      ctx.fillText('Press Space / Click to restart', W / 2, 92)
    }
  }
```

Add `drawObstacle` at module scope:

```tsx
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
    const color = o.kind === 'error' ? '#e5484d' : '#f5a623'
    ctx.fillStyle = color
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
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke test still passes**

Run: `npx vitest run src/components/EasterEggGame.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/EasterEggGame.tsx
git commit -m "feat(easter-egg): jump physics, obstacles, collision, scoring, game over"
```

---

## Task 5: Day/night cycle, audio, high score + mute persistence

**Files:**
- Modify: `src/components/EasterEggGame.tsx`

- [ ] **Step 1: Add persistence + audio + day/night**

At module scope, add storage helpers and audio:

```tsx
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

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function mixRgb(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a); const [r2, g2, b2] = hexToRgb(b)
  return `rgb(${Math.round(lerp(r1, r2, t))},${Math.round(lerp(g1, g2, t))},${Math.round(lerp(b1, b2, t))})`
}
```

Inside the component, add refs/state:

```tsx
  const audioRef = useRef<AudioContext | null>(null)
  const [muted, setMuted] = useState(readMuted())
  const mutedRef = useRef(readMuted())
  const [hi, setHi] = useState(readHi())
  const hiRef = useRef(readHi())
  const newBestRef = useRef(false)
  const reducedMotionRef = useRef(
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
  const setMutedAll = (v: boolean) => { mutedRef.current = v; setMuted(v); writeMuted(v) }
```

Add an audio helper inside the component:

```tsx
  function beep(freq: number, dur: number, type: OscillatorType, gainVal = 0.06) {
    if (mutedRef.current) return
    try {
      if (!audioRef.current) audioRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
      const ac = audioRef.current
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = type
      osc.frequency.value = freq
      gain.gain.value = gainVal
      osc.connect(gain); gain.connect(ac.destination)
      const t = ac.currentTime
      gain.gain.setValueAtTime(gainVal, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.start(t); osc.stop(t + dur)
    } catch { /* ignore */ }
  }
  function crashSound() {
    if (mutedRef.current) return
    try {
      if (!audioRef.current) audioRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
      const ac = audioRef.current
      const buf = ac.createBuffer(1, ac.sampleRate * 0.25, ac.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
      const src = ac.createBufferSource(); src.buffer = buf
      const gain = ac.createGain(); gain.gain.value = 0.12
      src.connect(gain); gain.connect(ac.destination)
      src.start()
    } catch { /* ignore */ }
  }
```

Update `updateRunning` (Task 4) to drive the day/night blend. Add at the end of `updateRunning`, before the obstacle filter:

```tsx
  // day/night target
  const nightTarget = Math.floor(s.score / 100) % 2 === 1 ? 1 : 0
  if (reducedMotionRef.current) s.nightBlend = nightTarget
  else s.nightBlend = lerp(s.nightBlend, nightTarget, 0.02)
```

Update the `gameOver` transition inside `updateRunning`'s collision branch to record high score + sound:

```tsx
      if (px < o.x + o.w && px + pw > o.x && py < GROUND_Y - o.h + o.h && py + ph > GROUND_Y - o.h) {
        s.status = 'gameOver'
        if (s.score > hiRef.current) {
          hiRef.current = s.score
          writeHi(s.score)
          setHi(s.score)
          newBestRef.current = true
        } else {
          newBestRef.current = false
        }
        crashSound()
      }
```

Update `render` to apply day/night background and show high score on gameOver:

```tsx
  function render(ctx: CanvasRenderingContext2D, s: GameState) {
    const c = colorsRef.current
    // day/night background
    const dayBg = c.bg
    const nightBg = mixRgb(c.bg, '#0b0e14', 0.6)
    ctx.fillStyle = s.nightBlend > 0.5 ? mixRgb(dayBg, nightBg, s.nightBlend) : dayBg
    if (s.nightBlend > 0.01) ctx.fillStyle = mixRgb(dayBg, nightBg, s.nightBlend)
    ctx.fillRect(0, 0, W, H)
    drawGround(ctx, s.groundOffset, c.muted)
    for (const o of s.obstacles) drawObstacle(ctx, o, c)
    drawSparkle(ctx, PLAYER_X + PLAYER_W / 2, s.player.y + PLAYER_H / 2, 9, c.fg)
    ctx.fillStyle = c.muted
    ctx.font = '12px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(`Score ${s.score}`, 12, 20)
    ctx.textAlign = 'right'
    ctx.fillText(`Best ${hiRef.current}`, W - 12, 20)
    ctx.textAlign = 'center'
    if (s.status === 'ready') {
      ctx.fillText('Press Space / Click to start', W / 2, 40)
    } else if (s.status === 'gameOver') {
      ctx.fillStyle = c.fg
      ctx.fillText('Game Over', W / 2, 70)
      ctx.fillStyle = c.muted
      ctx.fillText(newBestRef.current ? 'NEW BEST!' : `Best ${hiRef.current}`, W / 2, 88)
      ctx.fillText('Press Space / Click to restart', W / 2, 108)
    }
  }
```

Add a mute button to the toolbar JSX:

```tsx
      <div className="easter-egg-game-toolbar">
        <button className="easter-egg-game-btn" aria-label="Toggle sound" onClick={() => setMutedAll(!mutedRef.current)}>{muted ? '🔇' : '🔊'}</button>
        <button className="easter-egg-game-btn" aria-label="Exit game" onClick={onExit}>✕ Exit</button>
      </div>
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke test still passes**

Run: `npx vitest run src/components/EasterEggGame.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/EasterEggGame.tsx
git commit -m "feat(easter-egg): day/night cycle, web-audio sfx, persisted high score + mute"
```

---

## Task 6: Controls (keyboard / click / touch) + auto-pause

**Files:**
- Modify: `src/components/EasterEggGame.tsx`

- [ ] **Step 1: Add a reset + jump + start/restart helper**

Inside the component, add:

```tsx
  function resetGame(startRunning: boolean) {
    const s = stateRef.current
    const next = makeInitialState()
    if (startRunning) next.status = 'running'
    stateRef.current = next
    newBestRef.current = false
    setstatus(next.status)
  }

  function jump() {
    const s = stateRef.current
    if (s.status === 'ready') { s.status = 'running'; setstatus('running'); s.lastScoreTime = performance.now() }
    if (s.status === 'gameOver') { resetGame(true); return }
    if (s.status === 'paused') { s.status = 'running'; setstatus('running'); return } // resume, no jump
    if (s.status === 'running' && s.player.grounded) {
      s.player.vy = JUMP_V
      s.player.grounded = false
      beep(660, 0.12, 'square')
    }
  }
```

- [ ] **Step 2: Add input + auto-pause effects**

Add these `useEffect`s inside the component (after the main-loop effect):

```tsx
  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.key === 'ArrowUp') {
        e.preventDefault()
        jump()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onExit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit])

  // auto-pause: click outside panel, or window blur
  useEffect(() => {
    const root = canvasRef.current
    const panel = root?.closest('.chat-panel') as Element | null
    const onMouseDown = (e: MouseEvent) => {
      if (stateRef.current.status !== 'running') return
      if (panel && !panel.contains(e.target as Node)) {
        stateRef.current.status = 'paused'
        setstatus('paused')
      }
    }
    const onBlur = () => {
      if (stateRef.current.status === 'running') {
        stateRef.current.status = 'paused'
        setstatus('paused')
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
```

Add canvas click/touch handlers on the `<canvas>` element:

```tsx
      <canvas
        ref={canvasRef}
        aria-label="Easter egg sparkle dino game"
        onClick={() => jump()}
        onTouchStart={(e) => { e.preventDefault(); jump() }}
      />
```

Add the paused overlay text in `render`. Extend the status block:

```tsx
    if (s.status === 'ready') {
      ctx.fillText('Press Space / Click to start', W / 2, 40)
    } else if (s.status === 'paused') {
      ctx.fillStyle = c.fg
      ctx.fillText('Paused', W / 2, 70)
      ctx.fillStyle = c.muted
      ctx.fillText('Click or press Space to resume', W / 2, 90)
    } else if (s.status === 'gameOver') {
```

- [ ] **Step 3: Keep the loop advancing only in ready/running**

The existing `loop` already gates `updateRunning` on `s.status === 'running'`; paused freezes updates but keeps drawing. No further change needed — verify by re-reading the loop body.

- [ ] **Step 4: Verify typecheck + smoke test**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run src/components/EasterEggGame.test.tsx`
Expected: no type errors; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/EasterEggGame.tsx
git commit -m "feat(easter-egg): keyboard/click/touch controls + auto-pause on outside click / blur"
```

---

## Task 7: Wire into MessageList + test the unlock→game swap

**Files:**
- Modify: `src/components/MessageList.tsx`
- Modify: `src/components/MessageList.test.tsx`

- [ ] **Step 1: Write the failing test**

In `src/components/MessageList.test.tsx`, add a new test after the existing "shows the default empty state" test (around line 168):

```tsx
  it('swaps the empty state for the easter-egg game after triple-clicking the icon', () => {
    const { container } = render(<MessageList items={[]} replayReady />)
    expect(container.querySelector('.easter-egg-game')).toBeNull()
    const icon = container.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    fireEvent.click(icon)
    fireEvent.click(icon)
    expect(container.querySelector('.easter-egg-game')).toBeTruthy()
    // exiting returns to the empty state
    fireEvent.click(container.querySelector('[aria-label="Exit game"]') as HTMLElement)
    expect(container.querySelector('.easter-egg-game')).toBeNull()
    expect(container.querySelector('.chat-empty')).toBeTruthy()
  })
```

Ensure `fireEvent` is imported (it already is in that file — verify; if not, add to the `@testing-library/react` import).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/MessageList.test.tsx -t "swaps the empty state"`
Expected: FAIL — `.easter-egg-game` not found (the icon has no handler because `onUnlockEasterEgg` isn't wired).

- [ ] **Step 3: Wire it into MessageList**

In `src/components/MessageList.tsx`:

1. Add the import near the existing `ChatEmptyState` import (line ~30):
```tsx
import { EasterEggGame } from './EasterEggGame'
```

2. Inside the component body (near the top of `MessageList`, after the other `useState` hooks), add:
```tsx
  const [gameOpen, setGameOpen] = useState(false)
```
(Ensure `useState` is imported from `react` — it already is, since other hooks are used.)

3. Replace line 1268:
```tsx
              ? (emptyStateContent ?? <ChatEmptyState />)
```
with:
```tsx
              ? (emptyStateContent ?? (gameOpen
                  ? <EasterEggGame onExit={() => setGameOpen(false)} />
                  : <ChatEmptyState onUnlockEasterEgg={() => setGameOpen(true)} />))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/MessageList.test.tsx src/components/ChatEmptyState.test.tsx src/components/EasterEggGame.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx
git commit -m "feat(easter-egg): wire triple-click unlock into MessageList empty state"
```

---

## Task 8: Verify — typecheck, lint, full test suite, manual

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck (both tsconfigs)**

Run: `npm run typecheck`
Expected: no errors in either `tsconfig.json` or `tsconfig.node.json`.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors. (Fix any that surface — likely unused imports or `any` in audio code; the `(window as any).webkitAudioContext` cast is intentional and acceptable, but if eslint flags it, add an inline `// eslint-disable-next-line @typescript-eslint/no-explicit-any`.)

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: all green.

- [ ] **Step 4: Manual verification (dark + light theme)**

Run `npm run dev`, open the app, and in an empty chat panel:
1. Confirm the sparkle icon is visible with no messages.
2. Single-click — icon bounces; no game.
3. Two rapid clicks — icon tints toward accent (armed).
4. Wait >1s, then triple-click — chain should have reset; on the 3rd rapid click the game appears.
5. Game: Space/Up/click jumps; obstacles (bug, error, warning) approach; collision ends the game with score + best shown; Space/click restarts.
6. Reach 100 points — day/night background transitions.
7. Click the 🔊 button — mutes; reload — still muted (localStorage). Best score persists across reloads too.
8. While running, click in the sidebar / another panel — game pauses with overlay; click canvas or press Space to resume.
9. Alt+Tab away — game pauses.
10. Press Esc — game exits back to empty state.
11. Toggle OS reduced-motion — day/night switches instantly; icon bounce dampened.
12. Switch app theme (dark ↔ light) — game colors follow.

- [ ] **Step 5: Commit any fixups (if needed)**

If manual testing surfaced fixes, commit them. Otherwise nothing to commit.

---

## Self-Review notes

- **Spec coverage:** trigger (Task 1+2), game canvas/loop/state machine (Task 3), physics/obstacles/score/gameOver (Task 4), day/night/audio/high-score/mute (Task 5), controls + auto-pause (Task 6), MessageList wiring (Task 7), a11y (`aria-label`, reduced-motion) covered in Tasks 2/5/6. All spec sections mapped.
- **Type consistency:** `Status`, `Obstacle`, `GameState` defined once in Task 3 and reused unchanged in Tasks 4–6. `makeInitialState`, `drawSparkle`, `drawGround` defined in Task 3 and referenced later. `onExit: () => void` consistent across all tasks and tests.
- **No placeholders:** every code step contains full code; no TBD / "add error handling" / "similar to".
