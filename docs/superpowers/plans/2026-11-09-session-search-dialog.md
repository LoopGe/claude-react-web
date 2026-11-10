# Session Search Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-history search dialog to each session; results are grouped by user turn, and selecting one closes the dialog, anchors the transcript at the target, and flashes it.

**Architecture:** The server builds an in-memory, per-session plain-text index from the transcript seq store (not the JSONL), so every hit carries a seq. A new `around`/`aroundUuid` read on the existing `/messages` endpoint returns a page centered on that seq. The client adds an `ANCHOR_RESET` reducer action and a synchronizer `anchorAt`/`returnToHead` path that re-anchors the seq window instead of paging backward. A centered modal (variant A) replaces the inline `MessageSearch` bar and the `pendingJump` loop.

**Tech Stack:** TypeScript, React 19, Hono, Vitest, existing transcript seq store / seq window.

**Spec:** `docs/superpowers/specs/2026-11-09-session-search-dialog-design.md`

## Global Constraints

- TDD: every task writes a failing test first, runs it, implements the minimum, runs it green.
- Server diagnostics go through `createLogger(scope)`; never bare `console.*` for diagnostics.
- Metrics series labels are finite enums; never use session ids or uuids as labels.
- Never hardcode CSS colors; use `var(--…)` and define new tokens in both `:root` and `[data-theme="light"]`.
- Search matching is case-insensitive literal substring via `shared/search/match.ts`; do not introduce regex/regexp user input.
- Every commit step is gated on the task diff passing the `code-review` skill (CLAUDE.md: never commit unreviewed code).
- Task verification commands: `npx vitest run <files>`, `npm run typecheck`, `npx eslint <changed files>`.
- Do not add fallback/default code for failures not proven in a test.

## Review Focus

These are the failure modes most likely to bite, in order. Each gets a test in the owning task.

1. **Anchored view vs live stream** — a live frame arrives while the window is anchored at an older seq; gap-fill/reconnect must not pull the user back to head or silently apply an out-of-range page.
2. **In-flight page before `ANCHOR_RESET`** — a tail/gap/older request issued before the reset resolves after it; it must be discarded by the anchor epoch, never inserted into the anchored window.
3. **First query on a long session** — index build must not stall the event loop for seconds; repeated queries must reuse the index and only append new messages.
4. **Tool-result hit** — the jump must land on the owning tool card, auto-expand the group, and not target a message with no row.
5. **Session cleared/deleted mid-search or mid-anchor** — generation bump / 404 must surface as a clean error or empty state, never a stale anchor or a resurrected transcript.

---

### Task 1: Shared message-visibility predicate

**Files:**
- Create: `shared/message-visibility.ts`
- Create: `shared/message-visibility.test.ts`
- Modify: `src/session-store/normalize.ts` (remove the local implementations, re-export from shared)

**Interfaces:**
- Produces: `shouldHideByDefault(msg: VisibilityShape): boolean`
- Produces: `isLocalCommandLogUserMessage(msg: VisibilityShape): boolean`
- `VisibilityShape` is structural: `{ type?: string; subtype?: string; parent_tool_use_id?: string | null; isCompactSummary?: boolean; message?: unknown }`

- [ ] **Step 1: Write the failing test**

```ts
// shared/message-visibility.test.ts
import { describe, expect, it } from 'vitest'
import { shouldHideByDefault } from './message-visibility'

describe('shouldHideByDefault', () => {
  it('hides non-allowlisted system frames', () => {
    expect(shouldHideByDefault({ type: 'system', subtype: 'init' })).toBe(true)
    expect(shouldHideByDefault({ type: 'system', subtype: 'error' })).toBe(false)
  })
  it('hides CLI local-command logs', () => {
    expect(shouldHideByDefault({
      type: 'user',
      message: { content: '<command-name>/model</command-name>' },
    })).toBe(true)
  })
  it('hides payload-less task-notification injections', () => {
    expect(shouldHideByDefault({
      type: 'user',
      message: { content: [{ type: 'text', text: '<task-notification><task-id>t</task-id><status>completed</status></task-notification>' }] },
    })).toBe(true)
  })
  it('keeps ordinary user/assistant messages', () => {
    expect(shouldHideByDefault({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/message-visibility.test.ts`
Expected: FAIL with "Failed to resolve import ./message-visibility".

- [ ] **Step 3: Implement**

Move `shouldHideByDefault`, `isLocalCommandLogUserMessage`, `leadingUserText`, and `LOCAL_COMMAND_LOG_RE` out of `src/session-store/normalize.ts` into `shared/message-visibility.ts`. Import `classifyTaskNotificationInjection` and `userMessageHasToolResult` from `shared/user-frames.ts`. In `normalize.ts`, re-export both functions from shared so existing imports keep working.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/message-visibility.test.ts src/session-store/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint shared/message-visibility.ts src/session-store/normalize.ts`
Commit: `refactor: share message visibility predicate between server and client`

---

### Task 2: TranscriptStore around/after reads

**Files:**
- Modify: `server/transcript-store.ts`
- Test: `server/transcript-store.test.ts`

**Interfaces:**
- Produces: `around(seq: number, beforeCount: number, afterCount: number): (TranscriptWindow & { hasNewer: boolean }) | null`
- Produces: `hasVisibleAfter(seq: number): boolean`
- Produces: `after(afterSeq: number, limit: number): SeqMessage[]`

- [ ] **Step 1: Write failing tests**

Add to `server/transcript-store.test.ts`:

```ts
it('around returns before/after context and whether newer rows exist', () => {
  const s = new TranscriptStore('s')
  for (let i = 0; i < 10; i++) s.record(`u${i}`, { type: 'assistant', uuid: `u${i}` })
  const page = s.around(5, 2, 2)!
  expect(page.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7])
  expect(page.hasNewer).toBe(true)
  expect(page.hasMore).toBe(true)
})

it('around returns null for an unknown or tombstoned seq', () => {
  const s = new TranscriptStore('s')
  s.record('u0', { type: 'assistant', uuid: 'u0' })
  s.evict(['u0'])
  expect(s.around(0, 1, 1)).toBeNull()
  expect(s.around(99, 1, 1)).toBeNull()
})

it('after returns only visible messages above the watermark, ascending', () => {
  const s = new TranscriptStore('s')
  for (let i = 0; i < 5; i++) s.record(`u${i}`, { type: 'assistant', uuid: `u${i}` })
  s.evict(['u3'])
  expect(s.after(1, 10).map((m) => m.seq)).toEqual([2, 4])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/transcript-store.test.ts`
Expected: FAIL with "s.around is not a function".

- [ ] **Step 3: Implement**

`around` walks the seq map down from `seq - 1` collecting up to `beforeCount` visible entries, includes the target, walks up from `seq + 1` collecting up to `afterCount`, returns oldest-first with `startIndex` = first seq, `hasMore` = a visible seq exists below the first, `hasNewer` = `hasVisibleAfter(last)`. `after` iterates ascending from `afterSeq + 1`, skipping tombstones, capped at `limit`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/transcript-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint server/transcript-store.ts`
Commit: `feat: add around/after reads to transcript store`

---

### Task 3: Around-page API + route

**Files:**
- Modify: `shared/transcript-page.ts` (add `hasNewer?: boolean`)
- Modify: `server/session-manager.ts` (public `getTranscriptWindowAround`; `TranscriptHolder.degraded`)
- Modify: `server/transcript-sidecar.ts` (add `degraded: boolean` to `TranscriptHolder`)
- Modify: `server/routes/sessions.ts`
- Test: `server/routes/transcript-page.test.ts`

**Interfaces:**
- Consumes: `TranscriptStore.around` / `TranscriptStore.after` (Task 2)
- Produces: `SessionManager.getTranscriptWindowAround(id: string, seq: number, beforeCount: number, afterCount: number): Promise<(TranscriptWindow & { totalCount: number; hasNewer: boolean }) | null>`
- Produces: `SessionManager.getTranscriptWindowAfter(id: string, afterSeq: number, limit: number): Promise<{ generation: number; headSeq: number; totalCount: number; messages: SeqMessage[] }>`
- Produces: `SessionManager.isTranscriptDegraded(id: string): Promise<boolean>`
- `GET /api/sessions/:id/messages?around=<seq>&limit=<n>` and `?aroundUuid=<uuid>&limit=<n>`; mutually exclusive with `before`; response `TranscriptPageResponse` with `hasNewer`.

- [ ] **Step 1: Write failing route tests**

Add cases to `server/routes/transcript-page.test.ts`:

```ts
it('serves a page centered on around and reports hasNewer', async () => {
  const res = await app.request('/api/sessions/s1/messages?around=5&limit=4')
  const body = await json(res)
  expect(body.messages.map((m: any) => m.seq)).toEqual([4, 5, 6, 7])
  expect(body.hasNewer).toBe(true)
})

it('resolves aroundUuid before serving the page', async () => {
  const res = await app.request('/api/sessions/s1/messages?aroundUuid=u5&limit=4')
  expect(res.status).toBe(200)
})

it('rejects around + before and unknown uuids', async () => {
  expect((await app.request('/api/sessions/s1/messages?around=5&before=9')).status).toBe(400)
  expect((await app.request('/api/sessions/s1/messages?aroundUuid=nope')).status).toBe(404)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/routes/transcript-page.test.ts`
Expected: FAIL (unknown query / missing hasNewer).

- [ ] **Step 3: Implement**

Route: parse `around`/`aroundUuid`; reject both-with-each-other and with `before` (400); `aroundUuid` resolves through `transcriptSeqOfUuid` (404 when undefined); call `getTranscriptWindowAround` (404 when null). Manager: `ensureTranscriptReconciled`, then `t.store.around(...)`, attach `totalCount: t.store.visibleCount`. `getTranscriptWindowAfter` wraps `t.store.after(afterSeq, limit)` with generation/headSeq/totalCount. `degraded` is set in the reconcile catch block and returned by `isTranscriptDegraded` after awaiting reconcile.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/routes/transcript-page.test.ts server/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint server/routes/sessions.ts server/session-manager.ts server/transcript-sidecar.ts shared/transcript-page.ts`
Commit: `feat: add around-page transcript API`

---

### Task 4: Session search index (full build + search)

**Files:**
- Create: `shared/session-search.ts` (hit/response wire types)
- Create: `server/session-search-index.ts`
- Test: `server/session-search-index.test.ts`

**Interfaces:**
- Produces: `SessionSearchHit` / `SessionSearchResponse` in `shared/session-search.ts` (exact shape from spec §5.3)
- Produces: `createSessionSearchIndex(deps: { getWindow(id, before?, limit?): Promise<TranscriptPageResponse>; getAfter(id, afterSeq, limit): Promise<{ generation: number; headSeq: number; messages: SeqMessage[] }>; isDegraded(id): Promise<boolean> }): { search(id: string, query: string, limit: number): Promise<SessionSearchResponse> }`
- Internal rows: `{ seq, messageSeq, uuid, role, text, turnSeq, turnNo, turnPrompt, ownerSeq? }`

- [ ] **Step 1: Write failing tests**

```ts
// Fixture: seq 0 user "how do I cache?" (turn 1); seq 1 assistant "use search cache";
// seq 2 assistant tool_use Bash id "tu1"; seq 3 user tool_result tu1 "error: boom";
// seq 4 user "next question" (turn 2); seq 5 assistant "search is hard";
// seq 6 sidechain assistant "search inside agent" (parent set);
// seq 7 hidden task-notification containing "search".
it('groups hits under the nearest real user prompt', async () => {
  const res = await index.search('s1', 'search', 100)
  expect(res.hits.map((h) => [h.messageSeq, h.turnNo, h.turnPrompt])).toEqual([
    [1, 1, 'how do I cache?'],
    [5, 2, 'next question'],
  ])
})
it('skips sidechain and hidden frames', async () => {
  const res = await index.search('s1', 'search', 100)
  expect(res.hits.map((h) => h.messageSeq)).toEqual([1, 5])
})
it('maps a tool_result hit to its owning tool_use seq', async () => {
  const res = await index.search('s1', 'boom', 100)
  expect(res.hits).toHaveLength(1)
  expect(res.hits[0]).toMatchObject({ seq: 2, messageSeq: 3, ownerToolUseId: 'tu1', role: 'tool_result' })
})
it('treats a steered top-level user message as a new turn', async () => {
  // seq 8 user with steeredAt set, containing "search"; expect turnNo 3
  const res = await index.search('s1', 'search', 100)
  expect(res.hits.find((h) => h.messageSeq === 8)?.turnNo).toBe(3)
})
it('creates a 会话开头 group when the store has no preceding prompt', async () => {
  // fixture whose seq 0 is an assistant frame containing "search"
  const res = await index.search('s9', 'search', 100)
  expect(res.hits[0]).toMatchObject({ turnNo: 1, turnPrompt: '（会话开头）' })
})
it('caps at limit and reports totalHits/truncated', async () => {
  // 120 seeded assistant messages containing "needle"; limit 100
  expect(res.hits).toHaveLength(100)
  expect(res.totalHits).toBe(120)
  expect(res.truncated).toBe(true)
})
it('returns empty for a whitespace query without building', async () => {
  const res = await index.search('s1', '   ', 100)
  expect(res.hits).toEqual([])
  expect(deps.getWindow).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/session-search-index.test.ts`
Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3: Implement**

Build rows by paging `getWindow(id, before, 1000)` backward, reversing pages into chronological order. While scanning: track the last real user prompt (top-level, no tool_result, not task-notification/local-command per Task 1) as the turn boundary; record a `Map<string, number>` of tool_use id → seq and set `ownerSeq` on matching tool_result rows; skip rows failing `shouldHideByDefault` or with `parent_tool_use_id != null` (except tool_result carriers); skip non-user/assistant/tool_result types. Extract text with `extractMessagePlainText`. Search with `toLowerCase().includes()`; `totalHits` counts matched messages, `truncated = totalHits > hits.length`. If the first row has no turn, start a `（会话开头）` group at seq 0. `indexStatus` from `isDegraded(id)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/session-search-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint shared/session-search.ts server/session-search-index.ts`
Commit: `feat: add session transcript search index`

---

### Task 5: Incremental index + search route

**Files:**
- Modify: `server/session-search-index.ts`
- Modify: `server/routes/sessions.ts`
- Test: `server/session-search-index.test.ts`
- Test: `server/routes/session-search.test.ts`

**Interfaces:**
- Consumes: `TranscriptStore.after` (Task 2) via `deps.getAfter`
- Produces: `GET /api/sessions/:id/search?q=&limit=` → `SessionSearchResponse`

- [ ] **Step 1: Write failing tests**

```ts
it('appends only rows above lastIndexedSeq', async () => { /* second search sees new rows, not a full rebuild */ })
it('rebuilds when generation changes', async () => { /* reset + search sees only new content */ })
it('route returns 404 for unknown sessions and clamps limit to 100', async () => { /* ... */ })
it('route returns indexStatus degraded when the reconcile failed', async () => { /* ... */ })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/session-search-index.test.ts server/routes/session-search.test.ts`
Expected: FAIL (no incremental path / no route).

- [ ] **Step 3: Implement**

Index cache: `Map<sessionId, { generation, lastIndexedSeq, rows, lastTurn }>` LRU 4. On search: read the current `generation`/`headSeq`; if generation changed, rebuild; else append `after(lastIndexedSeq, 1000)` rows (loop until no more), carrying the last turn forward. Use `setImmediate` every 200 rows during a build. Route: mount in the sessions router; create the index once per router instance (`createSessionSearchIndex({ getWindow: (id, before, limit) => sm.getTranscriptWindow(id, before, limit), getAfter: (id, afterSeq, limit) => sm.getTranscriptWindowAfter(id, afterSeq, limit), isDegraded: (id) => sm.isTranscriptDegraded(id) })`). Reject an empty (trimmed) query with 200 + empty hits, allow 1+ chars; 404 unknown; `limit` clamp 1..100.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/session-search-index.test.ts server/routes/session-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint server/session-search-index.ts server/routes/sessions.ts`
Commit: `feat: add incremental session search API`

---

### Task 6: Client search hook

**Files:**
- Create: `src/hooks/useSessionSearch.ts`
- Test: `src/hooks/useSessionSearch.test.tsx`

**Interfaces:**
- Consumes: `SessionSearchResponse` (Task 4), `api.get`
- Produces: `useSessionSearch(sessionId: string, query: string, opts?: { enabled?: boolean }): { hits: SessionSearchHit[]; totalHits: number; truncated: boolean; indexStatus: 'ok' | 'degraded'; loading: boolean; error: boolean; retry(): void }`

- [ ] **Step 1: Write failing tests**

```ts
it('does not request for an empty query', async () => { /* fetch not called */ })
it('debounces and aborts the previous request', async () => { /* fake timers */ })
it('ignores an out-of-order response', async () => { /* resolve first request after the second */ })
it('surfaces degraded and error states', async () => { /* ... */ })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/useSessionSearch.test.tsx`
Expected: FAIL with "useSessionSearch is not a function".

- [ ] **Step 3: Implement**

Use `useDebouncedValue(query, 180)` + `AbortController` + a request sequence id. `api.get<SessionSearchResponse>(`/sessions/${id}/search?q=...&limit=100`, { signal })`. Reset hits on a new query; keep `retry()` as a nonce. `enabled:false` → idle.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useSessionSearch.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint src/hooks/useSessionSearch.ts`
Commit: `feat: add useSessionSearch hook`

---

### Task 7: Session search dialog

**Files:**
- Create: `src/components/SessionSearchDialog.tsx`
- Test: `src/components/SessionSearchDialog.test.tsx`
- Modify: `src/components/Overlay.tsx` (add `search` variant)
- Modify: `src/styles/overlays.css` (class names + animation + both themes)
- Modify: `src/styles/keyframe-dedup.test.ts` if it enumerates animations

**Interfaces:**
- Consumes: `useSessionSearch` (Task 6), `Overlay`, `useListSelection`, `useExitPresence`
- Produces: `<SessionSearchDialog open sessionId initialQuery onClose onSelect={(hit) => void} />`
- Overlay variant: `{ backdrop: 'palette-backdrop', card: 'session-search-dialog', roleOn: 'card', ariaModal: 'true' }`

- [ ] **Step 1: Write failing tests**

```tsx
it('renders hits grouped by turn with the query marked', () => {
  // two hits: turn 2 ("把搜索修一下", assistant) and turn 5 ("排序", user)
  renderDialog()
  expect(screen.getAllByText(/^第 \d+ 轮$/)).toHaveLength(2)
  expect(screen.getAllByRole('option')).toHaveLength(2)
  expect(document.querySelectorAll('mark')).toHaveLength(2)
})

it('moves selection with ArrowDown/ArrowUp and selects on Enter', () => {
  renderDialog()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ turnNo: 5 }))
})

it('shows loading, empty, degraded, and error states', () => {
  // re-render with each hook state; assert the exact Chinese copy
  expect(screen.getByText('搜索中…')).toBeInTheDocument()
  expect(screen.getByText('没有找到匹配')).toBeInTheDocument()
  expect(screen.getByText('这段会话的历史暂时无法读取')).toBeInTheDocument()
  expect(screen.getByText('搜索失败')).toBeInTheDocument()
})

it('seeds the input from initialQuery and closes on Escape', () => {
  renderDialog({ initialQuery: '搜索' })
  expect(screen.getByRole('textbox')).toHaveValue('搜索')
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  expect(onClose).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/SessionSearchDialog.test.tsx`
Expected: FAIL with "Cannot find module ./SessionSearchDialog".

- [ ] **Step 3: Implement**

Centered modal, max-height 74vh. Header: input, scope chip `当前会话 · 完整历史`, result count/status. Body: `role="listbox"` with group headers (`第 N 轮`, prompt) and rows (`你`/`Claude`/`工具`, highlighted snippet, time). Footer hints. Reuse `useListSelection`; `activeIndex` maps to the flattened hit list. Empty query shows a hint and issues no request. On select: call `onSelect(hit)`. Do not close inside the dialog; the parent owns closing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/SessionSearchDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint src/components/SessionSearchDialog.tsx src/components/Overlay.tsx`
Commit: `feat: add session search dialog`

---

### Task 8: Store anchor reset

**Files:**
- Modify: `src/session-store/types.ts` (action + snapshot field)
- Modify: `src/session-store/reducer.ts`
- Modify: `src/session-store/window-bridge.ts`
- Test: `src/session-store/anchor-reset.test.ts`

**Interfaces:**
- Produces: `{ type: 'ANCHOR_RESET'; generation: number; headSeq: number; viewSeq: number }`
- Produces: `ServerMirror.anchored: boolean` (or a snapshot field surfaced via `selectors`)
- Handler: rebuild the transcript layer from `createInitialServerMirror()`, preserve `intent` and every non-transcript mirror field.

- [ ] **Step 1: Write failing tests**

```ts
it('clears transcript items, indexes, and window but preserves intent/tasks/contextUsage', () => {
  /* seed a state via applyMessage + tasks/contextUsage, dispatch ANCHOR_RESET, assert */
})
it('lets a following WINDOW_PAGE at tail adopt the empty window', () => {
  /* dispatch ANCHOR_RESET then WINDOW_PAGE; assert items and oldestSeq */
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session-store/anchor-reset.test.ts`
Expected: FAIL (unknown action).

- [ ] **Step 3: Implement**

`ANCHOR_RESET` builds a fresh mirror, copies the non-transcript fields named in `ServerMirror` (tasks, contextUsage, promptSuggestion, apiRetry, thinkingTokens, sessionState, meta-like fields), keeps `state.intent` verbatim, sets `anchored: true`, and starts the window at `emptyWindow(generation, headSeq)` with `viewSeq`. Do not touch permissions (they live in `intent`/separate store state) or the prompt queue.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session-store/anchor-reset.test.ts src/session-store/reducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint src/session-store/types.ts src/session-store/reducer.ts src/session-store/window-bridge.ts`
Commit: `feat: add ANCHOR_RESET transcript action`

---

### Task 9: Synchronizer anchor + back-to-latest

**Files:**
- Modify: `src/session-sync/session-synchronizer.ts`
- Modify: `src/session-sync/useSessionSynchronizer.ts`
- Test: `src/session-sync/session-synchronizer.anchor.test.ts`

**Interfaces:**
- Produces: `anchorAt(target: { seq: number } | { uuid: string }): Promise<void>`
- Produces: `returnToHead(): Promise<void>`
- Extends `TranscriptPagingSnapshot` with `{ anchored: boolean; newerCount: number }`
- `SyncRunState.anchorEpoch`, `SyncRunState.anchored`.
- `fetchValidatedPage(run, url, opts?: { anchorEpoch?: number })` discards a page whose epoch differs.

- [ ] **Step 1: Write failing tests**

```ts
it('anchorAt fetches around, dispatches ANCHOR_RESET then WINDOW_PAGE', async () => {
  get.mockResolvedValueOnce(page({ generation: 2, headSeq: 20, startIndex: 4, hasMore: true, hasNewer: true }))
  await sync.anchorAt({ seq: 5 })
  expect(get).toHaveBeenCalledWith('/sessions/s1/messages?around=5&limit=200')
  expect(dispatches.map((d) => d.type)).toEqual(['ANCHOR_RESET', 'WINDOW_PAGE'])
  expect(sync.getPagingSnapshot()).toMatchObject({ anchored: true })
})

it('a page requested before ANCHOR_RESET is discarded', async () => {
  const parked = deferred<TranscriptPageResponse>()
  get.mockReturnValueOnce(parked.promise) // tail fetch from start()
  sync.start()
  await sync.anchorAt({ seq: 5 }) // bumps anchorEpoch, fetches its own page
  parked.resolve(page({ generation: 2, headSeq: 20, startIndex: 0 }))
  expect(dispatches.filter((d) => d.type === 'WINDOW_PAGE')).toHaveLength(1)
})

it('live frames while anchored park and increment newerCount without fillGap', async () => {
  await sync.anchorAt({ seq: 5 })
  get.mockClear()
  emit({ kind: 'message', seq: 21, generation: 2, message: assistant('live') })
  expect(get).not.toHaveBeenCalled() // no gap-fill request
  expect(sync.getPagingSnapshot().newerCount).toBe(1)
})

it('returnToHead re-anchors at the newest page and clears anchored', async () => {
  await sync.anchorAt({ seq: 5 })
  await sync.returnToHead()
  expect(get).toHaveBeenLastCalledWith('/sessions/s1/messages?limit=200')
  expect(sync.getPagingSnapshot().anchored).toBe(false)
})

it('reconnect start() re-fetches the anchored cursor, not head', async () => {
  await sync.anchorAt({ seq: 5 })
  sync.stop()
  sync.start()
  expect(get).toHaveBeenLastCalledWith('/sessions/s1/messages?around=5&limit=200')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session-sync/session-synchronizer.anchor.test.ts`
Expected: FAIL (anchorAt missing).

- [ ] **Step 3: Implement**

`anchorAt` bumps `anchorEpoch`, sets `anchored`, pauses gap-fill, fetches `/messages?around=…` (or `aroundUuid=…`) through the validated fetch, dispatches `ANCHOR_RESET` with the page's generation/headSeq, then `WINDOW_PAGE at:'tail'`. `returnToHead` fetches the head page, dispatches the same pair with `anchored:false`. `handleFrame` keeps `WINDOW_LIVE` for live frames so they park; `fillGap` returns early while anchored; `refetchTail` uses the anchored cursor on reconnect. `setPaging` compares the new fields. Adapter exposes stable `anchorAt`/`returnToHead` callbacks and spreads the new paging fields.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session-sync/session-synchronizer.anchor.test.ts src/session-sync/session-synchronizer.seq.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint src/session-sync/session-synchronizer.ts src/session-sync/useSessionSynchronizer.ts`
Commit: `feat: anchor transcript window for search jumps`

---

### Task 10: Reveal/flash + tool-group expansion + back-to-latest pill

**Files:**
- Modify: `src/components/MessageList.tsx`
- Modify: `src/components/message-list/ToolGroupCard.tsx`
- Modify: `src/components/message-list/transcript-chrome.tsx` (newer pill) or `src/components/Chat.tsx`
- Modify: `src/styles/chat.css` (reveal animation + pill, both themes)
- Test: `src/components/MessageList.reveal.test.tsx`

**Interfaces:**
- `MessageList` consumes `revealTarget?: { nonce: number; messageUuid?: string; ownerToolUseId?: string }`
- `ToolGroupCard` consumes `revealMemberItemIndex?: number`
- Pill consumes `paging.anchored` / `paging.newerCount` and calls `paging.returnToHead()`

- [ ] **Step 1: Write failing tests**

```tsx
it('seeks to the revealed message and marks its row', () => {
  // items: m0..m3; revealTarget { nonce: 1, messageUuid: 'm3' }
  renderList({ items, revealTarget: { nonce: 1, messageUuid: 'm3' } })
  expect(seekToIndex).toHaveBeenCalledWith(3, 'center')
  expect(screen.getByTestId('row-m3')).toHaveAttribute('data-crw-reveal', 'true')
})

it('opens the tool group containing the revealed tool_use and flashes the card', () => {
  // two folded Edit rows; revealTarget { nonce: 2, ownerToolUseId: 'tu2' }
  renderList({ items, revealTarget: { nonce: 2, ownerToolUseId: 'tu2' } })
  expect(screen.getByTestId('tool-group')).toHaveAttribute('data-open', 'true')
  expect(screen.getByTestId('tool-group')).toHaveAttribute('data-crw-reveal', 'true')
})

it('shows the newer-messages pill only while anchored with newerCount > 0', () => {
  renderPill({ anchored: true, newerCount: 3 })
  expect(screen.getByText(/3 条新消息/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /回到最新/ }))
  expect(returnToHead).toHaveBeenCalled()
})

it('respects prefers-reduced-motion (no animation class)', () => {
  mockMatchMedia('(prefers-reduced-motion: reduce)', true)
  renderList({ items, revealTarget: { nonce: 3, messageUuid: 'm1' } })
  expect(screen.getByTestId('row-m1')).not.toHaveAttribute('data-crw-reveal-anim')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/MessageList.reveal.test.tsx`
Expected: FAIL (prop unknown / no pill).

- [ ] **Step 3: Implement**

Resolve the target to an item index: `messageUuid` → item; else `ownerToolUseId` → the item whose content has that tool_use id. `seekToIndex` on the mapped row; set a reveal row id for 1.8s; pass `revealMemberItemIndex` to `ToolGroupCard`, whose fold reducer force-opens on a reveal event. The pill renders above the composer when `anchored && newerCount > 0`; click calls `returnToHead`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/MessageList.reveal.test.tsx src/components/message-list/transcript-rows.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint src/components/MessageList.tsx src/components/message-list/ToolGroupCard.tsx`
Commit: `feat: reveal and flash search jump targets`

---

### Task 11: Chat wiring + remove the inline search bar

**Files:**
- Modify: `src/components/Chat.tsx`
- Modify: `src/components/ChatPanel.tsx`
- Modify: `src/App.tsx` / `shared/message-jump.ts`
- Delete: `src/components/MessageSearch.tsx`
- Delete: `src/components/message-list/transcript-search.ts` + `transcript-search.test.ts`
- Modify: `src/components/Chat.tsx` (remove `searchOpen`, `searchSeed`, `searchQuery`, `debouncedQuery`, `searchMatches`, `searchActiveIdx`, `topVisibleIdxRef`, `pendingJump`, `handledJumpNonceRef`, Ctrl+F handler, context-menu entry)
- Modify: `src/styles/chat.css` (remove `.message-search-*`)
- Test: `src/components/Chat.search.test.tsx` (new)

**Interfaces:**
- `ChatPanel` owns `searchOpen`/`searchInitialQuery`/`revealTarget`; renders `<SessionSearchDialog>` and the header search button.
- `Chat` consumes `revealTarget` and `messageJumpTarget` (App) and calls `paging.anchorAt(...)` then sets the MessageList reveal target.
- Palette hit: `messageJumpTarget` keeps `{ nonce, sessionId, query, messageUuid }`; Chat anchors via `{ uuid }`.

- [ ] **Step 1: Write failing tests**

```tsx
it('opens the dialog from Ctrl+F and from the header button', () => {
  fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
  expect(screen.getByRole('dialog', { name: '搜索会话历史' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '搜索会话历史' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it('closes the dialog and reveals the selected hit', async () => {
  // dialog onSelect({ seq: 5, messageUuid: 'm5' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(anchorAt).toHaveBeenCalledWith({ seq: 5 })
  expect(seekToIndex).toHaveBeenCalled()
})

it('routes a palette message hit through the same anchor path', async () => {
  renderChat({ messageJumpTarget: { nonce: 1, sessionId: 's1', query: 'q', messageUuid: 'm5' } })
  expect(anchorAt).toHaveBeenCalledWith({ uuid: 'm5' })
})

it('no longer renders the inline message-search bar', () => {
  expect(screen.queryByPlaceholderText('Search messages…')).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/Chat.search.test.tsx`
Expected: FAIL (dialog not wired / bar still present).

- [ ] **Step 3: Implement**

- `ChatPanel`: add `IconSearch` button in `.chat-panel-meta`; `Ctrl+F` keydown when focused; state for dialog + reveal; pass `onOpenSearch` to `Chat` for the context-menu selection.
- `Chat`: remove the inline bar state/effects/handlers; on `revealTarget`/`messageJumpTarget`, call `paging.anchorAt` and set the MessageList reveal prop; keep the flash and error toast.
- `App.handleSelectMessage`: simplify the target to `{ nonce, sessionId, query, messageUuid }` (drop `messageIndex`/`matchOrdinal`); update `shared/message-jump.ts`.
- Delete `MessageSearch.tsx`, `transcript-search.ts` + test, the `.message-search-*` CSS, and the `MessageSearch` import. Leave `searchQuery` highlight primitives in `MessageList`/`Markdown` untouched (design §6.4).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/Chat.search.test.tsx src/components/CommandPalette.test.tsx src/components/message-list/transcript-rows.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint src/components/Chat.tsx src/components/ChatPanel.tsx src/App.tsx shared/message-jump.ts`
Commit: `feat: wire session search dialog and remove inline bar`

---

### Task 12: Integration + full verification

**Files:**
- Create: `src/components/session-search.integration.test.tsx`
- No production changes expected; fix only confirmed integration defects.

- [ ] **Step 1: Write the integration test**

```tsx
it('search → select → anchor page → row revealed → newer pill → back to latest', async () => {
  /* fake api: /search returns a hit with seq 5; /messages?around=5 returns a page;
     live frame while anchored increments newerCount; click pill calls returnToHead */
})
```

- [ ] **Step 2: Run it and fix confirmed defects**

Run: `npx vitest run src/components/session-search.integration.test.tsx`
Expected: PASS after fixes.

- [ ] **Step 3: Full verification**

Run: `npm run typecheck && npm run lint && npm test`
Expected: both typechecks pass, lint clean, full suite green.

- [ ] **Step 4: Code review**

Run the `code-review` skill on the full diff; verify each finding, fix confirmed issues, re-run the affected tests.

- [ ] **Step 5: Commit**

Commit: `feat: full-history session search dialog`

---

## Self-Review Notes

- Spec §4 (UX), §5 (server index/API), §6 (anchor/reveal), §7 (failure states), §8 (tests) each map to a task above.
- Type names are defined once in Task 4 (`shared/session-search.ts`) and consumed by Tasks 5-7, 11-12.
- `hasNewer` is added to `TranscriptPageResponse` in Task 3; `anchored`/`newerCount` live in the paging snapshot in Task 9; Task 10 consumes them.
- Review Focus items map to: #1 Task 9, #2 Task 9, #3 Tasks 4/5, #4 Tasks 4/10, #5 Tasks 3/8/9.
- The inline bar removal is isolated in Task 11 so the model/dialog work can be reviewed first.