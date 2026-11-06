# First-Party Config Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the model three first-party tool servers (`skills-tools`, `mcp-tools`, `marketplace-tools`) so it can configure skills, MCP servers, and the Claude plugin marketplace from inside a session.

**Architecture:** Code-register three in-process MCP servers in `FirstPartyToolRegistry` (same pattern as `git-tools` / `appdebug`). Each server takes a narrow host interface so handlers never touch SessionManager/stores directly and tests can fake them. MCP add/remove/enable also apply to the calling session through `SessionManager.attachGlobalMcpServer` / `detachGlobalMcpServer`; a same-name SDK server is not reconnected by `setMcpServers` (verified by spike), so synchronous apply is safe and the new tools are usable in the same user turn.

**Tech Stack:** TypeScript, Node 20 ESM, Hono, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`, `tool`), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-first-party-config-tools-design.md`

## Global Constraints

- Server and shared code compile under both tsconfigs (`npm run typecheck` runs `tsconfig.json` and `tsconfig.node.json`).
- All diagnostic logging goes through `createLogger(scope)`; never bare `console.*` for diagnostics.
- First-party tool names are BARE (`list`, `add`); the SDK FQN is `mcp__{server}__{tool}`. Never mix bare and FQN in a tool-name set.
- Every tool handler must return a `CallToolResult`; never reject the MCP call. Use `ok` / `err` / `json` / `guard` from `server/sdk-tools/call-result.ts`.
- Read-only tool names must be a subset of the tools `buildTools` actually returns; every mutating name must exist too.
- `setMcpServers` has REPLACE semantics over the dynamic set. The host `injectAll` already re-adds every first-party server; do not bypass it.
- Do not touch or commit unrelated working-tree changes. Start from a feature branch (`feat/first-party-config-tools`), and `git add` only the files named in each task.
- Commit messages are Conventional Commits; end every commit body with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- No new CSS and no client changes: this is a server-only change.

## Review Focus

1. **Project-scope skill op with no cwd** — must return a clear error and must never fall back to the user-scope directory. Pinned in Task 5.
2. **Inheriting MCP session (`mcpServerNames === undefined`)** — attach must not pin it to an explicit list; it must keep following global changes. Pinned in Task 4.
3. **`mcp.add` on an existing name without `overwrite`** — must not overwrite silently; it must return a guidance error. Pinned in Task 6.
4. **MCP read tools** — must return masked configs only; env/header values never cross the tool result. Pinned in Tasks 2, 6 and 8.
5. **`mcp.remove` / `set_enabled(false)`** — must detach only the calling session; other live sessions keep their connection. Pinned in Tasks 4 and 6.

---

## Task 1: Thread the session id into first-party tool builders

**Files:**
- Modify: `server/sdk-tools/types.ts`
- Modify: `server/sdk-tools/registry.ts`
- Modify: `server/session-manager-mcp.ts`
- Test: `server/sdk-tools/registry.test.ts`

**Interfaces:**
- Produces:
```ts
export interface FirstPartyToolBuildContext {
  /** Present when built for a real session; absent for metadata listing. */
  sessionId?: string
}
buildTools(cwd: string | null, ctx?: FirstPartyToolBuildContext): SdkMcpToolDefinition<any>[]
injectAll(
  cwd: string | null,
  enabled: (name: string) => boolean,
  onError?: (name: string, message: string) => void,
  ctx?: FirstPartyToolBuildContext,
): Record<string, unknown> | undefined
```
- Consumes (Task 6+): `ctx.sessionId` inside `mcp-tools` handlers.

- [ ] **Step 1: Write the failing test**

Add to `server/sdk-tools/registry.test.ts`:

```ts
it('injectAll forwards the build context to buildTools; listToolDefs omits it', () => {
  const r = new FirstPartyToolRegistry()
  const built = vi.fn(() => [])
  r.register({ ...makeServer('ctx'), buildTools: built })
  r.injectAll('/repo', () => true, undefined, { sessionId: 's1' })
  expect(built).toHaveBeenCalledWith('/repo', { sessionId: 's1' })
  built.mockClear()
  r.listToolDefs()
  expect(built).toHaveBeenCalledWith(null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/sdk-tools/registry.test.ts -t "forwards the build context"`
Expected: FAIL because `buildTools` receives only one argument / `injectAll` rejects a fourth argument.

- [ ] **Step 3: Implement the context parameter**

In `server/sdk-tools/types.ts` add `FirstPartyToolBuildContext` and change the `buildTools` signature. In `server/sdk-tools/registry.ts`, add the optional `ctx` parameter to `injectAll` and call `s.buildTools(cwd, ctx)`. In `server/session-manager-mcp.ts`'s `injectAll`, pass `{ sessionId: s.id }` as the fourth argument.

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/sdk-tools/registry.test.ts server/sdk-tools/app-tools.test.ts`
Expected: PASS (existing `buildTools(cwd)` implementations ignore the extra argument).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add server/sdk-tools/types.ts server/sdk-tools/registry.ts server/session-manager-mcp.ts server/sdk-tools/registry.test.ts
git commit -m "feat(sdk-tools): pass session context into first-party tool builders

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: Extract MCP config writes into `server/mcp-ops.ts`

**Files:**
- Create: `server/mcp-ops.ts`
- Modify: `server/mcp-routes.ts` (create / update / delete / toggle handlers)
- Test: `server/mcp-ops.test.ts`

**Interfaces:**
- Produces:
```ts
export function createMcpServer(store: McpConfigStore, input: McpServerInput): StoredMcpServer
export function updateMcpServer(
  store: McpConfigStore,
  name: string,
  input: Partial<McpServerInput>,
): StoredMcpServer
export function removeMcpServer(store: McpConfigStore, name: string): void
export function setMcpServerEnabled(
  store: McpConfigStore,
  name: string,
  enabled: boolean,
): StoredMcpServer
```
- Semantics are byte-identical to today's routes: create rejects an existing name with 409 and validates with `validateMcpServer`; update merges `env`/`headers`; all mutations set `updatedAt`.

- [ ] **Step 1: Write the failing test**

Create `server/mcp-ops.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { McpConfigStore } from './mcp-config.js'
import { createMcpServer, updateMcpServer, removeMcpServer, setMcpServerEnabled } from './mcp-ops.js'
import { tempDir } from './__test-utils__/index.js'

describe('mcp-ops', () => {
  let dir: string
  let store: McpConfigStore
  beforeEach(async () => {
    dir = tempDir('mcp-ops')
    store = new McpConfigStore({ stateDir: dir })
    await store.load()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('create validates and defaults type/enabled', () => {
    const s = createMcpServer(store, { name: 'pw', command: 'node', args: ['x.js'] })
    expect(s.type).toBe('stdio')
    expect(s.enabled).toBe(true)
    expect(store.get('pw')?.command).toBe('node')
  })

  it('create rejects a duplicate and an invalid command', () => {
    createMcpServer(store, { name: 'pw', command: 'node' })
    expect(() => createMcpServer(store, { name: 'pw', command: 'node' })).toThrow(/already exists/)
    expect(() => createMcpServer(store, { name: 'bad', command: 'curl' })).toThrow(/not in the allowlist/)
  })

  it('update merges env/headers and keeps existing keys', () => {
    createMcpServer(store, { name: 'pw', command: 'node', env: { A: '1', B: '2' } })
    const s = updateMcpServer(store, 'pw', { env: { B: '3', C: '4' } })
    expect(s.env).toEqual({ A: '1', B: '3', C: '4' })
  })

  it('remove and setEnabled reject an unknown name', () => {
    expect(() => removeMcpServer(store, 'nope')).toThrow(/not found/)
    expect(() => setMcpServerEnabled(store, 'nope', false)).toThrow(/not found/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/mcp-ops.test.ts`
Expected: FAIL because `server/mcp-ops.ts` does not exist.

- [ ] **Step 3: Implement `server/mcp-ops.ts` and rewire the four route handlers**

Move the bodies of `POST /`, `PUT /:name`, `DELETE /:name`, `POST /:name/toggle` from `server/mcp-routes.ts` into the four functions. The route handlers become: parse body → call the function → `c.json({ server: maskSecrets(...) })` / `{ ok: true }`, preserving status codes (201 for create, 409 duplicate, 404 unknown, 400 invalid).

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/mcp-ops.test.ts server/mcp-routes.test.ts`
Expected: PASS (route response shapes unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/mcp-ops.ts server/mcp-ops.test.ts server/mcp-routes.ts
git commit -m "refactor(mcp): extract global MCP writes into mcp-ops

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: Extract marketplace DTOs and plugin toggling into `server/mp-ops.ts`

**Files:**
- Modify: `server/mp-ops.ts`
- Modify: `server/routes/mp-marketplace.ts`
- Test: `server/mp-ops.test.ts`

**Interfaces:**
- Produces:
```ts
export interface MpListItem { id: string; displayName: string; source: MpEntry['source'] & { branch?: string }; addedAt: number; lastRefreshedAt: number; lastSha: string; pluginCount: number; enabledCount: number; manifestVersion?: string; ownerName?: string }
export interface PluginListItem { name: string; description?: string; version?: string; author?: string; category?: string; tags?: string[]; enabled: boolean }
export interface MpUpdateStatusItem { id: string; hasUpdate: boolean; remoteSha?: string; error?: string }

export function toMpListItem(e: MpEntry, store: MpStore): MpListItem
export function toPluginListItem(p: ParsedPlugin, enabled: boolean): PluginListItem
export function listMarketplaces(store: MpStore): MpListItem[]
export function listMarketplacePlugins(store: MpStore, id: string): PluginListItem[]
export async function checkMarketplaceUpdates(store: MpStore): Promise<MpUpdateStatusItem[]>
export async function applyPluginToggleToLiveSessions(sm: SessionManager, pluginKey: string, enabled: boolean): Promise<void>
export async function setMarketplacePluginEnabled(
  store: MpStore,
  sm: SessionManager,
  id: string,
  plugin: string,
  enabled: boolean,
): Promise<PluginListItem>
```
- Consumes: `MpStore.list/get/has/setEnabled/flush/keyOf/enabledMapFor/pruneExternalClones`, `addMarketplaceByUrl` (already here).

- [ ] **Step 1: Write the failing test**

Create `server/mp-ops.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { applyPluginToggleToLiveSessions, listMarketplaces, toPluginListItem } from './mp-ops.js'
import type { MpEntry, MpStore } from './mp-store.js'
import type { SessionManager } from './session-manager.js'

function entry(over: Partial<MpEntry> = {}): MpEntry {
  return {
    id: 'mp-id',
    displayName: 'MP',
    source: { type: 'https', url: 'https://github.com/a/b' },
    cloneDir: '/tmp/mp',
    addedAt: 1,
    lastRefreshedAt: 2,
    lastSha: 'a'.repeat(40),
    manifest: {
      name: 'MP',
      plugins: [
        { name: 'p1', dir: '/tmp/mp/p1' },
        { name: 'p2', dir: '/tmp/mp/p2' },
      ],
    },
    ...over,
  }
}

const store = {
  enabledMapFor: () => ({ p1: true }),
} as unknown as MpStore

describe('mp-ops', () => {
  it('listMarketplaces computes plugin/enabled counts', () => {
    const list = listMarketplaces({ list: () => [entry()], enabledMapFor: store.enabledMapFor } as unknown as MpStore)
    expect(list[0]).toMatchObject({ id: 'mp-id', pluginCount: 2, enabledCount: 1 })
  })

  it('toPluginListItem exposes the enabled flag and hides dir', () => {
    expect(toPluginListItem({ name: 'p1', dir: '/x', description: 'd' }, true)).toEqual({
      name: 'p1', description: 'd', version: undefined, author: undefined,
      category: undefined, tags: undefined, enabled: true,
    })
  })

  it('applyPluginToggleToLiveSessions touches only running sessions', async () => {
    const sm = {
      list: () => [
        { id: 'live', running: true },
        { id: 'sleep', running: false },
      ],
      togglePlugin: vi.fn(async () => ({})),
      reloadPlugins: vi.fn(async () => ({})),
    } as unknown as SessionManager
    await applyPluginToggleToLiveSessions(sm, 'p1@mp-id', true)
    expect(sm.togglePlugin).toHaveBeenCalledTimes(1)
    expect(sm.togglePlugin).toHaveBeenCalledWith('live', 'p1@mp-id', true)
    expect(sm.reloadPlugins).toHaveBeenCalledWith('live')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/mp-ops.test.ts`
Expected: FAIL because the exports do not exist.

- [ ] **Step 3: Implement the helpers and rewire the marketplace routes**

Move `MpListItem` / `PluginListItem` / `MpUpdateStatusItem`, `toListItem` / `toPluginListItem`, the check-updates loop, `applyToggleToLiveSessions`, `ensureExternalClone`, and the plugin-toggle body from `server/routes/mp-marketplace.ts` into `server/mp-ops.ts`. The routes call the new functions and keep their response shapes (`{ marketplaces }`, `{ plugins }`, `{ ok: true, updates }`, `{ ok: true, plugin }`, `{ ok: true, entry, warnings }`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/mp-ops.test.ts server/routes/mp-marketplace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/mp-ops.ts server/mp-ops.test.ts server/routes/mp-marketplace.ts
git commit -m "refactor(marketplace): extract DTOs and plugin toggling into mp-ops

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 4: Attach / detach a global MCP server on the calling session

**Files:**
- Create: `server/mcp-attach.ts`
- Modify: `server/session-manager-mcp.ts`
- Modify: `server/session-manager.ts`
- Test: `server/mcp-attach.test.ts`, `server/session-manager-mcp.test.ts`

**Interfaces:**
- Produces:
```ts
// server/mcp-attach.ts
export interface AttachPlanInput {
  sessionNames: string[] | undefined   // undefined = inherits the global enabled set
  /** Names currently live on the session (`Object.keys(dynamicMcpServers ?? {})`). */
  runtimeNames: string[]
  globalEnabledNames: string[]
  name: string
}
export interface AttachPlan {
  names: string[]
  stampNames: boolean
  alreadyAttached: boolean
}
export function planAttachGlobalMcpServer(input: AttachPlanInput): AttachPlan
export function planDetachGlobalMcpServer(input: AttachPlanInput): AttachPlan

// SessionMcpManager + SessionManager proxies
attachGlobalMcpServer(id: string, name: string): Promise<{
  alreadyAttached: boolean
  added: string[]
  removed: string[]
  errors: Record<string, string>
}>
detachGlobalMcpServer(id: string, name: string): Promise<{
  alreadyAttached: boolean
  added: string[]
  removed: string[]
  errors: Record<string, string>
}>
```
- The manager preserves inline (session-only) entries from `s.dynamicMcpServers` by excluding names present in `mcpStore.get(...)`.
- `stampNames: false` for inheriting sessions; `true` for own-list sessions.

- [ ] **Step 1: Write the failing planner test**

Create `server/mcp-attach.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planAttachGlobalMcpServer, planDetachGlobalMcpServer } from './mcp-attach.js'

describe('planAttachGlobalMcpServer', () => {
  it('adds to an own-list session and stamps', () => {
    expect(planAttachGlobalMcpServer({ sessionNames: ['a'], runtimeNames: ['a'], globalEnabledNames: ['a', 'b'], name: 'b' }))
      .toEqual({ names: ['a', 'b'], stampNames: true, alreadyAttached: false })
  })

  it('does not pin an inheriting session', () => {
    expect(planAttachGlobalMcpServer({ sessionNames: undefined, runtimeNames: [], globalEnabledNames: ['a'], name: 'b' }))
      .toEqual({ names: ['a', 'b'], stampNames: false, alreadyAttached: false })
  })

  it('is idempotent only when the name is live on the session', () => {
    expect(planAttachGlobalMcpServer({ sessionNames: ['a'], runtimeNames: ['a'], globalEnabledNames: ['a'], name: 'a' }).alreadyAttached).toBe(true)
    // Globally enabled but added after spawn → not live → must attach.
    expect(planAttachGlobalMcpServer({ sessionNames: undefined, runtimeNames: [], globalEnabledNames: ['a'], name: 'a' }).alreadyAttached).toBe(false)
  })
})

describe('planDetachGlobalMcpServer', () => {
  it('removes from an own-list session and keeps the stamp', () => {
    expect(planDetachGlobalMcpServer({ sessionNames: ['a', 'b'], runtimeNames: ['a', 'b'], globalEnabledNames: ['a', 'b'], name: 'b' }))
      .toEqual({ names: ['a'], stampNames: true, alreadyAttached: true })
  })

  it('removes from an inheriting session without stamping', () => {
    expect(planDetachGlobalMcpServer({ sessionNames: undefined, runtimeNames: ['a', 'b'], globalEnabledNames: ['a', 'b'], name: 'b' }))
      .toEqual({ names: ['a'], stampNames: false, alreadyAttached: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/mcp-attach.test.ts`
Expected: FAIL because `server/mcp-attach.ts` does not exist.

- [ ] **Step 3: Implement the planner**

`planAttach`/`planDetach` operate on `sessionNames ?? globalEnabledNames`, dedupe with `[...new Set(names)]`, and return the plan. `stampNames` is `sessionNames !== undefined`. `alreadyAttached` is `runtimeNames.includes(name)` — NOT membership in `globalEnabledNames`: a globally enabled server added after spawn is not live on an inheriting session and must still be attached.

- [ ] **Step 4: Write the manager test**

Create `server/session-manager-mcp.test.ts` with a fake `McpManagerDeps`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { SessionMcpManager, type McpManagerDeps } from './session-manager-mcp.js'

function makeDeps(session: Record<string, unknown>) {
  const setMcpServers = vi.fn(async () => ({ added: ['b'], removed: [], errors: {} }))
  const configs: Record<string, unknown> = { a: { type: 'stdio', command: 'node' }, b: { type: 'stdio', command: 'node' } }
  const mcpStore = {
    toSdkConfig: () => ({ a: configs.a }),
    getSdkServerConfig: (n: string) => configs[n] ?? null,
    get: (n: string) => (n in configs ? { name: n } : undefined),
    refreshOAuthTokens: async () => {},
  }
  const deps = {
    requireLive: () => session,
    require: () => session,
    requireHandleMethod: () => setMcpServers,
    writeStore: vi.fn(),
    broadcastGlobal: vi.fn(),
    info: () => ({}),
    persist: vi.fn(),
    mcpStore,
    timeSdkControl: async (_id: string, _label: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as McpManagerDeps
  return { deps, setMcpServers }
}

it('attach preserves an inheriting session (no mcpServerNames stamp)', async () => {
  const session: Record<string, unknown> = { id: 's1', cwd: undefined, mcpServerNames: undefined, dynamicMcpServers: { inline: { type: 'stdio', command: 'node' } } }
  const { deps, setMcpServers } = makeDeps(session)
  const m = new SessionMcpManager(deps)
  const res = await m.attachGlobalMcpServer('s1', 'b')
  expect(res.added).toEqual(['b'])
  expect(session.mcpServerNames).toBeUndefined()
  expect(setMcpServers).toHaveBeenCalledWith({ a: expect.anything(), inline: { type: 'stdio', command: 'node' }, b: expect.anything() })
})

it('attach stamps an own-list session', async () => {
  const session: Record<string, unknown> = { id: 's1', cwd: undefined, mcpServerNames: ['a'], dynamicMcpServers: undefined }
  const { deps } = makeDeps(session)
  const m = new SessionMcpManager(deps)
  await m.attachGlobalMcpServer('s1', 'b')
  expect(session.mcpServerNames).toEqual(['a', 'b'])
})
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run server/session-manager-mcp.test.ts`
Expected: FAIL because the methods do not exist.

- [ ] **Step 6: Implement the methods**

In `SessionMcpManager`:
- Add `stampNames?: boolean` to `setMcpServers`'s options; only assign `s.mcpServerNames` when it is not `false`.
- `attachGlobalMcpServer` / `detachGlobalMcpServer` build the plan with `runtimeNames: Object.keys(s.dynamicMcpServers ?? {})`, collect inline entries (`s.dynamicMcpServers` minus global names via `mcpStore.get`), and return early when `alreadyAttached`. Otherwise `await this.mergeMcpServersAsync(plan.names, inline)`, call `this.setMcpServers(id, merged ?? {}, { stampNames: plan.stampNames })`, and return the plan's `alreadyAttached` plus the SDK result's `added/removed/errors`.
- In `SessionManager`, add proxies wrapped in `this.opLock.run(id, ...)`:
```ts
async attachGlobalMcpServer(id: string, name: string) {
  return this.opLock.run(id, () => this.mcp.attachGlobalMcpServer(id, name))
}
async detachGlobalMcpServer(id: string, name: string) {
  return this.opLock.run(id, () => this.mcp.detachGlobalMcpServer(id, name))
}
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run server/mcp-attach.test.ts server/session-manager-mcp.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/mcp-attach.ts server/mcp-attach.test.ts server/session-manager-mcp.ts server/session-manager-mcp.test.ts server/session-manager.ts
git commit -m "feat(mcp): attach and detach global servers on the calling session

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: `skills-tools` server

**Files:**
- Create: `server/sdk-tools/skills-tools.ts`
- Test: `server/sdk-tools/skills-tools.test.ts`

**Interfaces:**
- Produces:
```ts
export const SKILLS_TOOLS_SERVER_NAME = 'skills-tools'
export const SKILLS_READ_ONLY_TOOLS: ReadonlySet<string>   // list, get, validate
export const SKILLS_MUTATING_TOOLS: ReadonlySet<string>    // create, update, delete
export interface SkillsToolsHost {
  reloadSkillsForCwd(cwd?: string): Promise<unknown>
}
export function buildSkillsTools(host: SkillsToolsHost, cwd: string | null): SdkMcpToolDefinition<any>[]
export function createSkillsTools(host: SkillsToolsHost): FirstPartyToolServer
```
- Tools: `list`, `get`, `validate`, `create`, `update`, `delete`.
- Project scope requires `cwd`; user scope does not.

- [ ] **Step 1: Write the failing test**

Create `server/sdk-tools/skills-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../__test-utils__/index.js'
import { buildSkillsTools, createSkillsTools, SKILLS_READ_ONLY_TOOLS } from './skills-tools.js'

const host = { reloadSkillsForCwd: vi.fn(async () => ({})) }
const userDir = tempDir('skills-user')
const projectDir = tempDir('skills-project')
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR

function call(name: string, input: unknown, cwd: string | null) {
  const def = buildSkillsTools(host, cwd).find((t) => t.name === name)
  if (!def) throw new Error(`no tool ${name}`)
  return def.handler(input as never, undefined)
}
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.find((c) => c.type === 'text')?.text ?? ''

beforeEach(() => { process.env.CLAUDE_CONFIG_DIR = userDir; vi.clearAllMocks() })
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  rmSync(userDir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

describe('skills-tools', () => {
  it('declares its read-only set as a subset of the built tools', () => {
    const names = new Set(buildSkillsTools(host, projectDir).map((t) => t.name))
    expect([...SKILLS_READ_ONLY_TOOLS].every((n) => names.has(n))).toBe(true)
  })

  it('creates a project skill and reloads the project cwd', async () => {
    const res = await call('create', { scope: 'project', name: 'demo', description: 'Demo' }, projectDir)
    expect(res.isError ?? false).toBe(false)
    expect(existsSync(join(projectDir, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(true)
    expect(host.reloadSkillsForCwd).toHaveBeenCalledWith(projectDir)
  })

  it('creates a user skill and reloads all scopes', async () => {
    await call('create', { scope: 'user', name: 'demo', description: 'Demo' }, projectDir)
    expect(existsSync(join(userDir, 'skills', 'demo', 'SKILL.md'))).toBe(true)
    expect(host.reloadSkillsForCwd).toHaveBeenCalledWith(undefined)
  })

  it('project scope without cwd is an error, never a user-scope write', async () => {
    const res = await call('create', { scope: 'project', name: 'demo' }, null)
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/cwd/i)
    expect(existsSync(join(userDir, 'skills', 'demo'))).toBe(false)
  })

  it('get returns content and validate reports errors', async () => {
    await call('create', { scope: 'project', name: 'demo', description: 'Demo' }, projectDir)
    const got = JSON.parse(text(await call('get', { scope: 'project', name: 'demo' }, projectDir)))
    expect(got.skill.content).toContain('name: demo')
    const bad = JSON.parse(text(await call('validate', { content: 'no frontmatter' }, projectDir)))
    expect(bad.ok).toBe(false)
  })

  it('list filters by scope', async () => {
    await call('create', { scope: 'project', name: 'proj', description: 'P' }, projectDir)
    await call('create', { scope: 'user', name: 'usr', description: 'U' }, projectDir)
    const user = JSON.parse(text(await call('list', { scope: 'user' }, projectDir)))
    expect(user.skills.every((s: { scope: string }) => s.scope === 'user')).toBe(true)
    const project = JSON.parse(text(await call('list', { scope: 'project' }, projectDir)))
    expect(project.skills.every((s: { scope: string }) => s.scope === 'project')).toBe(true)
  })

  it('delete removes the skill', async () => {
    await call('create', { scope: 'project', name: 'demo' }, projectDir)
    const res = await call('delete', { scope: 'project', name: 'demo' }, projectDir)
    expect(res.isError ?? false).toBe(false)
    expect(existsSync(join(projectDir, '.claude', 'skills', 'demo'))).toBe(false)
  })

  it('builds a server with the expected name and flags', () => {
    const server = createSkillsTools(host)
    expect(server.name).toBe('skills-tools')
    expect(server.defaultEnabled).toBe(true)
    expect(server.requiresCwd).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/sdk-tools/skills-tools.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement `server/sdk-tools/skills-tools.ts`**

Use `tool(name, description, schema, handler, { annotations: readOnly })` for `list/get/validate`. Each handler wraps its body in `guard(...)`. Project scope resolves `cwd`; if `cwd === null`, throw `new Error('project-scope skills require a session cwd')`. After `createSkill` / `updateSkill` / `deleteSkill`, call `await host.reloadSkillsForCwd(scope === 'project' ? cwd ?? undefined : undefined)` and include the result in the JSON.

Exact result shapes: `list` → `json({ roots, skills })`; `get` → `json({ skill })`; `validate` → `json(validation)`; `create` → `json({ skill, reload })`; `update` → `json({ skill, reload })`; `delete` → `json({ ok: true, reload })`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/sdk-tools/skills-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/sdk-tools/skills-tools.ts server/sdk-tools/skills-tools.test.ts
git commit -m "feat(sdk-tools): add skills-tools server

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 6: `mcp-tools` server

**Files:**
- Create: `server/sdk-tools/mcp-tools.ts`
- Test: `server/sdk-tools/mcp-tools.test.ts`

**Interfaces:**
- Produces:
```ts
export const MCP_TOOLS_SERVER_NAME = 'mcp-tools'
export const MCP_READ_ONLY_TOOLS: ReadonlySet<string>   // list, get
export interface McpToolsHost {
  list(): MaskedMcpServer[]
  get(name: string): MaskedMcpServer | null
  create(input: McpServerInput): MaskedMcpServer
  update(name: string, input: Partial<McpServerInput>): MaskedMcpServer
  remove(name: string): void
  setEnabled(name: string, enabled: boolean): MaskedMcpServer
  attach(sessionId: string, name: string): Promise<{ alreadyAttached: boolean; added: string[]; removed: string[]; errors: Record<string, string> }>
  detach(sessionId: string, name: string): Promise<{ alreadyAttached: boolean; added: string[]; removed: string[]; errors: Record<string, string> }>
  test(name: string): Promise<TestConnectionResult>
}
export function buildMcpTools(host: McpToolsHost, ctx?: FirstPartyToolBuildContext): SdkMcpToolDefinition<any>[]
export function createMcpTools(host: McpToolsHost): FirstPartyToolServer
```
- Tools: `list`, `get`, `add`, `update`, `remove`, `set_enabled`, `test`.
- `add` requires `overwrite: true` to replace an existing name; otherwise it returns a guidance error.
- `add` / `set_enabled(true)` attach to the calling session by default; `remove` / `set_enabled(false)` detach.

- [ ] **Step 1: Write the failing test**

Create `server/sdk-tools/mcp-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildMcpTools, createMcpTools, MCP_READ_ONLY_TOOLS } from './mcp-tools.js'

const host = {
  list: vi.fn(() => []),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setEnabled: vi.fn(),
  attach: vi.fn(async () => ({ alreadyAttached: false, added: ['pw'], removed: [], errors: {} })),
  detach: vi.fn(async () => ({ alreadyAttached: false, added: [], removed: ['pw'], errors: {} })),
  test: vi.fn(),
}

function call(name: string, input: unknown, sessionId?: string) {
  const def = buildMcpTools(host, { sessionId }).find((t) => t.name === name)
  if (!def) throw new Error(`no tool ${name}`)
  return def.handler(input as never, undefined)
}
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.find((c) => c.type === 'text')?.text ?? ''

beforeEach(() => vi.clearAllMocks())

describe('mcp-tools', () => {
  it('declares its read-only set as a subset of the built tools', () => {
    const names = new Set(buildMcpTools(host).map((t) => t.name))
    expect([...MCP_READ_ONLY_TOOLS].every((n) => names.has(n))).toBe(true)
  })

  it('add requires a session id', async () => {
    const res = await call('add', { name: 'pw', command: 'node' })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/session/i)
  })

  it('add creates then attaches to the calling session', async () => {
    host.get.mockReturnValue(null)
    host.create.mockReturnValue({ name: 'pw' })
    const res = await call('add', { name: 'pw', command: 'node' }, 's1')
    expect(host.create).toHaveBeenCalled()
    expect(host.attach).toHaveBeenCalledWith('s1', 'pw')
    expect(text(res)).toContain('"added"')
  })

  it('add refuses an existing name without overwrite', async () => {
    host.get.mockReturnValue({ name: 'pw' })
    const res = await call('add', { name: 'pw', command: 'node' }, 's1')
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/overwrite/)
    expect(host.update).not.toHaveBeenCalled()
  })

  it('add with overwrite updates instead of creating', async () => {
    host.get.mockReturnValue({ name: 'pw' })
    host.update.mockReturnValue({ name: 'pw' })
    await call('add', { name: 'pw', command: 'node', overwrite: true }, 's1')
    expect(host.update).toHaveBeenCalled()
    expect(host.create).not.toHaveBeenCalled()
  })

  it('update forwards the partial without the name', async () => {
    host.update.mockReturnValue({ name: 'pw' })
    await call('update', { name: 'pw', args: ['y.js'] }, 's1')
    expect(host.update).toHaveBeenCalledWith('pw', { args: ['y.js'] })
  })

  it('test delegates to the host', async () => {
    host.test.mockResolvedValue({ success: true, status: 'connected' })
    const res = await call('test', { name: 'pw' }, 's1')
    expect(host.test).toHaveBeenCalledWith('pw')
    expect(text(res)).toContain('"connected"')
  })

  it('remove detaches from the calling session', async () => {
    await call('remove', { name: 'pw' }, 's1')
    expect(host.remove).toHaveBeenCalledWith('pw')
    expect(host.detach).toHaveBeenCalledWith('s1', 'pw')
  })

  it('set_enabled(false) detaches; true attaches', async () => {
    await call('set_enabled', { name: 'pw', enabled: false }, 's1')
    expect(host.detach).toHaveBeenCalledWith('s1', 'pw')
    await call('set_enabled', { name: 'pw', enabled: true }, 's1')
    expect(host.attach).toHaveBeenCalledWith('s1', 'pw')
  })

  it('builds a server with the expected name and flags', () => {
    const server = createMcpTools(host)
    expect(server.name).toBe('mcp-tools')
    expect(server.defaultEnabled).toBe(true)
    expect(server.requiresCwd).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/sdk-tools/mcp-tools.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement `server/sdk-tools/mcp-tools.ts`**

`list` → `json({ servers })`; `get` → `json({ server })`; `add` → `json({ saved, attach })`; `update` → `json({ server })`; `remove` → `json({ removed: true, detach })`; `set_enabled` → `json({ server, attach })`; `test` → `json(result)`.

`list/get` return the host's already-masked values. `add` resolves `ctx?.sessionId` first (throw `new Error('this tool requires a live session context')` when absent), rejects an existing name without `overwrite`, then creates/updates and calls `host.attach`. `update` strips `name` from the input before calling `host.update`. `remove` calls `host.remove` then `host.detach` (wrap the detach in its own try/catch so a global removal still succeeds; include the detach error in the result). `set_enabled` calls `host.setEnabled` then attach/detach according to the flag (`attachToSession !== false`). `test` calls `host.test`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/sdk-tools/mcp-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/sdk-tools/mcp-tools.ts server/sdk-tools/mcp-tools.test.ts
git commit -m "feat(sdk-tools): add mcp-tools server

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 7: `marketplace-tools` server

**Files:**
- Create: `server/sdk-tools/marketplace-tools.ts`
- Test: `server/sdk-tools/marketplace-tools.test.ts`

**Interfaces:**
- Produces:
```ts
export const MARKETPLACE_TOOLS_SERVER_NAME = 'marketplace-tools'
export const MARKETPLACE_READ_ONLY_TOOLS: ReadonlySet<string>   // list, plugins, check_updates
export interface MarketplaceAddResult {
  id: string
  displayName: string
  plugins: PluginListItem[]
  warnings: Array<{ kind: string; detail: string }>
}
export interface MarketplaceToolsHost {
  list(): MpListItem[]
  plugins(id: string): PluginListItem[]
  add(url: string, ref?: string): Promise<MarketplaceAddResult>
  checkUpdates(): Promise<MpUpdateStatusItem[]>
  setPluginEnabled(id: string, plugin: string, enabled: boolean): Promise<PluginListItem>
}
export function buildMarketplaceTools(host: MarketplaceToolsHost): SdkMcpToolDefinition<any>[]
export function createMarketplaceTools(host: MarketplaceToolsHost): FirstPartyToolServer
```
- Tools: `list`, `plugins`, `add`, `check_updates`, `set_plugin_enabled`.

- [ ] **Step 1: Write the failing test**

Create `server/sdk-tools/marketplace-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildMarketplaceTools, createMarketplaceTools, MARKETPLACE_READ_ONLY_TOOLS } from './marketplace-tools.js'

const host = {
  list: vi.fn(() => [{ id: 'mp', displayName: 'MP' }]),
  plugins: vi.fn(() => [{ name: 'p1', enabled: false }]),
  add: vi.fn(async () => ({ id: 'mp', displayName: 'MP', plugins: [], warnings: [] })),
  checkUpdates: vi.fn(async () => []),
  setPluginEnabled: vi.fn(async () => ({ name: 'p1', enabled: true })),
}

function call(name: string, input: unknown) {
  const def = buildMarketplaceTools(host).find((t) => t.name === name)
  if (!def) throw new Error(`no tool ${name}`)
  return def.handler(input as never, undefined)
}
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.find((c) => c.type === 'text')?.text ?? ''

beforeEach(() => vi.clearAllMocks())

describe('marketplace-tools', () => {
  it('declares its read-only set as a subset of the built tools', () => {
    const names = new Set(buildMarketplaceTools(host).map((t) => t.name))
    expect([...MARKETPLACE_READ_ONLY_TOOLS].every((n) => names.has(n))).toBe(true)
  })

  it('add forwards url/ref to the host', async () => {
    await call('add', { url: 'https://github.com/anthropics/skills', ref: 'main' })
    expect(host.add).toHaveBeenCalledWith('https://github.com/anthropics/skills', 'main')
  })

  it('set_plugin_enabled forwards id/plugin/enabled', async () => {
    const res = await call('set_plugin_enabled', { id: 'mp', plugin: 'p1', enabled: true })
    expect(host.setPluginEnabled).toHaveBeenCalledWith('mp', 'p1', true)
    expect(text(res)).toContain('"enabled": true')
  })

  it('surfaces a host error as an isError result', async () => {
    host.add.mockRejectedValueOnce(new Error('bad url'))
    const res = await call('add', { url: 'ftp://x' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('bad url')
  })

  it('builds a server with the expected name and flags', () => {
    const server = createMarketplaceTools(host)
    expect(server.name).toBe('marketplace-tools')
    expect(server.defaultEnabled).toBe(true)
    expect(server.requiresCwd).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/sdk-tools/marketplace-tools.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement `server/sdk-tools/marketplace-tools.ts`**

Each handler wraps its body in `guard(...)`. `list` / `plugins` / `check_updates` use the `readOnlyHint` annotation. `add` calls `host.add(url, ref)`. `set_plugin_enabled` calls `host.setPluginEnabled(id, plugin, enabled)`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/sdk-tools/marketplace-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/sdk-tools/marketplace-tools.ts server/sdk-tools/marketplace-tools.test.ts
git commit -m "feat(sdk-tools): add marketplace-tools server

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 8: Register the three servers in production

**Files:**
- Create: `server/sdk-tools/config-tools.ts`
- Modify: `server/bootstrap.ts`
- Test: `server/sdk-tools/config-tools.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ConfigToolsDeps {
  registry: FirstPartyToolRegistry
  sm: SessionManager
  mcpStore: McpConfigStore
  mpStore: MpStore
}
export function registerConfigToolServers(deps: ConfigToolsDeps): void
```
- Registration is idempotent: an already-registered name is skipped.
- All three servers are `defaultEnabled: true`, `requiresCwd: false`.

- [ ] **Step 1: Write the failing test**

Create `server/sdk-tools/config-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { FirstPartyToolRegistry } from './registry.js'
import { registerConfigToolServers } from './config-tools.js'
import { McpConfigStore } from '../mcp-config.js'
import { createMcpServer } from '../mcp-ops.js'
import { MpStore } from '../mp-store.js'
import { tempDir } from '../__test-utils__/index.js'
import type { SessionManager } from '../session-manager.js'

describe('registerConfigToolServers', () => {
  let dir: string
  let mcpStore: McpConfigStore
  let mpStore: MpStore
  beforeEach(async () => {
    dir = tempDir('config-tools')
    mcpStore = new McpConfigStore({ stateDir: dir })
    await mcpStore.load()
    mpStore = new MpStore({ stateDir: dir })
    await mpStore.load()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const sm = {
    attachGlobalMcpServer: vi.fn(async () => ({ alreadyAttached: false, added: ['pw'], removed: [], errors: {} })),
    detachGlobalMcpServer: vi.fn(async () => ({ alreadyAttached: false, added: [], removed: ['pw'], errors: {} })),
    reloadSkillsForCwd: vi.fn(async () => ({ reloaded: [], failed: [] })),
  } as unknown as SessionManager

  it('registers the three servers and is idempotent', () => {
    const registry = new FirstPartyToolRegistry()
    registerConfigToolServers({ registry, sm, mcpStore, mpStore })
    registerConfigToolServers({ registry, sm, mcpStore, mpStore })
    expect(registry.list().map((s) => s.name).sort()).toEqual([
      'marketplace-tools', 'mcp-tools', 'skills-tools',
    ])
    for (const name of ['skills-tools', 'mcp-tools', 'marketplace-tools']) {
      const server = registry.get(name)!
      expect(server.defaultEnabled).toBe(true)
      expect(server.requiresCwd).toBe(false)
    }
  })

  it('wires mcp-tools add to the store and the calling session', async () => {
    const registry = new FirstPartyToolRegistry()
    registerConfigToolServers({ registry, sm, mcpStore, mpStore })
    const tool = registry.get('mcp-tools')!.buildTools(null, { sessionId: 's1' }).find((t) => t.name === 'add')!
    const res = await tool.handler({ name: 'pw', command: 'node', args: ['x.js'] } as never, undefined)
    expect(res.isError ?? false).toBe(false)
    expect(mcpStore.get('pw')?.command).toBe('node')
    expect(sm.attachGlobalMcpServer).toHaveBeenCalledWith('s1', 'pw')
  })

  it('mcp-tools list never exposes env/header values', async () => {
    const registry = new FirstPartyToolRegistry()
    registerConfigToolServers({ registry, sm, mcpStore, mpStore })
    createMcpServer(mcpStore, { name: 'pw', command: 'node', env: { TOKEN: 's3cr3t' } })
    const tool = registry.get('mcp-tools')!.buildTools(null, { sessionId: 's1' }).find((t) => t.name === 'list')!
    const res = await tool.handler({} as never, undefined)
    const firstText = (r: { content?: Array<{ type: string; text?: string }> }) =>
      r.content?.find((c) => c.type === 'text')?.text ?? ''
    const body = firstText(res)
    expect(body).toContain('envKeys')
    expect(body).not.toContain('s3cr3t')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/sdk-tools/config-tools.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement `server/sdk-tools/config-tools.ts`**

Build the three hosts:
- `skillsHost = { reloadSkillsForCwd: (cwd) => deps.sm.reloadSkillsForCwd(cwd) }`
- `mcpHost` delegates to `mcpStore` (`list().map(maskSecrets)`, `get` + `maskSecrets`, `createMcpServer`, `updateMcpServer`, `removeMcpServer`, `setMcpServerEnabled`, `testMcpConnection(server, { includeTools: true })`) and to `deps.sm.attachGlobalMcpServer` / `detachGlobalMcpServer`.
- `marketplaceHost` delegates to `listMarketplaces`, `listMarketplacePlugins`, `addMarketplaceByUrl`, `checkMarketplaceUpdates`, `setMarketplacePluginEnabled`.

Register idempotently (skip names already in the registry).

Host methods must call `deps.sm.*` / `deps.*Store.*` at call time (not capture the function at construction), so tests can swap a dependency after registration.

In `server/bootstrap.ts`, import and call immediately after the `SessionManager` is constructed:
```ts
registerConfigToolServers({ registry: firstPartyRegistry, sm: sessionManager, mcpStore, mpStore })
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/sdk-tools/config-tools.test.ts server/sdk-tools/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add server/sdk-tools/config-tools.ts server/sdk-tools/config-tools.test.ts server/bootstrap.ts
git commit -m "feat: register first-party config tool servers

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 9: Cleanup, decision note, and full verification

**Files:**
- Create: `.agents/notes/implemented/architecture/2026-11-06-first-party-config-tools.md`
- Modify: `CLAUDE.md` (first-party tool section: name the three new servers and their session-attach behavior)
- Delete: `spike/` (throwaway spike scripts + logs are not part of the change)

- [ ] **Step 1: Remove the throwaway spike**

Run: `rm -rf spike`
Expected: `spike/` is gone; it was never committed.

- [ ] **Step 2: Write the decision note**

Create the note with: why three servers (registry granularity, independent store dependencies), why `sessionId` rides in `buildTools` ctx (cwd cannot identify a session), why MCP `add` is "global + current session" two-phase (own-list vs inheritance), and the spike evidence that synchronous live apply is safe and same-turn tool use works.

- [ ] **Step 3: Update CLAUDE.md**

In the first-party tool section, list `skills-tools`, `mcp-tools`, `marketplace-tools` and one line each on their scope and session-attach behavior. Keep the existing `git-tools` / dev-only notes intact.

- [ ] **Step 4: Run the full verification**

Run: `npm run typecheck && npm run lint && npm run verify:agent-notes && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add .agents/notes/implemented/architecture/2026-11-06-first-party-config-tools.md CLAUDE.md
git commit -m "docs: record first-party config tools decision

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Execution Notes

- Work on `feat/first-party-config-tools`; do not merge to `main` until the whole-branch `code-review` passes.
- After each task, run that task's tests plus `npm run typecheck`. If a task changes route behavior, run the existing route test file named in the task.
- Before each commit, self-review the task's `git diff` (the repo forbids committing unreviewed code); the whole-branch `code-review` is the pre-merge gate.
- Task 8's integration path is the only place that ties the three servers to real stores; if it fails typecheck because of cyclic imports, keep `SessionManager` / store imports as `import type` and import only functions at runtime.