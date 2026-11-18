# Native MCP Host-Global Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut native-provider external stdio MCP child processes from N×M (per session) to M (shared) via a host-global refcounted connection registry, DSH-style.

**Architecture:** A `SharedRegistry` (owned by the one `NativeProvider` per host) holds one `SharedRecord` per distinct stdio config identity (command+args+env), refcounted by session views. `NativeMcpConnections` becomes a per-session view: stdio entries delegate to shared records; `sdk`/`sse`/`http` stay local. Records get bounded-backoff auto-reconnect with two-phase outage (fail-fast during retry, unregister on give-up), and fail-closed cleanup with a death-confirmation-gated manual reconnect.

**Tech Stack:** TypeScript / Node ≥ 20 ESM, `@modelcontextprotocol/sdk` Client + StdioClientTransport (`.pid` getter), vitest real-process tests (existing `stdio-server.mjs` fixture), koffi-backed `processIdentity` (win32-job.ts) for the death gate.

**Spec:** `.agents/notes/proposed/architecture/2026-11-18-native-mcp-sharing.md`

## Global Constraints

- Share **external stdio only**; `sdk` (cwd-bound, in-process) and `sse`/`http` (socket per session) stay per-session, unchanged. Preset plane is a non-goal.
- Sharing key = `JSON.stringify(['stdio', config.command ?? '', config.args ?? [], Object.entries(config.env ?? {}).sort()])` — **includes env**. The view's replace-diff identity (`connections.ts:516-522`) stays **env-excluded**; the two keys are distinct.
- DSH posture: default-on (no flag); one global status per shared record (no per-session projection / retry isolation); refcount-gated sibling-safe teardown via `AbortSignal.any([callerSignal, record.abort.signal])`; **immediate** teardown at users==0 (no idle grace).
- Reconnect: bounded exponential backoff, initial 500 ms, max 30 s, maxAttempts 10; fresh `Client`+transport per attempt; two-phase outage — cached last-good tools stay registered with fail-fast calls during the retry window, **unregister on give-up** (status `failed`) until manual `reconnect(name)`. Reconnect attempts reuse the `pending` status with attempt count in `error` (the five-value status union `connected|failed|needs-auth|pending|disabled` is unchanged).
- Cleanup: bounded close deadline + child-exit confirmation; a hung close sets `cleanupFailed` and blocks **automatic** replacement; manual `reconnect` on a cleanup-failed record is allowed only after `processIdentity(pid)` confirms the child is dead (PID + birth-time identity; reuse `server/win32-job.ts:228`). No app restart needed; never overlap a live child.
- API signatures unchanged: `NativeMcpConnections.load/whenReady/statuses/tools/call/setServers/reconnect/toggle/readResource/closeAll`; `NativeSession` handle methods (`mcpServerStatus/setMcpServers/reconnectMcpServer/toggleMcpServer/readMcpResource`) and the manager route (`session-manager-mcp.ts`) unchanged. `NativeMcpStatus.scope` widens to `'session' | 'global'` (shared records `'global'`, local `'session'`); `source:'sdk'` preserved for first-party.
- `closeAll()` stays abort-first (synchronous record abort before await), idempotent, never throws; a view releases its shared refs and closes only its local records.
- Diagnostics via `createLogger(scope)`; never bare `console.*`. Metrics: `metrics.count(name, labels?, by?)`, `metrics.gauge(name, value)`; finite enum labels only (`shared_mcp_records` gauge, `mcp_shared_acquire`/`mcp_shared_release` counters).
- Tests are real-process: reuse `server/providers/native/mcp/fixtures/stdio-server.mjs` (argv `[byePath, mode?]`, writes `bye` marker on exit/stdin-end), the `waitFor(check, ms, label)` poll helper and `echoServer()` sdk fixture from `connections.test.ts`. New fixture modes specified per task. 15 s test timeouts.
- Commit messages: conventional commits, end with exactly `Co-Authored-By: Claude Code <noreply@anthropic.com>` (commitlint subject-case rejects capital-led subjects; lowercase-led passes).
- Work on a feature branch; run the `code-review` skill on the full branch diff before anything lands on `main`.

## Review Focus

- **PID reuse at the death gate** → a recycled PID must not let a replacement overlap a live child. Pinned in Task 4 (stale-identity refusal test).
- **Late acquirer during outage** → a session acquiring while the server is down must see the cached registered tools, not zero. Pinned in Task 3.
- **Refcount leak on partial failure** → a `createSession` ctor-throw after acquiring must release every acquired ref (no leaked child). Pinned in Task 5 (the `native-provider.ts:300-303` guard path).
- **Double-release** → `toggle(false)` releases a ref; a later `destroy`/`closeAll` must not release it again (no refcount underflow / premature close). Pinned in Task 5.
- **Env-only config change** → sharing key differs (new child) while the replace-diff identity is unchanged (env-excluded); the view must still acquire the new shared record and release the old. Pinned in Task 5.

## File Structure

- Create `server/providers/native/mcp/shared-record.ts` — one shared stdio connection's lifecycle: connect/discover/close/call/readResource, PID capture, cached tools, abort, reconnect supervisor, cleanup deadline + death gate. Plus `sharingKey(config)`.
- Create `server/providers/native/mcp/shared-registry.ts` — host-global `Map<key, SharedRecord>`, refcount acquire/release, immediate teardown at 0, metrics.
- Create `server/providers/native/mcp/shared-record.test.ts`, `shared-registry.test.ts` — real-process pins.
- Modify `server/providers/native/mcp/connections.ts` — view refactor (stdio→shared, sdk/sse/http local), scope widening.
- Modify `server/providers/native/native-provider.ts` — own one `SharedRegistry`, pass to each view; ctor-throw releases refs.
- Modify `server/providers/native/mcp/fixtures/stdio-server.mjs` — add `--crash` and `--ignore-exit` modes.
- Modify `server/providers/native/mcp/connections.test.ts` — scope assertions for shared stdio.
- Modify `server/providers/native/e2e-mcp.test.ts` — manager-level multi-session stdio sharing test.
- Modify client/shared status type if it mirrors `scope` (check `src/types.ts:511` region) — widen `'session'`→`'session'|'global'` only where referenced.
- Task 6: move spec note to `implemented/`, update Related cross-links.

---

### Task 1: SharedRecord lifecycle core + sharing key

**Files:**
- Create: `server/providers/native/mcp/shared-record.ts`, `server/providers/native/mcp/shared-record.test.ts`
- Modify: `server/providers/native/mcp/fixtures/stdio-server.mjs` (add `--crash` mode)

**Interfaces:**
- Consumes: `createMcpTransport` (`server/mcp-config.ts:637`), `NativeMcpServerConfig`/`NativeMcpToolInfo`/`NativeMcpStatus` types (`connections.ts:57-97`), `Client`/`CallToolResultSchema` (SDK), `StdioClientTransport.pid` (SDK stdio.d.ts:72).
- Produces (later tasks import from `./shared-record.js`):

```ts
export function sharingKey(config: NativeMcpServerConfig): string
export interface ReconnectPolicy { enabled: boolean; initialDelayMs: number; maxDelayMs: number; maxAttempts: number }
export interface SharedRecordOptions {
  authFor?: (name: string) => OAuthClientProvider | undefined
  connectTimeoutMs?: number   // default 10_000
  toolTimeoutMs?: number      // default 120_000
  reconnect?: ReconnectPolicy // default {enabled:true, initialDelayMs:500, maxDelayMs:30_000, maxAttempts:10}
  closeTimeoutMs?: number     // default 5_000
}
export class SharedRecord {
  readonly key: string
  readonly config: NativeMcpServerConfig
  users: number                       // managed by the registry (Task 2)
  status: NativeMcpStatus['status']
  error?: string
  serverInfo?: { name: string; version: string }
  tools: NativeMcpToolInfo[]          // currently registered (emptied on give-up)
  cachedTools: NativeMcpToolInfo[]    // last-good discovery, served during outage
  abort: AbortController              // bounds connect + all calls; replaced per connect attempt (mutable)
  readonly ready: Promise<void>       // settles when the INITIAL connect attempt settles; callers await this
  pid: number | null                  // stdio child PID (transport.pid after start)
  cleanupFailed: boolean
  constructor(key: string, config: NativeMcpServerConfig, opts?: SharedRecordOptions)
  connect(): Promise<void>            // connect + discover; never rejects (failure → status failed/needs-auth); sets ready
  callTool(rawName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>
  readResource(uri: string): Promise<unknown>
  close(): Promise<void>              // bounded deadline + child-exit confirm; idempotent; sets cleanupFailed on hung close
}
```

- [ ] **Step 1: Add the `--crash` fixture mode**

In `stdio-server.mjs`, add a mode that completes the initialize handshake then `process.exit(1)` after ~50 ms (so the client connects, discovers tools, then loses the server). Keep the existing `bye` marker writes. Document the mode in a comment.

- [ ] **Step 2: Write the failing tests**

Create `shared-record.test.ts` (real stdio fixture + `waitFor`/`byePath` pattern from `connections.test.ts`):

```ts
it('sharingKey includes env and is order-stable', () => {
  // same command/args, env {A:'1',B:'2'} vs {B:'2',A:'1'} → equal keys
  // env {A:'1'} vs {A:'2'} → different keys
})
it('connect discovers tools and captures the child pid', async () => {
  const rec = new SharedRecord(sharingKey(cfg), cfg)
  await rec.connect()
  expect(rec.status).toBe('connected')
  expect(rec.tools.length).toBeGreaterThan(0)
  expect(rec.cachedTools).toEqual(rec.tools)
  expect(rec.pid).toBeGreaterThan(0)
})
it('callTool returns a result and is sibling-safe under per-call abort', async () => {
  // two concurrent callTool on one record; abort caller A's signal; B resolves; A rejects (ABORTED)
})
it('close kills the stdio child (bye marker) and is idempotent', async () => {
  await rec.connect(); const pid = rec.pid!
  await rec.close(); await rec.close()
  await waitFor(() => existsSync(byePath), 5000, 'child exit')
  expect(processIdentity(pid)).toBeNull()   // win32; on POSIX poll kill(pid,0) throws
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/mcp/shared-record.test.ts`
Expected: FAIL — cannot resolve `./shared-record.js`.

- [ ] **Step 4: Implement `shared-record.ts` (core, no reconnect supervisor yet)**

Port the connect/discover/close logic from `connections.ts` (`connectRecord`/`openConnection`/`raceConnect`/`discoverTools`/`closeServer`/`closeResources`, :336-455) into `SharedRecord`, adapted: after `client.connect(transport)`, capture `this.pid = (transport as StdioClientTransport).pid ?? null` for stdio; on successful discovery set both `tools` and `cachedTools`. `callTool` uses `AbortSignal.any([signal, this.abort.signal])` and the record's `toolTimeoutMs`; if `status !== 'connected'` throw `MCP_SERVER_UNAVAILABLE` (fail-fast). `close()` aborts first, then closes the client under `closeTimeoutMs` (Task 4 adds the death confirmation; here a plain bounded close is enough to pass the bye-marker test). `connect()` exposes its settlement as `ready` (resolved when the initial connect attempt settles, success or failure). `sharingKey` per Global Constraints. Reconnect supervisor is Task 3 — for now a crash leaves `status:'failed'` (no auto-retry).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/mcp/shared-record.test.ts`
Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/mcp/shared-record.ts server/providers/native/mcp/shared-record.test.ts server/providers/native/mcp/fixtures/stdio-server.mjs
git commit -m "feat(native-mcp): SharedRecord stdio lifecycle core and sharing key

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: SharedRegistry refcount + immediate teardown

**Files:**
- Create: `server/providers/native/mcp/shared-registry.ts`, `server/providers/native/mcp/shared-registry.test.ts`

**Interfaces:**
- Consumes: Task 1's `SharedRecord`, `sharingKey`, `SharedRecordOptions`.
- Produces (Task 5 imports from `./shared-registry.js`):

```ts
export class SharedRegistry {
  constructor(opts?: SharedRecordOptions)
  acquire(config: NativeMcpServerConfig): SharedRecord  // key=sharingKey; users++; connect if first; returns the record (await record.ready for initial connect)
  release(record: SharedRecord): Promise<void>          // users--; at 0 close + remove from map
  get(key: string): SharedRecord | undefined
  get size(): number                                     // active record count (metrics gauge)
}
```

- [ ] **Step 1: Write the failing tests**

Create `shared-registry.test.ts` (real stdio fixture; count children by PID):

```ts
it('two acquires of the same config share one child; release semantics', async () => {
  const reg = new SharedRegistry()
  const a = reg.acquire(cfg); const b = reg.acquire(cfg)
  expect(a).toBe(b); expect(a.users).toBe(2); expect(reg.size).toBe(1)
  await a.ready
  const pid = a.pid!
  await reg.release(a)                       // users 1, child alive
  expect(processIdentity(pid)).not.toBeNull()
  await reg.release(b)                       // users 0, child gone
  await waitFor(() => processIdentity(pid) === null, 5000, 'child exit')
  expect(reg.size).toBe(0)
})
it('different env yields separate children', async () => {
  const a = reg.acquire({...cfg, env:{A:'1'}}); const b = reg.acquire({...cfg, env:{A:'2'}})
  expect(a).not.toBe(b); expect(a.pid).not.toBe(b.pid); expect(reg.size).toBe(2)
})
it('acquire counters and gauge track activity', async () => {
  // metrics.snapshot() delta: mcp_shared_acquire +2, mcp_shared_release +2, shared_mcp gauge returns to 0
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/mcp/shared-registry.test.ts`
Expected: FAIL — cannot resolve `./shared-registry.js`.

- [ ] **Step 3: Implement `shared-registry.ts`**

`Map<string, SharedRecord>`; `acquire` computes `sharingKey`, returns existing record (users++) or creates `new SharedRecord(key, config, opts)`, sets users=1, `void record.connect()` (fire-and-forget like `connections.load`; callers await readiness via the record/queue), `metrics.count('mcp_shared_acquire')`, gauge. `release` decrements; at 0 `await record.close()`, delete from map, `metrics.count('mcp_shared_release')`, gauge. Serialize acquire/release on a queue (reuse the `enqueue` pattern) so a release-at-0 cannot race a concurrent acquire of the same key.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/mcp/shared-registry.test.ts`
Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/mcp/shared-registry.ts server/providers/native/mcp/shared-registry.test.ts
git commit -m "feat(native-mcp): host-global SharedRegistry with refcounted acquire/release

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Reconnect supervisor + two-phase outage

**Files:**
- Modify: `server/providers/native/mcp/shared-record.ts`, `shared-record.test.ts`

**Interfaces:**
- Consumes: Task 1 `SharedRecord` core; `ReconnectPolicy` defaults.
- Produces: `SharedRecord.reconnect(): Promise<void>` (manual reconnect; Task 4 adds the death gate); auto-reconnect on crash; `cachedTools` served during outage; `tools` emptied on give-up; `pending` status with attempt count in `error` during retries.

- [ ] **Step 1: Write the failing tests**

Add to `shared-record.test.ts` (use `--crash` fixture; inject a fast `reconnect` policy `{initialDelayMs:20, maxDelayMs:50, maxAttempts:3}` for test speed):

```ts
it('crash rejects in-flight calls, keeps cached tools registered, reconnects with a fresh child', async () => {
  // connect (--crash exits after handshake); await connected; start a long callTool;
  // child crashes → call rejects MCP_CONNECTION_CLOSED; status pending (reconnecting);
  // rec.tools still === cachedTools (registered); a new callTool fails fast MCP_SERVER_UNAVAILABLE;
  // backoff reconnects → status connected, new pid !== old pid
})
it('late acquirer during outage sees cached tools', async () => {
  // while status is pending/failed (outage), rec.tools.length > 0 (cached), callTool fails fast
})
it('give-up unregisters tools and stays failed until manual reconnect', async () => {
  // maxAttempts exhausted → status failed, rec.tools === [] (cachedTools retained);
  // callTool throws MCP_SERVER_UNAVAILABLE; await rec.reconnect() with a healthy fixture → connected, tools restored
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/mcp/shared-record.test.ts`
Expected: FAIL — no auto-reconnect; tools vanish on crash.

- [ ] **Step 3: Implement the reconnect supervisor**

On `client.onclose` (unexpected loss): abort the current generation (rejects in-flight calls with `MCP_CONNECTION_CLOSED`), keep `tools = cachedTools` registered, set `status:'pending'`, schedule bounded-backoff reconnect (`min(maxDelayMs, initialDelayMs * 2**(attempt-1))`), each attempt builds a fresh `Client`+transport (reuse `connect()` internals), `error` carries `reconnecting (attempt n/N)`. On success: `status:'connected'`, refresh `tools`/`cachedTools`, reset attempt budget after sustained uptime. On give-up (attempt > maxAttempts): `tools = []`, `status:'failed'`, stop until manual `reconnect()`. `reconnect()` cancels any pending backoff timer and runs a fresh connect. A `needs-auth` failure does not auto-retry (matches existing semantics).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/mcp/shared-record.test.ts`
Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/mcp/shared-record.ts server/providers/native/mcp/shared-record.test.ts
git commit -m "feat(native-mcp): bounded-backoff reconnect with two-phase outage behavior

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Cleanup deadline + death-confirmation gate + fail-closed

**Files:**
- Modify: `server/providers/native/mcp/shared-record.ts`, `shared-record.test.ts`
- Modify: `server/providers/native/mcp/shared-registry.ts`, `shared-registry.test.ts`
- Modify: `server/providers/native/mcp/fixtures/stdio-server.mjs` (add `--ignore-exit` mode)

**Interfaces:**
- Consumes: `processIdentity` (`server/win32-job.ts:228`), Task 3 `reconnect()`, Task 2 `SharedRegistry`.
- Produces: `close()` detects a hung close via `closeTimeoutMs` + child-exit confirmation and sets `cleanupFailed`; `reconnect()` on a `cleanupFailed` record is refused while `processIdentity(pid)` still resolves (child alive), allowed once it returns null (child dead). `SharedRegistry.release` **retains** a `cleanupFailed` record at users==0 (does not remove it), and `acquire` of that key returns the blocked record without a fresh connect — so automatic replacement is blocked until a death-gated manual `reconnect()` clears `cleanupFailed`.

- [ ] **Step 1: Add the `--ignore-exit` fixture mode**

In `stdio-server.mjs`, add a mode that completes the handshake but ignores stdin `end` and SIGTERM and never exits (stays alive after the client closes stdin) — so `client.close()` cannot reap it and the close deadline trips. (On Windows SIGTERM is a hard terminate, so the mode must also resist the SDK's close path; keep the process alive via an interval and detached stdin handling.) Document it.

- [ ] **Step 2: Write the failing tests**

```ts
it('hung close trips the deadline and sets cleanupFailed', async () => {
  // --ignore-exit fixture; connect; close() with closeTimeoutMs:200 → resolves, cleanupFailed === true, child still alive
})
it('manual reconnect is refused while the child is alive, allowed after confirmed death', async () => {
  // cleanupFailed record with live pid → reconnect() rejects (child alive);
  // kill the child externally; waitFor processIdentity(pid) === null; reconnect() succeeds (fresh healthy fixture config) → connected, cleanupFailed false
})
it('death gate refuses a recycled PID (stale birth-time identity)', async () => {
  // capture birthTime at spawn; simulate reuse by passing a mismatched identity → gate refuses (no replacement overlap)
})
it('registry retains a cleanupFailed record at users==0 and blocks automatic re-acquire', async () => {
  // reg.acquire(cfg) → record; force cleanupFailed (hung close); reg.release(record) → users 0 but reg.get(key) still defined, reg.size 1;
  // reg.acquire(cfg) returns the SAME blocked record (no fresh child, status failed); after death-gated reconnect clears it, acquire connects fresh
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/mcp/shared-record.test.ts server/providers/native/mcp/shared-registry.test.ts`
Expected: FAIL — close has no deadline/confirmation; reconnect not death-gated; release removes cleanupFailed records.

- [ ] **Step 4: Implement cleanup deadline + death gate + registry retention**

`SharedRecord.close()`: abort first; race `client.close()` against `closeTimeoutMs`; after close, confirm child exit by polling `processIdentity(pid)` until null or deadline; if the child is still alive at deadline, set `cleanupFailed = true` (do NOT force-kill automatically — the gate guards replacement). Capture `birthTime = processIdentity(pid)` at connect for the gate. `reconnect()`: if `cleanupFailed`, require `processIdentity(pid) === null` (child confirmed dead) else reject with a clear error; on allowed reconnect, reset `cleanupFailed`. Use `processIdentity` (birth-time identity) so a recycled PID cannot pass the gate.
`SharedRegistry`: `release` at users==0 removes the record ONLY if `!cleanupFailed`; a `cleanupFailed` record is retained (users 0) so it blocks automatic replacement. `acquire` of a key whose record is `cleanupFailed` returns that record (users++) without a fresh connect; it stays failed until a death-gated manual `reconnect()` clears the flag.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/mcp/shared-record.test.ts server/providers/native/mcp/shared-registry.test.ts`
Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/mcp/shared-record.ts server/providers/native/mcp/shared-record.test.ts server/providers/native/mcp/shared-registry.ts server/providers/native/mcp/shared-registry.test.ts server/providers/native/mcp/fixtures/stdio-server.mjs
git commit -m "feat(native-mcp): fail-closed cleanup with death-confirmation-gated reconnect

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: NativeMcpConnections view refactor + provider ownership

**Files:**
- Modify: `server/providers/native/mcp/connections.ts`, `server/providers/native/native-provider.ts`, `server/providers/native/mcp/connections.test.ts`
- Modify: client/shared status type if it mirrors `scope` (`src/types.ts:511` region)

**Interfaces:**
- Consumes: Tasks 1-4 `SharedRegistry`/`SharedRecord`/`sharingKey`; existing `NativeMcpConnections` API; `NativeProvider.authFor` (`native-provider.ts:155`).
- Produces: `NativeMcpConnections` constructor gains an optional `registry?: SharedRegistry` (stdio entries delegate to it; absent → legacy per-session behavior for tests that construct it standalone); `NativeProvider` owns one `SharedRegistry` and passes it to every view; `NativeMcpStatus.scope: 'session' | 'global'`.

- [ ] **Step 1: Write the failing tests**

Update `connections.test.ts` scope assertions (shared stdio → `'global'`, sdk → `'session'`) and add (construct `NativeMcpConnections` with a shared `SharedRegistry`):

```ts
it('two views over one registry share a stdio child; toggle is view-level', async () => {
  // reg = new SharedRegistry(); v1 = new NativeMcpConnections({registry:reg}); v2 = ...
  // v1.load({ext: stdioCfg}); v2.load({ext: stdioCfg}); one child pid;
  // v1.toggle('ext', false) → v1.tools() empty, v2.tools() still has ext, child alive (users 1);
  // v1.closeAll() → child alive (v2 still uses); v2.closeAll() → child gone
})
it('toggle(false) then closeAll does not double-release', async () => {
  // v1.toggle off (release), v1.closeAll() → refcount not underflowed; other view unaffected
})
it('env-only change acquires a new shared child and releases the old', async () => {
  // v1.setServers({ext: {...cfg, env:{A:'2'}}}) → new pid, old child gone, replace-diff identity unchanged but sharing key differs
})
it('statuses label shared stdio global and sdk session', async () => {
  // stdio status.scope === 'global'; sdk status.scope === 'session' && source === 'sdk'
})
```

Add a provider-level test (in `connections.test.ts` or a new `native-provider.mcp.test.ts`): `createSession` ctor-throw after acquire releases refs (no leaked child) — exercise the `native-provider.ts:300-303` guard.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/mcp/connections.test.ts`
Expected: FAIL — no registry delegation; scope still `'session'`.

- [ ] **Step 3: Refactor `connections.ts` into a view**

- Constructor accepts `registry?: SharedRegistry`. Internal entries become a discriminated union: `{ kind:'shared', record: SharedRecord, enabled: boolean }` for stdio when a registry is present, else the existing local `ServerRecord` for sdk/sse/http (and stdio when no registry — legacy path keeps standalone tests working).
- `replaceAll` (`setServers`/`load`): for stdio with registry, acquire new configs / release removed-or-changed (compare by `sharingKey`, NOT the env-excluded replace-diff identity, for the shared mapping); keep the env-excluded identity for the local sdk/sse/http replace-diff. `toggle(false)` releases the shared ref + marks view disabled; `toggle(true)` re-acquires. `reconnect(name)` delegates to `record.reconnect()` (global). `closeAll()` releases all shared refs (abort-first per view) + closes local records; idempotent.
- `statuses()` projects shared record status with `scope:'global'` (local `'session'`); preserve `source:'sdk'` for first-party. `tools()` returns shared `record.tools` (registered) for enabled entries. `call(fqn,…)` resolves the shared record and calls `record.callTool`, keeping the existing text extraction (`textOf`/`capToolText`). `readResource` delegates. `whenReady()` awaits the registry queue + local connects.
- Widen `NativeMcpStatus.scope` to `'session' | 'global'`; update the client/shared mirror only where `scope` is typed.

- [ ] **Step 4: Wire `NativeProvider` ownership**

`NativeProvider` constructs one `SharedRegistry({ authFor: this.authFor })` (lazily, win32-or-any — registry is platform-agnostic; the death gate uses `processIdentity` which degrades on POSIX). Pass it into each `new NativeMcpConnections({ authFor, registry })` at `native-provider.ts:245`. The ctor-throw guard (`:300-303`) must release any refs acquired before the throw (call `mcp.closeAll()` which releases). Ensure the registry lives for the provider lifetime (one per host).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/mcp/connections.test.ts server/providers/native/mcp/tools.test.ts server/providers/native/e2e-mcp.test.ts`
Expected: PASS (existing sdk/sse/http tests unchanged; shared stdio tests green). Then `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/mcp/connections.ts server/providers/native/native-provider.ts server/providers/native/mcp/connections.test.ts src/types.ts
git commit -m "feat(native-mcp): per-session view over the shared registry; provider-owned registry

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Manager-level e2e sharing test, full verify, note lifecycle

**Files:**
- Modify: `server/providers/native/e2e-mcp.test.ts`
- Move: `.agents/notes/proposed/architecture/2026-11-18-native-mcp-sharing.md` → `implemented/`

**Interfaces:**
- Consumes: all prior tasks; `SessionManager` + `NativeProvider` e2e harness (`e2e-mcp.test.ts:164-179`).
- Produces: shipped reality documented.

- [ ] **Step 1: Write the manager-level sharing test**

In `e2e-mcp.test.ts`, add a test creating TWO native sessions via `SessionManager` with the same external stdio `mcpServers` config (real `stdio-server.mjs` fixture), asserting exactly one child PID across both sessions; deleting one session keeps the child; deleting the last reaps it (bye marker / `processIdentity` null). Use the existing fixture + `waitFor` pattern; clean temp dirs in `afterEach`.

- [ ] **Step 2: Run the e2e test**

Run: `npx vitest run server/providers/native/e2e-mcp.test.ts`
Expected: PASS (new sharing test + existing sdk tests).

- [ ] **Step 3: Full verify**

Run: `npm run verify`
Expected: typechecks, lint, verify:agent-notes, full vitest suite, build — all green. (If the pre-existing native/e2e-mcp EBUSY temp-cleanup flake recurs under load, re-run that file focused to confirm it passes in isolation; it is unrelated to this change.)

- [ ] **Step 4: Move the note to implemented**

Rewrite `## Proposal` → present-tense `## Decision`; fold `## Acceptance criteria` + `## Risks` into `## Consequences`; keep `## Alternatives considered` and `## Related`; add a `## Testing` section recording the real-process + e2e evidence; `Status: implemented`. Update Related cross-links if needed. Run `npm run verify:agent-notes`.

- [ ] **Step 5: Whole-branch review, then commit**

Run the `code-review` skill on the full branch diff; fix confirmed findings; re-review non-trivial fixes. Then:

```bash
git add .agents/notes server/providers/native/e2e-mcp.test.ts
git commit -m "test(native-mcp): manager-level sharing e2e; note shipped

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

Merge to main only after the review is clean and the user authorizes (repo rule).
