# `/clear` Optimistic Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing (dormant) `clearing` blur-fade + "Clearing…" veil fire immediately on `/clear`, before the blocking POST, by extracting a `useClearSession` hook that sets `clearing=true` synchronously and rolls back only on failure.

**Architecture:** The `clearing`-driven animation infrastructure (CSS, `MessageList` veil, `MonitorBar`/`TodoChecklist` clearing props) is already built and tested — only the trigger is missing. We extract `clearing` state + `requestClearSession` + `clearingLinger` out of `Chat.tsx` into a testable `useClearSession` hook. `onClearSession` becomes `Promise<boolean>` so the hook can roll back `clearing` on failure; success relies on the panel-id swap unmounting `Chat(X)` (discarding `clearing` with it).

**Tech Stack:** React 19, TypeScript, Vitest, @testing-library/react (`renderHook`/`act`).

**Spec:** `docs/superpowers/specs/2026-07-01-clear-optimistic-animation-design.md`

---

## File Structure

- **Create** `src/hooks/useClearSession.ts` — owns `clearing` state, `clearingLinger`, `requestClearSession`. Also holds `useLingerFalse` (moved from `Chat.tsx`). Single responsibility: the /clear trigger lifecycle + animation gate.
- **Create** `src/hooks/useClearSession.test.ts` — `renderHook` tests for the trigger/rollback/linger behavior.
- **Modify** `src/components/Chat.tsx` — remove inline `useLingerFalse`/`clearing`/`clearingLinger`/`requestClearSession`; call `useClearSession`; drop the dead `setClearing(false)` from `onCleared`; widen `onClearSession` prop type to `Promise<boolean>`.
- **Modify** `src/App.tsx` — `handleClear` returns `Promise<boolean>` (`true` success / `false` failure).
- **Modify** `src/components/ChatPanel.tsx` — `onClearSession` prop type `void` → `Promise<boolean>` (passthrough only).

**Unchanged:** `MessageList`, `MonitorBar`, `TodoChecklist`, all CSS, `local-commands.ts` (`clearSession: void` stays — `Promise<void>` is assignable to `void`), the server.

**Ordering rationale:** Task 2 (widening the prop type to `Promise<boolean>` in `App` + `ChatPanel`) lands before Task 3 (consuming it in `Chat`). This keeps typecheck green at every commit: a `Promise<boolean>`-returning function is assignable to a `void`-returning prop type, so `Chat`'s still-`void` `onClearSession` prop accepts `handleClear` until Task 3 widens it.

---

## Task 1: Create `useClearSession` hook (TDD)

**Files:**
- Create: `src/hooks/useClearSession.ts`
- Test: `src/hooks/useClearSession.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/hooks/useClearSession.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useClearSession } from './useClearSession'

describe('useClearSession', () => {
  it('starts with clearing and clearingLinger false', () => {
    const { result } = renderHook(() =>
      useClearSession({
        onClearSession: vi.fn(() => Promise.resolve(true)),
        clearError: vi.fn(),
      }),
    )
    expect(result.current.clearing).toBe(false)
    expect(result.current.clearingLinger).toBe(false)
  })

  it('sets clearing true synchronously and calls clearError + onClearSession on trigger', async () => {
    const onClearSession = vi.fn(() => Promise.resolve(true))
    const clearError = vi.fn()
    const { result } = renderHook(() => useClearSession({ onClearSession, clearError }))

    let p: Promise<void> | undefined
    act(() => {
      p = result.current.requestClearSession('s1')
    })
    // Synchronous, before the await:
    expect(result.current.clearing).toBe(true)
    expect(clearError).toHaveBeenCalledTimes(1)
    expect(onClearSession).toHaveBeenCalledWith('s1')

    await act(async () => {
      await p
    })
  })

  it('keeps clearing true on success (unmount discards it, not the hook)', async () => {
    const onClearSession = vi.fn(() => Promise.resolve(true))
    const { result } = renderHook(() =>
      useClearSession({ onClearSession, clearError: vi.fn() }),
    )
    let p: Promise<void> | undefined
    act(() => {
      p = result.current.requestClearSession('s1')
    })
    await act(async () => {
      await p
    })
    expect(result.current.clearing).toBe(true)
  })

  it('rolls back clearing to false when onClearSession resolves false', async () => {
    const onClearSession = vi.fn(() => Promise.resolve(false))
    const { result } = renderHook(() =>
      useClearSession({ onClearSession, clearError: vi.fn() }),
    )
    let p: Promise<void> | undefined
    act(() => {
      p = result.current.requestClearSession('s1')
    })
    await act(async () => {
      await p
    })
    expect(result.current.clearing).toBe(false)
  })

  it('rolls back clearing to false when onClearSession rejects', async () => {
    const onClearSession = vi.fn(() => Promise.reject(new Error('boom')))
    const { result } = renderHook(() =>
      useClearSession({ onClearSession, clearError: vi.fn() }),
    )
    let p: Promise<void> | undefined
    act(() => {
      p = result.current.requestClearSession('s1')
    })
    await act(async () => {
      await p
    })
    expect(result.current.clearing).toBe(false)
  })

  it('clearingLinger holds true for 220ms after clearing flips false', async () => {
    vi.useFakeTimers()
    const onClearSession = vi.fn(() => Promise.resolve(false))
    const { result } = renderHook(() =>
      useClearSession({ onClearSession, clearError: vi.fn() }),
    )
    let p: Promise<void> | undefined
    act(() => {
      p = result.current.requestClearSession('s1')
    })
    await act(async () => {
      await p
    })
    // clearing just flipped false; linger still holds:
    expect(result.current.clearing).toBe(false)
    expect(result.current.clearingLinger).toBe(true)

    act(() => {
      vi.advanceTimersByTime(219)
    })
    expect(result.current.clearingLinger).toBe(true)

    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(result.current.clearingLinger).toBe(false)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/hooks/useClearSession.test.ts`
Expected: FAIL — `Cannot find module './useClearSession'` (or `useClearSession is not defined`).

- [ ] **Step 3: Write the minimal implementation**

Create `src/hooks/useClearSession.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'

/** Returns `true` while `value` is true, and keeps returning true for `ms`
 *  after it flips false. Used to hold TodoChecklist / MonitorBar mounted
 *  (faded, but occupying their height) through the "Clearing…" veil's exit
 *  animation: without it, they unmount the instant `clearing` ends, their
 *  height collapses, and the vertically-centered veil text jumps down
 *  mid-fade. The veil itself (in MessageList) uses the real `clearing` so
 *  its exit timing is unchanged. */
export function useLingerFalse(value: boolean, ms: number): boolean {
  const [lingered, setLingered] = useState(value)
  // When `value` is (or becomes) true, lingered must be true immediately —
  // fix it during render (React's adjust-state-during-render escape hatch)
  // rather than with a synchronous setState in an effect, which the
  // react-hooks rules flag as a cascading-render hazard. Guarded so it fires
  // at most once per true transition.
  if (value && !lingered) setLingered(true)
  useEffect(() => {
    if (value) return
    const t = setTimeout(() => setLingered(false), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return lingered
}

/** How long TodoChecklist / MonitorBar stay mounted after `clearing` flips
 *  false — covers the veil's --motion-duration-base (180ms) exit. */
const LINGER_MS = 220

interface UseClearSessionArgs {
  /** POST /sessions/:id/clear and swap the panel id. Resolves true on
   *  success, false on failure (POST rejected). */
  onClearSession: (sessionId: string) => Promise<boolean>
  /** Clear the panel's local error banner before starting the clear. */
  clearError: () => void
}

interface UseClearSessionResult {
  /** True while a /clear is in flight. Drives MessageList blur-fade + veil. */
  clearing: boolean
  /** `clearing` held true for LINGER_MS after it flips false, so
   *  TodoChecklist / MonitorBar stay mounted through the veil's exit fade. */
  clearingLinger: boolean
  /** Optimistic: set clearing=true synchronously, await onClearSession, and
   *  roll back (clearing=false) only on failure. Success relies on the panel
   *  id swap unmounting this Chat (discarding `clearing` with it). */
  requestClearSession: (sessionId: string) => Promise<void>
}

export function useClearSession({
  onClearSession,
  clearError,
}: UseClearSessionArgs): UseClearSessionResult {
  const [clearing, setClearing] = useState(false)
  const clearingLinger = useLingerFalse(clearing, LINGER_MS)

  const requestClearSession = useCallback(
    async (sessionId: string) => {
      clearError()
      setClearing(true)
      try {
        const ok = await onClearSession(sessionId)
        if (!ok) setClearing(false)
      } catch {
        setClearing(false)
      }
    },
    [onClearSession, clearError],
  )

  return { clearing, clearingLinger, requestClearSession }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/hooks/useClearSession.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean (the new hook is self-contained; nothing imports it yet).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useClearSession.ts src/hooks/useClearSession.test.ts
git commit -m "feat(hooks): add useClearSession hook for optimistic /clear animation

Extracts clearing state + requestClearSession + clearingLinger into a
testable hook. Sets clearing=true synchronously, rolls back only on
failure (onClearSession returns false or rejects). Success relies on the
panel-id swap unmounting Chat.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: `handleClear` returns `Promise<boolean>`; widen `ChatPanel` prop type

**Files:**
- Modify: `src/App.tsx` (`handleClear`, lines ~2309-2344)
- Modify: `src/components/ChatPanel.tsx` (prop type, line ~133)

- [ ] **Step 1: Change `handleClear` to return `Promise<boolean>`**

In `src/App.tsx`, edit `handleClear`. Add `return true` at the end of the `try` block (after the `setGroups` call) and `return false` in the `catch` block (after the toast). The signature becomes `(id: string) => Promise<boolean>`.

Current (`src/App.tsx:2309-2344`):
```ts
  const handleClear = useCallback(
    async (id: string) => {
      const sourceGroup = groups.find((g) => g.sessionIds.includes(id))
      const wasOpen = openIds.includes(id)
      try {
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/clear`, {})
        const newId = res.session.id
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
      } catch (e) {
        toast.error(`Couldn't clear session: ${(e as Error).message}`)
      }
    },
    [groups, openIds, toast, setLastSeenTurn, setGroups],
  )
```

New:
```ts
  const handleClear = useCallback(
    async (id: string): Promise<boolean> => {
      const sourceGroup = groups.find((g) => g.sessionIds.includes(id))
      const wasOpen = openIds.includes(id)
      try {
        const res = await api.post<{ session: SessionInfo }>(`/sessions/${id}/clear`, {})
        const newId = res.session.id
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
        return true
      } catch (e) {
        toast.error(`Couldn't clear session: ${(e as Error).message}`)
        return false
      }
    },
    [groups, openIds, toast, setLastSeenTurn, setGroups],
  )
```

- [ ] **Step 2: Widen `ChatPanel`'s `onClearSession` prop type**

In `src/components/ChatPanel.tsx` line 133, change:

```ts
  onClearSession: (panelSessionId: string) => void
```

to:

```ts
  onClearSession: (panelSessionId: string) => Promise<boolean>
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean. (`Chat.tsx` still types its `onClearSession` prop as `void`; `handleClear` (`Promise<boolean>`) is assignable to that, so the `App → ChatPanel → Chat` prop chain typechecks. This intermediate state is intentionally green.)

- [ ] **Step 4: Run lint + tests**

Run: `npm run lint && npm run test`
Expected: clean / green. No behavior change yet — `handleClear`'s return value is not consumed until Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/ChatPanel.tsx
git commit -m "refactor(clear): handleClear returns Promise<boolean>

Signal success/failure so the upcoming useClearSession hook can roll back
the clearing veil on failure. ChatPanel prop type widened to match; Chat
still accepts the wider type via void-return assignability until the next
commit wires the hook.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Wire `useClearSession` into `Chat.tsx`

**Files:**
- Modify: `src/components/Chat.tsx`

- [ ] **Step 1: Add the import**

In `src/components/Chat.tsx`, after line 23 (`import { useChatStream } from '../hooks/useChatStream'`), add:

```ts
import { useClearSession } from '../hooks/useClearSession'
```

- [ ] **Step 2: Remove the inline `useLingerFalse` function**

Delete lines 81-102 of `src/components/Chat.tsx` (the JSDoc comment + the `useLingerFalse` function):

```ts
/** Returns `true` while `value` is true, and keeps returning true for `ms`
 *  after it flips false. Used to hold TodoChecklist / MonitorBar mounted
 *  (faded, but occupying their height) through the "Clearing…" veil's exit
 *  animation: without it, they unmount the instant `clearing` ends, their
 *  height collapses, and the vertically-centered veil text jumps down
 *  mid-fade. The veil itself (in MessageList) uses the real `clearing` so
 *  its exit timing is unchanged. */
function useLingerFalse(value: boolean, ms: number): boolean {
  const [lingered, setLingered] = useState(value)
  // When `value` is (or becomes) true, langered must be true immediately —
  // fix it during render (React's adjust-state-during-render escape hatch)
  // rather than with a synchronous setState in an effect, which the
  // react-hooks rules flag as a cascading-render hazard. Guarded so it fires
  // at most once per true transition.
  if (value && !lingered) setLingered(true)
  useEffect(() => {
    if (value) return
    const t = setTimeout(() => setLingered(false), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return lingered
}
```

(It now lives in `src/hooks/useClearSession.ts`.)

- [ ] **Step 3: Remove the inline `clearing` state + `clearingLinger`**

Delete lines 252-261 of `src/components/Chat.tsx`:

```ts
  /** True while a /clear is in flight. Drives the MessageList blur-fade +
   *  "Clearing…" veil. Set synchronously on trigger; cleared by the onCleared
   *  WS callback (fires when session-cleared lands, after the store wipe —
   *  so the clearing class is dropped only once the transcript is already
   *  empty, preventing any snap-back). Also cleared in the catch path. */
  const [clearing, setClearing] = useState(false)
  // Hold TodoChecklist / MonitorBar mounted through the veil's exit fade so
  // their height doesn't collapse mid-exit and shift the centered "Clearing…"
  // text. 220ms covers the veil's --motion-duration-base (180ms) exit.
  const clearingLinger = useLingerFalse(clearing, 220)
```

- [ ] **Step 4: Drop the dead `setClearing(false)` from `onCleared`**

In `src/components/Chat.tsx`, the `useChatStream` `onCleared` callback (lines 414-417) currently reads:

```ts
    onCleared: () => {
      permissions.reset()
      setClearing(false)
    },
```

Change it to (remove the `setClearing(false)` line — `setClearing` no longer exists in `Chat.tsx`; the `session-cleared` WS frame does not fire on the local `/clear` path, so this unset was already dead):

```ts
    onCleared: () => {
      permissions.reset()
    },
```

- [ ] **Step 5: Add the `useClearSession` call after `clearError`**

In `src/components/Chat.tsx`, immediately after the `clearError` `useCallback` (which ends at line 844 — the block reading `}, [clearStreamError, clearAttachmentsError, clearPermissionsError])`), insert:

```ts
  const { clearing, clearingLinger, requestClearSession } = useClearSession({
    onClearSession,
    clearError,
  })
```

(Placed here — not where `clearing` used to live — because the hook needs `clearError`, which is defined just above. All `clearing` / `clearingLinger` consumers — `MessageList`, `TodoChecklist`, `MonitorBar`, `RecapWindow` — render after this point.)

- [ ] **Step 6: Remove the inline `requestClearSession` `useCallback`**

Delete lines 883-894 of `src/components/Chat.tsx`:

```ts
  const requestClearSession = useCallback((sessionId: string) => {
    // App owns the POST + panel id-swap: the server detaches the pre-clear
    // conversation as a dormant resumable session and returns a fresh session
    // Y under a new id; App swaps this panel from X to Y. X unmounts (its
    // transcript/permissions/attachments state is discarded), Y mounts fresh.
    // We deliberately do NOT set `clearing` here — the blur-fade was tied to
    // the old same-id wipe, and a stuck "Clearing…" veil on a failed POST
    // (onCleared never fires for a local /clear) isn't worth the transition.
    // `clearing` remains wired for the SDK's own in-band `cleared` event.
    clearError()
    onClearSession(sessionId)
  }, [clearError, onClearSession])
```

(`requestClearSession` now comes from the hook. `send()`'s `clearSession: requestClearSession` at line 967 is unchanged and picks up the hook's version.)

- [ ] **Step 7: Widen `Chat`'s `onClearSession` prop type**

In `src/components/Chat.tsx` line 121, change:

```ts
  onClearSession: (panelSessionId: string) => void
```

to:

```ts
  onClearSession: (panelSessionId: string) => Promise<boolean>
```

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: clean. The full `App → ChatPanel → Chat` prop chain is now `Promise<boolean>` end to end; `useClearSession` consumes it; `local-commands.ts`'s `clearSession: void` still accepts the hook's `Promise<void>` return.

- [ ] **Step 9: Run lint + tests**

Run: `npm run lint && npm run test`
Expected: clean / green. The existing `MessageList.test.tsx`, `MonitorBar.test.tsx`, `TodoChecklist.test.tsx` clearing-prop tests stay green (unchanged components). `useClearSession.test.ts` stays green.

- [ ] **Step 10: Commit**

```bash
git add src/components/Chat.tsx
git commit -m "feat(clear): fire blur-fade + veil immediately on /clear

Wire useClearSession into Chat: setClearing(true) now fires synchronously
on the /clear trigger, before the blocking POST. Success relies on the
panel-id swap unmounting Chat (discarding clearing); failure rolls back
via the hook's try/catch on onClearSession's boolean return. Removes the
inline clearing state, useLingerFalse, and requestClearSession (all moved
to the hook), and the dead setClearing(false) in onCleared.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Verify

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck (both tsconfigs)**

Run: `npm run typecheck`
Expected: both `tsc -p tsconfig.json` and `tsc -p tsconfig.node.json` clean.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: all green, including the new `useClearSession.test.ts` and the existing `MessageList`/`MonitorBar`/`TodoChecklist` clearing tests.

- [ ] **Step 4: Manual verification — success path**

Run: `npm run dev`
- Open the app, start a session, send a few messages so the transcript is non-empty.
- Type `/clear` and press Enter.
- **Expected:** within the same frame, the transcript blur-fades out (320ms) and a "Clearing…" veil with a spinner fades in over it. After ~1.7s the panel swaps to a fresh empty session (no frozen transcript, no perceived stutter before the animation).

- [ ] **Step 5: Manual verification — failure path**

- Stop the dev server (so the POST will fail), or point the clear at an invalid session id.
- With the server down, type `/clear` and press Enter.
- **Expected:** the blur-fade + veil start immediately, then a toast `Couldn't clear session: …` appears and the messages snap back to fully visible (veil fades out via its exiting state). No stuck "Clearing…" veil.
- Restart the server.

- [ ] **Step 6: Manual verification — reduced motion**

- In DevTools, emulate `prefers-reduced-motion: reduce`.
- Type `/clear`.
- **Expected:** no blur/transition animation (CSS disables it); the transcript is replaced by the empty state after the POST resolves. No stuck veil.

- [ ] **Step 7: Final commit (if any fixups were needed)**

Only if Steps 1-6 required changes. Otherwise this step is a no-op.

```bash
git add -A
git commit -m "fix(clear): verification fixups

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review Notes

**Spec coverage:**
- "Revive the existing `clearing` blur-fade + veil" → Task 3 wires `clearing=true` to the trigger; the animation CSS/components are unchanged and already tested.
- "Failure → snap-back + toast" → Task 1 hook rolls back `clearing` on `false`/reject; toast stays in `handleClear` (Task 2).
- "Success relies on unmount" → Task 1 hook does NOT unset on `true`; the panel swap unmounts `Chat(X)` (existing `handleClear` behavior).
- "`onClearSession` returns `Promise<boolean>`" → Task 2 (`App` + `ChatPanel`) + Task 3 (`Chat`).
- "Extract `useClearSession` hook" → Task 1.
- "Unchanged: `MessageList`/`MonitorBar`/`TodoChecklist`/CSS/server/`local-commands.ts`" → no tasks touch them.

**Deviation from spec (noted, consistent with spec intent):** The spec's hook signature is `useClearSession({ onClearSession, clearError })` with no `markCleared`. Consequently the dead `setClearing(false)` call in `Chat.tsx`'s `onCleared` WS callback (line 416) is removed in Task 3 Step 4 — `setClearing` is now encapsulated in the hook and not exposed. This is safe: the `session-cleared` frame does not fire on the local `/clear` path (the server's `clear()` does not emit it, and the local command intercepts `/clear` before the SDK sees it), so that `setClearing(false)` was already unreachable. `permissions.reset()` in `onCleared` is preserved.

**Type consistency:** `onClearSession: (id: string) => Promise<boolean>` is identical across `App.handleClear`, `ChatPanel` props, and `Chat` props (Tasks 2 & 3). `useClearSession`'s `requestClearSession: (sessionId: string) => Promise<void>` is assignable to `local-commands.ts`'s `clearSession: (sessionId: string) => void` ctx type (void return accepts any return) — no change to `local-commands.ts` needed.
