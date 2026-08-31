# Uploads Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A header-launched manager dialog that lists every composer file upload (with provenance), supports delete (including orphans whose session is gone), copy-path reuse, and usage stats — backed by a server-side path-keyed registry.

**Architecture:** A new `UploadStore` (JsonFileStore subclass, `<stateDir>/upload-registry.json`, unique key = absolute file path) records uploads at POST time and backfills from known session cwds at boot. The uploads router gains `GET /api/uploads` (with live `exists` check) and `DELETE /api/uploads/:id` (path-validated). The client gets a `useUploads` fetch-on-open hook and an app-level `UploadsManagerDialog` opened from the `main-header` toolbar.

**Tech Stack:** Hono + Node fs on the server (vitest, Node env); React 19 + TypeScript on the client (vitest jsdom workspace, @testing-library/react).

**Spec:** `docs/superpowers/specs/2026-08-31-uploads-manager-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- CSS: never hardcode color hex values — use theme variables only (`var(--fg)`, `var(--fg-muted)`, `var(--border)`, `--bg-elev`, `--danger`, …). Any NEW color must exist in both `:root` and `[data-theme="light"]` blocks (`src/styles/tokens.css`).
- UI copy in English, matching the rest of the app.
- All server diagnostics through `createLogger(scope)`; never bare `console.*` for logging.
- TypeScript strictness: server code uses ESM `.js` extension imports (`'./upload-store.js'`).
- Typecheck is two projects: `npm run typecheck` runs BOTH `tsconfig.json` (browser) and `tsconfig.node.json` (server) — never typecheck only one.
- Tests: `npx vitest run <path>` for a single file; server tests run in Node env, client hook/component tests in the jsdom workspace (routed automatically by path).
- Destructive UI actions require a `ConfirmDialog` (`destructive` prop) — repo convention from git-write.
- The registry key is the absolute `path`; `id` is for routes/UI only. Never key by session id — forks share a cwd and deleted sessions must not take records with them.
- Deleting a registry entry ALWAYS also unlinks the file (except `exists: false` entries, whose file is already gone). This is what keeps boot backfill from resurrecting deleted rows.

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `shared/uploads.ts` | Create | Wire types shared by server + client (`UploadEntry`, `UploadListItem`, `UploadsListResponse`) |
| `server/upload-store.ts` | Create | `UploadStore` (JsonFileStore subclass): record/lookup/remove + boot backfill |
| `server/upload-store.test.ts` | Create | Store unit tests |
| `server/routes/uploads.ts` | Modify | Router: POST records; add GET `/uploads`, DELETE `/uploads/:id`; chips DELETE syncs registry |
| `server/routes/uploads.test.ts` | Create | Route tests (multipart POST, list, delete, validation) |
| `server/routes/index.ts` | Modify | Thread `uploadStore` through `buildApiRouter` |
| `server/app.ts` | Modify | `uploadStore?` on `BuildAppOpts`, passed to `buildApiRouter` |
| `server/cli.ts` | Modify | Instantiate store, backfill after SessionManager, pass to `buildApp` |
| `src/hooks/useUploads.ts` | Create | Fetch-on-open client data layer |
| `src/hooks/useUploads.test.ts` | Create | Hook tests (jsdom, mocked api) |
| `src/components/UploadsManagerDialog.tsx` | Create | The manager dialog UI |
| `src/components/UploadsManagerDialog.test.tsx` | Create | Dialog component tests |
| `src/styles/uploads-manager.css` | Create | Scoped dialog styles (theme variables only) |
| `src/styles/index.css` | Modify | `@import` the new stylesheet |
| `src/App.tsx` | Modify | Header button + dialog mount |

---

### Task 1: UploadStore + shared types

**Files:**
- Create: `shared/uploads.ts`
- Create: `server/upload-store.ts`
- Test: `server/upload-store.test.ts`

**Interfaces:**
- Consumes: `JsonFileStore` base (`server/json-file-store.ts`) — constructor `(opts, fileName, defaultDirName, label)`, template methods `getKey`/`parseItems`/`serializeForWrite`, concrete `list()/get()/has()/upsert()/remove()`.
- Produces (used by Tasks 2, 3, 4, 5):
  - `shared/uploads.ts`: `interface UploadEntry { id: string; path: string; cwd: string; name: string; size: number; uploadedAt: number; sessionTitle: string }`, `type UploadListItem = UploadEntry & { exists: boolean }`, `interface UploadsListResponse { uploads: UploadListItem[] }`
  - `server/upload-store.ts`: `class UploadStore` with `record(entries: UploadEntry[]): void`, `getById(id: string): UploadEntry | undefined`, `removeById(id: string): boolean`, `removeByPath(path: string): void`, `backfillFromSessions(sessions: Array<{ cwd?: string | null; title?: string }>): Promise<number>`; `function coerceStoredUpload(raw: unknown): UploadEntry | null`; `const UPLOAD_SUBDIR = 'claude-web-uploads'`.

- [ ] **Step 1: Write the failing tests**

Create `shared/uploads.ts` is part of implementation, but the store test imports it — so write both files' content in Step 3; the test file goes first:

Create `server/upload-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { UploadStore, coerceStoredUpload, type UploadEntry } from './upload-store.js'
import { tempDir } from './__test-utils__/index.js'

function makeEntry(overrides: Partial<UploadEntry> = {}): UploadEntry {
  return {
    id: 'id-1',
    path: '/proj/claude-web-uploads/1-a.txt',
    cwd: '/proj',
    name: 'a.txt',
    size: 10,
    uploadedAt: 1_700_000_000_000,
    sessionTitle: 'Session A',
    ...overrides,
  }
}

describe('UploadStore', () => {
  let dir: string
  let store: UploadStore

  beforeEach(() => {
    dir = tempDir('upload-store')
    store = new UploadStore({ stateDir: dir })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  describe('load', () => {
    it('returns empty array when file is missing (ENOENT)', async () => {
      const entries = await store.load()
      expect(entries).toEqual([])
      expect(store.list()).toEqual([])
    })

    it('returns empty array on corrupt JSON without throwing', async () => {
      writeFileSync(join(dir, 'upload-registry.json'), '{not json')
      const entries = await store.load()
      expect(entries).toEqual([])
    })

    it('returns empty array when on-disk value is not an array', async () => {
      writeFileSync(join(dir, 'upload-registry.json'), JSON.stringify({ id: 'x' }))
      const entries = await store.load()
      expect(entries).toEqual([])
    })

    it('drops malformed entries but keeps valid ones, preserving order', async () => {
      writeFileSync(
        join(dir, 'upload-registry.json'),
        JSON.stringify([
          makeEntry({ id: 'a', name: 'a.txt' }),
          { id: 'b' }, // missing everything else → dropped
          makeEntry({ id: 'c', name: 'c.txt' }),
          makeEntry({ id: 'd', size: 'big' as unknown as number }), // wrong-typed size → dropped
          makeEntry({ id: 'e', uploadedAt: undefined }), // missing uploadedAt → dropped
        ]),
      )
      await store.load()
      expect(store.list().map((u) => u.id)).toEqual(['a', 'c'])
    })

    it('defaults missing sessionTitle to empty string', async () => {
      writeFileSync(
        join(dir, 'upload-registry.json'),
        JSON.stringify([
          { id: 'a', path: '/p/claude-web-uploads/1-a.txt', cwd: '/p', name: 'a.txt', size: 1, uploadedAt: 1 },
        ]),
      )
      await store.load()
      expect(store.list()[0].sessionTitle).toBe('')
    })
  })

  describe('record / keying', () => {
    it('keys by path — same path with different ids collapses to one entry', () => {
      store.record([makeEntry({ id: 'x' }), makeEntry({ id: 'y' })])
      expect(store.list()).toHaveLength(1)
      expect(store.list()[0].id).toBe('y') // upsert overwrites in place
    })

    it('record appends distinct paths in insertion order', () => {
      store.record([
        makeEntry({ path: '/p/claude-web-uploads/1-a.txt', name: 'a.txt' }),
        makeEntry({ path: '/p/claude-web-uploads/2-b.txt', name: 'b.txt' }),
      ])
      expect(store.list().map((u) => u.name)).toEqual(['a.txt', 'b.txt'])
    })
  })

  describe('getById / removeById / removeByPath', () => {
    beforeEach(() => {
      store.record([
        makeEntry({ id: 'a' }),
        makeEntry({ id: 'b', path: '/proj/claude-web-uploads/2-b.txt' }),
      ])
    })

    it('getById finds by id, not path', () => {
      expect(store.getById('b')?.name).toBe('b.txt')
      expect(store.getById('nope')).toBeUndefined()
    })

    it('removeById removes and reports true; unknown id reports false', () => {
      expect(store.removeById('a')).toBe(true)
      expect(store.getById('a')).toBeUndefined()
      expect(store.removeById('a')).toBe(false)
    })

    it('removeByPath removes the entry with that path', () => {
      store.removeByPath('/proj/claude-web-uploads/2-b.txt')
      expect(store.getById('b')).toBeUndefined()
    })
  })

  describe('coerceStoredUpload', () => {
    it('rejects non-objects and wrong types', () => {
      expect(coerceStoredUpload(null)).toBeNull()
      expect(coerceStoredUpload('x')).toBeNull()
      expect(coerceStoredUpload({ id: 'a' })).toBeNull()
      expect(coerceStoredUpload(makeEntry({ size: Number.NaN }))).toBeNull()
    })

    it('accepts a full valid entry', () => {
      const entry = makeEntry()
      expect(coerceStoredUpload(entry)).toEqual(entry)
    })
  })

  describe('backfillFromSessions', () => {
    it('records files under <cwd>/claude-web-uploads with mtime + provenance', async () => {
      const cwd = tempDir('backfill-cwd')
      const updir = join(cwd, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      writeFileSync(join(updir, '10-report.pdf'), 'hello')

      const added = await store.backfillFromSessions([{ cwd, title: 'My Session' }])
      expect(added).toBe(1)

      const entry = store.list()[0]
      const expectedStat = statSync(join(updir, '10-report.pdf'))
      expect(entry.name).toBe('10-report.pdf')
      expect(entry.size).toBe(5)
      expect(entry.sessionTitle).toBe('My Session')
      expect(entry.uploadedAt).toBe(expectedStat.mtimeMs)
      expect(entry.path).toBe(join(updir, '10-report.pdf'))
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })

    it('is idempotent — second run adds nothing and preserves original uploadedAt', async () => {
      const cwd = tempDir('backfill-cwd')
      const updir = join(cwd, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      writeFileSync(join(updir, '1-a.txt'), 'x')
      await store.backfillFromSessions([{ cwd, title: 'T1' }])
      const before = store.list()[0].uploadedAt

      const added = await store.backfillFromSessions([{ cwd, title: 'T2' }])
      expect(added).toBe(0)
      expect(store.list()).toHaveLength(1)
      expect(store.list()[0].uploadedAt).toBe(before) // not overwritten by second run
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })

    it('skips sessions without cwd, missing dirs, directories, and unreadable paths', async () => {
      const added = await store.backfillFromSessions([
        { title: 'no cwd' },
        { cwd: tempDir('no-upload-dir'), title: 'empty' },
      ])
      expect(added).toBe(0)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/upload-store.test.ts`
Expected: FAIL — cannot resolve `./upload-store.js` (module does not exist yet).

- [ ] **Step 3: Implement**

Create `shared/uploads.ts`:

```ts
// Uploaded-file registry types shared by the server (store + routes) and
// the client (manager dialog). Browser-safe: no Node imports.

/** One recorded upload. `path` is the unique key (dest names embed a
 *  millisecond timestamp, so same-cwd collisions cannot occur); `id`
 *  exists for routes and UI keys. `cwd` is the ownership key (forks share
 *  a cwd); `sessionTitle` is a provenance snapshot taken at upload time —
 *  a deleted session must not take the record with it. */
export interface UploadEntry {
  id: string
  path: string
  cwd: string
  name: string
  size: number
  uploadedAt: number
  sessionTitle: string
}

/** UploadEntry + a live on-disk existence flag computed by GET /uploads. */
export type UploadListItem = UploadEntry & { exists: boolean }

export interface UploadsListResponse {
  uploads: UploadListItem[]
}
```

Create `server/upload-store.ts`:

```ts
// Uploaded-file registry.
//
// Records every composer file upload (paperclip / drag-drop) so the
// Uploads Manager dialog can list, audit and delete them — including
// uploads whose session has since been deleted (orphans). Persisted as
// <stateDir>/upload-registry.json via the shared JsonFileStore base
// (atomic tmp+rename, debounced flush — same as snippet-store).
//
// Keying: `path` is the unique key; `id` is for routes/UI. Provenance:
// `cwd` is the ownership key and `sessionTitle` is a snapshot — a deleted
// session must not take the record with it.

import { promises as fs } from 'node:fs'
import { basename, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import { createLogger } from './log.js'
import type { UploadEntry } from '../shared/uploads.js'

const log = createLogger('upload-registry')

/** Where per-session uploads land inside the session's cwd. Kept visible
 *  (not dot-prefixed) so users can see what the UI dropped in. Single
 *  source of truth for both the upload route and the backfill scan. */
export const UPLOAD_SUBDIR = 'claude-web-uploads'

export type UploadStoreOptions = { stateDir?: string }

/** Defensive parse of one on-disk entry. Returns null for entries missing
 *  required fields or with wrong-typed values (hand edits / version drift)
 *  instead of throwing. `sessionTitle` tolerates absence → ''. */
export function coerceStoredUpload(raw: unknown): UploadEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.path !== 'string' || !r.path) return null
  if (typeof r.cwd !== 'string' || !r.cwd) return null
  if (typeof r.name !== 'string' || !r.name) return null
  if (typeof r.size !== 'number' || !Number.isFinite(r.size)) return null
  if (typeof r.uploadedAt !== 'number' || !Number.isFinite(r.uploadedAt)) return null
  return {
    id: r.id,
    path: r.path,
    cwd: r.cwd,
    name: r.name,
    size: r.size,
    uploadedAt: r.uploadedAt,
    sessionTitle: typeof r.sessionTitle === 'string' ? r.sessionTitle : '',
  }
}

interface BackfillSession {
  cwd?: string | null
  title?: string
}

export class UploadStore extends JsonFileStore<UploadEntry> {
  constructor(opts: UploadStoreOptions = {}) {
    super(opts, 'upload-registry.json', DEFAULT_DIR_NAME, 'upload-registry')
  }

  protected getKey(entry: UploadEntry): string {
    return entry.path
  }

  protected parseItems(raw: string): UploadEntry[] {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      log.warn(`${this.file} is not an array; ignoring`)
      return []
    }
    const entries: UploadEntry[] = []
    for (const item of parsed) {
      const entry = coerceStoredUpload(item)
      if (entry) entries.push(entry)
    }
    return entries
  }

  protected serializeForWrite(items: UploadEntry[]): unknown {
    return items
  }

  /** Record uploads. Idempotent by path — an existing path is updated in
   *  place, so a re-record never duplicates. Flush is debounced by the
   *  base class. */
  record(entries: UploadEntry[]): void {
    for (const entry of entries) this.upsert(entry)
  }

  /** Linear scan by id — registry sizes are small (hundreds at most), and
   *  the map is keyed by path, so no secondary index is warranted. */
  getById(id: string): UploadEntry | undefined {
    return this.list().find((e) => e.id === id)
  }

  /** Remove by id. Returns true when an entry was removed. */
  removeById(id: string): boolean {
    const entry = this.getById(id)
    if (!entry) return false
    this.remove(entry.path)
    return true
  }

  /** Remove by absolute path — used by the session-scoped chips DELETE so
   *  the two delete entry points cannot drift. */
  removeByPath(path: string): void {
    this.remove(path)
  }

  /** Seed the registry from the on-disk `claude-web-uploads/` folders of
   *  the given sessions. Idempotent — already-recorded paths (matched by
   *  path) keep their original uploadedAt/sessionTitle; only new paths are
   *  added, with mtimeMs as uploadedAt. Runs on every boot; cheap (one
   *  readdir per known-cwd session). Returns how many entries were added.
   *  Sessions without a cwd and unreadable/missing dirs are skipped.
   *
   *  Deletions are never resurrected: every registry delete path unlinks
   *  the file too, so a deleted entry's file is gone and cannot be
   *  re-scanned. */
  async backfillFromSessions(sessions: BackfillSession[]): Promise<number> {
    let added = 0
    for (const session of sessions) {
      if (!session.cwd) continue
      const dir = resolvePath(session.cwd, UPLOAD_SUBDIR)
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch {
        continue // no upload dir (or unreadable) — nothing to seed
      }
      for (const name of names) {
        const path = resolvePath(dir, name)
        let stat
        try {
          stat = await fs.stat(path)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        if (this.has(path)) continue
        this.upsert({
          id: randomUUID(),
          path,
          cwd: resolvePath(session.cwd),
          name: basename(path),
          size: stat.size,
          uploadedAt: stat.mtimeMs,
          sessionTitle: session.title ?? '',
        })
        added++
      }
    }
    if (added > 0) {
      log.info(`backfill added ${added} upload ${added === 1 ? 'entry' : 'entries'}`)
    }
    return added
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/upload-store.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add shared/uploads.ts server/upload-store.ts server/upload-store.test.ts
git commit -m "feat(server): uploads registry store + shared wire types"
```

---

### Task 2: Uploads routes — recording, list, delete

**Files:**
- Modify: `server/routes/uploads.ts` (full rewrite below — the file is small)
- Test: `server/routes/uploads.test.ts` (create)

**Interfaces:**
- Consumes: `UploadStore`, `UPLOAD_SUBDIR` from Task 1; `createErrorHandler` from `../errors.js`; existing `sm.get(id)` (returns `SessionInfo` with `.cwd`/`.title`).
- Produces (used by Task 3): `buildUploadRouter(sm: SessionManager, uploadStore?: UploadStore): Hono` mounting:
  - `POST /sessions/:id/uploads` — unchanged response shape `{ uploads: [...] }`, plus registry recording
  - `GET /uploads` → `{ uploads: UploadListItem[] }` (404 when no store mounted)
  - `DELETE /uploads/:id` → `{ ok: true }` (404 unknown id / no store, 400 path escape)

- [ ] **Step 1: Write the failing tests**

Create `server/routes/uploads.test.ts`:

```ts
// Tests for the uploads router: recording on POST, the manager routes
// (GET /uploads, DELETE /uploads/:id), path-escape validation, and the
// chips-DELETE → registry sync.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler } from '../errors.js'
import { buildUploadRouter } from './uploads.js'
import { UploadStore } from '../upload-store.js'
import { tempDir } from '../__test-utils__/index.js'
import type { SessionManager } from '../session-manager.js'

function makeSm(cwd: string, title = 'My Session'): SessionManager {
  // The router only uses sm.get(id) → { cwd, title }.
  return { get: () => ({ cwd, title }) } as unknown as SessionManager
}

function makeApp(sm: SessionManager, store?: UploadStore) {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/', buildUploadRouter(sm, store))
  return app
}

describe('uploads routes', () => {
  let cwd: string
  let stateDir: string
  let store: UploadStore
  let app: Hono

  beforeEach(() => {
    cwd = tempDir('uploads-cwd')
    stateDir = tempDir('uploads-state')
    store = new UploadStore({ stateDir })
    app = makeApp(makeSm(cwd), store)
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  describe('POST /sessions/:id/uploads', () => {
    it('writes the file, returns 200, and records a registry entry', async () => {
      const form = new FormData()
      form.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }))
      const res = await app.request('/sessions/s1/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(200)

      const body = (await res.json()) as { uploads: Array<{ path: string; name: string }> }
      expect(body.uploads).toHaveLength(1)
      expect(body.uploads[0].name).toBe('a.txt')

      const entries = store.list()
      expect(entries).toHaveLength(1)
      expect(entries[0].path).toBe(body.uploads[0].path)
      expect(entries[0].cwd).toBe(cwd)
      expect(entries[0].sessionTitle).toBe('My Session')
      expect(existsSync(body.uploads[0].path)).toBe(true)
    })

    it('still succeeds without a store (unrecorded)', async () => {
      const bare = makeApp(makeSm(cwd))
      const form = new FormData()
      form.append('file', new File(['x'], 'b.txt'))
      const res = await bare.request('/sessions/s1/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(200)
      expect(store.list()).toHaveLength(0)
    })
  })

  describe('GET /uploads', () => {
    it('lists entries with live exists flags', async () => {
      const updir = join(cwd, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      const kept = join(updir, '1-kept.txt')
      const gone = join(updir, '2-gone.txt')
      writeFileSync(kept, 'keep')
      writeFileSync(gone, 'gone')
      store.record([
        { id: 'k', path: kept, cwd, name: 'kept.txt', size: 4, uploadedAt: 1, sessionTitle: 'S' },
        { id: 'g', path: gone, cwd, name: 'gone.txt', size: 4, uploadedAt: 2, sessionTitle: 'S' },
      ])
      rmSync(gone) // out-of-band deletion

      const res = await app.request('/uploads')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { uploads: Array<{ id: string; exists: boolean }> }
      const byId = Object.fromEntries(body.uploads.map((u) => [u.id, u.exists]))
      expect(byId.k).toBe(true)
      expect(byId.g).toBe(false)
    })

    it('404s when no store is mounted', async () => {
      const bare = makeApp(makeSm(cwd))
      const res = await bare.request('/uploads')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /uploads/:id', () => {
    it('unlinks the file and removes the entry', async () => {
      const updir = join(cwd, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.txt')
      writeFileSync(path, 'data')
      store.record([{ id: 'a', path, cwd, name: 'a.txt', size: 4, uploadedAt: 1, sessionTitle: 'S' }])

      const res = await app.request('/uploads/a', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(existsSync(path)).toBe(false)
      expect(store.getById('a')).toBeUndefined()
    })

    it('removes a missing entry without unlinking (already gone)', async () => {
      store.record([{ id: 'g', path: join(cwd, 'claude-web-uploads', '9-gone.txt'), cwd, name: 'gone.txt', size: 1, uploadedAt: 1, sessionTitle: 'S' }])
      const res = await app.request('/uploads/g', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(store.getById('g')).toBeUndefined()
    })

    it('404s on unknown id', async () => {
      const res = await app.request('/uploads/nope', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })

    it('400s when the entry path escapes <cwd>/claude-web-uploads', async () => {
      // A tampered/hand-edited registry entry pointing outside the upload dir.
      store.record([{ id: 'bad', path: join(cwd, 'secret.txt'), cwd, name: 'secret.txt', size: 1, uploadedAt: 1, sessionTitle: 'S' }])
      const res = await app.request('/uploads/bad', { method: 'DELETE' })
      expect(res.status).toBe(400)
      expect(existsSync(join(cwd, 'secret.txt'))).toBe(true) // untouched
      expect(store.getById('bad')).toBeDefined()
    })
  })

  describe('DELETE /sessions/:id/uploads/:filename (chips path)', () => {
    it('removes the file AND syncs the registry', async () => {
      const updir = join(cwd, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.txt')
      writeFileSync(path, 'data')
      store.record([{ id: 'a', path, cwd, name: 'a.txt', size: 4, uploadedAt: 1, sessionTitle: 'S' }])

      const res = await app.request('/sessions/s1/uploads/1-a.txt', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(existsSync(path)).toBe(false)
      expect(store.getById('a')).toBeUndefined()
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/routes/uploads.test.ts`
Expected: FAIL — `buildUploadRouter` accepts one argument today; `GET /uploads` returns 404; POST does not record. Several tests fail; that's the point.

- [ ] **Step 3: Implement — rewrite `server/routes/uploads.ts`**

Replace the whole file with:

```ts
// Upload routes: upload, delete, and (since the Uploads Manager) list
// uploaded per-session files. Every UI upload is recorded in the
// UploadStore registry so the manager dialog can list/audit/delete it —
// including uploads whose session has since been deleted (orphans).

import { Hono } from 'hono'
import { mkdir, writeFile, unlink, stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionManager } from '../session-manager.js'
import { config as serverConfig } from '../config.js'
import { createLogger } from '../log.js'
import { UploadStore, UPLOAD_SUBDIR } from '../upload-store.js'
import type { UploadEntry } from '../../shared/uploads.js'

const log = createLogger('uploads')

/** Live on-disk existence check for a registry entry. Only a clean ENOENT
 *  reports missing — any other stat error reports present (and logs), so a
 *  transient FS hiccup never invites deleting a healthy file. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    log.warn(`stat failed for ${path}: ${(e as Error).message}`)
    return true
  }
}

export function buildUploadRouter(sm: SessionManager, uploadStore?: UploadStore): Hono {
  const app = new Hono()

  // Upload one or more files into the session's cwd.
  app.post('/sessions/:id/uploads', async (c) => {
    const id = c.req.param('id')
    const info = sm.get(id)
    if (!info.cwd) {
      return c.json({ error: 'session has no cwd; uploads require a working directory' }, 400)
    }
    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'expected multipart/form-data' }, 400)
    }

    const body = await c.req.parseBody({ all: true }).catch(() => null)
    if (!body) {
      log.warn(`upload session=${id} parseBody failed`)
      return c.json({ error: 'invalid multipart payload' }, 400)
    }

    const files: File[] = []
    for (const v of Object.values(body)) {
      if (v instanceof File) files.push(v)
      else if (Array.isArray(v)) for (const x of v) if (x instanceof File) files.push(x)
    }
    if (files.length === 0) return c.json({ error: 'no files in request' }, 400)

    const uploadDir = resolvePath(info.cwd, UPLOAD_SUBDIR)
    await mkdir(uploadDir, { recursive: true })

    const now = Date.now()
    const saved: Array<{ path: string; name: string; size: number }> = []
    const recorded: UploadEntry[] = []
    for (const f of files) {
      if (f.size > serverConfig.maxUploadBytes) {
        return c.json(
          { error: `file ${f.name} exceeds ${serverConfig.maxUploadBytes} bytes` },
          413 as 400 | 404 | 410 | 500,
        )
      }
      const rawName = f.name || 'upload'
      const baseName = rawName.split(/[\\/]/).pop() || 'upload'
      const safeName = baseName.replace(/[\0/\\]/g, '_').slice(0, 200) || 'upload'
      const destName = `${now}-${safeName}`
      const dest = resolvePath(uploadDir, destName)
      const buf = Buffer.from(await f.arrayBuffer())
      await writeFile(dest, buf)
      saved.push({ path: dest, name: safeName, size: f.size })
      if (uploadStore) {
        recorded.push({
          id: randomUUID(),
          path: dest,
          cwd: resolvePath(info.cwd),
          name: safeName,
          size: f.size,
          uploadedAt: now,
          sessionTitle: info.title ?? '',
        })
      }
    }

    // Registry recording must never fail the upload itself — persistence
    // errors inside the store are already logged by the JsonFileStore base.
    if (uploadStore && recorded.length > 0) {
      try {
        uploadStore.record(recorded)
      } catch (e) {
        log.warn(`upload registry record failed: ${(e as Error).message}`)
      }
    }

    log.info(`upload session=${id} files=${saved.length} totalBytes=${saved.reduce((s, f) => s + f.size, 0)}`)
    return c.json({ uploads: saved })
  })

  // ── Uploads Manager routes (only mounted when a store is wired) ──
  if (uploadStore) {
    // List every recorded upload with a live exists flag.
    app.get('/uploads', async (c) => {
      const uploads = await Promise.all(
        uploadStore.list().map(async (u) => ({ ...u, exists: await fileExists(u.path) })),
      )
      return c.json({ uploads })
    })

    // Delete by registry id: validate the entry path lives inside the
    // entry's own upload dir, unlink (unless already gone), drop the entry.
    app.delete('/uploads/:id', async (c) => {
      const id = c.req.param('id')
      const entry = uploadStore.getById(id)
      if (!entry) {
        return c.json({ error: 'upload entry not found' }, 404)
      }
      const uploadDir = resolvePath(entry.cwd, UPLOAD_SUBDIR)
      const target = resolvePath(entry.path)
      const targetNorm = target.replaceAll('\\', '/')
      const uploadDirNorm = uploadDir.replaceAll('\\', '/')
      if (!targetNorm.startsWith(uploadDirNorm + '/')) {
        return c.json({ error: 'invalid upload path' }, 400)
      }
      try {
        await unlink(target)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.error(`delete upload id=${id} error=${(e as Error).message}`)
          return c.json({ error: (e as Error).message }, 500)
        }
        // Already gone (out-of-band deletion) — just drop the entry.
      }
      uploadStore.removeById(id)
      log.info(`delete upload id=${id}`)
      return c.json({ ok: true })
    })
  }

  // Delete a previously uploaded file (pending-chip removal path).
  app.delete('/sessions/:id/uploads/:filename', async (c) => {
    const id = c.req.param('id')
    const filename = c.req.param('filename')
    const info = sm.get(id)
    if (!info.cwd) {
      return c.json({ error: 'session has no cwd' }, 400)
    }
    const target = resolvePath(info.cwd, UPLOAD_SUBDIR, filename)
    const uploadDir = resolvePath(info.cwd, UPLOAD_SUBDIR)
    const targetNorm = target.replaceAll('\\', '/')
    const uploadDirNorm = uploadDir.replaceAll('\\', '/')
    if (!targetNorm.startsWith(uploadDirNorm + '/') && targetNorm !== uploadDirNorm) {
      return c.json({ error: 'invalid filename' }, 400)
    }
    try {
      await unlink(target)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'file not found' }, 404)
      }
      log.error(`delete session=${id} filename=${filename} error=${(e as Error).message}`)
      return c.json({ error: (e as Error).message }, 500)
    }
    // Keep the registry in sync — the two delete paths must not drift.
    uploadStore?.removeByPath(target)
    log.info(`delete session=${id} filename=${filename}`)
    return c.json({ ok: true })
  })

  return app
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/routes/uploads.test.ts server/upload-store.test.ts`
Expected: PASS (both files green — the store tests confirm no regression).

- [ ] **Step 5: Commit**

```bash
git add server/routes/uploads.ts server/routes/uploads.test.ts
git commit -m "feat(server): uploads list/delete routes + registry recording"
```

---

### Task 3: Wiring — app opts, buildApiRouter, CLI boot + backfill

**Files:**
- Modify: `server/routes/index.ts` (signature + router call)
- Modify: `server/app.ts` (opts field + pass-through)
- Modify: `server/cli.ts` (instantiate + backfill + buildApp opt)

**Interfaces:**
- Consumes: `UploadStore` (Task 1), `buildUploadRouter(sm, store?)` (Task 2).
- Produces: `buildApiRouter(sm, configDir?, mpStore?, claudeBinary?, uploadStore?)`; `BuildAppOpts.uploadStore?: UploadStore`; boot log lines `loaded N uploaded-file registry entries` / `backfilled N upload entries`.

- [ ] **Step 1: Thread the store through `server/routes/index.ts`**

Add the import near the other type imports:

```ts
import type { UploadStore } from '../upload-store.js'
```

Change the signature (currently `buildApiRouter(sm, configDir?, mpStore?, claudeBinary?)`):

```ts
export function buildApiRouter(
  sm: SessionManager,
  configDir?: string,
  mpStore?: MpStore,
  claudeBinary?: string,
  uploadStore?: UploadStore,
): Hono {
```

Change the mount (currently `app.route('/', buildUploadRouter(sm))`):

```ts
  app.route('/', buildUploadRouter(sm, uploadStore))
```

- [ ] **Step 2: Add the opts field in `server/app.ts`**

Add the import next to the SnippetStore type import:

```ts
import type { UploadStore } from './upload-store.js'
```

Add to the `BuildAppOpts`-style opts interface, directly after the `snippetStore?` field (which carries the comment "Mounted as /api/snippets"):

```ts
  /** Uploaded-file registry store. Powered by buildUploadRouter: records
   *  POST /sessions/:id/uploads traffic and mounts GET /uploads +
   *  DELETE /uploads/:id for the Uploads Manager dialog. Optional —
   *  standalone builds (tests, tooling) without it keep plain upload
   *  working, unrecorded, and the manager routes return 404. */
  uploadStore?: UploadStore
```

Change the `buildApiRouter` call (currently
`const apiRouter = buildApiRouter(sessionManager, opts.configDir, opts.mpStore, opts.defaults?.claudeBinary)`):

```ts
  const apiRouter = buildApiRouter(sessionManager, opts.configDir, opts.mpStore, opts.defaults?.claudeBinary, opts.uploadStore)
```

- [ ] **Step 3: Instantiate + backfill in `server/cli.ts`**

Add the import next to the SnippetStore import (line ~23):

```ts
import { UploadStore } from './upload-store.js'
```

After the `uiStateStore` block (`const uiStateStore = new UiStateStore({ stateDir }); await uiStateStore.load()`), add:

```ts
  const uploadStore = new UploadStore({ stateDir })
  const uploadEntries = await uploadStore.load()
  if (uploadEntries.length) {
    log.info(`loaded ${uploadEntries.length} uploaded-file registry ${uploadEntries.length === 1 ? 'entry' : 'entries'} from ${stateDir}`)
  }
```

Directly after the `const sessionManager = new SessionManager({ ... })` block, add:

```ts
  // Seed the uploads registry from sessions' on-disk claude-web-uploads/
  // folders. Idempotent (path-keyed) — safe on every boot; deleted entries
  // never resurrect because every delete also unlinks the file.
  const backfilled = await uploadStore.backfillFromSessions(sessionManager.list())
  if (backfilled > 0) {
    log.info(`backfilled ${backfilled} upload ${backfilled === 1 ? 'entry' : 'entries'} from session cwds`)
  }
```

In the `buildApp({ ... })` call, add `uploadStore,` directly after the existing `snippetStore,` line.

- [ ] **Step 4: Typecheck + full test suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck passes (both tsconfigs); full vitest run passes with no new failures.

- [ ] **Step 5: Commit**

```bash
git add server/routes/index.ts server/app.ts server/cli.ts
git commit -m "feat(server): wire UploadStore through buildApp, api router, and CLI boot backfill"
```

---

### Task 4: useUploads client hook

**Files:**
- Create: `src/hooks/useUploads.ts`
- Test: `src/hooks/useUploads.test.ts`

**Interfaces:**
- Consumes: `api.get` / `api.delete` from `src/hooks/useApi.ts`; `UploadListItem`, `UploadsListResponse` from `shared/uploads.ts`.
- Produces (used by Task 5): `useUploads(open: boolean): UseUploads` where

```ts
interface UseUploads {
  uploads: UploadListItem[] | null // null = initial load in flight
  error: string | null
  refresh: () => Promise<void>
  remove: (id: string) => Promise<void>       // DELETE + refresh
  removeMany: (ids: string[]) => Promise<void> // sequential DELETEs + one refresh
}
```

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useUploads.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// ── Mock useApi ─────────────────────────────────────────────────────
const mockGet = vi.fn()
const mockDelete = vi.fn()

vi.mock('./useApi', () => ({
  api: {
    get: (...a: unknown[]) => mockGet(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}))

// Import AFTER the mock.
import { useUploads } from './useUploads'

const ENTRIES = [
  { id: 'a', path: '/p/claude-web-uploads/1-a.txt', cwd: '/p', name: 'a.txt', size: 10, uploadedAt: 1, sessionTitle: 'S', exists: true },
  { id: 'b', path: '/p/claude-web-uploads/2-b.txt', cwd: '/p', name: 'b.txt', size: 20, uploadedAt: 2, sessionTitle: 'S', exists: false },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ uploads: ENTRIES })
  mockDelete.mockResolvedValue({ ok: true })
})

describe('useUploads', () => {
  it('does not fetch while closed', () => {
    renderHook(() => useUploads(false))
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('fetches on open and exposes the list', async () => {
    const { result } = renderHook(() => useUploads(true))
    await waitFor(() => expect(result.current.uploads).toEqual(ENTRIES))
    expect(mockGet).toHaveBeenCalledWith('/uploads')
    expect(result.current.error).toBeNull()
  })

  it('exposes fetch errors and keeps uploads null', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useUploads(true))
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.uploads).toBeNull()
  })

  it('remove() deletes then refreshes', async () => {
    const { result } = renderHook(() => useUploads(true))
    await waitFor(() => expect(result.current.uploads).not.toBeNull())

    await act(() => result.current.remove('a'))
    expect(mockDelete).toHaveBeenCalledWith('/uploads/a')
    expect(mockGet).toHaveBeenCalledTimes(2) // initial + refresh
  })

  it('removeMany() deletes sequentially then refreshes once', async () => {
    const { result } = renderHook(() => useUploads(true))
    await waitFor(() => expect(result.current.uploads).not.toBeNull())

    mockGet.mockClear()
    await act(() => result.current.removeMany(['a', 'b']))
    expect(mockDelete).toHaveBeenCalledTimes(2)
    expect(mockGet).toHaveBeenCalledTimes(1) // single refresh after the batch
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useUploads.test.ts`
Expected: FAIL — cannot resolve `./useUploads`.

- [ ] **Step 3: Implement**

Create `src/hooks/useUploads.ts`:

```ts
// Client data layer for the Uploads Manager dialog.
//
// Fetch-on-open sync model (same as the snippets manager): the list is
// fetched when `open` flips true and refetched after every mutation. No
// WebSocket subscription — uploads change rarely and the dialog is the
// only consumer.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './useApi'
import type { UploadListItem, UploadsListResponse } from '../../shared/uploads'

export interface UseUploads {
  /** null = initial load in flight. */
  uploads: UploadListItem[] | null
  error: string | null
  refresh: () => Promise<void>
  remove: (id: string) => Promise<void>
  removeMany: (ids: string[]) => Promise<void>
}

export function useUploads(open: boolean): UseUploads {
  const [uploads, setUploads] = useState<UploadListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<UploadsListResponse>('/uploads')
      setUploads(res.uploads)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const remove = useCallback(
    async (id: string) => {
      await api.delete(`/uploads/${encodeURIComponent(id)}`)
      await refresh()
    },
    [refresh],
  )

  // Sequential deletes (registry sizes are small), one refresh at the end.
  const removeMany = useCallback(
    async (ids: string[]) => {
      for (const id of ids) {
        await api.delete(`/uploads/${encodeURIComponent(id)}`)
      }
      await refresh()
    },
    [refresh],
  )

  return useMemo(
    () => ({ uploads, error, refresh, remove, removeMany }),
    [uploads, error, refresh, remove, removeMany],
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useUploads.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useUploads.ts src/hooks/useUploads.test.ts
git commit -m "feat(client): useUploads fetch-on-open hook for the uploads manager"
```

---

### Task 5: UploadsManagerDialog + styles + component tests

**Files:**
- Create: `src/components/UploadsManagerDialog.tsx`
- Create: `src/components/UploadsManagerDialog.test.tsx`
- Create: `src/styles/uploads-manager.css`
- Modify: `src/styles/index.css` (one `@import` line)

**Interfaces:**
- Consumes: `useUploads` (Task 4), `Overlay` (`variant="perm"`, props `open` / `onClose` / `ariaLabel` / `cardClassName`), `ConfirmDialog` (`title`, `message`, `confirmLabel`, `destructive`, `busy`, `onConfirm`, `onCancel`), `useToast` (`toast.success/error`), `formatBytes` + `formatRelativeTime` from `src/utils/format`, `UploadListItem`.
- Produces (used by Task 6): `UploadsManagerDialog({ open?: boolean, onClose: () => void })`.

- [ ] **Step 1: Write the failing component test**

Create `src/components/UploadsManagerDialog.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const mockGet = vi.fn()
const mockDelete = vi.fn()
const mockToast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }

vi.mock('../hooks/useApi', () => ({
  api: {
    get: (...a: unknown[]) => mockGet(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}))
vi.mock('../hooks/useToast', () => ({
  useToast: () => mockToast,
}))

// Import AFTER the mocks.
import { UploadsManagerDialog } from './UploadsManagerDialog'

const ROWS = [
  { id: 'a', path: '/p/claude-web-uploads/1-a.txt', cwd: '/p', name: 'a.txt', size: 1024, uploadedAt: Date.now(), sessionTitle: 'Alpha', exists: true },
  { id: 'b', path: '/p/claude-web-uploads/2-b.txt', cwd: '/p', name: 'b.txt', size: 2048, uploadedAt: Date.now(), sessionTitle: 'Beta', exists: false },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ uploads: ROWS })
  mockDelete.mockResolvedValue({ ok: true })
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})
afterEach(cleanup)

describe('UploadsManagerDialog', () => {
  it('renders rows, stats, and the missing badge', async () => {
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    expect(screen.getByText(/2 files/)).toBeTruthy()
    expect(screen.getByText(/missing/i, { selector: '.uploads-missing-badge' })).toBeTruthy()
  })

  it('filter narrows rows by name / cwd / session title', async () => {
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(/filter/i), { target: { value: 'Beta' } })
    expect(screen.queryByText('a.txt')).toBeNull()
    expect(screen.getByText('b.txt')).toBeTruthy()
  })

  it('empty state when there are no uploads', async () => {
    mockGet.mockResolvedValue({ uploads: [] })
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/no files uploaded yet/i)).toBeTruthy())
  })

  it('error state with retry', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'))
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy())
    mockGet.mockResolvedValue({ uploads: ROWS })
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
  })

  it('copy path writes the absolute path to the clipboard', async () => {
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /copy path/i })[0])
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/p/claude-web-uploads/1-a.txt'),
    )
    expect(mockToast.success).toHaveBeenCalled()
  })

  it('delete flow: row Delete opens ConfirmDialog, confirming deletes + refetches', async () => {
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())

    // Row buttons say "Delete file"; the ConfirmDialog's confirm button is the
    // only accessible name exactly "Delete" once the dialog is open.
    fireEvent.click(screen.getAllByRole('button', { name: /^delete file$/i })[0])
    // ConfirmDialog mounted with the file path in the message.
    expect(screen.getByText('/p/claude-web-uploads/1-a.txt')).toBeTruthy()
    expect(screen.queryByText('b.txt')).toBeTruthy() // list still behind the confirm

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/uploads/a'))
    expect(mockGet).toHaveBeenCalledTimes(2) // initial + refresh
  })

  it('clean missing entries: button only when missing rows exist; batch deletes each', async () => {
    render(<UploadsManagerDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/clean missing entries/i)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /clean missing entries/i }))
    fireEvent.click(screen.getByRole('button', { name: /clean 1 entry/i }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/uploads/b'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/UploadsManagerDialog.test.tsx`
Expected: FAIL — cannot resolve `./UploadsManagerDialog`.

- [ ] **Step 3: Implement the dialog**

Create `src/components/UploadsManagerDialog.tsx`:

```tsx
// Uploads Manager dialog — app-level inventory of composer file uploads.
//
// Lists every recorded upload (path-keyed registry on the server) with
// provenance (cwd tail + session title snapshot), per-row Copy path /
// Delete, a "Clean missing entries" batch action, and client-derived
// usage stats. Fetch-on-open via useUploads — no WS subscription.
//
// Shell reuses the Overlay 'perm' variant (.perm-overlay/.perm-card) and
// the modal-header/modal-section family, so dark/light theming comes from
// the shared sheets; only the row layout gets scoped CSS
// (src/styles/uploads-manager.css).

import { useMemo, useState } from 'react'
import { Overlay } from './Overlay'
import { ConfirmDialog } from './ConfirmDialog'
import { useToast } from '../hooks/useToast'
import { useUploads } from '../hooks/useUploads'
import { formatBytes, formatRelativeTime } from '../utils/format'
import type { UploadListItem } from '../../shared/uploads'
import {
  IconCopy,
  IconFolderSearch,
  IconLoader,
  IconTrash,
  IconX,
} from './icons/ToolIcons'

interface Props {
  open?: boolean
  onClose: () => void
}

export function UploadsManagerDialog({ open = true, onClose }: Props) {
  const { uploads, error, refresh, remove, removeMany } = useUploads(open)
  const toast = useToast()

  const [filter, setFilter] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<UploadListItem | null>(null)
  const [cleanMissingOpen, setCleanMissingOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => {
    const list = uploads ?? []
    const q = filter.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.cwd.toLowerCase().includes(q) ||
        u.sessionTitle.toLowerCase().includes(q),
    )
  }, [uploads, filter])

  const stats = useMemo(() => {
    const list = uploads ?? []
    return {
      count: list.length,
      bytes: list.reduce((s, u) => s + u.size, 0),
      missing: list.filter((u) => !u.exists).length,
    }
  }, [uploads])

  const copyPath = async (u: UploadListItem) => {
    try {
      await navigator.clipboard.writeText(u.path)
      toast.success('Path copied')
    } catch {
      toast.error('Copy failed — select the path manually.')
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await remove(deleteTarget.id)
      setDeleteTarget(null)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirmCleanMissing = async () => {
    if (!uploads) return
    const ids = uploads.filter((u) => !u.exists).map((u) => u.id)
    setBusy(true)
    try {
      await removeMany(ids)
      toast.success(`Removed ${ids.length} missing ${ids.length === 1 ? 'entry' : 'entries'}`)
      setCleanMissingOpen(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** Tail of the cwd for display: last two segments. */
  const cwdTail = (cwd: string) => {
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join('/')}`
  }

  return (
    <Overlay variant="perm" open={open} onClose={onClose} ariaLabel="Uploaded files" cardClassName="uploads-manager-card">
      <div className="modal-header">
        <h3>
          <IconFolderSearch size={16} aria-hidden /> Uploaded files
        </h3>
        <span className="uploads-stats">
          {stats.count} {stats.count === 1 ? 'file' : 'files'} · {formatBytes(stats.bytes)}
        </span>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close">
          <IconX size={16} />
        </button>
      </div>

      {uploads === null && error === null && (
        <div className="modal-section uploads-state">
          <IconLoader size={16} className="composer-send-spinner" /> Loading…
        </div>
      )}

      {error !== null && (
        <div className="modal-section uploads-state">
          <span>{error}</span>
          <button type="button" className="btn" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}

      {uploads !== null && uploads.length === 0 && (
        <div className="modal-section uploads-state uploads-empty">
          No files uploaded yet. Attach files from any composer's paperclip.
        </div>
      )}

      {uploads !== null && uploads.length > 0 && (
        <>
          <div className="modal-section uploads-toolbar">
            <input
              className="input"
              type="text"
              placeholder="Filter by name, cwd, or session…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter uploads"
            />
            {stats.missing > 0 && (
              <button type="button" className="btn" onClick={() => setCleanMissingOpen(true)}>
                Clean missing entries
              </button>
            )}
          </div>

          <div className="uploads-list">
            {rows.length === 0 && <div className="uploads-state">No uploads match the filter.</div>}
            {rows.map((u) => (
              <div key={u.id} className={`uploads-row${u.exists ? '' : ' uploads-row-missing'}`}>
                <div className="uploads-row-main">
                  <span className="uploads-name">
                    {u.name}
                    {!u.exists && <span className="uploads-missing-badge">missing</span>}
                  </span>
                  <span className="uploads-meta" title={u.path}>
                    {formatBytes(u.size)} · {cwdTail(u.cwd)}
                    {u.sessionTitle ? ` · ${u.sessionTitle}` : ''} ·{' '}
                    {formatRelativeTime(new Date(u.uploadedAt).toISOString())}
                  </span>
                </div>
                <div className="uploads-row-actions">
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="Copy absolute path"
                    aria-label="Copy path"
                    onClick={() => void copyPath(u)}
                  >
                    <IconCopy size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="Delete file"
                    aria-label="Delete file"
                    onClick={() => setDeleteTarget(u)}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete uploaded file?"
          message={
            <>
              This permanently deletes the file from disk:
              <br />
              <code>{deleteTarget.path}</code>
            </>
          }
          confirmLabel="Delete"
          destructive
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {cleanMissingOpen && (
        <ConfirmDialog
          title="Clean missing entries?"
          message={
            <>
              {stats.missing} registry {stats.missing === 1 ? 'entry' : 'entries'} point to files
              that no longer exist on disk. They will be removed from the list (the files are
              already gone).
            </>
          }
          confirmLabel={`Clean ${stats.missing} ${stats.missing === 1 ? 'entry' : 'entries'}`}
          destructive
          busy={busy}
          onConfirm={() => void confirmCleanMissing()}
          onCancel={() => setCleanMissingOpen(false)}
        />
      )}
    </Overlay>
  )
}
```

- [ ] **Step 4: Add the styles**

Create `src/styles/uploads-manager.css` (theme variables only — no hex):

```css
/* Uploads Manager dialog (UploadsManagerDialog). Shell chrome comes from
   the shared .perm-card / .modal-header / .modal-section / .input / .btn
   classes — only the list layout is scoped here. */

.uploads-manager-card {
  width: min(720px, 92vw);
  max-height: min(640px, 85vh);
  display: flex;
  flex-direction: column;
}

.uploads-manager-card .modal-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.uploads-manager-card .modal-header h3 {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  margin-right: auto;
}

.uploads-stats {
  color: var(--fg-muted);
  font-size: 12px;
  white-space: nowrap;
}

.uploads-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--fg-muted);
  padding: 24px 16px;
  justify-content: center;
}

.uploads-empty {
  text-align: center;
}

.uploads-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 16px;
}

.uploads-toolbar .input {
  flex: 1;
}

.uploads-list {
  overflow-y: auto;
  padding: 0 8px 12px;
  min-height: 0;
}

.uploads-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
}

.uploads-row:hover {
  background: var(--btn-hover-bg);
}

.uploads-row-missing .uploads-name {
  color: var(--fg-muted);
  text-decoration: line-through;
}

.uploads-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.uploads-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.uploads-missing-badge {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--danger);
  border: 1px solid var(--danger);
  border-radius: 4px;
  padding: 0 4px;
  line-height: 14px;
}

.uploads-meta {
  color: var(--fg-muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.uploads-row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
```

Add the import to `src/styles/index.css` directly after the `@import './usage-panel.css';` line:

```css
@import './uploads-manager.css';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/UploadsManagerDialog.test.tsx src/hooks/useUploads.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/UploadsManagerDialog.tsx src/components/UploadsManagerDialog.test.tsx src/styles/uploads-manager.css src/styles/index.css
git commit -m "feat(client): Uploads Manager dialog with stats, filter, copy-path, delete, clean-missing"
```

---

### Task 6: Header entry + App mount

**Files:**
- Modify: `src/App.tsx` (import, state, presence, button, dialog render)

**Interfaces:**
- Consumes: `UploadsManagerDialog({ open, onClose })` (Task 5); `IconFolderSearch` from `./components/icons/ToolIcons`; `useExitPresence(open)` → `{ shouldRender, isExiting }`.

- [ ] **Step 1: Add the import**

Extend the existing icon import (line ~41):

```ts
import { IconSettings, IconBellToggle, IconMenu, IconSidebar, IconFolderSearch } from './components/icons/ToolIcons'
```

Add the component import near the other dialog imports:

```ts
import { UploadsManagerDialog } from './components/UploadsManagerDialog'
```

- [ ] **Step 2: State + presence**

Next to `const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)` (line ~243):

```ts
  const [uploadsDialogOpen, setUploadsDialogOpen] = useState(false)
```

Next to `const globalSettingsPresence = useExitPresence(globalSettingsOpen)` (line ~296):

```ts
  const uploadsDialogPresence = useExitPresence(uploadsDialogOpen)
```

- [ ] **Step 3: Header button**

Inside the `<div className="main-toolbar" role="group" aria-label="App actions">` block, between the `<AppearancePanel … />` element and the Global Settings `<button>`:

```tsx
            <button
              className="btn btn-icon"
              onClick={() => setUploadsDialogOpen(true)}
              title="Uploaded files"
              aria-label="Uploaded files"
            >
              <IconFolderSearch size={16} />
            </button>
```

- [ ] **Step 4: Dialog mount**

Directly after the `{globalSettingsPresence.shouldRender && ( … )}` block (near line 3995):

```tsx
      {uploadsDialogPresence.shouldRender && (
        <UploadsManagerDialog
          open={uploadsDialogOpen}
          onClose={() => setUploadsDialogOpen(false)}
        />
      )}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green.

Manual verification (`npm run dev`, open http://localhost:5174):
1. Upload a file via a composer paperclip; click the new header button — the dialog lists it with size, cwd tail, session title, "just now".
2. Copy path → paste somewhere → it is the absolute path.
3. Delete the file out-of-band in the file explorer → reopen the dialog → the row shows the `missing` badge and "Clean missing entries" appears; clean it → row gone.
4. Delete a row via the dialog → file is gone from `<cwd>/claude-web-uploads/`.
5. Restart the server (`npm run dev`) — the list is stable (registry persisted; backfill idempotent).
6. Toggle light/dark theme — the dialog uses theme variables throughout.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(client): header entry + mount for the Uploads Manager dialog"
```

---

## Self-Review (completed during plan writing)

- **Spec coverage:** registry store (Task 1), POST recording + GET exists + DELETE by id + chips sync (Task 2), boot backfill + wiring (Task 3), copy-path reuse without composer injection (Tasks 4-5), stats + filter + missing badge + batch clean (Task 5), header entry (Task 6), ConfirmDialog on destructive ops (Task 5), theme-variable CSS (Task 5), tests at store/route/hook/component levels (Tasks 1, 2, 4, 5).
- **Placeholder scan:** none — every code step carries full file content.
- **Type consistency:** `UploadEntry`/`UploadListItem`/`UploadsListResponse` spelled identically across Tasks 1/2/4/5; `buildUploadRouter(sm, uploadStore?)` consistent between Tasks 2 and 3; `useUploads(open)` return shape consistent between Tasks 4 and 5; `Overlay` props (`variant`/`open`/`onClose`/`ariaLabel`/`cardClassName`) match the SnippetsManagerDialog call site verified in the codebase.
