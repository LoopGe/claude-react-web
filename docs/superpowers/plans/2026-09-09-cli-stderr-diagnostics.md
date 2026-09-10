# CLI Stderr Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-session CLI stderr diagnostics — a global+per-session CLI debug toggle that writes an SDK `debugFile`, an always-on persistent stderr tail (`cli-stderr-<id>.jsonl`), a Diagnostics tab in SettingsPanel, and a spawn-failure stderr display.

**Architecture:** `config.json` gains a global `cliDebug` default (off); `SessionMeta` gains a per-session override. At spawn, the provider sets SDK `Options.debug` + `Options.debugFile` under `<stateDir>/logs/cli-<id>.log` when the effective flag is on. A new pure helper (`server/cli-diagnostics.ts`) owns the bounded jsonl tail + cleanup. `ProcessMonitor` tees each captured stderr line into the sink. A new `/sessions/:id/diagnostics` REST router exposes the effective toggle + tail + file info; the client reads it in a new Diagnostics tab and on session-error cards.

**Tech Stack:** Hono (server routes), node:fs, React/Vite (client), vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-cli-stderr-diagnostics-design.md`

## Global Constraints

- All diagnostic logging goes through `createLogger(scope)` — never bare `console.*` except where the project already allows it (log.ts, cli.ts, errors.ts).
- CSS colors must use theme variables in `:root` and `[data-theme="light"]` — no hardcoded hex.
- Server tests run in Node; client hook/component tests run with jsdom (vitest workspaces). Run `npm run typecheck` (both `tsconfig.json` + `tsconfig.node.json`) and the relevant tests per task.
- SDK `Options.debug` / `debugFile` are **spawn-time only** — no runtime setter. The toggle takes effect on the next spawn/resume/restart.
- Browser bundle must not import `@anthropic-ai/claude-agent-sdk` (shared/ code uses type-only imports only).
- Commit after each task (each task ends with an independently testable deliverable).

---

### Task 1: Global `cliDebug` config default

**Files:**
- Modify: `server/config.ts` (`ConfigFile` ~line 51, `ServerConfig` ~144, `DEFAULTS` ~205, `applyParsedConfig` ~373, `WRITABLE_CONFIG_KEYS` ~557)
- Test: `server/config.test.ts`

**Interfaces:**
- Produces: `defaultConfig.cliDebug: boolean` (global default, `false`), readable by the provider and session-manager exactly like `defaultConfig.autoRecap`.

- [ ] **Step 1: Write the failing test**

Add to `server/config.test.ts` (inside the existing main describe):

```ts
import { loadConfig, WRITABLE_CONFIG_KEYS, defaultConfig, config } from './config.js'

it('loads a global cliDebug default (false) and honors config.json', async () => {
  // Explicit default: false before any load.
  expect(defaultConfig.cliDebug).toBe(false)
  // config.json cliDebug:true is surfaced on the frozen config.
  vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify({ cliDebug: true }))
  await loadConfig(tmpStateDir)
  expect(config.cliDebug).toBe(true)
})

it('exposes cliDebug as a writable config key', () => {
  expect(WRITABLE_CONFIG_KEYS).toContain('cliDebug')
})
```

`vi`/`fs`/`tmpStateDir` already exist in this test file — follow the file's existing setup (`config.test.ts` imports `vi`, mocked `fs`, and a temp-dir helper). If the file does not already import `defaultConfig`, add it to the existing import from `./config.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- server/config.test.ts`
Expected: FAIL — `defaultConfig.cliDebug` is `undefined`, not `false`; `WRITABLE_CONFIG_KEYS` lacks `cliDebug`.

- [ ] **Step 3: Implement minimal code**

In `server/config.ts`:

1. `ConfigFile` (line ~51): add
```ts
/** Global default for per-session CLI debug logging (Options.debug +
 *  debugFile). SessionMeta.cliDebug overrides when set. Default: false. */
cliDebug?: boolean
```

2. `ServerConfig` (~144): add
```ts
/** Global default for per-session CLI debug logging (spawn-time only). */
readonly cliDebug: boolean
```

3. `DEFAULTS` (~205): add `cliDebug: false,`

4. `applyParsedConfig` (~373), next to the `logToFile` block (~435):
```ts
if (typeof file_.cliDebug === 'boolean') {
  ;(merged as { cliDebug: boolean }).cliDebug = file_.cliDebug
  log.info(`cliDebug: ${file_.cliDebug}`)
}
```

5. `WRITABLE_CONFIG_KEYS` (~557): add `'cliDebug',`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- server/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/config.test.ts
git commit -m "feat(config): global cliDebug default for CLI debug logging"
```

---

### Task 2: Per-session `cliDebug` (Session + SessionMeta + carry-forward)

**Files:**
- Modify: `server/persistence.ts` (`SessionMeta` ~31)
- Modify: `server/session-types.ts` (`Session` ~184)
- Modify: `server/session-manager.ts` — `writeStore` (~857/871), `snapshotMeta` (~928), `baseSpawnOptions` (~5322), `respawnInPlace` createSession (~5422), main `createSession` call (~2319)
- Test: `server/session-manager.test.ts`

**Interfaces:**
- Consumes: `defaultConfig.cliDebug` (Task 1).
- Produces: `Session.cliDebug?: boolean`; `SessionMeta.cliDebug?: boolean`; `CreateSessionOptions.cliDebug?: boolean` (provider side, used in Task 4); private `SessionManager.resolveCliDebug(session): boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `server/session-manager.test.ts`. Follow how the file builds a manager (`makeSessionManager()` or similar helper — copy the existing harness) and how it asserts persisted meta.

```ts
it('resolves the effective cliDebug as session override ?? global default', () => {
  const sm = makeSessionManager()
  const sess = { cliDebug: undefined } as Session
  expect(sm.resolveCliDebug(sess)).toBe(false) // defaultConfig.cliDebug = false
  sess.cliDebug = true
  expect(sm.resolveCliDebug(sess)).toBe(true)
})
```

> Note: `sm.require`, `sm.create`, `sm.store` names may differ in the real harness — adjust to the file's existing helpers. The persistence-through-PUT assertion lands in Task 5's route test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- server/session-manager.test.ts`
Expected: FAIL — `resolveCliDebug` missing / `cliDebug` not on Session.

- [ ] **Step 3: Implement minimal code**

`server/persistence.ts` `SessionMeta` (~31): add

```ts
/** User intent: per-session CLI debug logging. undefined = inherit the
 *  global config default. Persisted so resume/fork/restart keep the intent.
 *  Spawn-time only — takes effect on the next spawn. */
cliDebug?: boolean
```

`server/session-types.ts` `Session` (~239, next to `effortLevel`): add

```ts
/** User intent: per-session CLI debug logging. undefined = inherit the
 *  global config default. Persisted so resume/fork/restart keep the intent. */
cliDebug?: boolean
```

`server/session-manager.ts`:

1. In `writeStore` (~871), next to `fastMode: s.fastMode,`:
```ts
cliDebug: s.cliDebug,
```

2. `snapshotMeta` (~928): no change — cliDebug comes from the live session, not spawn `Options`. (Initial sessions inherit global; the override is set post-create via the diagnostics route.)

3. Add a private helper next to `snapshotMeta`:
```ts
/** Effective per-session CLI debug intent: session override ?? global default. */
private resolveCliDebug(s: Session): boolean {
  return s.cliDebug ?? defaultConfig.cliDebug ?? false
}
```

4. In the main `createSession` call (~2319), add `cliDebug: this.resolveCliDebug(session),`

5. In `respawnInPlace` createSession (~5439, next to `fastMode: session.fastMode,`): add `cliDebug: this.resolveCliDebug(session),`

6. `baseSpawnOptions` (~5322) input type: add `cliDebug?: boolean` to the source type and `cliDebug: source.cliDebug` to the returned options — the three call sites that build resume/fresh/fork opts (`resumeOpts` ~1229, `freshOpts` ~1296, `forkOpts` ~1534) pass `cliDebug: meta.cliDebug` / `cliDebug: session.cliDebug` respectively, mirroring how `effortLevel`/`fastMode` are threaded. The provider reads the effective value from `CreateSessionOptions.cliDebug` (Task 4). Follow the existing `effortLevel` → `effort:` mapping pattern.

**Security note:** `resolveCliDebug` reads `defaultConfig.cliDebug`. The overload that threads through `baseSpawnOptions` (used for resume/fork) should pass the session/meta `cliDebug` (the override), NOT the resolved boolean, so the provider's `opts.cliDebug ?? defaultConfig.cliDebug ?? false` resolution still applies the global default uniformly. Task 4's provider resolution is the single place the global default is applied for spawn.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- server/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/persistence.ts server/session-types.ts server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(session): persist and carry per-session cliDebug intent"
```

---

### Task 3: `cli-diagnostics` helper (bounded jsonl tail + cleanup)

**Files:**
- Create: `server/cli-diagnostics.ts`
- Test: `server/cli-diagnostics.test.ts`

**Interfaces:**
- Consumes: nothing (pure node:fs helpers).
- Produces:
```ts
appendStderrLine(logsDir: string | undefined, sid: string, line: string): Promise<void>
readStderrTail(logsDir: string | undefined, sid: string, n?: number): Promise<string[]>
cliLogInfo(logsDir: string | undefined, sid: string): Promise<{ exists: boolean; path?: string; size?: number }>
cleanupCliLogs(logsDir: string | undefined, maxAgeMs?: number): Promise<number> // returns count removed
```

- [ ] **Step 1: Write the failing tests**

Create `server/cli-diagnostics.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendStderrLine, readStderrTail, cliLogInfo, cleanupCliLogs } from './cli-diagnostics.js'

let dir: string
let logsDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-clidiag-'))
  logsDir = join(dir, 'logs')
})

describe('cli-diagnostics', () => {
  it('appends and reads back a stderr tail', async () => {
    await appendStderrLine(logsDir, 's1', 'line one')
    await appendStderrLine(logsDir, 's1', 'line two')
    expect(await readStderrTail(logsDir, 's1')).toEqual(['line one', 'line two'])
    expect(await readStderrTail(logsDir, 's1', 1)).toEqual(['line two'])
  })

  it('no-ops on missing logsDir / sid', async () => {
    await expect(appendStderrLine(undefined, 's1', 'x')).resolves.toBeUndefined()
    await expect(readStderrTail(undefined, 's1')).resolves.toEqual([])
    await expect(cliLogInfo(undefined, 's1')).resolves.toEqual({ exists: false })
  })

  it('caps the jsonl file at ~5MB keeping the tail', async () => {
    const big = 'x'.repeat(2048)
    for (let i = 0; i < 3000; i++) await appendStderrLine(logsDir, 's1', `${i}-${big}`)
    const file = join(logsDir, 'cli-stderr-s1.jsonl')
    const stat = await import('node:fs/promises').then((f) => f.stat(file))
    expect(stat.size).toBeLessThan(5 * 1024 * 1024 + 4096)
    const tail = await readStderrTail(logsDir, 's1', 5)
    expect(tail.length).toBeLessThanOrEqual(5)
  })

  it('cliLogInfo reports file existence and size', async () => {
    expect(await cliLogInfo(logsDir, 's1')).toEqual({ exists: false })
    writeFileSync(join(logsDir, 'cli-s1.log'), 'debug output', 'utf8')
    const info = await cliLogInfo(logsDir, 's1')
    expect(info.exists).toBe(true)
    expect(info.size).toBeGreaterThan(0)
    expect(info.path).toContain('cli-s1.log')
  })

  it('cleanupCliLogs removes stale cli logs and keeps fresh ones', async () => {
    writeFileSync(join(logsDir, 'cli-s1.log'), 'a', 'utf8')
    writeFileSync(join(logsDir, 'cli-stderr-s1.jsonl'), '{}', 'utf8')
    writeFileSync(join(logsDir, 'unrelated.log'), 'keep', 'utf8')
    const old = Date.now() - 15 * 24 * 3600 * 1000
    utimesSync(join(logsDir, 'cli-s1.log'), old, old)
    utimesSync(join(logsDir, 'cli-stderr-s1.jsonl'), old, old)

    const removed = await cleanupCliLogs(logsDir, 14 * 24 * 3600 * 1000)
    expect(removed).toBe(2)
    expect(existsSync(join(logsDir, 'cli-s1.log'))).toBe(false)
    expect(existsSync(join(logsDir, 'cli-stderr-s1.jsonl'))).toBe(false)
    expect(existsSync(join(logsDir, 'unrelated.log'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- server/cli-diagnostics.test.ts`
Expected: FAIL — module not found / functions not defined.

- [ ] **Step 3: Write minimal implementation**

Create `server/cli-diagnostics.ts`:

```ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const MAX_STDERR_BYTES = 5 * 1024 * 1024
const KEEP_LAST_BYTES = 1024 * 1024

function sidFile(logsDir: string | undefined, sid: string, kind: 'stderr' | 'debug'): string | null {
  if (!logsDir || !sid) return null
  return kind === 'stderr'
    ? join(logsDir, `cli-stderr-${sid}.jsonl`)
    : join(logsDir, `cli-${sid}.log`)
}

async function statSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size
  } catch {
    return 0
  }
}

/** Append one stderr line to the session's bounded jsonl tail. */
export async function appendStderrLine(
  logsDir: string | undefined,
  sid: string,
  line: string,
): Promise<void> {
  const file = sidFile(logsDir, sid, 'stderr')
  if (!file) return
  const entry = JSON.stringify({ ts: Date.now(), line })
  const lineLen = entry.length + 1
  const size = await statSize(file)
  if (size > 0 && size + lineLen > MAX_STDERR_BYTES) {
    const raw = await fs.readFile(file, 'utf8').catch(() => '')
    const kept = raw.slice(Math.max(0, raw.length - KEEP_LAST_BYTES))
    await fs.writeFile(file, kept + entry + '\n', 'utf8')
  } else {
    await fs.mkdir(join(file, '..'), { recursive: true }).catch(() => undefined)
    await fs.appendFile(file, entry + '\n', 'utf8')
  }
}

/** Read the last `n` stderr lines (oldest→newest), each reduced to its
 *  `line` payload (falls back to the raw line on parse failure). */
export async function readStderrTail(
  logsDir: string | undefined,
  sid: string,
  n = 200,
): Promise<string[]> {
  const file = sidFile(logsDir, sid, 'stderr')
  if (!file) return []
  const raw = await fs.readFile(file, 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .map((l) => {
      try {
        const o = JSON.parse(l) as { line?: unknown }
        return typeof o.line === 'string' ? o.line : l
      } catch {
        return l
      }
    })
}

/** Info about the session's CLI debug log file (SDK `Options.debugFile`). */
export async function cliLogInfo(
  logsDir: string | undefined,
  sid: string,
): Promise<{ exists: boolean; path?: string; size?: number }> {
  const file = sidFile(logsDir, sid, 'debug')
  if (!file) return { exists: false }
  try {
    const st = await fs.stat(file)
    return { exists: true, path: file, size: st.size }
  } catch {
    return { exists: false }
  }
}

/** Delete stale `cli-*.log` and `cli-stderr-*.jsonl` files older than
 *  `maxAgeMs`. Returns the count removed. Never throws. */
export async function cleanupCliLogs(
  logsDir: string | undefined,
  maxAgeMs = 14 * 24 * 3600 * 1000,
): Promise<number> {
  if (!logsDir) return 0
  let removed = 0
  const now = Date.now()
  const entries = await fs.readdir(logsDir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!/^cli-.*\.log$/.test(e.name) && !/^cli-stderr-.*\.jsonl$/.test(e.name)) continue
    const p = join(logsDir, e.name)
    try {
      const st = await fs.stat(p)
      if (now - st.mtimeMs > maxAgeMs) {
        await fs.unlink(p)
        removed++
      }
    } catch {
      /* ignore individual failures */
    }
  }
  return removed
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- server/cli-diagnostics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cli-diagnostics.ts server/cli-diagnostics.test.ts
git commit -m "feat(diagnostics): bounded jsonl stderr tail + cleanup helper"
```

---

### Task 4: `ProcessMonitor` stderr sink + provider spawn wiring

**Files:**
- Modify: `server/process-monitor.ts` (constructor ~118, `spawnFor` stderr block ~166-203)
- Modify: `server/providers/claude/claude-provider.ts` (`ClaudeProviderOptions` ~186, constructor ~279, `createSession` ~283)
- Modify: `server/providers/default-providers.ts` (`DefaultProvidersOptions` ~8, `createDefaultProviders` ~16)
- Modify: `server/providers/types.ts` (`CreateSessionOptions` ~11, add `cliDebug`)
- Modify: `server/session-manager.ts` (providers constructor call ~505, add `logsDir`)
- Test: reuse the existing provider test harness (`claude-provider.agent-injection.test.ts` or `structured-provider.test.ts`)

**Interfaces:**
- Consumes: `appendStderrLine` (Task 3); `CreateSessionOptions.cliDebug` (Task 2).
- Produces: `ProcessMonitor` constructed with `{ stderrSink }`; `sdkOptions.debug` + `sdkOptions.debugFile` set when `opts.cliDebug` is true.

- [ ] **Step 1: Write the failing tests**

In the existing provider test file (`claude-provider.agent-injection.test.ts` or `structured-provider.test.ts`), add a test that when `cliDebug` is passed, the SDK options `debug` and `debugFile` are set. Follow the file's existing pattern for invoking `provider.createSession(...)` and inspecting `options` (the harness usually captures the SDK `query` call's `options`).

```ts
it('sets SDK debug + debugFile when cliDebug is true (spawn-time only)', async () => {
  const provider = makeClaudeProvider() // existing harness helper
  provider.createSession({
    id: 'sess-1',
    cwd: tmpCwd,
    cliDebug: true,
  } as unknown as CreateSessionOptions)
  // Existing harness spies on the SDK `query()` options — assert:
  //   capturedOptions.debug === true
  //   capturedOptions.debugFile endpointsWith `cli-sess-1.log`
})
```

If no provider harness is easy to extend, put this assertion behind the existing `captureCall`/`call.options` pattern from `structured-provider.test.ts` (it already inspects `call.options.maxBudgetUsd`). Reuse that harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- server/providers/claude/claude-provider.agent-injection.test.ts`
Expected: FAIL — `debug`/`debugFile` undefined in captured options.

- [ ] **Step 3: Write minimal implementation**

`server/providers/types.ts` `CreateSessionOptions` (~11): add

```ts
/** Effective per-session CLI debug intent (resolved global/override).
 *  Spawn-time only — maps to SDK Options.debug + debugFile. */
cliDebug?: boolean
```

`server/process-monitor.ts`:

1. Constructor opts interface (the `opts` for `ProcessMonitor`, currently `{ safetyMs?: number }` at ~118): add
```ts
stderrSink?: (sessionId: string, line: string) => void
```

2. Store it on the instance: `readonly stderrSink?: (sessionId: string, line: string) => void`, set in the constructor.

3. In `spawnFor`, inside the `if (line) log.warn(...)` branch (~187), add after the log call:
```ts
this.stderrSink?.(sid, line)
```
Use `sid` (the same string already logged), not the captured session id, so stray spawns still tee.

`server/providers/claude/claude-provider.ts`:

1. `ClaudeProviderOptions` (~186): add `logsDir?: string`
2. Constructor (~279):
```ts
this.processMonitor = new ProcessMonitor(
  (info) => this.opts.onProcessExit?.(info),
  { stderrSink: (sid, line) => void appendStderrLine(this.opts.logsDir, sid, line) },
)
```
3. Import `appendStderrLine` from `../../cli-diagnostics.js` (the file lives under `providers/claude/`) and `mkdirSync` from `node:fs`, `join` from `node:path` (confirm whether `join` is already imported).
4. In `createSession`, after the `perTaskStopAffordance` line (~326) and before `applyStandardQueryOpts`:
```ts
if (opts.cliDebug) {
  if (this.opts.logsDir) mkdirSync(this.opts.logsDir, { recursive: true })
  sdkOptions.debug = true
  if (this.opts.logsDir) sdkOptions.debugFile = join(this.opts.logsDir, `cli-${opts.id}.log`)
}
```

`server/providers/default-providers.ts`:

1. `DefaultProvidersOptions`: add `logsDir?: string`
2. `createDefaultProviders`: pass `logsDir: opts.logsDir` into `new ClaudeProvider(opts)`.

`server/session-manager.ts` constructor (~505):

```ts
this.providers = opts.providers ?? createDefaultProviders({
  claudeBinary: opts.claudeBinary,
  mpStore: opts.mpStore,
  agentStore: this.agentStore,
  mcpStore: this.mcpStore,
  onProcessExit: (info) => this.handleProcessExit(info),
  logsDir: join(this.store.getDir(), 'logs'),
})
```
(`join` is already imported in `session-manager.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- server/providers/claude/claude-provider.agent-injection.test.ts server/session-manager.test.ts`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add server/process-monitor.ts server/providers/claude/claude-provider.ts server/providers/default-providers.ts server/providers/types.ts server/session-manager.ts + test files
git commit -m "feat(provider): wire SDK debug/debugFile + stderr sink per session"
```

---

### Task 5: REST diagnostics router + SessionManager methods

**Files:**
- Create: `server/routes/diagnostics.ts`
- Modify: `server/routes/index.ts` (import + mount)
- Modify: `server/session-manager.ts` (add `getDiagnostics` + `setCliDebug`)
- Test: `server/routes/diagnostics.test.ts`

**Interfaces:**
- Consumes: `readStderrTail`, `cliLogInfo` (Task 3), `defaultConfig.cliDebug`, `Session.cliDebug`, `writeStore`.
- Produces:
  - `SessionManager.getDiagnostics(id): Promise<{ cliDebug: { global: boolean; perSession?: boolean; effective: boolean }; stderrTail: string[]; debugLog: { exists: boolean; path?: string; size?: number } }>`
  - `SessionManager.setCliDebug(id, body: { cliDebug?: boolean | null }): Promise<{ cliDebug: {...}; note: string }>`
  - `buildDiagnosticsRouter(sm: SessionManager): Hono` mounted at `/sessions/:id/diagnostics`.

- [ ] **Step 1: Write the failing tests**

Create `server/routes/diagnostics.test.ts` (follow the direct `app.request` style from `agent-definition-routes.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDiagnosticsRouter } from './diagnostics.js'
import { SessionManager } from '../session-manager.js'
import { appendStderrLine } from '../cli-diagnostics.js'
import { SessionStore } from '../persistence.js'

function makeSm() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-diag-'))
  const sm = new SessionManager({ store: new SessionStore({ stateDir: dir }) })
  return { sm, app: new Hono().route('/', buildDiagnosticsRouter(sm)) }
}

describe('diagnostics router', () => {
  it('GET returns the effective cliDebug + stderr tail + debug log info', async () => {
    const { sm, app } = makeSm()
    const id = (await sm.create({ cwd: tmpdir() })).id
    const logsDir = join(sm.store.getDir(), 'logs')
    await appendStderrLine(logsDir, id, 'boom')

    const res = await app.request(`/sessions/${id}/diagnostics`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cliDebug.effective).toBe(false) // global default off
    expect(body.cliDebug.global).toBe(false)
    expect(body.stderrTail).toEqual(['boom'])
    expect(body.debugLog.exists).toBe(false)
  })

  it('PUT sets and clears the per-session override', async () => {
    const { sm, app } = makeSm()
    const id = (await sm.create({ cwd: tmpdir() })).id
    let res = await app.request(`/sessions/${id}/diagnostics`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cliDebug: true }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).cliDebug.perSession).toBe(true)
    expect((await res.json()).cliDebug.effective).toBe(true)

    res = await app.request(`/sessions/${id}/diagnostics`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cliDebug: null }),
    })
    const cleared = await res.json()
    expect(cleared.cliDebug.perSession).toBeUndefined()
    expect(cleared.cliDebug.effective).toBe(false)
    expect(sm.store.get(id)?.cliDebug).toBeUndefined()
  })

  it('404s on an unknown session', async () => {
    const { app } = makeSm()
    const res = await app.request('/sessions/nope/diagnostics')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- server/routes/diagnostics.test.ts`
Expected: FAIL — module not found / methods missing.

- [ ] **Step 3: Implement minimal code**

`server/session-manager.ts` — add methods next to the other read/control methods (confirm `HttpError` is already imported — it is, the manager throws it elsewhere; confirm `readStderrTail`/`cliLogInfo` need importing):

```ts
async getDiagnostics(id: string): Promise<{
  cliDebug: { global: boolean; perSession?: boolean; effective: boolean }
  stderrTail: string[]
  debugLog: { exists: boolean; path?: string; size?: number }
}> {
  const s = this.require(id)
  const logsDir = join(this.store.getDir(), 'logs')
  const global = defaultConfig.cliDebug ?? false
  const perSession = s.cliDebug
  const [stderrTail, debugLog] = await Promise.all([
    readStderrTail(logsDir, id),
    cliLogInfo(logsDir, id),
  ])
  return {
    cliDebug: { global, perSession, effective: perSession ?? global },
    stderrTail,
    debugLog,
  }
}

async setCliDebug(id: string, body: { cliDebug?: boolean | null }): Promise<{
  cliDebug: { global: boolean; perSession?: boolean; effective: boolean }
  note: string
}> {
  const s = this.require(id)
  const v = body?.cliDebug
  if (v === undefined) throw new HttpError(400, 'cliDebug (boolean or null) is required')
  s.cliDebug = v === null ? undefined : v
  this.writeStore(s)
  const global = defaultConfig.cliDebug ?? false
  return {
    cliDebug: { global, perSession: s.cliDebug, effective: s.cliDebug ?? global },
    note: 'applies on the next session start',
  }
}
```

Add imports in `session-manager.ts`:
```ts
import { readStderrTail, cliLogInfo } from './cli-diagnostics.js'
```

`server/routes/diagnostics.ts`:

```ts
import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { safeJson } from './index.js'

export function buildDiagnosticsRouter(sm: SessionManager): Hono {
  const app = new Hono()

  app.get('/sessions/:id/diagnostics', async (c) => {
    return c.json(await sm.getDiagnostics(c.req.param('id')))
  })

  app.put('/sessions/:id/diagnostics', async (c) => {
    const body = await safeJson<{ cliDebug?: boolean | null }>(c.req)
    return c.json(await sm.setCliDebug(c.req.param('id'), body ?? {}))
  })

  return app
}
```

`server/routes/index.ts`: after `buildHooksRouter` import add `import { buildDiagnosticsRouter } from './diagnostics.js'`, and after the hooks mount add:

```ts
app.route('/', buildDiagnosticsRouter(sm))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- server/routes/diagnostics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/diagnostics.ts server/routes/diagnostics.test.ts server/routes/index.ts server/session-manager.ts
git commit -m "feat(diagnostics): per-session diagnostics REST router"
```

---

### Task 6: Client — `useDiagnostics` + SettingsPanel Diagnostics tab + spawn-failure display

**Files:**
- Create: `src/hooks/useDiagnostics.ts`
- Create: `src/components/DiagnosticsPanel.tsx`
- Modify: `src/components/SettingsPanel.tsx` (`SettingsTab` union ~48, tab buttons, render block ~1545)
- Modify: the session-error rendering (locate via `rg "session.error" src/components`) to show a collapsible stderr tail
- Test: `src/hooks/useDiagnostics.test.ts` + `src/components/DiagnosticsPanel.test.tsx`

**Interfaces:**
- Consumes: `api.get<T>` / `api.put<T>` (from `src/hooks/useApi.ts`); REST shapes from Task 5.
- Produces: `useDiagnostics(sessionId)` returning `{ data, refresh, setCliDebug, loading, error }`.

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/useDiagnostics.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDiagnostics } from './useDiagnostics'
import type { DiagnosticsData } from './useDiagnostics'

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))
vi.mock('./useApi', () => ({ api: { get: mocks.get, put: mocks.put } }))

const data: DiagnosticsData = {
  cliDebug: { global: false, effective: false },
  stderrTail: ['boom'],
  debugLog: { exists: false },
}

describe('useDiagnostics', () => {
  beforeEach(() => {
    mocks.get.mockReset()
    mocks.put.mockReset()
    mocks.get.mockResolvedValue(data)
  })
  it('fetches diagnostics on mount and refreshes', async () => {
    const { result } = renderHook(() => useDiagnostics('s1'))
    await waitFor(() => expect(result.current.data).toEqual(data))
    expect(mocks.get).toHaveBeenCalledWith('/sessions/s1/diagnostics')
    mocks.get.mockResolvedValue({ ...data, stderrTail: ['x'] })
    await act(async () => { await result.current.refresh() })
    expect(result.current.data?.stderrTail).toEqual(['x'])
  })
  it('put sends a boolean override and null clears it', async () => {
    const { result } = renderHook(() => useDiagnostics('s1'))
    await waitFor(() => expect(result.current.data).toEqual(data))
    mocks.put.mockResolvedValue({ cliDebug: { global: false, perSession: true, effective: true } })
    await act(async () => { await result.current.setCliDebug(true) })
    expect(mocks.put).toHaveBeenCalledWith('/sessions/s1/diagnostics', { cliDebug: true })
    mocks.put.mockResolvedValue({ cliDebug: { global: false, effective: false } })
    await act(async () => { await result.current.setCliDebug(null) })
    expect(mocks.put).toHaveBeenCalledWith('/sessions/s1/diagnostics', { cliDebug: null })
  })
})
```

Create `src/components/DiagnosticsPanel.test.tsx` (jsdom; render `<DiagnosticsPanel sessionId="s1" />` with `useDiagnostics` mocked via the same `vi.mock` pattern). Assert: the select reflects the effective value; a stderr line renders in a `<pre>`; clicking Refresh calls `refresh`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/hooks/useDiagnostics.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write minimal implementation**

`src/hooks/useDiagnostics.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'
import { api } from './useApi'

export interface DiagnosticsCliDebug {
  global: boolean
  perSession?: boolean
  effective: boolean
}
export interface DiagnosticsData {
  cliDebug: DiagnosticsCliDebug
  stderrTail: string[]
  debugLog: { exists: boolean; path?: string; size?: number }
}

export function useDiagnostics(sessionId: string) {
  const [data, setData] = useState<DiagnosticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await api.get<DiagnosticsData>(`/sessions/${sessionId}/diagnostics`))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])

  const setCliDebug = useCallback(async (value: boolean | null) => {
    const res = await api.put<{ cliDebug: DiagnosticsCliDebug }>(`/sessions/${sessionId}/diagnostics`, { cliDebug: value })
    setData((prev) => (prev ? { ...prev, cliDebug: res.cliDebug } : prev))
  }, [sessionId])

  return { data, loading, error, refresh, setCliDebug }
}
```

`src/components/DiagnosticsPanel.tsx`:

```tsx
import { useState } from 'react'
import { useDiagnostics } from '../hooks/useDiagnostics'

export function DiagnosticsPanel({ sessionId }: { sessionId: string }) {
  const { data, loading, error, refresh, setCliDebug } = useDiagnostics(sessionId)
  const [saving, setSaving] = useState(false)

  async function choose(value: boolean | null) {
    setSaving(true)
    try {
      await setCliDebug(value)
    } catch {
      // keep minimal — the hook keeps prior data; a toast could be added later
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) return <div className="settings-field">Loading diagnostics…</div>
  if (error && !data) return <div className="settings-card-error">{error}</div>

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h4>Diagnostics</h4>
        <button className="btn btn-sm" onClick={() => void refresh()}>Refresh</button>
      </div>

      <label className="settings-field">
        <span>CLI debug logging</span>
        <select
          value={data?.cliDebug.perSession === undefined ? '' : data.cliDebug.perSession ? 'on' : 'off'}
          onChange={(e) => {
            const v = e.target.value
            void choose(v === '' ? null : v === 'on')
          }}
          disabled={saving}>
          <option value="">Global ({data?.cliDebug.global ? 'on' : 'off'})</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        <span className="settings-hint">Applies on the next session start.</span>
      </label>

      <div className="settings-field settings-field-block">
        <span>stderr tail</span>
        <pre className="diag-stderr">
          {(data?.stderrTail ?? []).slice(-100).join('\n') || '(no stderr yet)'}
        </pre>
        <span className="settings-hint">{data?.stderrTail.length ?? 0} lines captured</span>
      </div>

      {data?.debugLog.exists && (
        <div className="settings-field">
          <span>Debug log</span>
          <code className="settings-hint">{data.debugLog.path}</code>
          <span className="settings-hint"> ({data.debugLog.size} bytes)</span>
        </div>
      )}
    </div>
  )
}
```

Add the `.diag-stderr` CSS in the SettingsPanel stylesheet using theme variables:
```css
.diag-stderr {
  background: var(--btn-hover-bg, var(--surface-2));
  color: var(--text);
  font-family: var(--mono, monospace);
  font-size: 12px;
  max-height: 240px;
  overflow: auto;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
```
(Find the actual variables the codebase uses — check the settings/surface CSS vars and use those, adding both `:root` and `[data-theme="light"]` values if new.)

`src/components/SettingsPanel.tsx`:
1. Extend the tab union (~48): `| 'diagnostics'`
2. Add a tab header button next to the existing ones.
3. In the render block (near `tab === 'usage'`), add:
```tsx
{tab === 'diagnostics' && <DiagnosticsPanel sessionId={session.id} />}
```
4. Import `DiagnosticsPanel` from `./DiagnosticsPanel`.

Spawn-failure display: in the component rendering `session.error`, when the error is present, render:
```tsx
{error && (
  <details>
    <summary>stderr</summary>
    <pre className="diag-stderr">{(stderrTail ?? []).join('\n') || '(no stderr captured)'}</pre>
  </details>
)}
```
where `stderrTail` comes from a `useDiagnostics(session.id).data?.stderrTail.slice(-30)` hook call in that component (lazy — only stated when the error card is on screen).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/hooks/useDiagnostics.test.ts src/components/DiagnosticsPanel.test.tsx`
Expected: PASS. Also run `npx tsc -p tsconfig.json --noEmit` and confirm no NEW errors in files you touched (pre-existing errors in unrelated files may exist in the worktree baseline).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useDiagnostics.ts src/components/DiagnosticsPanel.tsx src/components/SettingsPanel.tsx src/components/DiagnosticsPanel.test.tsx src/hooks/useDiagnostics.test.ts + the error-card component
git commit -m "feat(ui): Diagnostics tab + spawn-failure stderr view"
```

---

### Task 7: Boot cleanup

**Files:**
- Modify: `server/cli.ts` (after stores load, ~141)
- Test: `cleanupCliLogs` behavior is already covered in Task 3; this task only wires the boot call.

**Interfaces:**
- Consumes: `cleanupCliLogs` (Task 3).
- Produces: cleanup of stale `cli-*.log` / `cli-stderr-*.jsonl` at boot.

- [ ] **Step 1: Implement the boot call**

In `server/cli.ts`, after the stores are constructed (~141, near where the upload-store load is logged), add:

```ts
// Prune stale per-session CLI diagnostics (cli-*.log / cli-stderr-*.jsonl)
// older than 14 days. Fire-and-forget: never blocks boot on IO.
void import('./cli-diagnostics.js').then(({ cleanupCliLogs }) =>
  cleanupCliLogs(join(stateDir, 'logs')).then((removed) => {
    if (removed) log.info(`cleaned ${removed} stale CLI diagnostic file(s)`)
  }).catch(() => undefined),
)
```

Ensure `join` and `log` are already imported in `cli.ts` (they are — used earlier).

- [ ] **Step 2: Verify compile + tests**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: EXIT 0 (no new errors in your files).

Run: `npm run test -- server/cli-diagnostics.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/cli.ts
git commit -m "chore(diagnostics): prune stale CLI diagnostic files at boot"
```

---

## Self-Review Notes

- Spec coverage: §3.1 config → Task 1; §3.2 SessionMeta → Task 2; §3.3 effective resolution → Task 2 `resolveCliDebug` + Task 4 provider resolution; §4 file layout → Task 3 (jsonl) + Task 4 (debugFile); §5 provider wiring → Task 4; §6 stderr tail capture → Task 3+4 (sink); §7 REST → Task 5; §8 client tab + hook → Task 6; §8.3 spawn-failure → Task 6 (error-card fetch); §9 cleanup → Task 7; §10 tests → each task. §11 non-goals respected (no runtime setter, no `Options.stderr` path, no download/open endpoint).
- Known harness note: Task 5 uses `SessionStore` in the test constructor — if `SessionManagerOptions` names the field `store`, keep as written; otherwise adjust to the existing `session-manager.test.ts` harness.