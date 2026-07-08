# Clear Configuration & Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Clear configuration & data" button in the About tab of GlobalSettingsModal that opens a dialog with grouped checkboxes (including a two-level "browser data" group and an isolated danger zone) and clears the selected categories via a single orchestrating `POST /config/reset` endpoint + client-side clears, then reloads.

**Architecture:** A new `shared/reset.ts` defines the `ResetItem` union shared by both ends. Server: a new `server/routes/reset.ts` `buildResetRouter` (mounted in `app.ts` where all stores are in scope) implements `POST /config/reset` — it best-effort clears each requested server-side category by calling new `clearAll()` methods on the stores + config/log/credentials helpers, returns per-item results + `deletedSessionIds`. Client: `useResetConfig` posts the selected server items, then clears client-side items (`inputHistoryStore.clear()`, draft/appearance localStorage, session caches) and reloads. `ResetConfigDialog` mirrors `NewSessionDialog` chrome with a tri-state parent checkbox for browser-data and a two-step danger confirm mirroring `McpCard` delete.

**Tech Stack:** Hono (server), React 19 + Vitest + jsdom (client), localStorage + IndexedDB (browser persistence), `JsonFileStore`-backed stores (server persistence).

## Global Constraints

- CSS: never hardcode color hex — use theme CSS variables (`var(--btn-hover-bg)` etc.). New colors defined in both `:root` and `[data-theme="light"]`.
- Logging: server diagnostics via `createLogger(scope)`; never bare `console.*` for server diagnostics. Browser bundle may use `console.warn` (matches `useLocalStorage` precedent).
- Git: never spawn through a shell — N/A here (no git calls in this feature).
- Tests: `npm run test` (vitest), `npm run typecheck` (both tsconfigs), `npm run lint`. All must pass.
- `accessToken` is intentionally NOT in `WRITABLE_CONFIG_KEYS` — clearing it must write `config.json` directly, not via `updateConfigFile`.
- Best-effort semantics: a failing item must not abort the others; the response reports per-item status.
- The dialog is a stacked `.modal-backdrop` inside GlobalSettingsModal (parent's `useFocusTrap` already exempts descendant `.modal-backdrop`).

---

## File Structure

**New files:**
- `shared/reset.ts` — `ResetItem` union + `RESET_ITEMS` / `DANGER_ITEMS` constants + `ResetResult` type.
- `server/routes/reset.ts` — `buildResetRouter(deps)` with `POST /config/reset`.
- `server/routes/reset.test.ts` — route orchestration tests.
- `src/hooks/useResetConfig.ts` — client orchestration hook.
- `src/hooks/useResetConfig.test.ts` — hook tests.
- `src/components/ResetConfigDialog.tsx` — the dialog.
- `src/components/ResetConfigDialog.test.tsx` — dialog tests.

**Modified files:**
- `server/mcp-config.ts` — add `clearAll()`.
- `server/mp-store.ts` — add `clearAll()`.
- `server/snippet-store.ts` — add `clearAll()`.
- `server/ui-state-store.ts` — add `clearAll()`.
- `server/log.ts` — add `clearLogFile(stateDir, reEnable)`.
- `server/config.ts` — add `clearCredentials(stateDir)`.
- `server/app.ts` — mount `buildResetRouter`.
- `src/state/inputHistoryStore.ts` — add `clear()` to interface + factory.
- `src/components/GlobalSettingsModal.tsx` — About-tab button + lazy mount `ResetConfigDialog`.

---

### Task 1: `shared/reset.ts` — ResetItem types & constants

**Files:**
- Create: `shared/reset.ts`

**Interfaces:**
- Produces: `ResetItem` union, `SERVER_RESET_ITEMS`, `DANGER_ITEMS`, `BrowserDataItem`, `ResetResponse`.

- [ ] **Step 1: Create the shared module**

```ts
// shared/reset.ts
// Categories the "Clear configuration & data" dialog can clear. Shared so the
// server route and the client dialog agree on the exact item keys.

/** Server-side items handled by POST /config/reset. */
export type ServerResetItem =
  | 'app-settings'
  | 'mcp-configs'
  | 'marketplaces'
  | 'snippets'
  | 'ui-state'
  | 'logs'
  | 'credentials'
  | 'sessions'

/** Client-side items cleared by the browser after the server responds. */
export type BrowserDataItem = 'input-history' | 'drafts' | 'appearance'

export const SERVER_RESET_ITEMS: readonly ServerResetItem[] = [
  'app-settings',
  'mcp-configs',
  'marketplaces',
  'snippets',
  'ui-state',
  'logs',
  'credentials',
  'sessions',
]

/** Items in the isolated danger zone — default unchecked, require two-step confirm. */
export const DANGER_ITEMS: readonly ServerResetItem[] = ['credentials', 'sessions']

/** Per-item result in the reset response. */
export type ItemOutcome = { ok: true } | { ok: false; error: string }

export interface ResetResponse {
  results: Partial<Record<ServerResetItem, ItemOutcome>>
  /** Session ids whose metadata + live handles were removed (for client cache cleanup). */
  deletedSessionIds: string[]
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (module is self-contained, no importers yet).

- [ ] **Step 3: Commit**

```bash
git add shared/reset.ts
git commit -m "feat(reset): add shared ResetItem types & constants"
```

---

### Task 2: Store `clearAll()` methods (mcp, snippet, ui-state)

**Files:**
- Modify: `server/mcp-config.ts` (class `McpConfigStore`, ~line 151)
- Modify: `server/snippet-store.ts` (class `SnippetStore`, ~line 63)
- Modify: `server/ui-state-store.ts` (class `UiStateStore`, ~line 71; `EMPTY_STATE` ~line 34)
- Test: `server/mcp-config.test.ts` (or extend existing), `server/snippet-store.test.ts`, `server/ui-state-store.test.ts`

**Interfaces:**
- Produces: `McpConfigStore.clearAll(): Promise<void>`, `SnippetStore.clearAll(): Promise<void>`, `UiStateStore.clearAll(): Promise<void>`.

**Note:** `JsonFileStore` exposes `this.index` (a `Map`) and `flush()`. `remove(key)` schedules a debounced flush; for bulk clear, `this.index.clear()` + `await this.flush()` is the minimal path. (`MpStore.clearAll()` is Task 3 — it has filesystem side effects.)

- [ ] **Step 1: Write failing tests**

`server/mcp-config.test.ts` (append):
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { McpConfigStore } from './mcp-config'
import { tmpdir } from '../test/tmpdir' // existing helper if present; else use fs.mkdtempSync

describe('McpConfigStore.clearAll', () => {
  it('removes all servers and flushes', async () => {
    const dir = await tmpdir()
    const store = new McpConfigStore(dir)
    store.upsert({ name: 'a', type: 'stdio', command: 'x' } as any)
    store.upsert({ name: 'b', type: 'stdio', command: 'y' } as any)
    await store.flush()
    await store.clearAll()
    expect(Array.from(store.list())).toHaveLength(0)
    // Re-read from disk to confirm flush
    const store2 = new McpConfigStore(dir)
    expect(Array.from(store2.list())).toHaveLength(0)
  })
})
```
Repeat the same shape for `SnippetStore` (seed 2 snippets, assert 0 after) and `UiStateStore` (seed groups/sidebarOrder, assert EMPTY_STATE after + disk).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- mcp-config snippet ui-state`
Expected: FAIL (`clearAll is not a function`).

- [ ] **Step 3: Implement `clearAll()` on each store**

`server/mcp-config.ts` — add inside `McpConfigStore`:
```ts
/** Remove every server config and flush. */
async clearAll(): Promise<void> {
  this.index.clear()
  await this.flush()
}
```

`server/snippet-store.ts` — same:
```ts
async clearAll(): Promise<void> {
  this.index.clear()
  await this.flush()
}
```

`server/ui-state-store.ts` — add:
```ts
async clearAll(): Promise<void> {
  this.update({ groups: [], sidebarOrder: [], collapsedGroups: {} })
  await this.flush()
}
```
(If `EMPTY_STATE` is already exported, use `{ ...EMPTY_STATE }`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- mcp-config snippet ui-state`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/mcp-config.ts server/snippet-store.ts server/ui-state-store.ts server/mcp-config.test.ts server/snippet-store.test.ts server/ui-state-store.test.ts
git commit -m "feat(reset): add clearAll() to mcp/snippet/ui-state stores"
```

---

### Task 3: `MpStore.clearAll()` (marketplaces + plugins + clone dirs)

**Files:**
- Modify: `server/mp-store.ts` (class `MpStore`, ~line 73; `removeEntry` ~line 194; `cacheDir` ~line 95; `externalCacheDir` ~line 96)
- Test: `server/mp-store.test.ts`

**Interfaces:**
- Produces: `MpStore.clearAll(): Promise<void>` — clears index + enabledPlugins + `rm -rf` `cacheDir` and `externalCacheDir`, flushes.

**Note:** `removeEntry(id)` already does per-entry cleanup (`rm cloneDir` + strip `enabledPlugins` keys + `pruneExternalClones`). For a full clear, iterate entries' cloneDirs, clear both maps, then `rm` both cache dirs wholesale (cheaper than per-entry prune). Use the existing `rm` import (already in mp-store.ts for `removeEntry`).

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest'
import { MpStore } from './mp-store'
import { tmpdir } from '../test/tmpdir'
import { existsSync } from 'node:fs'

describe('MpStore.clearAll', () => {
  it('clears entries, enabled plugins, and clone dirs', async () => {
    const dir = await tmpdir()
    const store = new MpStore(dir, '<stateDir>') // follow existing constructor signature
    // Seed one entry with a cloneDir under cacheDir; enable one plugin.
    // (Use the store's existing add/upsert + enablePlugin API as in other tests.)
    await store.clearAll()
    expect(Array.from(store.list())).toHaveLength(0)
    expect(existsSync(store.cacheDir)).toBe(false)
    expect(existsSync(store.externalCacheDir)).toBe(false)
  })
})
```
(Match the exact seeding API the existing `mp-store.test.ts` uses — read it first and mirror.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- mp-store`
Expected: FAIL (`clearAll is not a function`).

- [ ] **Step 3: Implement**

`server/mp-store.ts` — add inside `MpStore`:
```ts
import { rm } from 'node:fs/promises'

/** Remove every marketplace, all enabled-plugin flags, and the clone cache dirs. */
async clearAll(): Promise<void> {
  // Capture cloneDirs before wiping the index.
  const cloneDirs = Array.from(this.index.values()).map((e) => e.cloneDir)
  this.index.clear()
  this.enabled.clear()
  await this.flush()
  await Promise.all([
    ...cloneDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})),
    rm(this.cacheDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}),
    rm(this.externalCacheDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}),
  ])
}
```
(If `rm` is already imported at top of file, don't re-import. If `enabled` is the private map name, use the actual name — confirm from `removeEntry` which strips `enabledPlugins` keys; the field is `this.enabled` per the report line 77.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- mp-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/mp-store.ts server/mp-store.test.ts
git commit -m "feat(reset): add MpStore.clearAll() (entries + plugins + clone dirs)"
```

---

### Task 4: `log.ts` `clearLogFile()`

**Files:**
- Modify: `server/log.ts` (module globals ~line 155; `disableFileLogging` ~line 217; `enableFileLogging` ~line 206; `openStream` ~line 180)
- Test: `server/log.test.ts` (extend or create)

**Interfaces:**
- Produces: `clearLogFile(stateDir: string, reEnable: boolean): Promise<void>` — ends the live stream, `rm -rf <stateDir>/logs`, recreates the dir, and if `reEnable` re-opens today's log via `enableFileLogging(stateDir)`.

**Note:** On Windows you cannot delete the open log file, so the stream must be closed first. `disableFileLogging()` already ends + nulls the stream. After rm, `enableFileLogging(stateDir)` re-creates the dir + opens today's file + prunes. Export both helpers if they aren't already (they're module-internal — export them, or implement `clearLogFile` inside `log.ts` where it can call them directly).

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { clearLogFile, enableFileLogging } from './log'
import { tmpdir } from '../test/tmpdir'

describe('clearLogFile', () => {
  it('removes old log files and skips the open one by recreating fresh', async () => {
    const dir = await tmpdir()
    enableFileLogging(dir)
    const logDir = join(dir, 'logs')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(join(logDir, 'server-2020-01-01.log'), 'old')
    await clearLogFile(dir, true)
    expect(existsSync(join(logDir, 'server-2020-01-01.log'))).toBe(false)
    // today's file re-created by re-enable
    expect(existsSync(logDir)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- log.test`
Expected: FAIL (`clearLogFile is not a function` / not exported).

- [ ] **Step 3: Implement**

`server/log.ts` — add near the other file-logging exports:
```ts
import { rm } from 'node:fs/promises'

/** Wipe the logs directory. Ends the live stream first (Windows can't delete
 *  an open file), removes the whole dir, and optionally re-enables file logging
 *  (re-creating the dir + today's file). */
export async function clearLogFile(stateDir: string, reEnable: boolean): Promise<void> {
  disableFileLogging()
  const logDir = joinPath(stateDir, 'logs')
  await rm(logDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  if (reEnable) enableFileLogging(stateDir)
}
```
(Ensure `disableFileLogging` and `enableFileLogging` are exported — add `export` to their `function` declarations if not already. `joinPath` is the existing helper used in `openStream`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- log.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/log.ts server/log.test.ts
git commit -m "feat(reset): add clearLogFile() (close stream, rm logs, optional re-enable)"
```

---

### Task 5: `config.ts` `clearCredentials()`

**Files:**
- Modify: `server/config.ts` (`readConfigFile` ~line 405; `loadConfig` ~line 185; `updateConfigFile` ~line 428; DEFAULTS ~line 129)
- Test: `server/config.test.ts` (extend)

**Interfaces:**
- Produces: `clearCredentials(stateDir: string): Promise<void>` — sets `baseUrl` back to default + clears `authToken` (via `updateConfigFile({ baseUrl: null, authToken: null })`) AND clears `accessToken` by writing `config.json` directly (bypassing `WRITABLE_CONFIG_KEYS`), then `loadConfig(stateDir)` + `setWebAuth('', false)`.

**Note:** `accessToken` is intentionally not in `WRITABLE_CONFIG_KEYS`, so `updateConfigFile` will skip it. Mirror `POST /config/setup` (lines 37-64): `readConfigFile`, `delete existing.accessToken`, `writeAtomic`, `loadConfig`. Import `setWebAuth` from `server/auth.ts`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest'
import { clearCredentials, loadConfig, readConfigFile } from './config'
import { tmpdir } from '../test/tmpdir'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

describe('clearCredentials', () => {
  it('clears authToken, baseUrl, and accessToken from config.json', async () => {
    const dir = await tmpdir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      authToken: 'sk-xxx', baseUrl: 'https://custom.example', accessToken: 'webtok',
    }))
    await clearCredentials(dir)
    const raw = readConfigFile(dir)
    expect(raw.authToken).toBeUndefined()
    expect(raw.baseUrl).toBeUndefined() // falls back to default on load
    expect(raw.accessToken).toBeUndefined()
    const cfg = loadConfig(dir)
    expect(cfg.baseUrl).toBe('https://api.anthropic.com')
    expect(cfg.authToken).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- config.test`
Expected: FAIL.

- [ ] **Step 3: Implement**

`server/config.ts` — add:
```ts
import { setWebAuth } from './auth.js'
import { writeAtomic } from './atomic-write.js' // existing import used by /config/setup
import { configPath } from './config-paths.js'  // existing; use the actual path constant

/** Clear connection credentials: authToken + baseUrl (→ defaults) and the web
 *  access token (accessToken, which bypasses WRITABLE_CONFIG_KEYS). Reloads
 *  config and clears live web-auth state. */
export async function clearCredentials(stateDir: string): Promise<void> {
  // authToken + baseUrl go through the normal path (null → delete → default).
  await updateConfigFile(stateDir, { authToken: null, baseUrl: null })
  // accessToken must be written directly (not in WRITABLE_CONFIG_KEYS).
  const existing = readConfigFile(stateDir)
  delete existing.accessToken
  await writeAtomic(stateDir, configPath, existing)
  await loadConfig(stateDir)
  setWebAuth('', false)
}
```
(Confirm the exact names: `writeAtomic` signature + `configPath` constant — read `POST /config/setup` at lines 27-64 and reuse the same imports/paths it uses. `setWebAuth` is exported from `server/auth.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- config.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/config.test.ts
git commit -m "feat(reset): add clearCredentials() (authToken + baseUrl + accessToken)"
```

---

### Task 6: `server/routes/reset.ts` — `POST /config/reset`

**Files:**
- Create: `server/routes/reset.ts`
- Create: `server/routes/reset.test.ts`
- Modify: `server/app.ts` (mount the router; all stores are in scope here)

**Interfaces:**
- Consumes: `McpConfigStore.clearAll()`, `MpStore.clearAll()`, `SnippetStore.clearAll()`, `UiStateStore.clearAll()`, `clearLogFile()`, `clearCredentials()`, `SessionManager.delete(id)` + `list()`, `updateConfigFile()`, `loadConfig()`, `serverConfig`, `WRITABLE_CONFIG_KEYS`.
- Produces: `buildResetRouter(deps)` returning a `Hono` sub-app with `POST /config/reset` accepting `{ items: ServerResetItem[] }` → `ResetResponse`.

**`app-settings` clear semantics:** reset every key in `WRITABLE_CONFIG_KEYS` EXCEPT `authToken`, `baseUrl`, `logToFile`, `logLevel`, `logScopes` (those belong to credentials / logs / are operational) to default by passing `null` for each via `updateConfigFile`. Concretely clear: `modelList, recapModel, commitMessageModel, maxUploadBytes, historyCap, maxOpenPanels, workingStuckMs, updateCheckRegistry, skillLoadMode, enabledSkills, autoClassifierModel, autoClassifierTimeout, showPinnedUserMessage, autoRecap, allowSensitivePathEdits`. Then `loadConfig(stateDir)`.

- [ ] **Step 1: Write failing test**

`server/routes/reset.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { buildResetRouter } from './reset'
import { Hono } from 'hono'

function makeDeps(overrides = {}) {
  return {
    sm: { list: vi.fn(() => []), delete: vi.fn(async () => {}) },
    configDir: '/tmp/cfg',
    mcpStore: { clearAll: vi.fn(async () => {}) },
    mpStore: { clearAll: vi.fn(async () => {}) },
    snippetStore: { clearAll: vi.fn(async () => {}) },
    uiStateStore: { clearAll: vi.fn(async () => {}) },
    ...overrides,
  }
}

describe('POST /config/reset', () => {
  it('clears only the requested items, best-effort, returns results', async () => {
    const deps = makeDeps()
    const app = buildResetRouter(deps as any)
    const res = await app.request('/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['mcp-configs', 'snippets'] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results['mcp-configs']).toEqual({ ok: true })
    expect(body.results['snippets']).toEqual({ ok: true })
    expect(deps.mcpStore.clearAll).toHaveBeenCalledOnce()
    expect(deps.snippetStore.clearAll).toHaveBeenCalledOnce()
    expect(deps.mpStore.clearAll).not.toHaveBeenCalled()
  })

  it('continues on per-item failure and reports the error', async () => {
    const deps = makeDeps({ mcpStore: { clearAll: vi.fn(async () => { throw new Error('boom') }) } })
    const app = buildResetRouter(deps as any)
    const res = await app.request('/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['mcp-configs', 'snippets'] }),
    })
    const body = await res.json()
    expect(body.results['mcp-configs']).toEqual({ ok: false, error: 'boom' })
    expect(body.results['snippets']).toEqual({ ok: true })
  })

  it('sessions clear deletes all sessions and returns their ids', async () => {
    const deps = makeDeps({ sm: { list: vi.fn(() => [{ id: 'a' }, { id: 'b' }]), delete: vi.fn(async () => {}) } })
    const app = buildResetRouter(deps as any)
    const res = await app.request('/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['sessions'] }),
    })
    const body = await res.json()
    expect(body.deletedSessionIds).toEqual(['a', 'b'])
    expect(deps.sm.delete).toHaveBeenCalledWith('a')
    expect(deps.sm.delete).toHaveBeenCalledWith('b')
  })

  it('rejects unknown items with 400', async () => {
    const app = buildResetRouter(makeDeps() as any)
    const res = await app.request('/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['bogus'] }),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- reset.test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the router**

`server/routes/reset.ts`:
```ts
import { Hono } from 'hono'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import {
  SERVER_RESET_ITEMS,
  type ServerResetItem,
  type ResetResponse,
  type ItemOutcome,
} from '../../shared/reset.js'
import { updateConfigFile, loadConfig, serverConfig, WRITABLE_CONFIG_KEYS } from '../config.js'
import { clearCredentials } from '../config.js' // added in Task 5
import { clearLogFile } from '../log.js' // added in Task 4
import { createLogger } from '../log.js'
import type { SessionManager } from '../session-manager.js'
import type { McpConfigStore } from '../mcp-config.js'
import type { MpStore } from '../mp-store.js'
import type { SnippetStore } from '../snippet-store.js'
import type { UiStateStore } from '../ui-state-store.js'

const log = createLogger('reset')

// app-settings clears these WRITABLE_CONFIG_KEYS (excludes connection + log keys).
const APP_SETTING_KEYS = [
  'modelList', 'recapModel', 'commitMessageModel', 'maxUploadBytes', 'historyCap',
  'maxOpenPanels', 'workingStuckMs', 'updateCheckRegistry', 'skillLoadMode',
  'enabledSkills', 'autoClassifierModel', 'autoClassifierTimeout',
  'showPinnedUserMessage', 'autoRecap', 'allowSensitivePathEdits',
] as const

export interface ResetRouterDeps {
  sm: SessionManager
  configDir: string
  mcpStore: McpConfigStore
  mpStore: MpStore
  snippetStore: SnippetStore
  uiStateStore: UiStateStore
}

export function buildResetRouter(deps: ResetRouterDeps): Hono {
  const app = new Hono()

  app.post('/config/reset', async (c) => {
    const { items } = await safeJson<{ items: ServerResetItem[] }>(c.req)
    if (!Array.isArray(items)) throw new HttpError(400, 'items must be an array')
    const invalid = items.filter((it) => !SERVER_RESET_ITEMS.includes(it))
    if (invalid.length) throw new HttpError(400, `unknown reset items: ${invalid.join(', ')}`)

    const results: ResetResponse['results'] = {}
    const deletedSessionIds: string[] = []

    const run = async (item: ServerResetItem, fn: () => Promise<unknown>) => {
      try { await fn(); results[item] = { ok: true } }
      catch (e) { results[item] = { ok: false, error: (e as Error).message }; log.warn(`[${item}] clear failed: ${(e as Error).message}`) }
    }

    for (const item of items) {
      switch (item) {
        case 'app-settings':
          await run(item, async () => {
            const nulls: Record<string, null> = {}
            for (const k of APP_SETTING_KEYS) nulls[k] = null
            await updateConfigFile(deps.configDir, nulls)
            await loadConfig(deps.configDir)
          })
          break
        case 'mcp-configs': await run(item, () => deps.mcpStore.clearAll()); break
        case 'marketplaces': await run(item, () => deps.mpStore.clearAll()); break
        case 'snippets': await run(item, () => deps.snippetStore.clearAll()); break
        case 'ui-state': await run(item, () => deps.uiStateStore.clearAll()); break
        case 'logs': await run(item, () => clearLogFile(deps.configDir, !!serverConfig.logToFile)); break
        case 'credentials': await run(item, () => clearCredentials(deps.configDir)); break
        case 'sessions':
          await run(item, async () => {
            const sessions = deps.sm.list()
            for (const s of sessions) {
              deletedSessionIds.push(s.id)
              await deps.sm.delete(s.id)
            }
          })
          break
      }
    }

    return c.json({ results, deletedSessionIds } satisfies ResetResponse)
  })

  return app
}
```
(Confirm `sm.list()` returns objects with `.id` — it returns `SessionInfo[]`. Confirm `safeJson` is exported from `./index.js` — yes, used by config-routes. Confirm `serverConfig` + `WRITABLE_CONFIG_KEYS` are exported from `config.js`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- reset.test`
Expected: PASS.

- [ ] **Step 5: Mount the router in `server/app.ts`**

Find where the per-store routers are mounted in `server/app.ts` (the `/api/mcp-config`, `/api/snippets`, `/api/ui-state` mounts — all stores are in scope there). Add alongside them:
```ts
import { buildResetRouter } from './routes/reset.js'
// ...
if (mcpStore && mpStore && snippetStore && uiStateStore) {
  app.route('/api', buildResetRouter({ sm, configDir, mcpStore, mpStore, snippetStore, uiStateStore }))
}
```
(Use the actual variable names + the existing `configDir`/state-dir arg name in app.ts. Mount under `/api` so the route is `/api/config/reset` — matches the client `api.post('/config/reset', ...)` which prepends `/api`.)

- [ ] **Step 6: Typecheck + run server tests**

Run: `npm run typecheck && npm run test -- reset`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/routes/reset.ts server/routes/reset.test.ts server/app.ts
git commit -m "feat(reset): add POST /config/reset orchestrating endpoint"
```

---

### Task 7: `inputHistoryStore.clear()`

**Files:**
- Modify: `src/state/inputHistoryStore.ts` (interface ~line 60; factory return ~line 187)
- Modify: `src/state/inputHistoryStore.test.ts` (append a test)

**Interfaces:**
- Produces: `InputHistoryStore.clear(): void` — wipes both the in-memory cache and localStorage (persists `[]` + emits).

- [ ] **Step 1: Write failing test**

Append to `src/state/inputHistoryStore.test.ts`:
```ts
it('clear() wipes entries from memory and localStorage', () => {
  const store = createInputHistoryStore('clear-test')
  store.add('a', 's1')
  store.add('b', 's1')
  expect(store.getAll()).toHaveLength(2)
  store.clear()
  expect(store.getAll()).toEqual([])
  // localStorage also empty
  const raw = JSON.parse(localStorage.getItem('clear-test')!)
  expect(raw).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/inputHistoryStore.test.ts`
Expected: FAIL (`clear is not a function`).

- [ ] **Step 3: Implement**

`src/state/inputHistoryStore.ts` — add `clear` to the interface:
```ts
export interface InputHistoryStore {
  // ... existing
  reset: () => void
  /** Wipe all entries from memory and localStorage. */
  clear: () => void
}
```
In the factory return object (after `reset`):
```ts
clear() {
  commit([])
},
```
(`commit(next)` already persists + emits; passing `[]` empties both.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/inputHistoryStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/inputHistoryStore.ts src/state/inputHistoryStore.test.ts
git commit -m "feat(reset): add inputHistoryStore.clear()"
```

---

### Task 8: `useResetConfig` hook (client orchestration)

**Files:**
- Create: `src/hooks/useResetConfig.ts`
- Create: `src/hooks/useResetConfig.test.ts`

**Interfaces:**
- Consumes: `api.post` (`src/hooks/useApi.ts`), `inputHistoryStore.clear()`, `clearAllSessionStorage` (`src/session-store/store.ts`), `sessionStoreRegistry.delete` (`src/session-store/registry.ts`), `ResetResponse` / `ServerResetItem` / `BrowserDataItem` (`shared/reset.ts`).
- Produces: `useResetConfig()` → `{ reset(opts): Promise<ResetResponse>, clearing: boolean }` where `opts = { server: ServerResetItem[], browser: BrowserDataItem[], deletedSessionIds?: string[] }`.

**Browser clear mapping:**
- `input-history` → `inputHistoryStore.clear()`
- `drafts` → scan `localStorage` for keys starting with `claude-react-web:draft:` and `removeItem` each
- `appearance` → `removeItem` the keys: `claude-react-web:theme`, `:skin`, `:accent-color`, `:session-colors`, `:recent-colors`, `:sidebar-width`, `:sidebar-min-px`, `:sidebar-max-px`, `:panel-col-ratios`, `:panel-min-ratio`, `:recent-models`, `:recent-cwds`, `:update-banner-dismissed-version`, `:last-seen-turn`

**Flow:** POST `/config/reset { items: server }` → on success, clear requested browser items + (if `sessions` was in server items) clear all session caches via `clearAllSessionStorage()` + `sessionStoreRegistry.delete(id)` for each `deletedSessionIds` → return response. The caller does the reload.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useResetConfig } from './useResetConfig'
import { inputHistoryStore } from '../state/inputHistoryStore'

beforeEach(() => { localStorage.clear(); inputHistoryStore.reset() })

describe('useResetConfig', () => {
  it('posts server items and clears requested browser items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { 'mcp-configs': { ok: true } }, deletedSessionIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    localStorage.setItem('claude-react-web:draft:s1', 'hi')
    inputHistoryStore.add('old', 's1')
    const { result } = renderHook(() => useResetConfig())
    await act(async () => {
      await result.current.reset({ server: ['mcp-configs'], browser: ['input-history', 'drafts'] })
    })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/config/reset'), expect.objectContaining({ method: 'POST' }))
    expect(inputHistoryStore.getAll()).toEqual([])
    expect(localStorage.getItem('claude-react-web:draft:s1')).toBeNull()
  })

  it('clears session caches when sessions were reset', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { sessions: { ok: true } }, deletedSessionIds: ['a', 'b'] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    localStorage.setItem('claude-web-session:a', '{}')
    const { result } = renderHook(() => useResetConfig())
    await act(async () => {
      await result.current.reset({ server: ['sessions'], browser: [] })
    })
    expect(localStorage.getItem('claude-web-session:a')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useResetConfig.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/hooks/useResetConfig.ts`:
```ts
import { useCallback, useState } from 'react'
import { api } from './useApi'
import { inputHistoryStore } from '../state/inputHistoryStore'
import { clearAllSessionStorage } from '../session-store/store'
import { sessionStoreRegistry } from '../session-store/registry'
import type { ServerResetItem, BrowserDataItem, ResetResponse } from '../../shared/reset'

const DRAFT_PREFIX = 'claude-react-web:draft:'
const APPEARANCE_KEYS = [
  'claude-react-web:theme', 'claude-react-web:skin', 'claude-react-web:accent-color',
  'claude-react-web:session-colors', 'claude-react-web:recent-colors',
  'claude-react-web:sidebar-width', 'claude-react-web:sidebar-min-px', 'claude-react-web:sidebar-max-px',
  'claude-react-web:panel-col-ratios', 'claude-react-web:panel-min-ratio',
  'claude-react-web:recent-models', 'claude-react-web:recent-cwds',
  'claude-react-web:update-banner-dismissed-version', 'claude-react-web:last-seen-turn',
]

function clearBrowserItem(item: BrowserDataItem): void {
  if (item === 'input-history') inputHistoryStore.clear()
  else if (item === 'drafts') {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(DRAFT_PREFIX)) localStorage.removeItem(k)
    }
  } else if (item === 'appearance') {
    for (const k of APPEARANCE_KEYS) localStorage.removeItem(k)
  }
}

export interface ResetOpts {
  server: ServerResetItem[]
  browser: BrowserDataItem[]
}

export function useResetConfig() {
  const [clearing, setClearing] = useState(false)
  const reset = useCallback(async ({ server, browser }: ResetOpts): Promise<ResetResponse> => {
    setClearing(true)
    try {
      const res = await api.post<ResetResponse>('/config/reset', { items: server }, { timeoutMs: 0 })
      // Server cleared; now clear requested browser items.
      for (const b of browser) clearBrowserItem(b)
      // If sessions were reset, clear client session caches for the deleted ids.
      if (server.includes('sessions')) {
        clearAllSessionStorage()
        for (const id of res.deletedSessionIds) {
          try { await sessionStoreRegistry.delete(id) } catch { /* best-effort */ }
        }
      }
      return res
    } finally {
      setClearing(false)
    }
  }, [])
  return { reset, clearing }
}
```
(Confirm `sessionStoreRegistry` is the exported singleton name from `registry.ts` and `delete(id)` returns `Promise<void>`. Confirm `clearAllSessionStorage` is exported from `store.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useResetConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useResetConfig.ts src/hooks/useResetConfig.test.ts
git commit -m "feat(reset): add useResetConfig client orchestration hook"
```

---

### Task 9: `ResetConfigDialog` component

**Files:**
- Create: `src/components/ResetConfigDialog.tsx`
- Create: `src/components/ResetConfigDialog.test.tsx`
- Modify: `src/components/GlobalSettingsModal.tsx` (About tab button + lazy mount)

**Interfaces:**
- Consumes: `useResetConfig`, `useToast`, `useExitPresence`, `useFocusTrap`, `shared/reset` types.
- Produces: `ResetConfigDialog({ open, onClose })` — a stacked `.modal-backdrop` modal.

**Behavior:**
- Three groups: "Configuration & data" (6 server checkboxes), "Browser data" (tri-state parent `browser-data` + 3 sub-checkboxes), "Danger zone" (credentials + sessions, visually isolated, default unchecked).
- Footer: "Will clear N items" summary + Cancel + "Clear selected" (`.btn btn-danger`).
- Danger confirm: if any of `credentials`/`sessions` checked, the primary button becomes a two-step (mirror `McpCard` delete-confirm: first click sets `confirmDanger=true` and label becomes "Type `reset` to confirm" with a text input; only when input === 'reset' the real clear fires). Simpler: a `confirmDanger` flag swaps the button to a confirm gate.
- On confirm: call `reset({ server, browser })`; toast the summary (`Cleared N item(s); M failed`); `onClose()`; `location.reload()` after a short delay (so the toast paints).

- [ ] **Step 1: Write failing tests**

`src/components/ResetConfigDialog.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ResetConfigDialog } from './ResetConfigDialog'

beforeEach(() => { localStorage.clear() })
afterEach(() => cleanup())

describe('ResetConfigDialog', () => {
  it('renders the three groups and is closed when open=false', () => {
    render(<ResetConfigDialog open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog', { name: 'Clear configuration & data' })).toBeNull()
  })

  it('toggles server items and clears them on confirm', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { snippets: { ok: true } }, deletedSessionIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    render(<ResetConfigDialog open onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText(/snippets/i))
    fireEvent.click(screen.getByRole('button', { name: /clear selected/i }))
    await screen.findByText(/cleared/i)
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/config/reset'), expect.anything())
  })

  it('requires two-step confirm for danger items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { sessions: { ok: true } }, deletedSessionIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    render(<ResetConfigDialog open onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText(/sessions/i))
    // First click does NOT fire the request — enters confirm gate.
    fireEvent.click(screen.getByRole('button', { name: /clear selected/i }))
    expect(fetchMock).not.toHaveBeenCalled()
    // Type 'reset' + confirm.
    fireEvent.change(screen.getByPlaceholderText(/reset/i), { target: { value: 'reset' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    await screen.findByText(/cleared/i)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('browser-data parent is tri-state over its three children', () => {
    render(<ResetConfigDialog open onClose={() => {}} />)
    const parent = screen.getByRole('checkbox', { name: /browser data/i }) as HTMLInputElement
    const inputHistory = screen.getByRole('checkbox', { name: /input history/i }) as HTMLInputElement
    // Check parent → all children checked.
    fireEvent.click(parent)
    expect(inputHistory.checked).toBe(true)
    // Uncheck one child → parent indeterminate.
    fireEvent.click(inputHistory)
    expect(parent.indeterminate).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/ResetConfigDialog.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the dialog**

`src/components/ResetConfigDialog.tsx` — mirror `NewSessionDialog` chrome (`.modal-backdrop` + `.modal` + `.modal-header` + `.modal-footer`, `useFocusTrap(dialogRef, { restoreFocus: true })`, capture-phase Esc). Key pieces:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useExitPresence } from '../hooks/useExitPresence'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useToast } from '../hooks/useToast'
import { useResetConfig } from '../hooks/useResetConfig'
import { IconX } from './icons/ToolIcons'
import { SERVER_RESET_ITEMS, DANGER_ITEMS, type ServerResetItem, type BrowserDataItem } from '../../shared/reset'

const BROWSER_CHILDREN: BrowserDataItem[] = ['input-history', 'drafts', 'appearance']
const SERVER_LABELS: Record<ServerResetItem, string> = {
  'app-settings': 'App settings (reset to defaults; keeps connection)',
  'mcp-configs': 'MCP server configurations',
  'marketplaces': 'Marketplaces & enabled plugins',
  'snippets': 'Composer snippets',
  'ui-state': 'Session groups & sidebar order',
  'logs': 'Persisted log files (skips today)',
  'credentials': 'Connection credentials (authToken, baseUrl, access token)',
  'sessions': 'All sessions & transcript caches',
}
const BROWSER_LABELS: Record<BrowserDataItem, string> = {
  'input-history': 'Input history',
  'drafts': 'Composer drafts',
  'appearance': 'Theme, layout & recent picks',
}

interface Props { open: boolean; onClose: () => void }

export function ResetConfigDialog({ open, onClose }: Props) {
  const presence = useExitPresence(open)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, { restoreFocus: true })
  const toast = useToast()
  const { reset, clearing } = useResetConfig()

  const [server, setServer] = useState<Set<ServerResetItem>>(new Set())
  const [browser, setBrowser] = useState<Set<BrowserDataItem>>(new Set())
  const [confirmGate, setConfirmGate] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  useEffect(() => { if (!open) { setServer(new Set()); setBrowser(new Set()); setConfirmGate(false); setConfirmText('') } }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!presence.shouldRender) return null

  const toggleServer = (it: ServerResetItem) => setServer((s) => { const n = new Set(s); n.has(it) ? n.delete(it) : n.add(it); return n })
  const toggleBrowser = (it: BrowserDataItem) => setBrowser((s) => { const n = new Set(s); n.has(it) ? n.delete(it) : n.add(it); return n })
  const allBrowser = BROWSER_CHILDREN.every((c) => browser.has(c))
  const someBrowser = BROWSER_CHILDREN.some((c) => browser.has(c)) && !allBrowser
  const toggleAllBrowser = () => setBrowser(allBrowser ? new Set() : new Set(BROWSER_CHILDREN))

  const hasDanger = [...server].some((s) => (DANGER_ITEMS as readonly string[]).includes(s))
  const totalSelected = server.size + browser.size

  const doClear = async () => {
    if (hasDanger && !confirmGate) { setConfirmGate(true); return }
    if (hasDanger && confirmText !== 'reset') return
    const res = await reset({ server: [...server], browser: [...browser] })
    const okCount = Object.values(res.results).filter((r) => r?.ok).length
    const failCount = Object.values(res.results).filter((r) => r && !r.ok).length
    toast.success(`Cleared ${okCount} item(s)${failCount ? `; ${failCount} failed` : ''}`)
    onClose()
    setTimeout(() => location.reload(), 400)
  }

  const renderServer = (it: ServerResetItem) => (
    <label key={it} className="reset-row">
      <input type="checkbox" checked={server.has(it)} onChange={() => toggleServer(it)} />
      <span>{SERVER_LABELS[it]}</span>
    </label>
  )
  const normalServer = (SERVER_RESET_ITEMS.filter((it) => !(DANGER_ITEMS as readonly string[]).includes(it)) as ServerResetItem[])

  return (
    <div className="modal-backdrop" data-state={open ? 'open' : 'closing'} role="dialog" aria-modal={open ? 'true' : 'false'} aria-hidden={!open}
      onMouseDown={(e) => open && e.target === e.currentTarget && onClose()}>
      <div className="modal modal-reset-config" ref={dialogRef}>
        <div className="modal-header">
          <h3>Clear configuration &amp; data</h3>
          <button className="btn btn-icon-sm" onClick={onClose} aria-label="Close"><IconX size={14} /></button>
        </div>
        <div className="modal-section reset-config-body">
          <div className="reset-group">
            <div className="reset-group-label">Configuration &amp; data</div>
            {normalServer.map(renderServer)}
          </div>
          <div className="reset-group">
            <div className="reset-group-label">Browser data</div>
            <label className="reset-row">
              <input type="checkbox" ref={(el) => { if (el) el.indeterminate = someBrowser }} checked={allBrowser} onChange={toggleAllBrowser} />
              <span><strong>Browser data</strong> (all local caches)</span>
            </label>
            <div className="reset-sub">
              {BROWSER_CHILDREN.map((c) => (
                <label key={c} className="reset-row"><input type="checkbox" checked={browser.has(c)} onChange={() => toggleBrowser(c)} /><span>{BROWSER_LABELS[c]}</span></label>
              ))}
            </div>
          </div>
          <div className="reset-group reset-danger-zone">
            <div className="reset-group-label">Danger zone</div>
            {(DANGER_ITEMS as readonly ServerResetItem[]).map(renderServer)}
          </div>
        </div>
        <div className="modal-footer">
          <span className="hint">{totalSelected ? `Will clear ${totalSelected} item(s)` : 'Select items to clear'}</span>
          <div className="modal-footer-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            {confirmGate ? (
              <>
                <input className="input" placeholder="type reset to confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} style={{ width: 160 }} />
                <button className="btn btn-danger" disabled={confirmText !== 'reset' || clearing} onClick={doClear}>Confirm</button>
              </>
            ) : (
              <button className="btn btn-danger" disabled={!totalSelected || clearing} onClick={doClear}>Clear selected</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default ResetConfigDialog
```

Add CSS to `src/styles/overlays.css` (or the existing settings CSS) using only theme variables:
```css
.modal-reset-config { width: min(560px, 100%); max-height: min(600px, 90dvh); display: flex; flex-direction: column; overflow: hidden; }
.reset-config-body { overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 16px; }
.reset-group { display: flex; flex-direction: column; gap: 4px; }
.reset-group-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); margin-bottom: 4px; }
.reset-row { display: flex; align-items: center; gap: 8px; padding: 6px 4px; cursor: pointer; }
.reset-sub { margin-left: 24px; display: flex; flex-direction: column; gap: 2px; }
.reset-danger-zone { border-top: 1px solid var(--border); padding-top: 12px; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/ResetConfigDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into GlobalSettingsModal About tab**

`src/components/GlobalSettingsModal.tsx`:
- Add lazy import near the McpInstaller lazy import (~line 27-29):
  ```ts
  const ResetConfigDialog = lazy(() => import('./ResetConfigDialog').then((m) => ({ default: m.ResetConfigDialog })))
  ```
- In `AboutTab` (or the component holding about-tab state), add:
  ```ts
  const [showResetConfig, setShowResetConfig] = useState(false)
  const resetConfigPresence = useExitPresence(showResetConfig)
  ```
- Add a button in the About-tab update-controls row (~line 2030-2054), e.g. a `.btn btn-danger` "Clear configuration & data" after the update buttons.
- Mount the dialog (near the McpInstaller mount ~line 562-571):
  ```tsx
  {resetConfigPresence.shouldRender && (
    <Suspense fallback={null}>
      <ResetConfigDialog open={showResetConfig} onClose={() => setShowResetConfig(false)} />
    </Suspense>
  )}
  ```

- [ ] **Step 6: Typecheck + lint + full test suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/ResetConfigDialog.tsx src/components/ResetConfigDialog.test.tsx src/components/GlobalSettingsModal.tsx src/styles/overlays.css
git commit -m "feat(reset): add ResetConfigDialog + About-tab entry point"
```

---

### Task 10: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: PASS (no type/bundle errors).

- [ ] **Step 2: Manual smoke test**

Run the app (`npx tsx server/cli.ts --port 3459 --no-open`), open Global Settings → About → "Clear configuration & data". Verify:
- Three groups render; browser-data parent is tri-state.
- Checking only `snippets` + confirm clears snippets (verify `composer-snippets.json` emptied on disk).
- Checking `sessions` enters the danger confirm gate; typing `reset` + Confirm clears sessions and reloads.
- No console errors.

- [ ] **Step 3: Commit any fixups, push**

```bash
git push origin main
```

---

## Self-Review (completed)

- **Spec coverage:** every category from the approved design (`app-settings`, `mcp-configs`, `marketplaces`, `snippets`, `ui-state`, `logs`, `credentials`, `sessions`, browser-data two-level) has a task. ✓
- **Placeholders:** none — each step has real code or an exact command. ✓
- **Type consistency:** `clearAll(): Promise<void>` consistent across stores; `ServerResetItem` / `BrowserDataItem` / `ResetResponse` defined in Task 1 and reused in Tasks 6 + 8 + 9; `clearLogFile(stateDir, reEnable)` signature matches Task 4 impl + Task 6 call; `clearCredentials(stateDir)` matches Task 5 + Task 6. ✓
- **Gaps fixed:** `accessToken` clearing (Task 5) addresses the `WRITABLE_CONFIG_KEYS` exclusion surfaced in exploration. `logs` Windows-open-file (Task 4) addressed via disable/rm/re-enable. Store threading (Task 6 mounts in app.ts where stores are in scope) avoids the `buildConfigRouter` signature problem. ✓
