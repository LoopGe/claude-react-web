# Native Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native provider a DSH-style append-only session event log so native sessions survive restart, resume, page/search history, fork, support side chats, and delete — with the same client wire contract as claude sessions.

**Architecture:** A provider-owned JSONL event log under the existing state dir is the single source of truth. The log stores SDK-shaped durable events plus native markers; readers reuse `history-reader`'s `normalize` / `sliceWindow` / `paginateRenderable`, so history paging, search, recap, and side-chat boundaries work unchanged. `NativeSession` writes through the log, rebuilds model history on resume, repairs interrupted turns, and forks by copying an exact event prefix.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), Node 20 `fs` / `crypto`, vitest (Node env), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-09-native-session-persistence-design.md`

## Global Constraints

- All new files live under `server/providers/native/session-log/`, except the explicit modifications listed in Tasks 6–9.
- No changes to `server/providers/claude/**`, `server/history-reader.ts`, or `server/jsonl-cache.ts` behavior.
- Imports use the `.js` suffix; no bare `console.*` (use `createLogger('native')`).
- Node 20 only: no `zstd`, no new packages.
- Log format is version 1; unknown versions and committed-prefix corruption fail closed. Never silently truncate committed events.
- Every test command in this plan runs from the repo root. One file: `npx vitest run <file>`. Full gate: `npm run typecheck && npm run test`.
- Commit only the files named in the task.
- The claude provider remains the default and untouched.

## Review Focus

1. **Torn final line after a crash:** committed events must survive, the incomplete line is discarded, and the next append works.
2. **Queued-but-unconsumed user turn:** a prompt enqueued while a turn is running must not appear in the log or model history after restart.
3. **Side-chat inherited prefix:** `afterUuid` must hide the parent prefix from paging, search, and the resume seed while the model still receives it.
4. **Corrupt / unknown-version log:** must fail loudly during load; `hasTranscript` must not swallow it into a silent empty resume.
5. **Fork cwd change:** a fork of a worktree-isolated session runs in a different cwd; the child must get a fresh working-directory context.
6. **Same-id writer replacement:** `spawn()` creates the new handle before destroying the old one; the old writer must not append after takeover.

Each line has a test in the task that owns the behavior.

---

### Task 1: Log format, paths and errors

**Files:**
- Create: `server/providers/native/session-log/errors.ts`
- Create: `server/providers/native/session-log/paths.ts`
- Create: `server/providers/native/session-log/format.ts`
- Test: `server/providers/native/session-log/format.test.ts`
- Test: `server/providers/native/session-log/paths.test.ts`

**Interfaces:**
- Consumes: `isSafeSessionId` from `../../../history-reader.js`, `DEFAULT_DIR_NAME` from `../../../json-file-store.js`, `homedir` from `node:os`.
- Produces:
  - `class NativeSessionStorageError extends Error { readonly kind: 'corrupt' | 'unsupported-version' | 'exists' | 'missing' | 'fork-boundary'; readonly sessionId: string; readonly path: string }`
  - `resolveNativeStateDir(stateDir?: string): string`
  - `nativeSessionDir(stateDir: string, id: string): string`
  - `nativeSessionLogPath(stateDir: string, id: string): string`
  - `NATIVE_SESSION_LOG_VERSION = 1`
  - `interface NativeSessionHeader { type: 'session/header'; v: number; id: string; cwd: string; createdAt: number; isSeeded: boolean; inheritedEventCount: number }`
  - `type NativeTurnEndReason = 'completed' | 'interrupted' | 'error' | 'forked'`
  - `interface NativeUsage { input_tokens: number; output_tokens: number }`
  - `interface NativeUserEvent { seq: number; type: 'user'; uuid: string; session_id: string; parent_tool_use_id: null; timestamp: string; message: { role: 'user'; content: unknown[] }; isCompactSummary?: true }`
  - `interface NativeAssistantEvent { seq: number; type: 'assistant'; uuid: string; session_id: string; parent_tool_use_id: null; timestamp: string; message: { role: 'assistant'; content: unknown[]; id?: string; model?: string; stop_reason?: string | null; usage?: unknown } }`
  - `interface NativeContextEvent { seq: number; type: 'session/context'; text: string }`
  - `interface NativeTurnEndEvent { seq: number; type: 'turn/end'; reason: NativeTurnEndReason; usage?: NativeUsage }`
  - `interface NativeSeedEndEvent { seq: number; type: 'session/end-seed' }`
  - `type NativeLogEvent = NativeUserEvent | NativeAssistantEvent | NativeContextEvent | NativeTurnEndEvent | NativeSeedEndEvent`
  - `type NativeEventInput = Omit<NativeUserEvent,'seq'> | Omit<NativeAssistantEvent,'seq'> | Omit<NativeContextEvent,'seq'> | Omit<NativeTurnEndEvent,'seq'> | Omit<NativeSeedEndEvent,'seq'>`
  - `parseHeaderLine(raw: unknown, sessionId: string, path: string): NativeSessionHeader` — throws `NativeSessionStorageError` for a missing/invalid header or `v !== 1` (`kind: 'unsupported-version'`).
  - `parseEventLine(raw: unknown, expectedSeq: number, sessionId: string, path: string): NativeLogEvent` — throws `corrupt` on unknown type, `seq` mismatch, or missing required fields.
  - `serializeHeader(header: NativeSessionHeader): string` and `serializeEvent(event: NativeLogEvent): string` — return one JSON line without the trailing newline.

- [ ] **Step 1: Write the failing tests**

```ts
// format.test.ts
import { describe, expect, it } from 'vitest'
import { NATIVE_SESSION_LOG_VERSION, parseEventLine, parseHeaderLine, serializeEvent, serializeHeader } from './format.js'
import { NativeSessionStorageError } from './errors.js'

const header = { type: 'session/header', v: 1, id: 's1', cwd: '/repo', createdAt: 1, isSeeded: false, inheritedEventCount: 0 } as const

describe('session log format', () => {
  it('round-trips the header', () => {
    expect(parseHeaderLine(JSON.parse(serializeHeader(header)), 's1', 'p')).toEqual(header)
  })
  it('rejects an unknown version', () => {
    expect(() => parseHeaderLine({ ...header, v: 2 }, 's1', 'p')).toThrow(NativeSessionStorageError)
    try { parseHeaderLine({ ...header, v: 2 }, 's1', 'p') } catch (e) {
      expect((e as NativeSessionStorageError).kind).toBe('unsupported-version')
    }
  })
  it('accepts each known event and enforces contiguous seq', () => {
    const events = [
      { seq: 0, type: 'user', uuid: 'u', session_id: 's1', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [] } },
      { seq: 1, type: 'assistant', uuid: 'a', session_id: 's1', parent_tool_use_id: null, timestamp: 't', message: { id: 'msg_1', model: 'm', role: 'assistant', content: [] } },
      { seq: 2, type: 'session/context', text: 'ctx' },
      { seq: 3, type: 'turn/end', reason: 'completed' },
      { seq: 4, type: 'session/end-seed' },
    ]
    for (const [i, e] of events.entries()) {
      expect(parseEventLine(e, i, 's1', 'p')).toEqual(e)
      expect(JSON.parse(serializeEvent(e as never))).toEqual(e)
    }
    // Assistant identity/model fields survive the round-trip (downstream
    // dedupe and resume-model recovery read them).
    const parsedAssistant = parseEventLine(events[1], 1, 's1', 'p') as { message: { id?: string; model?: string } }
    expect(parsedAssistant.message).toMatchObject({ id: 'msg_1', model: 'm' })
    expect(() => parseEventLine(events[1], 0, 's1', 'p')).toThrow(/seq/)
  })
  it('rejects an unknown event type', () => {
    expect(() => parseEventLine({ seq: 0, type: 'mystery' }, 0, 's1', 'p')).toThrow(NativeSessionStorageError)
  })
  it('rejects a user event without a timestamp', () => {
    expect(() => parseEventLine({ seq: 0, type: 'user', uuid: 'u', session_id: 's1', parent_tool_use_id: null, message: { role: 'user', content: [] } }, 0, 's1', 'p')).toThrow(/timestamp/)
  })
})
```

```ts
// paths.test.ts
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativeSessionDir, nativeSessionLogPath, resolveNativeStateDir } from './paths.js'

describe('native session paths', () => {
  it('places the log under <stateDir>/native-sessions/<id>/session.v1.jsonl', () => {
    expect(nativeSessionLogPath('/state', 'abc')).toBe(join('/state', 'native-sessions', 'abc', 'session.v1.jsonl'))
    expect(nativeSessionDir('/state', 'abc')).toBe(join('/state', 'native-sessions', 'abc'))
  })
  it('rejects traversal ids', () => {
    expect(() => nativeSessionDir('/state', '../x')).toThrow(/Invalid session id/)
  })
  it('defaults to the app state dir', () => {
    expect(resolveNativeStateDir()).toMatch(/\.claude-react-web$/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/session-log/format.test.ts server/providers/native/session-log/paths.test.ts`
Expected: FAIL — cannot resolve `./format.js` / `./paths.js`.

- [ ] **Step 3: Implement the modules**

- `errors.ts`: the class with `name = 'NativeSessionStorageError'` and the four public fields; pass the message through to `super`.
- `paths.ts`: `resolveNativeStateDir` = `stateDir ?? join(homedir(), DEFAULT_DIR_NAME)`; `nativeSessionDir` validates `isSafeSessionId(id)` and returns `join(stateDir, 'native-sessions', id)`; log path adds `session.v1.jsonl`.
- `format.ts`: the types above plus validators. Validate `type`, `seq`, and per-type required fields (`uuid`, `session_id`, `parent_tool_use_id === null`, `timestamp`, `message` for user/assistant; `text` for context; `reason` in the enum for turn/end). **Preserve the raw `message` object after validation** — do not rebuild it and drop fields such as `id` / `model`; downstream assistant-dedupe and resume-model recovery read them. `serialize*` = `JSON.stringify` (no newline).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/session-log/format.test.ts server/providers/native/session-log/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/session-log/errors.ts server/providers/native/session-log/paths.ts server/providers/native/session-log/format.ts server/providers/native/session-log/format.test.ts server/providers/native/session-log/paths.test.ts
git commit -m "feat(native): session log format, validation and paths"
```

---

### Task 2: Append-only session log writer

**Files:**
- Create: `server/providers/native/session-log/log.ts`
- Test: `server/providers/native/session-log/log.test.ts`

**Interfaces:**
- Consumes: Task 1 types/validators, `nativeSessionDir` / `nativeSessionLogPath`.
- Produces:
  - `interface NativeSessionLogSnapshot { header: NativeSessionHeader; events: NativeLogEvent[]; path: string; completeBytes: number }`
  - `loadNativeSessionLogSync(stateDir: string, id: string): NativeSessionLogSnapshot | null` — returns null when the file is absent; ignores an incomplete final line; throws `NativeSessionStorageError` on committed-prefix corruption / unknown version.
  - `loadNativeSessionLog(stateDir: string, id: string): Promise<NativeSessionLogSnapshot | null>` — async wrapper (`readFile`) used by readers.
  - `hasNativeSessionLog(stateDir: string, id: string): Promise<boolean>` — existence only (`stat`, no parse).
  - `deleteNativeSessionLog(stateDir: string, id: string): Promise<boolean>` — `rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })`; true when the directory existed.
  - `interface NativeSeed { events: NativeLogEvent[]; inheritedEventCount: number; isSeeded: boolean }`
  - `interface OpenNativeSessionLogOptions { stateDir: string; id: string; cwd: string; resume: boolean; seed?: NativeSeed }`
  - `class NativeSessionLog`:
    - `static open(opts: OpenNativeSessionLogOptions): NativeSessionLog` — synchronous. `resume:true` loads and truncates a torn tail; `seed` creates a new file with a seeded header; fresh creates an empty file. Existing file without `resume`/`seed` → `kind: 'exists'`.
    - `readonly header: NativeSessionHeader`, `readonly events: NativeLogEvent[]`, `readonly path: string`
    - `append(input: NativeEventInput): NativeLogEvent` — assigns the next `seq`, buffers the serialized line, returns the event. No-op on a superseded writer (still returns the event).
    - `flush(): Promise<void>` — writes buffered lines and `fsync`s.
    - `close(): Promise<void>` — flush + close; idempotent.

- [ ] **Step 1: Write the failing tests**

```ts
// log.test.ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeSessionLog, deleteNativeSessionLog, hasNativeSessionLog, loadNativeSessionLogSync } from './log.js'
import { nativeSessionDir, nativeSessionLogPath } from './paths.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
const fresh = async () => { dir = await mkdtemp(join(tmpdir(), 'native-log-')); return dir }

const userEvent = (uuid: string) => ({ type: 'user' as const, uuid, session_id: 's1', parent_tool_use_id: null as null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] } })

describe('NativeSessionLog', () => {
  it('creates, appends, reloads in order and survives a torn tail', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1'))
    log.append({ type: 'turn/end', reason: 'completed' })
    await log.flush()
    await log.close()
    await writeFile(nativeSessionLogPath(stateDir, 's1'), '{"seq":2,"type":"assi', { flag: 'a' })
    const snapped = loadNativeSessionLogSync(stateDir, 's1')!
    expect(snapped.events.map((e) => e.type)).toEqual(['user', 'turn/end'])
    const reopened = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: true })
    reopened.append({ type: 'session/end-seed' })
    await reopened.flush()
    expect(loadNativeSessionLogSync(stateDir, 's1')!.events.map((e) => e.seq)).toEqual([0, 1, 2])
    await reopened.close()
  })
  it('refuses a fresh open over an existing log', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1')); await log.flush(); await log.close()
    expect(() => NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })).toThrow(/exists/)
  })
  it('takes over the writer: committed lines survive, post-takeover appends do not', async () => {
    const stateDir = await fresh()
    const a = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    a.append(userEvent('u1'))
    await a.flush()
    const b = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: true })
    a.append(userEvent('stale'))
    b.append({ type: 'session/end-seed' })
    await b.flush()
    expect(loadNativeSessionLogSync(stateDir, 's1')!.events.map((e) => e.type)).toEqual(['user', 'session/end-seed'])
    await a.close(); await b.close()
  })
  it('reports existence without parsing and deletes the directory', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1')); await log.flush(); await log.close()
    expect(await hasNativeSessionLog(stateDir, 's1')).toBe(true)
    expect(await deleteNativeSessionLog(stateDir, 's1')).toBe(true)
    expect(await hasNativeSessionLog(stateDir, 's1')).toBe(false)
  })
  it('rejects an unknown version on load', async () => {
    const stateDir = await fresh()
    const log = NativeSessionLog.open({ stateDir, id: 's1', cwd: '/repo', resume: false })
    log.append(userEvent('u1')); await log.flush(); await log.close()
    const path = nativeSessionLogPath(stateDir, 's1')
    const lines = (await readFile(path, 'utf8')).split('\n')
    lines[0] = lines[0].replace('"v":1', '"v":2')
    await writeFile(path, lines.join('\n'))
    expect(() => loadNativeSessionLogSync(stateDir, 's1')).toThrow(/unsupported|version/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/session-log/log.test.ts`
Expected: FAIL — cannot resolve `./log.js`.

- [ ] **Step 3: Implement `NativeSessionLog`**

- Module-level `const writers = new Map<string, NativeSessionLog>()`. `open` marks any existing writer superseded before registering the new one; `close` removes the map entry only when it still points at this log.
- `open` uses `readFileSync` for resume, `truncateSync` when `statSync(path).size > completeBytes`, and `writeFileSync(..., { flag: 'wx' })` for create/seed. Catch `EEXIST` → `NativeSessionStorageError('exists')`.
- `append` assigns `seq = events.length`, pushes to `events`, and pushes `serializeEvent(...) + '\n'` to `pending` unless superseded.
- `flush` lazily `await open(path, 'a')` (keep the `FileHandle`), writes `pending.join('')`, clears it, then `await handle.sync()`. Serialize flushes with a `Promise` chain so concurrent calls cannot interleave.
- On resume, a torn final line is everything after the last `\n`; ignore it on load and truncate it before the first new append.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/session-log/log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/session-log/log.ts server/providers/native/session-log/log.test.ts
git commit -m "feat(native): append-only session log with torn-tail recovery and writer takeover"
```

---

### Task 3: Replay events into model history and repair interrupted turns

**Files:**
- Create: `server/providers/native/session-log/replay.ts`
- Test: `server/providers/native/session-log/replay.test.ts`

**Interfaces:**
- Consumes: Task 1 event types; `RawLine` shape from `history-reader` (structurally).
- Produces:
  - `historyFromEvents(events: readonly NativeLogEvent[]): unknown[]` — returns the Anthropic-shaped `messages` array. Context events become user text messages; assistant/user events keep their `message.content`; thinking/redacted_thinking blocks are stripped from assistant content; native markers are skipped; **consecutive tool_result user events are merged into one user message** (the API requires one user message carrying all tool_result blocks for an assistant turn).
  - `interface RepairResult { synthetic: Omit<NativeUserEvent, 'seq'>[] }` — synthetic events carry no `seq`; the caller (the log append or the fork seed builder) assigns it.
  - `repairInterruptedTurn(events: readonly NativeLogEvent[], opts?: { now?: () => Date }): RepairResult` — scans for `tool_use` ids in assistant events that have no matching `tool_result`, and returns one synthetic `user` event per unanswered id with `is_error: true` content `[{ type: 'text', text: 'tool result missing (session interrupted)' }]`; returns `[]` when nothing is open.
  - `repairRenderableLines(lines: readonly RawLine[], opts?: { now?: () => Date }): RawLine[]` — the same scan over reader raw lines, returning synthetic user tool_result lines (with `uuid`, `timestamp`, `session_id`, `parent_tool_use_id: null`).
  - `contextSnapshot(cwd: string): string` — moved here from `native-session.ts`; fresh/resume/fork all use the same `<system-reminder>Working directory: …</system-reminder>` format.

- [ ] **Step 1: Write the failing tests**

```ts
// replay.test.ts
import { describe, expect, it } from 'vitest'
import { historyFromEvents, repairInterruptedTurn } from './replay.js'
import type { NativeLogEvent } from './format.js'

const lost = { seq: 0, type: 'session/context', text: 'ctx' } as const
const user = (seq: number, text: string): NativeLogEvent => ({ seq, type: 'user', uuid: `u${seq}`, session_id: 's', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text }] } })
const assistant = (seq: number, content: unknown[]): NativeLogEvent => ({ seq, type: 'assistant', uuid: `a${seq}`, session_id: 's', parent_tool_use_id: null, timestamp: 't', message: { role: 'assistant', content } })
const result = (seq: number, id: string): NativeLogEvent => ({ seq, type: 'user', uuid: `r${seq}`, session_id: 's', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }], is_error: false }] } })

describe('replay', () => {
  it('rebuilds history, strips thinking and merges consecutive tool results', () => {
    const events = [
      lost, user(1, 'hi'),
      assistant(2, [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'calling' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
      result(3, 't1'), result(4, 't2'),
      assistant(5, [{ type: 'text', text: 'done' }]),
      { seq: 6, type: 'turn/end', reason: 'completed' } as const,
    ]
    const messages = historyFromEvents(events) as Array<{ role: string; content: unknown[] }>
    expect(messages).toHaveLength(5) // ctx, user, assistant, merged tool results, assistant
    expect(messages[2].content.some((b) => (b as { type: string }).type === 'thinking')).toBe(false)
    expect(messages[3].content).toHaveLength(2)
  })
  it('synthesizes a result for every unanswered tool_use', () => {
    const events = [user(0, 'go'), assistant(1, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }])]
    const { synthetic } = repairInterruptedTurn(events)
    expect(synthetic.map((e) => (e as { message: { content: Array<{ tool_use_id: string }> } }).message.content[0].tool_use_id)).toEqual(['t1', 't2'])
  })
  it('returns no synthetic events for a complete turn', () => {
    expect(repairInterruptedTurn([user(0, 'go'), assistant(1, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]), result(2, 't1')]).synthetic).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/session-log/replay.test.ts`
Expected: FAIL — cannot resolve `./replay.js`.

- [ ] **Step 3: Implement `replay.ts`**

- Walk events in order; collect `tool_use` ids from assistant content and remove ids answered by any `tool_result` block found in user content.
- `historyFromEvents`: build `{ role, content }` entries. Group a run of user events whose first content block is `tool_result` into one message by concatenating their blocks. Strip `thinking` / `redacted_thinking` from assistant content before pushing.
- `repairInterruptedTurn` / `repairRenderableLines`: use the same unanswered-id scan; the synthetic timestamp is `opts.now?.() ?? new Date()` converted with `.toISOString()`, uuid via `crypto.randomUUID()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/session-log/replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/session-log/replay.ts server/providers/native/session-log/replay.test.ts
git commit -m "feat(native): replay session events into model history with interrupted-turn repair"
```

---

### Task 4: History reader and cache

**Files:**
- Create: `server/providers/native/session-log/cache.ts`
- Create: `server/providers/native/session-log/reader.ts`
- Test: `server/providers/native/session-log/reader.test.ts`

**Interfaces:**
- Consumes: Task 1 event types, Task 2 `loadNativeSessionLog`, Task 3 `repairRenderableLines`; `HistoryEntry`, `HistoryPage`, `normalize`, `paginateRenderable`, `isRenderableSdkMessage` from `../../../history-reader.js` / `../../../history-utils.js`.
- Produces:
  - `interface NativeHistoryCache { load(stateDir: string, id: string): Promise<{ lines: RawLine[]; size: number; mtimeMs: number } | null>; invalidate(id: string): void }`
  - `const nativeHistoryCache: NativeHistoryCache` — LRU 4, freshness key `(size, mtimeMs)`, incremental parse of appended complete lines, full reparse on shrink/replace. Stores **renderable raw lines only**; incomplete final line stays unparsed.
  - `readNativeHistoryEntries(stateDir: string, id: string, opts?: { afterUuid?: string }): Promise<HistoryEntry[]>` — missing log → `[]`; applies the boundary and interrupted-turn repair in memory; `message: normalize(line, id, false)`.
  - `readNativeHistoryPage(stateDir: string, id: string, opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string }): Promise<HistoryPage>` — missing log → `{ messages: [], totalCount: 0, startIndex: 0, hasMore: false }`; filters through `afterUuid` first (drop the boundary line and everything before it, mirroring `parseRenderable`), then `paginateRenderable(lines, id, opts)`.

- [ ] **Step 1: Write the failing tests**

```ts
// reader.test.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeSessionLog } from './log.js'
import { nativeHistoryCache } from './cache.js'
import { readNativeHistoryEntries, readNativeHistoryPage } from './reader.js'

let dir: string
afterEach(async () => { if (dir) { nativeHistoryCache.invalidate('s1'); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } })
async function seedLog() {
  dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
  const log = NativeSessionLog.open({ stateDir: dir, id: 's1', cwd: '/repo', resume: false })
  const push = (e: never) => log.append(e)
  push({ type: 'session/context', text: 'ctx' } as never)
  push({ type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } } as never)
  push({ type: 'assistant', uuid: 'a1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } } as never)
  push({ type: 'user', uuid: 'u2', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'three' }] } } as never)
  await log.flush(); await log.close()
}

describe('native history reader', () => {
  it('pages newest-first with the shared window semantics', async () => {
    await seedLog()
    const page = await readNativeHistoryPage(dir, 's1', { limit: 2 })
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['a1', 'u2'])
    expect(page.totalCount).toBe(3)
    expect(page.startIndex).toBe(1)
    expect(page.hasMore).toBe(true)
    const older = await readNativeHistoryPage(dir, 's1', { before: page.startIndex, limit: 2 })
    expect((older.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u1'])
  })
  it('hides the inherited prefix after afterUuid', async () => {
    await seedLog()
    const page = await readNativeHistoryPage(dir, 's1', { limit: 10, afterUuid: 'a1' })
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u2'])
    expect(page.totalCount).toBe(1)
  })
  it('returns entries with normalized timestamps and tool_result parents', async () => {
    await seedLog()
    const entries = await readNativeHistoryEntries(dir, 's1')
    expect(entries.map((e) => (e.message as { uuid: string }).uuid)).toEqual(['u1', 'a1', 'u2'])
    expect((entries[0].message as { receivedAt?: number }).receivedAt).toBe(Date.parse('2026-11-09T00:00:00.000Z'))
  })
  it('returns an empty page for a missing log', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-reader-'))
    expect(await readNativeHistoryPage(dir, 'nope', { limit: 10 })).toEqual({ messages: [], totalCount: 0, startIndex: 0, hasMore: false })
    expect(await readNativeHistoryEntries(dir, 'nope')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/session-log/reader.test.ts`
Expected: FAIL — cannot resolve `./reader.js`.

- [ ] **Step 3: Implement `cache.ts` and `reader.ts`**

- `cache.ts`: mirror `jsonl-cache`'s freshness/incremental logic, but parse a byte offset, call the log's serializer format? Simpler: `readFile` the whole file when `(size, mtimeMs)` changes, split by `\n`, drop the last segment when the file does not end with `\n`, `JSON.parse` each line, keep lines where `isRenderableSdkMessage(parsed)` is true. Cache per id; LRU 4 by Map insertion order. For growth, re-read the whole file (the spec allows; incremental is a later optimization) — but the spec says incremental. Implement incremental: keep `parsedChars` and parse the appended suffix after the last `\n`; on shrink/replace, full reparse.
- `reader.ts`: `load` via cache; `null` → empty; `repairRenderableLines`; `filterAfterUuid` (mirror `parseRenderable`: `past = !afterUuid`; for each line, if not past and uuid matches → past = true; `continue`; include only when past). For entries, `normalize(line, id, false)`; for pages, `paginateRenderable(filtered, id, opts)`. Invalidate the cache in `NativeProvider.deleteTranscript`, not here.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/session-log/reader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/session-log/cache.ts server/providers/native/session-log/reader.ts server/providers/native/session-log/reader.test.ts
git commit -m "feat(native): native session history reader with paging and side-chat boundary"
```

---

### Task 5: Fork seed builder

**Files:**
- Create: `server/providers/native/session-log/fork.ts`
- Test: `server/providers/native/session-log/fork.test.ts`

**Interfaces:**
- Consumes: Task 1 event types, Task 2 `NativeSessionLogSnapshot`, Task 3 `repairInterruptedTurn`.
- Produces:
  - `interface BuildForkSeedOptions { source: NativeSessionLogSnapshot; sourceId: string; newId: string; cwd: string; resumeSessionAt?: string; now?: () => Date }`
  - `interface NativeForkSeed { events: NativeLogEvent[]; inheritedEventCount: number; isSeeded: true }`
  - `buildForkSeed(opts: BuildForkSeedOptions): NativeForkSeed` — copies the source prefix through `resumeSessionAt` (inclusive; throws `NativeSessionStorageError` with `kind: 'fork-boundary'` when the uuid is absent), renumbers `seq` from 0, appends `session/end-seed`, appends synthetic error tool_results for an open turn, appends `turn/end { reason: 'forked' }`, then appends a child `session/context` event carrying `cwd`. `inheritedEventCount` is the copied-prefix length only.

- [ ] **Step 1: Write the failing test**

```ts
// fork.test.ts
import { describe, expect, it } from 'vitest'
import { buildForkSeed } from './fork.js'
import type { NativeLogEvent } from './format.js'

const source = {
  header: { type: 'session/header', v: 1, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
  events: [
    { seq: 0, type: 'session/context', text: 'ctx' },
    { seq: 1, type: 'user', uuid: 'u1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { seq: 2, type: 'assistant', uuid: 'a1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
  ],
  path: '/p', completeBytes: 0,
} as never

describe('buildForkSeed', () => {
  it('cuts inclusively, marks the seed and repairs the open turn', () => {
    const seed = buildForkSeed({ source, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'a1' })
    expect(seed.isSeeded).toBe(true)
    expect(seed.inheritedEventCount).toBe(3)
    expect(seed.events.slice(0, 3).map((e) => e.seq)).toEqual([0, 1, 2])
    expect(seed.events.some((e) => e.type === 'session/end-seed')).toBe(true)
    expect(seed.events.some((e) => e.type === 'turn/end' && e.reason === 'forked')).toBe(true)
    expect(seed.events.filter((e) => e.type === 'user' && JSON.stringify(e.message).includes('tool_result'))).toHaveLength(1)
    const context = seed.events.filter((e) => e.type === 'session/context')
    expect(context.map((e) => (e as { text: string }).text)).toEqual(['ctx', expect.stringContaining('/new')])
  })
  it('copies the full prefix when no boundary is given', () => {
    expect(buildForkSeed({ source, sourceId: 'src', newId: 'dst', cwd: '/new' }).inheritedEventCount).toBe(3)
  })
  it('rejects an unknown boundary uuid', () => {
    expect(() => buildForkSeed({ source, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'nope' })).toThrow(/fork boundary/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/session-log/fork.test.ts`
Expected: FAIL — cannot resolve `./fork.js`.

- [ ] **Step 3: Implement `fork.ts`**

- Find the cut index (`events.findIndex(e => 'uuid' in e && e.uuid === resumeSessionAt)`); throw `kind: 'fork-boundary'` when absent.
- Map the prefix to new objects with `seq: index`.
- Append `session/end-seed`, then call `repairInterruptedTurn(prefix)` and append each synthetic event with the next seq, then `turn/end { reason: 'forked' }`, then `session/context { text: contextSnapshot(cwd) }`. Export `contextSnapshot(cwd)` from `replay.ts` (move the current helper there) so fresh/resume/fork share one format.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/session-log/fork.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/session-log/fork.ts server/providers/native/session-log/fork.test.ts
git commit -m "feat(native): fork seed with inherited boundary and interrupted-turn closers"
```

---

### Task 6: Persist and resume inside `NativeSession`

**Files:**
- Modify: `server/providers/native/native-session.ts`
- Modify: `server/providers/native/native-provider.ts` (minimal: accept `{ stateDir?: string }`, resolve it, and thread `stateDir` / `resume` / `forkSession` / `resumeSessionAt` into `NativeSessionOptions`. Readers/hasTranscript/deleteTranscript/capabilities stay in Task 7.)
- Test: `server/providers/native/native-session.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `NativeSessionOptions` gains `stateDir: string`, `resume?: string`, `forkSession?: boolean`, `resumeSessionAt?: string`.
  - A private `log: NativeSessionLog`, a private `receivedAt: WeakMap<AgentUserMessage, number>`, and a private `persistFrame(frame: AgentMessage): void`.
  - Fresh constructor: open a fresh log, append `session/context { text: contextSnapshot(cwd) }`, history starts with that user message, fire-and-forget `flush()`.
  - Resume: open with `resume: true`, run `repairInterruptedTurn(log.events)`, append the synthetic events durably, `history = historyFromEvents([...log.events, ...synthetic])`, restore `lastUsage` / `totalUsage` from the last `turn/end.usage`.
  - Fork (`forkSession && resume`): load the source sync, `buildForkSeed`, open the new log with the seed, `history = historyFromEvents(seed.events)`.
  - `enqueueUserMessage`: record `Date.now()` in the WeakMap before queueing.
  - `pumpLoop`: before `runTurn`, append the user event (`timestamp` from the WeakMap) and `flush`; after success/error, append `turn/end` (`completed` / `interrupted` / `error`) with usage and `flush`.
  - `emit` wrapper persists `assistant` frames and top-level `user` (tool_result) frames; it does **not** persist `stream_event`, `system/init`, `result`, or `api_retry`.
  - `sendControlMessage`: append a compact-summary user event (`isCompactSummary: true`) and flush, in addition to pushing into history.
  - `destroy`: `await log.close()`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to native-session.test.ts
it('persists a turn and resumes it with model history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-persist-'))
  const provider = new NativeProvider({ stateDir: dir })
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* () { for (const ev of textTurn('hello')) yield ev }
  const first = provider.createSession({ id: 's1', cwd: dir })
  ;(async () => { for await (const _ of first.messages) { /* drain */ } })()
  first.enqueueUserMessage(userMsg('hi') as never)
  await vi.waitFor(() => {
    const log = (first as unknown as { log: { events: Array<{ type: string }> } }).log
    expect(log.events.some((e) => e.type === 'turn/end')).toBe(true)
  })
  await first.destroy()

  ;(provider as unknown as { _testStream: unknown })._testStream = async function* () { for (const ev of textTurn('again')) yield ev }
  const resumed = provider.createSession({ id: 's1', cwd: dir, resume: 's1' })
  const frames = []
  ;(async () => { for await (const f of resumed.messages) frames.push(f) })()
  expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' })
  expect((resumed as unknown as { history: Array<{ role: string }> }).history[0].role).toBe('user')
  resumed.enqueueUserMessage(userMsg('next') as never)
  await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'again')).toBe(true))
  await resumed.destroy()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
```

Also add: `it('does not persist a queued turn that is never consumed')`, `it('repairs an interrupted tool turn on resume')`, `it('forks from the source log and writes a seeded child log')`, `it('persists the compact control seed')`, `it('refuses to resume a corrupt log')` — the last one writes a valid log, rewrites the header line to `"v":2`, and expects `provider.createSession({ id, cwd, resume: id })` to throw the version error synchronously. Use the existing `textTurn` / `userMsg` helpers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/native-session.test.ts`
Expected: FAIL — `provider.createSession` does not accept `stateDir`, resume does not restore history.

- [ ] **Step 3: Implement the integration**

- Add the mode switch at the top of the constructor; load/seed/create the log before pushing `system/init`.
- Keep `history` as the API message array; `historyFromEvents` produces it for resume/fork.
- `persistFrame` builds the event object with `session_id: opts.id`, `parent_tool_use_id: null`, `timestamp: new Date().toISOString()`, and the frame's `uuid`/`message`; fire-and-forget `void log.flush()` for assistant and tool_result frames.
- On `pumpLoop` catch, classify as before; append `turn/end` with `lastUsage`.
- `sendControlMessage` writes the compact event before pushing to history.
- Remove the unconditional context-snapshot push from the constructor; only the fresh path adds it (via `contextSnapshot` from `replay.ts`).
- **Test isolation:** every test that builds a provider must pass a fresh temp `stateDir` — the provider's default state dir is `~/.claude-react-web`. Update `providerWithStreamer` in `native-session.test.ts` to accept a temp dir and add an `afterEach` that removes it with the repo's `maxRetries: 10, retryDelay: 100` pattern. Never let a test write to the real home dir.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/native-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): persist and resume native sessions"
```

---

### Task 7: Provider persistence surface

**Files:**
- Modify: `server/providers/native/native-provider.ts`
- Test: extend `server/providers/native/native-session.test.ts` (reuse its `textTurn` / `userMsg` helpers; the provider has no dedicated test file)

**Interfaces:**
- Consumes: Task 4 readers, Task 2 `hasNativeSessionLog` / `deleteNativeSessionLog`, `SessionMeta` from `../../../persistence.js`.
- Produces:
  - `class NativeProvider` constructor `{ stateDir?: string }`; `readonly stateDir: string`.
  - `readHistoryPage(id, opts)` / `readHistoryEntries(id, opts)` delegating to the reader with `this.stateDir`.
  - `hasTranscript(meta: SessionMeta): Promise<boolean>` → `hasNativeSessionLog(this.stateDir, meta.id)`.
  - `deleteTranscript(id: string): Promise<boolean>` → `nativeHistoryCache.invalidate(id)`; `deleteNativeSessionLog`.
  - `capabilities.supportsResume = true`; `capabilities.supportsFork = true`.
  - `createSession` passes `stateDir`, `resume`, `forkSession`, `resumeSessionAt`, `systemPromptAppend` into `NativeSessionOptions`; `system = systemPromptAppend ? `${registry.render()}\n\n${systemPromptAppend}` : registry.render()`.

- [ ] **Step 1: Write the failing test**

```ts
// append to native-session.test.ts
it('exposes history, existence and deletion over the state dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-prov-'))
  const provider = new NativeProvider({ stateDir: dir })
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* () { for (const ev of textTurn('hello')) yield ev }
  const session = provider.createSession({ id: 'p1', cwd: dir })
  ;(async () => { for await (const _ of session.messages) { /* drain */ } })()
  session.enqueueUserMessage(userMsg('hi') as never)
  await vi.waitFor(() => {
    const log = (session as unknown as { log: { events: Array<{ type: string }> } }).log
    expect(log.events.some((e) => e.type === 'turn/end')).toBe(true)
  })
  await session.destroy() // flush + close before reading the file
  const meta = { id: 'p1', cwd: dir } as never
  expect(await provider.hasTranscript(meta)).toBe(true)
  const entries = await provider.readHistoryEntries!('p1', {})
  expect(entries.length).toBeGreaterThan(0)
  expect((await provider.readHistoryPage!('p1', { limit: 10 })).totalCount).toBe(entries.length)
  expect(await provider.deleteTranscript!('p1')).toBe(true)
  expect(await provider.hasTranscript(meta)).toBe(false)
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

it('reports a corrupt log as existing, then fails loudly on read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-corrupt-'))
  const provider = new NativeProvider({ stateDir: dir })
  const log = NativeSessionLog.open({ stateDir: dir, id: 'p2', cwd: dir, resume: false })
  log.append({ type: 'session/context', text: 'ctx' })
  await log.flush(); await log.close()
  const path = nativeSessionLogPath(dir, 'p2')
  const raw = await readFile(path, 'utf8')
  await writeFile(path, raw.replace('"v":1', '"v":2'))
  expect(await provider.hasTranscript({ id: 'p2', cwd: dir } as never)).toBe(true)
  await expect(provider.readHistoryEntries!('p2', {})).rejects.toThrow(/unsupported|version/i)
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/native-session.test.ts`
Expected: FAIL — no `stateDir`, no reader methods.

- [ ] **Step 3: Implement the provider surface**

- Resolve `this.stateDir = resolveNativeStateDir(opts.stateDir)`.
- Delegate readers/has/delete; invalidate the cache on delete.
- Set the two capabilities to true.
- Thread the new session options and append `systemPromptAppend` to the rendered prompt.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/native-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-provider.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): expose native session persistence through the provider"
```

---

### Task 8: Manager plumbing — state dir, side-chat prompt, provider-aware deletion

**Files:**
- Modify: `server/providers/types.ts` (`CreateSessionOptions.systemPromptAppend?`, `AgentProvider.deleteTranscript?`)
- Modify: `server/providers/default-providers.ts` (`DefaultProvidersOptions.stateDir?`, pass to `NativeProvider`)
- Modify: `server/session-manager.ts` (constructor stateDir; `spawn` / `respawnInPlace` systemPromptAppend; `delete` / `discard` provider-aware transcript deletion)
- Test: `server/providers/native/e2e.test.ts` (extend in Task 9; this task's gate is typecheck + the existing native suite)

**Interfaces:**
- Consumes: Task 7 provider surface.
- Produces:
  - `CreateSessionOptions.systemPromptAppend?: string`
  - `AgentProvider.deleteTranscript?(id: string): Promise<boolean>`
  - `DefaultProvidersOptions.stateDir?: string`
  - A private `SessionManager.deleteProviderTranscript(providerName: string, id: string, opts: { single: boolean }): Promise<boolean>` helper used by `delete()` and `discard()`.

- [ ] **Step 1: Add the types and threaded options**

- Add the two optional fields; pass `stateDir: this.store.getDir()` in `SessionManager`'s `createDefaultProviders` call.
- In `spawn`, add `systemPromptAppend: (fullOpts as { parentId?: string }).parentId ? SIDE_DEVELOPER_INSTRUCTIONS : undefined` to the `provider.createSession` options.
- In `respawnInPlace`, add `systemPromptAppend: session.parentId ? SIDE_DEVELOPER_INSTRUCTIONS : undefined` to the `provider.createSession` options.

- [ ] **Step 2: Make deletion provider-aware**

- In `delete()`, resolve the provider name from `meta` before the strict probe. When `provider.deleteTranscript` exists, skip the `findTranscriptFile` probe and call the provider method in place of `deleteTranscriptFiles`; keep the claude branch unchanged. Use the provider's `hasTranscript` for the rollback existence check.
- In `discard({ deleteOriginal })`, replace `deleteTranscriptFile(id)` with `deleteProviderTranscript(providerName, id, { single: true })`; keep `jsonlPageCache.invalidate(id)` for claude and let the native method invalidate its own cache.

- [ ] **Step 3: Run typecheck and the native tests**

Run: `npm run typecheck && npx vitest run server/providers/native`
Expected: typecheck PASS; native suite PASS (no behavior change for claude).

- [ ] **Step 4: Run lint on the touched files**

Run: `npx eslint server/providers/types.ts server/providers/default-providers.ts server/providers/native/native-provider.ts server/session-manager.ts`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/providers/types.ts server/providers/default-providers.ts server/session-manager.ts
git commit -m "feat(native): thread state dir and side-chat prompt; make transcript deletion provider-aware"
```

---

### Task 9: End-to-end persistence, resume, fork, side chat, delete

**Files:**
- Modify: `server/providers/native/e2e.test.ts`
- Maybe create: `server/providers/native/e2e-persistence.test.ts` if the existing file grows too large.

**Interfaces:**
- Consumes: Task 8.
- Produces: proof through `SessionManager` that:
  - create → send → a NEW `SessionManager` on the same temp stateDir → `resume` restores the assistant reply and `getHistoryPage` returns it;
  - `searchMessages` finds text from the persisted turn;
  - `fork` produces a child with the source's history and a seeded log;
  - `createSideChat` hides the parent prefix from the child's history page while the model history contains it;
  - `delete({ deleteTranscript: true })` removes the native log;
  - `/clear` creates a new session id with a fresh log.

- [ ] **Step 1: Write the failing tests**

Use the existing `e2e.test.ts` fixture (`SessionStore` on a temp stateDir, `ProviderRegistry`, `NativeProvider({ stateDir: dir })`, scripted `_testStream`). Add one test per bullet above; for resume, create a second `SessionManager` with the same stateDir and call `resume(id)`. For side chat, send a turn on the parent, call `createSideChat`, assert `getHistoryPage(childId)` excludes the parent's first message and `sm.sessions.get(childId)` history includes it. For delete, assert `hasNativeSessionLog` is false after `delete(id, { deleteTranscript: true })`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/e2e.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Make them pass**

Fix only the integration gaps the tests surface (e.g., provider stateDir wiring, resume option threading, side-chat boundary). Do not change the log/reader contracts established in Tasks 1–5.

- [ ] **Step 4: Run the focused suite and the full gate**

Run: `npx vitest run server/providers/native && npm run typecheck && npm run test`
Expected: native suite PASS; typecheck PASS; full suite PASS (except unrelated pre-existing platform failures, which must be reported, not hidden).

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/e2e.test.ts
git commit -m "test(native): end-to-end persistence, resume, fork, side chat and delete"
```

---

### Task 10: Plan/spec sync and final review

**Files:**
- Modify: `docs/superpowers/plans/2026-11-08-native-provider-p0-p1.md` (add a short "P2: persistence" pointer to this plan and the spec)
- Modify: `docs/superpowers/specs/2026-11-09-native-session-persistence-design.md` (record any decisions that changed during implementation)

- [ ] **Step 1: Re-read the spec's Decisions section against the shipped code**

For each bullet in §16, confirm the code matches or update the spec with the actual decision. Do not leave stale statements.

- [ ] **Step 2: Add the plan pointer to the P0/P1 plan's out-of-scope list**

One line: persistence/resume/fork/side chat are implemented by `docs/superpowers/plans/2026-11-09-native-session-persistence.md`.

- [ ] **Step 3: Run the full gate**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: all pass.

- [ ] **Step 4: Run the code review on the full diff**

Run the `code-review` skill on `git diff HEAD`; verify each finding against the code, fix confirmed issues, and re-run the focused tests.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-11-08-native-provider-p0-p1.md docs/superpowers/specs/2026-11-09-native-session-persistence-design.md
git commit -m "docs(native): record native session persistence implementation"
```