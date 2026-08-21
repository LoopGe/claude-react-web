# MCP 配置导入 / 导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add export (download a JSON file of the app's global MCP servers) and import (batch-add from a JSON file with preview + conflict prompts) to the MCP Servers settings tab.

**Architecture:** Three new endpoints on the existing `/api/mcp-config` router (`GET /export`, `POST /import/preview`, `POST /import`). A versioned JSON envelope (`claude-react-web-mcp`) is the interchange format; `env`/`headers` are blanked by default and included only when the user opts in. Import is server-authoritative — the file text is re-parsed and validated on the server (mirroring the existing `claude-import` pattern). Client adds two dialogs (`McpExportDialog`, `McpImportDialog`) to the MCP tab header.

**Tech Stack:** Hono router (server), React 19 + Vite (client), vitest (server unit + client jsdom tests), `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-08-21-mcp-import-export-design.md`

## Global Constraints

- OAuth tokens are **never** exported — the export serializer builds a fresh object picking only known fields, so `oauth` cannot leak.
- Export defaults to `secretScope: 'masked'` — `env`/`headers` values become `''`; `includeSecrets=1` keeps real values.
- Import **drops `env`/`headers` entries whose value is `''`** (masked files don't create empty entries, and don't clobber existing secrets on overwrite).
- Import overwrite semantics: scalar fields (type/command/args/url/alwaysLoad/enabled) fully replaced; `env`/`headers` merged with non-empty file values winning; `createdAt` preserved, `updatedAt` bumped.
- Import validates every entry server-side via `validateMcpServer` (command allowlist enforced) — invalid entries land in `failed`, never imported.
- Import accepts three input shapes: our envelope, a bare array, or a keyed object `{ name: {...} }`.
- `~/.claude.json` is never written.
- Never hardcode color hex values in CSS — use theme CSS variables.

---

### Task 1: Server export endpoint (`GET /api/mcp-config/export`)

**Files:**
- Modify: `shared/mcp-types.ts`
- Modify: `server/mcp-config.ts`
- Modify: `server/mcp-routes.ts`
- Test: `server/mcp-routes.test.ts`

**Interfaces:**
- Produces (from `shared/mcp-types.ts`):
  ```ts
  export interface McpExportServer {
    name: string
    type: 'stdio' | 'sse' | 'http'
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    alwaysLoad?: boolean
    enabled?: boolean
  }
  export interface McpExportFile {
    format: 'claude-react-web-mcp'
    version: 1
    exportedAt: number
    secretScope: 'masked' | 'full'
    servers: McpExportServer[]
  }
  ```
- Produces (from `server/mcp-config.ts`):
  - `toExportServers(servers: StoredMcpServer[], includeSecrets: boolean): McpExportServer[]`
  - `buildExportFile(servers: StoredMcpServer[], includeSecrets: boolean): McpExportFile`
- Consumes: existing `StoredMcpServer`, `store.list()`, `HttpError`, `safeJson`.

- [ ] **Step 1: Write the failing tests**

Add to `server/mcp-routes.test.ts`, inside the top-level `describe('mcp-config routes', ...)` block (imports already present; add `buildExportFile` import if needed — not required for route tests):

```ts
  // -------------------------------------------------------------------
  // GET /export
  // -------------------------------------------------------------------
  describe('GET /export', () => {
    it('masks env/headers by default and never includes oauth', async () => {
      store.upsert(makeServer({
        name: 'git', command: 'npx', args: ['-y', 'server-git'],
        env: { TOKEN: 'secret' },
      }))
      store.upsert(makeServer({
        name: 'remote', type: 'http', url: 'http://localhost:9999',
        headers: { Auth: 'Bearer xyz' },
        oauth: { tokens: { access_token: 'tok', token_type: 'Bearer' } },
      }))
      await store.flush()

      const res = await app().request('/export')
      expect(res.status).toBe(200)
      const body = await json(res) as Record<string, unknown>
      expect(body.format).toBe('claude-react-web-mcp')
      expect(body.version).toBe(1)
      expect(body.secretScope).toBe('masked')
      const servers = body.servers as Array<Record<string, unknown>>
      expect(servers).toHaveLength(2)
      const git = servers.find((s) => s.name === 'git')!
      expect(git.env).toEqual({ TOKEN: '' })
      expect(git).not.toHaveProperty('oauth')
      expect(git).not.toHaveProperty('createdAt')
      const remote = servers.find((s) => s.name === 'remote')!
      expect(remote.headers).toEqual({ Auth: '' })
      expect(remote).not.toHaveProperty('oauth')
    })

    it('includes real env/headers when includeSecrets=1', async () => {
      store.upsert(makeServer({ name: 'git', command: 'npx', env: { TOKEN: 'secret' } }))
      await store.flush()

      const res = await app().request('/export?includeSecrets=1')
      const body = await json(res) as Record<string, unknown>
      expect(body.secretScope).toBe('full')
      const git = (body.servers as Array<Record<string, unknown>>).find((s) => s.name === 'git')!
      expect(git.env).toEqual({ TOKEN: 'secret' })
    })

    it('filters by names and includes all when names omitted', async () => {
      store.upsert(makeServer({ name: 'a', command: 'node', args: ['a.js'] }))
      store.upsert(makeServer({ name: 'b', command: 'node', args: ['b.js'] }))
      await store.flush()

      const res = await app().request('/export?names=a')
      const body = await json(res) as Record<string, unknown>
      expect((body.servers as Array<Record<string, unknown>>).map((s) => s.name)).toEqual(['a'])

      const all = await app().request('/export')
      const allBody = await json(all) as Record<string, unknown>
      expect((allBody.servers as Array<Record<string, unknown>>).map((s) => s.name)).toEqual(['a', 'b'])
    })
  })
```

Add unit tests to `server/mcp-config.test.ts` (append a new `describe('buildExportFile / toExportServers', ...)` block — the file already imports from `./mcp-config.js`; add `buildExportFile` to that import):

```ts
  describe('buildExportFile / toExportServers', () => {
    it('strips oauth and metadata, blanking secret values in masked mode', () => {
      const server: StoredMcpServer = {
        name: 's', type: 'stdio', command: 'npx', args: ['-y', 'x'],
        env: { K: 'v' }, alwaysLoad: true, enabled: false,
        createdAt: 1, updatedAt: 2,
        oauth: { tokens: { access_token: 't', token_type: 'Bearer' } },
      }
      const file = buildExportFile([server], false)
      expect(file.format).toBe('claude-react-web-mcp')
      expect(file.secretScope).toBe('masked')
      expect(file.servers[0]).toEqual({
        name: 's', type: 'stdio', command: 'npx', args: ['-y', 'x'],
        env: { K: '' }, alwaysLoad: true, enabled: false,
      })
      expect(file.servers[0]).not.toHaveProperty('oauth')
      expect(file.servers[0]).not.toHaveProperty('createdAt')
    })

    it('keeps real env/headers in full mode', () => {
      const server: StoredMcpServer = {
        name: 's', type: 'sse', url: 'http://x', headers: { Auth: 'Bearer z' }, createdAt: 1, updatedAt: 1,
      }
      const file = buildExportFile([server], true)
      expect(file.secretScope).toBe('full')
      expect(file.servers[0].headers).toEqual({ Auth: 'Bearer z' })
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/mcp-routes.test.ts server/mcp-config.test.ts`
Expected: FAIL — `buildExportFile` is not exported, `/export` returns 404.

- [ ] **Step 3: Add the shared types**

In `shared/mcp-types.ts`, append:

```ts
/** One server entry inside an export file — a config snapshot only:
 *  no timestamps, no OAuth state. */
export interface McpExportServer {
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  alwaysLoad?: boolean
  enabled?: boolean
}

/** Versioned export file envelope. */
export interface McpExportFile {
  format: 'claude-react-web-mcp'
  version: 1
  exportedAt: number
  secretScope: 'masked' | 'full'
  servers: McpExportServer[]
}

/** One entry in the import preview (masked + import status). */
export interface McpImportPreviewServer {
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  alwaysLoad?: boolean
  enabled?: boolean
  envKeys?: string[]
  headerKeys?: string[]
  errors: string[]
  exists: boolean
}

/** Result of POST /import. */
export interface McpImportResult {
  imported: string[]
  updated: string[]
  skipped: string[]
  failed: { name: string; error: string }[]
}
```

- [ ] **Step 4: Add the serialization helpers to `server/mcp-config.ts`**

At the top of the file, extend the shared-types import. Change:

```ts
export type { McpServerInput } from '../shared/mcp-types'
```

to:

```ts
export type { McpServerInput } from '../shared/mcp-types'
import type { McpExportFile, McpExportServer } from '../shared/mcp-types'
```

(Keep both — the re-export stays; the `import type` adds the new types.)

Append near the other helpers (after `validateMcpServer`):

```ts
/** Serialize stored servers into export entries. In masked mode every
 *  env/header value becomes ''; oauth and timestamps are never included. */
export function toExportServers(servers: StoredMcpServer[], includeSecrets: boolean): McpExportServer[] {
  return servers.map((s) => {
    const out: McpExportServer = { name: s.name, type: s.type }
    if (s.command !== undefined) out.command = s.command
    if (s.args !== undefined) out.args = s.args
    if (s.url !== undefined) out.url = s.url
    if (s.alwaysLoad !== undefined) out.alwaysLoad = s.alwaysLoad
    if (s.enabled !== undefined) out.enabled = s.enabled
    if (s.env && Object.keys(s.env).length > 0) {
      out.env = includeSecrets ? { ...s.env } : Object.fromEntries(Object.keys(s.env).map((k) => [k, '']))
    }
    if (s.headers && Object.keys(s.headers).length > 0) {
      out.headers = includeSecrets ? { ...s.headers } : Object.fromEntries(Object.keys(s.headers).map((k) => [k, '']))
    }
    return out
  })
}

/** Build a versioned export file envelope from stored servers. */
export function buildExportFile(servers: StoredMcpServer[], includeSecrets: boolean): McpExportFile {
  return {
    format: 'claude-react-web-mcp',
    version: 1,
    exportedAt: Date.now(),
    secretScope: includeSecrets ? 'full' : 'masked',
    servers: toExportServers(servers, includeSecrets),
  }
}
```

- [ ] **Step 5: Add the export route to `server/mcp-routes.ts`**

Extend the imports from `./mcp-config.js` (add `buildExportFile`):

```ts
import {
  McpConfigStore,
  buildExportFile,
  clearMcpOAuth,
  coerceStoredMcpServer,
  finishMcpOAuth,
  maskSecrets,
  startMcpOAuth,
  testMcpConnection,
  validateMcpServer,
  type StoredMcpServer,
  type McpServerInput,
  type MaskedMcpServer,
} from './mcp-config.js'
```

Add the route **after** the `GET /claude-import` block (before the OAuth callback block). Register it with a literal path before `GET /:name` so the param route can't capture it:

```ts
  // ── Export ───────────────────────────────────────────────────────
  /** GET /export — serialize the configured servers as a versioned JSON
   *  envelope. `includeSecrets=1` keeps real env/header values; oauth is
   *  never exported. Optional `names=a,b,c` filters. */
  app.get('/export', (c) => {
    const rawNames = c.req.query('names')
    const names = rawNames ? rawNames.split(',').map((n) => n.trim()).filter(Boolean) : undefined
    const includeSecrets = c.req.query('includeSecrets') === '1'
    let servers = store.list()
    if (names && names.length > 0) {
      const set = new Set(names)
      servers = servers.filter((s) => set.has(s.name))
    }
    return c.json(buildExportFile(servers, includeSecrets))
  })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/mcp-routes.test.ts server/mcp-config.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add shared/mcp-types.ts server/mcp-config.ts server/mcp-routes.ts server/mcp-routes.test.ts server/mcp-config.test.ts
git commit -m "feat(mcp): export configured servers as a versioned JSON file"
```

---

### Task 2: Server import preview (`POST /api/mcp-config/import/preview`)

**Files:**
- Modify: `server/mcp-routes.ts`
- Test: `server/mcp-routes.test.ts`

**Interfaces:**
- Produces: `parseImportFile(file: string): Array<{ key: string; raw: unknown }>` (throws `HttpError(400, ...)` on unparseable/empty input) — module-local in `mcp-routes.ts`.
- Produces: route `POST /api/mcp-config/import/preview` → `{ servers: McpImportPreviewServer[] }`.
- Consumes: `coerceStoredMcpServer`, `maskSecrets`, `validateMcpServer` (all already imported in `mcp-routes.ts`), `McpImportPreviewServer`.
- (No new `mcp-config.ts` helpers in this task — `coerceImportServer` lands in Task 3 where the import route needs it. The preview keeps env/header **keys** visible by masking the raw coerced server *before* empty-value dropping.)

- [ ] **Step 1: Write the failing tests**

Add to `server/mcp-routes.test.ts`:

```ts
  // -------------------------------------------------------------------
  // POST /import/preview
  // -------------------------------------------------------------------
  describe('POST /import/preview', () => {
    it('parses a bare array and flags exists + invalid entries', async () => {
      store.upsert(makeServer({ name: 'already', command: 'node' }))
      await store.flush()

      const file = JSON.stringify([
        { name: 'fresh', type: 'stdio', command: 'npx', args: ['-y', 'x'] },
        { name: 'already', type: 'stdio', command: 'node' },
        { name: 'bad', type: 'stdio' }, // no command
      ])
      const res = await app().request('/import/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      const servers = body.servers as Array<Record<string, unknown>>
      expect(servers).toHaveLength(3)
      const fresh = servers.find((s) => s.name === 'fresh')!
      expect(fresh.exists).toBe(false)
      expect(fresh.errors).toEqual([])
      const already = servers.find((s) => s.name === 'already')!
      expect(already.exists).toBe(true)
      const bad = servers.find((s) => s.name === 'bad')!
      expect((bad.errors as string[]).length).toBeGreaterThan(0)
      // preview never returns secret values
      expect(fresh).not.toHaveProperty('env')
    })

    it('parses the app envelope and a keyed object', async () => {
      const envelope = JSON.stringify({
        format: 'claude-react-web-mcp', version: 1, exportedAt: 1, secretScope: 'masked',
        servers: [{ name: 'env-srv', type: 'stdio', command: 'node', env: { K: '' } }],
      })
      const res1 = await app().request('/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: envelope }),
      })
      const body1 = await json(res1)
      expect((body1.servers as Array<Record<string, unknown>>)[0].name).toBe('env-srv')
      // masked env values keep their KEYS visible so the UI can hint re-entry
      expect((body1.servers as Array<Record<string, unknown>>)[0].envKeys).toEqual(['K'])

      const keyed = JSON.stringify({ 'kv-srv': { type: 'sse', url: 'http://x' } })
      const res2 = await app().request('/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: keyed }),
      })
      const body2 = await json(res2)
      expect((body2.servers as Array<Record<string, unknown>>)[0].name).toBe('kv-srv')
    })

    it('returns 400 for malformed JSON or an empty file', async () => {
      const res = await app().request('/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'not json' }),
      })
      expect(res.status).toBe(400)

      const empty = await app().request('/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: '{}' }),
      })
      expect(empty.status).toBe(400)
    })
  })
```

Note: `{}` parses as a keyed object with zero entries — the spec says "servers array empty → 400". Implement that in the route (Step 3): after building `entries`, if `entries.length === 0` throw 400.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/mcp-routes.test.ts`
Expected: FAIL — `/import/preview` returns 404.

- [ ] **Step 3: Add `parseImportFile` and the preview route to `server/mcp-routes.ts`**

No new `./mcp-config.js` imports are needed — `coerceStoredMcpServer`, `maskSecrets`, and `validateMcpServer` are already imported at the top. Add the parser helper (module-level, after `readClaudeMcpServers`):

```ts
/** Parse an import file into { key, raw } entries. Accepts three shapes:
 *  the app envelope ({ format | servers }), a bare array, or a keyed
 *  object. Throws HttpError(400) for unparseable/empty input. */
function parseImportFile(file: string): Array<{ key: string; raw: unknown }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(file)
  } catch {
    throw new HttpError(400, 'Not valid JSON')
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>
    if ('format' in rec || 'servers' in rec) {
      if (!Array.isArray(rec.servers)) throw new HttpError(400, 'Envelope "servers" must be an array')
      return rec.servers.map((raw, i) => ({ key: `server[${i}]`, raw }))
    }
    return Object.entries(rec).map(([key, raw]) => ({ key, raw }))
  }
  if (Array.isArray(parsed)) {
    return parsed.map((raw, i) => ({ key: `server[${i}]`, raw }))
  }
  throw new HttpError(400, 'Expected an array or object of MCP servers')
}

/** Build a preview entry (masked) for one parsed import entry. Masks the raw
 *  coerced server BEFORE empty-value dropping, so env/header KEYS from a
 *  masked export stay visible (the UI hints which secrets need re-entry).
 *  Error set matches what POST /import will report (coerceImportServer's
 *  empty-drop adds no errors). */
function previewImportEntry(
  entry: { key: string; raw: unknown },
  store: McpConfigStore,
): McpImportPreviewServer {
  const maybe = coerceStoredMcpServer(entry.raw, entry.key)
  const base = maybe ? maskSecrets(maybe) : null
  if (!base) {
    return { name: entry.key, type: 'stdio', errors: ['could not parse server entry'], exists: false }
  }
  return {
    name: base.name,
    type: base.type,
    command: base.command,
    args: base.args,
    url: base.url,
    alwaysLoad: base.alwaysLoad,
    enabled: base.enabled,
    envKeys: base.envKeys,
    headerKeys: base.headerKeys,
    errors: validateMcpServer(maybe),
    exists: !!store.get(base.name),
  }
}
```

Add `McpImportPreviewServer` to the shared-types import at the top of `mcp-routes.ts`:

```ts
import type { McpImportPreviewServer } from '../shared/mcp-types'
```

Add the preview route after the export route:

```ts
  // ── Import preview ───────────────────────────────────────────────
  /** POST /import/preview — parse + validate an import file and return a
   *  masked preview so the UI can render new / conflict / invalid sections. */
  app.post('/import/preview', async (c) => {
    const body = await safeJson<{ file?: unknown }>(c.req)
    if (typeof body?.file !== 'string') throw new HttpError(400, 'file must be a string')
    const entries = parseImportFile(body.file)
    if (entries.length === 0) throw new HttpError(400, 'No MCP servers found in file')
    return c.json({ servers: entries.map((entry) => previewImportEntry(entry, store)) })
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/mcp-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/mcp-routes.ts server/mcp-routes.test.ts
git commit -m "feat(mcp): import preview endpoint parses and validates candidate servers"
```

---

### Task 3: Server import (`POST /api/mcp-config/import`)

**Files:**
- Modify: `server/mcp-config.ts`
- Modify: `server/mcp-routes.ts`
- Test: `server/mcp-routes.test.ts`

**Interfaces:**
- Produces (from `server/mcp-config.ts`): `coerceImportServer(raw: unknown, fallbackName?: string): { server: StoredMcpServer } | { error: string }` and `applyImportedOverwrite(existing: StoredMcpServer, incoming: StoredMcpServer): StoredMcpServer` — both added in Step 3.
- Produces: route `POST /api/mcp-config/import` → `McpImportResult`.
- Consumes: `parseImportFile` (Task 2), `store.upsert`, `store.flush`.

- [ ] **Step 1: Write the failing tests**

Add to `server/mcp-routes.test.ts`:

```ts
  // -------------------------------------------------------------------
  // POST /import
  // -------------------------------------------------------------------
  describe('POST /import', () => {
    it('imports new servers, dropping empty env values, enabled default true', async () => {
      const file = JSON.stringify([
        { name: 'a', type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { KEEP: 'v', BLANK: '' } },
      ])
      const res = await app().request('/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, names: ['a'], overwrite: false }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.imported).toEqual(['a'])
      const stored = store.get('a')!
      expect(stored.enabled).toBe(true)
      expect(stored.env).toEqual({ KEEP: 'v' })
    })

    it('skips existing servers unless overwrite, and reports failed invalid entries', async () => {
      store.upsert(makeServer({ name: 'exists', command: 'node', args: ['old'] }))
      await store.flush()

      const file = JSON.stringify([
        { name: 'exists', type: 'stdio', command: 'python', args: ['new.py'] },
        { name: 'bad', type: 'stdio' },
        { name: 'ghost', type: 'stdio', command: 'node' },
      ])
      const res = await app().request('/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, names: ['exists', 'bad', 'ghost'], overwrite: false }),
      })
      const body = await json(res)
      expect(body.skipped).toEqual(['exists'])
      expect((body.failed as Array<{ name: string }>)[0].name).toBe('bad')
      expect(body.imported).toEqual(['ghost'])
      // skipped entry untouched
      expect(store.get('exists')?.args).toEqual(['old'])
    })

    it('overwrite replaces scalars and merges env/headers without clobbering masked blanks', async () => {
      store.upsert(makeServer({
        name: 's', command: 'node', args: ['old'], env: { SECRET: 'keepme', OLD: 'gone' }, enabled: false,
      }))
      await store.flush()

      // masked-style file: env has SECRET blanked to '' (must not clobber)
      const file = JSON.stringify([
        { name: 's', type: 'stdio', command: 'python', args: ['new.py'], env: { SECRET: '', NEW: 'added' }, enabled: true },
      ])
      const res = await app().request('/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, names: ['s'], overwrite: true }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.updated).toEqual(['s'])
      const stored = store.get('s')!
      expect(stored.command).toBe('python')
      expect(stored.args).toEqual(['new.py'])
      expect(stored.enabled).toBe(true)
      expect(stored.env).toEqual({ SECRET: 'keepme', NEW: 'added' })
      expect(stored.createdAt).toBe(1_700_000_000_000) // preserved
    })

    it('rejects non-allowlisted commands', async () => {
      const file = JSON.stringify([{ name: 'evil', type: 'stdio', command: 'rm' }])
      const res = await app().request('/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, names: ['evil'], overwrite: false }),
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      expect((body.failed as Array<{ name: string }>)[0].name).toBe('evil')
      expect(store.get('evil')).toBeUndefined()
    })

    it('round-trips a masked export through a fresh store import', async () => {
      store.upsert(makeServer({ name: 'git', command: 'npx', args: ['-y', 'server-git'], env: { TOKEN: 'secret' } }))
      await store.flush()
      const expRes = await app().request('/export')
      const file = await json(expRes)

      const dir2 = tempDir('mcp-roundtrip')
      const store2 = new McpConfigStore({ stateDir: dir2 })
      await store2.load()
      const app2 = buildMcpConfigRouter(store2)
      try {
        const res = await app2.request('/import', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: JSON.stringify(file), names: ['git'], overwrite: false }),
        })
        const body = await json(res)
        expect(body.imported).toEqual(['git'])
        const imported = store2.get('git')!
        expect(imported.name).toBe('git')
        expect(imported.command).toBe('npx')
        expect(imported.env).toBeUndefined() // masked values dropped
      } finally {
        rmSync(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      }
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/mcp-routes.test.ts`
Expected: FAIL — `/import` returns 404, `applyImportedOverwrite` not exported.

- [ ] **Step 3: Add `coerceImportServer` and `applyImportedOverwrite` to `server/mcp-config.ts`**

Append both after `validateMcpServer`:

```ts
/** Coerce + validate a raw import entry into a StoredMcpServer ready to
 *  store. Drops env/header entries whose value is '' (masked exports),
 *  so an overwrite can't clobber existing secrets with blanks. */
export function coerceImportServer(
  raw: unknown,
  fallbackName?: string,
): { server: StoredMcpServer } | { error: string } {
  const server = coerceStoredMcpServer(raw, fallbackName)
  if (!server) return { error: 'could not parse server entry' }
  const errors = validateMcpServer(server)
  if (errors.length > 0) return { error: errors.join('; ') }
  if (server.env) {
    const kept = Object.fromEntries(Object.entries(server.env).filter(([, v]) => v !== ''))
    if (Object.keys(kept).length > 0) server.env = kept
    else delete server.env
  }
  if (server.headers) {
    const kept = Object.fromEntries(Object.entries(server.headers).filter(([, v]) => v !== ''))
    if (Object.keys(kept).length > 0) server.headers = kept
    else delete server.headers
  }
  return { server }
}

/** Apply an imported server onto an existing stored server for overwrite.
 *  Scalar fields are replaced; env/headers merge with non-empty file values
 *  winning; createdAt preserved; updatedAt bumped. */
export function applyImportedOverwrite(existing: StoredMcpServer, incoming: StoredMcpServer): StoredMcpServer {
  const merged: StoredMcpServer = {
    ...existing,
    type: incoming.type,
    updatedAt: Date.now(),
  }
  if (incoming.command !== undefined) merged.command = incoming.command
  if (incoming.args !== undefined) merged.args = incoming.args
  if (incoming.url !== undefined) merged.url = incoming.url
  if (incoming.alwaysLoad !== undefined) merged.alwaysLoad = incoming.alwaysLoad
  if (incoming.enabled !== undefined) merged.enabled = incoming.enabled
  if (incoming.env) merged.env = { ...(existing.env ?? {}), ...incoming.env }
  if (incoming.headers) merged.headers = { ...(existing.headers ?? {}), ...incoming.headers }
  return merged
}
```

- [ ] **Step 4: Add the import route to `server/mcp-routes.ts`**

Extend the import from `./mcp-config.js` to add **both** `coerceImportServer` and `applyImportedOverwrite` (the route calls both). Add `McpImportResult` to the shared-types import. Add the route after the preview route:

```ts
  // ── Import ───────────────────────────────────────────────────────
  /** POST /import — import selected servers from an import file. Re-parses
   *  the file server-side (never trusts the client), validates each entry,
   *  skips existing names unless overwrite, and persists immediately. */
  app.post('/import', async (c) => {
    const body = await safeJson<{ file?: unknown; names?: unknown; overwrite?: unknown }>(c.req)
    if (typeof body?.file !== 'string') throw new HttpError(400, 'file must be a string')
    if (!Array.isArray(body.names) || !body.names.every((n) => typeof n === 'string')) {
      throw new HttpError(400, 'names must be an array of strings')
    }
    const overwrite = body.overwrite === true
    const requested = new Set((body.names as string[]).filter((n) => n.trim().length > 0))

    const entries = parseImportFile(body.file)
    const byName = new Map<string, { key: string; raw: unknown }>()
    for (const entry of entries) {
      const server = coerceStoredMcpServer(entry.raw, entry.key)
      if (server && !byName.has(server.name)) byName.set(server.name, entry)
    }

    const imported: string[] = []
    const updated: string[] = []
    const skipped: string[] = []
    const failed: { name: string; error: string }[] = []
    let dirty = false
    for (const name of requested) {
      const entry = byName.get(name)
      if (!entry) {
        failed.push({ name, error: 'not found in import file' })
        continue
      }
      const res = coerceImportServer(entry.raw, entry.key)
      if ('error' in res) {
        failed.push({ name, error: res.error })
        continue
      }
      const incoming = res.server
      const existing = store.get(name)
      if (existing) {
        if (!overwrite) {
          skipped.push(name)
          continue
        }
        store.upsert(applyImportedOverwrite(existing, incoming))
        updated.push(name)
      } else {
        store.upsert({
          ...incoming,
          name,
          enabled: incoming.enabled ?? true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        imported.push(name)
      }
      dirty = true
    }
    if (dirty) await store.flush()
    return c.json({ imported, updated, skipped, failed } satisfies McpImportResult)
  })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/mcp-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/mcp-config.ts server/mcp-routes.ts server/mcp-routes.test.ts
git commit -m "feat(mcp): import endpoint with server-authoritative validation and overwrite semantics"
```

---

### Task 4: Client download util + Export dialog

**Files:**
- Create: `src/utils/downloadJson.ts`
- Create: `src/components/McpExportDialog.tsx`
- Create: `src/components/McpExportDialog.test.tsx`
- Modify: `src/types.ts` (re-export the new shared MCP types)
- Modify: `src/components/GlobalSettingsModal.tsx`

**Interfaces:**
- Produces: `downloadJson(filename: string, data: unknown): void`
- Produces: `McpExportDialog` props `{ open?: boolean; servers: McpServerConfigMeta[]; onClose: () => void }`
- Consumes: `api.get<McpExportFile>(path)`, `McpServerConfigMeta` (from `src/types`), `McpExportFile` (re-exported from `src/types`), `Overlay`.
- GlobalSettingsModal wiring: add `onExport`/`onImport` props to `McpTab`; `McpTab` renders `Import` + `Export` buttons in the header row; parent holds `showMcpExport` state.

- [ ] **Step 1: Write the failing client tests**

Create `src/components/McpExportDialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { McpExportDialog } from './McpExportDialog'
import type { McpServerConfigMeta } from '../types'

const { downloadJson } = vi.hoisted(() => ({ downloadJson: vi.fn() }))

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))
vi.mock('../utils/downloadJson', () => ({ downloadJson }))

import { api } from '../hooks/useApi'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const servers: McpServerConfigMeta[] = [
  { name: 'git', type: 'stdio', command: 'npx', createdAt: 1, updatedAt: 1 },
  { name: 'fs', type: 'stdio', command: 'node', createdAt: 1, updatedAt: 1 },
]

describe('McpExportDialog', () => {
  it('requests all servers by default and triggers a download', async () => {
    const mockGet = vi.mocked(api.get).mockResolvedValue({ format: 'claude-react-web-mcp', version: 1, exportedAt: 1, secretScope: 'masked', servers: [] })
    render(<McpExportDialog open servers={servers} onClose={vi.fn()} />)

    fireEvent.click(document.body.querySelector('.btn-primary')!)

    expect(mockGet).toHaveBeenCalledWith('/mcp-config/export')
    await waitFor(() =>
      expect(downloadJson).toHaveBeenCalledWith('claude-react-web-mcp-servers.json', expect.objectContaining({ format: 'claude-react-web-mcp' })),
    )
  })

  it('filters by the selected subset and appends includeSecrets when checked', async () => {
    const mockGet = vi.mocked(api.get).mockResolvedValue({ format: 'claude-react-web-mcp', version: 1, exportedAt: 1, secretScope: 'full', servers: [] })
    render(<McpExportDialog open servers={servers} onClose={vi.fn()} />)

    const checkboxes = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    // first server checkbox, then fs checkbox, then includeSecrets checkbox
    const fsCheckbox = checkboxes[1]
    fireEvent.click(fsCheckbox) // uncheck fs
    const secretsCheckbox = checkboxes[2]
    fireEvent.click(secretsCheckbox) // check include secrets

    fireEvent.click(document.body.querySelector('.btn-primary')!)

    expect(mockGet).toHaveBeenCalledWith('/mcp-config/export?includeSecrets=1&names=git')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/McpExportDialog.test.tsx`
Expected: FAIL — module `./McpExportDialog` does not exist.

- [ ] **Step 3: Re-export the new shared MCP types from `src/types.ts`**

In `src/types.ts`, right after the existing `export type { McpServerInput } from '../shared/mcp-types'` line, add:

```ts
export type {
  McpExportFile,
  McpExportServer,
  McpImportPreviewServer,
  McpImportResult,
} from '../shared/mcp-types'
```

(The client components import these from `../types` to match the existing convention — `McpInstaller` imports `McpServerInput` from `../types` — instead of reaching into `shared/` directly.)

- [ ] **Step 4: Create `src/utils/downloadJson.ts`**

```ts
/** Serialize `data` as pretty JSON and trigger a browser download. */
export function downloadJson(filename: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 5: Create `src/components/McpExportDialog.tsx`**

```tsx
// Modal for exporting the configured MCP servers as a versioned JSON file.
// Lets the user pick which servers to export and whether to include secret
// env/header values.

import { useEffect, useMemo, useState } from 'react'
import { api } from '../hooks/useApi'
import { downloadJson } from '../utils/downloadJson'
import type { McpServerConfigMeta, McpExportFile } from '../types'
import { Overlay } from './Overlay'
import { IconX } from './icons/ToolIcons'

interface Props {
  open?: boolean
  servers: McpServerConfigMeta[]
  onClose: () => void
}

export function McpExportDialog({ open = true, servers, onClose }: Props) {
  const names = useMemo(() => servers.map((s) => s.name), [servers])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset to all-checked whenever the server list or open state changes.
  useEffect(() => {
    setSelected(Object.fromEntries(names.map((n) => [n, true])))
  }, [names, open])

  const selectedCount = names.filter((n) => selected[n]).length

  const download = async () => {
    const chosen = names.filter((n) => selected[n])
    if (chosen.length === 0) return
    setError(null)
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (includeSecrets) params.set('includeSecrets', '1')
      if (chosen.length !== names.length) params.set('names', chosen.join(','))
      const qs = params.toString()
      const data = await api.get<McpExportFile>(qs ? `/mcp-config/export?${qs}` : '/mcp-config/export')
      downloadJson('claude-react-web-mcp-servers.json', data)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Overlay
      variant="modal"
      portal
      open={open}
      onClose={onClose}
      inertOnExit
      cardStyle={{ width: 'min(520px, 92vw)' }}
      ariaLabel="Export MCP servers"
    >
      <div className="modal-header">
        <h3>Export MCP Servers</h3>
        <button className="btn" onClick={onClose} style={{ padding: '2px 10px' }} aria-label="Close"><IconX size={14} /></button>
      </div>
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '60vh', overflowY: 'auto' }}>
        <div className="settings-section-head" style={{ alignItems: 'center' }}>
          <span className="settings-note">{servers.length} server{servers.length !== 1 ? 's' : ''}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setSelected(Object.fromEntries(names.map((n) => [n, true])))}>Select all</button>
            <button className="btn" onClick={() => setSelected(Object.fromEntries(names.map((n) => [n, false])))}>Select none</button>
          </div>
        </div>
        {servers.length === 0 && <div className="hint">No MCP servers configured.</div>}
        {servers.map((srv) => (
          <label key={srv.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={!!selected[srv.name]}
              onChange={(e) => setSelected((prev) => ({ ...prev, [srv.name]: e.target.checked }))}
            />
            <span style={{ fontWeight: 500 }}>{srv.name}</span>
            <span className="settings-card-badge">{srv.type}</span>
          </label>
        ))}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
          Include secret values (env/headers)
        </label>
        {!includeSecrets && (
          <span className="settings-note">Secrets will be blanked — re-enter them on the target machine.</span>
        )}
        {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <span className="hint">Press Esc to cancel.</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void download()} disabled={exporting || selectedCount === 0}>
            {exporting ? 'Exporting…' : 'Download'}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
```

- [ ] **Step 6: Run the client tests to verify they pass**

Run: `npx vitest run src/components/McpExportDialog.test.tsx`
Expected: PASS.

- [ ] **Step 7: Wire into `src/components/GlobalSettingsModal.tsx`**

Add state near the other dialog state (line ~179):

```tsx
  const [showMcpExport, setShowMcpExport] = useState(false)
```

Pass new props to `McpTab` (the invocation around line 497-506) — add after `onRefresh={refreshMcp}`:

```tsx
                  onExport={() => setShowMcpExport(true)}
```

(Import wiring comes in Task 5.)

Update the `McpTab` signature and header (definition around line 1264-1296) to accept `onExport` and render an Export button:

```tsx
function McpTab({
  servers, onAdd, onEdit, onDelete, onToggle, onRefresh, onExport,
}: {
  servers: McpServerConfigMeta[]
  onAdd: () => void
  onEdit: (s: McpServerConfigMeta) => void
  onDelete: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
  onRefresh: () => void | Promise<void>
  onExport: () => void
}) {
  return (
    <>
      <div className="settings-section-head settings-mcp-head">
        <span className="settings-note settings-mcp-count">
          {servers.length} server{servers.length !== 1 ? 's' : ''} configured
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onExport}>Export</button>
          <button className="btn" onClick={onAdd}>+ Add Server</button>
        </div>
      </div>
      {/* ...rest unchanged... */}
```

Add `McpExportDialog` to the lazy imports at the top (next to `McpInstaller`, line ~28):

```tsx
const McpExportDialog = lazy(() =>
  import('./McpExportDialog').then((m) => ({ default: m.McpExportDialog })),
)
```

Render the dialog inside the modal body, next to the existing `McpInstaller` block (after the `mcpInstallerPresence.shouldRender` block, ~line 564). It does not need `useExitPresence` — use direct conditional:

```tsx
        {showMcpExport && (
          <Suspense fallback={null}>
            <McpExportDialog
              open={showMcpExport}
              servers={mcpServers}
              onClose={() => setShowMcpExport(false)}
            />
          </Suspense>
        )}
```

- [ ] **Step 8: Typecheck + lint + run the touched client test**

Run: `npm run typecheck && npm run lint && npx vitest run src/components/McpExportDialog.test.tsx`
Expected: no errors, test PASS.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/utils/downloadJson.ts src/components/McpExportDialog.tsx src/components/McpExportDialog.test.tsx src/components/GlobalSettingsModal.tsx
git commit -m "feat(mcp): export dialog with per-server selection and optional secrets"
```

---

### Task 5: Client Import dialog

**Files:**
- Create: `src/components/McpImportDialog.tsx`
- Create: `src/components/McpImportDialog.test.tsx`
- Modify: `src/components/GlobalSettingsModal.tsx`

**Interfaces:**
- Produces: `McpImportDialog` props `{ open?: boolean; file: File | null; onClose: () => void; onImported: () => void }`
- Consumes: `api.post<{ servers: McpImportPreviewServer[] }>('/mcp-config/import/preview', { file })`, `api.post<McpImportResult>('/mcp-config/import', { file, names, overwrite })`, `Overlay`.
- GlobalSettingsModal wiring: `McpTab` gains `onImport` prop + `Import` button; parent holds `showMcpImport` state + a hidden file input that captures the selected `File`.

- [ ] **Step 1: Write the failing client test**

Create `src/components/McpImportDialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { McpImportDialog } from './McpImportDialog'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))
import { api } from '../hooks/useApi'

afterEach(() => { cleanup(); vi.clearAllMocks() })

function makeFile(content: string): File {
  return new File([content], 'servers.json', { type: 'application/json' })
}

describe('McpImportDialog', () => {
  it('previews new/conflict/invalid sections and imports the checked selection', async () => {
    const preview = {
      servers: [
        { name: 'fresh', type: 'stdio', command: 'npx', errors: [], exists: false },
        { name: 'exists', type: 'stdio', command: 'node', errors: [], exists: true },
        { name: 'bad', type: 'stdio', errors: ['command is required for stdio type'], exists: false },
      ],
    }
    const importResult = { imported: ['fresh'], updated: [], skipped: ['exists'], failed: [] }
    vi.mocked(api.post)
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(importResult)

    const onImported = vi.fn()
    render(<McpImportDialog open file={makeFile(JSON.stringify({ servers: preview.servers }))} onClose={vi.fn()} onImported={onImported} />)

    // preview renders all three names
    await waitFor(() => expect(document.body.textContent).toContain('fresh'))
    expect(document.body.textContent).toContain('exists')
    expect(document.body.textContent).toContain('bad')

    // fresh (new) + exists (conflict) + "overwrite all existing" — the
    // invalid row renders with no checkbox
    const checkboxes = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    expect(checkboxes).toHaveLength(3)
    expect(checkboxes[0].checked).toBe(true) // fresh (new) default checked
    expect(checkboxes[1].checked).toBe(false) // exists (conflict) default unchecked
    expect(checkboxes[2].checked).toBe(false) // "overwrite all existing" toggle

    // check the conflict row to overwrite it, then import
    fireEvent.click(checkboxes[1])
    fireEvent.click(document.body.querySelector('.btn-primary')!)

    await waitFor(() =>
      expect(api.post).toHaveBeenLastCalledWith('/mcp-config/import', {
        file: expect.stringContaining('fresh'),
        names: ['fresh', 'exists'],
        overwrite: true,
      }),
    )
    // summary shown
    await waitFor(() => expect(document.body.textContent).toContain('Imported: 1'))
    expect(onImported).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/McpImportDialog.test.tsx`
Expected: FAIL — module `./McpImportDialog` does not exist.

- [ ] **Step 3: Create `src/components/McpImportDialog.tsx`**

```tsx
// Modal for importing MCP servers from a JSON file. Receives the chosen
// File from the parent, posts it to /import/preview to get a masked preview,
// renders new / conflict / invalid sections, then posts the checked
// selection to /import.

import { useEffect, useState } from 'react'
import { api } from '../hooks/useApi'
import type { McpImportPreviewServer, McpImportResult } from '../types'
import { Overlay } from './Overlay'
import { IconX } from './icons/ToolIcons'

interface Props {
  open?: boolean
  file: File | null
  onClose: () => void
  onImported: () => void
}

type Phase = 'loading' | 'preview' | 'importing' | 'summary'

export function McpImportDialog({ open = true, file, onClose, onImported }: Props) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [preview, setPreview] = useState<McpImportPreviewServer[]>([])
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [fileText, setFileText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<McpImportResult | null>(null)

  // Load + preview the file each time the dialog opens with a file present.
  useEffect(() => {
    if (!open || !file) return
    let cancelled = false
    setPhase('loading')
    setError(null)
    setSummary(null)
    void (async () => {
      try {
        const text = await file.text()
        if (cancelled) return
        setFileText(text)
        const r = await api.post<{ servers: McpImportPreviewServer[] }>('/mcp-config/import/preview', { file: text })
        if (cancelled) return
        setPreview(r.servers)
        setChecked(Object.fromEntries(
          r.servers.filter((s) => s.errors.length === 0).map((s) => [s.name, !s.exists]),
        ))
        setPhase('preview')
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message)
        setPhase('preview')
      }
    })()
    return () => { cancelled = true }
  }, [open, file])

  const newServers = preview.filter((s) => s.errors.length === 0 && !s.exists)
  const conflicts = preview.filter((s) => s.errors.length === 0 && s.exists)
  const invalid = preview.filter((s) => s.errors.length > 0)

  const checkedNames = preview.filter((s) => checked[s.name]).map((s) => s.name)
  const anyConflictChecked = conflicts.some((s) => checked[s.name])
  const validSelected = checkedNames.length > 0

  const toggleConflict = (value: boolean) => {
    setChecked((prev) => ({ ...prev, ...Object.fromEntries(conflicts.map((s) => [s.name, value])) }))
  }

  const doImport = async () => {
    if (checkedNames.length === 0) return
    setPhase('importing')
    setError(null)
    try {
      const r = await api.post<McpImportResult>('/mcp-config/import', {
        file: fileText,
        names: checkedNames,
        overwrite: anyConflictChecked,
      })
      setSummary(r)
      setPhase('summary')
      onImported()
    } catch (e) {
      setError((e as Error).message)
      setPhase('preview')
    }
  }

  return (
    <Overlay
      variant="modal"
      portal
      open={open}
      onClose={onClose}
      inertOnExit
      cardStyle={{ width: 'min(560px, 92vw)' }}
      ariaLabel="Import MCP servers"
    >
      <div className="modal-header">
        <h3>Import MCP Servers</h3>
        <button className="btn" onClick={onClose} style={{ padding: '2px 10px' }} aria-label="Close"><IconX size={14} /></button>
      </div>

      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '62vh', overflowY: 'auto' }}>
        {phase === 'loading' && <div className="hint">Reading file…</div>}

        {phase === 'preview' && error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

        {phase === 'preview' && !error && preview.length === 0 && (
          <div className="hint">No servers found in this file.</div>
        )}

        {phase === 'preview' && !error && (
          <>
            {newServers.length > 0 && (
              <>
                <div className="settings-note">New servers</div>
                {newServers.map((s) => (
                  <ImportRow key={s.name} srv={s} checked={!!checked[s.name]} onToggle={(v) => setChecked((prev) => ({ ...prev, [s.name]: v }))} />
                ))}
              </>
            )}

            {conflicts.length > 0 && (
              <div className="settings-card" style={{ borderColor: 'var(--warn)' }}>
                <div className="settings-note" style={{ color: 'var(--warn)' }}>
                  Already exist — checking a row will overwrite it
                </div>
                {conflicts.map((s) => (
                  <ImportRow key={s.name} srv={s} checked={!!checked[s.name]} onToggle={(v) => setChecked((prev) => ({ ...prev, [s.name]: v }))} />
                ))}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 4 }}>
                  <input type="checkbox" checked={conflicts.length > 0 && conflicts.every((s) => checked[s.name])} onChange={(e) => toggleConflict(e.target.checked)} />
                  Overwrite all existing
                </label>
              </div>
            )}

            {invalid.length > 0 && (
              <>
                <div className="settings-note" style={{ color: 'var(--danger)' }}>Invalid (skipped)</div>
                {invalid.map((s) => (
                  <div key={s.name} className="settings-card" style={{ borderColor: 'var(--danger)', opacity: 0.7 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                      <span style={{ fontWeight: 500 }}>{s.name}</span>
                      <span style={{ color: 'var(--danger)', fontSize: 12 }}>{s.errors.join('; ')}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {phase === 'summary' && summary && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <div>Imported: {summary.imported.length}</div>
            <div>Updated: {summary.updated.length}</div>
            <div>Skipped: {summary.skipped.length}</div>
            {summary.failed.length > 0 && (
              <div style={{ color: 'var(--danger)' }}>
                Failed: {summary.failed.map((f) => `${f.name}: ${f.error}`).join('; ')}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="modal-footer">
        <span className="hint">Press Esc to cancel.</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onClose}>
            {phase === 'summary' ? 'Done' : 'Cancel'}
          </button>
          {phase === 'preview' && !error && (
            <button className="btn btn-primary" onClick={() => void doImport()} disabled={!validSelected}>
              {validSelected ? `Import ${checkedNames.length}` : 'Import'}
            </button>
          )}
        </div>
      </div>
    </Overlay>
  )
}

function ImportRow({ srv, checked, onToggle }: {
  srv: McpImportPreviewServer
  checked: boolean
  onToggle: (v: boolean) => void
}) {
  const secretKeys = [...(srv.envKeys ?? []), ...(srv.headerKeys ?? [])]
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
      <span style={{ fontWeight: 500 }}>{srv.name}</span>
      <span className="settings-card-badge">{srv.type}</span>
      {secretKeys.length > 0 && (
        <span className="settings-note" style={{ fontSize: 11, marginLeft: 'auto' }}>
          needs: {secretKeys.join(', ')}
        </span>
      )}
    </label>
  )
}
```

- [ ] **Step 4: Run the client test to verify it passes**

Run: `npx vitest run src/components/McpImportDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into `src/components/GlobalSettingsModal.tsx`**

Add state near `showMcpExport`:

```tsx
  const [showMcpImport, setShowMcpImport] = useState(false)
  const [mcpImportFile, setMcpImportFile] = useState<File | null>(null)
  const mcpImportInputRef = useRef<HTMLInputElement>(null)
```

Pass `onImport` to `McpTab`:

```tsx
                  onImport={() => mcpImportInputRef.current?.click()}
```

Add `onImport` to `McpTab` props and render the Import button before Export in the header:

```tsx
  onImport: () => void
  // header buttons:
  <button className="btn" onClick={onImport}>Import</button>
  <button className="btn" onClick={onExport}>Export</button>
```

Add the lazy import:

```tsx
const McpImportDialog = lazy(() =>
  import('./McpImportDialog').then((m) => ({ default: m.McpImportDialog })),
)
```

Render the hidden file input and the dialog (near the `McpExportDialog` render):

```tsx
        <input
          ref={mcpImportInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) { setMcpImportFile(f); setShowMcpImport(true) }
            e.target.value = ''
          }}
        />
        {showMcpImport && (
          <Suspense fallback={null}>
            <McpImportDialog
              open={showMcpImport}
              file={mcpImportFile}
              onClose={() => setShowMcpImport(false)}
              onImported={() => void refreshMcp()}
            />
          </Suspense>
        )}
```

- [ ] **Step 6: Typecheck + lint + run the client test**

Run: `npm run typecheck && npm run lint && npx vitest run src/components/McpImportDialog.test.tsx`
Expected: no errors, test PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/McpImportDialog.tsx src/components/McpImportDialog.test.tsx src/components/GlobalSettingsModal.tsx
git commit -m "feat(mcp): import dialog with preview, conflict surfacing, and overwrite"
```

---

### Task 6: Full-suite verification

**Files:**
- None (verification only; fix anything surfaced).

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: all pass, including the new `mcp-routes.test.ts` export/import/preview tests, `mcp-config.test.ts` helper tests, and both client dialog tests.

- [ ] **Step 2: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual smoke check (optional)**

Run: `npm run dev`, open Settings → MCP Servers. Add a server, click Export → Download, confirm the JSON file downloads with the selected servers and masked secrets. Click Import → choose the downloaded file → confirm the preview lists it as "Already exist" (conflict) and that importing with overwrite updates it. (Manual, no commit.)
