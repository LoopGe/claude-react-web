# Easter Egg: Sparkle Dino Game

**Date:** 2026-07-02
**Status:** Design approved, ready for implementation plan

## Summary

A hidden mini-game, themed after this app, triggered by triple-clicking the
sparkle icon on the "Start a conversation" empty state. The game is a
Chrome-offline-dino-style endless runner: the player (the same sparkle glyph
used in the empty state) jumps over code-themed obstacles (bugs, errors,
warnings). It renders as a Canvas overlay covering the Chat panel body, fully
self-contained, with no impact on session/WebSocket/history logic.

## Goals

- Delightful, discoverable-by-accident easter egg consistent with the app's
  visual language.
- Zero coupling to the SDK / session / WS layer: pure client-side, no network,
  no persistence beyond a `localStorage` high score.
- Respects existing theme system (CSS variables) and accessibility settings
  (`prefers-reduced-motion`).

## Non-goals

- Mobile-optimized controls beyond tap-to-jump (no swipe, no accelerometer).
- Leaderboards, sharing, multiplayer.
- Asset pipeline (no images, no audio files — everything is code-drawn /
  synthesized).
- Persistence across sessions other than the high score and mute preference.

## Trigger mechanism

**File:** `src/components/ChatEmptyState.tsx`

The sparkle icon `<div className="chat-empty-icon">` currently has no click
handler. Add:

- A `clickCount` state + `lastClickAt` timestamp.
- On click: if `now - lastClickAt > 800ms`, reset `clickCount = 1`; else
  `clickCount += 1`. Update `lastClickAt`.
- On every click, trigger a **bounce animation**: toggle a CSS class
  `chat-empty-icon--bounce` on the icon; remove it on `onAnimationEnd` so it
  can re-trigger on consecutive clicks.
- At `clickCount === 3`: reset to 0 and call `onUnlockEasterEgg?.()` (new
  optional prop). No visible progress indicator before unlock — the easter egg
  stays hidden. After the 2nd click, the icon tints toward `var(--accent)` as
  a subtle "something is happening" cue, reversible if the chain resets.
- `ChatEmptyState` gains an optional prop `onUnlockEasterEgg?: () => void`.
  When omitted, the counting logic is inert (preserves current behavior for
  `SideChatDrawer` and other `emptyStateContent` overrides that don't pass the
  prop).
- `prefers-reduced-motion: reduce` → bounce amplitude dampened (small
  translate, no scale).

**CSS** (`src/styles/chat.css`, near the existing `.chat-empty-icon` block):

```css
.chat-empty-icon--bounce {
  animation: chat-empty-icon-bounce 220ms var(--motion-ease-enter);
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
```

## Wiring

`MessageList.tsx` renders `<ChatEmptyState />` at line ~1268. It will instead
render `<ChatEmptyState onUnlockEasterEgg={() => setGameOpen(true)} />` when
its own `gameOpen` state is false, and render `<EasterEggGame onExit={() => setGameOpen(false)} />`
when `gameOpen` is true. The game replaces the empty-state node inside the
existing `.chat-messages-empty` flex container, so it inherits the panel's
centering and full-height layout.

The game is scoped per `MessageList` instance (i.e. per Chat panel). Each open
panel can independently trigger its own game. The state is local React state,
not lifted to `App` or `Chat`.

## Game component

**New file:** `src/components/EasterEggGame.tsx`

### Props

```ts
interface EasterEggGameProps {
  onExit: () => void;
}
```

### Rendering surface

- A single `<canvas>` with a fixed **logical size of 600×200** (3:1, the
  classic dino ratio).
- CSS: `width: 100%; max-width: 600px; aspect-ratio: 3 / 1;` so it scales down
  on narrow panels.
- DPR scaling: set `canvas.width = 600 * dpr`, `canvas.height = 200 * dpr`,
  `ctx.scale(dpr, dpr)`; all drawing code uses logical 600×200 coordinates.
- A close button (✕) in the top-right corner calls `onExit`.
- A mute toggle (🔊/🔇) in the top-right next to close.

### Main loop

- `requestAnimationFrame` loop started in `useEffect`; `cancelAnimationFrame`
  on cleanup.
- All mutable game state held in a `useRef` (`gameRef`) so the loop reads/writes
  without re-rendering; React state is used only for UI overlays (status text,
  score display, mute icon) synced via a lightweight `setState` on discrete
  transitions.
- A `statusRef`: `'ready' | 'running' | 'paused' | 'gameOver'`.

### Drawing (all code-drawn, no assets)

- **Ground:** a horizontal dashed line near the bottom + scrolling short
  vertical ticks (evoking editor indent guides). Scrolls left at current
  speed; wraps infinitely.
- **Player (sparkle):** four crossing line segments reproducing the empty-state
  glyph geometry, drawn around the player's `x, y`. Jump = `y` decreases then
  returns via gravity. On landing, a brief squash (scaleY 0.8 → 1) for
  game-feel.
- **Obstacles** spawn off-screen right, move left at current speed. Three
  variants chosen at random:
  - `bug` — small circle head + wavy body line; short and wide.
  - `error` — red triangle with `!`; tall and narrow.
  - `warning` — yellow triangle with `!`; medium.
  Each variant has its own width/height profile used for both drawing and
  hitbox.
- **Day/night cycle:** every 100 points, toggle a `night` flag; background and
  ground colors interpolate over ~2s between two palettes derived from theme
  CSS variables (`var(--bg)`, `var(--fg-muted)`, etc. read once via
  `getComputedStyle`). Both dark and light app themes remain legible.

### State machine

- `ready`: canvas shows the sparkle standing, ground scrolling slowly, prompt
  "按空格 / 点击开始". First jump input → `running`.
- `running`: physics, scoring, obstacle spawning active.
- `paused`: loop continues but updates are gated by `pausedRef === false`;
  physics/scoring/spawning frozen; a semi-transparent overlay reads
  "⏸ 已暂停 — 点击或按空格恢复".
- `gameOver`: loop stops advancing; overlay shows current score, high score,
  "NEW BEST" if applicable, and "按空格重开 / Esc 退出".

### Physics

- Gravity constant; jump initial velocity; single jump only (must land before
  jumping again). No double jump (preserves dino feel).

### Scoring & difficulty

- Score increments ~+1 per 100ms while running; +5 per obstacle passed.
- Base speed increases by +0.5 per 100 points, capped at a max to avoid
  unplayable speeds.
- High score persisted to `localStorage` key `crw_easter_egg_hi`.

## Controls

The game registers its **own** `window` keydown listener on mount (not via
`useKeyboardShortcuts`, which is input-safe and would swallow Space/Up when the
composer is focused). The listener is removed on unmount.

- `Space` / `ArrowUp` / `Up`:
  - `ready` → start game (becomes `running`) and jump.
  - `running` → jump (if grounded).
  - `paused` → resume only (no jump this press; next Space jumps).
  - `gameOver` → restart (reset state to `running`).
  - Always `preventDefault` to stop page scroll.
- `Esc`:
  - `paused` → exit game (`onExit`).
  - any other state → exit game (`onExit`).
- Canvas `onClick` / `onTouchStart`:
  - `ready` → start + jump.
  - `running` → jump.
  - `paused` → resume.
  - `gameOver` → restart.
  - `touchstart` calls `preventDefault` to avoid synthesized mouse + scroll.

## Auto-pause

When `statusRef.current === 'running'`, two listeners are active:

- `document` `mousedown`: if `!panelRef.current.contains(e.target as Node)`,
  transition `running → paused`. Clicks on the canvas, composer, panel header,
  or any element inside the Chat `<section>` do **not** pause. Clicks on the
  sidebar, another panel, or outside the app do pause.
- `window` `blur`: transition `running → paused` (covers tab switch,
  Alt+Tab, clicking outside the browser window).

`paused` and `gameOver` and `ready` states do not react to auto-pause. Both
listeners are removed on unmount.

## Audio

- Web Audio API, synthesized on the fly. No audio files.
- `AudioContext` created lazily on first user gesture (the start jump), so it
  complies with autoplay policies.
- Jump: short high square-wave blip (~120ms, ~660Hz).
- Hit/crash: low noise burst with fast decay (~250ms).
- Mute toggle button (🔊/🔇) in the top-right; preference persisted to
  `localStorage` key `crw_easter_egg_muted`. When muted, no `AudioContext`
  calls are made.

## Accessibility

- `prefers-reduced-motion: reduce`: day/night cycle switches color instantly
  (no 2s interpolation); ground-tick scroll and core gameplay remain (they are
  the game itself, not decoration). Bounce on the trigger icon is dampened
  (see CSS above).
- `<canvas>` carries `aria-label` describing the game and current status.
- All controls have keyboard equivalents; no pointer-only actions.

## Files touched

- `src/components/ChatEmptyState.tsx` — add click counting, bounce, optional
  `onUnlockEasterEgg` prop.
- `src/styles/chat.css` — add `.chat-empty-icon--bounce` keyframes + reduced-
  motion fallback; possibly a `.chat-empty-icon--armed` tint after 2nd click.
- `src/components/EasterEggGame.tsx` — **new**, the entire game.
- `src/components/MessageList.tsx` — wire `gameOpen` state; render the game in
  place of `ChatEmptyState` when open; pass `onUnlockEasterEgg`.
- `src/components/MessageList.test.tsx` — light test that triple-clicking the
  empty-state icon (when `onUnlockEasterEgg` is wired) is exercised; the game
  component itself is hard to unit-test (rAF/canvas), so tests focus on the
  trigger wiring and that `EasterEggGame` renders without crashing when
  `gameOpen`.

## Verification

- `npm run typecheck` (both tsconfigs).
- `npm run lint`.
- `npm run test` (vitest).
- Manual: dark + light theme; triple-click trigger; bounce animation; jump
  physics; obstacle variety; day/night switch; high score persistence; mute
  toggle; auto-pause on outside click and on window blur; resume; Esc exit;
  reduced-motion path.

## Out-of-scope / future

- Sound effects beyond blip/noise.
- Multiple difficulty modes.
- Shared/global high score across panels (currently per-browser).
- Sprite art / themed skins beyond the three obstacle variants.
