# Task Results In Tasks Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move background-task completion output out of the transcript and into the Tasks panel, persisted to disk so it survives a server restart.

**Architecture:** Add `result?: string` to `TaskRecordUi` and a `TaskResultStore` sidecar (`PerSessionSidecar`, mirroring `ResultFrameStore`) that persists the whole task record set per session. Add the missing XML `<task-notification>` → `session.tasks` fold in the pump. Hide every `<task-notification>` frame from the transcript via `shouldHideByDefault` (disk JSONL keeps the line). Delete the now-dead transcript fold/card code. Render `result` in `TasksPanel` behind an on-expand toggle.

**Tech Stack:** TypeScript, Hono (server), React 19 + Vite (client), Vitest, `PerSessionSidecar` (existing engine), shared/browser-safe modules in `shared/`.

**Spec:** `docs/superpowers/specs/2026-10-22-task-results-in-tasks-panel-design.md`

## Global Constraints

- Conventional commits (`feat:` / `fix:` / `test:` / `refactor:` / `docs:` / `chore:`), enforced by commitlint. Every commit message ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Never use bare `console.*` for diagnostics — `createLogger(scope)` from `server/log.ts`.
- CSS: never hardcode color hex. Every color is a theme variable defined in **both** `:root` (dark) and `[data-theme="light"]`.
- Never spawn git through a shell — `runGit()` in `server/git.ts`.
- Typecheck runs **both** `tsc -p tsconfig.json` and `tsc -p tsconfig.node.json`.
- `MAX_TERMINAL_TASKS = 50` — terminal task records kept, oldest evicted. Lives in `shared/tasks.ts` after Task 1.
- Task record primary key is `taskId`. `taskId = <task-id> ?? <tool-use-id>` (spec §3.6).
- `<status>` missing/unrecognised normalises to `failed`, never `completed` (spec §3.7).
- The disk JSONL line for a `<task-notification>` **must keep being written** — `backfillSubagentCompletions` depends on it (spec §3.3).
- `output_file` body reading is **out of scope** (spec §2 Out). `result` stays empty on the `system/task_notification` path.

## Review Focus

1. **`<task-notification>` with no `<task-id>`** — must fall back to `<tool-use-id>` as `taskId`, else the task silently vanishes from Tasks. Pinned in Task 3 (pump fold) and Task 8 (panel display).
2. **`<status>` missing or unrecognised** — normalises to `failed`; combined with the transcript filter this yields **no transcript signal at all**. Must still land in Tasks with a red error icon. Pinned in Task 3 and Task 8.
3. **Hydrate racing a live frame for the same `taskId`** — hydrate runs fire-and-forget after `spawn`; it must only fill **missing** keys so a live frame that already landed is never clobbered. Pinned in Task 5.
4. **Multi-MB `result`** — must not enter the DOM until the row is expanded, or every `tasks-snapshot` repaint drags the panel. Pinned in Task 8.
5. **Disk JSONL line survives the frontend filter** — `shouldHideByDefault` must affect rendering only; the frame still enters the store and the disk transcript, or `backfillSubagentCompletions` re-synthesises completions over real ones on resume. Pinned in Task 6.

---

### Task 1: Shared types + XML injection parser

**Files:**
- Modify: `shared/tasks.ts`
- Modify: `shared/user-frames.ts`
- Modify: `src/session-store/normalize.ts` (delegate XML branch, re-export)
- Test: `shared/user-frames.test.ts` (create — the file does not exist yet)

**Interfaces:**
- Consumes: `UserFrameShape`, `isTaskNotificationUserMessage`, `taskNotificationText` (all already in `shared/user-frames.ts`).
- Produces:
  - `TaskRecordUi.result?: string` (`shared/tasks.ts`)
  - `MAX_TERMINAL_TASKS: number` (`shared/tasks.ts`, exported)
  - `type TaskNotificationStatus = 'completed' | 'failed' | 'stopped'` (`shared/user-frames.ts`)
  - `interface TaskNotificationInjection { taskId: string; toolUseId: string; status: TaskNotificationStatus; summary?: string; result?: string }` (`shared/user-frames.ts`)
  - `parseTaskNotificationInjection(msg: UserFrameShape): TaskNotificationInjection | null` (`shared/user-frames.ts`)

- [ ] **Step 1: Write the failing test**

Create `shared/user-frames.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseTaskNotificationInjection, isTaskNotificationUserMessage } from './user-frames'

const msg = (text: string) =>
  ({ type: 'user', message: { content: [{ type: 'text', text }] } }) as Parameters<
    typeof parseTaskNotificationInjection
  >[0]

describe('parseTaskNotificationInjection', () => {
  it('parses the full XML shape', () => {
    const p = parseTaskNotificationInjection(msg(
      '<task-notification><task-id>t1</task-id><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><summary>s</summary><result>R</result></task-notification>'))
    expect(p).toEqual({ taskId: 't1', toolUseId: 'tu1', status: 'completed', summary: 's', result: 'R' })
  })

  it('falls back to tool-use-id when task-id is absent', () => {
    const p = parseTaskNotificationInjection(msg(
      '<task-notification><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><result>R</result></task-notification>'))
    expect(p?.taskId).toBe('tu1')
    expect(p?.toolUseId).toBe('tu1')
  })

  it('returns null when tool-use-id is absent', () => {
    expect(parseTaskNotificationInjection(msg(
      '<task-notification><task-id>t1</task-id>' +
      '<status>completed</status><result>R</result></task-notification>'))).toBeNull()
  })

  it('normalises a missing status to failed, never completed', () => {
    const p = parseTaskNotificationInjection(msg(
      '<task-notification><tool-use-id>tu1</tool-use-id><result>R</result></task-notification>'))
    expect(p?.status).toBe('failed')
    const p2 = parseTaskNotificationInjection(msg(
      '<task-notification><tool-use-id>tu1</tool-use-id><status>weird</status></task-notification>'))
    expect(p2?.status).toBe('failed')
  })

  it('unescapes XML entities in the result body', () => {
    const p = parseTaskNotificationInjection(msg(
      '<task-notification><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><result>a &lt;b&gt; &amp; c</result></task-notification>'))
    expect(p?.result).toBe('a <b> & c')
  })

  it('returns null for a non-notification frame', () => {
    expect(parseTaskNotificationInjection(msg('plain user text'))).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/user-frames.test.ts`
Expected: FAIL — `parseTaskNotificationInjection` is not exported / does not exist.

- [ ] **Step 3: Write minimal implementation**

In `shared/user-frames.ts`, append after `taskNotificationToolUseId`. `extractXmlTag` and `normalizeTaskStatus` are lifted from `src/session-store/normalize.ts` so both surfaces share one parser (the repo rule: classification predicates are one implementation, not parallel mirrors).

```ts
/** Extract the inner text of the first `<tag>…</tag>` in `s`, with basic XML
 *  entity unescaping. Mirrors the parser the client's reducer uses, lifted
 *  here so server and client cannot drift. */
function extractXmlTag(s: string, tag: string): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = s.indexOf(open)
  if (start < 0) return null
  const end = s.indexOf(close, start + open.length)
  if (end < 0) return null
  return s.slice(start + open.length, end)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export type TaskNotificationStatus = 'completed' | 'failed' | 'stopped'

/** Known values pass through. Any UNRECOGNISED status defaults to 'failed' —
 *  NOT 'completed' — so a genuinely failed/cancelled task is never misshown
 *  as a successful green check. */
function normalizeTaskStatus(raw: string | undefined): TaskNotificationStatus {
  if (raw === 'completed' || raw === 'failed' || raw === 'stopped') return raw
  return 'failed'
}

/** A parsed harness `<task-notification>` user-role XML injection. */
export interface TaskNotificationInjection {
  /** Record key: `<task-id>` when present, else `<tool-use-id>` (spec §3.6).
   *  `toolUseId` is the only hard requirement the parser enforces. */
  taskId: string
  toolUseId: string
  status: TaskNotificationStatus
  summary?: string
  /** The completion's output body. Empty/absent when the injection carries
   *  none (e.g. the `system/task_notification` path keeps it in output_file). */
  result?: string
}

/** Parse a harness `<task-notification>` user-role XML injection. Returns
 *  null when the frame is not an injection, or carries no `<tool-use-id>`. */
export function parseTaskNotificationInjection(msg: UserFrameShape): TaskNotificationInjection | null {
  if (!isTaskNotificationUserMessage(msg)) return null
  const text = taskNotificationText(msg)
  const toolUseId = extractXmlTag(text, 'tool-use-id')
  if (!toolUseId) return null
  return {
    taskId: extractXmlTag(text, 'task-id') ?? toolUseId,
    toolUseId,
    status: normalizeTaskStatus(extractXmlTag(text, 'status') ?? undefined),
    summary: extractXmlTag(text, 'summary') ?? undefined,
    result: extractXmlTag(text, 'result') ?? undefined,
  }
}
```

Then in `src/session-store/normalize.ts`: delete the now-duplicated `extractXmlTag` and `normalizeTaskStatus` bodies, import them from `../../shared/user-frames.js`, and make the XML branch of `parseTaskNotification` delegate. Keep `ParsedTaskNotification` / `TaskNotificationStatus` exported from `normalize.ts` (re-export) so existing reducer imports do not change.

```ts
import {
  isTaskNotificationUserMessage,
  parseTaskNotificationInjection,
  type TaskNotificationStatus,
} from '../../shared/user-frames.js'

export type { TaskNotificationStatus }

export function parseTaskNotification(msg: SdkMessage): ParsedTaskNotification | null {
  if (msg.type === 'system' && (msg as { subtype?: unknown }).subtype === 'task_notification') {
    const m = msg as { tool_use_id?: unknown; status?: unknown; summary?: unknown }
    if (typeof m.tool_use_id !== 'string') return null
    return {
      toolUseId: m.tool_use_id,
      status: normalizeTaskStatus(typeof m.status === 'string' ? m.status : undefined),
      summary: typeof m.summary === 'string' ? m.summary : undefined,
    }
  }
  const inj = parseTaskNotificationInjection(msg as Parameters<typeof parseTaskNotificationInjection>[0])
  if (!inj) return null
  return { toolUseId: inj.toolUseId, status: inj.status, summary: inj.summary, result: inj.result }
}
```

`normalizeTaskStatus` is used by the system branch, so re-export it from `shared/user-frames.ts` (add `export` to its declaration) and import it in `normalize.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/user-frames.test.ts src/session-store/normalize.test.ts`
Expected: PASS. `normalize.test.ts` still passes because `parseTaskNotification` keeps its public shape.

- [ ] **Step 5: Typecheck both configs**

Run: `npm run typecheck`
Expected: PASS (both `tsconfig.json` and `tsconfig.node.json`).

- [ ] **Step 6: Commit**

```bash
git add shared/tasks.ts shared/user-frames.ts shared/user-frames.test.ts src/session-store/normalize.ts
git commit -m "feat: shared task-notification injection parser + TaskRecordUi.result

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `TaskRecordUi.result` + `MAX_TERMINAL_TASKS` move

**Files:**
- Modify: `shared/tasks.ts`
- Modify: `server/session-pump.ts` (import the constant, drop the local copy)
- Test: `shared/tasks.test.ts` (exists — add cases)

**Interfaces:**
- Consumes: `TaskRecordUi` (already in `shared/tasks.ts`).
- Produces: `TaskRecordUi.result?: string`, `MAX_TERMINAL_TASKS = 50` exported from `shared/tasks.ts`.

- [ ] **Step 1: Write the failing test**

In `shared/tasks.test.ts`, add:

```ts
import { MAX_TERMINAL_TASKS, isTerminalTaskStatus, normalizeTaskType } from './tasks'

describe('MAX_TERMINAL_TASKS', () => {
  it('is exported and pinned at 50', () => {
    expect(MAX_TERMINAL_TASKS).toBe(50)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/tasks.test.ts`
Expected: FAIL — `MAX_TERMINAL_TASKS` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `shared/tasks.ts`, add next to `TERMINAL_TASK_STATUSES`:

```ts
/** Cap on terminal (completed/failed/killed/stopped) task records kept in
 *  `session.tasks` and its sidecar. Terminal records linger so the
 *  TasksPanel can show recent completions; oldest are evicted beyond this. */
export const MAX_TERMINAL_TASKS = 50
```

Add to `TaskRecordUi`, after `resourceLinks`:

```ts
  /** Task completion output body. Filled from the harness XML injection's
   *  inline `<result>`; empty on the `system/task_notification` path, whose
   *  body lives in `output_file` (not read — spec §2 Out). */
  result?: string
```

In `server/session-pump.ts`: delete the local `const MAX_TERMINAL_TASKS = 50` block and import it from `../shared/tasks.js` alongside the existing `isTerminalTaskStatus` import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/tasks.test.ts server/session-pump.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add shared/tasks.ts shared/tasks.test.ts server/session-pump.ts
git commit -m "feat: add TaskRecordUi.result and hoist MAX_TERMINAL_TASKS to shared

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `TaskResultStore` sidecar

**Files:**
- Create: `server/task-result-store.ts`
- Test: `server/task-result-store.test.ts`

**Interfaces:**
- Consumes: `PerSessionSidecar` (`server/per-session-sidecar.ts`), `TaskRecordUi`, `MAX_TERMINAL_TASKS` (`shared/tasks.ts`), `isTerminalTaskStatus` (`shared/tasks.ts`).
- Produces:
  - `class TaskResultStore` with `load(sessionId: string): Promise<TaskRecordUi[] | null>`, `save(sessionId: string, records: TaskRecordUi[]): Promise<void>`, `remove(sessionId: string): Promise<void>`, `revive(sessionId: string): void`.

- [ ] **Step 1: Write the failing test**

Create `server/task-result-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskResultStore } from './task-result-store.js'
import type { TaskRecordUi } from '../shared/tasks.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'task-results-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const rec = (taskId: string, over: Partial<TaskRecordUi> = {}): TaskRecordUi => ({
  taskId,
  description: `desc ${taskId}`,
  status: 'completed',
  updatedAt: 1,
  ...over,
})

describe('TaskResultStore', () => {
  it('saves and reloads records, including result bodies', async () => {
    const store = new TaskResultStore(dir)
    await store.save('s1', [rec('t1', { result: 'OUTPUT-1' }), rec('t2')])
    const reloaded = await new TaskResultStore(dir).load('s1')
    expect(reloaded).toHaveLength(2)
    expect(reloaded!.find((r) => r.taskId === 't1')!.result).toBe('OUTPUT-1')
  })

  it('save replaces the whole set (upsert-by-taskId is the caller\'s job)', async () => {
    const store = new TaskResultStore(dir)
    await store.save('s1', [rec('t1'), rec('t2')])
    await store.save('s1', [rec('t1', { result: 'UPDATED' })])
    const reloaded = await store.load('s1')
    expect(reloaded).toHaveLength(1)
    expect(reloaded![0]!.result).toBe('UPDATED')
  })

  it('caps terminal records at MAX_TERMINAL_TASKS, keeping the newest', async () => {
    const store = new TaskResultStore(dir)
    const many = Array.from({ length: 60 }, (_, i) =>
      rec(`t${String(i).padStart(3, '0')}`, { status: 'completed', updatedAt: i }))
    await store.save('s1', many)
    const reloaded = await store.load('s1')
    expect(reloaded).toHaveLength(50)
    // Newest 50 survive: t010..t059
    expect(reloaded![0]!.taskId).toBe('t010')
    expect(reloaded![49]!.taskId).toBe('t059')
  })

  it('never drops non-terminal records when capping', async () => {
    const store = new TaskResultStore(dir)
    const mixed = [
      rec('live1', { status: 'running' }),
      ...Array.from({ length: 60 }, (_, i) => rec(`t${i}`, { status: 'completed', updatedAt: i })),
    ]
    await store.save('s1', mixed)
    const reloaded = await store.load('s1')
    expect(reloaded!.some((r) => r.taskId === 'live1')).toBe(true)
  })

  it('load returns null for a session with no sidecar', async () => {
    expect(await new TaskResultStore(dir).load('nope')).toBeNull()
  })

  it('tolerates a corrupted JSON file without throwing', async () => {
    await mkdir(join(dir, 'task-results'), { recursive: true })
    await writeFile(join(dir, 'task-results', 's1.json'), '{not json', 'utf8')
    expect(await new TaskResultStore(dir).load('s1')).toBeNull()
  })

  it('remove deletes the file and tombstones against a late save', async () => {
    const store = new TaskResultStore(dir)
    await store.save('s1', [rec('t1')])
    await store.remove('s1')
    await store.save('s1', [rec('t1')]) // tombstoned — must not recreate
    await expect(readFile(join(dir, 'task-results', 's1.json'), 'utf8')).rejects.toThrow()
    expect(await store.load('s1')).toBeNull()
  })

  it('revive clears the tombstone', async () => {
    const store = new TaskResultStore(dir)
    await store.save('s1', [rec('t1')])
    await store.remove('s1')
    store.revive('s1')
    await store.save('s1', [rec('t2')])
    expect(await store.load('s1')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/task-result-store.test.ts`
Expected: FAIL — `./task-result-store.js` does not resolve.

- [ ] **Step 3: Write minimal implementation**

Create `server/task-result-store.ts`:

```ts
// Durable sidecar of a session's background-task records (`session.tasks`),
// one JSON array per session at <stateDir>/task-results/<sessionId>.json.
//
// Why a sidecar (same rationale as result-frame-store): `session.tasks` is
// in-memory and rebuilt empty on every session creation — nothing replays
// the history seed into it. Without this store a server restart wipes the
// TasksPanel, and (once the transcript filter lands) the completion output
// has no surviving surface at all.
//
// `session.tasks` is the runtime authority; this file is its durable
// mirror. Writes are full-replace snapshots of the Map (upsert-by-taskId is
// already applied by the caller), fire-and-forget on the task-event path.

import { join } from 'node:path'
import { PerSessionSidecar } from './per-session-sidecar.js'
import { MAX_TERMINAL_TASKS, isTerminalTaskStatus, type TaskRecordUi } from '../shared/tasks.js'

/** Keep every non-terminal record plus the newest `cap` terminals.
 *  Insertion order tracks start order, so terminal overflow evicts oldest. */
export function retainTerminalRecords(
  records: TaskRecordUi[],
  cap: number = MAX_TERMINAL_TASKS,
): TaskRecordUi[] {
  const terminals = records.filter((r) => isTerminalTaskStatus(r.status))
  const live = records.filter((r) => !isTerminalTaskStatus(r.status))
  return [...live, ...terminals.slice(-cap)]
}

export class TaskResultStore {
  private readonly sidecar: PerSessionSidecar<TaskRecordUi>

  constructor(stateDir: string | undefined) {
    this.sidecar = new PerSessionSidecar({
      dir: stateDir ? join(stateDir, 'task-results') : null,
      label: 'task-results',
    })
  }

  load(sessionId: string): Promise<TaskRecordUi[] | null> {
    return this.sidecar.load(sessionId)
  }

  /** Full-replace persist of the current `session.tasks` contents, capped.
   *  Fire-and-forget safe on the task-event path. */
  async save(sessionId: string, records: TaskRecordUi[]): Promise<void> {
    await this.sidecar.update(sessionId, () => retainTerminalRecords(records))
  }

  /** Delete the sidecar. Tombstones the id so a late save cannot recreate
   *  the file. */
  remove(sessionId: string): Promise<void> {
    return this.sidecar.remove(sessionId)
  }

  /** Clear the remove() tombstone for a new session reusing `sessionId`. */
  revive(sessionId: string): void {
    this.sidecar.revive(sessionId)
  }
}
```

Note on the corrupted-JSON test: `PerSessionSidecar.load` must already return `null` (rather than throw) on unparseable content. If it throws, wrap the `load` body in a try/catch that returns `null` and `log.warn`s — do not leave the throw.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/task-result-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add server/task-result-store.ts server/task-result-store.test.ts
git commit -m "feat: TaskResultStore sidecar persisting session.tasks to disk

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Pump XML fold + persist hook

**Files:**
- Modify: `server/session-pump.ts`
- Test: `server/session-pump.test.ts`

**Interfaces:**
- Consumes: `parseTaskNotificationInjection` (`shared/user-frames.ts`), `TaskRecordUi` (`shared/tasks.ts`).
- Produces:
  - `applyTaskNotificationInjection(session: Session, msg: SDKMessage): void` (exported from `server/session-pump.ts`)
  - `pruneAndBroadcastTasks(session: Session): void` (exported from `server/session-pump.ts`)
  - `PumpDeps.recordTasksSnapshot?: (sessionId: string) => void`

- [ ] **Step 1: Write the failing test**

In `server/session-pump.test.ts`, add a new describe block. `makeTaskSession()` already exists in that file.

```ts
describe('applyTaskNotificationInjection', () => {
  const xml = (inner: string) =>
    ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: inner }] } }) as unknown as SDKMessage

  it('folds a full injection into session.tasks with its result body', () => {
    const { session } = makeTaskSession()
    applyTaskNotificationInjection(session, xml(
      '<task-notification><task-id>t1</task-id><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><summary>did a thing</summary><result>THE-OUTPUT</result></task-notification>'))
    const rec = session.tasks.get('t1')!
    expect(rec.toolUseId).toBe('tu1')
    expect(rec.status).toBe('completed')
    expect(rec.result).toBe('THE-OUTPUT')
    expect(rec.progressSummary).toBe('did a thing')
  })

  it('keys the record by tool-use-id when task-id is absent', () => {
    const { session } = makeTaskSession()
    applyTaskNotificationInjection(session, xml(
      '<task-notification><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><result>R</result></task-notification>'))
    expect(session.tasks.get('tu1')).toBeTruthy()
    expect(session.tasks.get('tu1')!.toolUseId).toBe('tu1')
  })

  it('normalises a missing status to failed and keeps the record terminal', () => {
    const { session } = makeTaskSession()
    applyTaskNotificationInjection(session, xml(
      '<task-notification><tool-use-id>tu1</tool-use-id><result>R</result></task-notification>'))
    expect(session.tasks.get('tu1')!.status).toBe('failed')
  })

  it('upserts an existing record rather than clobbering its metadata', () => {
    const { session, snapshots } = makeTaskSession()
    applyTaskEvent(session, {
      type: 'system', subtype: 'task_started', task_id: 't1',
      tool_use_id: 'tu1', description: 'launch desc', task_type: 'local_bash',
    } as unknown as SDKMessage)
    applyTaskNotificationInjection(session, xml(
      '<task-notification><task-id>t1</task-id><tool-use-id>tu1</tool-use-id>' +
      '<status>completed</status><result>R</result></task-notification>'))
    const rec = session.tasks.get('t1')!
    expect(rec.description).toBe('launch desc')
    expect(rec.taskType).toBe('shell')
    expect(rec.result).toBe('R')
    expect(rec.status).toBe('completed')
    expect(snapshots.at(-1)).toBeTruthy()
  })

  it('ignores a non-notification frame', () => {
    const { session } = makeTaskSession()
    applyTaskNotificationInjection(session, xml('plain text'))
    expect(session.tasks.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-pump.test.ts`
Expected: FAIL — `applyTaskNotificationInjection` is not defined.

- [ ] **Step 3: Write minimal implementation**

In `server/session-pump.ts`, add the XML fold and a small export that wraps the two existing private helpers. `pruneTerminalTasks` and `pushTasksSnapshot` stay private — the wrapper is the single public entry so `applyTaskEvent`, `applyTaskNotificationInjection`, and SessionManager's hydrate path all use the same cap + fan-out.

```ts
/** Prune terminal overflow and broadcast the current snapshot. Exported so
 *  SessionManager's sidecar hydrate path reuses the same cap + fan-out. */
export function pruneAndBroadcastTasks(session: Session): void {
  pruneTerminalTasks(session)
  pushTasksSnapshot(session)
}

/** Fold a harness `<task-notification>` user-role XML injection into
 *  `session.tasks`. Today this shape never reaches the task map at all
 *  (`applyTaskEvent` early-returns for non-system frames), so background
 *  shell/monitor completions are invisible in the TasksPanel.
 *
 *  `taskId` falls back to `tool-use-id` when the injection carries no
 *  `<task-id>` (spec §3.6) — the parser enforces `tool-use-id` as the only
 *  hard requirement. `result` is the inline `<result>` body; the
 *  `system/task_notification` path keeps its body in `output_file` and is
 *  left empty here (spec §2 Out). */
export function applyTaskNotificationInjection(session: Session, msg: SDKMessage): void {
  const inj = parseTaskNotificationInjection(msg as Parameters<typeof parseTaskNotificationInjection>[0])
  if (!inj) return
  const now = Date.now()
  const existing = session.tasks.get(inj.taskId)
  session.tasks.set(inj.taskId, {
    taskId: inj.taskId,
    toolUseId: inj.toolUseId,
    description: existing?.description ?? inj.summary ?? '',
    subagentType: existing?.subagentType,
    taskType: existing?.taskType,
    status: inj.status,
    isBackgrounded: existing?.isBackgrounded,
    skipTranscript: existing?.skipTranscript,
    ambient: existing?.ambient,
    progressSummary: inj.summary ?? existing?.progressSummary,
    lastToolName: existing?.lastToolName,
    result: inj.result ?? existing?.result,
    resourceLinks: existing?.resourceLinks,
    runId: existing?.runId,
    startedAt: existing?.startedAt,
    endedAt: now,
    updatedAt: now,
  })
  pruneAndBroadcastTasks(session)
}
```

Add `recordTasksSnapshot?: (sessionId: string) => void` to the `PumpDeps` interface, documented as:

```ts
  /** Called whenever `session.tasks` changed so the manager can persist the
   *  durable sidecar. Fire-and-forget; a missed write only costs the panel
   *  its history across a restart. */
  recordTasksSnapshot?: (sessionId: string) => void
```

Then wire it into the pump loop. Two places:

1. In the `task_started` / `task_updated` / `task_progress` branch (the `continue` after `applyTaskEvent`), and in the `task_notification` branch, append after the existing calls:
```ts
            try { deps.recordTasksSnapshot?.(session.id) }
            catch (err) { log.warn(`[session ${session.id}] recordTasksSnapshot threw: ${err}`) }
```

2. Add a new fold call next to the existing `isTaskNotificationUserMessage` turn-stamp block (~line 1045), so the record is folded whether or not the frame later reaches the ring:
```ts
        if (session.pendingTurns === 0 && isTaskNotificationUserMessage(msg)) {
          stampUnaccountedTurn(session, deps)
        }
        // Fold the injection into session.tasks (the task map's XML path —
        // applyTaskEvent only handles the system-frame shape).
        if (isTaskNotificationUserMessage(msg)) {
          applyTaskNotificationInjection(session, msg)
          try { deps.recordTasksSnapshot?.(session.id) }
          catch (err) { log.warn(`[session ${session.id}] recordTasksSnapshot threw: ${err}`) }
        }
```

Inside `applyTaskEvent`, replace its existing `pruneTerminalTasks(session); pushTasksSnapshot(session)` tail with `pruneAndBroadcastTasks(session)` so there is one cap+fan-out path. No other call sites of `applyTaskEvent` change here — the `recordTasksSnapshot` dep call is added in the pump loop (above), and the watcher wrapper gets its persist in Task 5.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/session-pump.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add server/session-pump.ts server/session-pump.test.ts
git commit -m "feat: fold XML task-notifications into session.tasks with result body

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: SessionManager wiring — store, hydrate, persist

**Files:**
- Modify: `server/session-manager.ts`
- Test: `server/session-manager.test.ts`

**Interfaces:**
- Consumes: `TaskResultStore` (Task 3), `applyTaskNotificationInjection` / `pruneAndBroadcastTasks` / `PumpDeps.recordTasksSnapshot` (Task 4), `TaskRecordUi` (Task 1).
- Produces: nothing new exported — this is wiring. `SessionManager` owns a `taskResultStore` and a private `persistTasks(session)` / `hydrateTasks(id, session)`.

- [ ] **Step 1: Write the failing test**

In `server/session-manager.test.ts`, add a describe block. The file's harness is: `dir = makeTmpDir()` / `store = new SessionStore({ stateDir: dir })` / `await store.load()` / `sm = new SessionManager({ store })` / `await sm.create({ cwd, model })`; teardown is `await sm.shutdown()` + `rmRf(dir)`. This test needs its own `SessionManager` over the same `dir` to prove the sidecar survives a manager restart.

```ts
describe('TaskResultStore wiring', () => {
  it('hydrates session.tasks from the sidecar across a manager restart', async () => {
    // 1. Run one session to completion so its task lands in the sidecar.
    const info = await sm.create({ cwd: '/tmp', model: 'test-model' })
    const { applyTaskNotificationInjection } = await import('./session-pump.js')
    const s1 = (sm as unknown as { sessions: Map<string, { tasks: Map<string, unknown> }> }).sessions.get(info.id)!
    applyTaskNotificationInjection(s1 as never, {
      type: 'user', parent_tool_use_id: null,
      message: { content: [{ type: 'text', text:
        '<task-notification><task-id>t1</task-id><tool-use-id>tu1</tool-use-id>' +
        '<status>completed</status><result>FROM-DISK</result></task-notification>' }] },
    } as never)
    // persistTasks is fire-and-forget — wait for the file to land.
    await vi.waitFor(async () => {
      const { TaskResultStore } = await import('./task-result-store.js')
      const recs = await new TaskResultStore(dir).load(info.id)
      expect(recs?.some((r) => r.taskId === 't1')).toBe(true)
    })

    // 2. Simulate a server restart: new manager over the same stateDir.
    await sm.shutdown()
    const sm2 = new SessionManager({ store, modelSwitchRetryDelayMs: 5 })
    try {
      const restored = await sm2.create({ cwd: '/tmp', model: 'test-model', resume: info.id } as Parameters<SessionManager['create']>[0])
      // hydrateTasks is fire-and-forget too.
      await vi.waitFor(() => {
        const s2 = (sm2 as unknown as { sessions: Map<string, { tasks: Map<string, { result?: string }> }> }).sessions.get(restored.id)!
        expect(s2.tasks.get('t1')?.result).toBe('FROM-DISK')
      })
    } finally {
      await sm2.shutdown()
    }
  })
})
```

If `create()` does not accept a `resume` option in this harness, instead seed the sidecar directly under the id `create()` will produce and assert against that — the assertion that matters is unchanged: **a record written by manager A is visible in manager B's `session.tasks`**, and a live `task_started` + `task_notification` for a *different* `taskId` coexists without evicting it (add a second injection for `t2` before the restart and assert both survive).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-manager.test.ts -t "hydrates session.tasks"`
Expected: FAIL — the records are not loaded (hydrate does not exist).

- [ ] **Step 3: Write minimal implementation**

In `server/session-manager.ts`:

1. Import and construct the store next to `resultFrameStore`:
```ts
import { TaskResultStore } from './task-result-store.js'
// ...
private taskResultStore: TaskResultStore
// in constructor, next to `this.resultFrameStore = ...`:
this.taskResultStore = new TaskResultStore(this.store.getDir())
```

2. Add the two private methods (place near the other sidecar helpers):
```ts
  /** Fire-and-forget persist of `session.tasks` to its sidecar. A failed
   *  write only costs the panel its history across a restart. */
  private persistTasks(session: Session): void {
    void this.taskResultStore.save(session.id, Array.from(session.tasks.values())).catch((err) => {
      log.warn(`[${session.id}] task-result persist failed: ${err}`)
    })
  }

  /** Fill `session.tasks` from the durable sidecar after spawn. Fire-and-
   *  forget: a failed load leaves old tasks invisible (the pre-feature
   *  behaviour) but never blocks spawn. Only fills MISSING keys so a live
   *  task frame that already landed wins (spec review focus #3). */
  private hydrateTasks(id: string, session: Session): void {
    void (async () => {
      let records: TaskRecordUi[] | null = null
      try {
        records = await this.taskResultStore.load(id)
      } catch (err) {
        log.warn(`[${id}] task-result hydrate failed: ${err}`)
        return
      }
      if (!records || records.length === 0) return
      for (const rec of records) {
        if (!session.tasks.has(rec.taskId)) session.tasks.set(rec.taskId, rec)
      }
      pruneAndBroadcastTasks(session)
    })()
  }
```

3. Call `this.hydrateTasks(id, session)` immediately after the session object (the one with `tasks: new Map()` in `spawn`, currently ~line 3077) is inserted into `this.sessions`.

4. Wire `recordTasksSnapshot` into the pump deps object (the one that already has `recordResultFrame`):
```ts
        recordTasksSnapshot: (sessionId) => {
          const s = this.sessions.get(sessionId)
          if (s) this.persistTasks(s)
        },
```

5. Wire the watcher's `applyTaskEvent` wrapper (in the `BackgroundWatcherRegistry` construction) to persist too:
```ts
      applyTaskEvent: (s, msg) => {
        applyTaskEvent(s, msg)
        this.persistTasks(s)
      },
```

6. Mirror `resultFrameStore`'s lifecycle calls: `this.taskResultStore.remove(id)` beside each `this.resultFrameStore.remove(id)`, and `this.taskResultStore.revive(id)` beside `this.resultFrameStore.revive(id)`.

7. Import `pruneAndBroadcastTasks` and `TaskRecordUi` where needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add server/session-manager.ts server/session-manager.test.ts
git commit -m "feat: wire TaskResultStore into spawn/persist lifecycle

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Transcript filter (`shouldHideByDefault`)

**Files:**
- Modify: `src/session-store/normalize.ts`
- Test: `src/session-store/normalize.test.ts`

**Interfaces:**
- Consumes: `isTaskNotificationUserMessage` (`shared/user-frames.ts`, already imported).
- Produces: nothing new — behaviour change to `shouldHideByDefault`.

- [ ] **Step 1: Write the failing test**

In `src/session-store/normalize.test.ts`, inside the `shouldHideByDefault` describe:

```ts
  it('hides a <task-notification> user injection (output lives in TasksPanel)', () => {
    expect(shouldHideByDefault({
      type: 'user',
      message: { content: [{ type: 'text', text: '<task-notification><tool-use-id>tu1</tool-use-id><status>completed</status></task-notification>' }] },
    } as unknown as SdkMessage)).toBe(true)
  })

  it('still returns the item from toTranscriptItem (reducer needs the frame)', () => {
    const item = toTranscriptItem({
      type: 'user',
      uuid: 'u1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '<task-notification><tool-use-id>tu1</tool-use-id><status>completed</status></task-notification>' }] },
    } as unknown as SdkMessage, undefined)
    expect(item).not.toBeNull()
    expect(item!.hiddenByDefault).toBe(true)
    expect(item!.id).toBe('u1')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/session-store/normalize.test.ts -t "hides a <task-notification>"`
Expected: FAIL — currently returns `false`.

- [ ] **Step 3: Write minimal implementation**

In `shouldHideByDefault`, add next to the `isLocalCommandLogUserMessage` line:

```ts
  // Background-task completion injection — its output is rendered by the
  // TasksPanel (TaskResultStore-backed), not the transcript. The frame MUST
  // still reach the store and the disk JSONL: the reducer's activeSubagents
  // merge and `backfillSubagentCompletions` both read it (spec §3.3).
  if (msg.type === 'user' && isTaskNotificationUserMessage(msg)) return true
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/session-store/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/session-store/normalize.ts src/session-store/normalize.test.ts
git commit -m "feat: hide task-notification injections from the transcript

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Delete dead transcript fold/card code

**Files:**
- Modify: `src/components/message-list/rendering.ts`
- Modify: `src/components/message-list/transcript-rows.ts`
- Modify: `src/components/message-list/views/frame-views.tsx`
- Modify: `src/components/MessageList.tsx`
- Modify: `src/components/message-list/transcript-rows.test.ts`
- Delete: `src/components/message-list/TaskNotificationGroupRow.test.tsx`
- Modify: `src/components/MessageList.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildTranscriptRows` no longer emits `taskNotifGroup`; `TranscriptRow` loses that field.

- [ ] **Step 1: Write the failing test**

In `src/components/message-list/transcript-rows.test.ts`, add:

```ts
it('no longer folds task-notifications (they are hidden from the transcript)', () => {
  const { rows } = buildTranscriptRows({
    items: [notifItem('a'), notifItem('b')],
    isResultConsumed: never,
  })
  expect(rows.every((r) => (r as { taskNotifGroup?: unknown }).taskNotifGroup === undefined)).toBe(true)
})
```

(Reuse that file's existing `notifItem` helper.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/message-list/transcript-rows.test.ts`
Expected: FAIL — `taskNotifGroup` is still populated.

- [ ] **Step 3: Delete the dead code**

1. `src/components/message-list/rendering.ts` — remove the `if (isTaskNotificationUserMessage(msg)) { … }` block inside `willRenderEmpty`. Drop `isTaskNotificationUserMessage` / `parseTaskNotification` from its imports if they become unused.

2. `src/components/message-list/transcript-rows.ts` — delete `isTaskNotificationEligible`, `foldTaskNotificationRows`, the `taskNotifGroup` field on `TranscriptRow`, and the `foldTaskNotificationRows` call in `buildTranscriptRows`. Simplify `const foldedNotifs = toolGroupCards ? foldTaskNotificationRows(folded) : folded` to `const foldedNotifs = folded` (or rename the variable back to `folded` and drop the alias).

3. `src/components/message-list/views/frame-views.tsx` — delete `TaskNotificationGroupRow` and `TaskNotificationCard`. Drop the `extractUserText` import if now unused.

4. `src/components/MessageList.tsx` — delete the `item.taskNotifGroup` ternary branch, the `row.taskNotifGroup` member-indices lookup, `expandedNotifGroups` state, `toggleNotifGroup`, and the `row.taskNotifGroup` branch of the search-index map (around line 747). Remove the `TaskNotificationGroupRow` import.

5. `src/components/message-list/TaskNotificationGroupRow.test.tsx` — delete the file.

6. `src/components/message-list/transcript-rows.test.ts` — delete the `foldTaskNotificationRows` describe block and the `buildTranscriptRows: task-notification fold vs toolGroupCards pref` describe block.

7. `src/components/MessageList.test.tsx` — delete the `expands a folded task-notification group on toggle` and `collapses expanded notification groups when the transcript identity changes` tests, and any `task-notification` card-rendering tests whose component is gone.

- [ ] **Step 4: Run the full client test suite**

Run: `npx vitest run src/`
Expected: PASS. If a removed symbol is still imported anywhere the run fails loudly — fix the import.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npm run lint
git add -A src/
git commit -m "refactor: remove dead task-notification transcript fold and cards

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: TasksPanel result rendering

**Files:**
- Modify: `src/components/TasksPanel.tsx`
- Modify: `src/styles/tasks-panel.css`
- Test: `src/components/TasksPanel.test.tsx`

**Interfaces:**
- Consumes: `TaskRecordUi.result?: string` (Task 1).
- Produces: nothing new exported — `TaskRow` renders the result block inline.

- [ ] **Step 1: Write the failing test**

In `src/components/TasksPanel.test.tsx`, add (adapting the file's existing render harness):

```ts
it('renders an expand toggle for a terminal task with a result, and the body only after expanding', () => {
  const tasks = [{
    taskId: 't1', toolUseId: 'tu1', description: 'bg command',
    status: 'completed', result: 'THE-OUTPUT-BODY', updatedAt: 1,
    startedAt: 0, endedAt: 5,
  }] as TaskRecordUi[]
  const { container, getByRole } = renderTasks(tasks)
  // Before expanding: the body must not be in the DOM at all.
  expect(container.textContent).not.toContain('THE-OUTPUT-BODY')
  fireEvent.click(getByRole('button', { name: /show output/i }))
  expect(container.textContent).toContain('THE-OUTPUT-BODY')
  fireEvent.click(getByRole('button', { name: /hide output/i }))
  expect(container.textContent).not.toContain('THE-OUTPUT-BODY')
})

it('renders no toggle when result is empty or absent', () => {
  const tasks = [
    { taskId: 't1', description: 'a', status: 'completed', updatedAt: 1 },
    { taskId: 't2', description: 'b', status: 'completed', result: '', updatedAt: 1 },
  ] as TaskRecordUi[]
  const { queryByRole } = renderTasks(tasks)
  expect(queryByRole('button', { name: /show output/i })).toBeNull()
})

it('renders no toggle for a still-running task', () => {
  const tasks = [{ taskId: 't1', description: 'a', status: 'running', result: 'X', updatedAt: 1 }] as TaskRecordUi[]
  const { queryByRole } = renderTasks(tasks)
  expect(queryByRole('button', { name: /show output/i })).toBeNull()
})

it('shows the red error styling for a failed task whose result is empty', () => {
  // Review focus #2: a failed task with no result must still be visible as a
  // failed row (it is now the ONLY signal — the transcript no longer shows it).
  const tasks = [{ taskId: 't1', description: 'a', status: 'failed', updatedAt: 1 }] as TaskRecordUi[]
  const { container } = renderTasks(tasks)
  expect(container.querySelector('.tasks-icon-err')).toBeTruthy()
  expect(queryByRole('button', { name: /show output/i })).toBeNull()
})
```

Adapt `renderTasks` to the file's existing harness (that test file already renders `TasksPanel`; follow its pattern).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/TasksPanel.test.tsx`
Expected: FAIL — no such toggle exists.

- [ ] **Step 3: Write minimal implementation**

In `src/components/TasksPanel.tsx`, add a small local component (do **not** reuse `FoldableBody` — it is a transcript-row component with scroll-coupled height tweening, wrong for this overlay):

```tsx
/** On-demand viewer for a task's completion output. The body is NOT in the
 *  DOM until expanded — a background command can emit megabytes of stdout,
 *  and tasks-snapshot re-renders this row often. */
function TaskResultBlock({ result }: { result: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="tasks-row-result">
      <button
        type="button"
        className="tasks-row-result-toggle"
        aria-label={open ? 'Hide output' : 'Show output'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide output' : 'Show output'}
      </button>
      {open && <pre className="tasks-row-result-body">{result}</pre>}
    </span>
  )
}
```

In `TaskRow`, render it after `resourceLinks` and gate it on terminal + non-empty:

```tsx
        {terminal && task.result != null && task.result !== '' && (
          <TaskResultBlock result={task.result} />
        )}
```

`TaskRow` already computes `terminal` from `isTerminalTaskStatus(task.status)`.

In `src/styles/tasks-panel.css`, add (colors as theme variables only):

```css
.tasks-row-result {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-1);
}
.tasks-row-result-toggle {
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  font-size: var(--fs-xs);
  padding: 0;
}
.tasks-row-result-toggle:hover {
  color: var(--fg);
}
.tasks-row-result-body {
  margin: 0;
  padding: var(--space-2);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  font-family: var(--mono);
  font-size: var(--fs-2xs);
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
```

Verify every variable used (`--space-1`, `--space-2`, `--fs-xs`, `--fs-2xs`, `--mono`, `--bg`, `--border`, `--radius-sm`, `--fg-muted`, `--fg`) is defined in **both** `:root` and `[data-theme="light"]`. If any is missing, add it to both.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/TasksPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/components/TasksPanel.tsx src/styles/tasks-panel.css src/components/TasksPanel.test.tsx
git commit -m "feat: TasksPanel on-expand viewer for task completion output

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: Full verification + regression sweep

**Files:**
- Modify: `CLAUDE.md` (the `tasks-snapshot` / `TaskRecordUi` notes)
- Modify: `AGENTS.md` if it mirrors the same notes

**Interfaces:**
- Consumes: all previous tasks.
- Produces: none.

- [ ] **Step 1: Run the entire test suite**

Run: `npm run test`
Expected: PASS (server unit tests + client hook tests).

- [ ] **Step 2: Run typecheck (both configs) and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Verify the Review Focus items are covered**

Confirm each has a passing test:
1. missing `<task-id>` → `toolUseId` fallback — Task 4 test `keys the record by tool-use-id when task-id is absent`, Task 1 test `falls back to tool-use-id when task-id is absent`.
2. missing `<status>` → `failed` + red icon — Task 4 test `normalises a missing status to failed`, Task 8 test `shows the red error styling for a failed task whose result is empty`.
3. hydrate does not clobber live frames — Task 5 test `hydrates session.tasks from the sidecar on spawn and keeps live frames winning`.
4. multi-MB result not in DOM until expanded — Task 8 test `renders an expand toggle … body only after expanding`.
5. disk line survives the filter — Task 6 test `still returns the item from toTranscriptItem`.

If any is missing, add the test to the owning task's file and re-run.

- [ ] **Step 4: Manually verify the disk line still gets written**

With a session that produces a background task, confirm the session's JSONL still contains a `type:"user"` line whose text starts with `<task-notification>`. This is the input `backfillSubagentCompletions` scans; if it is gone, resume will re-synthesise completions over real ones.

- [ ] **Step 5: Update docs**

In `CLAUDE.md`, in the `tasks-snapshot` bullet and the `TaskRecordUi`-adjacent prose, note that `TaskRecordUi` carries `result` and that `<task-notification>` frames are hidden from the transcript (output lives in TasksPanel). Keep the edit to the existing bullets — do not restructure the file.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: record task-result persistence and transcript filter

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
