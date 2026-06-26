# `/clear` blur-fade transition — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the ~1.7s `/clear` server latency behind an immediate blur-fade-out of the transcript + a "清理中" veil, replacing the current "freeze then hard snap to empty" behavior.

**Architecture:** A local `clearing` boolean in `Chat.tsx` (set on trigger, cleared by the existing `onCleared` WS callback that fires when `session-cleared` lands — i.e. after the store wipe, so no snap-back). `MessageList` receives `clearing` as a prop, applies a `chat-messages-clearing` blur-fade animation to the scroller, and renders a "清理中" veil that fades in during the wait and fades out to reveal the post-clear empty state. All animation reuses existing `--motion-*` tokens and theme color tokens; `prefers-reduced-motion` degrades to an instant opacity drop. No store/reducer changes, no `useChatStream` signature changes.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react (jsdom), CSS (theme tokens).

**Spec:** `docs/superpowers/specs/2026-06-26-clear-blur-fade-design.md`

**Scope note:** The spec mentioned `SideChatDrawer.tsx` as secondary. Confirmed during planning: side chats do NOT expose `/clear` (no `requestClear`/`matchLocalCommand` in `SideChatDrawer.tsx` — the `pastedImages.clear()` hit is unrelated). Dropped from this plan.

---

## File Structure

- **Modify** `src/components/MessageList.tsx` — add `clearing` prop, `chat-messages-clearing` class on the scroller, and the "清理中" veil element with a fade-out exit.
- **Modify** `src/styles/chat.css` — `clear-blur-fade`, `clear-veil-in`, `clear-veil-out`, `clear-spinner` keyframes + classes; `prefers-reduced-motion` block.
- **Modify** `src/components/Chat.tsx` — `clearing` state; set on `/clear` trigger, clear on `onCleared` and on failure; pass `clearing` to `<MessageList>`.
- **Modify** `src/components/MessageList.test.tsx` — tests for the clearing class + veil fade-out.

No new files. No store/reducer changes. No `useChatStream` signature change (reuses the existing `onCleared` callback already wired at `Chat.tsx:354`).

---

## Task 1: MessageList — `clearing` prop, blur-fade class, veil with fade-out exit (TDD)

**Files:**
- Modify: `src/components/MessageList.tsx` (Props interface ~line 37; state/effect near other hooks; `messagesClassName` ~line 1119; render ~line 1211)
- Test: `src/components/MessageList.test.tsx`

- [ ] **Step 1: Add the `fireEvent` import to the test file**

In `src/components/MessageList.test.tsx`, line 2, change:

```ts
import { act, render, waitFor } from '@testing-library/react'
```

to:

```ts
import { act, fireEvent, render, waitFor } from '@testing-library/react'
```

- [ ] **Step 2: Write the failing tests**

Append these two tests inside the `describe('MessageList', ...)` block in `src/components/MessageList.test.tsx` (after the existing `'shows the default empty state when messages are empty'` test is fine):

```tsx
  it('applies clearing class and shows the veil while clearing', () => {
    const items = toItems([
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'hi' }] } }),
    ])
    const { container } = render(<MessageList items={items} replayReady clearing />)
    expect(
      container.querySelector('.chat-messages')?.classList.contains('chat-messages-clearing'),
    ).toBe(true)
    const veil = container.querySelector('.chat-clearing-veil')
    expect(veil).toBeTruthy()
    expect(veil?.classList.contains('exiting')).toBe(false)
  })

  it('fades the veil out when clearing completes', () => {
    const items = toItems([
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'hi' }] } }),
    ])
    const { container, rerender } = render(<MessageList items={items} replayReady clearing />)
    // clearing flips false + store wiped (items empty) in the same transition
    rerender(<MessageList items={[]} replayReady clearing={false} />)

    expect(
      container.querySelector('.chat-messages')?.classList.contains('chat-messages-clearing'),
    ).toBe(false)
    expect(container.querySelector('.chat-messages-empty')).toBeTruthy()
    // Veil stays mounted, now in its exiting (fade-out) state
    const veil = container.querySelector('.chat-clearing-veil')
    expect(veil?.classList.contains('exiting')).toBe(true)
    // fade-out animation ends → veil unmounts
    fireEvent.animationEnd(veil!)
    expect(container.querySelector('.chat-clearing-veil')).toBeNull()
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/components/MessageList.test.tsx`
Expected: FAIL — `clearing` prop not accepted / `.chat-clearing-veil` not found.

- [ ] **Step 4: Add the `clearing` prop to the Props interface**

In `src/components/MessageList.tsx`, inside `interface Props` (starts ~line 37), add this field immediately after the `working?: boolean` field (after line 42):

```ts
  /** True while a /clear is in flight (trigger → session-cleared frame).
   *  Adds a blur-fade-out to the transcript and a "清理中" veil so the
   *  ~1.7s server teardown+respawn reads as an intentional transition
   *  instead of a frozen screen followed by a hard snap to empty. */
  clearing?: boolean
```

- [ ] **Step 5: Destructure `clearing` from props**

Find the component's props destructure (the `function MessageList({...})` or `({ items, working, ... }: Props)` signature). Add `clearing` to the destructured list alongside `working`. (Search for `working` in the destructure to locate it.)

- [ ] **Step 6: Add the veil exit state + layout effect**

In `src/components/MessageList.tsx`, near the other `useState`/`useRef`/`useLayoutEffect` declarations (e.g., just below the `messagesElRef` declaration), add:

```ts
  // --- /clear veil exit -----------------------------------------------
  // The veil fades IN while `clearing` is true, then fades OUT when
  // `clearing` flips false (the session-cleared frame just wiped the
  // store). useLayoutEffect so the `exiting` class commits before paint
  // — otherwise the veil unmounts for one frame and flickers.
  const [clearingVeilExiting, setClearingVeilExiting] = useState(false)
  const prevClearingRef = useRef(false)
  useLayoutEffect(() => {
    const prev = prevClearingRef.current
    prevClearingRef.current = clearing ?? false
    if (!clearing && prev) setClearingVeilExiting(true)
    else if (clearing) setClearingVeilExiting(false)
  }, [clearing])
  const veilVisible = clearing || clearingVeilExiting
  const onVeilAnimationEnd = useCallback(() => {
    setClearingVeilExiting(false)
  }, [])
```

- [ ] **Step 7: Add `chat-messages-clearing` to `messagesClassName`**

In `src/components/MessageList.tsx` (~line 1119), replace:

```ts
  const messagesClassName = isTranscriptRevealPending
    ? 'chat-messages chat-messages-reveal-pending'
    : 'chat-messages'
```

with:

```ts
  const messagesClassName = [
    'chat-messages',
    isTranscriptRevealPending && 'chat-messages-reveal-pending',
    clearing && 'chat-messages-clearing',
  ]
    .filter(Boolean)
    .join(' ')
```

- [ ] **Step 8: Render the veil**

In `src/components/MessageList.tsx`, the render's `.chat-messages-stage` block closes at the `</div>` on line 1211 (right before `</div>` closing `.chat-messages-wrap` on line 1212). Insert the veil **immediately before** the line-1211 `</div>` (i.e., after the `visibleStreamingContent` block, still inside `.chat-messages-stage`):

```tsx
      {veilVisible && (
        <div
          className={`chat-clearing-veil${clearingVeilExiting ? ' exiting' : ''}`}
          onAnimationEnd={onVeilAnimationEnd}
        >
          <span className="chat-clearing-spinner" aria-hidden="true" />
          <span className="chat-clearing-label">清理中…</span>
        </div>
      )}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run src/components/MessageList.test.tsx`
Expected: PASS — both new tests green, all existing tests still green.

- [ ] **Step 10: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx
git commit -m "feat(messagelist): add clearing prop + blur-fade veil for /clear transition"
```

---

## Task 2: CSS — keyframes, veil styling, reduced-motion

**Files:**
- Modify: `src/styles/chat.css` (insert after the reduced-motion block ending at line 111)

- [ ] **Step 1: Add the transition CSS**

In `src/styles/chat.css`, insert this block immediately **after** the `prefers-reduced-motion` block that ends at line 111 (i.e., after the `}` closing the `@media (prefers-reduced-motion: reduce)` at line 111):

```css
/* /clear transition: blur-fade the transcript out and veil it with a
   "清理中" affordance while the server tears down + respawns the CLI
   subprocess (~1.7s). The class is removed only after the session-cleared
   frame wipes the store, so messages never snap back into view. */
.chat-messages.chat-messages-clearing {
  animation: clear-blur-fade var(--motion-duration-slow) var(--motion-ease-exit) both;
}
@keyframes clear-blur-fade {
  0%   { opacity: 1; filter: blur(0); transform: scale(1); }
  40%  { opacity: 0.9; filter: blur(6px); transform: scale(0.99); }
  100% { opacity: 0; filter: blur(10px); transform: scale(0.96); }
}

/* "清理中" veil — centered over the transcript. Fades in shortly after
   the blur-fade starts, fades out to reveal the post-clear empty state. */
.chat-clearing-veil {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  pointer-events: none;
  animation: clear-veil-in var(--motion-duration-base) var(--motion-ease-enter) both;
  animation-delay: var(--motion-duration-fast);
}
.chat-clearing-veil.exiting {
  animation: clear-veil-out var(--motion-duration-base) var(--motion-ease-exit) both;
  animation-delay: 0s;
}
.chat-clearing-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  animation: clear-spinner 0.7s linear infinite;
}
@keyframes clear-veil-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes clear-veil-out {
  from { opacity: 1; }
  to   { opacity: 0; }
}
@keyframes clear-spinner {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .chat-messages.chat-messages-clearing {
    animation: none;
    opacity: 0;
  }
  .chat-clearing-veil,
  .chat-clearing-veil.exiting {
    animation: none;
  }
  .chat-clearing-spinner {
    animation: none;
  }
}
```

- [ ] **Step 2: Verify no hardcoded hex (CLAUDE.md compliance)**

Run: `git diff src/styles/chat.css` and confirm the added block uses only theme tokens (`--motion-duration-*`, `--motion-ease-*`, `--fg-muted`, `--accent`, `--border`, `--fs-sm`) — no `#rrggbb` literals.

- [ ] **Step 3: Commit**

```bash
git add src/styles/chat.css
git commit -m "style(chat): add clear blur-fade + clearing veil animations"
```

---

## Task 3: Chat.tsx — wire `clearing` state to the `/clear` flow

**Files:**
- Modify: `src/components/Chat.tsx` (state declaration near other `useState`; `onCleared` at line 354; `requestClearSession` at line 820; `<MessageList>` at line 1156)

- [ ] **Step 1: Add the `clearing` state**

In `src/components/Chat.tsx`, near the other `useState` declarations in the component (e.g., alongside `localError`/`setLocalError`), add:

```ts
  /** True while a /clear is in flight. Drives the MessageList blur-fade +
   *  "清理中" veil. Set synchronously on trigger; cleared by the onCleared
   *  WS callback (fires when session-cleared lands, after the store wipe —
   *  so the clearing class is dropped only once the transcript is already
   *  empty, preventing any snap-back). Also cleared in the catch path. */
  const [clearing, setClearing] = useState(false)
```

(If `useState` is not already imported from `react` in this file, add it to the existing `react` import. It almost certainly already is.)

- [ ] **Step 2: Clear the flag in `onCleared`**

In `src/components/Chat.tsx` (~line 351-355), the `useChatStream` call passes `onCleared: permissions.reset`. Change:

```ts
  const stream = useChatStream(session.id, {
    onRequest: permissions.onRequest,
    onResolved: permissions.onResolved,
    onCleared: permissions.reset,
  })
```

to:

```ts
  const stream = useChatStream(session.id, {
    onRequest: permissions.onRequest,
    onResolved: permissions.onResolved,
    onCleared: () => {
      permissions.reset()
      setClearing(false)
    },
  })
```

- [ ] **Step 3: Set the flag on trigger and clear on failure**

In `src/components/Chat.tsx` (~line 820-833), the `requestClearSession` callback. Change:

```ts
  const requestClearSession = useCallback((sessionId: string) => {
    clearError()
    questionDraftsRef.current.clear()
    setMinimizedQ(new Set())
    void api.post(`/sessions/${sessionId}/clear`, {})
      .then(() => {
        permissions.reset()
        clearAttachments()
        pastedImages.clear()
      })
      .catch((e) => {
        setLocalError((e as Error).message)
      })
  }, [clearAttachments, clearError, pastedImages, permissions])
```

to:

```ts
  const requestClearSession = useCallback((sessionId: string) => {
    setClearing(true)
    clearError()
    questionDraftsRef.current.clear()
    setMinimizedQ(new Set())
    void api.post(`/sessions/${sessionId}/clear`, {})
      .then(() => {
        permissions.reset()
        clearAttachments()
        pastedImages.clear()
        // NOTE: clearing is NOT reset here. The onCleared WS callback
        // (fired by the session-cleared frame, in the same handler that
        // wipes the store) drops it — so the blur-fade class is removed
        // only once the transcript is already empty, preventing snap-back.
      })
      .catch((e) => {
        setClearing(false)
        setLocalError((e as Error).message)
      })
  }, [clearAttachments, clearError, pastedImages, permissions])
```

- [ ] **Step 4: Pass `clearing` to `<MessageList>`**

In `src/components/Chat.tsx` (~line 1156), add the `clearing` prop to `<MessageList>`. Add it alongside `replayReady`:

```tsx
        <MessageList
          items={stream.items}
          working={session.working}
          replayReady={stream.replayReady}
          clearing={clearing}
          transcriptRevealKey={session.id}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no new errors. (Runs both `tsc -p tsconfig.json` and `tsc -p tsconfig.node.json`.)

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: PASS — no new errors. (If `useLayoutEffect` deps in MessageList flags on `clearing` only, the `setClearingVeilExiting` setter is stable and correctly omitted — no disable needed. If a `react-hooks/exhaustive-deps` warning appears, verify it's only about the stable setter and is a false positive before deciding to act.)

- [ ] **Step 7: Commit**

```bash
git add src/components/Chat.tsx
git commit -m "feat(chat): wire clearing state to /clear trigger + onCleared"
```

---

## Task 4: Verify — typecheck, lint, full test suite, manual

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: PASS — all server + client tests green, including the two new `MessageList` tests and the existing `useChatStream` session-cleared tests.

- [ ] **Step 2: Typecheck + lint together**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Manual verification (dev server)**

Run: `npm run dev`
Then in the browser:
1. Open a session with several messages.
2. Type `/clear` and send.
3. Confirm: messages blur-fade out over ~320ms, "清理中…" veil appears, then after ~1.7s the empty state fades in as the veil fades out. No snap-back flicker.
4. Toggle `prefers-reduced-motion` (DevTools → Rendering → Emulate CSS prefers-reduced-motion: reduce) and repeat — messages should drop to invisible instantly, veil shows without animation, empty state appears.
5. Toggle light theme and repeat — confirm the veil/spinner use theme tokens (no hardcoded colors).
6. Trigger a clear, then immediately switch sessions mid-clear — confirm no crash, the new panel renders normally.

- [ ] **Step 4: Final commit (if any fixups)**

If manual verification surfaced fixups, commit them. Otherwise no-op.

---

## Self-Review

**1. Spec coverage:**
- "trigger-time blur-fade-out" → Task 1 (class) + Task 2 (keyframes) + Task 3 (set on trigger). ✓
- "清理中 veil during wait" → Task 1 (veil element) + Task 2 (veil CSS). ✓
- "clearing flag local to Chat.tsx, cleared by onCleared after store wipe" → Task 3 Steps 1-2. ✓
- "failed clear un-blurs" → Task 3 Step 3 `.catch`. ✓
- "prefers-reduced-motion degrades to instant fade" → Task 2 reduced-motion block. ✓
- "no store/reducer changes, no useChatStream signature change" → confirmed; onCleared reused. ✓
- "no hardcoded hex" → Task 2 Step 2 verification. ✓
- SideChatDrawer → confirmed not applicable (no /clear in side chats); dropped. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step shows full code. ✓

**3. Type consistency:** `clearing?: boolean` prop (Task 1 Step 4) consumed as `clearing` (Step 5) and `clearing ?? false` (Step 6). `clearing={clearing}` passed from Chat.tsx (Task 3 Step 4) where `clearing` is `boolean` (Task 3 Step 1). `setClearing` used in Task 3 Steps 1-3. Veil class names (`chat-clearing-veil`, `exiting`, `chat-clearing-spinner`, `chat-clearing-label`) match between Task 1 Step 8 (JSX) and Task 2 (CSS) and Task 1 tests. `chat-messages-clearing` matches between Task 1 Step 7 (JSX), Task 2 (CSS), and tests. ✓

**Known limitation (documented):** If the WebSocket is down exactly during a `/clear`, the `session-cleared` frame never reaches the client, so `onCleared` doesn't fire and the panel stays blurred. Recoverable by switching sessions (unmounts `Chat`, resets local state) or retrying once WS reconnects. Accepted as a rare edge — the alternative (clearing the flag in `.then`) risks snap-back when the WS wipe hasn't landed yet.
