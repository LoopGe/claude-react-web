# Feishu Bridge — Session Outbound Subscription (Framework Ability) + Independent Feishu Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the App Plugin framework an outbound "session event stream" (`sessions.subscribe`) so a plugin can see a native session's output, land a reusable acceptance fixture in the host repo, then ship a minimal Feishu/Lark bot plugin as an **independent marketplace repo** that bridges a Feishu chat to a native session.

**Architecture:** A host-side `SessionSubscriptionRegistry` wires each plugin's `RpcPeer` into a new per-session `pluginSubscribers` fan-out (mirroring the existing WS `session.subscribers`), pushing already-filtered `SDKMessage`s via `peer.notify('sessions.event', …)`. A plugin subprocess receives those notifications in its own stdio runtime and routes them into a bridge → a Feishu bot replies. Host framework ability + acceptance fixture land in the claude-react-web monorepo (Tasks 1–5); the Feishu plugin ships in its own GitHub marketplace repo (Tasks 6–10).

**Tech Stack:** TypeScript (server + plugin); `peer.notify`/RPC via `server/app-plugins/rpc-peer.ts`; `process.execPath` child + newline-delimited JSON-RPC/stdio (child runtime, pattern from `fixtures/app-plugins/_lib/runtime.mjs`); `@larksuiteoapi/node-sdk` (Feishu, in the independent repo), `vitest` (tests); plugin built to ESM `.mjs` service.

**Spec:** `docs/superpowers/specs/2026-09-03-feishu-plugin-session-subscription-design.md`

## Global Constraints

- All diagnostic logging via `createLogger(scope)` from `server/log.ts`; never bare `console.*` for diagnostics (plugin subprocess stderr is captured + rate-limited by the host).
- Permissions use the existing `PermissionChecker`; `sessions.subscribe` requires `sessions.read`. Plugin only gets the **incremental event stream**, never transcript pull or session control.
- Outbound payload re-uses the pump's already-filtered broadcast (`shouldBroadcastMessage`), i.e. it aligns with `BROADCAST_SYSTEM_SUBTYPES`/base frames. Do not invent a second parallel message abstraction.
- v1 default: subscribe starts from "now", **no backfill of transcript history** (spec §3).
- One Feishu chat ⇔ one native session (mapping table), stored in plugin `storage` service.
- v1 scope only: bidirectional **text** + text replies. v2 (out of scope here): card approval, images/files, progress cards, slash commands, group multi-user @, webhook deployment, custom iframe UI.
- **Plugin ownership:** the Feishu plugin is an independent GitHub marketplace repo, NOT this monorepo's official `plugins/`. Host repo only ships the framework ability (Tasks 1–4) + a no-network acceptance fixture (Task 5).
- **Version contract:** plugin manifest `engines.claudeReactWeb` must declare ≥ the host version that introduced `sessions.subscribe`; older hosts reject it.
- Tests are TDD: write the failing test first, run to see it fail, implement, run to see it pass, then commit. Commits review before landing (host-side code must pass the `code-review` skill on the diff per CLAUDE.md).
- Repo tooling (host): `npm run typecheck` runs both tsconfigs; `npm run test` is vitest; server tests under Node. `fixtures/**/*.test.ts` runs under vitest.

---

## File Structure

**Host repo (framework ability + acceptance fixture) — new/changed:**
- Modify `server/session-types.ts` — add `pluginSubscribers` field to `Session`; add it to `endAllSubscribers`.
- Modify `server/session-pump.ts` — fan out to `pluginSubscribers` alongside `subscribers` in the broadcast path.
- Create `server/session-plugin-subscription.ts` — `SessionEventOut` types + `SessionSubscriptionRegistry`.
- Modify `server/app-plugins/host/host-api.ts` — register `sessions.subscribe`, return `subscriptions` from `registerHostApi`.
- Modify `server/app-plugins/host/session-adapter.ts` — thin `subscribe` method delegating to the registry.
- Modify `server/app-plugins/plugin-process.ts` — hold the registry; call `dropPeer` on deactivate/kill.
- Create `fixtures/app-plugins/fixture.session-subscription/` — no-network acceptance fixture consuming `sessions.subscribe`.
- Test files mirroring existing patterns (`host-api.test.ts`, `server/session-pump` fixture conventions).

**Independent plugin repo (Feishu) — new, AI-driven in its own checkout:**
- `feishu.bridge/crw-plugin.json` — manifest (config, commands, status widget). `feishu.bridge/` is the marketplace plugin subdir; the repo root is the marketplace source (auto-scan finds `feishu.bridge/` via its `crw-plugin.json`).
- `feishu.bridge/package.json`, `feishu.bridge/tsconfig.json`.
- `feishu.bridge/src/runtime.ts` — hand-rolled stdio JSON-RPC child runtime (pattern from `fixtures/app-plugins/_lib/runtime.mjs`), includes inbound `sessions.event` dispatch.
- `feishu.bridge/src/main.ts` — plugin entry wires config → bot + bridge + stream; command dispatch; status pushes.
- `feishu.bridge/src/bot.ts` — Feishu long-connection wrapper (`@larksuiteoapi/node-sdk`), receive text + reply text; credentials via `secrets` host calls.
- `feishu.bridge/src/bridge.ts` — mapping table (chat_id↔sessionId) via `storage`; `sessions.send`; allow_chat/groupOnly filtering.
- `feishu.bridge/src/stream.ts` — `sessions.subscribe` + aggregate replied text → `bot` reply.
- `feishu.bridge/src/status.ts` — status indicator data.
- Tests per module (vitest in the independent repo), Feishu SDK stubbed (never real network).

---

## Task 1: Per-session plugin subscriber set + teardown inclusion

**Files:**
- Modify: `server/session-types.ts` (add field to `Session`; add line to `endAllSubscribers`)
- Test: `server/session-plugin-subscription.test.ts` — created in Task 3; for **this** task, create `server/session-types.test.ts` (or extend an existing one if present — grep first) asserting teardown.

**Interfaces:**
- Consumes: existing `Session` interface; existing `Subscriber` type (`{ id, push(msg: SDKMessage), end, closed }`); existing `endAndClear(collection)` helper.
- Produces: `Session.pluginSubscribers: Map<string, Subscriber>`; `endAllSubscribers(s)` now also ends+clears `pluginSubscribers`.

- [ ] **Step 1: Write the failing test**

```ts
// server/session-types.test.ts
import { describe, it, expect, vi } from 'vitest'
import { endAllSubscribers, type Session } from './session-types.js'

function fakeSession(): Session {
  return {
    id: 's1', provider: 'claude', createdAt: 0, lastActivityAt: 0,
    handle: {} as any, pumpTask: Promise.resolve(), running: true, terminated: false,
    subscribers: new Map(), permissionSubscribers: new Map(),
    elicitationSubscribers: new Map(), dialogSubscribers: new Map(),
    contextUsageSubscribers: new Map(), promptSuggestionSubscribers: new Map(),
    taskSubscribers: new Map(), gitStatusSubscribers: new Map(),
    messageStatusSubscribers: new Map(), commandSubscribers: new Map(),
    hookRunSubscribers: new Map(), recapSubscribers: new Map(),
    sessionClearedSubscribers: new Map(),
    pluginSubscribers: new Map(), // the new field — must exist
    pending: new Map(), elicitationPending: new Map(), dialogPending: new Map(),
    history: [], subagentHistory: [],
  } as unknown as Session
}

describe('endAllSubscribers handles pluginSubscribers', () => {
  it('ends and clears the plugin subscriber set', () => {
    const s = fakeSession()
    const end = vi.fn()
    s.pluginSubscribers.set('peer1', { id: 'peer1', push: () => {}, end, closed: false })
    endAllSubscribers(s)
    expect(end).toHaveBeenCalledTimes(1)
    expect(s.pluginSubscribers.size).toBe(0)
  })
})
```

Note: the `Session` type is wide; if the existing test already builds a `fakeSession`, extend it rather than duplicate. If no `server/session-types.test.ts` exists, create it with this fixture.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-types.test.ts`
Expected: FAIL — `Session` type has no `pluginSubscribers` (TS error) and/or `endAllSubscribers` didn't clear it.

- [ ] **Step 3: Implement**

In `server/session-types.ts`, add to the `Session` interface (near `subscribers`, ~line 265):

```ts
/** Plugin outbound-event subscribers (App Plugin `sessions.subscribe`).
 *  Separate from `subscribers` so plugin consumers can't block or be
 *  evicted by browser-tab logic, and so we can end them at teardown
 *  without touching the WS live set. Each entry is owned by a
 *  SessionSubscriptionRegistry and pushes already-filtered SDKMessages. */
pluginSubscribers: Map<string, Subscriber>
```

In `endAllSubscribers` (session-types.ts), add one line after the other subscriber set cleanups:

```ts
endAndClear(s.pluginSubscribers)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/session-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. If TS flags `Session` literal constructions missing the field, add `pluginSubscribers: new Map()` to those fixtures (grep `: Session =` / `as Session`).

- [ ] **Step 6: Commit**

```bash
git add server/session-types.ts server/session-types.test.ts
git commit -m "feat(app-plugins): per-session plugin subscriber set + teardown"
```

---

## Task 2: Pump fans out to plugin subscribers

**Files:**
- Modify: `server/session-pump.ts` (broadcast path ~line 956-960)
- Test: `server/session-pump.test.ts` (extend; grep for existing pump test file — add a case there)

**Interfaces:**
- Consumes: `Session.pluginSubscribers` (Task 1); existing `shouldBroadcastMessage`.
- Produces: pump pushes every broadcastable `SDKMessage` to both `session.subscribers` and `session.pluginSubscribers` (best-effort, exceptions swallowed, mirroring the existing loop's try/catch).

- [ ] **Step 1: Write the failing test**

In the existing pump test file, add a case that runs `pump` against a session with a stubbed provider handle emitting one broadcastable message, with a `pluginSubscribers` entry, and asserts it received the message. Reuse the test's existing session/message fixtures. Minimal shape:

```ts
it('fans broadcastable messages out to pluginSubscribers', async () => {
  const session = makeSession() // existing fixture, now with a pluginSubscribers entry
  const received: SDKMessage[] = []
  session.pluginSubscribers.set('p', { id: 'p', push: (m) => received.push(m), end: () => {}, closed: false })
  await pump(session, makePumpDeps()) // existing deps fixture
  expect(received.some((m) => m.type === 'assistant' || m.type === 'user')).toBe(true)
})
```

If there is no existing `session-pump.test.ts`, follow Task 1's test-file-creation approach with the pump's deps fixture (see `PumpDeps` in `session-pump.ts`, `server/session-pump.test.ts` if present).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-pump.test.ts`
Expected: FAIL — `received` is empty (pump doesn't push to `pluginSubscribers` yet).

- [ ] **Step 3: Implement**

In `server/session-pump.ts`, the broadcast block (currently only `session.subscribers`):

```ts
if (shouldBroadcastMessage(msg as { type?: string; subtype?: string })) {
  for (const sub of session.subscribers.values()) {
    try { sub.push(msg) } catch { /* subscriber dead — don't break broadcast to others */ }
  }
  for (const sub of session.pluginSubscribers.values()) {
    try { sub.push(msg) } catch { /* plugin subscriber dead — skip */ }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/session-pump.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/session-pump.ts server/session-pump.test.ts
git commit -m "feat(app-plugins): pump fans broadcastable messages to plugin subscribers"
```

---

## Task 3: SessionSubscriptionRegistry + event payload types

**Files:**
- Create: `server/session-plugin-subscription.ts`
- Create: `server/session-plugin-subscription.test.ts`

**Interfaces:**
- Consumes: `Session` (`session.pluginSubscribers` from Task 1), `RpcPeer` (`peer.notify(method, params)`, `peer.closed`), the host's `SessionManager` (opaque `{ get(id): Session | undefined }`).
- Produces:
  - `type SessionEventOut` (union: `message` / `session-cleared` / `subscription-ended`).
  - `class SessionSubscriptionRegistry` with:
    - `constructor(opts: { getSession: (id: string) => Session | undefined })`
    - `subscribe(sessionId: string, peer: RpcPeer): { ok: true; unsubscribe: () => void } | { ok: false; error: string }`
    - `dropPeer(peer: RpcPeer): void`
    - `notify(sessionId: string, frame: SessionEventOut): void`

Note: this file **must live server-side** (not `shared/`) because `SessionEventOut` carries an `SDKMessage` which the browser bundle must never import.

- [ ] **Step 1: Write the failing test**

```ts
// server/session-plugin-subscription.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SessionSubscriptionRegistry } from './session-plugin-subscription.js'

function fakePeer(notify = vi.fn()) {
  return { notify, closed: false, id: 'p1' } as any
}

function fakeSession(set: { push: (m: any) => void; end: () => void } | null) {
  return {
    id: 's1',
    pluginSubscribers: set ? new Map([['peerKey', { id: 'peerKey', ...set }]]) : new Map(),
  } as any
}

describe('SessionSubscriptionRegistry', () => {
  it('rejects unknown sessions', () => {
    const r = new SessionSubscriptionRegistry({ getSession: () => undefined })
    expect(r.subscribe('nope', fakePeer())).toMatchObject({ ok: false })
  })

  it('registers a plugin subscriber and notifies it via peer.notify', () => {
    const notify = vi.fn()
    const session = fakeSession(null)
    const r = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    const res = r.subscribe('s1', fakePeer(notify))
    expect(res.ok).toBe(true)
    // subscribe attaches a Subscriber into session.pluginSubscribers; push it manually
    const sub = session.pluginSubscribers.values().next().value
    sub.push({ type: 'assistant' })
    expect(notify).toHaveBeenCalledTimes(1)
    const [method, params] = notify.mock.calls[0]
    expect(method).toBe('sessions.event')
    expect(params.kind).toBe('message')
    expect(params.message.type).toBe('assistant')
  })

  it('dropPeer removes the peer’s subscriptions and ends their subscribers', () => {
    const snapshot = { end: vi.fn(), push: () => {} }
    const session = fakeSession(snapshot)
    const peer = fakePeer()
    const r = new SessionSubscriptionRegistry({ getSession: (id) => (id === 's1' ? session : undefined) })
    const key = r.subscribe('s1', peer)
    expect(key.ok).toBe(true)
    r.dropPeer(peer)
    expect(session.pluginSubscribers.size).toBe(0)
    expect(snapshot.end).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-plugin-subscription.test.ts`
Expected: FAIL — module/class/`kind` don't exist yet.

- [ ] **Step 3: Implement**

```ts
// server/session-plugin-subscription.ts
import type { Session } from './session-types.js'
import type { RpcPeer } from './app-plugins/rpc-peer.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/** Outbound frame pushed host→plugin on a session subscription. Server-only
 *  (carries an SDKMessage). `message` is already filtered by the pump
 *  (shouldBroadcastMessage), so it aligns with BROADCAST_SYSTEM_SUBTYPES/base
 *  frames — deliberately the same content a browser tab's subscribers
 *  fan-out sees. */
export type SessionEventOut =
  | { kind: 'message'; sessionId: string; message: SDKMessage }
  | { kind: 'session-cleared'; sessionId: string }
  | { kind: 'subscription-ended'; sessionId: string; reason: 'session-gone' | 'plugin-disabled' | 'peer-closed' }

/** Routes clock-ticked end() back so we can drop the registration record. */
interface RegistryEntry {
  sessionId: string
  peer: RpcPeer
  release: () => void
}

/** Manages plugin → session outbound subscriptions. One instance per plugin
 *  process's Host API. It manipulates a single session's `pluginSubscribers`
 *  map (Task 1); a Subscriber's `push` forwards the already-filtered message
 *  as a `sessions.event` notification to that plugin's RpcPeer. */
export class SessionSubscriptionRegistry {
  private readonly entries = new Set<RegistryEntry>()

  constructor(private readonly opts: { getSession: (id: string) => Session | undefined }) {}

  subscribe(sessionId: string, peer: RpcPeer): { ok: true; unsubscribe: () => void } | { ok: false; error: string } {
    const session = this.opts.getSession(sessionId)
    if (!session) return { ok: false, error: `session not found: ${sessionId}` }
    if (peer.closed) return { ok: false, error: 'peer is closed' }

    const key = `${peer['id'] ?? 'peer'}:${sessionId}`
    if (session.pluginSubscribers.has(key)) {
      return { ok: true, unsubscribe: () => {} } // idempotent
    }

    let entry: RegistryEntry
    const release = () => {
      if (!session.pluginSubscribers.has(key)) return
      session.pluginSubscribers.get(key)?.end()
      session.pluginSubscribers.delete(key)
      this.entries.delete(entry)
    }
    entry = { sessionId, peer, release }
    this.entries.add(entry)

    session.pluginSubscribers.set(key, {
      id: key,
      closed: false,
      end: () => { this.entries.delete(entry) },
      push: (message: SDKMessage) => {
        this.notify(sessionId, { kind: 'message', sessionId, message })
      },
    })
    return { ok: true, unsubscribe: release }
  }

  /** Remove every subscription belonging to one peer (called by
   *  PluginProcess on deactivate/kill). */
  dropPeer(peer: RpcPeer): void {
    for (const entry of [...this.entries]) {
      if (entry.peer === peer) entry.release()
    }
  }

  /** Push a frame to every peer subscribed to a session. */
  notify(sessionId: string, frame: SessionEventOut): void {
    for (const entry of this.entries) {
      if (entry.sessionId !== sessionId) continue
      try {
        if (!entry.peer.closed) entry.peer.notify('sessions.event', frame)
      } catch { /* peer gone — best-effort */ }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/session-plugin-subscription.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/session-plugin-subscription.ts server/session-plugin-subscription.test.ts
git commit -m "feat(app-plugins): session outbound subscription registry (sessions.event)"
```

---

## Task 4: Host API `sessions.subscribe` + lifecycle wiring

**Files:**
- Modify: `server/app-plugins/host/session-adapter.ts`
- Modify: `server/app-plugins/host/host-api.ts`
- Modify: `server/app-plugins/plugin-process.ts`
- Test: `server/app-plugins/host/host-api.test.ts` (extend)

**Interfaces:**
- Consumes: `SessionSubscriptionRegistry` (Task 3), `PermissionChecker` (`sessions.read`), existing `registerHostApi(peer, ctx)` return shape.
- Produces:
  - `session-adapter.ts`: `subscribe(sessionId): { ok: true; unsubscribe: () => void } | { ok: false; error: string }` gated on `sessions.read`.
  - `registerHostApi` returns an extra key `subscriptions: SessionSubscriptionRegistry` (alongside `storage/secrets/config/checker`).
  - The registry is built in `registerHostApi` with `getSession` over `ctx.sm`.
  - `PluginProcess` holds the registry and calls `subscriptions.dropPeer(this.peer)` in `deactivate` and `kill`.

- [ ] **Step 1: Write the failing test** (extend `host-api.test.ts`)

The test builds a host-api peer with `sm` whose `get` returns a fake session with `pluginSubscribers`; grants `sessions.read`; calls the `sessions.subscribe` handler; asserts `{ ok: true }` and that a subsequent pump-push to `session.pluginSubscribers` produces a `sessions.event` notification on the peer. Mirror the existing host-api test's peer/`callHost` helpers:

```ts
it('sessions.subscribe requires sessions.read and registers a session plugin subscriber', async () => {
  // setup: grant ['sessions.read'], fake session with pluginSubscribers, fake peer
  const result = await callHost('sessions.subscribe', { sessionId: 's1' })
  expect(result.ok).toBe(true)
  const sub = fakeSession.pluginSubscribers.values().next().value
  sub.push({ type: 'assistant' })
  expect(peerNotifications()).toContainEqual(expect.objectContaining({ method: 'sessions.event' }))
})
```

Add a case asserting denial without the grant (extend the existing not-granted assertions to include `sessions.subscribe`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/app-plugins/host/host-api.test.ts`
Expected: FAIL — `sessions.subscribe` not registered.

- [ ] **Step 3: Implement**

`server/app-plugins/host/session-adapter.ts` — build with the peer + registry; add `subscribe`:

```ts
export class SessionAdapter {
  constructor(
    private readonly sm: SessionManager,
    private readonly perm: PermissionChecker,
    private readonly peer: RpcPeer,
    private readonly subscriptions: SessionSubscriptionRegistry,
  ) {}

  // ... existing methods unchanged ...

  /** Subscribe to a session's outbound event stream. Gated on sessions.read. */
  subscribe(sessionId: string): { ok: true; unsubscribe: () => void } | { ok: false; error: string } {
    this.perm.assert('sessions.read')
    return this.subscriptions.subscribe(sessionId, this.peer)
  }
}
```

`server/app-plugins/host/host-api.ts` — build the registry with `getSession` unwrapping the manager, build the adapter with peer + registry, register the handler, return the registry:

```ts
import type { Session } from '../../session-types.js'
import { SessionSubscriptionRegistry } from '../../session-plugin-subscription.js'

const subscriptions = new SessionSubscriptionRegistry({
  getSession: (id) => (ctx.sm as unknown as { get(id: string): Session | undefined }).get(id),
})
const sessions = new SessionAdapter(ctx.sm, checker, peer, subscriptions)
// ...
peer.registerHandler('sessions.subscribe', async (p) => {
  const { sessionId } = requireParams(p, ['sessionId']) as { sessionId: string }
  return sessions.subscribe(sessionId)
})
// ...
return { storage, secrets, config, checker, subscriptions }
```

`server/app-plugins/plugin-process.ts` — hold the registry and drop on teardown:

```ts
const res = registerHostApi(this.peer, { /* existing */ })
this.host = res
this.subscriptions = res.subscriptions
// in deactivate(): this.subscriptions.dropPeer(this.peer) before/around peer.close()
// in kill(): this.subscriptions.dropPeer(this.peer)
```

Add `private subscriptions!: SessionSubscriptionRegistry` field to `PluginProcess`. Fix any construction/tests that assert the exact `registerHostApi` return object (add `subscriptions`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/app-plugins/host/host-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/app-plugins/host/session-adapter.ts server/app-plugins/host/host-api.ts server/app-plugins/plugin-process.ts server/app-plugins/host/host-api.test.ts
git commit -m "feat(app-plugins): sessions.subscribe host api + peer lifecycle cleanup"
```

---

## Task 5: Acceptance fixture — no-network consumer of `sessions.subscribe`

**Files:**
- Create: `fixtures/app-plugins/fixture.session-subscription/crw-plugin.json`
- Create: `fixtures/app-plugins/fixture.session-subscription/dist/service.mjs`
- Create: `fixtures/app-plugins/fixture.session-subscription/src/*` (source, if you keep fixture source in-repo)
- Test: `fixtures/app-plugins/fixture-session-subscription.test.ts` (or extend an existing fixture test — grep first)

**Interfaces:**
- Consumes: `sessions.subscribe` (Host API, Task 4) + the `sessions.event` notification (Task 3). No network. This fixture is how the host repo itself exercises the outbound stream without depending on the independent Feishu plugin.
- Produces: a plugin whose activation calls `sessions.subscribe` on a chosen session, buffers assistant text, and surfaces it via the `app.event` widget path / command result — proving host→plugin outbound delivery end-to-end in CI.

- [ ] **Step 1: Write the failing test**

```ts
// fixtures/app-plugins/fixture-session-subscription.test.ts
import { describe, it, expect } from 'vitest'
// Drive the fixture's service scripts? Follow the existing fixture test
// conventions (see fixtures.test.ts / plugin-runtime.test.ts) — the
// assertion is that a host session event fans out to the child as a
// sessions.event notification the fixture's runtime dispatches to its
// configured handler.
describe('fixture.session-subscription', () => {
  it('routes shared SDKMessage frames to the plugin', () => {
    // Use the host test harness to: activate the fixture with a fake
    // session, subscribe, push an assistant message through
    // session.pluginSubscribers, and assert the child's surfaced result
    // (widget payload or command result) contains the text.
  })
})
```

This test exercises the full host→child path (registry → peer.notify → child runtime dispatch → plugin handler), the "protocol contract test" the spec requires. Reuse whatever harness `plugin-runtime.test.ts` / `fixtures.test.ts` uses to spawn a real child.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run fixtures/app-plugins/fixture-session-subscription.test.ts`
Expected: FAIL — fixture/module missing.

- [ ] **Step 3: Implement**

`fixtures/app-plugins/fixture.session-subscription/crw-plugin.json`:
```json
{
  "manifestVersion": 1,
  "id": "fixture.session-subscription",
  "name": "Fixture: Session Subscription",
  "description": "Framework-verification fixture: subscribes to a session's outbound stream and surfaces assistant text. No network.",
  "version": "1.0.0",
  "publisher": "claude-react-web",
  "license": "MIT",
  "engines": { "claudeReactWeb": "^0.6.0", "node": ">=20" },
  "runtime": { "service": "dist/service.mjs" },
  "activationEvents": ["onStartup"],
  "permissions": ["sessions.read"],
  "contributes": {
    "commands": [
      { "id": "fixture.session-subscription.bind", "title": "Fixture: subscribe to session", "category": "session", "showInPalette": true }
    ]
  }
}
```

`fixtures/app-plugins/fixture.session-subscription/dist/service.mjs` — child runtime (pattern from `fixtures/app-plugins/_lib/runtime.mjs`) that:
- on `activate`, calls host `sessions.list` (to enumerate) and, if a session is bound (via the command or a fixed id), calls `sessions.subscribe { sessionId }`; stores the returned unsubscribe.
- on `sessions.event` notification (`{ kind:'message', sessionId, message }`), accumulates `message.type==='assistant'` text blocks into a buffer.
- on `executeCommand` for `fixture.session-subscription.bind`, returns a `PluginCommandResult` whose `message.text` is the buffered text (the visible proof of deltas) or "subscribed" after wiring.
- on `deactivate`, calls unsubscribe.

Follow `fixtures/app-plugins/_lib/runtime.mjs` and one existing fixture (`fixture.nyan` / `fixture.declarative`) for exact shape (handler map, `callHost`, stdio loop). Source may live under `src/` and be committed as built → `dist/service.mjs`, or hand-author the `.mjs` directly like `fixture.nyan` does; prefer matching the closest existing fixture's convention.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run fixtures/app-plugins/fixture-session-subscription.test.ts`
Expected: PASS — proves the outbound stream reaches a real child.

- [ ] **Step 5: Typecheck + full host suite**

Run: `npm run typecheck && npm run test`
Expected: clean; no regressions.

- [ ] **Step 6: Commit**

```bash
git add fixtures/app-plugins/fixture.session-subscription fixtures/app-plugins/fixture-session-subscription.test.ts
git commit -m "test(fixtures): acceptance fixture for session outbound subscription (sessions.event)"
```

---

## Task 6: Independent plugin repo — scaffold + child runtime

**Files (all inside the independent Feishu repo checkout; "Bridged" here by `feishu.bridge/` as the marketplace plugin subdir at the repo root):**
- Create: `feishu.bridge/crw-plugin.json`
- Create: `feishu.bridge/package.json`
- Create: `feishu.bridge/tsconfig.json`
- Create: `feishu.bridge/app-plugins-marketplace.json` (repo root: catalog listing `feishu.bridge`)
- Create: `feishu.bridge/src/runtime.ts`
- Create: `feishu.bridge/src/main.ts`
- Create: `feishu.bridge/src/runtime.test.ts`

**Interfaces:**
- Consumes: host JSON-RPC contract: `activate` / `executeCommand` / `deactivate` inbound; `sessions.event` inbound notification (Task 4); Host API calls `storage.get/set`, `secrets.read/write`, `config.get`, `sessions.send`, `sessions.subscribe`. Exact JSON-RPC over stdio per `fixtures/app-plugins/_lib/runtime.mjs` (copied into this repo's `runtime.ts`).
- Produces: a plugin entry `src/main.ts` exporting `createPlugin()`. `runtime.ts` exposes `setupRuntime(handlers)` and a pure `dispatchInbound(msg, handlers)`.

- [ ] **Step 1: Write the failing test**

```ts
// feishu.bridge/src/runtime.test.ts
import { describe, it, expect, vi } from 'vitest'
import { dispatchInbound } from './runtime.js'

describe('runtime inbound dispatch', () => {
  it('routes sessions.event notification to the registered handler', () => {
    const onSessionEvent = vi.fn()
    dispatchInbound({ method: 'sessions.event', params: { kind: 'message' } }, { onSessionEvent })
    expect(onSessionEvent).toHaveBeenCalledWith({ kind: 'message' })
  })
  it('ignores notifications with no handler', () => {
    expect(() => dispatchInbound({ method: 'nope', params: {} }, {})).not.toThrow()
  })
})
```

Make `dispatchInbound` a pure, exported function so the stdio loop and tests share one dispatch path.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run feishu.bridge/src/runtime.test.ts`
Expected: FAIL — `dispatchInbound` undefined.

- [ ] **Step 3: Implement**

`feishu.bridge/package.json`:
```json
{
  "name": "feishu-bridge-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc && esbuild src/main.ts --bundle --platform=node --format=esm --outfile=dist/service.mjs --external:@larksuiteoapi/node-sdk",
    "test": "vitest run"
  },
  "dependencies": { "@larksuiteoapi/node-sdk": "^6.0.0" },
  "devDependencies": {
    "typescript": "^5.0.0", "esbuild": "^0.19.0", "vitest": "^1.0.0", "@types/node": "^20.0.0"
  }
}
```

`feishu.bridge/app-plugins-marketplace.json` (repo root):
```json
{
  "name": "Feishu Bridge",
  "plugins": [
    { "id": "feishu.bridge", "dir": "feishu.bridge" }
  ]
}
```

`feishu.bridge/crw-plugin.json`:
```json
{
  "manifestVersion": 1,
  "id": "feishu.bridge",
  "name": "Feishu Bridge",
  "description": "Bridge a Feishu/Lark chat to a native Claude session",
  "version": "0.1.0",
  "publisher": "feishu-bridge",
  "license": "MIT",
  "engines": { "claudeReactWeb": "^0.6.0", "node": ">=20" },
  "runtime": { "service": "dist/service.mjs" },
  "activationEvents": ["onStartup"],
  "permissions": ["sessions.read", "sessions.send", "storage", "secrets.read", "secrets.write"],
  "contributes": {
    "commands": [
      { "id": "feishu.bridge.status", "title": "Feishu Bridge: Status", "category": "global", "icon": "info" }
    ],
    "configuration": {
      "properties": [
        { "key": "feishu.bridge.appId", "type": "string", "title": "Feishu App ID" },
        { "key": "feishu.bridge.appSecret", "type": "string", "title": "Feishu App Secret" },
        { "key": "feishu.bridge.allowChats", "type": "array", "items": "string", "title": "Allowed chat IDs" },
        { "key": "feishu.bridge.groupOnly", "type": "boolean", "title": "Group chat only", "default": false },
        { "key": "feishu.bridge.sessionId", "type": "string", "title": "Default bound native session id" }
      ]
    }
  }
}
```

`feishu.bridge/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "node",
    "esModuleInterop": true, "skipLibCheck": true, "strict": true,
    "outDir": "dist", "types": ["node"]
  },
  "include": ["src/**/*"], "exclude": ["node_modules", "dist"]
}
```

`feishu.bridge/src/runtime.ts` (pure dispatch + stdio loop):
```ts
import readline from 'node:readline'

export interface PluginHandlers {
  activate?: (params: any) => Promise<any>
  executeCommand?: (params: any) => Promise<any>
  deactivate?: (params: any) => Promise<any>
  onSessionEvent: (params: any) => void
}

export function dispatchInbound(msg: any, handlers: PluginHandlers): void {
  if (!msg || typeof msg !== 'object') return
  if ('method' in msg && msg.method === 'sessions.event') {
    handlers.onSessionEvent(msg.params)
  }
}

export interface RpcPlug { callHost: (method: string, params?: any) => Promise<any> }

export function setupRuntime(handlers: PluginHandlers): RpcPlug {
  // stdio JSON-RPC loop (pattern from fixtures/app-plugins/_lib/runtime.mjs).
  // Reads newline-delimited JSON-RPC from stdin, dispatches via
  // dispatchInbound, responds to requests, and provides callHost(). Full
  // implementation here; completes in Task 10 main wiring.
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  let nextId = 1
  const rl = readline.createInterface({ input: process.stdin })
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n')
  const callHost = (method: string, params?: any): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      send({ jsonrpc: '2.0', id, method, params })
    })
  rl.on('line', (line) => {
    let msg: any
    try { msg = JSON.parse(line) } catch { return }
    if (!msg || typeof msg !== 'object') return
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
      return
    }
    if ('method' in msg) {
      if (!('id' in msg)) { dispatchInbound(msg, handlers); return } // notification
      const handler = (handlers as any)[msg.method]
      Promise.resolve(handler ? handler(msg.params) : undefined).then(
        (result) => send({ jsonrpc: '2.0', id: msg.id, result: result ?? null }),
        (err: Error) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } }),
      )
    }
  })
  globalThis.__callHost = callHost
  return { callHost }
}
```

`feishu.bridge/src/main.ts`:
```ts
import { setupRuntime, type PluginHandlers } from './runtime.js'

export function createPlugin(): PluginHandlers {
  return {
    activate: async () => ({ ok: true }),
    executeCommand: async () => ({ kind: 'message', title: 'Feishu Bridge not configured' }),
    deactivate: async () => ({ ok: true }),
    onSessionEvent: () => { /* wired in Task 10 */ },
  }
}

export function main(): void {
  if (process.env.NODE_ENV !== 'test') {
    setupRuntime(createPlugin())
  }
}

if (require.main === module) main()
```

The `require.main === module` guard keeps unit tests from starting the stdio loop.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd feishu.bridge && npx vitest run src/runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `cd feishu.bridge && npm install && npm run build`
Expected: `feishu.bridge/dist/service.mjs` appears (ESM, `--external:@larksuiteoapi/node-sdk`).

- [ ] **Step 6: Commit** (in the independent repo)

```bash
git add feishu.bridge
git commit -m "feat(feishu): independent plugin scaffold + marketplace catalog + child runtime"
```

---

## Task 7: Feishu bot client (receive text, reply text) — stubbed-verifiable

**Files (independent repo):**
- Create: `feishu.bridge/src/bot.ts`
- Create: `feishu.bridge/src/bot.test.ts`

**Interfaces:**
- Consumes: `callHost('secrets.read', { key })`; `@larksuiteoapi/node-sdk` `App`.
- Produces:
  - `interface BridgeMessage { chatId: string; senderId: string; senderName: string; text: string; isGroup: boolean; atBot: boolean }`
  - `class FeishuBot` with `constructor(opts: { appId: string; appSecret: string; allowChats: string[]; groupOnly: boolean; createApp?: (o:any)=>App })`, `start()`, `stop()`, `onMessage?: (m: BridgeMessage) => void`, `replyText(chatId: string, text: string): Promise<void>`.
  - Pure `parseMessageEvent(raw): BridgeMessage | null` and `isAllowed(chatId, allowChats, groupOnly, m): boolean` for tests (SDK interaction stubbed).

- [ ] **Step 1: Write the failing test**

```ts
// feishu.bridge/src/bot.test.ts
import { describe, it, expect } from 'vitest'
import { parseMessageEvent, isAllowed } from './bot.js'

describe('parseMessageEvent', () => {
  it('extracts text + sender from a receive_v1 event', () => {
    const ev = { event: {
      message: { message_id: 'm1', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
      sender: { sender_type: 'user', sender_id: { open_id: 'u1' } },
      chat_id: 'oc_1',
    } }
    expect(parseMessageEvent(ev)).toMatchObject({ chatId: 'oc_1', senderId: 'u1', text: 'hi' })
  })
  it('returns null for bot messages and non-text', () => {
    expect(parseMessageEvent({ event: { sender: { sender_type: 'bot' } } })).toBeNull()
    expect(parseMessageEvent({ event: { message: { message_type: 'image' } } })).toBeNull()
  })
})

describe('isAllowed', () => {
  it('applies allowChats and groupOnly', () => {
    expect(isAllowed('oc_a', ['oc_a'], false, { isGroup: false } as any)).toBe(true)
    expect(isAllowed('oc_b', ['oc_a'], false, { isGroup: false } as any)).toBe(false)
    expect(isAllowed('oc_a', [], true, { isGroup: false } as any)).toBe(false)
    expect(isAllowed('oc_a', [], true, { isGroup: true, atBot: true } as any)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd feishu.bridge && npx vitest run src/bot.test.ts`
Expected: FAIL — `parseMessageEvent` / `isAllowed` undefined.

- [ ] **Step 3: Implement** (`bot.ts`)

```ts
import type { App } from '@larksuiteoapi/node-sdk'

export interface BridgeMessage {
  chatId: string; senderId: string; senderName: string; text: string
  isGroup: boolean; atBot: boolean
}

export function parseMessageEvent(ev: any): BridgeMessage | null {
  const e = ev?.event
  if (!e) return null
  if (e.sender?.sender_type === 'bot') return null
  const msg = e.message
  if (!msg || msg.message_type !== 'text') return null
  let text = ''
  try { text = JSON.parse(msg.content).text ?? '' } catch { text = '' }
  if (!text) return null
  return {
    chatId: e.chat_id ?? '',
    senderId: e.sender?.sender_id?.open_id ?? '',
    senderName: e.sender?.sender_id?.name ?? '',
    text,
    isGroup: String(e.chat_type ?? '') === 'p2p' ? false : true,
    atBot: false,
  }
}

export function isAllowed(chatId: string, allowChats: string[], groupOnly: boolean, m: Pick<BridgeMessage,'isGroup'|'atBot'>): boolean {
  if (allowChats.length > 0 && !allowChats.includes(chatId)) return false
  if (groupOnly && (!m.isGroup || !m.atBot)) return false
  return true
}

export class FeishuBot {
  onMessage?: (m: BridgeMessage) => void
  private app?: App
  private adapter?: any
  constructor(private readonly opts: {
    appId: string; appSecret: string; allowChats: string[]; groupOnly: boolean
    createApp?: (o: { appId: string; appSecret: string }) => App
  }) {}
  async start(): Promise<void> { /* SDK wiring in Task 8; stub throws until then */ }
  async stop(): Promise<void> { /* close */ }
  async replyText(chatId: string, text: string): Promise<void> { /* SDK wiring in Task 8 */ }
}
```

For **this** task, `start`/`replyText` may throw `new Error('not started')` until started; the parsing/filtering surface is complete and tested. Task 8 fills the live SDK wiring behind the same signature.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd feishu.bridge && npx vitest run src/bot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (in the independent repo)

```bash
git add feishu.bridge/src/bot.ts feishu.bridge/src/bot.test.ts
git commit -m "feat(feishu): bot message-parse + allow filters (testable seam)"
```

---

## Task 8: Live Feishu SDK wiring (receive + reply over long connection)

**Files (independent repo):**
- Modify: `feishu.bridge/src/bot.ts` (fill `start`/`replyText`)
- Test: `feishu.bridge/src/bot.sdk.test.ts` — SDK mocked; no real network

**Interfaces:**
- Consumes: `parseMessageEvent`, `isAllowed`, `FeishuBot` shape (Task 7).
- Produces: `FeishuBot.start()` connects the Feishu long connection, routes incoming text to `onMessage` after `isAllowed`; `replyText` sends a text message. Uses the injectable `createApp` factory so tests stub the SDK.

- [ ] **Step 1: Write the failing test** (mock the SDK via injected factory)

Refactor `FeishuBot` to use `this.opts.createApp` (default = real `@larksuiteoapi/node-sdk`). Test injects a stub whose `im.message.create` records calls; asserts `replyText('oc_1','hi')` sends `{ receive_id:'oc_1', msg_type:'text', content: JSON.stringify({text:'hi'}) }`. A second test drives `onMessage` by invoking the registered event callback with a crafted receive_v1 event and asserts the parsed `BridgeMessage` reached it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd feishu.bridge && npx vitest run src/bot.sdk.test.ts`
Expected: FAIL — messages not sent / events not routed.

- [ ] **Step 3: Implement**

In `FeishuBot.start()`: create the app via `createApp`; register a message-receive handler that runs `parseMessageEvent` → `isAllowed` → `this.onMessage`. In `replyText`, call the SDK `im.message.create` with `receive_id_type: 'chat_id'` and text content. Resolve credentials from `callHost('secrets.read', { key: 'feishu.appSecret' })` (the appId/secret also come from `config.get`; `main.ts` passes them in). Exact SDK surface per the installed `@larksuiteoapi/node-sdk` types (verify method names against its typings at implementation time — the seams `app`/`adapter` are untyped `any` in this layer precisely so the SDK version can't propagate).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd feishu.bridge && npx vitest run src/bot.sdk.test.ts`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `cd feishu.bridge && npm run build`
Expected: `dist/service.mjs` builds.

- [ ] **Step 6: Commit** (in the independent repo)

```bash
git add feishu.bridge/src/bot.ts feishu.bridge/src/bot.sdk.test.ts
git commit -m "feat(feishu): live Feishu long-connection receive + reply"
```

---

## Task 9: Bridge (mapping + send) and Stream (subscribe + aggregate)

**Files (independent repo):**
- Create: `feishu.bridge/src/bridge.ts`, `feishu.bridge/src/bridge.test.ts`
- Create: `feishu.bridge/src/stream.ts`, `feishu.bridge/src/stream.test.ts`

**Interfaces:**
- Consumes: `callHost('sessions.send', { sessionId, text })`; `callHost('sessions.subscribe', { sessionId })` returning `{ ok, unsubscribe }`; `callHost('storage.get'/'storage.set')` for the mapping; `BridgeMessage` (Task 7); `sessions.event` payload (Task 3: `{ kind, sessionId, message }`).
- Produces:
  - `bridge.ts`: `class Bridge { constructor(callHost); route(m: BridgeMessage): Promise<string>; getSessionId(chatId); setMapping(chatId, sessionId) }` — `route` returns '' on success or a human error string.
  - `stream.ts`: `class StreamRouter { constructor(callHost, { onReply }); async attach(sessionId); handleSessionEvent(ev); detach() }` — aggregates assistant text; on `kind==='message'` with message `type==='result'`, emits `onReply(trimmedText)`.
  - `chunkText(text, max=4000): string[]` helper for Feishu's per-message length cap.

- [ ] **Step 1: Write the failing tests**

```ts
// feishu.bridge/src/bridge.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Bridge } from './bridge.js'

describe('Bridge.route', () => {
  it('sends a mapped message to the session and returns empty (ok)', async () => {
    const callHost = vi.fn(async (m: string, p: any) => {
      if (m === 'storage.get') return { value: null }
      if (m === 'storage.set') return null
      if (m === 'sessions.send') return null
    })
    const b = new Bridge(callHost as any)
    await b.setMapping('oc_1', 's1')
    const err = await b.route({ chatId: 'oc_1', senderId: 'u1', senderName: 'u', text: 'hi', isGroup: false, atBot: false })
    expect(err).toBe('')
    expect(callHost).toHaveBeenCalledWith('sessions.send', { sessionId: 's1', text: 'hi' })
  })
  it('returns an error string when there is no mapping', async () => {
    const callHost = vi.fn(async () => ({ value: null }))
    const b = new Bridge(callHost as any)
    expect(await b.route({ chatId: 'oc_x', text: 'hi', /* other fields */ } as any)).toMatch(/no session/i)
  })
})
```

```ts
// feishu.bridge/src/stream.test.ts
import { describe, it, expect, vi } from 'vitest'
import { StreamRouter, chunkText } from './stream.js'

describe('StreamRouter', () => {
  it('aggregates assistant text blocks into the reply', async () => {
    const onReply = vi.fn()
    const callHost = vi.fn(async (m: string) => {
      if (m === 'sessions.subscribe') return { ok: true, unsubscribe: () => {} }
    })
    const r = new StreamRouter(callHost as any, { onReply })
    await r.attach('s1')
    r.handleSessionEvent({ kind: 'message', sessionId: 's1', message: { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }] } } })
    r.handleSessionEvent({ kind: 'message', sessionId: 's1', message: { type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } } })
    r.handleSessionEvent({ kind: 'message', sessionId: 's1', message: { type: 'result' } })
    expect(onReply.mock.calls[0][0]).toBe('Hello world')
  })
})

describe('chunkText', () => {
  it('splits long text at Feishu length cap', () => {
    expect(chunkText('x'.repeat(9000), 4000).map((c) => c.length)).toEqual([4000, 4000, 1000])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd feishu.bridge && npx vitest run src/bridge.test.ts src/stream.test.ts`
Expected: FAIL — modules undefined.

- [ ] **Step 3: Implement**

`bridge.ts`:
```ts
import type { BridgeMessage } from './bot.js'

export class Bridge {
  constructor(private readonly callHost: (m: string, p?: any) => Promise<any>) {}
  async getSessionId(chatId: string): Promise<string | null> {
    const r = await this.callHost('storage.get', { scope: 'workspace', key: `mapping:${chatId}` })
    return r?.value ?? null
  }
  async setMapping(chatId: string, sessionId: string): Promise<void> {
    await this.callHost('storage.set', { scope: 'workspace', key: `mapping:${chatId}`, value: sessionId })
  }
  async route(m: BridgeMessage): Promise<string> {
    const sessionId = await this.getSessionId(m.chatId)
    if (!sessionId) return 'No session is bound to this chat. Bind one first.'
    await this.callHost('sessions.send', { sessionId, text: m.text })
    return ''
  }
}
```

`stream.ts`:
```ts
export function chunkText(text: string, max = 4000): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max))
  return out.length ? out : ['']
}

export class StreamRouter {
  private claudeLine = ''
  private unsub: (() => void) | null = null
  constructor(
    private readonly callHost: (m: string, p?: any) => Promise<any>,
    private readonly opts: { onReply: (text: string) => void },
  ) {}
  async attach(sessionId: string): Promise<void> {
    const r = await this.callHost('sessions.subscribe', { sessionId })
    if (!r?.ok) return
    this.unsub = r.unsubscribe
  }
  handleSessionEvent(ev: any): void {
    if (ev?.kind !== 'message') return
    const message = ev.message
    if (message?.type === 'assistant') {
      const content = message.message?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text' && typeof b.text === 'string') this.claudeLine += b.text
        }
      }
    } else if (message?.type === 'result') {
      if (this.claudeLine) {
        this.opts.onReply(this.claudeLine.trim())
        this.claudeLine = ''
      }
    }
  }
  detach(): void { this.unsub?.(); this.unsub = null }
}
```

Progress cards / thinking rendering are v2; v1 assembles only the final reply on `result`. `main.ts` (Task 10) uses `chunkText` before each `replyText`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd feishu.bridge && npx vitest run src/bridge.test.ts src/stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (in the independent repo)

```bash
git add feishu.bridge/src/bridge.ts feishu.bridge/src/bridge.test.ts feishu.bridge/src/stream.ts feishu.bridge/src/stream.test.ts
git commit -m "feat(feishu): bridge mapping + stream subscribe/aggregate"
```

---

## Task 10: Assemble main.ts (config→bot/bridge/stream) + status + README

**Files (independent repo):**
- Modify: `feishu.bridge/src/main.ts` (full wiring via `setupRuntime`)
- Create: `feishu.bridge/src/status.ts`, `feishu.bridge/src/status.test.ts`
- Create: `feishu.bridge/src/main.test.ts`
- Create: `feishu.bridge/README.md`

**Interfaces:**
- Consumes: `setupRuntime` (Task 6), `FeishuBot` (Task 8), `Bridge` (Task 9), `StreamRouter` (Task 9), `chunkText` (Task 9), `config.get` (appId/appSecret/allowChats/groupOnly/sessionId).
- Produces: `main.ts` wires `activate` → read config, construct bot/bridge/stream, `bot.onMessage = m => bridge.route(m).then(err => err && bot.replyText(m.chatId, err))`, `stream.onReply = text => chunkText(text).forEach(c => bot.replyText(m.chatId, c))`, `bot.start()`; `onSessionEvent` → `stream.handleSessionEvent`; `executeCommand` `feishu.bridge.status`; `deactivate` → `bot.stop()`. `status.ts` exports `statusPayload(state)`.

- [ ] **Step 1: Write the failing test**

```ts
// feishu.bridge/src/status.test.ts
import { describe, it, expect } from 'vitest'
import { statusPayload } from './status.js'
describe('statusPayload', () => {
  it('produces a stat-grid payload reflecting bot state', () => {
    expect(statusPayload({ connected: true })).toMatchObject({ stats: expect.any(Array) })
  })
})
```

```ts
// feishu.bridge/src/main.test.ts
import { describe, it, expect } from 'vitest'
import { createPlugin } from './main.js'
describe('createPlugin', () => {
  it('provides activate/executeCommand/deactivate/onSessionEvent handlers', () => {
    const p = createPlugin()
    expect(typeof p.activate).toBe('function')
    expect(typeof p.onSessionEvent).toBe('function')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd feishu.bridge && npx vitest run src/status.test.ts src/main.test.ts`
Expected: FAIL — modules undefined.

- [ ] **Step 3: Implement**

`status.ts`:
```ts
export function statusPayload(state: { connected: boolean; sessionCount?: number }): any {
  return {
    stats: [
      { label: 'Feishu', value: state.connected ? 'Connected' : 'Stopped' },
      ...(state.sessionCount != null ? [{ label: 'Bound', value: String(state.sessionCount) }] : []),
    ],
  }
}
```

`main.ts` — full wiring. `createPlugin(overrides?)` for tests injects a `bot` factory; the real process entry calls `setupRuntime` on it. Read appId/appSecret from `config.get`; require both before `bot.start()` (else activation still succeeds but bot stays stopped — surface via status). Bind mapping: if `config.sessionId` is set, `bridge.setMapping` is skipped (mapping is per-chat; v1 binds the default session when a chat has no explicit map — i.e., `bridge.route` falls back to `sessionId` when the `mapping:chatId` key is empty). Implement that fallback in `bridge.ts` (add an optional default-session param to `Bridge`):

```ts
export class Bridge {
  constructor(callHost, private readonly defaultSessionId?: string) {}
  async route(m: BridgeMessage): Promise<string> {
    let sessionId = await this.getSessionId(m.chatId) ?? this.defaultSessionId ?? null
    if (!sessionId) return 'No session is bound to this chat. Bind one first.'
    await this.callHost('sessions.send', { sessionId, text: m.text })
    return ''
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd feishu.bridge && npx vitest run`
Expected: all pass (runtime, bot, bot.sdk, bridge, stream, status, main).

- [ ] **Step 5: Build + verify manifest**

Run: `cd feishu.bridge && npm run build`
Expected: `dist/service.mjs` builds clean. Confirm `crw-plugin.json` validates against the host (local install test: `POST /api/app-plugins/install {source:{type:'local',path:'<repo>/feishu.bridge'}}` or marketplace add of the repo URL).

- [ ] **Step 6: README**

Write `feishu.bridge/README.md`: Feishu Open Platform app setup (create app, enable long connection, subscribe to message receive), config values (appId/appSecret/allowChats/groupOnly/sessionId), install steps (add this repo as a marketplace in claude-react-web → install `feishu.bridge` → configure), the permission model note (v1 target session uses a relaxed permission mode; v2 adds card approval), and v1/v2 scope.

- [ ] **Step 7: Commit** (in the independent repo)

```bash
git add feishu.bridge
git commit -m "feat(feishu): assemble plugin — config→bot→bridge→stream + status + README"
```

---

## Self-Review

**1. Spec coverage:**
- §2 `sessions.subscribe` host api → Tasks 1–4 (subscriber set, pump fan-out, registry, host-api + lifecycle).
- §2 "reuse message 帧/BROADCAST_SYSTEM_SUBTYPES" → Task 2 (pump's `shouldBroadcastMessage` path reused verbatim). ✓
- §2 ledger cleanup (peer/session gone) → Task 3 `dropPeer`/`end`, Task 4 `PluginProcess` hooks; v1 no-history-backfill honored. ✓
- §3 payload server-side (`SessionEventOut`, `SDKMessage`) → Task 3; browser never imports it. ✓
- §4 child handler in the plugin's own runtime (not a host file) → Task 6 `runtime.ts`; documented. ✓
- §5 host tests → Tasks 1–5 (unit + acceptance fixture). The acceptance fixture (Task 5) is the "reusable framework ability" the review added. ✓
- §6 independent marketplace repo structure → Task 6 (`app-plugins-marketplace.json` + `feishu.bridge/` subdir). ✓
- §7 security (secrets, allow rail, explicit errors) → Tasks 7–10. ✓
- §8 plugin tests → Tasks 7–10. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step carries real code + test + run/build/commit commands. Task 8 and Task 10's Feishu SDK wiring say "verify against the installed SDK types at implementation time" — that is a live version check, not a vague placeholder (the SDK in the independent repo isn't installed here; the seams `app`/`adapter` are `any` so the version can't propagate). The `throw new Error('not started')` stubs in Task 7 are intentional early-TDD seams, not placeholders.

**3. Type consistency:** `pluginSubscribers: Map<string, Subscriber>` (Task 1) consumed in Tasks 2–4. `SessionEventOut` (Task 3) consumed by `sessions.event` in Tasks 5/6/9/10. `BridgeMessage` (Task 7) used Tasks 7–10. `callHost` flows from Task 6 `RpcPlug` through Tasks 7–10. `sessions.subscribe` returns `{ ok, unsubscribe }` consistently in Tasks 4/9. Names (`setupRuntime`, `dispatchInbound`, `createPlugin`, `parseMessageEvent`, `isAllowed`, `Bridge.route`, `StreamRouter.attach/handleSessionEvent`, `chunkText`, `statusPayload`) are identical across tasks. `SessionAdapter` gains the peer + registry via its constructor in Task 4 — any other construction sites are updated there. ✓

**Gap handled:** Host Tasks 1–5 land in the claude-react-web repo as a self-contained, self-verifying framework PR (+ acceptance fixture); the Feishu plugin ships in its own independent marketplace repo (Tasks 6–10) consuming the same `sessions.event` protocol.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Host tasks 1–5 run in the claude-react-web checkout; plugin tasks 6–10 run in the independent Feishu repo checkout.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?