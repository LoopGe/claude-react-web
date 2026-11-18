# Agent Note: Host-global MCP connection sharing for the native provider

Status: proposed

## Problem

The native provider runs every session in-process (no per-session CLI subprocess;
`native-provider.ts:3-4`, turn loop `loop.ts:80`, model adapter is `fetch`), and
first-party `sdk` MCP servers are already in-process (`InMemoryTransport`). But
**external stdio MCP servers are still per-session**: `NativeMcpConnections` is
constructed once per session (`native-provider.ts:245-246`), and each stdio entry
spawns its own child process (`mcp-config.ts:647-653`). N sessions × M stdio
servers = **N×M child processes** (~70 MB each). The incident workload was 5
sessions × ~4 MCP servers ≈ 20 children ≈ 1.6 GB (on the claude provider today;
native inherits the same duplication on migration).

The duplication is pure waste, not identity-driven: native external stdio has
**no per-session identity** — `McpTransportTarget` has no `cwd` field
(`mcp-config.ts:616-623`), stdio env is `process.env` + config env, and the native
provider never consumes a per-session `opts.env`. Two sessions requesting the same
global stdio server produce identical configs but separate children. DSH dedups
exactly this case to M via host-global singletons (5×4 → 4).

Goal: cut native external stdio MCP children from N×M to M, DSH-style, for the
native migration. Memory is the driver; the user will switch sessions to native
later, so the saving lands there.

## Proposal

A **host-global shared registry** for external stdio MCP records with **reference
counting**; `NativeMcpConnections` becomes a per-session **view** over shared
records. Posture aligned with DSH (user-approved):

- **Default-on, no opt-in flag.** Identical global stdio configs share automatically.
- **Per-session differentiation via view restrictions**, not private servers — reuse
  the existing `filterToolsForProfile` + server-scope allowlist
  ([native-agent-profile-presets](../../implemented/architecture/2026-11-11-native-agent-profile-presets.md)).
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
| acquire (session create / `setServers` add) | refcount++; create + connect the shared record if new |
| release (session destroy / `setServers` remove) | refcount--; at 0 close the child + remove the record immediately |
| session destroy | releases that session's refs; never aborts a shared record others still use |
| per-call abort | `AbortSignal.any([callerSignal, record.abort.signal])` — sibling-safe (existing pattern, `connections.ts:207`) |
| `toggle(name, false)` | view-level: hide tools in this session's view + release its ref; shared record closes only at refcount 0 |
| `toggle(name, true)` | acquire again + mark view enabled |
| `reconnect(name)` / server-level ops | global to all users of that record (accepted blast radius, DSH-aligned) |
| `setServers` replace-diff | per-session name set: acquire new configs / release removed; unchanged kept. The view's replace-diff identity stays env-excluded (documented behavior); the sharing key includes env (distinct keys, see Risks) |
| server crash | reject ALL users' in-flight calls (`MCP_CONNECTION_CLOSED`); **during the retry window** cached last-good tools stay registered (cache lives on the shared record, so late acquirers see the same tools) and calls fail-fast (`MCP_SERVER_UNAVAILABLE`); bounded backoff reconnect, fresh client per attempt; one global status. **On budget give-up** (~10 attempts / ~2.5 min) tools unregister and status turns `failed` until manual `reconnect(name)` — DSH's actual two-phase behavior |
| cleanup failure | a bounded close deadline + child-exit confirmation detects a hung close; the record blocks **automatic** replacement (refuse + log). **Recoverable without app restart**: manual `reconnect(name)` is allowed only after confirming the child PID is dead (death-confirmation gate, reusing the win32 process check), so a replacement never overlaps a live child |

### Architecture

- **New module `server/providers/native/mcp/shared-registry.ts`** — host-global
  `Map<sharingKey, SharedRecord>`. `SharedRecord` carries config, client, one
  `AbortController` (connect + all calls), status, tools, **cached last-good tools**
  (served during outage so late acquirers see the same registered tools), serverInfo,
  `users` refcount, reconnect attempt/backoff state, and a cleanup-failed flag. A
  serialized mutation queue (reuse the `enqueue` pattern, `connections.ts:284-288`).
  `acquire(config)` / `release(key)` manage the refcount; connect/discover/close
  reuse the existing `connections.ts` core (extracted). A reconnect supervisor adds
  bounded exponential backoff (DSH defaults: initial 500 ms, max 30 s, maxAttempts
  10 ≈ 2.5 min), a fresh `Client` + transport per attempt, and two-phase outage
  behavior: cached tools stay registered with fail-fast calls during the retry
  window, then unregister on give-up (status `failed`) until manual reconnect.
  Reconnect attempts reuse the `pending` status with the attempt count in `error`
  (no growth of the client status union, `src/types.ts:511`). The close path gains a
  bounded deadline + child-exit confirmation; a hung close sets cleanup-failed and
  blocks automatic replacement. Manual `reconnect(name)` on a cleanup-failed record
  is gated on confirming the child PID is dead (reuse the win32 process-identity /
  liveness check), so recovery needs no app restart and never overlaps a live child.
- **Sharing key** = `JSON.stringify(['stdio', command, args, sorted env])` —
  **includes env**, unlike the replace-diff identity (`connections.ts:516-522`,
  which deliberately excludes env). The two keys serve different purposes and must
  stay separate.
- **`NativeMcpConnections` refactor** — stdio entries route to the shared registry
  (the view holds a name→sharingKey map + a per-session enabled flag); `sdk` /
  `sse` / `http` entries stay local records (current code unchanged).
  `statuses()` / `tools()` / `call()` / `readResource()` project shared-record state
  into the session view; `call()` keeps `AbortSignal.any([caller, shared.abort])`.
  `closeAll()` releases all stdio refs and closes local sdk/sse/http records.
  `setServers` / `reconnect` / `toggle` split into view-level vs refcount-gated
  global operations.
- **`NativeMcpStatus.scope`** widens from `'session'` to `'session' | 'global'`;
  shared records are labeled `'global'`, and the view projects their global status
  (no per-session projection). The five-value status union is unchanged.
- **Reused unchanged**: `filterToolsForProfile` + ownership map
  (`native-session.ts` `buildFullTools`) for per-session tool restrictions over
  shared tools; loop-level `requestPermission` (sharing does not bypass permissions).
- **OAuth**: `authFor` is already host-global; the shared record resolves auth by the
  global server identity (builder settles the exact keying).
- **Call sites**: `native-provider.ts:245` (createSession builds the view + acquires),
  `native-session.ts` destroy (~1971, `closeAll` → release), the manager
  `setMcpServers` route (`session-manager-mcp.ts`) — API signatures unchanged.
- **Metrics / logging**: `shared_mcp_records` gauge, `mcp_shared_acquire` /
  `mcp_shared_release` counters, per-record refcount; finite enum labels only.
  `createLogger('native-mcp-shared')`.

### Behavior addition (intentional)

Bounded-backoff **auto-reconnect is new for native** — today `reconnect(name)` is
manual and a failed server stays failed until retried (`connections.ts:20-22,227`).
Shared stdio records gain DSH-style auto-reconnect (~2.5 min budget) with two-phase
outage behavior (fail-fast during retry, unregister on give-up until manual
reconnect). This changes native MCP failure behavior deliberately; it is part of
the DSH alignment, not a side effect.

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

## Acceptance criteria

1. Real-process test: two native sessions acquiring the same stdio config → exactly
   **one** child process; releasing one → child alive; releasing the last → child gone
   (poll PID absence).
2. Same command/args but **different env** → separate children (sharing key includes env).
3. Per-call abort is sibling-safe: session A aborts a call while session B's in-flight
   call on the same shared server completes.
4. Session destroy never closes a shared server another session still uses; refcount 0
   closes immediately.
5. Server crash → all users' in-flight calls rejected; during the retry window cached
   tools stay registered and calls fail-fast; bounded backoff reconnects with a fresh
   child; status is global. On budget give-up tools unregister (status `failed`) until
   manual `reconnect(name)` succeeds.
6. `toggle(false)` is view-level (hides tools for that session, releases its ref)
   without closing a shared server others use.
7. Cleanup failure (hung close) → record blocks automatic replacement; manual
   `reconnect(name)` is refused while the child PID is alive, and succeeds once the
   child is confirmed dead (no overlapping children, no app restart).
8. `sdk` / `sse` / `http` entries unchanged (per-session); existing native MCP tests green.
9. `setServers` / `reconnect` / `toggle` / `statuses` API signatures unchanged; the
   manager route works for both providers.
10. `npm run verify` green.

## Risks

- **Shared-lifecycle bugs** (leaked child at refcount 0, use-after-close, cross-session
  abort). Mitigations: refcount-gated record abort, per-call `AbortSignal.any`
  (existing), serialized queue, abort-before-close teardown, fail-closed replacement;
  real-process tests pin each.
- **Failure blast radius**: one shared server crash affects all its users (accepted,
  DSH-aligned); bounded backoff + fail-fast + fail-closed compensate; servers isolate
  from each other (separate records/supervisors).
- **Auto-reconnect behavior change**: native failed servers now auto-retry (~2.5 min)
  then unregister tools until manual reconnect, instead of waiting for manual
  reconnect immediately — intentional DSH alignment; document so it is not mistaken
  for a regression.
- **Fail-closed recovery**: a hung close blocks automatic replacement; recovery is
  manual `reconnect(name)` gated on confirmed child death (no app restart). The gate
  must reliably confirm death (PID + creation-time identity, reuse the win32 check) so
  a recycled PID cannot let a replacement overlap a live child. A wedged config is
  recoverable per-config without taking down the long-lived server.
- **Two distinct keys**: the sharing key includes env; the replace-diff identity
  excludes env (documented behavior). Conflating them would either wrong-merge
  different-env servers or change replace-diff semantics. Keep them separate.
- **OAuth / identity**: shared records resolve auth by global identity; per-session
  inline overrides carrying custom env stay per-session (not shared) — correct, since
  their config identity differs.
- **Churn**: clear/respawn releases + re-acquires → reconnect churn; accepted (no idle
  grace).
- **First-party `sdk` stays per-session** (cwd-bound): no saving there, but already
  in-process and cheap.

## Related

- [first-party-config-tools](../../implemented/architecture/2026-11-06-first-party-config-tools.md)
  — current per-session MCP connection semantics ("other live sessions keep their
  connection until their next spawn"); partially superseded for native stdio by this
  sharing model.
- [native-agent-profile-presets](../../implemented/architecture/2026-11-11-native-agent-profile-presets.md)
  — the profile / tool-filtering mechanism reused for per-session views over shared tools.
- DSH reference: `deepseek-harness` `packages/mcp/mcp-client` (generation abort,
  bounded-backoff reconnect, two-phase outage, fail-closed replacement),
  `packages/mcp/mcp-manager` (global plane), `packages/preset/agent-preset-registry`
  (refcounted `collect()`).
