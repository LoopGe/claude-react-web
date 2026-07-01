# `/clear` Optimistic Animation — Design

## Problem

When the user runs `/clear`, the message fade-out animation does **not** start
immediately. Instead the transcript freezes for ~1.7s, then the panel swaps to
a fresh session. The user perceives a "stutter" before any transition.

### Root cause

The panel-id swap that drives the exit/enter animation is gated behind a
blocking POST:

1. `/clear` is matched as a local command (`src/local-commands.ts:69`) →
   `requestClearSession` (`src/components/Chat.tsx:883`) → `onClearSession` →
   `handleClear` (`src/App.tsx:2309`).
2. `handleClear` does `await api.post('/sessions/:id/clear')`
   (`App.tsx:2314`). The server's `SessionManager.clear()` tears down the old
   subprocess and spawns a fresh one (~1.7s).
3. **Only after the POST resolves** does `setOpenIds` swap panel X→Y
   (`App.tsx:2317-2323`). React unmounts `Chat(X)`, mounts `Chat(Y)`, and the
   `panel-exit` / `panel-enter` animations play (`layout.css:302/312`).

So the animation is tied to the panel swap, which is tied to the POST
resolving. During the ~1.7s wait nothing animates.

### The intended latency mask is dead code

A dedicated `clearing`-driven blur-fade + "Clearing…" veil exists and is fully
implemented and tested:

- CSS: `.chat-messages-clearing` (`chat.css:126-137`) + `.chat-clearing-veil`
  (`chat.css:141-176`), `--motion-duration-slow` = 320ms. The CSS comment
  itself states it is meant to cover "the server tears down + respawns the CLI
  subprocess (~1.7s)."
- Components: `MessageList` (`MessageList.tsx:268-294` veil state machine),
  `MonitorBar`, `TodoChecklist` all accept a `clearing` prop and render the
  fade. Tested in `MessageList.test.tsx:170-206`, `MonitorBar.test.tsx`,
  `TodoChecklist.test.tsx`.
- State: `const [clearing, setClearing] = useState(false)` in `Chat.tsx:257`,
  unset by the `onCleared` WS callback (`Chat.tsx:414-417`).

**But `setClearing(true)` is never called anywhere.** `Chat.tsx:888-891`
deliberately removed it when the architecture changed to unload-and-respawn:

> We deliberately do NOT set `clearing` here — the blur-fade was tied to the
> old same-id wipe, and a stuck "Clearing…" veil on a failed POST (`onCleared`
> never fires for a local /clear) isn't worth the transition.

The concern was: in the new architecture the server returns a **new** session
id Y; `onCleared` (the `session-cleared` WS handler) never fires for the old
id X, so `clearing=true` could get stuck on a failed POST.

### Why the original concern is solvable

In the unload-and-respawn flow:

- **Success** = POST resolves → `setOpenIds` swaps X→Y → `Chat(X)` unmounts →
  the `clearing` state is discarded with the component. **No explicit unset
  needed on success.**
- **Failure** = POST rejects → `Chat(X)` stays mounted with `clearing=true` →
  stuck veil. **This is the only case needing an explicit unset**, and it is
  solvable by signaling failure back from `handleClear` to `Chat`.

## Design

### Decisions

1. **Animation**: revive the existing `clearing` blur-fade + "Clearing…" veil
   (already built and tested). No new CSS, no new component behavior.
2. **Failure rollback**: POST failure → `setClearing(false)` (messages snap
   back to opacity 1) + toast (toast already lives in `handleClear`'s catch).
   No animated restore on the error path (YAGNI).
3. **Wiring (Approach A)**: `onClearSession` returns `Promise<boolean>`;
   `requestClearSession` sets `clearing=true` synchronously, awaits, and
   unsets only on `false`/reject.

### Architecture / data flow

**Success:**
```
t=0      /clear → matchLocalCommand → requestClearSession
         → setClearing(true)              ← blur-fade (320ms) + "Clearing…" veil start NOW
         → await onClearSession(id)       ← POST blocks ~1.7s; veil + spinner cover it
t~1.7s   POST resolve, handleClear returns true
         → setOpenIds swaps X→Y
         → Chat(X) unmounts (clearing state discarded; veil gone with it)
         → Chat(Y) mounts with clearing=false; .entering plays panel-enter
```

**Failure:**
```
t=0      setClearing(true) → animation starts
t~?      POST rejects → handleClear catch: toast + return false
         → requestClearSession: ok=false → setClearing(false)
         → MessageList: clearing flips false → .chat-messages-clearing class
           removed (messages snap back to opacity 1); veil runs its exiting
           fade-out (180ms) then unmounts
```

**No "setState on unmounted component" on success:** `requestClearSession`'s
`try` block only calls `setClearing` in the `if (!ok)` branch. On success
`ok=true`, so no setState lands on the about-to-unmount `Chat(X)`. On failure
`Chat(X)` is still mounted, so `setClearing(false)` is safe.

### File changes

**New: `src/hooks/useClearSession.ts`** — focused, testable unit extracted from
`Chat.tsx`:
- `useLingerFalse(value: boolean, ms: number): boolean` (moved from
  `Chat.tsx:88`).
- `useClearSession({ onClearSession, clearError }) →
  { clearing, clearingLinger, requestClearSession }`. The hook does **not**
  take `sessionId`; `requestClearSession(sessionId)` accepts it as an argument
  to preserve the existing call interface (`ctx.clearSession(ctx.sessionId)`).
- `requestClearSession(sessionId)`:
  ```ts
  clearError()
  setClearing(true)
  try {
    const ok = await onClearSession(sessionId)
    if (!ok) setClearing(false)   // failure rollback
  } catch {
    setClearing(false)            // defensive: reject also rolls back
  }
  ```
- Absorbs and rewrites the `Chat.tsx:888-891` comment to describe the new
  wiring (success = unmount discards state; failure = explicit unset).

**`src/components/Chat.tsx`**:
- Remove inline `clearing` state (`:257`), `useLingerFalse` (`:88`, `:261`),
  and `requestClearSession` (`:883-894`).
- Replace with `const { clearing, clearingLinger, requestClearSession } =
  useClearSession({ onClearSession, clearError })`. `requestClearSession` is
  still called as `requestClearSession(session.id)` (via the local-command
  ctx), unchanged.
- `send()`'s `clearSession: requestClearSession` (`:967`) is unchanged — the
  `local-commands` ctx types `clearSession` as `void`, and `Promise<void>` is
  assignable to `void`; fire-and-forget semantics are preserved.
- Prop `onClearSession` type (`:121`): `(id: string) => void` →
  `(id: string) => Promise<boolean>`.

**`src/App.tsx` — `handleClear` (`:2309-2344`)**:
- `return true` at the end of the `try` block (after the group update).
- `return false` in the `catch` block (after the toast).
- Signature: `(id: string) => Promise<boolean>`.

**`src/components/ChatPanel.tsx` (`:133`)**: prop type
`onClearSession: (id: string) => void` → `(id: string) => Promise<boolean>`.
Pure passthrough; no logic change.

**`src/local-commands.ts`**: no change. `clearSession: (sessionId: string) =>
void` stays; `requestClearSession` (now `Promise<void>`) remains assignable.

**Unchanged:** `MessageList`, `MonitorBar`, `TodoChecklist`, all CSS, the
server, and the existing `clearing`-prop tests for those components.

### Testing strategy (TDD)

Red-green-refactor, driven from a new `src/hooks/useClearSession.test.ts`
(`renderHook` + fake timers):

1. Initially `clearing === false`.
2. `requestClearSession('s1')` sets `clearing === true` **synchronously**
   (before `await`) and calls `clearError`.
3. `onClearSession` resolves `false` → after `await`, `clearing === false`
   (failure rollback).
4. `onClearSession` resolves `true` → after `await`, `clearing` still `true`
   (success — hook does not unset; unmount handles it).
5. `onClearSession` rejects → `clearing === false` (defensive rollback).
6. `clearingLinger` holds `true` for 220ms after `clearing` flips `false`,
   then drops to `false` (fake timers).

Existing tests stay green: `MessageList.test.tsx:170-206`,
`MonitorBar.test.tsx`, `TodoChecklist.test.tsx` exercise the `clearing` prop
behavior (the animation itself); the new hook test exercises the trigger and
rollback wiring.

`handleClear`'s `boolean` return is covered consumer-side by the hook test's
mock `onClearSession` contract plus typecheck; no `App`-level test is added
(this repo does not unit-test `App`).

### Manual verification

- Run app, run `/clear` → observe immediate blur-fade + "Clearing…" veil,
  then ~1.7s later a fresh empty panel.
- Simulate failure (stop server, or clear an invalid id) → toast appears,
  messages snap back to fully visible.

## Out of scope

- No timeout fallback on a hung POST (a hung POST is a separate issue; the
  current `handleClear` has no timeout and that is unchanged).
- No suppression of the redundant `panel-exit` ghost that fires on the swap;
  by swap time `Chat(X)` is already at opacity 0 (blur-fade fill `both`), so
  the ghost fading an empty frame is harmless.
- No animated restore on failure (snap-back + toast is sufficient for an error
  path).
