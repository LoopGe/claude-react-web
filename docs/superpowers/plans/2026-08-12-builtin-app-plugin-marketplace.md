# Built-in App Plugin Marketplace + subdir support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a user's first-ever launch, the App Plugin Marketplace automatically shows a fully-populated "Claude React Web Plugins" entry that reads the official plugins straight from the installed `dist/plugins/` dir — instant, offline, no runtime git clone — and respects removal (delete stays deleted). In addition, marketplaces whose catalog lives in a **subdirectory** of their root are supported end-to-end (parser, records, install, refresh, add-API), so `https://github.com/LoopGe/claude-react-web` (catalog at `plugins/`) also works for existing users.

**Architecture:** `build.mjs` copies `plugins/` → `dist/plugins/` at build time (already shipped by `"files": ["dist"]`). A new `server/app-plugins/builtin-marketplace.ts` resolves that dir at runtime and seeds a single `local`-source marketplace record on first launch (store file absent). The marketplace store gains `local` source support (`coerceRecord`, `isFirstRun`, `seedBuiltinIfFirstRun`) and stops deleting local dirs on removal. A new optional `subdir` field on marketplace records threads through the parser (`parseAppPluginMarketplace(root, subdir?)`, `pluginDirInClone(root, dir, subdir?)`), the manager's `resolveInstallSource`, and the routes (add/refresh/install), so a marketplace can keep its catalog in a nested dir. Refresh branches on source type (local re-parses, https git-pulls). The client renders a "Bundled" label for local entries and shows `subdir` on https entries. No `package.json` changes.

**Tech Stack:** Node 20 ESM, Hono, esbuild (`build.mjs`), React 19 + Vite client, vitest (`server/**`, `plugins/**` run in node; `src/**` mostly jsdom), TypeScript (`npm run typecheck` runs both `tsconfig.json` and `tsconfig.node.json`).

## Global Constraints

- Node `>=20`, ESM (`"type": "module"`). All new server imports use explicit `.js` extensions for relative ESM paths.
- `@anthropic-ai/claude-agent-sdk` is external to the bundle — never import it from server code touched here.
- Server diagnostics go through `createLogger('scope')` — never bare `console.*` for diagnostics. `builtin-marketplace.ts` uses `createLogger('app-plugins:builtin')`; the store uses `createLogger('app-plugins:mp-store')`; the parser uses `createLogger('app-plugins:mp-parser')`.
- Typecheck = `npm run typecheck` (both tsconfigs) — must pass after every task.
- Tests = `npm test` (vitest run, `maxWorkers: 2`). Run targeted files with `npx vitest run <file>` during tasks.
- Every git commit ends with `Co-Authored-By: Claude <noreply@anthropic.com>`. Never commit unreviewed code. `src/App.tsx` has an **unrelated uncommitted change** — never `git add` it (add only the specific files each commit touches).
- **No `package.json` changes.** The parser (`marketplace-parser.ts`) and manager (`app-plugin-manager.ts`) DO change in Task 3 — subdir support only; no other behavior changes there.
- Path security: every `subdir` value must pass `validateRelativePath(subdir, { isWindows: process.platform === 'win32' })` (from `shared/app-plugins/path-security.ts`) — relative, no `..`/absolute, no device names. Reject (or throw on) anything else. Same treatment the parser already gives plugin `dir` entries.
- CSS: no new colors in this work (client change reuses existing `.app-plugins-state` / `.app-plugins-meta` classes).
- Don't change `plugins/app-plugins-marketplace.json` shape — only Task 7 may add an entry.

---

### Task 1: Build — copy `plugins/` into `dist/plugins/`

**Files:**
- Modify: `build.mjs:7` (import) and `build.mjs:37` (after the chmod line)
- No test file (build script — verified by running the build and asserting the output).

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `dist/plugins/` directory at build time — consumed by Task 4's `resolveBundledPluginsDir()` (candidate `join(here, 'plugins')`).

- [ ] **Step 1: Write the verification command (the "test")**

There is no unit test harness for `build.mjs` (it's a top-level ESM script). The TDD cycle here is a build + filesystem assertion. First, confirm the current build output has NO `dist/plugins/`:

```bash
node build.mjs
test -e dist/plugins && echo "PRESENT (unexpected)" || echo "ABSENT (expected before change)"
```

Expected: the `node build.mjs` line completes (esbuild logs `✔ Built dist/cli.mjs`), then `ABSENT (expected before change)`.

- [ ] **Step 2: Add the copy step**

Edit `build.mjs:7` — add `cpSync` to the node:fs import:

```js
import { mkdirSync, writeFileSync, readFileSync, chmodSync, cpSync } from 'node:fs'
```

Edit the end of `build.mjs` (after the `chmodSync(path, 0o755)` line, before the final `console.log`):

```js
// Ship the official App Plugin marketplace with the package so the built-in
// marketplace works offline without a runtime git clone. Test files excluded.
cpSync('plugins', 'dist/plugins', {
  recursive: true,
  filter: (src) => !/\.test\.(ts|js|tsx|jsx)$/.test(src),
})
```

- [ ] **Step 3: Run the build and verify the copy**

```bash
node build.mjs
test -f dist/plugins/app-plugins-marketplace.json && echo "OK catalog"
test -f dist/plugins/translator/crw-plugin.json && echo "OK translator manifest"
test -f dist/plugins/idle-compact/crw-plugin.json && echo "OK idle-compact manifest"
test ! -e dist/plugins/translator/translate.test.ts && echo "OK test file excluded"
```

Expected: all four `OK` lines. The filter uses a suffix regex on the source path (relative or absolute both match at the end), so `plugins/translator/translate.test.ts` is excluded while `dist/service.mjs` files are copied.

- [ ] **Step 4: Commit**

```bash
git add build.mjs
git commit -m "feat: ship official app plugin marketplace in dist

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Shared types + store — `local` source, `subdir`, seed-once, never delete local dirs

**Files:**
- Modify: `shared/app-plugins/marketplace.ts`
- Modify: `server/app-plugins/marketplace-store.ts`
- Modify: `server/app-plugins/marketplace-routes.ts` (only `toInfo`, required for typecheck)
- Create: `server/app-plugins/marketplace-store.test.ts`

**Interfaces:**
- Consumes: `JsonFileStore` base (`file` is `protected readonly`, `flush()`, `has()`, `upsert()`, `remove()` — see `server/json-file-store.ts`). `rm` from `node:fs/promises` is already imported in the store. `validateRelativePath(rel, opts): string | null` from `shared/app-plugins/path-security.ts`.
- Produces:
  - `type AppPluginMarketplaceSource = { type: 'https'; url: string; ref?: string } | { type: 'local'; path: string }`
  - `AppPluginMarketplaceRecord.source: AppPluginMarketplaceSource`; `AppPluginMarketplaceRecord.subdir?: string`
  - `AppPluginMarketplaceInfo`: `sourceType: 'https' | 'local'`, `url?: string`, `subdir?: string`, rest unchanged.
  - `AppPluginMarketplaceStore.isFirstRun(): boolean`
  - `AppPluginMarketplaceStore.seedBuiltinIfFirstRun(record: AppPluginMarketplaceRecord): Promise<boolean>`
  - `AppPluginMarketplaceStore.removeEntry(id)` — now only `rm`s `cloneDir` when `source.type === 'https'`.
  - `coerceRecord` (module-private) accepts optional validated `subdir` and rejects invalid ones.
  - These are consumed by Task 3 (`record.subdir` in parser/manager), Task 4 (`seedBuiltinIfFirstRun`, `isFirstRun`) and Task 5 (`source.type`/`subdir` in routes).

- [ ] **Step 1: Write the failing store test**

Create `server/app-plugins/marketplace-store.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import type { AppPluginMarketplaceRecord } from '../../shared/app-plugins/marketplace.js'

function makeRecord(id: string, source: AppPluginMarketplaceRecord['source'], cloneDir: string): AppPluginMarketplaceRecord {
  const now = Date.now()
  return {
    id,
    displayName: id,
    source,
    cloneDir,
    addedAt: now,
    lastRefreshedAt: now,
    lastSha: '',
    manifest: { plugins: [] },
  }
}

describe('AppPluginMarketplaceStore — built-in seeding', () => {
  let stateDir: string
  let store: AppPluginMarketplaceStore

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mp-store-'))
    store = new AppPluginMarketplaceStore({ stateDir })
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('seedBuiltinIfFirstRun seeds + persists when the store file is absent', async () => {
    expect(store.isFirstRun()).toBe(true)
    const record = makeRecord('builtin', { type: 'local', path: join(stateDir, 'plugins') }, join(stateDir, 'plugins'))
    const seeded = await store.seedBuiltinIfFirstRun(record)
    expect(seeded).toBe(true)
    expect(store.get('builtin')).toBeDefined()
    // The explicit flush inside seedBuiltinIfFirstRun materialised the file.
    expect(store.isFirstRun()).toBe(false)
  })

  it('seedBuiltinIfFirstRun is a no-op when the store file already exists', async () => {
    const record = makeRecord('builtin', { type: 'local', path: join(stateDir, 'plugins') }, join(stateDir, 'plugins'))
    await store.seedBuiltinIfFirstRun(record)
    // Second call — the file now exists.
    const seededAgain = await store.seedBuiltinIfFirstRun(record)
    expect(seededAgain).toBe(false)
  })

  it('seedBuiltinIfFirstRun is a no-op when the id is already present', async () => {
    const record = makeRecord('builtin', { type: 'local', path: join(stateDir, 'plugins') }, join(stateDir, 'plugins'))
    store.upsert(record)
    // File may not exist yet (debounced) — the id check must still guard.
    const seeded = await store.seedBuiltinIfFirstRun(record)
    expect(seeded).toBe(false)
    await store.flush() // settle the pending debounced write before teardown
  })

  it('removeEntry deletes an https cloneDir but keeps a local one', async () => {
    const localDir = join(stateDir, 'plugins')
    const cloneDir = join(stateDir, 'clone')
    mkdirSync(localDir, { recursive: true })
    mkdirSync(cloneDir, { recursive: true })
    writeFileSync(join(localDir, 'marker.txt'), 'x')
    writeFileSync(join(cloneDir, 'marker.txt'), 'x')

    store.upsert(makeRecord('local', { type: 'local', path: localDir }, localDir))
    store.upsert(makeRecord('https', { type: 'https', url: 'https://example.com/x.git' }, cloneDir))
    await store.flush()

    await store.removeEntry('https')
    expect(existsSync(cloneDir)).toBe(false)

    await store.removeEntry('local')
    expect(existsSync(localDir)).toBe(true)
  })

  it('load coerces an optional valid subdir and drops an invalid one', async () => {
    const now = Date.now()
    mkdirSync(join(stateDir, 'app-plugins'), { recursive: true })
    writeFileSync(join(stateDir, 'app-plugins', 'marketplaces.json'), JSON.stringify({
      version: 1,
      marketplaces: {
        good: { id: 'good', displayName: 'Good', source: { type: 'https', url: 'https://example.com/g.git' }, subdir: 'plugins', cloneDir: join(stateDir, 'g'), addedAt: now, lastRefreshedAt: now, lastSha: '', manifest: { plugins: [] } },
        bad: { id: 'bad', displayName: 'Bad', source: { type: 'https', url: 'https://example.com/b.git' }, subdir: '../escape', cloneDir: join(stateDir, 'b'), addedAt: now, lastRefreshedAt: now, lastSha: '', manifest: { plugins: [] } },
      },
    }))
    await store.load()
    expect(store.get('good')?.subdir).toBe('plugins')
    expect(store.get('bad')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/app-plugins/marketplace-store.test.ts`
Expected: FAIL — `TypeError: store.seedBuiltinIfFirstRun is not a function` (methods don't exist yet), and the subdir-coerce test fails too (`good.subdir` undefined, `bad` present).

- [ ] **Step 3: Update the shared types**

Edit `shared/app-plugins/marketplace.ts`:

- Add the union type above the record interface:

```ts
/** Where a marketplace's plugin content comes from. `https` = a user-added
 *  cloned git repo; `local` = a bundled dir shipped with the app
 *  (dist/plugins/) that is read in place, never cloned. */
export type AppPluginMarketplaceSource =
  | { type: 'https'; url: string; ref?: string }
  | { type: 'local'; path: string }
```

- Change the record interface (line 27-40) — `source` becomes the union and add `subdir`:

```ts
/** A marketplace record persisted in the store (one per cloned repo). */
export interface AppPluginMarketplaceRecord {
  /** URL-safe slug used as the on-disk clone dir name + route :id. */
  id: string
  displayName: string
  source: AppPluginMarketplaceSource
  /** Optional relative path within cloneDir that holds the marketplace
   *  content (catalog + plugin dirs). The official host repo keeps its
   *  catalog in `plugins/`, so a marketplace seeded from it uses
   *  subdir: 'plugins'. Absent = content is at cloneDir root. */
  subdir?: string
  /** Absolute path to the cloned repo on disk. */
  cloneDir: string
  addedAt: number
  lastRefreshedAt: number
  /** HEAD SHA of the most recent successful clone/pull. */
  lastSha: string
  /** Cached parsed catalog. Refreshed on every clone/pull. */
  manifest: AppPluginMarketplaceManifest
}
```

- Change `AppPluginMarketplaceInfo` (line 43-52):

```ts
/** Client-facing marketplace DTO (no cloneDir / raw manifest blob). */
export interface AppPluginMarketplaceInfo {
  id: string
  displayName: string
  sourceType: 'https' | 'local'
  url?: string
  ref?: string
  subdir?: string
  addedAt: number
  lastRefreshedAt: number
  lastSha: string
  pluginCount: number
}
```

- [ ] **Step 4: Update the store** (`server/app-plugins/marketplace-store.ts`)

Line 9 — add `existsSync` to the `node:fs` import:

```ts
import { existsSync, promises as fs } from 'node:fs'
```

Add the path-security import (after line 14, the `createLogger` import):

```ts
import { validateRelativePath } from '../../shared/app-plugins/path-security.js'
```

Line 15 — import the new type:

```ts
import type { AppPluginMarketplaceRecord, AppPluginMarketplaceSource } from '../../shared/app-plugins/marketplace.js'
```

Add two methods to the `AppPluginMarketplaceStore` class (after `removeEntry`, before the closing brace at line 118):

```ts
  /** True when the store file has never been written — the boundary for the
   *  built-in marketplace seeding ("seed on first launch only"). */
  isFirstRun(): boolean {
    return !existsSync(this.file)
  }

  /** Seed the built-in marketplace record on the very first launch. Returns
   *  whether the record was actually seeded (no-op when the store file
   *  already exists or a record with the same id is present). The explicit
   *  flush guarantees the file exists after boot 1, which is exactly the
   *  "first run" boundary the next boot checks. */
  async seedBuiltinIfFirstRun(record: AppPluginMarketplaceRecord): Promise<boolean> {
    if (!this.isFirstRun()) return false
    if (this.has(record.id)) return false
    this.upsert(record)
    await this.flush()
    return true
  }
```

Change `removeEntry` (lines 95-106) to guard the clone-dir deletion:

```ts
  /** Hard-remove a marketplace: drop from index, recursively delete the
   *  clone dir. Filesystem errors are swallowed so a stale clone doesn't
   *  block removal. A `local` (bundled) marketplace points at app code
   *  (dist/plugins/) and its dir is never deleted. */
  async removeEntry(id: string): Promise<void> {
    const entry = this.get(id)
    this.remove(id)
    await this.flush()
    if (entry?.source.type === 'https' && entry.cloneDir) {
      try {
        await rm(entry.cloneDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (err) {
        log.warn(`failed to remove clone dir ${entry.cloneDir}: ${(err as Error).message}`)
      }
    }
  }
```

Replace `coerceRecord` (lines 122-146) so it builds the source union and coerces/validates `subdir`:

```ts
/** Coerce a raw JSON record into a trusted marketplace record. The file is
 *  hand-editable, so re-validate the source, subdir + cloneDir. */
function coerceRecord(raw: unknown, fallbackId: string): AppPluginMarketplaceRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id ? r.id : fallbackId
  const source = r.source as Record<string, unknown> | undefined
  if (!source) return null
  let coercedSource: AppPluginMarketplaceSource
  if (source.type === 'https' && typeof source.url === 'string') {
    coercedSource = {
      type: 'https',
      url: source.url,
      ref: typeof source.ref === 'string' ? source.ref : undefined,
    }
  } else if (source.type === 'local' && typeof source.path === 'string' && source.path) {
    coercedSource = { type: 'local', path: source.path }
  } else {
    return null
  }
  if (typeof r.cloneDir !== 'string' || !r.cloneDir) return null
  // Optional subdir: the marketplace content lives under cloneDir/subdir
  // (e.g. the official host repo keeps its catalog in plugins/). Must stay
  // contained — reject records that try to escape the clone.
  let coercedSubdir: string | undefined
  if (r.subdir !== undefined) {
    if (typeof r.subdir !== 'string' || !r.subdir) return null
    const subErr = validateRelativePath(r.subdir, { isWindows: process.platform === 'win32' })
    if (subErr) return null
    coercedSubdir = r.subdir
  }
  const manifest = (r.manifest && typeof r.manifest === 'object' && !Array.isArray(r.manifest)
    ? r.manifest
    : { plugins: [] }) as AppPluginMarketplaceRecord['manifest']
  return {
    id,
    displayName: typeof r.displayName === 'string' && r.displayName ? r.displayName : id,
    source: coercedSource,
    subdir: coercedSubdir,
    cloneDir: r.cloneDir,
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0,
    lastRefreshedAt: typeof r.lastRefreshedAt === 'number' ? r.lastRefreshedAt : 0,
    lastSha: typeof r.lastSha === 'string' ? r.lastSha : '',
    manifest,
  }
}
```

- [ ] **Step 5: Fix `toInfo` in the routes (typecheck requirement)**

`server/app-plugins/marketplace-routes.ts`, replace `toInfo` (lines 151-162) — the old `r.source.url` no longer typechecks on the union:

```ts
function toInfo(r: AppPluginMarketplaceRecord): AppPluginMarketplaceInfo {
  return {
    id: r.id,
    displayName: r.displayName,
    sourceType: r.source.type,
    url: r.source.type === 'https' ? r.source.url : undefined,
    ref: r.source.type === 'https' ? r.source.ref : undefined,
    subdir: r.subdir,
    addedAt: r.addedAt,
    lastRefreshedAt: r.lastRefreshedAt,
    lastSha: r.lastSha,
    pluginCount: r.manifest.plugins.length,
  }
}
```

- [ ] **Step 6: Run tests + typecheck to verify they pass**

Run: `npx vitest run server/app-plugins/marketplace-store.test.ts`
Expected: PASS (5 tests).

Run: `npm run typecheck`
Expected: PASS (both tsconfigs). Existing marketplace tests construct `source: { type: 'https', url }` which remains assignable to the union, so the app-plugins suite stays green too:

Run: `npx vitest run server/app-plugins/marketplace-routing.test.ts server/app-plugins/marketplace-install.test.ts server/app-plugins/marketplace-parser.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add shared/app-plugins/marketplace.ts server/app-plugins/marketplace-store.ts server/app-plugins/marketplace-routes.ts server/app-plugins/marketplace-store.test.ts
git commit -m "feat: support local source + subdir + seed-once in marketplace store

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Parser + manager — thread `subdir` through resolution

**Files:**
- Modify: `server/app-plugins/marketplace-parser.ts`
- Modify: `server/app-plugins/app-plugin-manager.ts` (one line in `resolveInstallSource`)
- Modify: `server/app-plugins/marketplace-parser.test.ts`
- Modify: `server/app-plugins/marketplace-install.test.ts`

**Interfaces:**
- Consumes:
  - `AppPluginMarketplaceRecord.subdir?: string` from Task 2.
  - `validateRelativePath(rel, opts): string | null` — already imported in the parser (line 15).
  - `resolvePluginDir`, `isPathInside`, `fs.realpath` already present in the manager.
- Produces:
  - `parseAppPluginMarketplace(repoRoot: string, subdir?: string): Promise<AppPluginMarketplaceManifest>` — parses `subdir ? join(repoRoot, subdir) : repoRoot` (manifest + auto-scan). Throws `Error` on an invalid (escaping) subdir.
  - `pluginDirInClone(repoRoot: string, dir: string, subdir?: string): string` — resolves `dir` inside the effective root.
  - `marketplaceRoot(repoRoot, subdir)` — private helper; the single validation point.
  - Manager `resolveInstallSource` resolves plugin dirs as `pluginDirInClone(mp.cloneDir, entry.dir, mp.subdir)`.
  - These are consumed by Task 5 (routes call the parser with `record.subdir`; install route delegates to the manager which now threads subdir).

- [ ] **Step 1: Write the failing parser + install tests**

Add a subdir describe block to `server/app-plugins/marketplace-parser.test.ts` (append before the closing of the file):

```ts
describe('parseAppPluginMarketplace — subdir', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mp-parse-sub-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })

  it('parses a marketplace whose catalog lives in a subdir', async () => {
    writePlugin(join(root, 'plugins', 'translator'), 'translator.claude-react-web')
    writeFileSync(join(root, 'plugins', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Nested Market',
      appPlugins: [{ name: 'translator', dir: 'translator' }],
    }))
    const res = await parseAppPluginMarketplace(root, 'plugins')
    expect(res.name).toBe('Nested Market')
    expect(res.plugins.map((p) => p.name)).toEqual(['translator'])
  })

  it('auto-scans the subdir when it has no manifest', async () => {
    writePlugin(join(root, 'plugins', 'alpha'), 'com.example.alpha')
    const res = await parseAppPluginMarketplace(root, 'plugins')
    expect(res.plugins.map((p) => p.name)).toEqual(['com.example.alpha'])
  })

  it('throws on an invalid (escaping) subdir', async () => {
    await expect(parseAppPluginMarketplace(root, '../escape')).rejects.toThrow(/subdir/)
  })

  it('pluginDirInClone resolves inside the subdir', () => {
    expect(pluginDirInClone(root, 'translator', 'plugins')).toBe(join(root, 'plugins', 'translator'))
  })
})
```

Add a subdir install test to `server/app-plugins/marketplace-install.test.ts` (append a new describe block after the existing one):

```ts
describe('AppPluginManager — marketplace install with subdir', () => {
  let stateDir: string
  let cloneDir: string
  let store: AppPluginStore
  let mpStore: AppPluginMarketplaceStore
  let manager: AppPluginManager

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mp-inst-sub-'))
    cloneDir = mkdtempSync(join(tmpdir(), 'mp-clone-sub-'))
    // Marketplace content lives under <clone>/plugins/ — the layout of the
    // official host repo (catalog is NOT at the clone root).
    writePlugin(join(cloneDir, 'plugins', 'translator'), 'translator.claude-react-web')
    writeFileSync(join(cloneDir, 'plugins', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Nested Market',
      appPlugins: [{ name: 'translator', dir: 'translator', description: 'translate', version: '1.0.0' }],
    }))
    store = new AppPluginStore({ stateDir })
    mpStore = new AppPluginMarketplaceStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub, marketplaceStore: mpStore })
    const now = Date.now()
    const record: AppPluginMarketplaceRecord = {
      id: 'sub-mp',
      displayName: 'Nested Market',
      source: { type: 'https', url: 'https://github.com/loopge/claude-react-web' },
      subdir: 'plugins',
      cloneDir,
      addedAt: now,
      lastRefreshedAt: now,
      lastSha: 'abc123',
      manifest: { name: 'Nested Market', plugins: [{ name: 'translator', dir: 'translator' }] },
    }
    mpStore.upsert(record)
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(cloneDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('installs a plugin from a subdir marketplace (content under clone/subdir)', async () => {
    const result = await manager.install({ type: 'marketplace', marketplaceId: 'sub-mp', pluginName: 'translator' })
    expect(result.id).toBe('translator.claude-react-web')
    const rec = store.get('translator.claude-react-web')!
    if (rec.source.type === 'marketplace') {
      expect(rec.source.marketplaceId).toBe('sub-mp')
      expect(rec.source.path).toBe(join(cloneDir, 'plugins', 'translator'))
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/app-plugins/marketplace-parser.test.ts server/app-plugins/marketplace-install.test.ts`
Expected: FAIL — the parser subdir tests fail (`parseAppPluginMarketplace` ignores the second arg → 0 plugins / no throw), and the install test fails (`pluginDirInClone` resolves to `<clone>/translator`, which doesn't exist → install throws).

- [ ] **Step 3: Update the parser**

`server/app-plugins/marketplace-parser.ts`:

- Change `parseAppPluginMarketplace` (lines 29-70) to take an optional `subdir` and parse the effective root:

```ts
/** Parse a marketplace clone. Returns the catalog (name + plugins). Throws
 *  on a malformed marketplace.json; an empty catalog (no plugins found) is
 *  a valid result, not an error. `subdir` is an optional contained relative
 *  path within `repoRoot` that holds the marketplace content (the official
 *  host repo keeps its catalog in `plugins/`). */
export async function parseAppPluginMarketplace(repoRoot: string, subdir?: string): Promise<AppPluginMarketplaceManifest> {
  const root = marketplaceRoot(repoRoot, subdir)
  const manifestPath = join(root, MARKETPLACE_FILE)
  let fromManifest = false
  let name: string | undefined
  let entries: AppPluginMarketplacePlugin[] = []

  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as { name?: unknown; appPlugins?: unknown }
      name = typeof obj.name === 'string' ? obj.name : undefined
      if (Array.isArray(obj.appPlugins)) {
        entries = coerceEntries(obj.appPlugins)
        fromManifest = true
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') {
      throw new Error(`failed to read ${MARKETPLACE_FILE}: ${e.message}`)
    }
    // No manifest file → fall through to auto-scan.
  }

  if (!fromManifest) {
    entries = await autoScan(root)
    if (entries.length === 0) {
      log.warn(`no ${MARKETPLACE_FILE} and no plugins found by auto-scan in ${root}`)
    }
  }

  // De-duplicate by name (keep first); drop entries with duplicate dirs.
  const seen = new Set<string>()
  const plugins = entries.filter((e) => {
    if (seen.has(e.name)) return false
    seen.add(e.name)
    return true
  })

  return { name, plugins }
}
```

- Change `pluginDirInClone` (lines 137-141) to take the optional `subdir`:

```ts
/** Resolve a plugin entry's absolute dir within the clone (after containment
 *  was already validated). Used by the install route. `subdir` is the
 *  marketplace content subdir, resolved first. */
export function pluginDirInClone(repoRoot: string, dir: string, subdir?: string): string {
  // resolvePath with a relative `dir` stays under the effective root; the
  // entry was already validated to be relative + contained, and the subdir
  // is validated by marketplaceRoot.
  return resolvePath(marketplaceRoot(repoRoot, subdir), dir)
}
```

- Add the private `marketplaceRoot` helper at the end of the file (after `pluginDirInClone`):

```ts
/** Resolve the effective marketplace root (clone root + optional subdir),
 *  validating that the subdir stays inside the clone. The record layer
 *  validates on persist; this re-checks as defense-in-depth because the
 *  parser can also be called directly. */
function marketplaceRoot(repoRoot: string, subdir?: string): string {
  if (!subdir) return repoRoot
  const err = validateRelativePath(subdir, { isWindows: process.platform === 'win32' })
  if (err) throw new Error(`invalid marketplace subdir '${subdir}': ${err}`)
  return join(repoRoot, subdir)
}
```

- [ ] **Step 4: Update the manager**

`server/app-plugins/app-plugin-manager.ts`, line 370 — thread `mp.subdir` into the plugin-dir resolution:

```ts
    const dir = await resolvePluginDir(pluginDirInClone(mp.cloneDir, entry.dir, mp.subdir))
```

The existing symlink-escape check (`cloneReal` / `isPathInside(dir, cloneReal, …)`) still holds: `dir` resolves inside `cloneDir/subdir`, which is inside `cloneDir`, so the realpath'd dir remains contained. No other manager change.

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `npx vitest run server/app-plugins/marketplace-parser.test.ts server/app-plugins/marketplace-install.test.ts`
Expected: PASS (existing + new subdir tests).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/app-plugins/marketplace-parser.ts server/app-plugins/app-plugin-manager.ts server/app-plugins/marketplace-parser.test.ts server/app-plugins/marketplace-install.test.ts
git commit -m "feat: thread subdir through marketplace parser and install

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Built-in marketplace module + CLI wiring

**Files:**
- Create: `server/app-plugins/builtin-marketplace.ts`
- Modify: `server/cli.ts` (imports + seed call)
- Create: `server/app-plugins/builtin-marketplace.test.ts`

**Interfaces:**
- Consumes:
  - `parseAppPluginMarketplace(dir: string): Promise<AppPluginMarketplaceManifest>` from `./marketplace-parser.js` (Task 3 — called without a subdir, since `dist/plugins/` already has the catalog at its root).
  - `AppPluginMarketplaceStore.seedBuiltinIfFirstRun(record): Promise<boolean>` + `isFirstRun()` from Task 2.
  - `AppPluginMarketplaceRecord` / `AppPluginMarketplaceManifest` from `../../shared/app-plugins/marketplace.js`.
- Produces (consumed by Task 5's tests and by the CLI):
  - `BUILTIN_MARKETPLACE_ID = 'claude-react-web-plugins'`
  - `BUILTIN_MARKETPLACE_DISPLAY_NAME = 'Claude React Web Plugins'`
  - `resolveBundledPluginsDir(): string | null`
  - `resolvePluginsDirFrom(here: string): string | null` (exported for tests)
  - `buildBuiltinRecord(pluginsDir: string): Promise<AppPluginMarketplaceRecord>`
  - `seedBuiltinMarketplace(store: AppPluginMarketplaceStore, pluginsDir?: string): Promise<void>`
- Note: the spec listed `buildBuiltinRecord(store, pluginsDir)`; the `store` param is unused (cloneDir = the bundled dir, not `store.cloneDirFor`) so it was dropped. The seeding call site in `cli.ts` is `seedBuiltinMarketplace(appPluginMarketplaceStore)` — the dir is resolved internally.

- [ ] **Step 1: Write the failing module tests**

Create `server/app-plugins/builtin-marketplace.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import {
  BUILTIN_MARKETPLACE_ID,
  resolveBundledPluginsDir,
  resolvePluginsDirFrom,
  buildBuiltinRecord,
  seedBuiltinMarketplace,
} from './builtin-marketplace.js'

/** Write a minimal-but-valid marketplace fixture at `dir`. */
function writeMarketplaceFixture(dir: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'app-plugins-marketplace.json'),
    JSON.stringify({
      name: 'Claude React Web Plugins',
      appPlugins: [
        { name: 'translator', dir: 'translator', description: 'Translate', version: '1.0.0' },
      ],
    }),
  )
}

describe('built-in app plugin marketplace', () => {
  let stateDir: string
  let pluginsDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'builtin-'))
    pluginsDir = join(stateDir, 'plugins')
    writeMarketplaceFixture(pluginsDir)
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('resolvePluginsDirFrom finds a dir containing the marketplace marker', () => {
    const found = resolvePluginsDirFrom(stateDir)
    expect(found).toBe(pluginsDir)
  })

  it('resolvePluginsDirFrom returns null when no marker is present', () => {
    const empty = join(stateDir, 'empty')
    mkdirSync(empty, { recursive: true })
    expect(resolvePluginsDirFrom(empty)).toBe(null)
  })

  it('resolveBundledPluginsDir resolves a real dir in the repo (dev layout)', () => {
    // In this repo the module lives at server/app-plugins → candidate
    // `join(here, '..', '..', 'plugins')` resolves to <repo>/plugins, which
    // exists and has the marker.
    expect(resolveBundledPluginsDir()).not.toBeNull()
  })

  it('buildBuiltinRecord builds a fully-populated local record (no subdir)', async () => {
    const record = await buildBuiltinRecord(pluginsDir)
    expect(record.id).toBe(BUILTIN_MARKETPLACE_ID)
    expect(record.source).toEqual({ type: 'local', path: pluginsDir })
    expect(record.cloneDir).toBe(pluginsDir)
    expect(record.subdir).toBeUndefined()
    expect(record.lastSha).toBe('')
    expect(record.manifest.name).toBe('Claude React Web Plugins')
    expect(record.manifest.plugins).toHaveLength(1)
    expect(record.manifest.plugins[0].name).toBe('translator')
  })

  it('seedBuiltinMarketplace seeds on first run and no-ops afterwards', async () => {
    const store = new AppPluginMarketplaceStore({ stateDir })
    await seedBuiltinMarketplace(store, pluginsDir)
    const seeded = store.get(BUILTIN_MARKETPLACE_ID)
    expect(seeded).toBeDefined()
    expect(seeded?.source.type).toBe('local')
    // The explicit flush inside seedBuiltinIfFirstRun created the file.
    expect(store.isFirstRun()).toBe(false)
    // Second call must not re-seed (file now exists).
    await seedBuiltinMarketplace(store, pluginsDir)
    expect(store.list()).toHaveLength(1)
  })

  it('seedBuiltinMarketplace skips (no crash) when the dir is missing', async () => {
    const store = new AppPluginMarketplaceStore({ stateDir })
    await seedBuiltinMarketplace(store, join(stateDir, 'does-not-exist'))
    expect(store.list()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/app-plugins/builtin-marketplace.test.ts`
Expected: FAIL — `Cannot find module './builtin-marketplace.js'` (module doesn't exist yet).

- [ ] **Step 3: Create the module**

Create `server/app-plugins/builtin-marketplace.ts`:

```ts
// Built-in ("Bundled") App Plugin marketplace seeding.
//
// The official plugins ship inside the npm package at dist/plugins/ (copied
// there by build.mjs). On the very first launch the marketplace store is
// seeded with a single `local`-source record pointing at that bundled dir, so
// the App Plugin Marketplace shows the official plugins immediately, offline,
// with no runtime git clone. Seeding is failure-safe: any error is logged and
// never blocks boot.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../log.js'
import { parseAppPluginMarketplace } from './marketplace-parser.js'
import type { AppPluginMarketplaceStore } from './marketplace-store.js'
import type { AppPluginMarketplaceRecord } from '../../shared/app-plugins/marketplace.js'

const log = createLogger('app-plugins:builtin')

export const BUILTIN_MARKETPLACE_ID = 'claude-react-web-plugins'
export const BUILTIN_MARKETPLACE_DISPLAY_NAME = 'Claude React Web Plugins'

/** Marker file that identifies a directory as an App Plugin marketplace. */
const MARKETPLACE_FILE = 'app-plugins-marketplace.json'

/** Locate the bundled plugins dir at runtime. Mirrors resolveClientDir in
 *  server/app.ts: walk a few candidates so both the bundled dist/cli.mjs
 *  (sibling dist/plugins/) and source `tsx server/cli.ts` (repo-root
 *  plugins/) work without config. */
export function resolveBundledPluginsDir(): string | null {
  return resolvePluginsDirFrom(dirname(fileURLToPath(import.meta.url)))
}

/** Candidate walk, exported for tests. `here` is a module dir. */
export function resolvePluginsDirFrom(here: string): string | null {
  const candidates = [
    join(here, 'plugins'), // bundled as dist/cli.mjs → dist/plugins
    join(here, '..', '..', 'plugins'), // tsx dev from server/app-plugins → <repo>/plugins
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, MARKETPLACE_FILE))) return dir
  }
  return null
}

/** Build the seeded built-in marketplace record from the bundled dir. The
 *  manifest is parsed eagerly (a local read) so the entry is fully populated
 *  from the very first render. No subdir — the bundled dir already has the
 *  catalog at its root. */
export async function buildBuiltinRecord(pluginsDir: string): Promise<AppPluginMarketplaceRecord> {
  const manifest = await parseAppPluginMarketplace(pluginsDir)
  const now = Date.now()
  return {
    id: BUILTIN_MARKETPLACE_ID,
    displayName: BUILTIN_MARKETPLACE_DISPLAY_NAME,
    source: { type: 'local', path: pluginsDir },
    cloneDir: pluginsDir,
    addedAt: now,
    lastRefreshedAt: now,
    lastSha: '',
    manifest,
  }
}

/** Seed the built-in marketplace on first launch. No-op when the store file
 *  already exists (later launches — the record persists, and a removed
 *  built-in stays removed). `pluginsDir` is optional for tests; it defaults
 *  to the runtime-resolved bundled dir. Any error is logged, never fatal. */
export async function seedBuiltinMarketplace(store: AppPluginMarketplaceStore, pluginsDir?: string): Promise<void> {
  const dir = pluginsDir ?? resolveBundledPluginsDir()
  if (!dir) {
    log.warn('bundled app plugins marketplace not found; skipping built-in seed')
    return
  }
  try {
    const record = await buildBuiltinRecord(dir)
    await store.seedBuiltinIfFirstRun(record)
  } catch (err) {
    log.warn(`failed to seed built-in marketplace: ${(err as Error).message}`)
  }
}
```

- [ ] **Step 4: Wire the seed into the CLI**

`server/cli.ts`:

- Add the import after line 28 (`import { AppPluginManager } ...`):

```ts
import { seedBuiltinMarketplace } from './app-plugins/builtin-marketplace.js'
```

- Add the seed call right after `await appPluginMarketplaceStore.load()` (line 356):

```ts
  const appPluginStore = new AppPluginStore({ stateDir })
  const appPluginMarketplaceStore = new AppPluginMarketplaceStore({ stateDir })
  await appPluginMarketplaceStore.load()
  // Seed the bundled official App Plugin marketplace on first launch (no-op on
  // later launches; skipped when app plugins are disabled).
  if (!args.disableAppPlugins) {
    await seedBuiltinMarketplace(appPluginMarketplaceStore)
  }
  const appPluginManager = new AppPluginManager({
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `npx vitest run server/app-plugins/builtin-marketplace.test.ts server/app-plugins/marketplace-store.test.ts`
Expected: PASS (6 + 5 tests).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/app-plugins/builtin-marketplace.ts server/app-plugins/builtin-marketplace.test.ts server/cli.ts
git commit -m "feat: seed bundled official app plugin marketplace on first launch

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Routes — branch refresh on source type + `subdir` in add/refresh/info

**Files:**
- Modify: `server/app-plugins/marketplace-routes.ts` (add-route body, refresh route, `toInfo`, imports)
- Modify: `server/app-plugins/marketplace-routing.test.ts` (new describe blocks + imports)

**Interfaces:**
- Consumes:
  - `AppPluginMarketplaceRecord` from Task 2 (now has `source.type` union + `subdir?`).
  - `parseAppPluginMarketplace(repoRoot, subdir?)` and `pluginDirInClone` from Task 3 (routes call the parser with `record.subdir`; install delegates to the manager which threads subdir — the install route body is unchanged).
  - `validateRelativePath(rel, opts)` from `shared/app-plugins/path-security.ts`.
  - `gitPull`, `gitClone`, `gitGetHeadSha`, `assertHttpsUrl` already in the file.
- Produces:
  - `POST /` accepts optional `subdir` in the body (validated), stores it on the record, and parses the clone with it.
  - `POST /:id/refresh` re-parses with `record.subdir` on both branches.
  - `toInfo` includes `subdir`.
  - No new exported symbols.

- [ ] **Step 1: Write the failing routes test**

Edit `server/app-plugins/marketplace-routing.test.ts`:

- Change the `node:fs` import (line 3) to:

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
```

- Append two new describe blocks after the existing one (before end of file):

```ts
describe('marketplace refresh — local source (bundled)', () => {
  let stateDir: string
  let manager: AppPluginManager
  let mpStore: AppPluginMarketplaceStore
  let pluginsDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mp-refresh-'))
    pluginsDir = join(stateDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(
      join(pluginsDir, 'app-plugins-marketplace.json'),
      JSON.stringify({
        name: 'Claude React Web Plugins',
        appPlugins: [
          { name: 'translator', dir: 'translator', description: 'Translate', version: '1.0.0' },
        ],
      }),
    )
    const store = new AppPluginStore({ stateDir })
    mpStore = new AppPluginMarketplaceStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub, marketplaceStore: mpStore })
    const now = Date.now()
    mpStore.upsert({
      id: 'bundled',
      displayName: 'Claude React Web Plugins',
      source: { type: 'local', path: pluginsDir },
      cloneDir: pluginsDir,
      addedAt: now,
      lastRefreshedAt: 0,
      lastSha: '',
      manifest: { name: 'Claude React Web Plugins', plugins: [] },
    })
    return mpStore.flush()
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('POST /:id/refresh re-parses a local marketplace without git', async () => {
    const app = new Hono()
    app.route('/api/app-plugins/marketplaces', buildAppPluginMarketplaceRouter(mpStore, manager))
    const res = await app.request('/api/app-plugins/marketplaces/bundled/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      updated: boolean
      marketplace: { pluginCount: number; sourceType: string }
    }
    expect(body.ok).toBe(true)
    expect(body.updated).toBe(false)
    expect(body.marketplace.pluginCount).toBe(1)
    expect(body.marketplace.sourceType).toBe('local')
    // Local dir is read in place — the cloneDir must be untouched.
    expect(mpStore.get('bundled')?.cloneDir).toBe(pluginsDir)
  })

  it('DELETE /:id keeps a local cloneDir on disk', async () => {
    const app = new Hono()
    app.route('/api/app-plugins/marketplaces', buildAppPluginMarketplaceRouter(mpStore, manager))
    const res = await app.request('/api/app-plugins/marketplaces/bundled', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    })
    expect(res.status).toBe(200)
    expect(mpStore.get('bundled')).toBeUndefined()
    // Local (bundled) source dir is app code — never deleted.
    expect(existsSync(pluginsDir)).toBe(true)
  })
})

describe('marketplace refresh — subdir marketplace', () => {
  let stateDir: string
  let manager: AppPluginManager
  let mpStore: AppPluginMarketplaceStore
  let cloneDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mp-refresh-sub-'))
    cloneDir = mkdtempSync(join(tmpdir(), 'mp-clone-sub-'))
    // Nested marketplace content (catalog under <clone>/plugins/). Local
    // source so refresh re-parses without a real git repo.
    mkdirSync(join(cloneDir, 'plugins'), { recursive: true })
    writeFileSync(join(cloneDir, 'plugins', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Claude React Web Plugins',
      appPlugins: [{ name: 'translator', dir: 'translator', description: 'Translate', version: '1.0.0' }],
    }))
    const store = new AppPluginStore({ stateDir })
    mpStore = new AppPluginMarketplaceStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub, marketplaceStore: mpStore })
    const now = Date.now()
    mpStore.upsert({
      id: 'nested',
      displayName: 'Claude React Web Plugins',
      source: { type: 'local', path: cloneDir },
      subdir: 'plugins',
      cloneDir,
      addedAt: now,
      lastRefreshedAt: 0,
      lastSha: '',
      manifest: { name: 'Claude React Web Plugins', plugins: [] },
    })
    return mpStore.flush()
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(cloneDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('POST /:id/refresh re-parses the catalog inside the subdir', async () => {
    const app = new Hono()
    app.route('/api/app-plugins/marketplaces', buildAppPluginMarketplaceRouter(mpStore, manager))
    const res = await app.request('/api/app-plugins/marketplaces/nested/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; marketplace: { pluginCount: number; subdir?: string; sourceType: string } }
    expect(body.ok).toBe(true)
    expect(body.marketplace.pluginCount).toBe(1)
    expect(body.marketplace.subdir).toBe('plugins')
    expect(body.marketplace.sourceType).toBe('local')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/app-plugins/marketplace-routing.test.ts`
Expected: FAIL — the first local-refresh test fails (gitPull throws on a non-repo → 400), and the subdir test fails (refresh ignores `record.subdir` → 0 plugins).

- [ ] **Step 3: Implement the route changes**

`server/app-plugins/marketplace-routes.ts`:

- Add the import (after line 15, the parser import):

```ts
import { validateRelativePath } from '../../shared/app-plugins/path-security.js'
```

- Replace the `POST /` route body (lines 33-71) to accept/validate/strip a `subdir`:

```ts
  app.post('/', async (c) => {
    const body = await safeJson<{ url?: string; ref?: string; subdir?: string }>(c.req)
    const url = body.url?.trim()
    if (!url) throw new HttpError(400, 'url is required')
    assertHttpsUrl(url)
    const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined
    let subdir: string | undefined
    if (typeof body.subdir === 'string' && body.subdir.trim()) {
      subdir = body.subdir.trim()
      const subErr = validateRelativePath(subdir, { isWindows: process.platform === 'win32' })
      if (subErr) throw new HttpError(400, `invalid subdir: ${subErr}`)
    }
    const id = store.generateId(url)
    const cloneDir = store.cloneDirFor(id)
    await fs.mkdir(dirname(cloneDir), { recursive: true })
    try {
      await gitClone(url, cloneDir, ref ? { ref } : {})
    } catch (err) {
      await rm(cloneDir, { recursive: true, force: true }).catch(() => {})
      throw new HttpError(400, `clone failed: ${(err as Error).message}`)
    }
    let manifest
    try {
      manifest = await parseAppPluginMarketplace(cloneDir, subdir)
    } catch (err) {
      await rm(cloneDir, { recursive: true, force: true }).catch(() => {})
      throw new HttpError(400, `marketplace parse failed: ${(err as Error).message}`)
    }
    const sha = await gitGetHeadSha(cloneDir)
    const now = Date.now()
    const record: AppPluginMarketplaceRecord = {
      id,
      displayName: manifest.name ?? id,
      source: { type: 'https', url, ref },
      subdir,
      cloneDir,
      addedAt: now,
      lastRefreshedAt: now,
      lastSha: sha,
      manifest,
    }
    store.upsert(record)
    await store.flush()
    log.info(`added marketplace ${id} (${manifest.plugins.length} plugins) from ${url}`)
    return c.json({ ok: true, marketplace: toInfo(record) })
  })
```

- Replace the `POST /:id/refresh` route body (lines 73-104) — branch on source type and pass `record.subdir` to the parser on both branches:

```ts
  app.post('/:id/refresh', async (c) => {
    const id = c.req.param('id')
    if (!SAFE_NAME.test(id)) throw new HttpError(400, 'invalid marketplace id')
    const record = store.get(id)
    if (!record) throw new HttpError(404, 'marketplace not found')

    // Local (bundled) marketplaces have no git remote — refresh re-parses the
    // on-disk catalog in place. https marketplaces git-pull as before. Both
    // re-parse from the effective root (cloneDir + optional subdir).
    let updated: AppPluginMarketplaceRecord
    let didUpdate = false
    if (record.source.type === 'local') {
      const manifest = await parseAppPluginMarketplace(record.cloneDir, record.subdir)
      updated = { ...record, manifest, lastRefreshedAt: Date.now() }
    } else {
      let pull
      try {
        pull = await gitPull(record.cloneDir)
      } catch (err) {
        throw new HttpError(400, `refresh failed: ${(err as Error).message}`)
      }
      const manifest = await parseAppPluginMarketplace(record.cloneDir, record.subdir)
      updated = { ...record, manifest, lastRefreshedAt: Date.now(), lastSha: pull.newSha }
      didUpdate = pull.updated
    }
    store.upsert(updated)
    await store.flush()
    // Re-validate every plugin installed from this marketplace so version /
    // permission changes from the refreshed content surface (escalation →
    // permission-required; new version → updated record).
    for (const pluginRecord of manager.recordsForMarketplace(id)) {
      try {
        await manager.revalidatePlugin(pluginRecord.id)
      } catch (err) {
        log.warn(`revalidate ${pluginRecord.id} after marketplace refresh failed: ${(err as Error).message}`)
      }
    }
    return c.json({ ok: true, updated: didUpdate, marketplace: toInfo(updated) })
  })
```

The install route (`POST /:id/plugins/:pluginName/install`, lines 135-146) is **unchanged** — it delegates to `manager.install`, which Task 3 already threads `mp.subdir` through.

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `npx vitest run server/app-plugins/marketplace-routing.test.ts`
Expected: PASS (5 tests: 2 ordering + 2 local + 1 subdir).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app-plugins/marketplace-routes.ts server/app-plugins/marketplace-routing.test.ts
git commit -m "feat: local marketplace refresh re-parses; subdir threaded through routes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Client — "Bundled" label + subdir display

**Files:**
- Modify: `src/components/AppPluginMarketplaceSection.tsx`

**Interfaces:**
- Consumes: `AppPluginMarketplaceInfo` from Task 2 (`sourceType: 'https' | 'local'`, `url?: string`, `ref?: string`, `subdir?: string`) — imported already as `'../../shared/app-plugins/marketplace.js'`.
- Produces: `MarketplaceRow` renders "Bundled with app" instead of the URL for local entries, a `Bundled` chip next to the display name, and shows `subdir` on https entries. No new exports.

- [ ] **Step 1: Write the failing check (manual — no component test exists for this section)**

There is no existing component test for `AppPluginMarketplaceSection`. The verification for this UI change is typecheck + a manual render. Do the typecheck first so the change is validated against the new optional `url`/`subdir`:

Run: `npm run typecheck`
Expected: PASS (baseline — `mp.url` is now optional, and the current `{mp.url}` JSX still compiles).

- [ ] **Step 2: Implement the label + subdir display**

`src/components/AppPluginMarketplaceSection.tsx`, in the row head (lines 148-151), add a `Bundled` chip after the name:

```tsx
        <button className="app-plugins-row-toggle" onClick={props.onToggle} aria-expanded={expanded}>
          <span className="app-plugins-name">{mp.displayName}</span>
          {mp.sourceType === 'local' && <span className="app-plugins-state state-muted">Bundled</span>}
          <span className="app-plugins-state state-muted">{mp.pluginCount} plugins</span>
        </button>
```

Replace the meta line (lines 157-160):

```tsx
      <div className="app-plugins-meta">
        {mp.sourceType === 'local' ? <span>Bundled with app</span> : <span>{mp.url}{mp.subdir ? ` / ${mp.subdir}` : ''}</span>}
        {mp.sourceType !== 'local' && mp.ref && <span>@ {mp.ref}</span>}
      </div>
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: PASS.

Manual smoke (dev server): `npm run dev`, open the App Plugins tab, Marketplace section. With a fresh state dir (delete `~/.claude-react-web/app-plugins/marketplaces.json`) the entry shows **Claude React Web Plugins**, a `Bundled` chip, `1 plugins`, and meta text "Bundled with app". Expanding it shows the `translator` plugin with a working Install button. For an https marketplace with `subdir`, the meta shows `https://github.com/… / plugins`.

- [ ] **Step 4: Commit**

```bash
git add src/components/AppPluginMarketplaceSection.tsx
git commit -m "feat: show Bundled label + subdir in marketplace rows

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Catalog — include `idle-compact` (optional, serves "show our built-in plugins")

> This task is independent of the marketplace mechanism and only touches the shared catalog. Skip it if the user only wants `translator` listed.

**Files:**
- Modify: `plugins/app-plugins-marketplace.json`
- Create: `plugins/marketplace-catalog.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (standalone; the catalog is read by `parseAppPluginMarketplace` at runtime and covered by Task 1's build copy).
- Produces: the official catalog lists both `translator` and `idle-compact`; a regression test pins the invariant that every catalog `dir` exists and has a `crw-plugin.json`.

- [ ] **Step 1: Write the failing catalog test**

Create `plugins/marketplace-catalog.test.ts` (this file runs under vitest — `plugins/**/*.test.ts` is in `vitest.config.ts` include):

```ts
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

describe('official App Plugin marketplace catalog', () => {
  const catalog = JSON.parse(readFileSync(join(here, 'app-plugins-marketplace.json'), 'utf8')) as {
    appPlugins: Array<{ name: string; dir: string }>
  }

  it('every catalog entry points at a directory with a crw-plugin.json', () => {
    expect(catalog.appPlugins.length).toBeGreaterThan(0)
    for (const entry of catalog.appPlugins) {
      expect(existsSync(join(here, entry.dir, 'crw-plugin.json')), `missing crw-plugin.json for ${entry.dir}`).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it passes (both entries on disk)**

Run: `npx vitest run plugins/marketplace-catalog.test.ts`
Expected: PASS — both `translator` and `idle-compact` dirs exist with manifests, so the test passes even before adding idle-compact to the catalog (the test asserts dirs exist, not that all dirs are listed).

- [ ] **Step 3: Add `idle-compact` to the catalog**

`plugins/app-plugins-marketplace.json`, append the second entry:

```json
{
  "name": "Claude React Web Plugins",
  "appPlugins": [
    {
      "name": "translator",
      "dir": "translator",
      "description": "Select text in a message, right-click → Translate (LLM translation into a configurable target language).",
      "version": "1.0.0"
    },
    {
      "name": "idle-compact",
      "dir": "idle-compact",
      "description": "Automatically compacts a conversation when a session has been idle and its context window is getting full.",
      "version": "1.0.0"
    }
  ]
}
```

(`idle-compact/crw-plugin.json` exists with `version: 1.0.0` — verified.)

- [ ] **Step 4: Verify the catalog test still passes + typecheck**

Run: `npx vitest run plugins/marketplace-catalog.test.ts server/app-plugins/marketplace-parser.test.ts`
Expected: PASS (catalog test is entry-count-agnostic; parser test unaffected — it uses fixtures).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/app-plugins-marketplace.json plugins/marketplace-catalog.test.ts
git commit -m "feat: list idle-compact in the official plugin marketplace catalog

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

Run the full suite before calling the work done:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all pass; `node build.mjs` (part of `npm run build`) also copies `plugins/` → `dist/plugins/`.

Manual end-to-end (one clean run):

```bash
rm -rf ~/.claude-react-web/app-plugins/marketplaces.json   # simulate first launch
npm run dev
```

Then: open the App Plugins tab → Marketplace → the "Claude React Web Plugins" entry is present, shows the `Bundled` chip + "Bundled with app", lists the catalog plugins, and Install works (translator uses host `storage`, verified read-safe for a possibly-read-only `dist/plugins`). Quit, delete the marketplace entry in the UI, restart — it does NOT come back (the store file now exists, so `seedBuiltinIfFirstRun` is a no-op).

Manual subdir path (existing-user scenario, requires network): add a marketplace with URL `https://github.com/LoopGe/claude-react-web` and `subdir: plugins` — the official plugins appear, installable.

## Behavior matrix (acceptance)

| Scenario | Expected |
|---|---|
| Fresh state dir, first launch | Seeded local marketplace from `dist/plugins/` — instant, offline |
| Later launches | Record persists; no re-seed |
| User removes the built-in entry | Record removed, its installed plugins uninstalled, `dist/plugins/` untouched, no resurrection |
| `dist/plugins/` missing (broken install) | Seed warns and skips; boot unaffected |
| Existing user (store file already present) | Not auto-seeded; can add `https://github.com/LoopGe/claude-react-web` + `subdir: plugins` manually |
| Marketplace catalog in a subdir | `parseAppPluginMarketplace`/`pluginDirInClone`/refresh/install resolve `cloneDir/subdir`; invalid `subdir` rejected at add-time and at load-time |
| App updated | Installed bundled plugins revalidate against new `dist/plugins/` on next `initialize()` (existing path) |
| `--disable-app-plugins` | No seeding (routes absent) |
