# Native Resumable Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native sessions first-class in the `/resume` picker — enumerable, adoptable, and recoverable after ordinary delete with their titles (manual AND auto-generated) intact.

**Architecture:** A new durable `session/title` log event (DSH-parity semantics) written by `renameSession` and auto-title; a host-side selective listing scan (one streaming pass, parse only header/user/title lines) with a stat-keyed in-memory row cache feeds two new `NativeProvider` methods (`listResumable`, `getSessionInfo`). The manager is unchanged — its provider iteration and multi-provider `adoptDiskSession` (commit `a317a476`) carry everything.

**Tech Stack:** TypeScript, Node fs/readline, vitest (server: Node env; client: happy-dom), existing native session-log format machinery.

**Spec:** `docs/superpowers/specs/2026-11-25-native-resumable-discovery-design.md`

## Global Constraints

- **Manager diff zero:** `server/session-manager.ts` is NOT modified by any task.
- **Core neutrality:** `vocabulary/` and `session-log/` files import ONLY neutral `shared/*`, Node builtins, and sibling vocabulary/core. The host-free pin (`host-free.test.ts`) bans value-imports of host-domain services from EVERY production file under `native/` — the listing module therefore lives OUTSIDE `native/` at `server/providers/native-resumable-listing.ts` (the `native-host-adapters.ts` precedent). Pins: `vocabulary/neutrality.test.ts`, `host-free.test.ts` stay green and literally untouched.
- **`session/title` is log-only:** never enters model history (`historyFromEvents`), renderable transcript (`projectNativeEventToSdkLine` → null), or search.
- **Single writer:** never call `NativeSessionLog.open()` over a live writer (`open()` supersedes the previous writer, `log.ts:378`). Live appends ride the current writer's `appendDurable`.
- **Exact values:** listing concurrency chunk = 16; row cache cap = 256; freshness key = `(size, mtimeMs)`; `?dir=` scope = exact `header.cwd` match; log title maps to `ResumableSession.title` (NOT `customTitle`); `known/running/terminated` default `false` (manager annotates).
- **TDD:** every behavior gets a failing test first; run it, watch it fail for the right reason, then implement.
- **Commits:** Conventional Commits (commitlint hook active); one commit per task; stage only that task's files (the worktree may carry other sessions' changes).
- **Diagnostics:** `createLogger(scope)` only, never bare `console.*` on the server.

## Review Focus

Inputs/conditions the spec implies but no happy-path test exercises — each gets a pin in the owning task:

1. **Torn tail during a live turn** — picker opens mid-append; the scan must parse only complete lines (up to the last `\n`) and never throw on the half-written final line. (Task 4)
2. **Title append interleaved with a turn's append burst** — seq chain stays contiguous and both the turn events and the title are durable. (Task 2)
3. **Windows EBUSY / delete race mid-scan** — a log locked or unlinked while the listing reads it: row skipped, listing survives, no negative verdict cached. (Task 4)
4. **Multi-MB log** — scan memory stays bounded: streaming lines, no whole-file JSON.parse, no event-array retention. (Task 4)
5. **Junk under `native-sessions/`** — non-id directories, plain files, empty dirs: enumeration skips them safely. (Task 4)

---

### Task 1: `session/title` durable event

**Files:**
- Modify: `server/providers/native/vocabulary/session-event.ts` (SessionEventMap, ~line 98–139 operational block)
- Modify: `server/providers/native/session-log/format.ts` (V3_EVENT_TYPES `:881`, parseEventLineV3 switch `:1038`)
- Test: `server/providers/native/session-log/format.test.ts`
- Test: `server/providers/native/session-log/log.test.ts`
- Test: `server/providers/native/session-log/replay.test.ts`
- Test: `server/providers/native/session-log/reader.test.ts`
- Test: `server/providers/native-host-frame-adapter.test.ts`

**Interfaces:**
- Consumes: existing `SessionEventMap`, `parseEventLineV3(raw, expectedSeq, sessionId, path)`, `requireV3NonEmptyString`, writer `append(input: NativeEventInput | NativeNeutralEventInput)`.
- Produces: event key `'session/title'` with payload `{ title: string }` (non-empty), envelope `{ type, seq, time, data }` — usable by Tasks 2–5 as `{ type: 'session/title', time: number, data: { title: string } }` append input.

- [ ] **Step 1: Write the failing tests**

`format.test.ts`: `parseEventLineV3` accepts a `session/title` line (round-trips `data.title`); rejects empty-string title; rejects unknown data field (`{ title, extra }`); rejects missing `data`.
`log.test.ts`: `writer.append({ type: 'session/title', time: Date.now(), data: { title: 'T' } })` returns a neutral event with the next seq; after `flush()` + `loadNativeSessionLog`, the snapshot's neutral events contain it.
`replay.test.ts`: `historyFromEvents([...turn events, session/title event])` deep-equals `historyFromEvents([...turn events])` (title ignored).
`reader.test.ts`: `readNativeHistoryPage` over a log containing a `session/title` event returns no row for it.
`native-host-frame-adapter.test.ts`: `projectNativeEventToSdkLine(titleEvent, sessionId)` returns `null`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/session-log/format.test.ts server/providers/native/session-log/log.test.ts server/providers/native/session-log/replay.test.ts server/providers/native/session-log/reader.test.ts server/providers/native-host-frame-adapter.test.ts`
Expected: FAIL — `unknown event type 'session/title'` from the validator; append/reader/adapter tests fail on the same missing key.

- [ ] **Step 3: Implement the event**

`session-event.ts`: add to `SessionEventMap` (operational block, after `'session/agent'`):
```ts
/** Durable session title (DSH session-title parity): latest-wins, log-only —
 *  never model history, renderable transcript, or search. Written by manual
 *  rename and auto-title; forks inherit it in their seed unchanged. */
'session/title': { title: string }
```
`format.ts`: add `'session/title'` to `V3_EVENT_TYPES`; add the switch case:
```ts
case 'session/title':
  return { type, ...envelope, data: { title: requireV3NonEmptyString(data, 'title', type, sessionId, path) } } as NativeSessionEvent
```
No migration code: legacy logs simply lack the event. No `ignorable` flag (plain operational event, same as `session/context`).

- [ ] **Step 4: Run tests to verify they pass**

Run: the Step 2 command. Expected: PASS. Also run `npx vitest run server/providers/native/vocabulary/neutrality.test.ts server/providers/native/host-free.test.ts` — Expected: PASS (no new imports).

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/vocabulary/session-event.ts server/providers/native/session-log/format.ts server/providers/native/session-log/format.test.ts server/providers/native/session-log/log.test.ts server/providers/native/session-log/replay.test.ts server/providers/native/session-log/reader.test.ts server/providers/native-host-frame-adapter.test.ts
git commit -m "feat(native): durable session/title log event"
```

---

### Task 2: `appendSessionTitle` helper + `NativeProvider.renameSession`

**Files:**
- Modify: `server/providers/native/session-log/log.ts` (new exported function near `deleteNativeSessionLog` `:226`)
- Modify: `server/providers/native/native-provider.ts` (new method)
- Test: `server/providers/native/session-log/log.test.ts`
- Test: `server/providers/native/native-provider.test.ts`

**Interfaces:**
- Consumes: Task 1's event; module-private `writers` map (`log.ts:97`), `NativeSessionLog.open/appendDurable/migrateToV3/close`, `loadNativeSessionLogSync`, `NativeSessionStorageError`.
- Produces:
  - `export async function appendSessionTitle(stateDir: string, id: string, title: string): Promise<void>` (log.ts) — throws `NativeSessionStorageError('missing', …)` when no log exists.
  - `NativeProvider.renameSession(sessionId: string, title: string): Promise<void>` — satisfies `AgentProvider.renameSession` (`types.ts:463`); the manager's existing `persistTitleToTranscript` seam calls it on every manual rename (live + dormant).

- [ ] **Step 1: Write the failing tests**

`log.test.ts`:
- *live writer reuse*: open a writer, `appendSessionTitle`, then append a turn event through the ORIGINAL writer object — seq contiguous (Review Focus 2: interleave a title between two turn appends and assert the full seq chain + all events durable after flush).
- *dormant append*: create + flush + close a log; `appendSessionTitle`; reload — title event present, writer closed (file handle released).
- *missing log*: `appendSessionTitle` on an id with no log → rejects with `NativeSessionStorageError`, `kind === 'missing'`.
- *legacy migration*: seed a v2 log (existing fixture pattern in `migration.test.ts`); `appendSessionTitle`; reload — header `v === 3`, title event present.

`native-provider.test.ts`: `provider.renameSession(id, 'T')` on a dormant log fixture appends the event (delegation pin).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/session-log/log.test.ts server/providers/native/native-provider.test.ts`
Expected: FAIL — `appendSessionTitle is not a function` / `provider.renameSession is not a function`.

- [ ] **Step 3: Implement**

`log.ts` — the helper owns the single-writer decision (it lives in the module that owns `writers`):
```ts
export async function appendSessionTitle(stateDir: string, id: string, title: string): Promise<void> {
  const path = nativeSessionLogPath(stateDir, id)
  const input = { type: 'session/title' as const, time: Date.now(), data: { title } }
  const current = writers.get(resolve(path))
  if (current) { await current.appendDurable(input); return }
  const snapshot = loadNativeSessionLogSync(stateDir, id)
  if (!snapshot) throw new NativeSessionStorageError('missing', `no session log at ${path}`, id, path)
  const log = NativeSessionLog.open({ stateDir, id, cwd: snapshot.header.cwd, resume: true })
  try {
    if (log.header.v < NATIVE_SESSION_LOG_V3) await log.migrateToV3()
    await log.appendDurable(input)
  } finally { await log.close() }
}
```
(`close()` removes the writer from the map, `log.ts:911`; a superseded writer is replaced in the map by `open()`, so a map hit is always the current writer. `appendDurable` drains pending bytes through the writer-operation queue — do not use bare `append` + `flush`.)

`native-provider.ts`:
```ts
async renameSession(sessionId: string, title: string): Promise<void> {
  await appendSessionTitle(this.stateDir, sessionId, title)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/session-log/log.ts server/providers/native/session-log/log.test.ts server/providers/native/native-provider.ts server/providers/native/native-provider.test.ts
git commit -m "feat(native): renameSession persists titles through the single log writer"
```

---

### Task 3: Auto-title persistence (provider-side, no-overwrite guard)

**Files:**
- Modify: `server/providers/native/native-session.ts` (`generateTitle` `:2334`)
- Test: `server/providers/native/native-session.test.ts`
- Test: `server/providers/native/e2e-tools.test.ts` (existing auto-title e2e ~`:661`)

**Interfaces:**
- Consumes: Task 1's event; `this.log.appendDurable`; `neutralEventsOf(this.log)` (`session-log/neutral-read.ts`).
- Produces: `generateTitle(description): Promise<unknown>` — UNCHANGED return contract (the manager trims/persists the resolved value); the log append is a side effect before return.

- [ ] **Step 1: Write the failing tests**

`native-session.test.ts` (stub `ports.auxLlm.call` to resolve a title string):
- auto-title appends one `session/title` event with the trimmed text.
- a pre-existing `session/title` event (manual rename) → auto-title appends NOTHING (log-level no-overwrite).
- empty/whitespace aux result → no append.
- ordering: auto-title first, then a manual `appendSessionTitle` → latest-wins fold yields the manual title.

`e2e-tools.test.ts`: extend the existing auto-title test — after `sm.autoGenerateTitle`, the on-disk log contains the `session/title` event.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/native-session.test.ts server/providers/native/e2e-tools.test.ts`
Expected: FAIL — no title event in the log after `generateTitle`.

- [ ] **Step 3: Implement**

In `generateTitle`, after the aux call resolves (`raw`), before returning:
```ts
const text = String(raw ?? '').trim()
if (text && !neutralEventsOf(this.log).some((e) => e.type === 'session/title')) {
  await this.log.appendDurable({ type: 'session/title', time: Date.now(), data: { title: text } })
}
return raw
```
The trim mirrors the manager's own normalization (`session-manager.ts:7928`). The scan is per-call (auto-title runs once per session) — no cached state. A failed append propagates: the manager's `timeSdkControl` surfaces it and leaves the session untitled (existing thrown-`generateTitle` behavior). The manager's store-level double no-overwrite guard (`:7911`, `:7922`) is untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/native-session.test.ts server/providers/native/e2e-tools.test.ts
git commit -m "feat(native): persist auto-generated titles to the log (claude persist:true parity)"
```

---

### Task 4: Selective listing scan + row cache

**Files:**
- Modify: `server/history-reader.ts` (export `SYNTHETIC_FRAME_PREFIX_RE` `:176`, `isInterruptPlaceholder` `:194`, `attachmentNameFallback` `:229` — add `export`, no body changes)
- Create: `server/providers/native-resumable-listing.ts` (HOST-side, OUTSIDE native/ — host-free pin precedent; imports core parsers + shared/host cleaners)
- Test: `server/providers/native-resumable-listing.test.ts` (new)

**Interfaces:**
- Consumes: `nativeSessionDir/nativeSessionLogPath` (`session-log/paths.ts`), `isSafeSessionId` (`shared/transcript-format.ts`), `parseHeaderLine` (`format.ts:686`), `parseEventLineV3(raw, expectedSeq, id, path)`, `parseEventLine(raw, expectedSeq, id, path, version)` + `migrateEventToV3`, `NATIVE_SESSION_LOG_V3`; cleaners `stripHandles` (`shared/attachment-handle.ts`), `condensePromptPreview` (`shared/prompt-preview.ts`), and the three newly-exported history-reader helpers.
- Produces:
  - `export interface NativeResumableRow { sessionId: string; cwd: string; createdAt: number; lastModified: number; title?: string; firstPrompt?: string; lastPrompt?: string }`
  - `export function listNativeResumableRows(stateDir: string, opts?: { dir?: string }): Promise<NativeResumableRow[]>` — per-row fail-soft (corrupt/unreadable → skip + warn), concurrency 16, `dir` = exact `cwd` match.
  - `export function readNativeResumableRow(stateDir: string, id: string): Promise<NativeResumableRow | undefined>` — missing → `undefined`; corrupt → THROW (adoption catches per provider).
  - `export function invalidateNativeResumableCache(id: string): void`

- [ ] **Step 1: Write the failing tests**

`resumable-listing.test.ts` (write fixture logs through the REAL writer — this pins the prefilter against actual serialization; test file lives at `server/providers/native-resumable-listing.test.ts`):
- enumeration: two session dirs → two rows with header `cwd`/`createdAt` + stat `lastModified`; junk skipped — a plain file, a non-id dir name (`../evil` style / `not a uuid`), an empty dir (Review Focus 5).
- previews: first/last eligible user text; `isCompactSummary` and sidechain (`parentToolUseId != null`) user events skipped; synthetic-prefix / interrupt-placeholder text skipped; attachment-only message → `attachmentNameFallback`.
- title: two `session/title` events → latest wins; none → `title` undefined.
- legacy: a v2 log (no title) enumerates with previews via migration.
- corrupt isolation: one log with a garbage line → `listNativeResumableRows` returns the OTHER rows; `readNativeResumableRow` on the corrupt id THROWS (Review Focus 3 variant).
- dir scope: `opts.dir` matching one row's cwd → only that row.
- cache: second call with unchanged stat → no re-read (spy on fs or count parses via a torn-tail growth: append a line, next call sees it; shrink → rescan).
- torn tail: append a half-line (no trailing `\n`) → scan ignores it, returns complete-line facts, does not throw (Review Focus 1).
- delete race: unlink a fixture log after enumeration starts (or between stat and read) → row skipped, no throw, NOT cached as absent (next call after re-creating the log sees it) (Review Focus 3).
- large log: ~2 MB fixture (many assistant events, few user/title) → correct row; scan streams (Review Focus 4 — asserted by correctness + the streaming implementation, no whole-file parse).
- invalidate: `invalidateNativeResumableCache(id)` forces a fresh read.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native-resumable-listing.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the scan**

Algorithm (the one part the signatures don't determine):
```
enumerate: readdir(native-sessions) → filter isSafeSessionId(dir) → stat(session.v1.jsonl)
per row (chunks of 16):
  cache hit on (size, mtimeMs) → cached row
  else stream lines (createReadStream + readline):
    seq = 0; pendingLast = undefined
    for each line:
      if line is the final line AND file does not end '\n' → drop (torn tail)
      prefilter: line includes '"type":"session/header"' | '"type":"user/message"'
                 | '"type":"session/title"' | '"type":"user"' (legacy)
      hit → JSON.parse + validated parse (header: parseHeaderLine;
            v3: parseEventLineV3(raw, seq, id, path);
            legacy: migrateEventToV3(parseEventLine(raw, seq, id, path, header.v)))
      non-hit → no parse
      seq++ on EVERY complete line (the validators check the seq chain)
      track: header facts; first/last eligible user text; latest title
  eligibility: type user/message, !isCompactSummary, parentToolUseId == null;
    join text blocks (neutral tool results are separate tool/result events —
    no tool_result filter needed); host cleaners: stripHandles →
    isInterruptPlaceholder / SYNTHETIC_FRAME_PREFIX_RE skip →
    condensePromptPreview; empty → attachmentNameFallback
  store row in LRU (cap 256, key `${stateDir}\0${id}`)
list: per-row catch → log.warn + skip; dir filter row.cwd === opts.dir
readNativeResumableRow: same scan, missing → undefined, corrupt → throw
```
Logger: `createLogger('native-resumable')`. No durable persistence.

- [ ] **Step 4: Run tests to verify they pass**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/history-reader.ts server/providers/native-resumable-listing.ts server/providers/native-resumable-listing.test.ts
git commit -m "feat(native): selective listing scan with stat-keyed row cache"
```

---

### Task 5: `NativeProvider.listResumable` + `getSessionInfo`

**Files:**
- Modify: `server/providers/native/native-provider.ts`
- Test: `server/providers/native/native-provider.test.ts`

**Interfaces:**
- Consumes: Task 4's `listNativeResumableRows` / `readNativeResumableRow` / `invalidateNativeResumableCache` from `../native-resumable-listing.js` (module lives OUTSIDE native/); `ResumableSession` (`server/session-types.ts:244`).
- Produces: `NativeProvider.listResumable(opts?: { dir?: string }): Promise<ResumableSession[]>` and `NativeProvider.getSessionInfo(id: string): Promise<ResumableSession | undefined>` — the manager's `listResumable` iteration and `adoptDiskSession` probe pick them up with ZERO manager code.

- [ ] **Step 1: Write the failing tests**

`native-provider.test.ts`:
- `listResumable()` over two fixture logs → rows mapped: `sessionId/cwd/createdAt/lastModified/firstPrompt/lastPrompt`, log title as **`title`** (assert `customTitle` is undefined), `known/running/terminated` all `false`, `provider` unset.
- `listResumable({ dir })` scopes.
- `getSessionInfo(id)`: existing log → row; missing → `undefined`; corrupt → rejects.
- `deleteTranscript(id)` invalidates the row cache (delete, re-create a log with the same id, `getSessionInfo` sees the NEW content).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/native-provider.test.ts`
Expected: FAIL — `provider.listResumable is not a function`.

- [ ] **Step 3: Implement**

```ts
async listResumable(opts?: ListResumableOptions): Promise<ResumableSession[]> {
  const rows = await listNativeResumableRows(this.stateDir, opts)
  return rows.map((row) => this.toResumable(row))
}
async getSessionInfo(id: string): Promise<ResumableSession | undefined> {
  const row = await readNativeResumableRow(this.stateDir, id)
  return row ? this.toResumable(row) : undefined
}
private toResumable(row: NativeResumableRow): ResumableSession {
  return { sessionId: row.sessionId, cwd: row.cwd, createdAt: row.createdAt,
    lastModified: row.lastModified, title: row.title, firstPrompt: row.firstPrompt,
    lastPrompt: row.lastPrompt, known: false, running: false, terminated: false }
}
```
In `deleteTranscript`: add `invalidateNativeResumableCache(id)` beside `nativeHistoryCache.invalidate(id)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-provider.ts server/providers/native/native-provider.test.ts
git commit -m "feat(native): listResumable and getSessionInfo for picker discovery and adoption"
```

---

### Task 6: Manager-path e2e — picker parity, delete recovery, adoption

**Files:**
- Test: `server/providers/native/e2e-persistence.test.ts` (existing fixture: `makeFixture`/`createAndSend`/`sendTurn`/`waitForPersistedTurn`)
- Test: `server/session-manager.test.ts` (SDK-mocked harness, `listResumable` describe ~`:8459`)

**Interfaces:**
- Consumes: Tasks 2/3/5 through the REAL `SessionManager` paths (`sm.listResumable`, `sm.rename`, `sm.autoGenerateTitle`, `sm.delete`, `sm.resume(id, { allowAdopt: true })`). No production code in this task.
- Produces: the acceptance proof (spec Acceptance 1–3, 2a).

- [ ] **Step 1: Write the failing tests**

`e2e-persistence.test.ts`:
- *picker parity*: `createAndSend` → `sm.listResumable()` contains the id, `known: true`, `provider: 'native'`.
- *manual-rename recovery*: `sm.rename(id, 'Renamed')` → `sm.delete(id)` (ordinary) → `listResumable` row `known: false`, `title: 'Renamed'` → `sm.resume(id, { allowAdopt: true })` → `store.get(id).provider === 'native'`, title `'Renamed'`, running.
- *auto-title recovery*: stub the aux port, `sm.autoGenerateTitle(id, 'desc')` → ordinary delete → picker row carries the auto title → adopt restores it.
- *permanent delete*: `sm.delete(id, { deleteTranscript: true })` → no picker row, `hasNativeSessionLog` false.
- *store-entry loss*: ordinary delete IS the entry-removal path; pin that a resume WITHOUT `allowAdopt` 404s while WITH it adopts (the automatic-path guard).
- *fork/clear title semantics* (spec Acceptance 6): rename the source → `sm.fork(id)` → the fork's log seed contains the source's `session/title` event; rename the fork → latest-wins yields the fork's title; `sm.clear(id)` → the source log keeps its title event, the replacement id has none.

`session-manager.test.ts` (`listResumable` describe):
- *mixed providers*: a live native session (`sm.create({ provider: 'native', … })`) + `mockListSessions` claude row → `sm.listResumable()` returns both, each with its own `provider`, no cross-annotation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/e2e-persistence.test.ts server/session-manager.test.ts -t "resumable"`
Expected: the new e2e tests FAIL (native rows absent from `listResumable` before Task 5 — if Tasks 1–5 are complete they may pass immediately; in that case verify each assertion is load-bearing by temporarily reverting the relevant provider method and watching it fail, then restore). The mixed-provider test fails on the missing native row.

- [ ] **Step 3: No production code — fix any test-harness issues only**

If a test fails for a harness reason (fixture timing, aux-port stub shape), fix the test. If it fails for a production reason, STOP and fix the owning task's code with a unit test first.

- [ ] **Step 4: Run tests to verify they pass**

Run: the Step 2 command, then `npx vitest run server/providers/native/e2e-persistence.test.ts server/session-manager.test.ts` (full files). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/e2e-persistence.test.ts server/session-manager.test.ts
git commit -m "test(native): picker parity and delete-recovery e2e through SessionManager"
```

---

### Task 7: Client provider-aware badge

**Files:**
- Modify: `src/components/session-list/ResumeSessionDialog.tsx:263`
- Test: `src/components/session-list/ResumeSessionDialog.test.tsx`

**Interfaces:**
- Consumes: `ResumableSession.provider` (client `src/types.ts:62` shape; the manager always sets it on picker rows).
- Produces: unknown-row badge text — `native` for native rows, `CLI` for claude rows (unchanged wording).

- [ ] **Step 1: Write the failing test**

`ResumeSessionDialog.test.tsx` (existing file, follow its api-mock pattern): mock `GET /sessions/resumable` with two unknown rows (`known: false`, `terminated: false`), `provider: 'native'` and `provider: 'claude'` → the native row renders badge text `native`, the claude row renders `CLI`; a known row renders neither.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/session-list/ResumeSessionDialog.test.tsx`
Expected: FAIL — native row shows `CLI`.

- [ ] **Step 3: Implement**

Replace the badge line:
```tsx
{!s.known && !s.terminated && (
  <span className="resume-badge">{s.provider === 'native' ? 'native' : 'CLI'}</span>
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/session-list/ResumeSessionDialog.tsx src/components/session-list/ResumeSessionDialog.test.tsx
git commit -m "feat(client): provider-aware badge for unknown resumable rows"
```

---

### Task 8: Agent note + full verification + review

**Files:**
- Create: `.agents/notes/implemented/feature/2026-11-25-native-resumable-discovery.md`
- Modify: `CLAUDE.md` (native provider paragraph — one sentence: native implements `listResumable`/`getSessionInfo`/`renameSession`; `session/title` log event; picker recovery parity)

**Interfaces:**
- Consumes: the shipped Tasks 1–7.
- Produces: the decision record + green verification gates.

- [ ] **Step 1: Write the agent note**

Format per `.agents/notes/README.md` (`# Agent Note: …` / `Status: implemented` / `## Problem` …). Record: the recoverable-delete contract; `session/title` DSH-parity semantics (latest-wins, log-only, fork inheritance, no clear mirroring); auto-title provider-side persist with the log-level no-overwrite guard; selective scan + in-memory row cache; rejected alternatives (sidecar, full-parse cache enumeration, DSH projection machinery — with the revisit trigger) and the D1–D5 calls. Cross-link the spec and the provider-seam neutralization note with relative Markdown links.

- [ ] **Step 2: Run the verification gates**

Run: `npm run verify:agent-notes && npm run typecheck && npm run lint`
Expected: all PASS (lint: 0 errors; pre-existing src warnings unchanged).
Run: `npm run test` (full suite, no pipe that swallows the exit code)
Expected: PASS. Any failure: attribute it (this diff vs concurrent worktree edits vs load flake), re-run the failing file isolated, and report by name — do not claim green on a red run.

- [ ] **Step 3: Code review**

Run the `code-review` skill on the full diff (commit range from before Task 1). Verify each finding against the code; fix confirmed issues with a failing test first; re-review non-trivial fixes.

- [ ] **Step 4: Commit**

```bash
git add .agents/notes/implemented/feature/2026-11-25-native-resumable-discovery.md CLAUDE.md
git commit -m "docs(native): resumable discovery decision record"
```