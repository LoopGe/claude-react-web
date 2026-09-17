# Dev-only `appdebug` debug tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a first-party `appdebug` MCP server that gives the agent its own view of the host server process (log ring, metrics, session internals, permission-gated runtime writes) — but only when the server runs from TypeScript source.

**Architecture:** A new `server/dev-mode.ts` decides dev-ness from the entry module (`isDevRuntime`) and wires up two things: an opt-in ring buffer in `server/log.ts` (capturing only lines that already passed the level/scope filter) and registration of a new first-party server `server/sdk-tools/app-debug.ts` into the existing `firstPartyRegistry`. The tool handlers are bound to a narrow `DebugHost` interface implemented structurally by `SessionManager`, so the tool module never touches session internals and `server/sdk-tools/types.ts` / `registry.ts` are untouched. Because `injectAll` only iterates *registered* servers, "never exposed in a published run" is guaranteed by the registration step — no config value can turn these tools on.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (`tool`, `SdkMcpToolDefinition`), `zod`, Hono (untouched), vitest, `server/log.ts`, `server/metrics.ts`, `server/session-manager.ts`.

**Spec:** `docs/superpowers/specs/2026-09-17-dev-debug-tools-design.md`

## Global Constraints

- **All diagnostic logging goes through `server/log.ts`** (`createLogger(scope)`). Never add bare `console.*` for diagnostics. The `[scope]` tag is auto-prepended — do not hand-write it.
- **Never let an MCP handler reject.** Every handler is wrapped in `guard()`; errors become `{ content: [{ type: 'text', text }], isError: true }`. A rejected MCP call hangs the turn.
- **Do NOT modify** `server/sdk-tools/types.ts`, `server/sdk-tools/registry.ts`, `server/permission-broker.ts`, or any file under `src/` or `shared/`. The UI picks up the new server generically via `GET /api/first-party-tools`.
- **No new dependencies.** `zod` is already a direct dependency.
- **Server name is `appdebug`**; tool FQNs are `mcp__appdebug__{name}`. The registry stores BARE tool names.
- **Read-only tool set is exactly** `{ logs, metrics, sessions, session }` — these go into `readOnlyToolNames`, which is what makes `permission-broker.ts` auto-approve them. The three write tools must NOT be in that set.
- **No `mutatingToolNames`** on this server — these tools never touch the worktree, so `git-broadcast` must not schedule a snapshot for them.
- **Ring buffer captures only lines that already passed `passes()`.** This is load-bearing (zero performance distortion); there is a dedicated regression test for it in Task 1.
- **Both tsconfigs must typecheck**: `npm run typecheck` runs `tsc -p tsconfig.json` + `tsc -p tsconfig.node.json`.
- **Every commit message ends with** the line `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- **Verified facts this plan relies on** (do not re-derive):
  - `SessionInfo` has `running`, `terminated`, `terminatedReason?`, `slept?`, `subscribers`, `messageCount`, `cwd?`, `model?`, `permissionMode?`, `title?`, `gitStartSha?`. It has **no** `phase` field.
  - `Session` (internal, `server/session-types.ts`) has `pending: Map`, `pendingTurns: number`, `history: SDKMessage[]`, `subagentHistory: SDKMessage[]`, `withdrawnUuids: string[]`, `promptUuids?: PromptUuidEntry[]`, `tasks: Map<string, TaskRecordUi>`, `firstPartyErrors?: Record<string, string>`.
  - `PromptUuidEntry = { u: string; v?: string }`.
  - The "queued input" predicate is `receivedAt != null && consumedAt == null`.
  - `SessionManager.unload(id, opts?)` is **public** and defaults to `removeFromStore: false` (the session stays in the store).
  - `SessionManager.contextUsage(id)` calls `requireLive(id)` and therefore **throws for dormant/terminated sessions**.
  - `SessionManager.mergedHistory(s)` is private but reachable from other methods of the class.
  - `metrics.snapshot()` returns `{ uptimeSec, gauges, counters, histograms }`; the singleton exported from `server/metrics.ts` is `{ observe, count, gauge, snapshot, reset }`.
  - `log.ts` `emit()` calls `passes(scope, level)` first, then prints, then `writeToFile(tag, args)`.

**Deliberate deviation from the spec (one line):** the spec wrote `isDevRuntime(argv1 = process.argv[1], env = process.env)`. This plan uses **explicit, non-defaulted parameters** `isDevRuntime(argv1: string | undefined, env: Record<string, string | undefined>)`, because a defaulted `argv1` makes the `argv[1] === undefined` case impossible to test (passing `undefined` re-triggers the default). The caller in `cli.ts` passes both explicitly. Everything else in the spec stands.

## File Structure

| File | Responsibility |
|---|---|
| `server/log.ts` *(modify)* | Add an opt-in ring buffer beside the existing opt-in file logging: `enableLogRing` / `disableLogRing` / `isLogRingEnabled` / `readLogRing`. Captures formatted lines, applies the filters. Knows nothing about dev mode. |
| `server/dev-mode.ts` *(create)* | Dev-runtime detection (`isDevRuntime`, pure) and the wiring function (`enableDevMode`: turn the ring on + register the server). Knows nothing about tool definitions. |
| `server/sdk-tools/app-debug.ts` *(create)* | The `appdebug` tool definitions and its `FirstPartyToolServer` factory. Bound to a `DebugHost`. Knows nothing about how the host is built. |
| `server/session-types.ts` *(modify)* | Snapshot types (`DebugSessionSummary`, `DebugSessionDetail`) + extraction of two named types for shapes currently written inline in `SessionManager`. |
| `server/session-manager.ts` *(modify)* | `debugSessions()` / `debugSession(id)` — the only code that can read session internals. Returns plain JSON. |
| `server/cli/args.ts` *(modify)* | `--dev` / `--no-dev` flags + HELP text. |
| `server/cli.ts` *(modify)* | 3-line wiring after the `SessionManager` is constructed. |

---

### Task 1: Log ring buffer in `server/log.ts`

**Files:**
- Modify: `server/log.ts`
- Test: `server/log.test.ts`

**Interfaces:**
- Consumes: existing `passes(scope, level)`, `formatArg(arg)`, `LEVELS` (module-private, same file).
- Produces:
  - `export interface LogRingLine { ts: number; level: LogLevel; scope: string; msg: string }`
  - `export interface LogRingQuery { level?: LogLevel; scope?: string; since?: number; grep?: string; limit?: number }`
  - `export function enableLogRing(capacity?: number): void` (default 1000)
  - `export function disableLogRing(): void`
  - `export function isLogRingEnabled(): boolean`
  - `export function readLogRing(opts?: LogRingQuery): { lines: LogRingLine[]; total: number; dropped: number }`

- [ ] **Step 1: Write the failing tests**

Append to `server/log.test.ts` (add the new imports to the existing `from './log.js'` import list at the top: `enableLogRing, disableLogRing, isLogRingEnabled, readLogRing, setLogConfig`):

```ts
describe('log ring buffer', () => {
  afterEach(() => {
    disableLogRing()
    setLogConfig({ level: 'info', scopes: null })
  })

  it('captures only lines that already passed the level filter', () => {
    setLogConfig({ level: 'warn', scopes: null })
    enableLogRing(10)
    const log = createLogger('ring-a')
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    log.info('muted')
    log.warn('kept')
    expect(readLogRing().lines.map((l) => l.msg)).toEqual(['kept'])
    expect(readLogRing().lines[0].level).toBe('warn')
    expect(readLogRing().lines[0].scope).toBe('ring-a')
    spyLog.mockRestore()
    spyWarn.mockRestore()
  })

  it('evicts the oldest lines past capacity and accumulates dropped', () => {
    enableLogRing(2)
    const log = createLogger('ring-b')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('1')
    log.info('2')
    log.info('3')
    const { lines, total, dropped } = readLogRing()
    expect(lines.map((l) => l.msg)).toEqual(['2', '3'])
    expect(total).toBe(2)
    expect(dropped).toBe(1)
    spy.mockRestore()
  })

  it('filters by scope (exact match)', () => {
    enableLogRing(50)
    const a = createLogger('ring-x')
    const b = createLogger('ring-y')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    a.info('from x')
    b.info('from y')
    expect(readLogRing({ scope: 'ring-y' }).lines.map((l) => l.msg)).toEqual(['from y'])
    spy.mockRestore()
  })

  it('filters by level as "at least this severe"', () => {
    enableLogRing(50)
    const log = createLogger('ring-l')
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(readLogRing({ level: 'warn' }).lines.map((l) => l.msg)).toEqual(['w', 'e'])
    spyLog.mockRestore()
    spyWarn.mockRestore()
    spyErr.mockRestore()
  })

  it('filters by since and by a case-insensitive grep', () => {
    enableLogRing(50)
    const log = createLogger('ring-g')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('alpha hit')
    log.info('beta miss')
    expect(readLogRing({ since: 0 }).lines).toHaveLength(2)
    expect(readLogRing({ since: Number.MAX_SAFE_INTEGER }).lines).toEqual([])
    expect(readLogRing({ grep: 'ALPHA' }).lines.map((l) => l.msg)).toEqual(['alpha hit'])
    spy.mockRestore()
  })

  it('applies limit AFTER filtering, keeping the newest N', () => {
    enableLogRing(50)
    const log = createLogger('ring-lim')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('one')
    log.info('two')
    log.info('three')
    expect(readLogRing({ limit: 2 }).lines.map((l) => l.msg)).toEqual(['two', 'three'])
    expect(readLogRing({ limit: 2 }).total).toBe(3)
    spy.mockRestore()
  })

  it('truncates a single line at 4096 chars including the elision marker', () => {
    enableLogRing(5)
    const log = createLogger('ring-t')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('x'.repeat(5000))
    const [line] = readLogRing().lines
    expect(line.msg).toHaveLength(4096)
    expect(line.msg.endsWith('…')).toBe(true)
    spy.mockRestore()
  })

  it('stops collecting after disable and reports an empty ring', () => {
    enableLogRing(5)
    const log = createLogger('ring-d')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('before')
    expect(readLogRing().lines).toHaveLength(1)
    disableLogRing()
    expect(isLogRingEnabled()).toBe(false)
    log.info('after')
    expect(readLogRing()).toEqual({ lines: [], total: 0, dropped: 0 })
    spy.mockRestore()
  })

  it('is a no-op while disabled', () => {
    expect(isLogRingEnabled()).toBe(false)
    const log = createLogger('ring-off')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('nothing collects this')
    expect(readLogRing().lines).toEqual([])
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/log.test.ts`
Expected: FAIL — `enableLogRing is not a function` (the exports do not exist yet).

- [ ] **Step 3: Implement the ring buffer**

In `server/log.ts`, append a new section at the end of the file (after the existing `// ── File logging ─` block, so it can reuse `formatArg`, which is declared there — function declarations hoist, so `emit()` may call it earlier in the source):

```ts
// ─ Log ring buffer (opt-in, in-process) ──────────────────────────
//
// A bounded in-memory tail of what the server actually PRINTED. Enabled by
// `enableLogRing` (dev mode only); symmetric with `enableFileLogging`.
//
// CAPTURE POINT IS LOAD-BEARING: `writeToRing` is called from `emit()` AFTER
// `passes()` has already filtered the line, so a muted line costs nothing and
// the ring never distorts the timings you are trying to measure. The trade-off
// is that the ring cannot show history that was filtered out — raise the level
// first, then reproduce.

export interface LogRingLine {
  ts: number
  level: LogLevel
  scope: string
  msg: string
}

/** Hard cap on one line's `msg` (INCLUDING the `…` elision marker). An
 *  unbounded line would let a single fat payload pin memory for the ring's
 *  whole retention window. */
const RING_LINE_MAX = 4096

interface RingState {
  capacity: number
  lines: LogRingLine[]
  dropped: number
}

let ring: RingState | null = null

/** Start collecting. Replaces any existing ring. */
export function enableLogRing(capacity = 1000): void {
  ring = { capacity: Math.max(1, capacity), lines: [], dropped: 0 }
}

/** Stop collecting and release the buffer. */
export function disableLogRing(): void {
  ring = null
}

export function isLogRingEnabled(): boolean {
  return ring !== null
}

function writeToRing(scope: string, level: LogLevel, args: unknown[]): void {
  if (!ring) return
  const raw = args.map(formatArg).join(' ')
  const msg = raw.length > RING_LINE_MAX ? `${raw.slice(0, RING_LINE_MAX - 1)}…` : raw
  ring.lines.push({ ts: Date.now(), level, scope, msg })
  const excess = ring.lines.length - ring.capacity
  if (excess > 0) {
    ring.dropped += excess
    ring.lines.splice(0, excess)
  }
}

export interface LogRingQuery {
  /** Keep lines AT LEAST this severe (reuses the LEVELS ordering). */
  level?: LogLevel
  /** Exact logger-scope match; use `grep` for fuzzy matching. */
  scope?: string
  /** Keep lines with `ts >= since` (epoch ms). */
  since?: number
  /** Case-insensitive substring match on `msg`. */
  grep?: string
  /** Keep the NEWEST N matches, applied after all other filters. */
  limit?: number
}

/** Read the ring. Filters are ANDed; `limit` keeps the newest N matches.
 *  Returns an empty result (not an error) when the ring is disabled. */
export function readLogRing(opts: LogRingQuery = {}): { lines: LogRingLine[]; total: number; dropped: number } {
  if (!ring) return { lines: [], total: 0, dropped: 0 }
  const { level, scope, since, grep, limit } = opts
  const needle = grep?.toLowerCase()
  let lines = ring.lines.filter(
    (l) =>
      (level === undefined || LEVELS[l.level] <= LEVELS[level]) &&
      (scope === undefined || l.scope === scope) &&
      (since === undefined || l.ts >= since) &&
      (needle === undefined || l.msg.toLowerCase().includes(needle)),
  )
  if (limit !== undefined && lines.length > limit) lines = lines.slice(lines.length - limit)
  return { lines, total: ring.lines.length, dropped: ring.dropped }
}
```

Then wire it into `emit()` — one added line, immediately after the existing `writeToFile(tag, args)`:

```ts
  function emit(level: LogLevel, consoleFn: (...a: unknown[]) => void, args: unknown[]) {
    if (!passes(scope, level)) return
    const fn = forceStderr && (level === 'info' || level === 'debug' || level === 'trace')
      ? console.error
      : consoleFn
    fn(tag, ...args)
    writeToFile(tag, args)
    writeToRing(scope, level, args)
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/log.test.ts`
Expected: PASS (all pre-existing `clearLogFile` / `setLogToStderr` tests still pass too).

- [ ] **Step 5: Commit**

```bash
git add server/log.ts server/log.test.ts
git commit -m "feat(log): add an opt-in in-process log ring buffer

Captures only lines that already passed the level/scope filter, so a muted
line costs nothing and the ring never distorts the timings being measured.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `isDevRuntime` — pure dev detection

**Files:**
- Create: `server/dev-mode.ts`
- Test: `server/dev-mode.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function isDevRuntime(argv1: string | undefined, env: Record<string, string | undefined>): boolean`

- [ ] **Step 1: Write the failing test**

Create `server/dev-mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isDevRuntime } from './dev-mode.js'

describe('isDevRuntime', () => {
  it('is true for a .ts / .tsx entry (npm run dev:server, direct tsx)', () => {
    expect(isDevRuntime('C:\\codes\\claude-react-web\\server\\cli.ts', {})).toBe(true)
    expect(isDevRuntime('/repo/server/cli.tsx', {})).toBe(true)
  })

  it('is true from source even when npm reports a non-dev lifecycle', () => {
    expect(isDevRuntime('/repo/server/cli.ts', { npm_lifecycle_event: 'start' })).toBe(true)
  })

  it('is true for an npm dev/dev:* lifecycle even without a .ts entry', () => {
    expect(isDevRuntime('/repo/dist/cli.mjs', { npm_lifecycle_event: 'dev' })).toBe(true)
    expect(isDevRuntime('/repo/dist/cli.mjs', { npm_lifecycle_event: 'dev:server' })).toBe(true)
  })

  it('is FALSE for the bundled .mjs entry — the published path', () => {
    expect(
      isDevRuntime('C:\\x\\node_modules\\claude-react-web\\dist\\cli.mjs', {
        npm_lifecycle_event: 'start',
      }),
    ).toBe(false)
    expect(isDevRuntime('/repo/dist/cli.mjs', {})).toBe(false)
  })

  it('is FALSE for npm run start / preview (lifecycle set, but not dev)', () => {
    expect(isDevRuntime('/repo/dist/cli.mjs', { npm_lifecycle_event: 'start' })).toBe(false)
    expect(isDevRuntime('/repo/dist/cli.mjs', { npm_lifecycle_event: 'preview' })).toBe(false)
  })

  it('does not treat a dev-PREFIXED script as dev', () => {
    expect(isDevRuntime('/repo/dist/cli.mjs', { npm_lifecycle_event: 'developed' })).toBe(false)
  })

  it('is false when argv[1] is undefined and no lifecycle is set', () => {
    expect(isDevRuntime(undefined, {})).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/dev-mode.test.ts`
Expected: FAIL — cannot resolve `./dev-mode.js`.

- [ ] **Step 3: Implement `isDevRuntime`**

Create `server/dev-mode.ts`:

```ts
// Dev-runtime detection and dev-only wiring.
//
// The `appdebug` tool server must never appear in a published run. Two
// signals, both verified to survive `tsx watch`'s fork (the dev:server
// script runs `tsx watch server/cli.ts`):
//
//  1. `process.argv[1]` — the entry module. Running from TypeScript source
//     means `npm run dev:server`, `npm run dev`, or a direct
//     `tsx server/cli.ts`; the bundled `dist/cli.mjs` used by
//     `npx claude-react-web` / `npm run start` / `npm run preview` ends in
//     `.mjs`. THIS IS THE PRIMARY SIGNAL: `npm_lifecycle_event` alone cannot
//     separate dev from prod, because `npm run start` also sets it (to
//     `start`).
//  2. `npm_lifecycle_event` — set by npm for any `npm run <script>`; only the
//     `dev` / `dev:*` forms count.
//
// `NODE_ENV` is deliberately NOT consulted: nothing in this repo sets it, so
// reading it would be a fake interface.

/** `dev` or `dev:<anything>` — deliberately not a bare `startsWith('dev')`,
 *  which would match an unrelated script named e.g. `developed`. */
const DEV_LIFECYCLE = /^dev(:|$)/

/** True when this process is a development run: the entry module is
 *  TypeScript source, or npm launched us via a `dev`/`dev:*` script.
 *
 *  Both inputs are explicit (no default parameter values) so the
 *  `argv1 === undefined` case is reachable in tests — a default of
 *  `process.argv[1]` would silently re-apply whenever a caller passes
 *  `undefined`. */
export function isDevRuntime(
  argv1: string | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (typeof argv1 === 'string' && /\.tsx?$/.test(argv1)) return true
  const lifecycle = env.npm_lifecycle_event
  return typeof lifecycle === 'string' && DEV_LIFECYCLE.test(lifecycle)
}
```

> This file has no imports yet. `enableDevMode` (Task 5) adds the `log.ts` /
> `app-debug.ts` / `registry.js` imports along with the function that uses
> them — importing them here would commit unused bindings, and
> `@typescript-eslint/no-unused-vars` is an error in this repo's
> `tseslint.configs.recommended` set.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/dev-mode.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/dev-mode.ts server/dev-mode.test.ts
git commit -m "feat(dev-mode): detect a dev runtime from the entry module

Primary signal is argv[1] ending in .ts/.tsx (running from source); npm's
npm_lifecycle_event dev/dev:* is the secondary signal. npm_lifecycle_event
alone is insufficient because npm run start also sets it.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Snapshot types + `SessionManager` introspection methods

**Files:**
- Modify: `server/session-types.ts` (add 3 types; extract 2 currently-inline return types)
- Modify: `server/session-manager.ts` (`getDiagnostics` / `toolServerStatus` return types; add `debugSessions` / `debugSession` / `debugSummaryOf` / `contextUsageOrNull`)
- Test: `server/session-manager.test.ts` (uses the existing mocked-SDK harness at the top of that file)

**Interfaces:**
- Consumes: `this.list()`, `this.info(s)`, `this.require(id)`, `this.mergedHistory(s)`, `this.getDiagnostics(id)`, `this.toolServerStatus(id)`, `this.contextUsage(id)`; `TooldRecordUi` from `shared/tasks.ts`; `FirstPartyToolDef` from `shared/first-party.ts`.
- Produces:
  - `export interface SessionCliDiagnostics { cliDebug: { global: boolean; perSession?: boolean; effective: boolean }; stderrTail: string[]; debugLog: { exists: boolean; path?: string; size?: number } }`
  - `export interface FirstPartyToolServerStatus { name: string; description: string; enabled: boolean; injected: boolean; requiresCwd: boolean; hasCwd: boolean; tools: FirstPartyToolDef[]; error?: string }`
  - `export interface DebugSessionSummary { … }` (fields below)
  - `export interface DebugSessionDetail extends DebugSessionSummary { historyTail; withdrawnUuids; promptUuids; tasks; cli; toolServers; contextUsage }`
  - `SessionManager.debugSessions(): DebugSessionSummary[]` (sync)
  - `SessionManager.debugSession(id: string, historyLimit?: number): Promise<DebugSessionDetail>` (async — it awaits `getDiagnostics`)

- [ ] **Step 1: Write the failing tests**

Add to `server/session-manager.test.ts`, inside the main `describe` block that owns the `sm` / `store` fixture (the one whose `beforeEach` does `sm = new SessionManager({ store })`), so the existing SDK mock harness applies:

```ts
describe('debug introspection', () => {
  it('lists a live session with a derived phase and zeroed counters', () => {
    const info = sm.create({ cwd: '/tmp', model: 'test-model' })
    const row = sm.debugSessions().find((r) => r.id === info.id)
    expect(row).toMatchObject({
      id: info.id,
      phase: 'live',
      running: true,
      terminated: false,
      pendingTurns: 0,
      pendingPermissions: 0,
      queuedInputs: 0,
    })
  })

  it('derives phase dormant for a session that is in the store but not live', async () => {
    const info = sm.create({ cwd: '/tmp', model: 'test-model' })
    await sm.unload(info.id)
    const row = sm.debugSessions().find((r) => r.id === info.id)
    expect(row?.phase).toBe('dormant')
    expect(row?.running).toBe(false)
    expect(row?.terminated).toBe(false)
  })

  it('counts a sent-but-unconsumed message as a queued input', async () => {
    const info = sm.create({ cwd: '/tmp', model: 'test-model' })
    sm.send(info.id, 'hello')
    const row = sm.debugSessions().find((r) => r.id === info.id)
    expect(row?.queuedInputs).toBe(1)
  })

  it('projects historyTail to routing metadata only and nulls contextUsage off-live', async () => {
    const info = sm.create({ cwd: '/tmp', model: 'test-model' })
    sm.send(info.id, 'hello')
    const detail = await sm.debugSession(info.id, 10)
    expect(detail.id).toBe(info.id)
    expect(detail.historyTail.length).toBeGreaterThan(0)
    // Projection only — never the SDK message body.
    expect(Object.keys(detail.historyTail[0]).sort()).toEqual(
      ['consumedAt', 'parentToolUseId', 'receivedAt', 'subtype', 'type', 'uuid'].filter(
        (k) => k in detail.historyTail[0],
      ).sort(),
    )
    expect(detail.historyTail[0].type).toBe('user')
    expect(detail.tasks).toEqual([])
    expect(detail.promptUuids.length).toBeGreaterThan(0)

    // A dormant session has no live Query: contextUsage throws internally and
    // the snapshot reports null rather than failing.
    await sm.unload(info.id)
    const dormant = await sm.debugSession(info.id, 0)
    expect(dormant.contextUsage).toBeNull()
    expect(dormant.historyTail).toEqual([])
  })

  it('throws for an unknown session id', async () => {
    expect(() => sm.debugSessions()).not.toThrow()
    await expect(sm.debugSession('nope')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/session-manager.test.ts -t 'debug introspection'`
Expected: FAIL — `sm.debugSessions is not a function`.

- [ ] **Step 3: Extract the two inline shapes into named types**

In `server/session-types.ts`, add near the other exported interfaces (the file already imports from `../shared/tasks.js` and can import from `../shared/first-party.js`):

```ts
import type { FirstPartyToolDef } from '../shared/first-party.js'

/** CLI subprocess diagnostics for one session (SDK stderr tail + the
 *  optional per-session CLI debug log file). */
export interface SessionCliDiagnostics {
  cliDebug: { global: boolean; perSession?: boolean; effective: boolean }
  stderrTail: string[]
  debugLog: { exists: boolean; path?: string; size?: number }
}

/** Status of one registered first-party tool server for one session. */
export interface FirstPartyToolServerStatus {
  name: string
  description: string
  enabled: boolean
  injected: boolean
  requiresCwd: boolean
  hasCwd: boolean
  tools: FirstPartyToolDef[]
  error?: string
}
```

In `server/session-manager.ts`, replace the inline anonymous return types (no behaviour change):
- `async getDiagnostics(id: string): Promise<SessionCliDiagnostics> {`
- `toolServerStatus(id: string): FirstPartyToolServerStatus[] {`

`server/session-manager-mcp.ts` declares its own `toolServerStatus`-shaped inline type — leave it alone; only the `session-manager.ts` declaration changes. Import the two new names into `session-manager.ts` from `./session-types.js`.

- [ ] **Step 4: Add the snapshot types**

In `server/session-types.ts`:

```ts
/** Plain-JSON projection of one session for the dev-only `appdebug` tools.
 *  Carries no SDK message bodies — see DebugSessionDetail.historyTail. */
export interface DebugSessionSummary {
  id: string
  title?: string
  /** Derived, never stored: 'terminated' if `terminated`, else 'live' if
   *  `running`, else 'dormant'. `SessionInfo` has no phase field. */
  phase: 'live' | 'dormant' | 'terminated'
  terminatedReason?: string
  cwd?: string
  model?: string
  permissionMode?: string
  running: boolean
  terminated: boolean
  slept?: boolean
  subscribers: number
  messageCount: number
  /** Sent-but-unfinished turns (mirrors the client's Working state). */
  pendingTurns: number
  /** Tool-use permission requests parked awaiting a decision. */
  pendingPermissions: number
  /** Derived: main-ring entries with `receivedAt` but no `consumedAt` — the
   *  exact predicate the client renders as "queued". */
  queuedInputs: number
  gitStartSha?: string
  firstPartyErrors?: Record<string, string>
}

export interface DebugSessionDetail extends DebugSessionSummary {
  /** Tail of the merged history, projected to routing metadata ONLY. The
   *  message body is deliberately dropped: the ring caps at 500 frames each
   *  potentially carrying a large payload. */
  historyTail: Array<{
    type: string
    subtype?: string
    uuid?: string
    parentToolUseId?: string
    receivedAt?: number
    consumedAt?: number
  }>
  withdrawnUuids: string[]
  /** app-level uuid → SDK on-disk uuid pairs (the rewind-files mapping). */
  promptUuids: Array<{ u: string; v?: string }>
  tasks: Array<{
    taskId: string
    taskType?: string
    status: string
    isBackgrounded?: boolean
    progressSummary?: string
    lastToolName?: string
    startedAt?: number
    endedAt?: number
  }>
  cli: SessionCliDiagnostics
  toolServers: FirstPartyToolServerStatus[]
  /** `contextUsage(id)` result, or null when the session is not live
   *  (contextUsage requires a live Query and throws otherwise). */
  contextUsage: unknown | null
}
```

- [ ] **Step 5: Implement the `SessionManager` methods**

In `server/session-manager.ts`, add next to `getDiagnostics` (they share the diagnostic sources). Add the two module-level helpers near the other free functions at the bottom of the file:

```ts
/** Snapshot fields that come straight from the public `SessionInfo`. */
function debugSummaryFromInfo(
  i: SessionInfo,
): Omit<DebugSessionSummary, 'pendingTurns' | 'pendingPermissions' | 'queuedInputs' | 'firstPartyErrors'> {
  return {
    id: i.id,
    title: i.title,
    phase: i.terminated ? 'terminated' : i.running ? 'live' : 'dormant',
    terminatedReason: i.terminatedReason,
    cwd: i.cwd,
    model: i.model,
    permissionMode: i.permissionMode,
    running: i.running,
    terminated: i.terminated,
    slept: i.slept,
    subscribers: i.subscribers,
    messageCount: i.messageCount,
    gitStartSha: i.gitStartSha,
  }
}

/** Main-ring entries the SDK has not consumed yet. Scans `history` directly
 *  (no merge/sort): a queued input is always a top-level user message, and
 *  this runs per session on a list call. */
function countQueuedInputs(history: SDKMessage[]): number {
  let n = 0
  for (const m of history) {
    const r = m as { receivedAt?: number; consumedAt?: number }
    if (r.receivedAt != null && r.consumedAt == null) n++
  }
  return n
}

/** Project a ring frame to routing metadata only — never the body. */
function projectHistoryFrame(m: SDKMessage): DebugSessionDetail['historyTail'][number] {
  const r = m as {
    type?: string
    subtype?: string
    uuid?: string
    parent_tool_use_id?: string | null
    receivedAt?: number
    consumedAt?: number
  }
  return {
    type: r.type ?? 'unknown',
    subtype: r.subtype,
    uuid: r.uuid,
    parentToolUseId: r.parent_tool_use_id ?? undefined,
    receivedAt: r.receivedAt,
    consumedAt: r.consumedAt,
  }
}
```

And the methods (place them right after `getDiagnostics` / `setCliDebug`):

```ts
  /** Dev-only (`appdebug`): plain-JSON overview of every session — live ones
   *  from their in-memory state, the rest (hibernated, from the store) with
   *  zeroed counters. */
  debugSessions(): DebugSessionSummary[] {
    const out: DebugSessionSummary[] = []
    for (const info of this.list()) {
      const s = this.sessions.get(info.id)
      out.push({
        ...debugSummaryFromInfo(info),
        pendingTurns: s?.pendingTurns ?? 0,
        pendingPermissions: s?.pending.size ?? 0,
        queuedInputs: s ? countQueuedInputs(s.history) : 0,
        firstPartyErrors: s?.firstPartyErrors,
      })
    }
    return out
  }

  /** Dev-only (`appdebug`): deep-dive one session. Reads internals that no
   *  other public surface exposes (withdrawnUuids, promptUuids, the task
   *  table) but projects the history ring to routing metadata only. */
  async debugSession(id: string, historyLimit = 30): Promise<DebugSessionDetail> {
    const s = this.require(id)
    const tail = this.mergedHistory(s).slice(-Math.max(0, historyLimit))
    return {
      ...debugSummaryFromInfo(this.info(s)),
      pendingTurns: s.pendingTurns,
      pendingPermissions: s.pending.size,
      queuedInputs: countQueuedInputs(s.history),
      firstPartyErrors: s.firstPartyErrors,
      historyTail: tail.map(projectHistoryFrame),
      withdrawnUuids: [...s.withdrawnUuids],
      promptUuids: (s.promptUuids ?? []).map((e) => ({ u: e.u, v: e.v })),
      tasks: [...s.tasks.values()].map((t) => ({
        taskId: t.taskId,
        taskType: t.taskType,
        status: t.status,
        isBackgrounded: t.isBackgrounded,
        progressSummary: t.progressSummary,
        lastToolName: t.lastToolName,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
      })),
      cli: await this.getDiagnostics(id),
      toolServers: this.toolServerStatus(id),
      contextUsage: await this.contextUsageOrNull(id),
    }
  }

  /** `contextUsage()` calls requireLive() and throws for a dormant or
   *  terminated session. Inspecting one is normal, so the debug snapshot
   *  reports null instead of failing the whole call. */
  private async contextUsageOrNull(id: string): Promise<unknown | null> {
    try {
      return await this.contextUsage(id)
    } catch {
      return null
    }
  }
```

Import `DebugSessionDetail` / `DebugSessionSummary` (type-only) from `./session-types.js` in `session-manager.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS — the 5 new tests plus every pre-existing test in the file (the type extraction in Step 3 is behaviour-neutral).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors from either tsconfig. If `server/session-manager-mcp.ts`'s own inline `toolServerStatus` type now conflicts, leave it as-is — the two declarations are structurally identical and independent.

- [ ] **Step 8: Commit**

```bash
git add server/session-types.ts server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(session): add plain-JSON debug introspection methods

debugSessions()/debugSession() expose internals no other public surface
reaches (pending counters, queued inputs, withdrawn/prompt uuids, the task
table) while projecting the history ring to routing metadata only. Also
extracts two inline anonymous return types into named ones.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `appdebug` tool definitions

**Files:**
- Create: `server/sdk-tools/app-debug.ts`
- Test: `server/sdk-tools/app-debug.test.ts`

**Interfaces:**
- Consumes: `DebugSessionSummary` / `DebugSessionDetail` (Task 3); `readLogRing` / `isLogRingEnabled` / `isFileLoggingEnabled` / `getLogFilePath` / `getLogConfig` / `setLogConfig` (Task 1 + existing); `metrics.snapshot()`; `FirstPartyToolServer` from `./types.js` (`buildTools(cwd: string | null)`).
- Produces:
  - `export const DEBUG_TOOLS_SERVER_NAME = 'appdebug'`
  - `export const DEBUG_READ_ONLY_TOOLS: ReadonlySet<string>`
  - `export interface DebugHost { debugSessions(): DebugSessionSummary[]; debugSession(id: string, historyLimit?: number): Promise<DebugSessionDetail>; setCliDebug(id: string, body: { cliDebug?: boolean | null }): Promise<unknown>; send(id: string, text: string): void }`
    — note `send` is **synchronous** on `SessionManager` (`send(id, text): SentUserMessage`, verified at `server/session-manager.ts:2483`; `SentUserMessage` is module-private, and TS's void-return assignability rule lets the sync, value-returning method satisfy this `void` signature). `setCliDebug` and `debugSession` are async.
  - `export function buildDebugTools(host: DebugHost): SdkMcpToolDefinition<any>[]`
  - `export function createDebugAppTools(host: DebugHost): FirstPartyToolServer`

- [ ] **Step 1: Write the failing test**

Create `server/sdk-tools/app-debug.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { metrics } from '../metrics.js'
import { createLogger, disableLogRing, enableLogRing, setLogConfig } from '../log.js'
import type { DebugSessionDetail, DebugSessionSummary } from '../session-types.js'
import {
  DEBUG_READ_ONLY_TOOLS,
  DEBUG_TOOLS_SERVER_NAME,
  buildDebugTools,
  createDebugAppTools,
  type DebugHost,
} from './app-debug.js'

function summary(over: Partial<DebugSessionSummary> = {}): DebugSessionSummary {
  return {
    id: 's1',
    phase: 'live',
    running: true,
    terminated: false,
    subscribers: 1,
    messageCount: 0,
    pendingTurns: 0,
    pendingPermissions: 0,
    queuedInputs: 0,
    ...over,
  }
}

function detail(): DebugSessionDetail {
  return { ...summary(), historyTail: [], withdrawnUuids: [], promptUuids: [], tasks: [], cli: { cliDebug: { global: false, effective: false }, stderrTail: [], debugLog: { exists: false } }, toolServers: [], contextUsage: null }
}

const host = vi.hoisted(() => ({
  debugSessions: vi.fn(),
  debugSession: vi.fn(),
  setCliDebug: vi.fn(),
  send: vi.fn(),
}))

// Resolve the tool by bare name, then call its handler. The arity matches
// server/sdk-tools/app-tools.test.ts: `handler(input, undefined)`.
function callTool(name: string, input: unknown) {
  const def = buildDebugTools(host as unknown as DebugHost).find((t) => t.name === name)
  if (!def) throw new Error(`no such tool: ${name}`)
  return def.handler(input as never, undefined)
}

const firstText = (r: { content?: Array<{ type: string; text?: string }> }) =>
  r.content?.find((c) => c.type === 'text')?.text ?? ''

beforeEach(() => {
  vi.clearAllMocks()
  metrics.reset()
  disableLogRing()
  setLogConfig({ level: 'info', scopes: null })
  host.debugSessions.mockReturnValue([summary()])
  host.debugSession.mockResolvedValue(detail())
  host.setCliDebug.mockResolvedValue({ ok: true })
  host.send.mockReturnValue(undefined)
})

describe('appdebug tool surface', () => {
  it('exposes exactly the 7 declared tools', () => {
    expect(buildDebugTools(host as unknown as DebugHost).map((t) => t.name)).toEqual([
      'logs', 'metrics', 'sessions', 'session', 'set_log', 'set_cli_debug', 'send_message',
    ])
  })

  it('declares exactly the 4 read tools read-only, and they carry the annotation', () => {
    expect([...DEBUG_READ_ONLY_TOOLS].sort()).toEqual(['logs', 'metrics', 'session', 'sessions'])
    const tools = buildDebugTools(host as unknown as DebugHost)
    for (const readOnlyName of ['logs', 'metrics', 'sessions', 'session']) {
      expect(tools.find((t) => t.name === readOnlyName)!.annotations?.readOnlyHint).toBe(true)
    }
    for (const writeName of ['set_log', 'set_cli_debug', 'send_message']) {
      expect(tools.find((t) => t.name === writeName)!.annotations?.readOnlyHint ?? false).toBe(false)
    }
  })

  it('builds a cwd-independent server that has no mutating tools', () => {
    const server = createDebugAppTools(host as unknown as DebugHost)
    expect(server.name).toBe(DEBUG_TOOLS_SERVER_NAME)
    expect(server.requiresCwd).toBe(false)
    expect(server.defaultEnabled).toBe(true)
    expect(server.mutatingToolNames).toBeUndefined()
    expect(server.buildTools(null).map((t) => t.name)).toHaveLength(7)
  })
})

describe('logs', () => {
  it('returns the ring tail with the current level config and file-logging state', async () => {
    enableLogRing(10)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    createLogger('pump').info('tick')
    spy.mockRestore()

    const res = await callTool('logs', {})
    const body = JSON.parse(firstText(res))
    expect(body.ringEnabled).toBe(true)
    expect(body.ringLines).toBe(1)
    expect(body.level).toBe('info')
    expect(body.fileLogging.enabled).toBe(false)
    expect(body.lines).toEqual([{ ts: expect.any(Number), level: 'info', scope: 'pump', msg: 'tick' }])
  })

  it('passes every filter through to the ring', async () => {
    enableLogRing(10)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    createLogger('pump').info('alpha')
    createLogger('ws').info('beta')
    spy.mockRestore()

    const body = JSON.parse(firstText(await callTool('logs', { scope: 'ws', grep: 'BET', limit: 5 })))
    expect(body.lines.map((l: { msg: string }) => l.msg)).toEqual(['beta'])
  })

  it('reports an empty ring without erroring when the ring is disabled', async () => {
    const res = await callTool('logs', {})
    expect(res.isError).toBeFalsy()
    const body = JSON.parse(firstText(res))
    expect(body.ringEnabled).toBe(false)
    expect(body.lines).toEqual([])
  })
})

describe('metrics', () => {
  it('returns the full snapshot, and filters by series substring', async () => {
    metrics.observe('http_request_ms', 10, { route: 'GET /api/x' })
    metrics.count('ws_frames_sent', { kind: 'message' }, 3)
    metrics.gauge('sessions_active', 2)

    const full = JSON.parse(firstText(await callTool('metrics', {})))
    expect(full.histograms.http_request_ms).toBeDefined()
    expect(full.counters.ws_frames_sent).toBeDefined()
    expect(full.gauges.sessions_active).toBe(2)

    const narrowed = JSON.parse(firstText(await callTool('metrics', { series: 'ws_' })))
    expect(Object.keys(narrowed.counters)).toEqual(['ws_frames_sent'])
    expect(Object.keys(narrowed.histograms)).toEqual([])
    expect(Object.keys(narrowed.gauges)).toEqual([])
  })
})

describe('sessions / session', () => {
  it('wraps the host overview with process gauges', async () => {
    const body = JSON.parse(firstText(await callTool('sessions', {})))
    expect(body.sessions).toEqual([summary()])
    expect(body.process.pid).toBe(process.pid)
    expect(typeof body.process.rssMb).toBe('number')
  })

  it('forwards the id and history limit to the host', async () => {
    await callTool('session', { id: 's1', history: 5 })
    expect(host.debugSession).toHaveBeenCalledWith('s1', 5)
  })
})

describe('write tools', () => {
  it('set_log forwards level/scopes and echoes the new snapshot', async () => {
    const body = JSON.parse(firstText(await callTool('set_log', { level: 'debug', scopes: ['pump'] })))
    expect(body).toEqual({ level: 'debug', scopes: ['pump'] })
    expect(JSON.parse(firstText(await callTool('set_log', { level: 'warn' }))).scopes).toEqual(['pump'])
  })

  it('set_log with an empty scopes array clears the filter', async () => {
    await callTool('set_log', { scopes: ['pump'] })
    const body = JSON.parse(firstText(await callTool('set_log', { scopes: [] })))
    expect(body.scopes).toBeNull()
  })

  it('set_cli_debug forwards the three-state value', async () => {
    await callTool('set_cli_debug', { sessionId: 's1', cliDebug: null })
    expect(host.setCliDebug).toHaveBeenCalledWith('s1', { cliDebug: null })
  })

  it('send_message forwards the text', async () => {
    const res = await callTool('send_message', { sessionId: 's1', text: 'hi' })
    expect(res.isError).toBeFalsy()
    expect(host.send).toHaveBeenCalledWith('s1', 'hi')
  })
})

describe('error handling', () => {
  it('turns a host rejection into isError instead of throwing', async () => {
    host.debugSession.mockRejectedValue(new Error('no such session'))
    const res = await callTool('session', { id: 'nope' })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe('no such session')
  })

  it('turns a host throw into isError instead of throwing', async () => {
    // send() is synchronous and throws (requireSendable) for an unusable
    // session — a sync throw the async guard wrapper must catch.
    host.send.mockImplementation(() => {
      throw new Error('session is terminated')
    })
    const res = await callTool('send_message', { sessionId: 's1', text: 'hi' })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe('session is terminated')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/sdk-tools/app-debug.test.ts`
Expected: FAIL — cannot resolve `./app-debug.js`.

- [ ] **Step 3: Implement the module**

Create `server/sdk-tools/app-debug.ts`:

```ts
// Dev-only first-party `appdebug` in-process MCP server.
//
// Gives the agent a view of the HOST process it is running inside — the
// in-process log ring, the metrics registry, per-session internals, and three
// permission-gated runtime writes — rather than of the workspace (that is what
// the `apptools` git server is for).
//
// REACHABILITY IS THE SECURITY BOUNDARY: this module is only ever imported by
// `server/dev-mode.ts`, whose `enableDevMode` the CLI calls when the server
// runs from TypeScript source. `firstPartyRegistry.injectAll` only iterates
// REGISTERED servers, so a published `dist/cli.mjs` run cannot expose these
// tools through configuration alone.
//
// Handlers bind a `DebugHost` — a narrow structural slice of SessionManager —
// so this module never touches session internals and tests can pass a fake.
//
// The read tools go into `readOnlyToolNames`, which is the single source
// `permission-broker.ts` consults for its first-party read-only exemption (the
// SDK's own readOnlyHint annotation is not surfaced through canUseTool). The
// write tools are deliberately NOT in that set, so they prompt like any other
// tool. There is no `mutatingToolNames`: nothing here touches the worktree, so
// git-broadcast must not schedule a snapshot for them.

import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { FirstPartyToolServer } from './types.js'
import type { DebugSessionDetail, DebugSessionSummary } from '../session-types.js'
import {
  getLogConfig,
  getLogFilePath,
  isFileLoggingEnabled,
  isLogRingEnabled,
  readLogRing,
  setLogConfig,
  type LogLevel,
} from '../log.js'
import { metrics } from '../metrics.js'

/** Server name — tool FQN is `mcp__appdebug__{name}`. */
export const DEBUG_TOOLS_SERVER_NAME = 'appdebug'

/** Bare read-only tool names. Membership here is what makes the permission
 *  broker auto-approve the call in every mode. */
export const DEBUG_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'logs',
  'metrics',
  'sessions',
  'session',
])

/** The slice of SessionManager the debug tools need. Declared structurally so
 *  `app-debug.ts` stays free of session internals and tests can fake it. */
export interface DebugHost {
  debugSessions(): DebugSessionSummary[]
  debugSession(id: string, historyLimit?: number): Promise<DebugSessionDetail>
  setCliDebug(id: string, body: { cliDebug?: boolean | null }): Promise<unknown>
  /** SYNCHRONOUS on SessionManager (`send(id, text): SentUserMessage`) — it
   *  throws synchronously via requireSendable for an unknown/unusable session.
   *  `SentUserMessage` is module-private there, and a sync value-returning
   *  method is assignable to this `void` signature. */
  send(id: string, text: string): void
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function err(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Run a handler so no failure can reject the MCP call (a rejection hangs the
 *  turn); every error becomes an `isError` text result instead. */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

/** Pretty-printed JSON result — what every read tool returns. */
function json(value: unknown): CallToolResult {
  return ok(JSON.stringify(value, null, 2))
}

const LEVEL = z.enum(['error', 'warn', 'info', 'debug', 'trace'])

function processInfo(): { pid: number; uptimeSec: number; rssMb: number; nodeVersion: string } {
  return {
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    nodeVersion: process.version,
  }
}

/** Substring-filter the keyed maps of a metrics snapshot. */
function pickSeries<T>(o: Record<string, T>, needle: string): Record<string, T> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k.includes(needle)))
}

/** The tool definitions for the appdebug server, bound to the host. Exported
 *  separately from the server factory so tests can assert the tool set /
 *  annotations and invoke handlers without owning an McpServer. */
export function buildDebugTools(host: DebugHost): SdkMcpToolDefinition<any>[] {
  const readOnly = { readOnlyHint: true }
  return [
    tool(
      'logs',
      'Read the server process log ring buffer (in-memory, dev only). Filters are ANDed and limit keeps the NEWEST N. level means "at least this severe"; scope is an exact logger-scope match; since is ts>=; grep is case-insensitive on the message. Also reports the current level/scopes and whether file logging is on (with its path, for older history).',
      {
        level: LEVEL.optional(),
        scope: z.string().optional(),
        since: z.number().optional(),
        grep: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      async (a) =>
        guard(async () => {
          const { lines, total, dropped } = readLogRing({
            level: a.level as LogLevel | undefined,
            scope: a.scope,
            since: a.since,
            grep: a.grep,
            limit: a.limit ?? 200,
          })
          return json({
            ...getLogConfig(),
            fileLogging: { enabled: isFileLoggingEnabled(), path: getLogFilePath() ?? undefined },
            ringEnabled: isLogRingEnabled(),
            ringLines: total,
            dropped,
            lines,
          })
        }),
      { annotations: readOnly },
    ),
    tool(
      'metrics',
      'Read the in-process metrics registry snapshot: uptime, gauges, counters, and histograms (p50/p95/p99/max). Optional series is a case-sensitive substring filter over metric names.',
      { series: z.string().optional() },
      async (a) =>
        guard(async () => {
          const snap = metrics.snapshot()
          if (!a.series) return json(snap)
          return json({
            ...snap,
            gauges: pickSeries(snap.gauges, a.series),
            counters: pickSeries(snap.counters, a.series),
            histograms: pickSeries(snap.histograms, a.series),
          })
        }),
      { annotations: readOnly },
    ),
    tool(
      'sessions',
      'List every session in the server pool (live and hibernated) with lifecycle, pending counters, queued input count, and background tasks, plus process gauges.',
      {},
      async () => guard(async () => json({ sessions: host.debugSessions(), process: processInfo() })),
      { annotations: readOnly },
    ),
    tool(
      'session',
      'Deep-dive one session: the overview fields plus history-tail routing metadata (no message bodies), withdrawn/prompt uuids, the task table, CLI diagnostics, first-party tool server status, and context usage.',
      { id: z.string(), history: z.number().int().min(0).max(200).optional() },
      async (a) => guard(async () => json(await host.debugSession(a.id, a.history))),
      { annotations: readOnly },
    ),
    tool(
      'set_log',
      'Change the server log level and/or scope filter at runtime. Omit a key to leave it unchanged; scopes: [] clears the filter (server-wide, not per session).',
      { level: LEVEL.optional(), scopes: z.array(z.string()).optional() },
      async (a) => guard(async () => json(setLogConfig({ level: a.level as LogLevel | undefined, scopes: a.scopes }))),
    ),
    tool(
      'set_cli_debug',
      'Toggle per-session CLI debug logging (captures the claude subprocess stderr for that session). null clears the per-session override and re-inherits the global value. Applies on the next session start.',
      { sessionId: z.string(), cliDebug: z.boolean().nullable() },
      async (a) => guard(async () => json(await host.setCliDebug(a.sessionId, { cliDebug: a.cliDebug }))),
    ),
    tool(
      'send_message',
      'Send a user message into a session (any session, not just the caller). The full path of POST /sessions/:id/messages — use it to drive a reproduction.',
      { sessionId: z.string(), text: z.string() },
      async (a) =>
        guard(async () => {
          host.send(a.sessionId, a.text)
          return ok(`sent ${a.text.length} char(s) to ${a.sessionId}`)
        }),
    ),
  ]
}

/** Build the appdebug first-party server bound to a host. `requiresCwd` is
 *  false because these tools inspect the process, not a workspace. */
export function createDebugAppTools(host: DebugHost): FirstPartyToolServer {
  return {
    name: DEBUG_TOOLS_SERVER_NAME,
    description: 'Dev-only host introspection tools (logs, metrics, session internals)',
    defaultEnabled: true,
    requiresCwd: false,
    buildTools: () => buildDebugTools(host),
    readOnlyToolNames: DEBUG_READ_ONLY_TOOLS,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/sdk-tools/app-debug.test.ts`
Expected: PASS (all blocks). The handler arity (`handler(input, undefined)`) and the `def.annotations?.readOnlyHint` access are the ones already used in `server/sdk-tools/app-tools.test.ts`; both typecheck today, so no further adjustment should be needed.

- [ ] **Step 5: Commit**

```bash
git add server/sdk-tools/app-debug.ts server/sdk-tools/app-debug.test.ts
git commit -m "feat(sdk-tools): add the dev-only appdebug tool definitions

Seven tools over a narrow DebugHost: four read-only (logs, metrics,
sessions, session) and three permission-gated writes (set_log,
set_cli_debug, send_message). Read tools join readOnlyToolNames, the source
the permission broker consults for its first-party exemption; there is no
mutatingToolNames because nothing here touches the worktree.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: `enableDevMode` wiring function

**Files:**
- Modify: `server/dev-mode.ts` (append)
- Test: `server/dev-mode.test.ts` (append)

**Interfaces:**
- Consumes: `enableLogRing` / `isLogRingEnabled` (Task 1); `createDebugAppTools`, `DEBUG_TOOLS_SERVER_NAME`, `DebugHost` (Task 4); `FirstPartyToolRegistry` (`register`, `get`, `list`).
- Produces: `export interface DevModeDeps { registry: FirstPartyToolRegistry; sm: DebugHost; ringCapacity?: number }` and `export function enableDevMode(deps: DevModeDeps): void` (idempotent).

- [ ] **Step 1: Write the failing test**

Append to `server/dev-mode.test.ts`, and **replace that file's header imports** (the two lines Task 2 wrote) with the block below — the new cases need `afterEach`, the registry, the appdebug constant, and the ring accessors:

```ts
describe('enableDevMode', () => {
  afterEach(() => disableLogRing())

  it('enables the ring and registers the appdebug server', () => {
    const registry = new FirstPartyToolRegistry()
    enableDevMode({ registry, sm: fakeHost(), ringCapacity: 7 })
    expect(isLogRingEnabled()).toBe(true)
    expect(registry.get(DEBUG_TOOLS_SERVER_NAME)?.name).toBe(DEBUG_TOOLS_SERVER_NAME)
    expect(registry.list()).toHaveLength(1)
  })

  it('registers the 4 read tools as read-only and injects with no cwd', () => {
    const registry = new FirstPartyToolRegistry()
    enableDevMode({ registry, sm: fakeHost() })
    const server = registry.get(DEBUG_TOOLS_SERVER_NAME)!
    expect([...server.readOnlyToolNames!].sort()).toEqual(['logs', 'metrics', 'session', 'sessions'])
    // requiresCwd:false → injected even without a cwd.
    const injected = registry.injectAll(null, (n) => n === DEBUG_TOOLS_SERVER_NAME)
    expect(Object.keys(injected ?? {})).toEqual([DEBUG_TOOLS_SERVER_NAME])
  })

  it('is idempotent — a second call does not re-register', () => {
    const registry = new FirstPartyToolRegistry()
    enableDevMode({ registry, sm: fakeHost() })
    expect(() => enableDevMode({ registry, sm: fakeHost() })).not.toThrow()
    expect(registry.list()).toHaveLength(1)
  })
})
```

New header for `server/dev-mode.test.ts` (replacing Task 2's two import lines) plus a host factory:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDevRuntime, enableDevMode } from './dev-mode.js'
import { FirstPartyToolRegistry } from './sdk-tools/registry.js'
import { DEBUG_TOOLS_SERVER_NAME, type DebugHost } from './sdk-tools/app-debug.js'
import { disableLogRing, isLogRingEnabled } from './log.js'

/** A DebugHost whose methods are never called by these assertions. */
function fakeHost(): DebugHost {
  return {
    debugSessions: vi.fn(() => []),
    debugSession: vi.fn(async () => ({}) as never),
    setCliDebug: vi.fn(async () => ({})),
    send: vi.fn(async () => {}),
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/dev-mode.test.ts -t 'enableDevMode'`
Expected: FAIL — `enableDevMode is not a function`.

- [ ] **Step 3: Implement `enableDevMode`**

Append to `server/dev-mode.ts` — imports first (Task 2 deliberately left the file import-free; the linter rejects unused bindings, so they arrive with the code that uses them):

```ts
import { createLogger, enableLogRing } from './log.js'
import { createDebugAppTools, DEBUG_TOOLS_SERVER_NAME, type DebugHost } from './sdk-tools/app-debug.js'
import type { FirstPartyToolRegistry } from './sdk-tools/registry.js'

const log = createLogger('dev-mode')

export interface DevModeDeps {
  /** Injected rather than importing the singleton so tests can pass a fresh
   *  registry — that avoids adding a test-only `unregister` to production. */
  registry: FirstPartyToolRegistry
  sm: DebugHost
  /** Log-ring capacity; defaults to 1000 lines. */
  ringCapacity?: number
}

/** Turn on dev mode: start the log ring and register the `appdebug` server.
 *  Idempotent — the registry rejects duplicate names, so re-entry is guarded.
 *
 *  Call this BEFORE any session spawns; sessions already running pick the
 *  server up through the existing per-session first-party toggle (which
 *  re-runs injection), and dormant ones at their next spawn. */
export function enableDevMode(deps: DevModeDeps): void {
  enableLogRing(deps.ringCapacity ?? 1000)
  if (deps.registry.get(DEBUG_TOOLS_SERVER_NAME) !== undefined) return
  deps.registry.register(createDebugAppTools(deps.sm))
  log.info(
    `registered ${DEBUG_TOOLS_SERVER_NAME} (dev runtime) — ` +
      'read-only: logs, metrics, sessions, session; writes prompt for permission',
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/dev-mode.test.ts`
Expected: PASS (10 tests total in the file).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/dev-mode.ts server/dev-mode.test.ts
git commit -m "feat(dev-mode): wire the log ring and appdebug registration

enableDevMode takes the registry as a dependency so tests use a fresh one
instead of needing a test-only unregister. Idempotent.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: `--dev` / `--no-dev` CLI flags

**Files:**
- Modify: `server/cli/args.ts` (`CliArgs`, `parseServerArgs`, `HELP`)
- Test: `server/cli/args.test.ts` *(create — `parseServerArgs` has no test file today)*

**Interfaces:**
- Produces: `CliArgs.dev?: boolean` (`undefined` = auto-detect, `true` = force on, `false` = force off).

- [ ] **Step 1: Write the failing test**

Create `server/cli/args.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseServerArgs } from './args.js'

describe('parseServerArgs --dev / --no-dev', () => {
  it('leaves dev undefined when neither flag is given (auto-detect)', () => {
    expect(parseServerArgs([]).dev).toBeUndefined()
  })

  it('sets dev true for --dev', () => {
    expect(parseServerArgs(['--dev']).dev).toBe(true)
  })

  it('sets dev false for --no-dev', () => {
    expect(parseServerArgs(['--no-dev']).dev).toBe(false)
  })

  it('lets a later flag win', () => {
    expect(parseServerArgs(['--dev', '--no-dev']).dev).toBe(false)
  })

  it('does not disturb the existing flags', () => {
    const args = parseServerArgs(['--dev', '-p', '4000', '--no-open'])
    expect(args).toMatchObject({ dev: true, port: 4000, open: false })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/cli/args.test.ts`
Expected: FAIL — `dev` is `undefined` for the `--dev` cases.

- [ ] **Step 3: Implement the flags**

In `server/cli/args.ts`:

1. Add to `CliArgs` (after `safeMode`):
```ts
  /** `--dev` / `--no-dev`. undefined = auto-detect from the entry module
   *  (see server/dev-mode.ts `isDevRuntime`). true/false force it. */
  dev?: boolean
```

2. Add to the `switch` in `parseServerArgs` (after the `--safe-mode` case):
```ts
      case '--dev':
        args.dev = true
        break
      case '--no-dev':
        args.dev = false
        break
```

3. Add to `HELP` after the `--safe-mode`-adjacent option block (keep the existing 2-space / aligned style; insert before `-V, --version`):
```
      --dev            Register the dev-only `appdebug` introspection tools
                       (logs, metrics, session internals). Default: auto —
                       on when the server runs from TypeScript source
                       (npm run dev / dev:server), off for dist/cli.mjs.
      --no-dev         Force the dev tools off even when running from source.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/cli/args.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/cli/args.ts server/cli/args.test.ts
git commit -m "feat(cli): add --dev/--no-dev to force the dev tools on or off

undefined means auto-detect from the entry module; the flags exist for the
cases detection cannot cover, e.g. debugging a built dist/cli.mjs.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Wire it into the server boot + end-to-end verification

**Files:**
- Modify: `server/cli.ts`

**Interfaces:**
- Consumes: `isDevRuntime`, `enableDevMode` (Tasks 2/5); `firstPartyRegistry` (`server/sdk-tools/registry.ts`); `args.dev` (Task 6); the already-constructed `sessionManager`.

- [ ] **Step 1: Add the imports**

In `server/cli.ts`, beside the other local imports:

```ts
import { enableDevMode, isDevRuntime } from './dev-mode.js'
import { firstPartyRegistry } from './sdk-tools/registry.js'
```

- [ ] **Step 2: Add the wiring**

In `runServer`, immediately after `const sessionManager = new SessionManager({ … })` and before the upload-store backfill (so registration precedes any spawn):

```ts
  // Dev-only introspection tools. Registration is the security boundary: the
  // registry is only iterated for sessions that spawn after this point, and a
  // published dist/cli.mjs run never reaches this branch (see isDevRuntime).
  // --dev / --no-dev override detection for the cases it cannot cover.
  if (args.dev ?? isDevRuntime(process.argv[1], process.env)) {
    enableDevMode({ registry: firstPartyRegistry, sm: sessionManager })
  }
```

- [ ] **Step 3: Typecheck, lint, and run the full suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green. `npm run test` must show the pre-existing suites unaffected — in particular `server/sdk-tools/registry.test.ts`'s "the singleton registers the git apptools server" and "the singleton lists the 15 apptools tools, 4 of them read-only" assertions (they read the SINGLETON, which Task 7 does not touch at module load — registration only happens at boot).

- [ ] **Step 4: Build and confirm the bundle still works**

Run: `npm run build`
Expected: `dist/client` + `dist/cli.mjs` produced with no esbuild error. `server/dev-mode.ts` and `server/sdk-tools/app-debug.ts` are bundled into `dist/cli.mjs`; they are inert unless `isDevRuntime` is true.

- [ ] **Step 5: End-to-end verification — dev run exposes the tools**

```bash
npm run dev:server
```

Then, with the server up, from a second shell:

```bash
# The tools are listed for the first-party registry...
curl -s http://127.0.0.1:3456/api/first-party-tools | grep -o 'appdebug'
```

Expected: `appdebug` appears, with 7 tools (4 marked `"readOnly":true`).

Then in the app UI: create a session whose cwd is this repo, and confirm the agent can call `mcp__appdebug__logs` / `mcp__appdebug__sessions` **without a permission card**, and that `mcp__appdebug__set_log` **does** raise a permission card. Verify the SettingsPanel → MCP tab shows an `appdebug` section with a toggle and 7 tools (no UI code was changed).

Close-loop check: ask the agent to call `set_log` with `{"level":"debug","scopes":["pump"]}`, then `logs` with `{"scope":"pump"}` and confirm real server log lines come back.

- [ ] **Step 6: End-to-end verification — the published path does NOT**

```bash
npm run build && node dist/cli.mjs --port 3457 --no-open
```

From a second shell:

```bash
curl -s http://127.0.0.1:3457/api/first-party-tools | grep -c appdebug   # expect 0
```

Expected: `0` — no match. Also confirm the boot log does **not** contain `dev-mode` registering anything.

- [ ] **Step 7: End-to-end verification — the override flags**

```bash
npm run dev:server -- --no-dev      # → appdebug absent
npm run start -- --dev              # → appdebug present (needs the Step 4 build)
```

- [ ] **Step 8: Commit**

```bash
git add server/cli.ts
git commit -m "feat(cli): register the dev-only appdebug tools from source runs

Wires enableDevMode behind args.dev ?? isDevRuntime(...), so the tools exist
for npm run dev/dev:server (or an explicit --dev) and never for a published
dist/cli.mjs run.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:

| Spec section | Task |
|---|---|
| 关键决策 1 (separate `appdebug` server, `requiresCwd:false`, zero UI change) | 4 (server shape), 5 (`injectAll(null, …)` assertion) |
| 关键决策 2/3 (`isDevRuntime`, no `NODE_ENV`) | 2 |
| 关键决策 4 (ring captures after `passes()`) | 1 (dedicated regression test) |
| 关键决策 5 (read tools exempt, writes prompt) | 4 (`readOnlyToolNames` + annotation assertions) |
| 关键决策 6/7 (closure DI, internals stay in the manager) | 3, 4 |
| 工具集 (7 tools, all params/returns) | 4 |
| `logs` 过滤语义 | 1 (5 filter tests) + 4 (pass-through test) |
| `DebugSessionSummary` / `Detail` field lists | 3 |
| `log.ts` ring API + 4096 truncation | 1 |
| `enableDevMode` idempotence + DI | 5 |
| `cli/args.ts` flags + HELP | 6 |
| `cli.ts` wiring | 7 |
| 配置/开关链 (no new config field) | 7 Step 3 (registry singleton assertions unchanged) + no task adds config |
| 错误处理 (guard, dormant → null, bounded output) | 3 (`contextUsageOrNull`), 4 (`guard` + limit caps) |
| 非目标 (no follow/restart/UI change) | enforced by task file lists — no client file is touched |
| 测试 (all three named test files) | 1, 2+5, 3, 4, 6 |
| 验收 (dev exposes / dist absent / flags / UI auto / closed loop) | 7 Steps 5–7 |

**Placeholder scan:** no TBD/TODO; every code step carries the real code; every command step carries the exact command and expected result.

**Type consistency:** `isDevRuntime(argv1, env)` (explicit params, Task 2) ↔ call site in Task 7 (`isDevRuntime(process.argv[1], process.env)`). `DebugHost.debugSession(id, historyLimit?)` returns a Promise (Task 4 interface) ↔ `SessionManager.debugSession(id, historyLimit = 30): Promise<DebugSessionDetail>` (Task 3) ↔ `await this.getDiagnostics(id)` is async, which is why the method is async. `DEBUG_TOOLS_SERVER_NAME` is defined once in Task 4 and imported (never re-declared) in Tasks 5 and 6's tests. `readLogRing` returns `{ lines, total, dropped }` (Task 1) ↔ the `logs` handler maps `total` → `ringLines` (Task 4). `LogRingLine` = `{ ts, level, scope, msg }` throughout.