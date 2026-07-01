# /clear Animation Survives X→Y ID-Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the blur-fade transition on the local `/clear` path (disabled by commit `794c8e7` when `/clear` switched from same-id wipe to X→Y id-swap), adapted so a slot-level veil DOM survives the swap and provides fade-in → swap-under-opaque-veil → fade-out.

**Architecture:** A new `<PanelSlot>` wrapper keyed by slot index sits **above** `<ErrorBoundary key={s.id}>` in `App.tsx`'s panel `flatMap`; because slot indices are stable across in-place id-swap, `PanelSlot`'s veil DOM survives the ErrorBoundary+ChatPanel remount. A new `useClearAnimation` hook manages the phase state (`Map<panelSessionId, 'fading-in' | 'fading-out'>`) and cleanup timers. `App.handleClear` becomes: fade-in on X + POST in parallel → gate on both → swap X→Y → transition to fade-out → cleanup. A `clearing` boolean is prop-drilled App → ChatPanel → Chat so the existing TodoChecklist / MessageList / MonitorBar content-blur classes activate during fade-in only.

**Tech Stack:** React 19 + Vitest (@testing-library/react, jsdom) for client hook + component tests; TypeScript strict. All timings driven by existing `--motion-duration-*` tokens (`tokens.css`). No new colors, no server changes.

**Spec:** `docs/superpowers/specs/2026-07-01-clear-animation-survives-id-swap-design.md`

## Global Constraints

- **Motion tokens** (from `src/styles/tokens.css`): `--motion-duration-base: 180ms`, `--motion-duration-slow: 320ms`. The veil fade-in / fade-out use `--motion-duration-base` (180ms each); the content blur uses `--motion-duration-slow` (320ms). All timers in JS must match these constants.
- **CSS variable rule (CLAUDE.md)**: never hardcode hex; use theme variables. Any new colors must be defined in both `:root` (dark) and `[data-theme="light"]` blocks.
- **Logging rule (CLAUDE.md)**: no bare `console.*` in application code — this plan writes no server code, so N/A on the client side (browser `console.*` is not gated).
- **Vitest workspaces**: client hook tests run under jsdom (see `vitest.config.ts`). Run `npm run test` for the full suite.
- **Two typechecks**: `npm run typecheck` runs `tsc -p tsconfig.json` (client) + `tsc -p tsconfig.node.json` (node). Both must pass.
- **No new SDK/network coupling**: this is a UI-only refactor. `POST /sessions/:id/clear` behavior is unchanged.
- **Backwards compatibility**: the SDK in-band `cleared` control event path (Chat's local `clearing` state + `useChatStream.onCleared`) must remain functional after this refactor. Local `/clear` and SDK `cleared` both feed the same downstream classes via `effectiveClearing = clearingProp || localClearing` in Chat.

---

## File Structure

**Create:**
- `src/hooks/useClearAnimation.ts` — the state machine + timers.
- `src/hooks/useClearAnimation.test.ts` — unit tests for the hook.
- `src/components/PanelSlot.tsx` — the wrapper that hosts the veil DOM.
- `src/components/PanelSlot.test.tsx` — unit tests.

**Modify:**
- `src/App.tsx` — wrap panels in `<PanelSlot>`; add `useClearAnimation` state; rewrite `handleClear`; add `suppressEnteringRef` and check it in the render-phase entering diff.
- `src/components/ChatPanel.tsx` — new `clearing?: boolean` prop, forwarded to `<Chat>`.
- `src/components/Chat.tsx` — new `clearing?: boolean` prop; `effectiveClearing = clearingProp || localClearing`; delete `useLingerFalse`; wire `effectiveClearing` to TodoChecklist / MessageList / MonitorBar.
- `src/components/MessageList.tsx` — remove the internal veil DOM (`chat-clearing-veil`), remove the `clearingVeil` state + `veilExitTimerRef` block. Keep the `chat-messages-clearing` class application on the messages container.
- `src/styles/chat.css` — add `.panel-slot` and `.panel-clearing-veil` rules; remove obsolete `.chat-clearing-veil` / `.chat-clearing-spinner` / `@keyframes clear-veil-*` / `@keyframes clear-spinner`.
- `src/components/MessageList.test.tsx` — remove/adapt any test asserting the internal veil DOM.

**No changes:**
- Server code, `useChatStream`, TodoChecklist, MonitorBar, permission-broker, session-manager.

---

### Task 1: `useClearAnimation` hook (TDD)

**Files:**
- Create: `src/hooks/useClearAnimation.ts`
- Test: `src/hooks/useClearAnimation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ClearPhase = 'fading-in' | 'fading-out'

  export interface UseClearAnimationOptions {
    fadeInMs?: number    // default 180
    fadeOutMs?: number   // default 180
  }

  export interface UseClearAnimationReturn {
    /** Read-only map of panel session id → phase. */
    clearingByPanel: ReadonlyMap<string, ClearPhase>
    /** Start fade-in on panel `id`. Returns a Promise that resolves after
     *  `fadeInMs` — a "veil is opaque, safe to swap" signal for the caller. */
    beginClear: (id: string) => Promise<void>
    /** Atomically move state from `oldId` to `newId` and transition to
     *  fading-out. Cleanup timer scheduled for `fadeOutMs`. */
    swapAndEnd: (oldId: string, newId: string) => void
    /** Cancel any in-progress clear on panel `id` (POST failure path).
     *  Removes the map entry immediately and clears any pending timer. */
    cancelClear: (id: string) => void
  }

  export function useClearAnimation(
    opts?: UseClearAnimationOptions,
  ): UseClearAnimationReturn
  ```
- Consumes: nothing (leaf hook, uses only `useState` / `useRef` / `useEffect`).

- [ ] **Step 1: Write the first failing test — beginClear sets fading-in**

Create `src/hooks/useClearAnimation.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useClearAnimation } from './useClearAnimation'

describe('useClearAnimation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets fading-in when beginClear is called', () => {
    const { result } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    expect(result.current.clearingByPanel.size).toBe(0)
    act(() => {
      void result.current.beginClear('X')
    })
    expect(result.current.clearingByPanel.get('X')).toBe('fading-in')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useClearAnimation.test.ts`
Expected: FAIL with "Cannot find module './useClearAnimation'".

- [ ] **Step 3: Create the hook skeleton**

Create `src/hooks/useClearAnimation.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'

export type ClearPhase = 'fading-in' | 'fading-out'

export interface UseClearAnimationOptions {
  fadeInMs?: number
  fadeOutMs?: number
}

export interface UseClearAnimationReturn {
  clearingByPanel: ReadonlyMap<string, ClearPhase>
  beginClear: (id: string) => Promise<void>
  swapAndEnd: (oldId: string, newId: string) => void
  cancelClear: (id: string) => void
}

const DEFAULT_FADE_IN_MS = 180
const DEFAULT_FADE_OUT_MS = 180

export function useClearAnimation(
  opts: UseClearAnimationOptions = {},
): UseClearAnimationReturn {
  const fadeInMs = opts.fadeInMs ?? DEFAULT_FADE_IN_MS
  const fadeOutMs = opts.fadeOutMs ?? DEFAULT_FADE_OUT_MS
  const [clearingByPanel, setClearingByPanel] = useState<Map<string, ClearPhase>>(
    () => new Map(),
  )
  const cleanupTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  )

  // Clear any pending cleanup timer on unmount so we don't setState after unmount.
  useEffect(
    () => () => {
      for (const t of cleanupTimersRef.current.values()) clearTimeout(t)
      cleanupTimersRef.current.clear()
    },
    [],
  )

  const cancelTimer = useCallback((id: string) => {
    const t = cleanupTimersRef.current.get(id)
    if (t != null) {
      clearTimeout(t)
      cleanupTimersRef.current.delete(id)
    }
  }, [])

  const beginClear = useCallback(
    (id: string): Promise<void> => {
      cancelTimer(id)
      setClearingByPanel((prev) => {
        const next = new Map(prev)
        next.set(id, 'fading-in')
        return next
      })
      return new Promise<void>((resolve) => {
        setTimeout(resolve, fadeInMs)
      })
    },
    [cancelTimer, fadeInMs],
  )

  const swapAndEnd = useCallback(
    (oldId: string, newId: string): void => {
      cancelTimer(oldId)
      cancelTimer(newId)
      setClearingByPanel((prev) => {
        const next = new Map(prev)
        next.delete(oldId)
        next.set(newId, 'fading-out')
        return next
      })
      const t = setTimeout(() => {
        cleanupTimersRef.current.delete(newId)
        setClearingByPanel((prev) => {
          if (!prev.has(newId)) return prev
          const next = new Map(prev)
          next.delete(newId)
          return next
        })
      }, fadeOutMs)
      cleanupTimersRef.current.set(newId, t)
    },
    [cancelTimer, fadeOutMs],
  )

  const cancelClear = useCallback(
    (id: string): void => {
      cancelTimer(id)
      setClearingByPanel((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    },
    [cancelTimer],
  )

  return { clearingByPanel, beginClear, swapAndEnd, cancelClear }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useClearAnimation.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Add the remaining tests**

Append to `src/hooks/useClearAnimation.test.ts` (inside the same `describe` block):

```ts
  it('beginClear resolves after fadeInMs', async () => {
    const { result } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    let resolved = false
    act(() => {
      void result.current.beginClear('X').then(() => {
        resolved = true
      })
    })
    expect(resolved).toBe(false)
    await act(async () => {
      vi.advanceTimersByTime(179)
    })
    expect(resolved).toBe(false)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(resolved).toBe(true)
  })

  it('swapAndEnd moves state from oldId to newId as fading-out, then clears after fadeOutMs', async () => {
    const { result } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    act(() => {
      void result.current.beginClear('X')
    })
    expect(result.current.clearingByPanel.get('X')).toBe('fading-in')
    act(() => {
      result.current.swapAndEnd('X', 'Y')
    })
    expect(result.current.clearingByPanel.has('X')).toBe(false)
    expect(result.current.clearingByPanel.get('Y')).toBe('fading-out')
    await act(async () => {
      vi.advanceTimersByTime(180)
    })
    expect(result.current.clearingByPanel.has('Y')).toBe(false)
  })

  it('cancelClear removes state immediately and cancels pending cleanup', async () => {
    const { result } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    act(() => {
      void result.current.beginClear('X')
    })
    act(() => {
      result.current.cancelClear('X')
    })
    expect(result.current.clearingByPanel.has('X')).toBe(false)
    // No timer should fire and re-add 'X'.
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current.clearingByPanel.has('X')).toBe(false)
  })

  it('a second beginClear on the same panel cancels the prior cleanup timer', async () => {
    const { result } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    act(() => {
      void result.current.beginClear('X')
    })
    act(() => {
      result.current.swapAndEnd('X', 'Y')
    })
    // Y is fading-out; before cleanup fires, a fresh clear on Y should restart in.
    act(() => {
      void result.current.beginClear('Y')
    })
    expect(result.current.clearingByPanel.get('Y')).toBe('fading-in')
    // Original cleanup timer would have fired at t=180; advance past it and
    // confirm 'Y' still reads 'fading-in' (not deleted).
    await act(async () => {
      vi.advanceTimersByTime(180)
    })
    expect(result.current.clearingByPanel.get('Y')).toBe('fading-in')
  })

  it('cleans up pending timers on unmount', () => {
    const { result, unmount } = renderHook(() =>
      useClearAnimation({ fadeInMs: 180, fadeOutMs: 180 }),
    )
    act(() => {
      void result.current.beginClear('X')
    })
    act(() => {
      result.current.swapAndEnd('X', 'Y')
    })
    // Unmount before fade-out cleanup fires; advancing timers must not throw
    // (no setState after unmount).
    unmount()
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
  })
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useClearAnimation.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useClearAnimation.ts src/hooks/useClearAnimation.test.ts
git commit -m "feat(clear): useClearAnimation hook for slot-level veil state"
```

---

### Task 2: `PanelSlot` component + CSS (TDD)

**Files:**
- Create: `src/components/PanelSlot.tsx`
- Test: `src/components/PanelSlot.test.tsx`
- Modify: `src/styles/chat.css` — add `.panel-slot` + `.panel-clearing-veil` rules.

**Interfaces:**
- Consumes: `ClearPhase` type from `useClearAnimation.ts`.
- Produces:
  ```ts
  export interface PanelSlotProps {
    clearingPhase?: ClearPhase
    children: ReactNode
  }
  export const PanelSlot: React.MemoExoticComponent<
    (props: PanelSlotProps) => JSX.Element
  >
  ```

- [ ] **Step 1: Write the failing test**

Create `src/components/PanelSlot.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PanelSlot } from './PanelSlot'

describe('PanelSlot', () => {
  it('renders children', () => {
    render(
      <PanelSlot>
        <div data-testid="child">hi</div>
      </PanelSlot>,
    )
    expect(screen.getByTestId('child')).toHaveTextContent('hi')
  })

  it('does not render a veil when clearingPhase is undefined', () => {
    const { container } = render(
      <PanelSlot>
        <div />
      </PanelSlot>,
    )
    expect(container.querySelector('.panel-clearing-veil')).toBeNull()
  })

  it('renders the veil with data-phase="fading-in"', () => {
    const { container } = render(
      <PanelSlot clearingPhase="fading-in">
        <div />
      </PanelSlot>,
    )
    const veil = container.querySelector('.panel-clearing-veil')
    expect(veil).not.toBeNull()
    expect(veil?.getAttribute('data-phase')).toBe('fading-in')
    expect(veil?.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders the veil with data-phase="fading-out"', () => {
    const { container } = render(
      <PanelSlot clearingPhase="fading-out">
        <div />
      </PanelSlot>,
    )
    const veil = container.querySelector('.panel-clearing-veil')
    expect(veil?.getAttribute('data-phase')).toBe('fading-out')
  })

  it('veil contains a spinner and a Clearing… label', () => {
    render(
      <PanelSlot clearingPhase="fading-in">
        <div />
      </PanelSlot>,
    )
    expect(screen.getByText(/Clearing/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/PanelSlot.test.tsx`
Expected: FAIL with "Cannot find module './PanelSlot'".

- [ ] **Step 3: Create the component**

Create `src/components/PanelSlot.tsx`:

```tsx
/** One column in the App main-body grid. Wraps <ChatPanel> so a veil DOM
 *  can survive the X→Y id-swap that `/clear` performs on this slot: the
 *  parent `<PanelSlot key={slotIdx}>` is keyed by slot index (stable across
 *  in-place id-swap) so React reuses this element; the child
 *  `<ErrorBoundary key={session.id}>` is keyed by session id, so the panel
 *  subtree remounts on swap. The veil rendered here therefore lives across
 *  the swap and can play a full fade-in → swap-under-veil → fade-out
 *  animation. See `2026-07-01-clear-animation-survives-id-swap-design.md`. */

import { memo } from 'react'
import type { ReactNode } from 'react'
import type { ClearPhase } from '../hooks/useClearAnimation'

export interface PanelSlotProps {
  clearingPhase?: ClearPhase
  children: ReactNode
}

export const PanelSlot = memo(function PanelSlot({
  clearingPhase,
  children,
}: PanelSlotProps) {
  return (
    <div className="panel-slot">
      {children}
      {clearingPhase && (
        <div
          className="panel-clearing-veil"
          data-phase={clearingPhase}
          aria-hidden="true"
        >
          <span className="panel-clearing-spinner" aria-hidden="true" />
          <span className="panel-clearing-label">Clearing…</span>
        </div>
      )}
    </div>
  )
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/PanelSlot.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Add CSS**

Append to `src/styles/chat.css` (just after the existing `.chat-clearing-veil` block, ~line 190; leave the existing block in place for now — task 5 removes it):

```css
/* Slot-level clearing veil — survives the X→Y id-swap that `/clear`
   performs, so the fade-in → swap-under-veil → fade-out animation can
   play across a ChatPanel remount. See PanelSlot.tsx. */
.panel-slot {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.panel-clearing-veil {
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
  background: transparent;
  animation: panel-clear-veil-in var(--motion-duration-base) var(--motion-ease-enter) both;
}
.panel-clearing-veil[data-phase='fading-out'] {
  animation: panel-clear-veil-out var(--motion-duration-base) var(--motion-ease-exit) both;
}
.panel-clearing-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  animation: panel-clear-spinner 0.7s linear infinite;
}
@keyframes panel-clear-veil-in  { from { opacity: 0; } to { opacity: 1; } }
@keyframes panel-clear-veil-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes panel-clear-spinner  { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .panel-clearing-veil,
  .panel-clearing-veil[data-phase='fading-out'] {
    animation: none;
    opacity: 1;
  }
  .panel-clearing-spinner {
    animation: none;
  }
}
```

- [ ] **Step 6: Verify chat-css test still passes**

Run: `npx vitest run src/chat-css.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/PanelSlot.tsx src/components/PanelSlot.test.tsx src/styles/chat.css
git commit -m "feat(clear): PanelSlot wrapper + veil CSS scaffolding"
```

---

### Task 3: Integrate `<PanelSlot>` into `App.tsx` (no state hookup yet)

**Files:**
- Modify: `src/App.tsx` — the `openSessions.flatMap` block (~line 2653-2718).

**Interfaces:**
- Consumes: `PanelSlot` from `../components/PanelSlot`.
- Produces: nothing new (this task is a wrapping-only refactor).

- [ ] **Step 1: Read the current flatMap block**

Read `src/App.tsx:2653-2720` to confirm the structure. The current code looks like:

```tsx
openSessions.flatMap((s, i) => {
  const entering = enteringSetRef.current.has(s.id)
  const owningGroup = groups.find((g) => g.sessionIds.includes(s.id))
  const node = (
    <ErrorBoundary key={s.id}>
      <ChatPanel session={s} ... />
    </ErrorBoundary>
  )
  if (i === openSessions.length - 1) return [node]
  return [
    node,
    <div key={`divider-${i}`} className={...} .../>,
  ]
})
```

- [ ] **Step 2: Add the import**

At the top of `src/App.tsx`, near the `ChatPanel` import (line 7), add:

```tsx
import { PanelSlot } from './components/PanelSlot'
```

- [ ] **Step 3: Wrap ErrorBoundary in PanelSlot**

Modify the `flatMap` block. Change:

```tsx
      const node = (
        <ErrorBoundary key={s.id}>
          <ChatPanel ... />
        </ErrorBoundary>
      )
```

to:

```tsx
      const node = (
        <PanelSlot key={i}>
          <ErrorBoundary key={s.id}>
            <ChatPanel ... />
          </ErrorBoundary>
        </PanelSlot>
      )
```

Note: PanelSlot gets the outer `key={i}` (slot index — stable across id-swap). ErrorBoundary keeps its `key={s.id}` (unchanged — panel subtree still remounts on session change).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run existing tests**

Run: `npm run test`
Expected: PASS (all existing tests unchanged in behavior).

- [ ] **Step 6: Manual layout verification**

Start dev server: `npm run dev`

Open the browser and verify:
- 1-up: single panel fills its column, headers and messages look correct.
- 2-up: open a second session, resize with the divider. Panels stay side-by-side, no overflow.
- 3-up: open a third. Grid template still fr / 4px / fr / 4px / fr — no visual regression.
- Open Settings overlay (per-panel gear) — still positions correctly inside the panel.
- Open Git panel — still positions correctly.

If the panel body height collapses, check that `.panel-slot` has `min-height: 0` and `display: flex; flex-direction: column` (from Task 2's CSS) — this is what lets the inner grid item still fill vertically.

Kill the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(clear): wrap ChatPanel in PanelSlot inside App.tsx"
```

---

### Task 4: Thread `clearing` prop through ChatPanel → Chat (no visible change)

**Files:**
- Modify: `src/components/ChatPanel.tsx` — add optional `clearing?: boolean` prop, forward to `<Chat>`.
- Modify: `src/components/Chat.tsx` — add optional `clearing?: boolean` prop, combine with local: `effectiveClearing = (clearing ?? false) || localClearing`. Wire to TodoChecklist / MessageList / MonitorBar.

**Interfaces:**
- Consumes: nothing (adds new props).
- Produces:
  - `ChatPanelProps` gains `clearing?: boolean`.
  - `Chat` `Props` gains `clearing?: boolean`.

- [ ] **Step 1: Add `clearing` prop to ChatPanel**

In `src/components/ChatPanel.tsx`:

Inside the `ChatPanelProps` interface (right after the existing `entering?: boolean` prop, ~line 96), add:

```tsx
  /** True while App is playing the /clear fade-in on this slot. Threaded
   *  through to <Chat> so TodoChecklist / MessageList / MonitorBar get their
   *  content-blur classes for the duration of the fade-in. */
  clearing?: boolean
```

Add `clearing` to the destructured props (in the `function ChatPanel({ ... }: ChatPanelProps)` signature, ~line 233):

```tsx
  onSideChat,
  settingsTabRequest,
  clearing,
  skin,
```

Forward it to `<Chat>` (in the `<Chat ... />` JSX, ~line 757-796). Add the prop near `focused`:

```tsx
          <Chat
            key={session.id}
            session={session}
            focused={focused}
            clearing={clearing}
            onSessionUpdate={onSessionUpdate}
            ...
          />
```

- [ ] **Step 2: Add `clearing` prop to Chat + wire effectiveClearing**

In `src/components/Chat.tsx`:

Inside the `Props` interface (~line 104), add near `focused`:

```tsx
  /** True while App is playing the /clear fade-in on this panel. Combined
   *  with the local `clearing` state (which serves the SDK in-band cleared
   *  path) via `effectiveClearing = clearingProp || localClearing`. */
  clearing?: boolean
```

In the destructured props (~line 200), add `clearing: clearingProp`:

```tsx
  clearing: clearingProp,
  settingsOpen, onCloseSettings,
```

After the existing `const [clearing, setClearing] = useState(false)` line (~line 257), rename that state to `localClearing` and add the combination. Change:

```tsx
  const [clearing, setClearing] = useState(false)
  // Hold TodoChecklist / MonitorBar mounted through the veil's exit fade so
  // their height doesn't collapse mid-exit and shift the centered "Clearing…"
  // text. 220ms covers the veil's --motion-duration-base (180ms) exit.
  const clearingLinger = useLingerFalse(clearing, 220)
```

to:

```tsx
  /** Local /clear signal — the SDK in-band `cleared` control event flips this
   *  false via onCleared. The local `/clear` command drives the animation via
   *  the App-owned `clearingProp` instead, so this state is only reached by
   *  the SDK-emitted path today. */
  const [localClearing, setLocalClearing] = useState(false)
  /** Effective clearing signal for the downstream classes on TodoChecklist /
   *  MessageList / MonitorBar. During a local `/clear` fade-in it comes from
   *  App via prop; during an SDK-emitted clear it comes from local state. */
  const effectiveClearing = (clearingProp ?? false) || localClearing
```

Update the `onCleared` handler to call `setLocalClearing(false)` (was `setClearing(false)`) — find the `useChatStream({...})` call (~line 411-418):

```tsx
    onCleared: () => {
      permissions.reset()
      setLocalClearing(false)
    },
```

Replace all remaining references to `clearing` (that meant the state) with `effectiveClearing`. Concretely:
- `<TodoChecklist ... clearing={clearingLinger} />` → `<TodoChecklist ... clearing={effectiveClearing} />`
- `<MonitorBar ... clearing={clearingLinger} />` → `<MonitorBar ... clearing={effectiveClearing} />`
- If MessageList receives `clearing={clearing}` anywhere, change to `effectiveClearing`.

**Do not remove `useLingerFalse` in this task** — Task 5 removes it once the old MessageList veil is gone.

Keep `clearingLinger` for now, still computed from `useLingerFalse(effectiveClearing, 220)` — this keeps TodoChecklist/MonitorBar's linger behavior functionally identical to today. Concretely:

```tsx
  const clearingLinger = useLingerFalse(effectiveClearing, 220)
```

And feed `clearingLinger` (not `effectiveClearing`) into TodoChecklist / MonitorBar for now:

```tsx
      <TodoChecklist messages={stream.messages} working={session.working} skin={skin} clearing={clearingLinger} />
      <MonitorBar messages={stream.messages} clearing={clearingLinger} />
```

For MessageList, feed `effectiveClearing` directly (its own internal state machine already handles exit lingering — until Task 5 rips it out):

```tsx
        <MessageList ... clearing={effectiveClearing} />
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run existing tests**

Run: `npm run test`
Expected: PASS (no behavior change — nothing sets clearingProp yet).

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatPanel.tsx src/components/Chat.tsx
git commit -m "feat(clear): thread clearing prop through ChatPanel to Chat"
```

---

### Task 5: Remove old MessageList veil + `useLingerFalse` + obsolete CSS

**Files:**
- Modify: `src/components/MessageList.tsx` — delete the internal veil DOM + `clearingVeil` state machine + `veilExitTimerRef` + `CLEARING_VEIL_EXIT_MS`.
- Modify: `src/components/Chat.tsx` — delete `useLingerFalse` and `clearingLinger`; use `effectiveClearing` directly for TodoChecklist / MonitorBar.
- Modify: `src/styles/chat.css` — remove obsolete `.chat-clearing-veil`, `.chat-clearing-veil.exiting`, `.chat-clearing-spinner`, `.chat-clearing-label`, `@keyframes clear-veil-in`, `@keyframes clear-veil-out`, `@keyframes clear-spinner`, and their `prefers-reduced-motion` overrides. Keep `.chat-messages-clearing` and `@keyframes clear-blur-fade`.
- Modify: `src/components/MessageList.test.tsx` — remove/adapt any test asserting `.chat-clearing-veil`.

**Interfaces:**
- Consumes: `effectiveClearing` from Chat (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Locate & remove the MessageList veil state machine**

In `src/components/MessageList.tsx`:

Delete the block at ~line 209-213 (`STREAMING_EXIT_MS` stays; delete only `CLEARING_VEIL_EXIT_MS` and its comment):

```tsx
const CLEARING_VEIL_EXIT_MS = 180
```
(Grep-verify the constant name against the file — remove that line only.)

Delete the state machine block at ~line 267-294:

```tsx
  const clearingActive = clearing ?? false
  const [clearingVeil, setClearingVeil] = useState({ source: false, exiting: false })
  const nextClearingVeil = clearingActive !== clearingVeil.source
    ? { source: clearingActive, exiting: !clearingActive && clearingVeil.source }
    : clearingVeil
  if (nextClearingVeil !== clearingVeil) {
    setClearingVeil(nextClearingVeil)
  }
  const veilExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (veilExitTimerRef.current) {
      clearTimeout(veilExitTimerRef.current)
      veilExitTimerRef.current = null
    }
    if (!nextClearingVeil.exiting) return
    veilExitTimerRef.current = setTimeout(() => {
      veilExitTimerRef.current = null
      setClearingVeil({ source: false, exiting: false })
    }, CLEARING_VEIL_EXIT_MS)
    return () => {
      if (veilExitTimerRef.current) {
        clearTimeout(veilExitTimerRef.current)
        veilExitTimerRef.current = null
      }
    }
  }, [nextClearingVeil.exiting])
  const veilVisible = clearingActive || nextClearingVeil.exiting
```

Keep only what downstream still needs. Determine that by grepping the file: `clearingActive` was used to apply the `chat-messages-clearing` class. Replace all remaining references to `clearingActive` with `(clearing ?? false)`. If any references to `nextClearingVeil` or `veilVisible` remain, delete them along with their JSX.

Delete the veil JSX at ~line 1355-1360:

```tsx
      {veilVisible && (
        <div className={`chat-clearing-veil${nextClearingVeil.exiting ? ' exiting' : ''}`}>
          <span className="chat-clearing-spinner" aria-hidden="true" />
          <span className="chat-clearing-label">Clearing…</span>
        </div>
      )}
```

Verify that `useRef` / `useEffect` / `useState` imports are still needed by other code in the file; if this was the last consumer, trim the import (unlikely).

- [ ] **Step 2: Update `.chat-messages-clearing` class application**

Confirm the class is still applied. Grep MessageList for `chat-messages-clearing` — it should still appear in the messagesClassName construction. If it referenced `clearingActive`, change to `(clearing ?? false)`. Example:

```tsx
  const messagesClassName = [
    'chat-messages',
    (clearing ?? false) ? 'chat-messages-clearing' : '',
    ...
  ].filter(Boolean).join(' ')
```

- [ ] **Step 3: Delete `useLingerFalse` and `clearingLinger` in Chat**

In `src/components/Chat.tsx`:

Delete the `useLingerFalse` function definition (~line 81-102) — the whole `function useLingerFalse(...)` block and its docblock.

Delete the `clearingLinger` computation added in Task 4:

```tsx
  const clearingLinger = useLingerFalse(effectiveClearing, 220)
```

Update TodoChecklist and MonitorBar to receive `effectiveClearing` directly:

```tsx
      <TodoChecklist messages={stream.messages} working={session.working} skin={skin} clearing={effectiveClearing} />
      <MonitorBar messages={stream.messages} clearing={effectiveClearing} />
```

Rationale: the "hold height through veil exit" concern that motivated `useLingerFalse` was specific to a veil rendered inside MessageList. With the veil now in PanelSlot (above the panel body), TodoChecklist / MonitorBar unmounting mid-veil-exit no longer shifts the veil's centered text — the veil is anchored to the slot, not to MessageList's flow.

- [ ] **Step 4: Remove obsolete CSS**

In `src/styles/chat.css`:

Delete the following blocks (approximate line numbers per current file — grep to confirm before removing):
- `.chat-clearing-veil` (~line 141-154)
- `.chat-clearing-veil.exiting` (~line 155-158)
- `.chat-clearing-spinner` (~line 159-166)
- `@keyframes clear-veil-in` (~line 167-170)
- `@keyframes clear-veil-out` (~line 171-174)
- `@keyframes clear-spinner` (~line 175-177)
- The `.chat-clearing-veil` / `.chat-clearing-veil.exiting` / `.chat-clearing-spinner` blocks inside `@media (prefers-reduced-motion: reduce)` (~line 183-189)

Also grep for `.chat-clearing-label` and remove its rule if any exists.

**Keep:**
- `.chat-messages.chat-messages-clearing` (still applied by MessageList)
- `@keyframes clear-blur-fade` (used by `.chat-messages-clearing`, `.todo-panel-clearing`, `.monitor-bar-clearing`)
- The `@media (prefers-reduced-motion: reduce) .chat-messages.chat-messages-clearing` rule.

Grep-verify nothing outside chat.css references the removed classes:

```bash
git grep -nE 'chat-clearing-(veil|spinner|label)' src/
```
Expected: no matches after removal.

- [ ] **Step 5: Update MessageList tests**

Open `src/components/MessageList.test.tsx`. Grep for `chat-clearing-veil` or `Clearing…` inside test assertions. Remove any tests that asserted the internal veil DOM. If those tests were the only tests referencing `clearing`, they are safely deletable (the wrapper-level veil is now tested in `PanelSlot.test.tsx`).

Any test that verifies `.chat-messages-clearing` class application on the messages container should be kept — the class survives this refactor.

- [ ] **Step 6: Run tests**

Run: `npm run test`
Expected: PASS. If any test fails on missing veil DOM, adapt or delete per Step 5.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Lint**

Run: `npm run lint`
Expected: no errors. If unused-import errors appear (e.g. `useEffect` no longer used in MessageList), remove them.

- [ ] **Step 9: Commit**

```bash
git add src/components/MessageList.tsx src/components/Chat.tsx src/styles/chat.css src/components/MessageList.test.tsx
git commit -m "refactor(clear): remove MessageList veil + useLingerFalse (superseded by PanelSlot)"
```

---

### Task 6: Wire `useClearAnimation` + `suppressEnteringRef` into `App.handleClear`

**Files:**
- Modify: `src/App.tsx` — add `useClearAnimation` state, `suppressEnteringRef`, rewrite `handleClear`, update the render-phase entering diff, thread `clearing` + `clearingPhase` to PanelSlot / ChatPanel.

**Interfaces:**
- Consumes: `useClearAnimation` from `../hooks/useClearAnimation`, `PanelSlot` (already imported).
- Produces: nothing new externally; new internal `suppressEnteringRef: MutableRefObject<Set<string>>`.

- [ ] **Step 1: Add the imports**

In `src/App.tsx`, near the other hook imports:

```tsx
import { useClearAnimation } from './hooks/useClearAnimation'
```

- [ ] **Step 2: Instantiate the hook**

Near where other useCallback / useState blocks live in App (before `handleClear`, ~line 2300), add:

```tsx
  /** Manages the veil phase state for local `/clear` fade-in → swap → fade-out.
   *  Keyed by panel session id (which changes X→Y during the swap; the hook's
   *  `swapAndEnd` atomically moves state from X to Y). See PanelSlot.tsx and
   *  `docs/superpowers/specs/2026-07-01-clear-animation-survives-id-swap-design.md`. */
  const clearAnim = useClearAnimation()
```

- [ ] **Step 3: Add `suppressEnteringRef`**

Near the existing `enteringSetRef` declaration (~line 1709), add:

```tsx
  /** Panel session ids that should be skipped by the render-phase entering
   *  diff — used by `/clear` so the new session Y doesn't play its mount
   *  animation under the fade-out veil (would look like double-animation).
   *  Entries are cleared in a useLayoutEffect after the render that
   *  handled the swap. */
  const suppressEnteringRef = useRef<Set<string>>(new Set())
```

- [ ] **Step 4: Update the render-phase entering diff**

Find the render-phase diff at ~line 1711-1717:

```tsx
  if (prevOpenIdsRef.current !== openIds) {
    const prevSet = new Set(prevOpenIdsRef.current)
    for (const id of openIds) {
      if (!prevSet.has(id)) enteringSetRef.current.add(id)
    }
    prevOpenIdsRef.current = openIds
  }
```

Change to:

```tsx
  if (prevOpenIdsRef.current !== openIds) {
    const prevSet = new Set(prevOpenIdsRef.current)
    for (const id of openIds) {
      if (!prevSet.has(id) && !suppressEnteringRef.current.has(id)) {
        enteringSetRef.current.add(id)
      }
    }
    prevOpenIdsRef.current = openIds
  }
```

Add a `useLayoutEffect` immediately after this block to clear the suppress set after render:

```tsx
  useLayoutEffect(() => {
    if (suppressEnteringRef.current.size > 0) {
      suppressEnteringRef.current.clear()
    }
  })
```

No dependency array on purpose — this fires every commit, and it's O(1) when the set is already empty.

- [ ] **Step 5: Rewrite `handleClear`**

Replace the current `handleClear` (~line 2309-2344) with:

```tsx
  /** `/clear` a panel: fade-in on X in parallel with the POST, then swap
   *  X→Y under the fully-opaque veil, then fade-out to reveal Y's fresh
   *  empty state. The server detaches X as a dormant resumable session and
   *  returns a fresh session Y under a new id; App swaps the panel slot
   *  X→Y at the same position (mirrors handleRestart's in-place id swap).
   *  X stays in the sidebar as dormant (the server's session-update broadcast
   *  dims it); Y takes X's group slot so the active group view stays
   *  consistent, and X leaves the group — it's now a standalone resumable
   *  past session, recoverable via the resume picker. */
  const handleClear = useCallback(
    async (id: string) => {
      const sourceGroup = groups.find((g) => g.sessionIds.includes(id))
      const wasOpen = openIds.includes(id)
      try {
        // Fade-in on X and the POST run in parallel. Promise.all gates the
        // swap on BOTH: the fade-in Promise resolves after --motion-duration-base
        // (180 ms — veil is fully opaque), the POST resolves whenever the
        // server responds. In the common case (POST < 200 ms) we're waiting
        // on the animation; under slow POST we wait on the network. Either
        // way, the swap happens only under an opaque veil, so Y never
        // flashes into view.
        const [res] = await Promise.all([
          api.post<{ session: SessionInfo }>(`/sessions/${id}/clear`, {}),
          clearAnim.beginClear(id),
        ])
        const newId = res.session.id
        // Suppress Y's mount animation — the veil fade-out is the visual
        // transition here; playing the panel-enter animation on top would
        // look like a double-animation under the receding veil.
        suppressEnteringRef.current.add(newId)
        if (wasOpen) {
          setOpenIds((prev) => {
            const idx = prev.indexOf(id)
            if (idx === -1) return prev
            const next = prev.slice()
            next[idx] = newId
            return next
          })
          setFocusedId((prev) => (prev === id ? newId : prev))
        }
        setLastSeenTurn((prev) => ({ ...prev, [newId]: res.session.lastTurnAt ?? Date.now() }))
        if (sourceGroup) {
          setGroups((prev) =>
            prev.map((g) => {
              if (g.id !== sourceGroup.id) return g
              const idx = g.sessionIds.indexOf(id)
              if (idx === -1) return g
              const next = g.sessionIds.slice()
              next[idx] = newId
              return { ...g, sessionIds: next }
            }),
          )
        }
        // Atomically move veil state from X to Y, transition to fade-out.
        // The hook schedules cleanup at fadeOutMs (180 ms).
        clearAnim.swapAndEnd(id, newId)
      } catch (e) {
        // Drop the veil immediately — X is untouched (server didn't act).
        clearAnim.cancelClear(id)
        toast.error(`Couldn't clear session: ${(e as Error).message}`)
      }
    },
    [groups, openIds, toast, setLastSeenTurn, setGroups, clearAnim],
  )
```

- [ ] **Step 6: Thread `clearingPhase` + `clearing` down to PanelSlot / ChatPanel**

In the `openSessions.flatMap` block (~line 2653-2718), compute the phase for this slot's panel and pass it to `<PanelSlot>` + `<ChatPanel>`:

```tsx
    openSessions.flatMap((s, i) => {
      const entering = enteringSetRef.current.has(s.id)
      const owningGroup = groups.find((g) => g.sessionIds.includes(s.id))
      const clearingPhase = clearAnim.clearingByPanel.get(s.id)
      const node = (
        <PanelSlot key={i} clearingPhase={clearingPhase}>
          <ErrorBoundary key={s.id}>
            <ChatPanel
              session={s}
              focused={s.id === focusedId}
              clearing={clearingPhase === 'fading-in'}
              hasUnread={!!unread[s.id]}
              ...
            />
          </ErrorBoundary>
        </PanelSlot>
      )
```

Key detail: pass `clearing={clearingPhase === 'fading-in'}` — not `clearingPhase === 'fading-out'`. During fade-out, Y is mounted with `clearing=false` (Y should never blur its own content — it's a fresh session, the veil above it is doing all the work). Only during fade-in does X get its content-blur classes.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Run all tests**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 9: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/App.tsx
git commit -m "feat(clear): wire useClearAnimation into handleClear (animation live)"
```

---

### Task 7: End-to-end verification, manual QA, and final commit

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: PASS across all client and server test files.

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`
Expected: no errors in either tsconfig.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Manual QA**

Start dev server: `npm run dev`

Open a browser at `http://localhost:5174` and run through the scenarios below. **For each scenario, verify the visual sequence: X's content blurs out (TodoChecklist / MonitorBar / messages) → veil fades in and becomes opaque → panel content silently swaps to Y underneath (no visible flash) → veil fades out revealing Y's empty state.**

1. **Happy path (1-up)**: create session with a few messages + a running Todo. Type `/clear` in composer, submit. Verify sequence completes cleanly in ~400 ms (180 ms fade-in + up to 180 ms POST + 180 ms fade-out).
2. **Happy path (2-up, 3-up)**: repeat with 2 and 3 panels open. Verify only the clearing panel's slot shows the veil; siblings are undisturbed.
3. **Scrolled-up transcript**: scroll one panel up mid-transcript, then `/clear`. Veil should cover the visible scroll position; Y appears at empty state.
4. **Permission dialog open**: open a permission request on X, then `/clear`. Permission dialog should close naturally (X unmounted → dialog inside X unmounts).
5. **Composer has text**: type a draft into the composer, then `/clear`. Y should mount with an empty composer.
6. **Rapid double-`/clear` on same slot**: `/clear` a panel; while the fade-out is still running, `/clear` the newly-appeared Y. The hook's `beginClear` should cancel the pending fade-out timer and restart fade-in cleanly.
7. **Two panels clearing at once**: `/clear` panel A, then `/clear` panel B before A finishes. Both slots show their own veils simultaneously; states don't cross-contaminate.
8. **Close panel mid-clear**: `/clear` a panel; while it's fading in, click the close button. Panel unmounts cleanly; no console errors; the fade-out timer that would have fired later doesn't crash.
9. **POST fails**: throttle the network or point `/api` at an unreachable URL. `/clear` should show a brief veil, then drop it and show a toast. X remains live and interactive.
10. **`prefers-reduced-motion: reduce`**: enable in browser dev-tools (or system prefs). `/clear`: veil should appear/disappear without animation but state machine still gates on the 180 ms timer (imperceptible). Content blur is also disabled (CSS `.chat-messages-clearing` already has a `prefers-reduced-motion` rule).
11. **SDK in-band cleared path**: if reachable (via a specific tool or workflow that causes the SDK to emit `cleared`), verify the animation still runs. **If not reachable in dev** — verify code-wise that `useChatStream.onCleared` → `setLocalClearing(false)` still fires and that `effectiveClearing` correctly reflects `localClearing` when `clearingProp` is undefined.

If any scenario fails, do NOT proceed to Step 5. Reopen the relevant task and fix.

Kill the dev server.

- [ ] **Step 5: Final review of diff**

Run: `git log --oneline main..HEAD`
Expected: 6 commits (one per task 1-6).

Run: `git diff main..HEAD --stat`
Expected files touched:
- New: `src/hooks/useClearAnimation.ts`, `src/hooks/useClearAnimation.test.ts`, `src/components/PanelSlot.tsx`, `src/components/PanelSlot.test.tsx`
- Modified: `src/App.tsx`, `src/components/ChatPanel.tsx`, `src/components/Chat.tsx`, `src/components/MessageList.tsx`, `src/components/MessageList.test.tsx`, `src/styles/chat.css`

- [ ] **Step 6: Update the spec's Status field**

Edit `docs/superpowers/specs/2026-07-01-clear-animation-survives-id-swap-design.md`:

```
- **Status:** Draft
+ **Status:** Implemented
```

- [ ] **Step 7: Commit the status update**

```bash
git add docs/superpowers/specs/2026-07-01-clear-animation-survives-id-swap-design.md
git commit -m "docs: mark clear-animation spec as implemented"
```

---

## Notes on Spec ⇄ Plan Deviations

The spec proposed keying `clearingSlots` by **slot index** (`Map<number, ClearPhase>`). This plan keys the animation state by **panel session id** (`Map<string, ClearPhase>`) inside the `useClearAnimation` hook. Reasoning:

- Session id at PanelSlot render time is stable enough for lookups (`clearAnim.clearingByPanel.get(s.id)`). When the swap happens, `swapAndEnd(oldId, newId)` atomically moves the entry.
- Slot indices renumber when a middle panel closes; keying by slot index would need a reconciliation step (spec §"Panel close mid-clear"). Session-id keying makes that reconciliation unnecessary — a stale entry becomes unreachable (no PanelSlot reads it) and its cleanup timer expires it naturally.
- The `<PanelSlot key={i}>` **DOM survival** contract (spec's core insight) is unaffected: the slot-index key on the wrapper is what makes the DOM node survive; the state key inside the animation hook is separate.

This is a purely internal refinement — the observable behavior matches the spec. Every spec section's Approach still applies.
