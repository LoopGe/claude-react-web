# Agent Note: Host-global MCP connection sharing for the native provider

Status: implemented

## Problem

The native provider runs every session in-process (no per-session CLI subprocess;
`native-provider.ts`, turn loop `loop.ts`, model adapter is `fetch`), and
first-party `sdk` MCP servers are already in-process (`InMemoryTransport`).
External stdio MCP servers, left per-session, spawn one child process each
(`NativeMcpConnections` is constructed once per session; the stdio transport
builder in `mcp-config.ts` spawns a child per entry): N sessions × M stdio
servers = **N×M child processes** (~70 MB each). The incident workload was 5
sessions × ~4 MCP servers ≈ 20 children ≈ 1.6 GB (on the claude provider; native
inherits the same duplication on migration).

The duplication is pure waste, not identity-driven: native external stdio has
**no per-session identity** — `McpTransportTarget` has no `cwd` field, stdio env
is `process.env` + config env, and the native provider never consumes a
per-session `opts.env`. Two sessions requesting the same global stdio server
produce identical configs but separate children. DSH dedups exactly this case to
M via host-global singletons (5×4 → 4).

Goal: cut native external stdio MCP children from N×M to M, DSH-style, for the
native migration. Memory is the driver; the user will switch sessions to native
later, so the saving lands there.

## Decision

A **host-global shared registry** for external stdio MCP records with **reference
counting**; `NativeMcpConnections` is a per-session **view** over shared records.
Posture aligned with DSH (user-approved):

- **Default-on, no opt-in flag.** Identical global stdio configs share automatically.
- **Per-session differentiation via view restrictions**, not private servers — reuse
  the existing `filterToolsForProfile` + server-scope allowlist
  ([native-agent-profile-presets](2026-11-11-native-agent-profile-presets.md)).
- **Global-per-server failure surface**: one status per shared record, bounded-backoff
  auto-reconnect, fail-fast calls during the retry window, fail-closed replacement.
  **No** per-session status projection or retry isolation (DSH does neither).
- **Refcount-gated, sibling-safe teardown**: a session leaving never closes a server
  others still use; per-call `AbortSignal.any` means one caller's abort never kills
  siblings. **Immediate teardown at users==0** (no idle grace).

### Scope

- **Shared**: external `stdio` records with identical config identity (command + args + env).
- **Per-session, unchanged**: first-party `sdk` (cwd-bound, in-process, cheap);
  remote `sse`/`http` (a socket per session, not a process — outside the memory goal).
- **Non-goals**: the DSH preset plane (refcounted capability subtrees) — the shared
  registry alone delivers N×M→M, presets are new architecture only needed if
  capability-set grouping becomes a product requirement; claude-provider MCP (owned
  by the CLI subprocess, a separate harder proxy route, and the user is migrating to
  native).

### Semantics

| Operation | Behavior |
| --- | --- |
| acquire (session create / `setServers` add) | refcount++; create + connect the shared record if new. An acquire of a `cleanupFailed` record returns that SAME blocked record (no fresh connect) until a death-gated manual `reconnect()` clears the flag |
| release (session destroy / `setServers` remove) | refcount--; at 0 close the child, then remove the record ONLY if cleanup succeeded. A `cleanupFailed` record is retained at users 0 to block automatic replacement |
| acquire during healthy teardown | an acquire that lands while the last release is closing bumps the refcount; the settled release REVIVES the record for the new user (fire-and-forget reconnect) instead of leaving a closed zombie every future acquire would join |
| session destroy | releases that session's refs; never aborts a shared record others still use |
| per-call abort | `AbortSignal.any([callerSignal, view.abort, record.abort])` — sibling-safe; one view's teardown cancels only its own calls, never a sibling's and never the shared connection |
| `toggle(name, false)` | view-level: hide tools in this session's view + release its ref; the shared record closes only at refcount 0 |
| `toggle(name, true)` / `reconnect(name)` on a DISABLED entry | re-acquire ownership (a fresh record, or join a retained one) — never revive a released record at users 0, which would leave an unowned connected child (the unowned-child guard) |
| `reconnect(name)` on an enabled entry | global to all users of that record (accepted blast radius, DSH-aligned); a `cleanupFailed` record refuses until the child's death is confirmed |
| `setServers` replace-diff | per-session name set: acquire new configs / release removed (removals awaited BEFORE the add loop, so a freed child is gone before its replacement spawns); unchanged kept. A local entry's replace-diff identity stays env-excluded; a shared stdio entry's identity IS the env-included sharing key, so an env-only change acquires a new child and releases the old |
| server crash | reject ALL users' in-flight calls (`MCP_CONNECTION_CLOSED`); during the retry window cached last-good tools stay registered (the cache lives on the shared record, so late acquirers see the same tools) and calls fail-fast (`MCP_SERVER_UNAVAILABLE`); bounded backoff reconnect, fresh client per attempt; one global status. On budget give-up (~10 attempts / ~2.5 min) tools unregister and status turns `failed` until manual `reconnect(name)` |
| cleanup failure | a bounded close deadline + child-exit confirmation detects a hung close; `cleanupFailed` blocks automatic replacement. Manual `reconnect(name)` is allowed only after the child's identity reads null (death-confirmation gate), so a replacement never overlaps a live child and a recycled PID cannot pass |

### Architecture

- **`server/providers/native/mcp/shared-record.ts`** — `SharedRecord`, one shared
  connection's lifecycle: connect + discover, `callTool`, `readResource`, bounded
  teardown, and a reconnect supervisor. Carries config, client, one mutable
  `AbortController` (connect + all calls, replaced per attempt), status, `tools`,
  `cachedTools` (last-good, served during outage), serverInfo, `users` refcount,
  `pid` + `birthTime` identity, `cleanupFailed`, and reconnect attempt/backoff state.
  A serialized mutation queue (the `enqueue` pattern) keeps two attempts from
  overlapping; a reconnect tears down the previous generation BEFORE spawning a
  replacement. Bounded exponential backoff (initial 500 ms, max 30 s, maxAttempts 10
  ≈ 2.5 min), a fresh `Client` + transport per attempt, two-phase outage behavior.
  The attempt budget resets only after sustained uptime past `maxDelayMs`;
  `needs-auth` does not auto-retry. Also exports `sharingKey` and `childIdentity`.
- **`server/providers/native/mcp/shared-registry.ts`** — host-global
  `Map<sharingKey, SharedRecord>`. `acquire(config)` is synchronous (users++ or
  create + users=1 + fire-and-forget connect; callers await `record.ready` for the
  initial connect). `release(record)` runs its whole mutation on one serialized
  queue: users--, and at 0 the bounded close settles BEFORE the map decision (only a
  settled close knows whether cleanup failed), retaining a `cleanupFailed` record
  and reviving a during-teardown acquirer. Immediate teardown at users==0, no idle
  grace.
- **Sharing key** = `JSON.stringify(['stdio', command, args, sorted env])` —
  **includes env**, unlike the local replace-diff identity (which excludes it). The
  two keys serve different purposes and stay separate.
- **`connections.ts`** — the per-session view. An entry union: LOCAL (`sdk` / `sse` /
  `http`, and `stdio` without a registry) keeps the original connect/discover/close
  lifecycle; SHARED (`stdio` WITH a registry) holds a record ref + an `enabled` flag
  + a view-level `AbortController`. A stdio-only gate routes only external stdio to
  the registry. `statuses()` / `tools()` / `call()` / `readResource()` project
  shared-record state, gated on `record.status === 'connected'` (never merely
  `ready`, so a revival acquirer exposes no tools until connected). `sharedToolInfos`
  re-projects the record's tools under the session-local server name — the raw
  env-bearing sharing key never reaches a client / model / log surface. `closeAll()`
  aborts every view-level controller synchronously, then releases shared refs /
  closes local records; idempotent, never throws, and skips an already-released
  entry (no double-release).
- **`NativeMcpStatus.scope`** is `'session' | 'global'`; shared records project
  `'global'`, local `'session'`. The five-value status union is unchanged. The
  client's `McpServerStatus.scope` is already `scope?: string`, so no client/shared
  change is needed.
- **`native-provider.ts`** owns ONE `SharedRegistry` per provider (the provider is
  one-per-host) and passes it into every session's view. The `createSession`
  ctor-throw guard (`mcp.closeAll()`) releases any shared refs the fire-and-forget
  `load` acquired before the throw, so a half-started session never leaks a child.
- **Reused unchanged**: `filterToolsForProfile` + the ownership map
  (`native-session.ts` `buildFullTools`) for per-session tool restrictions over shared
  tools (ownership keys on the session-local server name); loop-level
  `requestPermission` (sharing does not bypass permissions).
- **OAuth**: `authFor` is host-global. Local entries resolve auth by server name; a
  shared record resolves by its sharing key (see Consequences for the residual).
- **Metrics / logging**: `shared_mcp_records` gauge, `mcp_shared_acquire` /
  `mcp_shared_release` counters; finite enum labels only. Scopes:
  `native-mcp-shared` (record), `native-mcp-registry` (registry), `native-mcp` (view).
  The sharing key embeds env values, so it never reaches a log; record diagnostics
  carry the command plus a one-way FNV-1a hash of the key.
- **Identity probe** (`childIdentity`): win32 is capability-gated — a sticky self-PID
  probe decides once per process whether the koffi FFI works; available reads go
  through `processIdentity` directly (microsecond death confirmation, no PowerShell
  on the teardown path), and only koffi-absent hosts fall back to `captureBirthTime`'s
  PowerShell leg. POSIX uses `kill(pid, 0)` liveness with an `'alive'` sentinel
  (PID-reuse fencing is win32-only).

### Auto-reconnect asymmetry (intentional)

Shared stdio records auto-reconnect with a bounded budget (~2.5 min) and two-phase
outage behavior (fail-fast during retry, unregister on give-up until manual
reconnect); local `sdk` / `sse` / `http` entries reconnect only manually. This
asymmetry is part of the DSH alignment, not a regression — a shared server's failure
surface is global, compensated by bounded backoff + fail-fast + fail-closed
replacement.

## Alternatives considered

- **Per-session status projection + retry isolation** (the initial cautious
  proposal). Rejected: DSH does neither — it accepts a global-per-server failure
  surface compensated by bounded backoff + fail-fast + fail-closed replacement.
  Simpler, proven, lower complexity and risk. User approved the DSH posture.
- **Opt-in sharing flag.** Rejected: DSH sharing is the architectural default with
  no per-session private-connection flag; differentiation is via view restrictions.
  Default-on delivers the saving automatically on native migration. User approved.
- **Idle grace period at refcount 0.** Rejected: DSH `collect()` disposes immediately
  at `retired && users==0`; the memory goal favors immediate release. Reconnect churn
  on clear/respawn is accepted (re-acquire reconnects).
- **Share `sse`/`http` too.** Rejected as outside the memory goal (a socket per
  session, not a process); limits blast radius and complexity. Could extend later.
- **Preset refcounted capability plane.** Rejected as a non-goal: the shared registry
  alone gives N×M→M; presets are new architecture needed only for capability-set
  grouping as a product requirement.
- **MCP proxy for the claude provider.** Rejected as out of scope: claude MCP is owned
  by the CLI subprocess (a separate, harder host-proxy route), and the user is
  migrating to native.
- **Connection reuse across reconnect generations.** Rejected (DSH): SDK guidance is
  one connection per Protocol instance; a fresh client per attempt avoids carrying
  notification handlers and negotiated capability state across server incarnations.
- **Fail-closed resolution: DSH-absolute (restart-only) vs force-replace.** DSH blocks
  replacement until Host restart (even manual restart refuses); rejected for this
  long-lived, constantly-churning server — one wedged config would block every
  session's acquire of that config until app restart. Force-replace on manual
  reconnect was rejected because it can overlap a live child (the exact hazard
  fail-closed prevents). Chosen: recoverable without restart, but manual reconnect
  gated on confirmed child death (user decision).

## Consequences

**Bought**: N×M → M children for identical stdio configs (the memory goal); one
connection per server across sessions; a DSH-aligned failure posture proven on the
harness. The acceptance behaviors are pinned by real-process tests (see Testing).

**Cost / residuals**:

- **Shared-lifecycle hazards** (leaked child at refcount 0, use-after-close,
  cross-session abort) are mitigated by refcount-gated record abort, per-call
  `AbortSignal.any`, serialized queues, abort-before-close teardown, and fail-closed
  replacement; real-process tests pin each.
- **Failure blast radius**: one shared server crash affects all its users (accepted,
  DSH-aligned); bounded backoff + fail-fast + fail-closed compensate; servers isolate
  from each other (separate records/supervisors).
- **Fail-closed recovery**: a hung close blocks automatic replacement; recovery is
  manual `reconnect(name)` gated on confirmed child death (no app restart). The gate
  confirms death by identity (PID + birth-time on win32), so a recycled PID cannot let
  a replacement overlap a live child. Residual degraded edge: when BOTH identity
  sources fail on a live child the read is null and death is indistinguishable from
  unreadable — fail-closed is not claimed there. POSIX gating is liveness-only (no
  birth-time identity).
- **Two distinct keys**: the sharing key includes env; the local replace-diff identity
  excludes env. Conflating them would wrong-merge different-env servers or change
  replace-diff semantics. They stay separate; a shared entry's replace-diff identity
  IS its sharing key, so an env-only change correctly acquires a new child.
- **OAuth residual**: a shared stdio record resolves `authFor` by its sharing key,
  while the host store keys by server name, so a shared stdio entry needing stored
  OAuth misses the lookup (silent; no secret leaks). stdio servers are usually
  env-keyed, and remote `sse`/`http` stay local with correct name-keyed `authFor`, so
  the practical surface is small.
- **View-level timeout opts** (`connectTimeoutMs` / `toolTimeoutMs`) are not forwarded
  to shared records (the registry uses its own defaults). The provider constructs the
  registry with defaults, so there is no production impact; a caller passing custom
  view timeouts would see them apply only to local entries.
- **Churn**: clear/respawn releases + re-acquires → reconnect churn; accepted (no idle
  grace).
- **First-party `sdk` stays per-session** (cwd-bound): no saving there, but already
  in-process and cheap.

## Testing

Real-process throughout (the `stdio-server.mjs` fixture spawns actual children; its
`--hang` / `--hang-tools` / `--crash` / `--flaky` / `--ignore-exit` / `--slow-exit`
modes make each lifecycle hazard deterministic). A bye marker plus the `childIdentity`
probe prove real child exit — no leaked children. The healthy-close pins carry a
generous `closeTimeoutMs` margin so a load-stretched healthy child exit never trips
`cleanupFailed` retention; the deliberately-hung retention pin keeps a short deadline.

- **`mcp/shared-record.test.ts`** — connect/discover/close core; sibling-safe per-call
  abort; crash rejects in-flight calls, keeps cached tools registered, reconnects with
  a fresh child; late acquirer during outage sees cached tools; give-up unregisters
  tools until manual reconnect; hung close trips the deadline and sets `cleanupFailed`;
  death-gated reconnect refused while the child is alive / allowed after confirmed
  death; recycled-PID refusal; reconnect racing an in-flight hung close refuses after
  teardown settles (no overlapping child); secret env never logged; FFI-fast identity
  timing.
- **`mcp/shared-registry.test.ts`** — two acquires share one child + release semantics;
  different env yields separate children; release-at-0 cannot race a concurrent
  acquire; acquire during healthy teardown gets a reviving record (not a zombie);
  acquire/release counters + records gauge; retains a `cleanupFailed` record at users 0
  and blocks automatic re-acquire.
- **`mcp/connections.test.ts`** — two views share a stdio child + view-level toggle; no
  double-release on toggle-off + closeAll; env-only change acquires a new child and
  releases the old; scope labels (shared global / sdk session); tool re-projection with
  no sharing-key/env leak; the unowned-guard re-acquire paths (`reconnect` /
  `toggle(true)` on a disabled entry re-acquire ownership) — mutation-verified RED
  without the guard. The 14 legacy no-registry tests stay green (local path intact).
- **`native-provider.mcp.test.ts`** — ctor-throw releases acquired refs (no leaked
  child); two provider-created sessions share one provider-owned registry + one child.
- **`e2e-mcp.test.ts`** (manager-level) — "shares ONE stdio child across two sessions;
  delete keeps it until the last user": two `SessionManager`-created native sessions
  with an identical stdio config drive ONE real child, both route echo calls through it
  (re-projected FQN, first-party git-tools alongside, `scope:'global'` status), deleting
  one keeps the child alive and the survivor still calls it, deleting the last reaps it
  (bye marker + `childIdentity` null). Plus the existing manager-level MCP e2e
  (first-party routing, external sdk server, denied call, replace/toggle).
- **Full gate**: `npm run verify` (typecheck ×4, lint, verify:agent-notes, full vitest
  suite — 774 files / 11048 tests, build) green.

## Related

- [first-party-config-tools](2026-11-06-first-party-config-tools.md)
  — per-session MCP connection semantics ("other live sessions keep their
  connection until their next spawn"); partially superseded for native stdio by this
  sharing model.
- [native-agent-profile-presets](2026-11-11-native-agent-profile-presets.md)
  — the profile / tool-filtering mechanism reused for per-session views over shared tools.
- DSH reference: `deepseek-harness` `packages/mcp/mcp-client` (generation abort,
  bounded-backoff reconnect, two-phase outage, fail-closed replacement),
  `packages/mcp/mcp-manager` (global plane), `packages/preset/agent-preset-registry`
  (refcounted `collect()`).