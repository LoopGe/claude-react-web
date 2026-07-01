# `/clear` blur-fade animation survives the X→Y id-swap

**Date:** 2026-07-01
**Status:** Draft
**Depends on:** 2026-07-01 `feat(clear): preserve pre-clear conversation as a resumable session` (commit `794c8e7`)
**Supersedes for the local-`/clear` path:** 2026-06-26 `/clear` blur-fade transition

## Problem

Commit `794c8e7` changed `/clear` semantics: instead of wiping session X in
place, the server detaches X as a dormant resumable session and spawns a fresh
session Y under a new id; the client swaps the panel's session in `openIds`
X→Y. That change **also disabled the blur-fade animation** on the local-
`/clear` path, because:

1. `<ErrorBoundary key={s.id}>` wraps `<ChatPanel>` in `App.tsx`, so when
   `openIds` swaps X→Y the entire panel subtree — including anything that was
   fading — unmounts immediately. A CSS transition attached to X's DOM can't
   span the unmount.
2. `session-cleared` is no longer broadcast for local `/clear` (it's now only
   emitted by the SDK's in-band `cleared` control event), so the existing
   `onCleared` exit signal never fires. Any `clearing` flag set on X would
   have no way to reset — a stuck "Clearing…" veil is worse than none.

The commit's author explicitly disabled the animation on the local path (see
`Chat.tsx:requestClearSession` and the accompanying comment) and left the
`clearing` state + `onCleared` plumbing wired only for the SDK-emitted case.

The user experience is now: press `/clear` → the panel snap-swaps from full
transcript to empty state on POST resolve, with no visual bridge.

## Goal

Restore a full round-trip blur-fade animation on the local-`/clear` path,
adapted to the new "X → dormant, Y → fresh" semantics:

- X's content (TodoChecklist / MonitorBar / message list) blurs and fades
  out.
- A centered "Clearing…" veil fades in over the panel.
- The X→Y id-swap happens **behind the fully-opaque veil**, so the user
  never sees a partial-transparency flash of Y appearing.
- The veil fades out, revealing Y's fresh empty state.

## Non-goals

- The SDK-emitted `cleared` control-event path is out of scope. `clearing`
  state and `onCleared` in `useChatStream` / `Chat` stay wired for that case
  (unchanged from `794c8e7`).
- Side Chats: `/clear` is not dispatched from Side Chat drawers today
  (`SideChatDrawer.handleSend` doesn't intercept slash commands). No changes
  needed there.
- Cross-fade of X→Y (both mounted simultaneously). The veil is opaque during
  the swap, so single-mount is sufficient.

## Architectural key: the slot-level wrapper

The X→Y swap re-keys `<ErrorBoundary key={s.id}>` and everything under it.
We introduce a new `<PanelSlot>` wrapper **above** that ErrorBoundary,
keyed by the panel's slot index (0/1/2). Because slot indices are stable
across an in-place id swap, `<PanelSlot>` reuses its DOM node — its child
subtree (ErrorBoundary + ChatPanel) still remounts on id change, but the
wrapper (and the veil it owns) survives.

```
App.tsx
├── openSessions.flatMap((s, i) =>
│     <PanelSlot key={i}                         ← keyed by slot index, stable
│                clearingPhase={clearingSlots.get(i)}>
│       <ErrorBoundary key={s.id}>               ← keyed by session id, remounts on swap
│         <ChatPanel clearing={phase === 'fading-in'} …>
│           <Chat key={s.id} clearing={…} …>
│             ├── TodoChecklist               ← keeps its .todo-panel-clearing blur
│             ├── MessageList                 ← keeps its .chat-messages-clearing blur
│             └── MonitorBar                  ← keeps its .monitor-bar-clearing blur
```

`<PanelSlot>` is a small wrapper `<div className="panel-slot">` that:

- Occupies the same grid cell that `<ChatPanel>`'s `<section>` used to (so
  the fr / 4px / fr grid template in `.main-body` is unchanged).
- Uses `position: relative` so a `position: absolute` veil child scopes
  correctly.
- Renders `<div className="panel-clearing-veil" data-phase={phase} />`
  conditionally when `clearingPhase` is set.

## State machine

**App-level state (new):**

```ts
type ClearPhase = 'fading-in' | 'fading-out'
const [clearingSlots, setClearingSlots] = useState<Map<number, ClearPhase>>(
  new Map(),
)
```

**Timing constants** (all from `src/styles/tokens.css`):

- `--motion-duration-base` = 180 ms (veil fade-in and fade-out duration)
- `--motion-duration-slow` = 320 ms (content blur-fade duration)
- Content blur-fade and veil fade-in run in parallel from t=0. The veil
  becomes fully opaque at t≈180 ms — the earliest point at which the swap
  is safe.

**`handleClear(id)` flow:**

```
t=0
  slotIdx = openIds.indexOf(id)               ← locate the slot
  if slotIdx === -1: fall back to old behavior (no animation, just POST)
  setClearingSlots(prev → prev.set(slotIdx, 'fading-in'))
  fire POST /sessions/:id/clear                (in parallel, don't await yet)

t=0..180ms
  ChatPanel receives clearing=true → threaded into Chat →
    TodoChecklist / MonitorBar / MessageList add their `-clearing` classes →
    content blurs out (320ms)
  PanelSlot renders veil with data-phase="fading-in" → veil fades in (180ms)

gate:  await Promise.all([post, wait(--motion-duration-base)])
  Both must be satisfied. In the common case (POST < 200ms), we're waiting
  on the animation. Under slow POST we wait on the network.

t=gate  perform id-swap X→Y:
  setOpenIds(prev → swap X → Y at slotIdx)
  setFocusedId(X → Y if focused)
  setGroups(...)
  setLastSeenTurn(...)
  enteringSetRef.current.delete(Y)             ← suppress mount-anim (avoids double-anim with veil-out)
  setClearingSlots(prev → prev.set(slotIdx, 'fading-out'))

  React commits: ErrorBoundary + ChatPanel for X unmount, for Y mount.
  PanelSlot's veil DOM is preserved (same slot key), transitions to
  data-phase="fading-out" → veil fades out (180ms).

t=gate+180ms  cleanup:
  setClearingSlots(prev → prev.delete(slotIdx))
  Veil element unmounts, Y is fully revealed.
```

**Failure path (POST rejects):**

```
setClearingSlots(prev → prev.delete(slotIdx))  ← veil disappears immediately
toast.error(`Couldn't clear session: ${err.message}`)
```

X remains live (server made no change on 4xx/5xx). Content blur classes on
X's Chat unmount cleanly because `clearing=false` is now propagated.

**Panel close mid-clear:**

If the user closes the panel while `clearingSlots` still has that slot, the
slot disappears from `openIds` → `openSessions` no longer includes it →
`<PanelSlot>` unmounts naturally. The `clearingSlots` entry becomes stale;
we clean it up in a `useEffect` that reconciles `clearingSlots` against
`openSessions.length` after every render.

**Cleanup timers:** We use a `setTimeout(180ms)` for the fade-out cleanup.
The timer id is stored per slot in a ref (`Map<number, number>`) and
cleared if the slot is closed or a new `/clear` is dispatched on the same
slot before the timer fires.

## Prop drilling: `clearing` boolean

`clearing` is delivered from App → ChatPanel → Chat → { TodoChecklist,
MessageList, MonitorBar } via ordinary React props. Chat internally
combines: `effectiveClearing = clearingProp || clearingLocal`, where
`clearingLocal` is the existing `useState` (kept for the SDK in-band
cleared path). Both signals produce the same CSS classes downstream.

- `clearingProp` is only `true` during the `fading-in` phase. During
  `fading-out`, Y is mounted with `clearing=false` — Y should never blur
  its own content.
- `clearingLocal` remains reachable from `onCleared` in `useChatStream`.

The three-hop prop drill is small (4 new lines total). A React Context
alternative was considered and rejected: only one prop, only three levels,
and adding a Context provider around ChatPanel would create a new subtree
that renders on every clear — worse ergonomics than the prop.

## File-level changes

### 1. `src/App.tsx`

- **New state**: `clearingSlots: Map<number, ClearPhase>` and a
  `clearingTimersRef: MutableRefObject<Map<number, number>>` for cleanup
  timers.
- **`handleClear` rewritten** as described in the state machine section.
  The current implementation (POST → swap → toast on error) becomes the
  synchronous core of the new flow, wrapped in fade-in / gate / fade-out
  logic.
- **`openSessions.flatMap` update**: wrap each `<ErrorBoundary>` in a new
  `<PanelSlot key={i} clearingPhase={clearingSlots.get(i)}>`.
- **Reconciliation effect**: `useEffect` that prunes `clearingSlots`
  entries whose slotIdx is no longer valid (panel closed mid-clear); also
  clears their stored timers.
- **`enteringSetRef.current.delete(newId)`** in the swap block so Y doesn't
  play its enter-animation under the veil.
- **`clearing` prop plumbed** to `<ChatPanel>` on each render:
  `clearing={clearingSlots.get(i) === 'fading-in'}`.

### 2. `src/components/PanelSlot.tsx` (new file)

A small memo'd component:

```tsx
export const PanelSlot = memo(function PanelSlot({
  clearingPhase,
  children,
}: {
  clearingPhase: ClearPhase | undefined
  children: ReactNode
}) {
  return (
    <div className="panel-slot">
      {children}
      {clearingPhase && (
        <div
          className="panel-clearing-veil"
          data-phase={clearingPhase}
          aria-hidden
        >
          <span className="panel-clearing-spinner" aria-hidden />
          <span>Clearing…</span>
        </div>
      )}
    </div>
  )
})
```

`ClearPhase` type exported from a shared module (either `types.ts` or
inline in `App.tsx` — decided in the plan).

### 3. `src/components/ChatPanel.tsx`

- New optional prop `clearing?: boolean`.
- Forward to `<Chat clearing={clearing} …>`.
- No other changes; the header / overlays / gitStatus are untouched.

### 4. `src/components/Chat.tsx`

- New optional prop `clearing?: boolean`.
- `effectiveClearing = (clearing ?? false) || localClearing`.
- Use `effectiveClearing` where `clearing` was previously read (three call
  sites: TodoChecklist, MessageList, MonitorBar).
- **Delete `useLingerFalse`** and the `clearingLinger` state. The veil no
  longer disappears with a component unmount, so the "hold height through
  the exit fade" hack is no longer needed. TodoChecklist and MonitorBar
  read `clearing` directly (i.e. `effectiveClearing`) and unmount at their
  own pace.
- The comment block on `requestClearSession` explaining "deliberately do
  NOT set clearing" is removed (obsolete — behavior is now driven by prop
  from App).

### 5. `src/components/MessageList.tsx`

- The existing veil that lives inside `.chat-messages-wrap` is removed
  (`chat-clearing-veil` DOM). The wrapper-layer veil replaces it.
- `.chat-messages-clearing` class stays — it's the content blur-fade, still
  useful.
- The one-shot `chat-messages-empty-enter` empty-state entrance is kept
  for the SDK-emitted `cleared` path (same-id in-place wipe, `clearing`
  flag flips false with 0 items — the "flip edge" trigger still fires).
  On the local-`/clear` path Y mounts fresh with 0 items and `clearing`
  never flipped, so no fade-in — but the wrapper-layer veil already
  provides the entrance transition, and doubling up would look busier
  than the current single fade-out. Explicit non-change; documented here
  so the plan doesn't invent a new trigger.

### 6. `src/hooks/useChatStream.ts`

- No signature changes. The `onCleared` callback and `session-cleared` frame
  handler remain wired for the SDK-emitted case, unchanged.

### 7. CSS

New rules in `src/styles/chat.css` (or a dedicated `panel-slot.css` —
decided in the plan):

```css
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
  /* fade-in default; overridden by data-phase="fading-out" */
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
  .panel-clearing-spinner { animation: none; }
}
```

Existing CSS to remove:
- `.chat-clearing-veil` and `.chat-clearing-veil.exiting` (the wrap-level
  veil, replaced by `.panel-clearing-veil`).
- `.chat-clearing-spinner`, `@keyframes clear-veil-in`,
  `@keyframes clear-veil-out`, `@keyframes clear-spinner` — replaced by
  the `panel-clear-*` equivalents. (Kept if any other consumer uses them —
  a search-and-verify step in the plan.)

Existing CSS unchanged:
- `.chat-messages-clearing`, `.todo-panel-clearing`, `.monitor-bar-clearing`,
  `@keyframes clear-blur-fade`. The content blur is still what we want.

### 8. Tests

- **`src/hooks/useClearAnimation.test.ts`** (new, if we extract the state
  machine into a hook — likely, for testability): unit tests covering the
  four flow paths (happy, POST-fails, panel-closes-mid-clear, second-clear-
  during-fade).
- **`src/components/Chat.test.tsx`** (existing, extend): verify
  `effectiveClearing` truthiness under `clearing` prop, under `localClearing`,
  and combined.
- **`src/App.test.tsx`** (existing if it exists, or new integration test):
  simulate `/clear` and assert the slot's veil DOM appears, then disappears
  on happy path; POST-fails path drops veil immediately with a toast.

Manual QA scenarios (to be listed in the plan):

1. Local `/clear`: veil in → swap under veil → veil out → empty Y.
2. `/clear` while panel is scrolled up mid-transcript.
3. `/clear` while a permission dialog is open on X.
4. `/clear` while the composer has text.
5. `/clear` in each of 1-up, 2-up, 3-up layouts.
6. `/clear` twice in rapid succession on the same slot.
7. `/clear` a panel while another panel is also mid-clear.
8. Close the panel while a `/clear` is fading in.
9. POST fails (simulate 500) — veil clears, toast fires, X untouched.
10. `prefers-reduced-motion: reduce` — veil visible but no animation.

## Anti-goals / rejected alternatives

- **Change `<ErrorBoundary key={s.id}>` to a slot-index key.** Would let
  ChatPanel survive the swap without a new wrapper, but breaks the
  invariant that ChatPanel's local header state (menus, gitStatus cache,
  dropActive, etc.) resets on session change. Too risky for a UI-only fix.
- **App-level portal veil positioned by `getBoundingClientRect`.** Requires
  tracking panel resize / divider drag / layout reflow with observers.
  High complexity, no visual benefit over the wrapper approach.
- **Delay the id-swap until after the fade-out.** Would keep X mounted
  longer than needed, hiding the fact that Y has already spawned server-
  side. Also can't fade the veil over Y without a wrapper anyway.

## Risks and rollback

- **Risk:** Introducing `<PanelSlot>` changes the grid item structure. If
  CSS assumptions in `main-body`'s grid template implicitly depended on
  ChatPanel's `<section>` being the direct grid child, layout may break.
  Mitigation: PanelSlot mimics the grid-item CSS (`min-width: 0`,
  `min-height: 0`, `display: flex`, `flex-direction: column`) exactly.
  Manual verify in 1-up, 2-up, 3-up.
- **Risk:** Rapid double-`/clear` on the same slot could race the fade-out
  timer. Mitigation: `clearingTimersRef` — cancel any prior timer for the
  slot before scheduling a new one.
- **Risk:** `enteringSetRef.current.delete(newId)` races the render-phase
  entering-diff. React 18 batches state updates in event handlers, so a
  synchronous `.delete` immediately after `setOpenIds` fires *before* the
  render — the diff then re-adds Y. Two possible fixes:
  1. `flushSync(() => setOpenIds(...))` then `enteringSetRef.current.delete(newId)`.
  2. Add a new `suppressEnteringRef: MutableRefObject<Set<string>>`;
     `handleClear` adds `newId` before `setOpenIds`; the render-phase diff
     at `App.tsx:1711-1717` checks the suppress set and skips adding to
     `enteringSetRef` for suppressed ids; the suppress entry is cleared in
     a `useLayoutEffect` after render.
  Approach 2 is preferred (avoids `flushSync`, which can cascade extra
  renders). Locked in during implementation.
- **Rollback:** the change is additive on the App/ChatPanel/Chat surface
  and purely CSS/DOM elsewhere. Revert the commit to restore current
  behavior; no server or persistence coupling.
