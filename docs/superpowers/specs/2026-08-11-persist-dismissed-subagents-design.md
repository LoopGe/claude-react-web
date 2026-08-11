# Persist dismissed subagents across refresh

Date: 2026-08-11

## Problem

Dismissing an in-flight subagent (async/background or sync) from the `SubagentOverlay` × button or the Waiting bubble flips its `activeSubagents` record to `dismissed`. That status is **client-only, in-memory state**: the `DISMISS_SUBAGENT` action mutates `state.mirror.activeSubagents` and nothing else — no network call, no persistence.

On page refresh the `SessionStore` hydrates from the localStorage transcript cache (or a WS `REPLAY_REPLACE`), and `activeSubagents` is **re-derived from message history** via `getSubagentStarts()` (`normalize.ts`), which always seeds records with `status: 'running'`. The dismiss was never persisted, so the re-derivation cannot reconstruct it, and the chip / "Waiting" bubble reappears. Verified read-sites (`getRunningSubagents`, the completion branch, ack-orphan suppression, `SubagentCard` styling) all key off the `dismissed` status.

The dismiss is deliberately a UI-tracking concept. The server-side subagent watcher (`server/subagent-watcher.ts`) never receives or stores it, and the subagent's actual execution / result flow is fully independent of the client's tracking status. The fix therefore stays **client-only**.

## Goal / non-goals

- **Goal:** after a user dismisses an in-flight subagent, a page refresh must not bring its chip / Waiting bubble back. The record stays `dismissed`.
- **Non-goal (preserve current semantics):** `dismissed` remains a terminal tracking state for **both** sync and async subagents. The tool-result merge (`reducer.ts:1321`) only processes `status === 'running'` records, so a dismissed sync subagent's result is ignored and the card stays "tracking dismissed" even after real completion. The completion branch (`reducer.ts:1511`) excludes `dismissed`, so a late `task_notification` is likewise ignored. **We keep all of this as-is** — the fix only extends the same behavior across refresh.
- **Non-goal:** server-side persistence / cross-tab sync. Dismiss is a per-view UI preference; if the localStorage cache is cleared the dismiss is lost (same degradation as drafts).
- **Non-goal:** fixing the pre-existing comment/code mismatch at `reducer.ts:177-178` / `types.ts:407-408` vs `:1321` (sync dismiss → result never flips to done). Logged separately.

## Design

The dismissed `toolUseId` set is client-owned state and belongs on the **`ClientIntent` layer** (`types.ts:346`) — the layer the architecture guarantees survives every server-frame mirror rebuild. A `REPLAY_REPLACE` / hydrate rebuilds `mirror` but must preserve `intent` verbatim; that invariant is exactly what dismiss needs. We persist the set in the existing transcript cache payload so it survives page load, rehydrate it into `intent`, and re-apply it to the mirror after the only rebuild-from-scratch path.

### 1. `ClientIntent.dismissedSubagents`

`types.ts:346` — add a field:

```ts
export interface ClientIntent {
  pendingPlaceholders: ReadonlyMap<string, TranscriptItem>
  error: string | null
  /** toolUseIds the user explicitly dismissed while in-flight
   *  (running/background/pending). Client-owned and NOT derivable from the
   *  message stream — it is the only record that those ids were dismissed.
   *  Survives mirror rebuilds (REPLAY_REPLACE / hydrate re-derive
   *  activeSubagents from messages and would otherwise resurrect the chips).
   *  Re-applied to mirror via reapplyDismissed() after any rebuild. Cleared
   *  by CLEAR_TRANSCRIPT. Persisted in the transcript cache payload. */
  dismissedSubagents: ReadonlySet<string>
}
```

`createInitialClientIntent()` seeds an empty `Set`.

### 2. `DISMISS_SUBAGENT` — write both layers

`reducer.ts:172` — keep the existing mirror flip, and additionally record the id on `intent`:

```ts
case 'DISMISS_SUBAGENT': {
  const existing = state.mirror.activeSubagents.get(action.toolUseId)
  if (!existing || (existing.status !== 'running' && existing.status !== 'background' && existing.status !== 'pending')) return state
  const activeSubagents = new Map(state.mirror.activeSubagents)
  activeSubagents.set(action.toolUseId, {
    ...existing,
    status: 'dismissed',
    endedAt: existing.endedAt ?? existing.startedAt,
  })
  const dismissedSubagents = new Set(state.intent.dismissedSubagents)
  dismissedSubagents.add(action.toolUseId)
  return withIntent(
    withMirror(state, { ...state.mirror, activeSubagents }),
    { ...state.intent, dismissedSubagents },
  )
}
```

### 3. `reapplyDismissed(state)` — pure re-application helper

New pure function in `reducer.ts`. Reads `intent.dismissedSubagents`, mutates `mirror.activeSubagents` only:

```ts
export function reapplyDismissed(state: SessionState): SessionState {
  if (state.intent.dismissedSubagents.size === 0) return state
  let mirror = state.mirror
  let activeSubagents = mirror.activeSubagents
  let dismissed = state.intent.dismissedSubagents
  let mirrorChanged = false
  for (const id of dismissed) {
    const sub = activeSubagents.get(id)
    if (!sub) continue                                // absent (e.g. post-/clear) — pruned below
    if (sub.status === 'dismissed') continue          // already applied — keep id
    if (sub.status === 'running' || sub.status === 'background' || sub.status === 'pending') {
      if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
      activeSubagents.set(id, { ...sub, status: 'dismissed', endedAt: sub.endedAt ?? sub.startedAt })
      mirrorChanged = true
    }
    // done/interrupted/rejected — record settled naturally; prune id below.
  }
  // Prune ids whose record is absent or settled naturally (done/interrupted/
  // rejected). Keep ids whose record is still dismissed or dismissable so a
  // future rebuild can re-apply them.
  const keep = new Set<string>()
  for (const id of dismissed) {
    const sub = activeSubagents.get(id)
    if (!sub) continue
    if (sub.status === 'dismissed' || sub.status === 'running' || sub.status === 'background' || sub.status === 'pending') {
      keep.add(id)
    }
  }
  if (keep.size !== dismissed.size) {
    dismissed = keep
  }
  if (!mirrorChanged && dismissed === state.intent.dismissedSubagents) return state
  const nextMirror = mirrorChanged ? { ...mirror, activeSubagents } : mirror
  return withIntent(
    withMirror(state, nextMirror),
    dismissed === state.intent.dismissedSubagents ? state.intent : { ...state.intent, dismissedSubagents: dismissed },
  )
}
```

Note on pruning: because `dismissed` is terminal for sync too (result merge skips non-`running`), a dismissed record never naturally settles — so in practice the keep-set equals the full set until `/clear` removes the records. The absent-record branch covers the `/clear`-then-rebuild case (the id is dropped because the record no longer exists). The helper stays idempotent.

### 4. Persistence — extend the transcript cache payload

`store.ts`:

- `persistToStorage` (line 148): add `dismissedSubagents: Array.from(state.intent.dismissedSubagents)` to **both** the full and budget-trimmed payloads (tiny, always included). Keep `v: 2` (old caches without the field still load; no forced re-replay).
- `loadFromStorage` (line 219): read `data.dismissedSubagents` (default `[]`), return it as `string[]`.
- `clearSessionStorage` / `clearPersisted` / `purge`: already delete the whole key — no change (dismiss set dies with the cache, correct).

### 5. Constructor hydrate — rehydrate + re-apply

`store.ts` constructor (line 334). This is the **only** place `activeSubagents` is rebuilt from scratch on a persisted set, so this is the only mandatory re-apply point:

```ts
const cached = loadFromStorage(sessionId)
if (cached && cached.messages.length > 0) {
  const fresh = createInitialSessionState(sessionId)
  const seededMirror: ServerMirror = {
    ...fresh.mirror,
    items: cached.messages,
    messages: cached.rawMessages as ServerMirror['messages'],
    lastMessageUuid: cached.lastMessageUuid,
    replayReady: true,
  }
  const seeded: SessionState = {
    sessionId,
    mirror: seededMirror,
    intent: {
      ...fresh.intent,
      dismissedSubagents: new Set(cached.dismissedSubagents ?? []),
    },
  }
  this.state = reapplyDismissed(rebuildIndexesFromMessages(seeded, seededMirror.messages))
  ...
}
```

Why no re-apply in `replayReplace`:
- **Merge branch (cache exists):** keeps `prevMirror` (already carries dismissed records); `sweepAtTurnEnd` never touches `dismissed`; re-applying an overlapping `tool_use` preserves `existing.status` (`:1283`). No re-seed from empty.
- **Fresh-state branch (no cache):** `intent.dismissedSubagents` is empty (nothing was persisted), so there is nothing to re-apply.
- **`PREPEND_MESSAGES` (IDB cold-load / loadOlder):** only adds strictly-older messages; dismissed in-flight records are recent and unaffected.

### 6. Immediate-refresh race — persist immediately on dismiss

`scheduleSave` is debounced (2s). A dismiss followed by a refresh within the debounce window would not persist the flag. The store already exposes `persistNow()` (line 668) which bypasses the debounce (sync LS + async IDB). In `SessionStore.dispatch` (or the `dismissSubagent` path), after a `DISMISS_SUBAGENT` action takes effect, call `persistNow()` so the flag is durable immediately. (IDB write is fire-and-forget; LS write is synchronous, which is what hydrate reads.)

### 7. Clear semantics (unchanged, verified)

- `CLEAR_TRANSCRIPT` (`/clear` and `store.reset()`): rebuilds via `createInitialSessionState` → `createInitialClientIntent()` → empty set. Dismisses cleared. Correct.
- `clearPersisted` / session delete: removes the LS key (and IDB) → set gone. Correct.
- `SubagentOverlay` × on an already-settled record (`done`/`interrupted`/`dismissed`/`rejected`) only calls `onClose`, not `onDismiss` (`SubagentOverlay.tsx:267`) → no stale id added. Correct.

## Files touched

| File | Change |
|---|---|
| `src/session-store/types.ts` | `ClientIntent.dismissedSubagents`; `createInitialClientIntent` seeds empty set |
| `src/session-store/reducer.ts` | `DISMISS_SUBAGENT` writes intent + mirror; new `reapplyDismissed`; export it |
| `src/session-store/store.ts` | `persistToStorage`/`loadFromStorage` payload field; constructor rehydrate + `reapplyDismissed`; `persistNow()` after dismiss dispatch |
| `src/session-store/reducer.test.ts` | reducer tests (see below) |
| `src/session-store/store.test.ts` | persistence round-trip + hydrate test |

## Testing (TDD)

1. **Reducer — dismiss survives a rebuild-from-scratch.** Dispatch `DISMISS_SUBAGENT`, then run `rebuildIndexesFromMessages` over the same messages; assert the record is still `dismissed` and `intent.dismissedSubagents` still contains the id.
2. **Reducer — `reapplyDismissed` flips a freshly-seeded record.** Build a state where the mirror record is `pending` (seeded from messages) and `intent.dismissedSubagents` contains its id; assert `reapplyDismissed` flips it to `dismissed` with `endedAt` set, and keeps the id.
3. **Reducer — prune on absent / naturally-settled records.** A `done` record's id is dropped from the set; an absent id is dropped; a `dismissed` id is kept.
4. **Reducer — idempotence.** Calling `reapplyDismissed` twice is a no-op (identity-stable second time).
5. **Store — persistence round-trip.** `persistToStorage` writes `dismissedSubagents`; `loadFromStorage` returns it; hydrate (`reapplyDismissed` in constructor) leaves the dismissed subagent out of the snapshot's `activeSubagents` (chip hidden).
6. **Store — `/clear` clears.** After `CLEAR_TRANSCRIPT`, `intent.dismissedSubagents` is empty.
7. **Regression — existing `DISMISS_SUBAGENT` tests still pass** (flip to `dismissed`, late-completion ignored, non-pending no-op).

## Open questions / decisions

- **Confirmed:** preserve current `dismissed`-is-terminal semantics for both sync and async (do not flip to `done` on real completion). Dismissing a running sync subagent's result is still ignored (`:1321`) — unchanged.
- The pre-existing comment/code mismatch about sync dismiss → `done` is **out of scope** and tracked separately.
