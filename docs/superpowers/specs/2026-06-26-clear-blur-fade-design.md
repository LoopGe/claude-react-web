# `/clear` blur-fade transition

**Date:** 2026-06-26
**Status:** Approved
**Effect:** #2 blur-fade (from `clear-effect-preview.html`)

## Problem

`POST /api/sessions/:id/clear` takes ~1.7s server-side (`SessionManager.clear()` —
tear down the old `claude` CLI subprocess, delete the transcript, refresh MCP OAuth
tokens, spawn a fresh subprocess). During that window the client shows the **old
transcript with zero feedback**, then the `session-cleared` WS frame lands and
`useChatStream` **instantly wipes** the store — an abrupt hard snap from full
transcript to empty state.

Two perceptual problems: **(A)** no feedback during the ~1.7s wait, **(B)** the
old→empty transition is an abrupt snap. This design addresses both with an
immediate (trigger-time) blur-fade-out that hides the server latency behind the
animation + a "清理中" veil.

## Visual sequence

```
t=0       user triggers /clear
          → .chat-messages gets .chat-messages-clearing
          → blur-fade animation plays (≈320ms: opacity 1→0, blur 0→10px, scale 1→0.96)
t≈220ms   → "清理中" veil fades in over the now-invisible transcript
t≈1.7s    server done → session-cleared WS frame lands
          → store wipes items (empty state appears), onCleared fires
          → clearing flag flips false → class removed
          → empty state gets a gentle fade-in
```

Messages reach opacity 0 well before the store wipe, so there is never a
snap-back flicker: the `.chat-messages-clearing` class is removed only after
the store is already empty (no items left to snap back into view).

## Where the `clearing` flag lives

**Local `useState` in `Chat.tsx`** — NOT in the session store.

- It is transient UI/animation state, not server-derived data. Putting it in
  `ServerMirror`/`ClientIntent` would drag it through the reducer, the snapshot,
  and IDB persistence (which would then have to exclude it) — heavyweight for a
  1.7s flag.
- Its lifecycle is fully contained in `Chat.tsx`: set on trigger, cleared by the
  existing `onCleared` callback channel (already wired at `Chat.tsx:354`), which
  fires precisely when the `session-cleared` WS frame lands — i.e. after the
  store wipe. No change to `useChatStream`'s signature is required.

## Changes

### 1. `src/components/Chat.tsx`
- `const [clearing, setClearing] = useState(false)`.
- `requestClearSession`: `setClearing(true)` synchronously **before** `api.post`;
  `setClearing(false)` in `.catch` (so a failed clear doesn't leave the panel
  stuck blurred).
- `onCleared` (`Chat.tsx:354`): wrap `permissions.reset` →
  `() => { permissions.reset(); setClearing(false) }` via `useCallback`. This
  fires on the `session-cleared` frame, after the store wipe — the safe moment
  to drop the class.
- Pass `clearing={clearing}` to `<MessageList>` (`Chat.tsx:1156`).

### 2. `src/components/MessageList.tsx`
- New optional prop `clearing?: boolean`.
- Add `chat-messages-clearing` to `messagesClassName` (`MessageList.tsx:1119`)
  when `clearing` is true.
- Render the "清理中" veil inside `.chat-messages-wrap` when `clearing` is true:
  absolutely positioned, centered spinner + label, `pointer-events: none`.
- One-shot empty-state entrance: track previous `clearing` via a ref; when it
  flips false with `items.length === 0`, add `chat-messages-empty-enter` for a
  soft fade-in, removed on `animationend`. Self-contained — no new prop.

### 3. `src/styles/chat.css`
- `.chat-messages-clearing` →
  `animation: clear-blur-fade var(--motion-duration-slow) var(--motion-ease-exit) both`.
- `@keyframes clear-blur-fade` (opacity 1→0, blur 0→10px, scale 1→0.96 — same as
  the approved preview), `@keyframes clear-veil-in`, `@keyframes chat-messages-empty-enter`.
- `.chat-clearing-veil` styling (spinner reuses the existing working-dot/spinner
  aesthetic).
- `prefers-reduced-motion` block: degrade to an instant opacity drop (matching
  the existing reveal/reduced-motion precedent at `chat.css:103-107`).
- All colors via theme tokens (`--fg-muted`, `--accent`, `--border`) — no
  hardcoded hex, per `CLAUDE.md`.

### 4. `src/components/SideChatDrawer.tsx` (secondary)
- Same `clearing` state + prop wiring as `Chat.tsx`, **if** side chats expose
  `/clear`. Confirm during planning; skip if not.

### 5. Tests
- `MessageList.test.tsx`: render with `clearing` → assert
  `.chat-messages-clearing` present; flip `clearing` false with empty items →
  assert `chat-messages-empty-enter` applied then removed on animationend.
- `useChatStream.test.ts` session-cleared tests remain green (no hook signature
  change).

## Non-goals

- **No per-message stagger.** The preview had it; the real app uses
  react-virtuoso virtualization, so animating one container element is correct
  and performant. The visual read is nearly identical.
- **No `clearing` flag in the store/reducer.** Keeps the architectural
  mirror/intent split untouched.
- **No change to `useChatStream`'s signature.** Reuses the existing `onCleared`
  channel.

## Risks / edge cases

- **Failed clear:** `.catch` resets the flag → messages un-blur and remain.
- **Rapid double `/clear`:** `requestClearSession` already no-ops server-side
  when a clear is in flight; the flag is already true so re-setting is a no-op.
- **Session switch mid-clear:** switching panels unmounts/remounts `Chat` for
  the new session; local `clearing` state resets. The old session's clear
  completes server-side regardless. Matches today's behavior.
- **`prefers-reduced-motion`:** degrades to instant fade, no blur/scale.
