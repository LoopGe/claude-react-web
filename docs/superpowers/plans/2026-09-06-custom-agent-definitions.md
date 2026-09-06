# Custom Agent Definitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users define custom agents (full `AgentDefinition` field coverage) in a persisted store; every session gets them as subagents and a session can start "as" a custom agent.

**Architecture:** A new `AgentDefinitionStore` (over the existing `JsonFileStore` base) persists definitions to `<stateDir>/agent-definitions.json`. `cli` instantiates it, `app` threads it into the `SessionManager` (→ `createDefaultProviders` → `ClaudeProvider`), which injects `Options.agents` on every spawn and `Options.agent` for start-as sessions. Routes mount alongside the snippet router. Client: a new `Agents` tab in `SettingsPanel` (list + full-field form) and an agent dropdown in `NewSessionDialog`.

**Tech Stack:** Node/TypeScript, Hono, vitest (server tests), @anthropic-ai/claude-agent-sdk `Options.agents` / `Options.agent`, React 19 + Vite (client).

**Spec:** `docs/superpowers/specs/2026-09-06-custom-agent-definitions-design.md`

## Global Constraints

- Functional behavior asserted by tests — **TDD** per task (write failing test → run → implement → run → commit).
- Two typecheck passes always: `npm run typecheck` (tsconfig.json + tsconfig.node.json).
- All diagnostic logging via `createLogger(scope)` (`server/log.ts`); never bare `console.*`.
- Every new color via theme CSS vars (dark `:root` + `[data-theme="light"]`) — never literal hex.
- No spec placeholder (TBD) without a task: the two empirical unknowns are resolved by **Task 1 spike**; downstream tasks use the **fallback-safe** path regardless of spike verdict, so no task blocks on spike output.
- `name` is the immutable, unique key → rename = delete + create. `enabled: false` defs are never injected and rejected as a start-as target.
- Restart-to-apply: definitions reach only sessions spawned after the change; **no** auto-respawn. **Deferred from spec §5's `agents-updated` WS cross-tab broadcast + toast** — the management surface is single-tab per app instance and refetches on its own mutations, so a cross-tab/WS event has no live consumer; skip it unless a concrete multi-client need appears (record as a follow-up, not a task blocker).
- Store file name `agent-definitions.json`; logger scope label `agent-definitions`.

---

### Task 0: De-risking spike (throwaway — NOT committed)

Verify the two empirical unknowns from the spec. Output is a plain-text verdict recorded to `/tmp/cwa-spike-notes.txt`; no code is kept.

**Files:**
- Create (throwaway, do not commit): `/tmp/cwa-spike.mjs`

**Interfaces:**
- Consumes: a local `@anthropic-ai/claude-agent-sdk` (`query`).
- Produces: recorded answers to (1) does `supportedAgents()` reflect injected `Options.agents`? and (2) does `Options.agent` as main-thread agent honor `initialPrompt` + the definition's `model`, and how does it merge with top-level `Options.model`? Downstream tasks use the fallback path regardless.

- [ ] **Step 1: Write the throwaway probe**

```js
// /tmp/cwa-spike.mjs — run with node. Requires ANTHROPIC_API_KEY (or config) reachable.
import { query } from '@anthropic-ai/claude-agent-sdk'

const options = {
  cwd: process.cwd(),
  model: 'sonnet',
  agents: {
    'spike-probe': {
      description: 'probe agent',
      prompt: 'You are a probe agent. Reply with exactly the single word READY.',
    },
  },
  includePartialMessages: true,
}

// Probe 1: are injected agents surfaced in supportedAgents?
const q1 = query({ prompt: '', options })
try {
  const init = await q1.initializationResult()
  const sample = await q1.supportedAgents()
  console.log('PROBE1 supportedAgents:', JSON.stringify(sample.map((a) => a.name)))
} catch (e) { console.log('PROBE1 ERR', e) }
q1.close()

// Probe 2: does starting a session AS the agent run initialPrompt + honor its model?
const q2 = query({
  prompt: '', // empty: the agent's initialPrompt should auto-run
  options: {
    ...options,
    agent: 'spike-probe',
    title: 'spike-probe-as-main',
  },
})
let sawTurn = false, sawReady = false
for await (const m of q2) {
  if (m.type === 'assistant') {
    sawTurn = true
    const text = m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
    if (/READY/i.test(text)) sawReady = true
    console.log('PROBE2 assistant text:', JSON.stringify(text.slice(0, 120)))
  }
  if (sawTurn) break
}
console.log('PROBE2 initialPrompt-autoran:', sawReady, 'any-turn:', sawTurn)
q2.close()

// Record the model: report which model headline the assistant turn carried (from SDKUserMessage/stream events) — inspect a few frames to note the resolved model id.
```

- [ ] **Step 2: Run it and capture the verdict**

Run: `node /tmp/cwa-spike.mjs > /tmp/cwa-spike-notes.txt 2>&1` (workspace: `/Users/loop/Codes/claude-react-web`; ensure a valid API env/config first).
Expected: file contains PROBE1 and PROBE2 lines. If PROBE1 lists `spike-probe` → injected agents DO surface (spike confirms); regardless, **Task 5's union stays in** (spec §4). If PROBE2 `autoran:true` → `Options.agent` works (confirms start-as); regardless, **Task 6 still prefills model/permissionMode/effort from the def** (spec fallback).

- [ ] **Step 3: Stop and note findings**

No commit (throwaway). Leave `/tmp/cwa-spike-notes.txt` for the executor of Tasks 5/6. **Do NOT delete it until Tasks 5 and 6 land.**

---

### Task 1: AgentDefinitionStore (server)

**Files:**
- Create: `server/agent-definition-store.ts`
- Create: `server/agent-definition-store.test.ts`

**Interfaces:**
- Consumes: `JsonFileStore`, `JsonFileStoreOptions` from `./json-file-store.js`; `DEFAULT_DIR_NAME` from same; `createLogger` from `./log.js`; `type AgentDefinition` from `@anthropic-ai/claude-agent-sdk`.
- Produces (used by later tasks):
  - `export interface StoredAgentDefinition extends AgentDefinition { name: string; enabled: boolean; createdAt: number; updatedAt: number }`
  - `export type AgentDefinitionStoreOptions = JsonFileStoreOptions`
  - `export class AgentDefinitionStore extends JsonFileStore<StoredAgentDefinition>` with:
    - `constructor(opts?: AgentDefinitionStoreOptions)`
    - `protected getKey(def): string`
    - `protected parseItems(raw: string): StoredAgentDefinition[]`
    - `protected serializeForWrite(items: StoredAgentDefinition[]): unknown`
    - `async load(): Promise<StoredAgentDefinition[]>`
    - `getEnabledDefinitions(): Record<string, AgentDefinition>` — enabled defs only, `name`/`enabled`/`createdAt`/`updatedAt` stripped.
  - `export function coerceStoredAgentDefinition(raw: unknown): StoredAgentDefinition | null`
  - The `AgentDefinition` membership fields constant `AGENT_FIELDS` (below) is shared by the route validator in Task 2.

- [ ] **Step 1: Write the failing tests**

```ts
// server/agent-definition-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentDefinitionStore, coerceStoredAgentDefinition } from './agent-definition-store.js'

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-ads-'))
  return new AgentDefinitionStore({ stateDir: dir })
}

function baseDef(over = {}) {
  return { name: 'reviewer', description: 'Reviews code', prompt: 'You are a reviewer.', enabled: true, createdAt: 1, updatedAt: 1, ...over }
}

describe('AgentDefinitionStore', () => {
  let store: AgentDefinitionStore
  beforeEach(async () => { store = makeStore(); await store.load() })

  it('loads empty on a missing/corrupt file', async () => {
    expect(store.list()).toEqual([])
  })

  it('round-trips upsert/remove via getKey = name', async () => {
    store.upsert(baseDef())
    store.upsert(baseDef({ name: 'r2', description: 'b' }))
    expect(store.get('reviewer')?.prompt).toBe('You are a reviewer.')
    store.remove('reviewer')
    expect(store.has('reviewer')).toBe(false)
    expect(store.get('r2')).toBeDefined()
  })

  it('getEnabledDefinitions strips bookkeeping and filters disabled', () => {
    store.upsert(baseDef())
    store.upsert(baseDef({ name: 'off', enabled: false }))
    const defs = store.getEnabledDefinitions()
    expect(Object.keys(defs)).toEqual(['reviewer'])
    expect(defs.reviewer).not.toHaveProperty('name')
    expect(defs.reviewer).not.toHaveProperty('enabled')
    expect(defs.reviewer).toHaveProperty('prompt', 'You are a reviewer.')
  })

  it('coerceStoredAgentDefinition rejects malformed entries', () => {
    expect(coerceStoredAgentDefinition({ name: 'x' })).toBeNull() // missing prompt/description
    expect(coerceStoredAgentDefinition(baseDef({ prompt: '' }))).toBeNull()
    expect(coerceStoredAgentDefinition(baseDef({ name: 42 }))).toBeNull()
    expect(coerceStoredAgentDefinition(baseDef({ model: '' }))).toBeNull() // empty model rejected
    expect(coerceStoredAgentDefinition(baseDef())).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to confirm the file/types are missing**

Run: `npx vitest run server/agent-definition-store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the store**

```ts
// server/agent-definition-store.ts
import { promises as fs } from 'node:fs'
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import type { JsonFileStoreOptions } from './json-file-store.js'
import { createLogger } from './log.js'

const log = createLogger('agent-definitions')

/** Fields that make up an SDK AgentDefinition, in Options.agents payload shape. */
export const AGENT_FIELDS = [
  'description', 'prompt', 'tools', 'disallowedTools', 'model', 'mcpServers',
  'skills', 'memory', 'effort', 'permissionMode', 'maxTurns', 'background',
  'initialPrompt', 'observer', 'observerMessage', 'criticalSystemReminder_EXPERIMENTAL',
] as const

export type AgentField = (typeof AGENT_FIELDS)[number]

/** A stored definition: the SDK AgentDefinition plus app bookkeeping. */
export interface StoredAgentDefinition extends AgentDefinition {
  name: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export type AgentDefinitionStoreOptions = JsonFileStoreOptions

/** Persist/CRUD store for custom agent definitions. */
export class AgentDefinitionStore extends JsonFileStore<StoredAgentDefinition> {
  constructor(opts: AgentDefinitionStoreOptions = {}) {
    super(opts, 'agent-definitions.json', DEFAULT_DIR_NAME, 'agent-definitions')
  }
  protected getKey(def: StoredAgentDefinition): string {
    return def.name
  }
  protected parseItems(raw: string): StoredAgentDefinition[] {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) { log.warn(`${this.file} is not an array; ignoring`); return [] }
    const entries: StoredAgentDefinition[] = []
    for (const value of parsed) {
      const def = coerceStoredAgentDefinition(value)
      if (def) entries.push(def)
    }
    return entries
  }
  protected serializeForWrite(items: StoredAgentDefinition[]): unknown {
    return items
  }
  async load(): Promise<StoredAgentDefinition[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      this.initEntries(this.parseItems(raw))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error(`load failed: ${(err as Error).message}`)
      }
    }
    return this.list()
  }
  /** Enabled definitions in SDK `Options.agents` shape (bookkeeping stripped). */
  getEnabledDefinitions(): Record<string, AgentDefinition> {
    const out: Record<string, AgentDefinition> = {}
    for (const def of this.list()) {
      if (!def.enabled) continue
      const { name: _n, enabled: _e, createdAt: _c, updatedAt: _u, ...rest } = def
      out[def.name] = rest as AgentDefinition
    }
    return out
  }
}

const STRING_OPTIONAL: readonly string[] = ['model', 'initialPrompt', 'observer', 'observerMessage', 'criticalSystemReminder_EXPERIMENTAL']
const STRING_ARRAY_OPTIONAL: readonly string[] = ['tools', 'disallowedTools', 'mcpServers', 'skills']
const MEMORY_VALUES = ['user', 'project', 'local']

/** Defensive parse of one stored definition; malformed → null (dropped). */
export function coerceStoredAgentDefinition(raw: unknown): StoredAgentDefinition | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const d = raw as Record<string, unknown>
  if (typeof d.name !== 'string' || !d.name.trim()) return null
  if (typeof d.description !== 'string' || !d.description.trim()) return null
  if (typeof d.prompt !== 'string' || !d.prompt.trim()) return null
  if (typeof d.enabled !== 'boolean') return null
  if (typeof d.createdAt !== 'number' || typeof d.updatedAt !== 'number') return null
  for (const s of STRING_OPTIONAL) if (d[s] !== undefined && (typeof d[s] !== 'string' || !d[s].trim())) return null
  for (const a of STRING_ARRAY_OPTIONAL) {
    if (d[a] === undefined) continue
    if (!Array.isArray(d[a]) || d[a].some((v) => typeof v !== 'string' || !v.trim())) return null
  }
  if (d.memory !== undefined && !MEMORY_VALUES.includes(d.memory as string)) return null
  const effort = d.effort
  if (effort !== undefined && typeof effort !== 'number' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort as string)) return null
  if (effort !== undefined && typeof effort === 'number' && !Number.isFinite(effort)) return null
  const pm = d.permissionMode
  if (pm !== undefined && !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'disabled'].includes(pm as string)) return null
  if (d.maxTurns !== undefined && (typeof d.maxTurns !== 'number' || !Number.isFinite(d.maxTurns))) return null
  if (d.background !== undefined && typeof d.background !== 'boolean') return null
  if (d.mcpServers !== undefined && d.mcpServers.some((v: string) => typeof v !== 'string')) return null
  return d as unknown as StoredAgentDefinition
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/agent-definition-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: passes (note `AGENT_FIELDS`/`AgentField` exported even if unused yet — verify no `noUnusedLocals` violation for the exported const; exports are safe).

- [ ] **Step 6: Commit**

```bash
git add server/agent-definition-store.ts server/agent-definition-store.test.ts
git commit -m "feat: AgentDefinitionStore for custom agent definitions"
```

---

### Task 2: Agent-definition routes + app mounting (server)

**Files:**
- Create: `server/agent-definition-routes.ts`
- Create: `server/agent-definition-routes.test.ts`
- Modify: `server/app.ts` (add `agentDefinitionStore` option, mount the router)

**Interfaces:**
- Consumes: `AgentDefinitionStore`, `StoredAgentDefinition`, `AGENT_FIELDS` from `./agent-definition-store.js`; `Hono` from `hono`; `safeJson` from `./routes/index.js`; test helper patterns from `server/snippet-routes.test.ts`.
- Produces (used by Task 6 client + Task 8):
  - `export function buildAgentDefinitionsRouter(store: AgentDefinitionStore): Hono`
  - `GET /api/agent-definitions` → `{ agents: StoredAgentDefinition[] }`
  - `POST /api/agent-definitions` body `{ data: StoredAgentDefinition }` → 201 `{ agent }` | 400 | 409
  - `PUT /api/agent-definitions/:name` body `{ data: partial }` → 200 `{ agent }` | 400 | 404
  - `DELETE /api/agent-definitions/:name` → 204
- Route convention follows `server/snippet-routes.ts` (`HttpError` from `./errors.js`, `createErrorHandler`).

- [ ] **Step 1: Write the failing route tests**

```ts
// server/agent-definition-routes.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentDefinitionStore } from './agent-definition-store.js'
import { buildAgentDefinitionsRouter } from './agent-definition-routes.js'

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-adr-'))
  const store = new AgentDefinitionStore({ stateDir: dir })
  void store.load()
  return { app: buildAgentDefinitionsRouter(store), store }
}
function def(name: string) {
  return { name, description: 'Reviews', prompt: 'You are a reviewer.', enabled: true, createdAt: 1, updatedAt: 1 }
}

describe('agent-definition routes', () => {
  it('lists stored definitions', async () => {
    const { app, store } = makeApp()
    store.upsert(def('reviewer'))
    const res = await app.request('/agent-definitions')
    expect(res.status).toBe(200)
    expect((await res.json()).agents).toHaveLength(1)
  })
  it('creates a definition and 409s on duplicate name', async () => {
    const { app } = makeApp()
    let res = await app.request('/agent-definitions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: def('reviewer') }) })
    expect(res.status).toBe(201)
    res = await app.request('/agent-definitions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: def('reviewer') }) })
    expect(res.status).toBe(409)
  })
  it('rejects malformed bodies with 400', async () => {
    const { app } = makeApp()
    const res = await app.request('/agent-definitions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { name: 'x' } }) })
    expect(res.status).toBe(400)
  })
  it('updates an existing definition and 404s on unknown name', async () => {
    const { app, store } = makeApp()
    store.upsert(def('reviewer'))
    const res = await app.request('/agent-definitions/reviewer', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { prompt: 'updated' } }) })
    expect(res.status).toBe(200)
    expect((await res.json()).agent.prompt).toBe('updated')
    const miss = await app.request('/agent-definitions/nope', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { prompt: 'x' } }) })
    expect(miss.status).toBe(404)
  })
  it('deletes a definition', async () => {
    const { app, store } = makeApp()
    store.upsert(def('reviewer'))
    const res = await app.request('/agent-definitions/reviewer', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(store.has('reviewer')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to confirm the module is missing**

Run: `npx vitest run server/agent-definition-routes.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the router**

```ts
// server/agent-definition-routes.ts
import { Hono } from 'hono'
import { AgentDefinitionStore, coerceStoredAgentDefinition, type StoredAgentDefinition } from './agent-definition-store.js'
import { HttpError, createErrorHandler } from './errors.js'
import { safeJson } from './routes/index.js'

type PartialDef = Partial<StoredAgentDefinition> & Pick<StoredAgentDefinition, 'name'>

/** Merge a client-supplied partial over a base, guarding immutable fields. */
function applyUpdate(base: StoredAgentDefinition, patch: Record<string, unknown> | undefined): StoredAgentDefinition {
  const data = patch ?? {}
  const next: StoredAgentDefinition = { ...base }
  const { name: _n, createdAt: _c, updatedAt: _u, ...rest } = data as Record<string, unknown>
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue
    ;(next as unknown as Record<string, unknown>)[k] = v
  }
  next.updatedAt = Date.now()
  return next
}

export function buildAgentDefinitionsRouter(store: AgentDefinitionStore): Hono {
  const app = new Hono()
  app.onError(createErrorHandler())

  app.get('/agent-definitions', (c) => c.json({ agents: store.list() }))

  app.post('/agent-definitions', async (c) => {
    const body = await safeJson<{ data?: unknown }>(c.req)
    const data = body?.data as PartialDef | undefined
    if (!data || typeof data !== 'object' || typeof data.name !== 'string' || !data.name.trim()) {
      throw new HttpError(400, 'data.name is required')
    }
    if (store.has(data.name)) throw new HttpError(409, `agent "${data.name}" already exists`)
    const withMeta: StoredAgentDefinition = {
      name: data.name,
      description: 'description' in data && data.description ? String(data.description) : '',
      prompt: data.prompt ? String(data.prompt) : '',
      enabled: data.enabled !== false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(data as Record<string, unknown>),
    }
    const def = coerceDef(withMeta)
    store.upsert(def)
    return c.json({ agent: def }, 201)
  })

  app.put('/agent-definitions/:name', async (c) => {
    const name = c.req.param('name')
    const existing = store.get(name)
    if (!existing) throw new HttpError(404, `agent "${name}" not found`)
    const body = await safeJson<{ data?: unknown }>(c.req)
    const merged = applyUpdate(existing, body?.data as Record<string, unknown> | undefined)
    const def = coerceDef(merged)
    store.upsert(def)
    return c.json({ agent: def })
  })

  app.delete('/agent-definitions/:name', (c) => {
    store.remove(c.req.param('name'))
    return c.body(null, 204)
  })
  return app
}

/** Validate a candidate definition at the write edge so garbage never reaches
 *  disk (mirrors how load() would otherwise drop it on read). Throws 400 on
 *  any shape violation so the client gets immediate feedback. */
function coerceDef(store0: AgentDefinitionStore, def: StoredAgentDefinition): StoredAgentDefinition {
  void store0
  const ok = coerceStoredAgentDefinition(def)
  if (!ok) throw new HttpError(400, 'invalid agent definition shape')
  return def
}
```

Replace the two `coerceDef` call sites with `coerceDef(store, def)`:
- In `POST /agent-definitions`: `const def = coerceDef(store, withMeta)`.
- In `PUT /agent-definitions/:name`: `const def = coerceDef(store, merged)`.
Read `server/snippet-routes.ts` to confirm the repo's exact `safeJson` + error idiom and match it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/agent-definition-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Mount the router in app.ts**

In `server/app.ts`:
- Add `import { AgentDefinitionStore } from './agent-definition-store.js'` and `import { buildAgentDefinitionsRouter } from './agent-definition-routes.js'`.
- Add `agentDefinitionStore?: AgentDefinitionStore` to the `AppOptions` type (near `snippetStore`, ~line 74).
- In the mounting block near `if (opts.snippetStore) { app.route('/api/snippets', buildSnippetRouter(opts.snippetStore)) }` (~line 266), add:

```ts
if (opts.agentDefinitionStore) {
  app.route('/api/agent-definitions', buildAgentDefinitionsRouter(opts.agentDefinitionStore))
}
```

- [ ] **Step 6: Typecheck + lint + route tests**

Run: `npm run typecheck` then `npx vitest run server/agent-definition-routes.test.ts`
Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add server/agent-definition-routes.ts server/agent-definition-routes.test.ts server/app.ts
git commit -m "feat: agent-definition CRUD routes + app mounting"
```

---

### Task 3: Spawn injection — thread agentStore and set Options.agents (server)

**Files:**
- Modify: `server/providers/default-providers.ts` (add `agentStore` to `DefaultProvidersOptions`)
- Modify: `server/providers/claude/claude-provider.ts` (`ClaudeProviderOptions`, inject in `applyStandardQueryOpts`)
- Modify: `server/session-manager.ts` (thread `agentStore` into `createDefaultProviders`)
- Modify: `server/app.ts` (pass `agentStore` into `SessionManager` opts)
- Create: `server/providers/claude/claude-provider.agent-injection.test.ts`

**Interfaces:**
- Consumes: `AgentDefinitionStore` (from `./server/agent-definition-store.js`); existing `ClaudeProviderOptions` shape.
- Produces (used by Task 4/5): any session spawned via `ClaudeProvider` now has `opts.agents` set from the store's `getEnabledDefinitions()` when the store is present and non-empty.

- [ ] **Step 1: Write the failing injection test** (tests the exported helper directly — avoids mocking the whole SDK Query surface)

```ts
// server/providers/claude/claude-provider.agent-injection.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { AgentDefinitionStore } from '../../agent-definition-store.js'
import { injectAgentDefinitions } from './claude-provider.js'

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-adji-'))
  return new AgentDefinitionStore({ stateDir: dir })
}

describe('injectAgentDefinitions', () => {
  let store: AgentDefinitionStore
  beforeEach(async () => { store = makeStore(); await store.load() })

  it('is a no-op when the store is absent', () => {
    const opts: Options = {}
    injectAgentDefinitions(opts, undefined)
    expect(opts.agents).toBeUndefined()
  })
  it('injects only enabled definitions, stripping bookkeeping', () => {
    store.upsert({ name: 'reviewer', description: 'Reviews', prompt: 'You are a reviewer.', enabled: true, createdAt: 1, updatedAt: 1 })
    store.upsert({ name: 'off', description: 'Off', prompt: 'X', enabled: false, createdAt: 1, updatedAt: 1 })
    const opts: Options = {}
    injectAgentDefinitions(opts, store)
    expect(opts.agents).toEqual({ reviewer: { description: 'Reviews', prompt: 'You are a reviewer.' } })
  })
  it('merges over pre-existing opts.agents (custom wins on name clash)', () => {
    store.upsert({ name: 'reviewer', description: 'R', prompt: 'P', enabled: true, createdAt: 1, updatedAt: 1 })
    const opts: Options = { agents: { builtin: { description: 'B', prompt: 'PB' } } }
    injectAgentDefinitions(opts, store)
    expect(Object.keys(opts.agents!)).toContain('builtin')
    expect(opts.agents!.reviewer).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run server/providers/claude/claude-provider.agent-injection.test.ts`
Expected: FAIL (`injectAgentDefinitions` undefined).

- [ ] **Step 3: Implement injection**

In `server/providers/claude/claude-provider.ts`:
- Add to `ClaudeProviderOptions`: `agentStore?: AgentDefinitionStore` (import `import type { AgentDefinitionStore } from '../../agent-definition-store.js'`).
- Refactor: extract the mpStore `applyStandardQueryOpts` block into a clear function and add the agent block (see Global Constraints: mirror the mpStore guard `if (this.opts.mpStore)`) :

```ts
export function injectAgentDefinitions(opts: Options, store: AgentDefinitionStore | undefined): void {
  if (!store) return
  const agents = store.getEnabledDefinitions()
  if (Object.keys(agents).length === 0) return
  opts.agents = { ...agents, ...(opts.agents ?? {}) }
}
```

And in `applyStandardQueryOpts`, after the mpStore block (line ~635): `injectAgentDefinitions(opts, this.opts.agentStore)`.

In `server/providers/default-providers.ts`: add `agentStore?: AgentDefinitionStore` to `DefaultProvidersOptions`; pass through to `new ClaudeProvider(opts)`.

In `server/session-manager.ts` (~line 477): thread to `createDefaultProviders({ claudeBinary, mpStore, agentStore: opts.agentStore, onProcessExit })` — add `agentStore?: AgentDefinitionStore` to `SessionManagerOptions` **and store it on `this`** (Task 4's resume guard reads `this.agentStore`).

In `server/app.ts` (~line 137): pass `agentStore: opts.agentStore` into the `SessionManager` constructor options.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/claude/claude-provider.agent-injection.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add server/providers/default-providers.ts server/providers/claude/claude-provider.ts server/providers/claude/claude-provider.agent-injection.test.ts server/session-manager.ts server/app.ts
git commit -m "feat: inject custom agents (Options.agents) on every spawn"
```

---

### Task 4: Start-as + persistence + resume/fork guard (server)

**Files:**
- Modify: `server/routes/sessions.ts` (POST /sessions: accept + validate `agent`)
- Modify: `server/session-manager.ts` (`snapshotMeta` + `SessionMeta` type + `resumeOpts` + `forkOpts` carry `agent`, with guard)
- Modify: `server/persistence.ts` (`SessionMeta` add `agent?: string`)
- Modify: `server/providers/claude/claude-provider.ts` (pass `agent` through to `Options.agent`; already rides `sdkOptions`, ensure it's not stripped)
- Create/Modify: tests for create-agent validation, resume/fork propagation/guard, and the `/sessions/:id/agents` union

**Interfaces:**
- Consumes: `AgentDefinitionStore`; existing `snapshotMeta`, `resumeOpts`, `forkOpts`, `POST /sessions` create route.
- Produces:
  - `POST /sessions` accepts `agent?: string`; 400 if the name is unknown or disabled.
  - `SessionMeta.agent?: string` persisted; resume/fork drop it (logged) when the def is deleted/disabled.
  - `claude-provider` maps `opts.agent` → `Options.agent` explicitly (guarantee, since it must reach the SDK even if a spreading code path changes).
  - `GET /sessions/:id/agents` returns the union of `supportedAgents()` + enabled store defs, deduped (built-in wins).

- [ ] **Step 1: Write the failing tests**

```ts
// server/routes/sessions-agent-create.test.ts
import { describe, it, expect } from 'vitest'
// Build the router with a SessionManager stub that exposes create() and an
// AgentDefinitionStore with one enabled + one disabled def. Follow the shape
// of the existing server/routes/sessions-permission-mode.test.ts (it shows how
// to build the Hono app + a stub create that records the Options).
describe('POST /sessions agent field', () => {
  it('accepts a valid enabled agent name', async () => {
    const created = []
    const app = makeApp({ onCreate: (opts) => created.push(opts.agent) }) // enable 'reviewer'
    const res = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'reviewer' }) })
    expect(res.status).toBe(201) // or 200 per existing create-route convention
    expect(created[0]).toBe('reviewer')
  })
  it('400s on an unknown or disabled agent name', async () => {
    const app = makeApp()
    const a = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'ghost' }) })
    const b = await app.request('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'disabled-def' }) })
    expect(a.status).toBe(400)
    expect(b.status).toBe(400)
  })
  it('exposes custom agents in the /agents union (built-in wins on collision)', async () => {
    const app = makeApp() // supportedAgents() returns [{name:'builtin'}], store has builtin + custom
    const res = await app.request('/sessions/s1/agents')
    const names = (await res.json()).agents.map((a: { name: string }) => a.name)
    expect(names).toContain('reviewer')
    const dups = names.filter((n: string) => n === 'builtin')
    expect(dups).toHaveLength(1) // built-in beats the colliding custom def
  })
})
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run server/routes/sessions-agent-create.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement create validation + union**

In `server/routes/sessions.ts` create handler (`POST /sessions`, ~line 199):
- Accept `agent` from the body; validate against the store (passed into `buildSessionRouter` for exactly this — thread `agentDefinitionStore` into it from `buildApiRouter`, which already receives `mpStore`).
- Unknown or disabled → `return c.json({ error: ... }, 400)`.

In `server/session-manager.ts` `supportedAgents` (and the route handler at `server/routes/sessions.ts:834`): after `sm.supportedAgents(id)`, union in enabled store def names and de-dupe (built-in wins):

```ts
// in the /sessions/:id/agents route handler
const builtins = await sm.supportedAgents(id) // AgentInfo[]
const custom = store ? store.getEnabledDefinitions() : {}
const seen = new Set(builtins.map((a) => a.name))
for (const name of Object.keys(custom)) {
  if (!seen.has(name)) builtins.push({ name, description: custom[name].description, ...custom[name] })
}
return c.json({ agents: builtins })
```

- [ ] **Step 4: Implement persistence + resume/fork guard**

In `server/persistence.ts`: add `agent?: string` to `SessionMeta`.

In `server/session-manager.ts`:
- `snapshotMeta` (line ~982): add `agent?: string` to the return type and `agent: opts.agent` to the returned object.
- `resumeOpts` construction (line ~1241): add:

```ts
// Carry start-as agent forward only if it still exists and is enabled.
agent: this.agentStore?.get(name)?.enabled ? meta.agent : undefined,
```

(Add `private agentStore?: AgentDefinitionStore` to the manager and populate it from `opts.agentStore` — thread it through `SessionManagerOptions` in Task 3's change.)
- `forkOpts` (line ~1545-1601): add `agent: meta.agent` guarded the same way.
- Where `meta.agent` is set but the def is gone, log `log.warn('[id] start-as agent X no longer enabled/defined; resuming as normal session')`.

In `server/providers/claude/claude-provider.ts` `createSession`: add an explicit `if (opts.agent !== undefined) sdkOptions.agent = opts.agent` in the explicit-mapping block (~line 230) to guarantee `Options.agent` reaches the SDK even if other spreading paths strip it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/routes/sessions-agent-create.test.ts`
Expected: PASS. (Also run the existing suite that touches resume/fork: `npx vitest run server/session-manager.test.ts` — must stay green.)

- [ ] **Step 6: Typecheck + lint + full server tests**

Run: `npm run typecheck` and `npx vitest run server/`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/routes/sessions.ts server/session-manager.ts server/persistence.ts server/providers/claude/claude-provider.ts server/routes/sessions-agent-create.test.ts
git commit -m "feat: start-a-session-as-custom-agent + resume/fork guard + agents union"
```

---

### Task 5: Client — SettingsPanel "Agents" tab (list + enabled toggle)

**Files:**
- Modify: `src/components/SettingsPanel.tsx` (SettingsTab type + tabs array + render branch + data fetch)
- Create: `src/components/agent-definitions/AgentDefinitionsSection.tsx` (list + toggle + delete)
- Create: `src/hooks/useAgentDefinitions.ts`
- Create: `src/components/agent-definitions/AgentDefinitionsSection.test.tsx`

**Interfaces:**
- Consumes: `api` from `../hooks/useApi` (`api.get<T>(path)`, `api.delete<T>(path)`); resolver/enum for `AgentDefinition` types from `src/types.ts` (add a client `AgentDefinition`/`StoredAgentDefinition` shape if not present).
- Produces:
  - `GET /api/agent-definitions` → `{ agents: StoredAgentDefinition[] }` mapped to client state.
  - `useAgentDefinitions()` → `{ agents, refresh, toggleEnabled, remove }`.
  - `AgentDefinitionsSection` receives `agents` + callbacks and renders rows (name, description, enabled toggle, delete, "edit" stub) → on edit it opens the Task 6 form.

- [ ] **Step 1: Write the failing hook + section tests**

```ts
// src/hooks/useAgentDefinitions.test.ts
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAgentDefinitions } from './useAgentDefinitions'

vi.mock('./useApi', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }))

describe('useAgentDefinitions', () => {
  it('refreshes from /api/agent-definitions', async () => {
    const { get } = await import('./useApi')
    get.mockResolvedValueOnce({ agents: [{ name: 'reviewer', enabled: true }] })
    const { result } = renderHook(() => useAgentDefinitions())
    await act(async () => {})
    expect(result.current.agents).toEqual([{ name: 'reviewer', enabled: true }])
    expect(get).toHaveBeenCalledWith('/agent-definitions')
  })
})
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run src/hooks/useAgentDefinitions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the hook**

```ts
// src/hooks/useAgentDefinitions.ts
import { useCallback, useEffect, useState } from 'react'
import { api } from './useApi'
import type { StoredAgentDefinition } from '../types'

export function useAgentDefinitions() {
  const [agents, setAgents] = useState<StoredAgentDefinition[]>([])
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try { const r = await api.get<{ agents: StoredAgentDefinition[] }>('/agent-definitions'); setAgents(r.agents); setError(null) }
    catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const toggleEnabled = useCallback(async (name: string, enabled: boolean) => {
    const def = agents.find((a) => a.name === name); if (!def) return
    await api.put<{ agent: StoredAgentDefinition }>(`/agent-definitions/${encodeURIComponent(name)}`, { data: { enabled } })
    await refresh()
  }, [agents, refresh])
  const remove = useCallback(async (name: string) => {
    await api.delete(`/agent-definitions/${encodeURIComponent(name)}`)
    await refresh()
  }, [refresh])
  return { agents, error, refresh, toggleEnabled, remove }
}
```

- [ ] **Step 4: Add the "Agents" tab to SettingsPanel**

- Extend `type SettingsTab = 'general' | 'context' | 'hooks' | 'plugins' | 'mcp' | 'usage' | 'agents'` (line ~45).
- Add `{ key: 'agents', label: 'Agents' }` to the `tabs` array (line ~832).
- Add `{tab === 'agents' && (<AgentDefinitionsSection ... />)}` beside the other `tab === '...'` render branches (~line 1536 region), passing the section `agents`, `error`, `toggleEnabled`, `remove`, plus an `onedit` prop that opens the Task 6 form.

> Client form/type placement: add a `StoredAgentDefinition`/`AgentDefinition` client type in `src/types.ts` matching the server shape (fields as documented in the spec §1). Use it in the hook and section.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useAgentDefinitions.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useAgentDefinitions.ts src/hooks/useAgentDefinitions.test.ts src/components/agent-definitions/AgentDefinitionsSection.tsx src/components/agent-definitions/AgentDefinitionsSection.test.tsx src/components/SettingsPanel.tsx src/types.ts
git commit -m "feat: SettingsPanel Agents tab with definition list + toggle"
```

---

### Task 6: Client — full-field agent definition form

**Files:**
- Create: `src/components/agent-definitions/AgentDefinitionForm.tsx`
- Create: `src/components/agent-definitions/AgentDefinitionForm.test.tsx`
- Modify: `src/components/agent-definitions/AgentDefinitionsSection.tsx` (open form for create/edit)

**Interfaces:**
- Consumes: `api.post`/`api.put` from `useApi`; client `StoredAgentDefinition` type (Task 5); `onSaved()` callback.
- Produces:
  - `AgentDefinitionForm({ initial?: StoredAgentDefinition; onSaved: () => void; onCancel: () => void })`
  - Validates client-side with the same field rules as Task 2's `coerceStoredAgentDefinition`; on submit `POST /api/agent-definitions` (create) or `PUT /api/agent-definitions/:name` (edit).

- [ ] **Step 1: Write failing tests for validation rules**

```ts
// src/components/agent-definitions/AgentDefinitionForm.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AgentDefinitionForm, validateAgentDefinition } from './AgentDefinitionForm'

vi.mock('../../hooks/useApi', () => ({ api: { post: vi.fn(), put: vi.fn() } }))

describe('AgentDefinitionForm', () => {
  it('blocks save until name/description/prompt are present', () => {
    render(<AgentDefinitionForm onSaved={() => {}} onCancel={() => {}} />)
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: '' } })
    expect(validateAgentDefinition({ name: '', description: '', prompt: '' })).toBe('name is required')
  })
  it('submits a fully valid definition to POST', async () => {
    const { post } = await import('../../hooks/useApi')
    render(<AgentDefinitionForm onSaved={() => {}} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'reviewer' } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Reviews' } })
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: 'You are a reviewer.' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    expect(post).toHaveBeenCalledWith('/agent-definitions', expect.objectContaining({ data: expect.objectContaining({ name: 'reviewer' }) }))
  })
})
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run src/components/agent-definitions/AgentDefinitionForm.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the form**

`AgentDefinitionForm`: a controlled form over the field groups:
- **Basic** — `name` (text, disabled when editing), `description` (text), `prompt` (textarea)
- **Tools & Capabilities** — `tools`, `disallowedTools`, `mcpServers`, `skills` (each a tag-input → `string[]`), `model` (text), `effort` (select: low/medium/high/xhigh/max or number), `permissionMode` (select: default/acceptEdits/bypassPermissions/plan/disabled)
- **Runtime** — `maxTurns` (number), `background` (toggle), `memory` (select: user/project/local/''), `initialPrompt` (textarea)
- **Advanced (collapsible `<details>`) — `observer` (text), `observerMessage` (text), `criticalSystemReminder_EXPERIMENTAL` (textarea)

`validateAgentDefinition(partial): string | null` implements the Task 2 rules (required name/description/prompt; empty-string optional strings rejected; enum membership for memory/effort/permissionMode; finite numbers; boolean checks). On submit, `null` optional fields are omitted from the payload; call `api.post('/agent-definitions', { data })` (create) or `api.put('/agent-definitions/<name>', { data })` (edit), then `onSaved()`.

Wire `AgentDefinitionsSection`: an "New" button opens the form with `initial=undefined`; an "edit" action per row opens it with `initial=def`; the form's `onSaved` closes it and calls `refresh()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/agent-definitions/AgentDefinitionForm.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-definitions/AgentDefinitionForm.tsx src/components/agent-definitions/AgentDefinitionForm.test.tsx src/components/agent-definitions/AgentDefinitionsSection.tsx
git commit -m "feat: full-field agent definition editor form"
```

---

### Task 7: Client — start a session as a custom agent (NewSessionDialog)

**Files:**
- Modify: `src/components/session-list/NewSessionDialog.tsx` (agent dropdown + prefill)
- Modify: the component that owns `NewSessionForm` and POSTs `/sessions` (find the `onSubmit(form)` consumer and add `agent` to the create body)
- Create: `src/components/session-list/NewSessionDialog.agent.test.tsx`

**Interfaces:**
- Consumes: `useAgentDefinitions` (Task 5) for the definition list; existing `NewSessionForm` type and `POST /sessions` create path.
- Produces:
  - `NewSessionForm.agent?: string`
  - Selecting an agent prefills the form's `model`/`permissionMode`/`effort` from the def, and the create body includes `agent: <name>`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/session-list/NewSessionDialog.agent.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewSessionDialog } from './NewSessionDialog'

vi.mock('../../hooks/useApi', () => ({ api: { get: vi.fn() } }))

describe('NewSessionDialog custom agent', () => {
  it('renders an agent dropdown with custom definitions and prefills model', async () => {
    const onSubmit = vi.fn()
    const probe = { name: 'reviewer', description: 'Reviews', prompt: 'P', enabled: true, createdAt: 1, updatedAt: 1, model: 'haiku' }
    // stub useAgentDefinitions to return [probe]
    render(<NewSessionDialog open={true} onSubmit={onSubmit} onCancel={() => {}} groups={[]} serverModels={[]} defaults={{}} />)
    fireEvent.change(screen.getByLabelText(/agent/i), { target: { value: 'reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    const form = onSubmit.mock.calls[0][0]
    expect(form.agent).toBe('reviewer')
    expect(form.model).toBe('haiku') // prefilled from the def
  })
})
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run src/components/session-list/NewSessionDialog.agent.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Add `agent?: string` to `NewSessionForm`.
- In `NewSessionDialog`, add an "Agent" `<select>` populated from `useAgentDefinitions().agents` (Button: a "None" option + one per enabled custom def). Track `selectedAgent`.
- When `selectedAgent` changes, prefill `model = def.model ?? model`, `permissionMode = def.permissionMode ?? permissionMode`, `effort = def.effort ?? effort` (state setters), mirroring the spec's "start-as mirrors the def's model/permission/effort" fallback so it works even if spike #2's `Options.agent` model-merging is nil.
- Include `agent: selectedAgent || undefined` in the `onSubmit(form)` payload.
- In the parent consumer of `onSubmit`, include `agent` in the `POST /sessions` body.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/session-list/NewSessionDialog.agent.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add src/components/session-list/NewSessionDialog.tsx <create-consumer-file> src/components/session-list/NewSessionDialog.agent.test.tsx
git commit -m "feat: start a new session as a custom agent"
```

---

### Task 8: Full verification + manual smoke

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: passes (both tsconfigs).

- [ ] **Step 2: Full lint**

Run: `npm run lint`
Expected: passes.

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: all pass (server unit + client hook tests). Fix any regressions before proceeding.

- [ ] **Step 4: Manual smoke (needs a running app + valid API config)**

- `npm run dev`, open the app.
- Settings → Agents tab: create a definition with all fields (name `smoke`, prompt, a few tools), toggle, delete, re-create.
- Confirm it persists after reload (`agent-definitions.json` exists under the state dir).
- Start a new session as `smoke` → the first assistant turn reflects `initialPrompt` (if set) and the session uses the def's model.
- In a running session's agents list, confirm `smoke` appears.
- **Spike crosscheck:** delete `/tmp/cwa-spike-notes.txt` only after this smoke pass.

- [ ] **Step 5: Final commit (if any fixes were needed)**

Only if fixes were made; commit them with a descriptive message. Otherwise nothing to commit.

```bash
git status --short
```

Expected: working tree clean (or only the already-committed feature commits).