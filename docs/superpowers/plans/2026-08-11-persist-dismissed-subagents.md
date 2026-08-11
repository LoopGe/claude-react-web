# Persist Dismissed Subagents Across Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a user's dismissal of an in-flight subagent survive a page refresh — the chip / Waiting bubble must not reappear.

**Architecture:** The dismissed `toolUseId` set is client-owned state, stored on the existing `ClientIntent` layer (which survives every server-frame mirror rebuild). It is persisted in the existing transcript cache payload, rehydrated into `intent` on store construction, and re-applied to the freshly-rebuilt `activeSubagents` mirror via a new pure `reapplyDismissed()` helper. `DISMISS_SUBAGENT` writes both layers; a dismiss also calls `persistNow()` to bypass the 2s save debounce.

**Tech Stack:** TypeScript, React (client), vitest, localStorage (transcript cache), IDB (secondary). Server is untouched.

## Global Constraints

- Run both typechecks: `npm run typecheck` (runs `tsc -p tsconfig.json` and `tsc -p tsconfig.node.json`).
- Run tests: `npm run test` (vitest). Run lint: `npm run lint`.
- No server (`server/`, `shared/`) changes. This is purely client-side.
- `dismissed` stays a terminal tracking status for BOTH sync and async subagents — do NOT make real completion flip a dismissed record to `done` (the result merge at `reducer.ts:1321` requires `status === 'running'`; the completion branch at `reducer.ts:1511` excludes `dismissed`). Preserve existing semantics exactly.
- Keep the transcript cache payload at `v: 2` (do not bump) — old caches without the new field must still load.
- Commit messages end with the trailer line `Co-Authored-By: Claude <noreply@anthropic.com>` (CLAUDE.md). If on the default branch, create a feature branch before the first commit.

---

### Task 1: Reducer — record dismiss on intent + `reapplyDismissed` helper

**Files:**
- Modify: `src/session-store/types.ts:346-366` (ClientIntent) and `src/session-store/types.ts:500-505` (`createInitialClientIntent`)
- Modify: `src/session-store/reducer.ts:172-190` (`DISMISS_SUBAGENT`) and add `reapplyDismissed` near `rebuildIndexesFromMessages` (`reducer.ts:1128`)
- Test: `src/session-store/reducer.test.ts` (append after the existing `DISMISS_SUBAGENT` tests, ~line 886)

**Interfaces:**
- Consumes: `createInitialSessionState`, `reduceSessionState`, `withMirror`, `withIntent`, `SessionState` (all exist).
- Produces:
  - `ClientIntent.dismissedSubagents: ReadonlySet<string>` (new field; `createInitialClientIntent()` seeds an empty `Set`).
  - `export function reapplyDismissed(state: SessionState): SessionState` — pure, idempotent. Flips `running`/`background`/`pending` mirror records whose id is in `intent.dismissedSubagents` to `dismissed` (setting `endedAt: sub.endedAt ?? sub.startedAt`); prunes ids whose record is absent or settled naturally (`done`/`interrupted`/`rejected`); keeps ids that are still `dismissed` or dismissable. Returns `state` unchanged when nothing changes.

- [ ] **Step 1: Write the failing tests**

Append to `src/session-store/reducer.test.ts`. Extend the imports at the top first:

```ts
import { reduceSessionState, splitReplayAgainstCache, rebuildIndexesFromMessages, reapplyDismissed } from './reducer'
import { createInitialSessionState, type SessionState, type ServerMirror } from './types'
```

Then append these four tests after the existing `DISMISS_SUBAGENT` block (line ~886):

```ts
it('DISMISS_SUBAGENT records the id on intent.dismissedSubagents', () => {
  const toolUse: SdkMessage = {
    type: 'assistant', uuid: 'a-1', receivedAt: 0,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_i', name: 'Agent', input: { description: 'w' } }] },
  } as unknown as SdkMessage
  let state = createInitialSessionState('s1')
  state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
  state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_i' })
  expect(state.mirror.activeSubagents.get('tu_i')?.status).toBe('dismissed')
  expect(state.intent.dismissedSubagents.has('tu_i')).toBe(true)
})

it('a dismissed async subagent stays dismissed after refresh-style rebuild + reapply', () => {
  const toolUse: SdkMessage = {
    type: 'assistant', uuid: 'a-1', receivedAt: 0,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_dis', name: 'Agent', input: { description: 'do work' } }] },
  } as unknown as SdkMessage
  const ack: SdkMessage = {
    type: 'user', uuid: 'u-1', parent_tool_use_id: null, receivedAt: 1_000,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_dis', content: 'Async agent launched successfully' }] },
  } as unknown as SdkMessage
  const result: SdkMessage = { type: 'result', subtype: 'success', uuid: 'r-1', receivedAt: 2_000 } as unknown as SdkMessage

  let state = createInitialSessionState('s1')
  for (const m of [toolUse, ack, result]) state = reduceSessionState(state, { type: 'MESSAGE', message: m })
  expect(state.mirror.activeSubagents.get('tu_dis')?.status).toBe('pending')

  state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_dis' })
  expect(state.intent.dismissedSubagents.has('tu_dis')).toBe(true)

  // Refresh simulation (mirrors SessionStore constructor): fresh mirror,
  // seed the cached transcript, rebuild indexes, re-apply persisted dismiss.
  const fresh = createInitialSessionState('s1')
  const seededMirror: ServerMirror = {
    ...fresh.mirror,
    messages: state.mirror.messages,
    items: state.mirror.items,
    lastMessageUuid: state.mirror.lastMessageUuid,
    replayReady: true,
  }
  const seeded: SessionState = {
    sessionId: 's1',
    mirror: seededMirror,
    intent: { ...fresh.intent, dismissedSubagents: state.intent.dismissedSubagents },
  }
  const rebuilt = reapplyDismissed(rebuildIndexesFromMessages(seeded, seededMirror.messages))
  expect(rebuilt.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
})

it('reapplyDismissed prunes ids for absent records', () => {
  // Two dismissed in-flight records, then a /clear-style empty mirror: the
  // ids must be pruned from intent (nothing to dismiss against).
  const toolUseA: SdkMessage = {
    type: 'assistant', uuid: 'a-1', receivedAt: 0,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_a', name: 'Agent', input: { description: 'a' } }] },
  } as unknown as SdkMessage
  const toolUseB: SdkMessage = {
    type: 'assistant', uuid: 'a-2', receivedAt: 0,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_b', name: 'Agent', input: { description: 'b' } }] },
  } as unknown as SdkMessage
  let state = createInitialSessionState('s1')
  for (const m of [toolUseA, toolUseB]) state = reduceSessionState(state, { type: 'MESSAGE', message: m })
  state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_a' })
  state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_b' })
  expect(state.intent.dismissedSubagents.size).toBe(2)

  const cleared = createInitialSessionState('s1')
  const seeded: SessionState = {
    sessionId: 's1',
    mirror: cleared.mirror,
    intent: { ...cleared.intent, dismissedSubagents: state.intent.dismissedSubagents },
  }
  const reapplied = reapplyDismissed(seeded)
  expect(reapplied.intent.dismissedSubagents.size).toBe(0)
})

it('reapplyDismissed is idempotent', () => {
  const toolUse: SdkMessage = {
    type: 'assistant', uuid: 'a-1', receivedAt: 0,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_dis', name: 'Agent', input: { description: 'w' } }] },
  } as unknown as SdkMessage
  let state = createInitialSessionState('s1')
  state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
  state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_dis' })

  const fresh = createInitialSessionState('s1')
  const seededMirror: ServerMirror = {
    ...fresh.mirror,
    messages: state.mirror.messages,
    items: state.mirror.items,
    lastMessageUuid: state.mirror.lastMessageUuid,
    replayReady: true,
  }
  const seeded: SessionState = {
    sessionId: 's1',
    mirror: seededMirror,
    intent: { ...fresh.intent, dismissedSubagents: state.intent.dismissedSubagents },
  }
  const once = reapplyDismissed(rebuildIndexesFromMessages(seeded, seededMirror.messages))
  expect(once.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
  const twice = reapplyDismissed(once)
  expect(twice).toBe(once)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/session-store/reducer.test.ts -t "dismissed"`

Expected: FAIL. The file fails to compile / the tests error because `ClientIntent` has no `dismissedSubagents` and `reducer.ts` does not export `reapplyDismissed` (`reapplyDismissed` is not exported / `property 'dismissedSubagents' does not exist`).

- [ ] **Step 3: Implement — add the type field**

In `src/session-store/types.ts`, add the field to `ClientIntent` (after `error`, ~line 365):

```ts
export interface ClientIntent {
  /** Optimistic user-message placeholders awaiting their server echo.
   *  Keyed by placeholder id (the temp uuid stamped by insertUserMessage),
   *  value is the full TranscriptItem so snapshot-time render-merge has
   *  everything it needs without consulting mirror.items.
   *
   *  Placeholders live HERE, not in mirror.items, so REPLAY_REPLACE
   *  (which rebuilds mirror.items from the server payload) cannot wipe
   *  them. The render path (SessionStore.buildSnapshot) merges them at
   *  the tail of mirror.items, so components see the same flat list
   *  they did pre-refactor. On echo, applyMessage removes the matching
   *  placeholder from intent and appends the real message to mirror.items.
   *
   *  A Map (not a Set) so insertion order is preserved — echoes arrive in
   *  send order, so the oldest pending placeholder matches the next echo. */
  pendingPlaceholders: ReadonlyMap<string, TranscriptItem>
  /** Last error string to surface in the chat header. Written by the
   *  ERROR action (driven by WS error frames) and cleared by the client
   *  via clearError(). The clear path makes this client-owned. */
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

In `createInitialClientIntent` (`types.ts:500-505`), seed the empty set:

```ts
export function createInitialClientIntent(): ClientIntent {
  return {
    pendingPlaceholders: new Map<string, TranscriptItem>(),
    error: null,
    dismissedSubagents: new Set<string>(),
  }
}
```

- [ ] **Step 4: Implement — record dismiss on intent + add `reapplyDismissed`**

In `src/session-store/reducer.ts`, replace the `DISMISS_SUBAGENT` case (lines 172-190) with:

```ts
    case 'DISMISS_SUBAGENT': {
      // Flip an in-flight subagent (running/background/pending) to `dismissed`
      // so it leaves the WorkingBubble chip set. Uses a dedicated `dismissed`
      // status (NOT `interrupted`) so the inline SubagentCard renders a neutral
      // state instead of a false error. The result merge only processes
      // status === 'running' records, and the completion branch excludes
      // `dismissed`, so a dismissed record stays dismissed for BOTH sync and
      // async subagents — an explicit dismiss is a deliberate terminal state.
      // Also records the id on intent.dismissedSubagents so the dismiss
      // survives mirror rebuilds (refresh/replay re-derive activeSubagents
      // from the message stream, which has no record of the dismiss).
      // No-op for already-settled records.
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

Add `reapplyDismissed` immediately after the `rebuildIndexesFromMessages` export (`reducer.ts:1128-1137`):

```ts
/** Re-apply client-side dismissals to a freshly-rebuilt mirror. After a
 *  hydrate / replay rebuilds `activeSubagents` from the message stream, the
 *  records the user dismissed come back as `running`/`background`/`pending`
 *  (the stream has no record of the dismiss). This flips them back to
 *  `dismissed` (stamping `endedAt` the same way DISMISS_SUBAGENT does) and
 *  prunes ids that no longer have a dismissable record (absent post-/clear,
 *  or settled naturally to done/interrupted/rejected). Ids whose record is
 *  already `dismissed` are kept so a future rebuild can re-apply. Idempotent. */
export function reapplyDismissed(state: SessionState): SessionState {
  if (state.intent.dismissedSubagents.size === 0) return state
  let activeSubagents = state.mirror.activeSubagents
  let mirrorChanged = false
  for (const id of state.intent.dismissedSubagents) {
    const sub = activeSubagents.get(id)
    if (!sub) continue
    if (sub.status !== 'running' && sub.status !== 'background' && sub.status !== 'pending') continue
    if (activeSubagents === state.mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
    activeSubagents.set(id, { ...sub, status: 'dismissed', endedAt: sub.endedAt ?? sub.startedAt })
    mirrorChanged = true
  }
  // Prune ids whose record no longer exists or settled naturally; keep ids
  // that are still dismissed or dismissable so a future rebuild can re-apply.
  let dismissed = state.intent.dismissedSubagents
  for (const id of state.intent.dismissedSubagents) {
    const sub = activeSubagents.get(id)
    if (!sub) {
      if (dismissed === state.intent.dismissedSubagents) dismissed = new Set(dismissed)
      dismissed.delete(id)
      continue
    }
    if (sub.status !== 'dismissed' && sub.status !== 'running' && sub.status !== 'background' && sub.status !== 'pending') {
      if (dismissed === state.intent.dismissedSubagents) dismissed = new Set(dismissed)
      dismissed.delete(id)
    }
  }
  const intent = dismissed === state.intent.dismissedSubagents ? state.intent : { ...state.intent, dismissedSubagents: dismissed }
  const mirror = mirrorChanged ? { ...state.mirror, activeSubagents } : state.mirror
  if (mirror === state.mirror && intent === state.intent) return state
  return withIntent(withMirror(state, mirror), intent)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/session-store/reducer.test.ts`

Expected: PASS — all reducer tests including the four new ones.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` — Expected: no errors.

```bash
git add src/session-store/types.ts src/session-store/reducer.ts src/session-store/reducer.test.ts
git commit -m "feat: persist dismissed subagents on intent + reapplyDismissed

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Persistence + hydrate — survive a real refresh

**Files:**
- Modify: `src/session-store/store.ts:148-217` (`persistToStorage`), `:219-257` (`loadFromStorage`), `:334-364` (constructor hydrate), `:2` (import from reducer)
- Test: `src/session-store/store.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `reapplyDismissed` (Task 1), `ClientIntent.dismissedSubagents` (Task 1).
- Produces:
  - `loadFromStorage` return type gains `dismissedSubagents: string[]` (default `[]` for old v2 caches).
  - `persistToStorage` writes `dismissedSubagents: Array.from(state.intent.dismissedSubagents)` in both the full and trimmed payloads (payload stays `v: 2`).
  - `SessionStore` constructor: rehydrates `intent.dismissedSubagents` from the cache and runs `reapplyDismissed(rebuildIndexesFromMessages(...))`.

- [ ] **Step 1: Write the failing tests**

Append to `src/session-store/store.test.ts` (after the existing `describe` blocks):

```ts
describe('SessionStore dismissed-subagent persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('a dismissed subagent stays hidden after a refresh-style rehydrate', () => {
    // Store A: build an async subagent transcript and dismiss it, then force
    // the cache write (persistNow bypasses the 2s debounce).
    const storeA = new SessionStore('sess-dismiss')
    const toolUse: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_x', name: 'Agent', input: { description: 'w', run_in_background: true } }] },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user', uuid: 'u-1', parent_tool_use_id: null, receivedAt: 1_000,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_x', content: 'Async agent launched successfully' }] },
    } as unknown as SdkMessage
    storeA.dispatch({ type: 'MESSAGE', message: toolUse })
    storeA.dispatch({ type: 'MESSAGE', message: ack })
    storeA.dispatch({ type: 'DISMISS_SUBAGENT', toolUseId: 'tu_x' })
    storeA.persistNow()

    // A refresh = a brand-new store hydrating from the same localStorage key.
    const storeB = new SessionStore('sess-dismiss')
    const snap = storeB.getSnapshot()
    expect(snap.activeSubagents.some((a) => a.toolUseId === 'tu_x')).toBe(false)
  })

  it('loads a v2 cache without dismissedSubagents as an empty set', () => {
    const key = STORAGE_PREFIX + 'sess-old'
    const msg: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] },
    } as unknown as SdkMessage
    // Old v2 shape: no dismissedSubagents field.
    localStorage.setItem(key, JSON.stringify({ v: 2, savedAt: Date.now(), messages: [msg], lastMessageUuid: null }))
    const store = new SessionStore('sess-old')
    expect(store.getState().intent.dismissedSubagents.size).toBe(0)
  })

  it('/clear wipes dismissedSubagents', () => {
    const store = new SessionStore('sess-clear')
    const toolUse: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_c', name: 'Agent', input: { description: 'w' } }] },
    } as unknown as SdkMessage
    store.dispatch({ type: 'MESSAGE', message: toolUse })
    store.dispatch({ type: 'DISMISS_SUBAGENT', toolUseId: 'tu_c' })
    expect(store.getState().intent.dismissedSubagents.has('tu_c')).toBe(true)
    store.reset() // /clear
    expect(store.getState().intent.dismissedSubagents.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `npx vitest run src/session-store/store.test.ts -t "dismissed-subagent"`

Expected: the first test FAILS (`snap.activeSubagents.some(...)` is `true`) — `persistToStorage` doesn't yet write the dismissed set and the constructor doesn't re-apply it, so `storeB` re-derives `tu_x` as `background`/`pending` and it appears in the snapshot. The second and third tests pass already (regression guards).

- [ ] **Step 3: Implement — persistence payload + constructor hydrate**

In `src/session-store/store.ts`:

(a) Update the reducer import (line 2) to include `reapplyDismissed`:

```ts
import { rebuildIndexesFromMessages, reduceSessionState, reapplyDismissed, MEMORY_ITEM_CAP } from './reducer'
```

(b) In `persistToStorage` (lines 148-194), compute the dismissed array once and include it in both payloads:

```ts
function persistToStorage(sessionId: string, state: SessionState): void {
  // Only the server-authored mirror is persisted, as a per-field-capped
  // render projection (see project.ts). plainText / items / ClientIntent are
  // NOT persisted — re-derived on hydrate. Optimistic placeholders die with
  // the tab by design. The ONE exception is `dismissedSubagents`: it is the
  // only client-owned, non-derivable flag, so it rides along in the payload
  // to keep dismissed subagents hidden across refresh.
  const mirror = state.mirror
  // Project each message (no-op ref for small messages). Live state is never
  // touched — projection is persist-only.
  const projected: SdkMessage[] = mirror.messages.map(projectMessage)
  const lastMessageUuid = mirror.lastMessageUuid
  const dismissedSubagents = Array.from(state.intent.dismissedSubagents)

  let toWrite: string

  // Fast path: stringify once. The projection caps usually keep a session
  // well under the budget, so this single stringify is the common case.
  const fullPayload = JSON.stringify({
    v: 2,
    savedAt: Date.now(),
    messages: projected,
    lastMessageUuid,
    dismissedSubagents,
  })

  if (fullPayload.length <= STORAGE_MAX_BYTES) {
    toWrite = fullPayload
  } else {
    // Over budget: compute per-message sizes (O(n)) to pick the largest
    // suffix that fits, then stringify just that slice. Never drop below the
    // floor — a non-empty render hint is worth more than enforcing the budget
    // on pathological inputs (the on-disk log + loadOlder cover the dropped
    // older messages). +1 per message accounts for the array comma.
    const sizes = projected.map((m) => JSON.stringify(m).length + 1)
    // Include the dismissed-array in the wrapper overhead estimate.
    const wrapperOverhead = 96 + (lastMessageUuid?.length ?? 0) + JSON.stringify(dismissedSubagents).length
    let total = wrapperOverhead
    let kept = 0
    for (let i = sizes.length - 1; i >= 0; i--) {
      if (total + sizes[i] > STORAGE_MAX_BYTES && kept >= STORAGE_TRIM_FLOOR_MESSAGES) break
      total += sizes[i]
      kept++
    }
    const keptMessages = kept < projected.length ? projected.slice(projected.length - kept) : projected
    toWrite = JSON.stringify({
      v: 2,
      savedAt: Date.now(),
      messages: keptMessages,
      lastMessageUuid,
      dismissedSubagents,
    })
  }
  // ... rest unchanged (key write + quota handling) ...
}
```

(c) In `loadFromStorage` (lines 219-257), extend the return type and read the field defensively:

```ts
function loadFromStorage(sessionId: string): { messages: TranscriptItem[]; rawMessages: unknown[]; lastMessageUuid: string | null; dismissedSubagents: string[] } | null {
  // ...
    return {
      messages,
      rawMessages,
      lastMessageUuid: typeof data.lastMessageUuid === 'string' ? data.lastMessageUuid : null,
      dismissedSubagents: Array.isArray(data.dismissedSubagents)
        ? data.dismissedSubagents.filter((x): x is string => typeof x === 'string')
        : [],
    }
  // ...
}
```

(d) In the constructor (lines 337-364), rehydrate the set and re-apply after rebuilding:

```ts
    const cached = loadFromStorage(sessionId)
    if (cached && cached.messages.length > 0) {
      // Only `messages`/`items` are persisted — the lifecycle index
      // maps (toolStatus, planStatus, planContent, questionAnswers,
      // activeSubagents) are derived state and start empty after
      // hydrate. We MUST replay the cached messages through
      // updateIndexes() to rebuild them; otherwise every cached
      // tool_use card renders 'running' forever (useToolStatus
      // defaults to 'running' for unknown ids, and the live-replay
      // path only sees frames AFTER lastMessageUuid). This was the
      // "older Grep/Read cards stuck spinning after several turns"
      // bug — cards from previous turns lived in the cached items
      // but their toolStatus entries had been thrown away.
      const fresh = createInitialSessionState(sessionId)
      const seededMirror: ServerMirror = {
        ...fresh.mirror,
        items: cached.messages,
        messages: cached.rawMessages as ServerMirror['messages'],
        lastMessageUuid: cached.lastMessageUuid,
        replayReady: true, // Treat cached data as "replayed"
      }
      const seeded: SessionState = {
        sessionId,
        mirror: seededMirror,
        intent: {
          ...fresh.intent,
          dismissedSubagents: new Set(cached.dismissedSubagents),
        },
      }
      // Rebuild indexes from the cached messages, THEN re-apply persisted
      // dismissals so dismissed subagents stay hidden across refresh.
      this.state = reapplyDismissed(rebuildIndexesFromMessages(seeded, seededMirror.messages))
      this.snapshot = this.buildSnapshot(this.state)
    } else {
      this.state = createInitialSessionState(sessionId)
      this.snapshot = this.buildSnapshot(this.state)
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/session-store/store.test.ts`

Expected: PASS — all three new tests plus existing store tests.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: no errors.

```bash
git add src/session-store/store.ts src/session-store/store.test.ts
git commit -m "feat: persist dismissed subagents across refresh

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Persist immediately on dismiss — close the <2s refresh race

**Files:**
- Modify: `src/session-store/store.ts:471-497` (`dispatch`)
- Test: `src/session-store/store.test.ts` (append to the `SessionStore dismissed-subagent persistence` describe block)

**Interfaces:**
- Consumes: `SessionStore.persistNow()` (already exists, `store.ts:668`).
- Produces: `SessionStore.dispatch` calls `this.persistNow()` after a `DISMISS_SUBAGENT` action that changed state, so the dismissed set is written synchronously (bypassing the 2s save debounce).

- [ ] **Step 1: Write the failing test**

Append inside the `describe('SessionStore dismissed-subagent persistence', ...)` block:

```ts
  it('a dismiss is persisted synchronously (survives an <2s refresh)', () => {
    const store = new SessionStore('sess-immediate')
    const toolUse: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_i', name: 'Agent', input: { description: 'w' } }] },
    } as unknown as SdkMessage
    store.dispatch({ type: 'MESSAGE', message: toolUse })
    // No explicit persistNow() here — the dispatch itself must write.
    store.dispatch({ type: 'DISMISS_SUBAGENT', toolUseId: 'tu_i' })
    // The 2s debounced save has not fired (no timers awaited), so the key
    // being present NOW proves dispatch persisted synchronously.
    const raw = localStorage.getItem(STORAGE_PREFIX + 'sess-immediate')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.dismissedSubagents).toContain('tu_i')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/session-store/store.test.ts -t "synchronously"`

Expected: FAIL — before the implementation, `dispatch` only schedules a debounced save, so `localStorage.getItem(...)` returns `null` (or a payload without `dismissedSubagents`).

- [ ] **Step 3: Implement — persist immediately on dismiss**

In `src/session-store/store.ts`, in `dispatch` (around line 492-496), after scheduling the debounced save, bypass it for a dismiss:

```ts
    this.state = next
    this.snapshot = this.buildSnapshot(next)
    this.scheduleFlush()
    this.scheduleSave()
    // A dismiss must survive an immediate refresh: bypass the 2s save
    // debounce so the dismissed set is persisted synchronously (sync LS write
    // is what hydrate reads; IDB write is chained async but fire-and-forget).
    if (action.type === 'DISMISS_SUBAGENT') this.persistNow()
    this.emit()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/session-store/store.test.ts`

Expected: PASS — the new test plus all existing store tests.

- [ ] **Step 5: Full suite + typecheck + lint + commit**

Run: `npm run typecheck` — Expected: no errors.
Run: `npm run lint` — Expected: no errors.
Run: `npm test` — Expected: full suite PASS.

```bash
git add src/session-store/store.ts src/session-store/store.test.ts
git commit -m "feat: persist dismissed subagents immediately on dismiss

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `ClientIntent.dismissedSubagents` + empty seed → Task 1 Step 3. ✓
- `DISMISS_SUBAGENT` writes intent + mirror → Task 1 Step 4. ✓
- `reapplyDismissed` (flip dismissable, prune absent/terminal, keep dismissed, idempotent, sets `endedAt`) → Task 1 Step 4. ✓
- Persistence payload field, both full & trimmed, stays `v:2` → Task 2 Step 3. ✓
- Constructor rehydrate + re-apply → Task 2 Step 3. ✓
- `persistNow()` on dismiss (race) → Task 3. ✓
- `/clear` clears the set → covered by `CLEAR_TRANSCRIPT` (untouched) + Task 2 Step 1 `/clear` regression test. ✓
- Tests: reducer (record/rebuild/prune/idempotence) + store (hydrate/backcompat/clear/immediate) → Tasks 1-3. ✓

**Placeholder scan:** every step has concrete code or exact commands; no TBD/TODO. ✓

**Type consistency:** `reapplyDismissed(state: SessionState): SessionState` is the single name used across Tasks 1-3. `ClientIntent.dismissedSubagents: ReadonlySet<string>`; persisted as `string[]` via `Array.from(...)`; rehydrated via `new Set(cached.dismissedSubagents)`. Consistent. ✓
