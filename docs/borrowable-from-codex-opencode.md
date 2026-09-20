# Borrowable mechanisms from Codex & OpenCode — for claude-react-web

Deep dive into what `openai/codex` and `anomalyco/opencode` do that we don't, verified against both their code and ours.

**Sources (pinned revisions):**

| Repo | Revision | Date |
|---|---|---|
| `D:\codes\codex` | `cac96cd7b1` (`main`) | 2026-09-03 |
| `D:\codes\opencode` | `b5787261fc` (`dev`) | 2026-09-02 |
| This repo | working tree | 2026-09-20 |

Every "we lack X" claim below was verified by grep against this repo. Where we already have something, that is stated — several of the obvious-looking borrowables are things we do better.

## TL;DR — the short list

| # | What | Theirs | Effort | Why it matters |
|---|---|---|---|---|
| **1** | **Fix the default cwd in the desktop host** | `process.chdir(homedir())` at boot | **~1 h** | **Confirmed bug**: packaged app pre-fills new-session cwd with `/` (macOS) or the install dir (Windows) |
| **2** | **Protocol drift test** | `schema_fixtures_tests.rs` regen-and-diff | ~1 day | Converts "server and client disagree" from a runtime browser bug into `npm test` failure |
| **3** | **Scoped server identity** | `ServerConnection.key()` + `ServerScope` | ~2-3 days | Retrofitting scope onto already-persisted state is the expensive part — do it before you need multi-server |
| **4** | **State-dir GC** | `store-cleanup.ts` | ~half day | Directly portable template; our `--state-dir` accumulates forever |
| **5** | **Shell env probe** | `shell-env.ts` | ~half day | GUI-launched app loses the user's PATH → `git`, `npx`, `rg` ENOENT. macOS only (see §5) |
| **6** | **Generic server→client request** | `ServerRequest` + `pending` + `serverRequest/resolved` | ~2 days | We reimplement correlation three times by hand |
| **7** | Desktop hygiene bundle | single-instance, window state, crash handling, deep links | ~2 days | Each is small; together they're "feels like an app" |
| **8** | Backpressure asymmetry | fail requests, block notifications | ~half day | We have recovery; this is the *policy* half |

---

## 1. Desktop shell — we already have one, so this is a diff not a decision

**Surprise finding:** this repo already ships an Electron host — `desktop/{main,preload,menu,updater,frame-sink-ipc}.ts`, `desktop/electron-builder.yml`, `.github/workflows/desktop.yml`, `shared/desktop-bridge.ts`, `src/transport/desktop.ts`.

And our architecture is **different from opencode's, and better on one axis**:

| | Ours | OpenCode |
|---|---|---|
| Renderer ←→ host | `crw://` custom scheme → `protocol.handle` → `ctx.app.fetch(request)`, **in-process into the same Hono app** | forks a `utilityProcess` running the real server |
| Realtime | `MessageChannelMain` + `PortFrameSink` / `SessionConnection`, **no WebSocket** | ordinary HTTP/SSE client |
| Network surface | **zero ports, zero CORS** | one TCP port + Basic auth |
| Renderer build | desktop-specific transport (`src/transport/desktop.ts`) | the *same* build as `opencode web` |

We win on surface area: no port to bind, no password to manage, no CORS. **But we lose the ability to point the UI at a different machine** (§2), which is exactly what opencode's design buys them.

### 1.1 Confirmed bug: default cwd is `process.cwd()` in the packaged app

`desktop/main.ts:180`:

```ts
ctx = await createServerContext({ stateDir, appPlugins: true })
```

No `cwd`. Compare `server/bootstrap.ts:177`, which is the only place `defaults.cwd` is supplied:

```ts
defaults: { cwd: opts.cwd, model: opts.model, claudeBinary },
```

So in the desktop host `opts.defaults?.cwd` is `undefined`, and `server/app.ts:243` falls through to:

```ts
cwd: opts.defaults?.cwd ?? process.cwd(),
```

**A packaged GUI app does not have a meaningful `process.cwd()`.** On macOS, Finder/`open` launches with cwd `/`. On Windows, an NSIS shortcut starts in the install directory. So:

- `GET /api/config` → `defaults.cwd` = `/` (or the install dir) → the new-session dialog **pre-fills a meaningless workspace**.
- `server/fs-routes.ts:66` → the directory picker's start point is the same value, while `home: homedir()` sits right beside it unused for this purpose.

This never reproduces under `npm run dev` (cwd is the repo) — it only shows up in an installed build. **`process.chdir(homedir())` at boot, before `createServerContext`.** Same as opencode's `index.ts:118-121`.

### 1.2 Stale comment worth fixing while you're in there

`desktop/main.ts` header claims the host adds "a per-launch random state dir under userData". The code is deterministic:

```ts
const stateDir = join(app.getPath('userData'), 'state')
```

It reads as though desktop sessions don't persist across restarts. They do. Fix the comment.

### 1.3 Verified gaps (each grep returned empty)

| Missing | Consequence | Their mechanism |
|---|---|---|
| `requestSingleInstanceLock` | Two launches = two hosts writing one state dir | `index.ts:70,81-86` |
| Window bounds persistence | Size/position lost every launch (hardcoded 1280×860) | `window-state.ts` + `electron-window-state` |
| `render-process-gone` / `unresponsive` | Renderer dies, nothing happens. `frame-sink-ipc.ts:83` only mentions it in a comment | `unresponsive.ts` + recovery dialog |
| Deep link / protocol handler | Can't `crw://…?cwd=X` from CLI or OS | `codex://threads/new?path=` · `opencode://` |
| State root GC / migration | Old state dirs never reclaimed | `store-cleanup.ts` · `migrate.ts` |
| Build channel identity | One channel only | `OPENCODE_CHANNEL` → app id + userData + feed |

Two of these have a detail worth stealing:

**Single instance + deep-link relay, with a pre-renderer queue** (`index.ts:198-222,295`). A protocol URL can arrive before any renderer exists (cold launch), or in a second process while the first runs. Their fix: `second-instance` argv → filtered by scheme → pushed to `pendingDeepLinks`; the renderer *pulls* the queue on mount (`consume-initial-deep-links`, `splice(0)`) while live links are *pushed*. **That ordering rule is exactly our WS replay ring + `subscribe-result` handshake** — buffer what precedes the listener, hand the buffer over on subscribe, mark the boundary with a drain.

**Channel identity as a build-time constant** (`constants.ts:3-7`, `electron.vite.config.ts:8-13`). `OPENCODE_CHANNEL` is inlined via `define` and derives app id, product name, userData dir, protocol, and update feed. Rule: derive every identity-bearing artifact from one build-time constant, never from runtime env in a packaged artifact. Relevant if we ever ship a beta channel.

### 1.4 Window registry: the "deliberate close" rule

`window-registry.ts:35-45` — a closed window id is forgotten **only if the close was deliberate**:

```ts
// closed() forgets the id only when !quitting && windows.size > 0
```

The comment explains why: closing the last window quits the app, and `closed` fires *before* `before-quit`, so naive pruning drops the id and the next launch opens a fresh window with no restored state. A `quitting` flag (set from `before-quit`/`will-quit`/`relaunch`/`quitAndInstall`) suppresses pruning during teardown. Windows-specific: OS shutdown never fires `before-quit`, but every window gets `session-end` → sets the flag.

Not directly applicable (we're single-window), but the general rule — **distinguish user-initiated close from teardown** — is the same distinction our hub makes between a user closing a panel and a page unload, and it's the kind of thing that's invisible until it bites.

---

## 2. Server identity is a key, not a URL — the biggest architectural borrowable

### 2.1 What they did

`packages/app/src/context/server.tsx:181-243` models a server as a tagged union over four physically different transports (local HTTP, Electron sidecar, WSL sidecar per distro, SSH remote) and gives every one a **derived, branded key**:

```ts
ServerConnection.key(): Key   // url | "sidecar" | "wsl:<distro>" | "ssh:<host>"
```

Then `utils/server-scope.ts:21-27` collapses both the canonical local key *and* `"sidecar"` to the literal scope `"local"`. Every persisted key is composed as `ScopedKey.from(scope, …)`, so **the browser's `http://localhost:4096` and the desktop's `type:"sidecar"` produce byte-identical storage keys**. Open projects, last session, panel widths, drafts all follow the user across all four runtimes with no migration beyond one `canonicalLocalServer` hint.

That's 73 lines of utility code doing load-bearing work.

### 2.2 Where we stand

`src/transport/web.ts:15-19` is hard-wired to the current origin:

```ts
function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}${WS_PATH}`
}
```

REST is relative `/api`. **There is no way to point the UI at another server.** So remote/WSL/multi-server is unreachable, and desktop-vs-web stays a transport fork rather than a config value.

Compounding this: our persisted keys are **unscoped** — `claude-react-web:accent-color`, `claude-react-web:recent-colors` (`src/theme.ts`), plus `ui-state-store.ts` (groups + `sidebarOrder`). If two servers were ever connected, those collide.

### 2.3 Recommendation

`src/transport/types.ts` already gives us the seam (`Transport` / `TransportConnection`). What's missing is that the **target isn't part of a transport's identity**. Concretely:

1. Add `ServerKey` (branded string) + `serverScope(key)` collapsing local variants, mirroring `server-scope.ts`.
2. Make the transport factory take a target instead of reading `window.location`.
3. Prefix every persisted key with the scope — **and do this before you need it.** Retrofitting a scope onto already-persisted user state is the expensive half; adding the prefix while there's exactly one server is nearly free and needs no migration.

Also worth noting: their `global.tsx:38-71` keeps one detached reactive root per server (QueryClient + event stream + directory store) in a `Map`, disposed by list membership — so every connected server's stream is live simultaneously, which is what makes the sidebar truthful across servers. The React equivalent is a module-level `Map` + acquire/release in an effect; the bookkeeping is hand-written because React has no owner tree.

---

## 3. Protocol design

### 3.1 The drift test — copy this first

Codex generates ~700 TypeScript types from Rust and **checks the generated tree in**, then has ordinary `#[test]`s that regenerate in-memory and diff (`app-server-protocol/src/schema_fixtures_tests.rs:20-37`, `:47-67`). `assert_schema_trees_match` (`:159-210`) prints a unified diff **and the remediation command**. A second test asserts the embedded zstd blobs equal the on-disk tree, so the shipped binary and the vendored schema can't diverge either. Comparison is canonicalized (`schema_fixtures.rs:208-283` sorts `required`/`enum`/`anyOf` arrays) to kill platform-ordering flake.

**TS equivalent, ~40 lines:**

1. Make `shared/ws-protocol.ts` a *data* table, not only types — `const FRAMES = { replay: {...}, message: {...}, … } as const` so the discriminant is a literal union instead of `kind: string`.
2. `scripts/gen-protocol.mts` reads the table, emits `shared/protocol/generated.ts` + `docs/ws-protocol.md`.
3. `protocol.drift.test.ts` runs the generator into a temp dir and asserts byte-equality against the committed output.

**Why this one first:** we already designate `shared/ws-protocol.ts` as the single source, and CLAUDE.md is explicit that `server/ws-protocol.ts` and `src/ws-types.ts` are "thin instantiation aliases … **not** duplicated mirrors". That discipline is real but it's enforced by convention. The drift test makes it enforced by CI — and it's the mechanism that keeps every other pattern on this list honest. Today, a frame added server-side and forgotten client-side fails at runtime in a browser.

Their own counter-example is instructive: opencode's IPC has **no codegen and no parity test** — channels are bare string literals on both sides, and the type system can't catch the mismatch. The result is a dead `install-cli` channel: `preload/index.ts:15` exposes it, `src/renderer/cli.ts:3-7` calls it, **and no `ipcMain.handle("install-cli")` exists anywhere in `src/main`.** It rejects at runtime with "No handler registered". That's exactly the bug class the drift test removes.

### 3.2 Request vs notification — a decision procedure

Codex's rule, as encoded rather than documented (`app-server-protocol/src/protocol/common.rs`):

> **If the client must send a value back, it's a request (has `id`, gets a `pending` entry, gets a typed response). Everything streaming/stateful is a notification (no `id`).**

Their ten server→client requests are exactly the things needing an answer: approvals, `requestUserInput`, MCP elicitation, permissions, dynamic tool call, auth-token refresh, attestation, two legacy approval methods. Everything else is a notification.

Three sub-rules worth taking:

- **Correlation is generated, not written.** `OutgoingMessageSender` holds `next_server_request_id: AtomicI64` + `Mutex<HashMap<RequestId, PendingCallbackEntry>>`, where the entry carries the `oneshot::Sender`, the original `ServerRequest` (for logging and re-parsing), and an RAII gauge guard (`app-server/src/outgoing_message.rs:104-127`). Ids share one counter with client ids, so collision is impossible by construction.
- **Emit the resolution broadcast from the single place that clears the pending entry** — not from the answer handler. `serverRequest/resolved` (`{threadId, requestId}`) fires on every resolution path: client answer, *and* lifecycle cleanup on turn start / complete / interrupt (README:1995, :2013, :2022). That's how a second tab's modal closes when the first tab answers. **Our `permission-broker.ts` / session-manager `pending` map is the right place for this rule**, and we already have the frame (`permission-resolved`) — the borrowable part is firing it from the clear path so timeout/abort/session-delete all get it for free.
- **The response carries only what the server knows synchronously.** `turn/start` returns a receipt; the work streams as notifications joined by `turn.id`.

**Where we are:** we have bespoke frame kinds — `permission-request`/`permission-resolved`, `elicitation-request`/`-resolved`, `dialog-request`/`-resolved` — each reimplementing correlation by hand. Collapsing them into one generic `{kind:'request', id, method, params}` frame with a discriminated-union payload, plus one resolution broadcast, is the single biggest reduction in protocol surface available to us.

### 3.3 Backpressure — the asymmetry is the insight

We already have `ws-backpressure-recovery` (per CLAUDE.md). What codex adds is the *policy*:

- **Requests fail fast, notifications block.** `enqueue_incoming_message` (`transport/mod.rs:229-257`) distinguishes `Full(Request)` → synthesize `{"id": …, "error": {"code": -32001, "message": "Server overloaded; retry later."}}` **straight to that connection's writer, bypassing the full queue entirely**, versus `Full(notification)` → `await` the blocking send. So a saturated server tells requesters to back off, and never silently drops a notification or deadlocks.
- **Slow-client disconnect on the push path**, gated on a *per-transport capability* rather than a global flag: `can_disconnect()` is `disconnect_sender.is_some()` — true for websocket, false for stdio (`app-server/src/transport.rs:136-174`). On `Full`, websocket disconnects with a warn; stdio blocks. A pipe has no choice but to block; a socket does.
- **Heartbeat on a separate control channel** so a saturated data queue can't starve the ping and make a live client look dead (`websocket.rs:199,304-311,362-371`). Worth verifying against our `useWsHub` ping path.
- **32× headroom with a compile-time assert:** `WEBSOCKET_OUTBOUND_CHANNEL_CAPACITY = 32 * 1024` vs internal `CHANNEL_CAPACITY = 128`, plus `const _: () = assert!(OUTBOUND > INTERNAL);` (`websocket.rs:46-49`). Cheap and it documents intent.

### 3.4 Small, cheap, portable

| Mechanism | Where | Why |
|---|---|---|
| `emittedAtMs` stamped **once before fan-out** | `common.rs:1981-1992` | Lets clients order/dedup against a common clock; optional field so old servers still decode |
| Per-connection notification opt-out | `v1.rs:58-61` | `optOutNotificationMethods: string[]` — a logger client skips every delta |
| `RedactedString` newtype | `codex-utils-redacted-string` | Type-level guarantee a field never reaches a log line |
| **No version field** | `v1.rs:29-80` | Deliberate. Version numbers force lockstep upgrades; they regenerate instead. Don't add one |
| `initialize` → `initialized` gate | `message_processor.rs:899-901` | One boolean per connection checked in the dispatcher before anything else; ~10 lines |
| Pagination is uniform | `experimental_feature.rs:10-22` | Every list method takes `cursor`/`limit`, returns `nextCursor`; cursor opaque. No exceptions, no offsets |

---

## 4. State, GC, and robustness

### 4.1 State-dir GC — directly portable

Our `--state-dir` accumulates sessions, uploads, snippets, UI state, logs, and app-plugin data forever. `store-cleanup.ts:4-94` is a complete, unit-tested template. Three rules:

- **Filename-regex classification** (`opencode.draft.*.dat` / `opencode.workspace.*.dat`) so **global** stores are structurally immune to per-session GC — the rule can't accidentally eat settings.
- **Empty = size ≤ 128 bytes AND parses to a `{}`-shaped object.** The size cap avoids reading big files; the parse check avoids trusting `"{}"` text.
- **Age + count caps:** drafts older than 30 days, drafts beyond the newest 100.

Two details that are easy to get wrong:
- **Delete-on-empty must invalidate the cached store handle** (`store.ts:28-35`, `ipc.ts:127-134`), or the next write resurrects the deleted file.
- The whole sweep runs **at startup**, wrapped so failure is a warn, never a boot failure.

### 4.2 Shell env probe — real for our macOS DMG only

Root cause: a macOS GUI app is launched by `launchd`, not a login shell, so it inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — no Homebrew, no nvm/asdf, no `EDITOR`. Developer tools live in `.zprofile`/`.zshrc`, sourced only by interactive/login shells.

**Note the platform split, which changes the priority for us:** opencode skips the entire probe on Windows (`server.ts:45` — `process.platform === "win32" ? null : getUserShell()`), because Windows assembles the environment from the registry and already carries the full `PATH`. Our primary platform is win32, so **for local dev this is a non-issue** — but we ship `mac: target: [dmg, zip]`, and that's where `server/git.ts`'s `execFile('git', …)`, MCP servers spawning `npx`, `rg`, and `resolveClaudeBinary()`'s `which claude` fallback would all start failing on an installed app while working perfectly under `npm run dev`.

Borrowable near-verbatim: the `-il` → `-l` → nothing ladder; NUL-delimited `env -0` parse splitting at the **first** `=` (so `FOO=bar=baz` survives); a 5s timeout that **does not** fall through to `-l` on timeout (a hanging rc file must not cost 10s of startup); skip nushell (`env -0` isn't its syntax); and the **merge direction `{...shell, ...app}`** so a user's exported `CRW_*` in their rc file can't hijack configuration. Their `shell-env.test.ts` pins the parse and the nushell cases.

### 4.3 One sanitized key per entity, and never let the two sides drift

`windows.ts:55,157-173,281-289` derives **every** per-window filename from one `randomUUID()`, sanitized with the same `[^a-zA-Z0-9._-] → -` rule on both sides — `window-state-<id>.json` in main, `opencode.window.<id>.dat` in the renderer — and the renderer's name is **pinned in a comment to `windowStorage()` in the shared package** so two independently-written names can't drift. Restore is "one window per persisted id, or a single fresh uuid if the list is empty" — not "always create one and also restore N".

### 4.4 Assorted

- **`process.chdir(homedir())` at boot** — same class as §1.1; pin cwd before anything resolves relative paths.
- **Lazy store resolution** (`store.ts:11-14`): `new Store()` at module scope binds to the *default* `userData`, beating a later `app.setPath("userData", …)`. Anything that resolves paths at import time before flags are parsed has this bug. **Worth auditing `server/config.ts`** — it reads `~/.claude-react-web/config.json`; if that path is computed at module scope it would precede `--state-dir` parsing.
- **Grandfathering is a snapshot, not a derivation** (`onboarding.ts:12-21`): compute once, persist, return the stored value forever. Re-deriving from the filesystem would flip users retroactively.
- **Updater refinements** (`updater-controller.ts:41,73-77,79-93`): coalesce concurrent checks behind one `pending` promise; on launch, **clear a persisted `ready` record if it equals the running version** (stops nagging after install); on a failed `quitAndInstall`, transition **back to `ready`** so the dialog stays usable. Our `desktop/updater.ts` is already conservative and arguably better than naive (`autoDownload = false`, asks before downloading, no-ops when unpackaged/feedless) — these are the two missing refinements.
- **Attachment single-use token** (`attachment-picker.ts:7-57`): the renderer gets an opaque `randomUUID()` token; `read(sender, token, path)` requires `selection.sender === sender` **and** `paths.delete(path)` (one-shot), and the byte budget is charged on **bytes actually read**, not stat size. If any of our upload/ingest endpoints accept a client-supplied path, this is the pattern.

---

## 5. What we already have — don't rebuild these

Worth stating plainly, because several of the obvious candidates are already done, and in two cases better.

| Mechanism | Status |
|---|---|
| **Stream coalescing / bounded render cost** | **Already have, and tuned for our case.** `src/session-store/store.ts:327` `LIVE_TURN_FLUSH_MS = 80` with a `dirty` flag + chunk accumulation + a `streamedTextMemo` WeakMap keyed on the segment array so `buildSnapshot`'s join is O(1). The comment documents the reasoning: ~80ms (~12fps) reads as smooth for prose while cutting render volume to a third of a 33ms flush. OpenCode batches at 16ms (60fps) with adjacency coalescing before dispatch — a different point on the same curve, not a gap. **One piece we may lack:** their read loop does `await wait(0)` every `STREAM_YIELD_MS = 8` so a saturated stream can't starve the renderer; our per-frame reducer run is unavoidable. Cheap to add if profiling ever shows starvation. |
| Transport abstraction (`Transport`/`TransportConnection`, web + desktop impls) | Have. Missing only that the *target* isn't part of transport identity (§2) |
| Per-subscriber queues so a slow client can't block the pump | Have (documented in CLAUDE.md) |
| Replay + `subscribe-result` explicit reason | Have — and codex's deep-link queue is the same ordering rule, independently arrived at |
| Backpressure recovery | Have (`ws-backpressure-recovery`) |
| App plugins + marketplace, scheduled sends, uploads, subagents/workflows/skills, metrics + perf panel, full git integration, URL-hash session layout sharing | Have |
| **No PTY / terminal panel** | Genuine gap. They use `ghostty-web` (WASM Ghostty, `Ghostty.load()`) — not xterm.js |
| **No i18n** | Genuine gap. OpenCode has 64 locale dicts with a two-source merge (`{...en, ...uiEn}` flattened, missing keys fall back to English), per-locale code splitting via a static `() => import()` record, `loadInitialLocale()` awaited before `createRoot`, and a `parity.test.ts` enforcing locale completeness |

---

## 6. Prioritized backlog

**Now (bug + cheap wins, < 1 day each)**
1. §1.1 — pass `cwd: homedir()` from `desktop/main.ts` (or `process.chdir(homedir())` at boot). **Real bug, shipped build only.**
2. §1.2 — fix the stale "per-launch random state dir" comment.
3. §1.3 — `requestSingleInstanceLock`.
4. §4.4 — audit `server/config.ts` for import-time path resolution.

**Next (high value, ~1 day each)**
5. §3.1 — protocol drift test + method table.
6. §4.1 — state-dir GC (directly portable).
7. §1.3 — window bounds persistence; `render-process-gone` handling.

**Then (architectural, do before it's expensive)**
8. §2.3 — scoped server identity. The prefix is nearly free now and a migration later.
9. §3.2 — collapse `permission-*`/`elicitation-*`/`dialog-*` into one generic request frame + one resolution broadcast fired from the pending-clear path.

**Opportunistic**
10. §4.2 — shell env probe (do it with the next macOS build).
11. §3.3 — backpressure asymmetry + separate heartbeat channel audit.
12. §3.4 — `emittedAtMs` before fan-out; `RedactedString` for tokens.
13. §1.3 — deep-link handler for `crw://` (enables `--cwd X` CLI→app handoff).

## Appendix: verification log

| Claim | Method | Status |
|---|---|---|
| We already have an Electron host | `git ls-files \| grep -iE "electron\|desktop"` | ✅ |
| Desktop host passes no `cwd` | `desktop/main.ts:180`, `server/bootstrap.ts:177`, `server/app.ts:243` | ✅ read |
| fs picker start point is `process.cwd()` | `server/fs-routes.ts:66` | ✅ read |
| Stale state-dir comment | `desktop/main.ts` header vs line 180 | ✅ read |
| No single-instance lock / window state / crash handling / shell-env / deep links | grep over `desktop/` → all empty | ✅ |
| Client is same-origin only | `src/transport/web.ts:15-19` | ✅ read |
| Persisted keys are unscoped | `src/theme.ts`, `server/ui-state-store.ts` | ✅ |
| **Stream coalescing already exists** | `src/session-store/store.ts:327,766-772` | ✅ read |
| No PTY / terminal | `package.json` has no `node-pty`/`@xterm/*` | ✅ |
| `shared/ws-protocol.ts` is hand-written, no codegen | no codegen script in `package.json` | ✅ |
| OpenCode desktop = Electron + SolidJS, no React | `packages/desktop/package.json`, `packages/app/package.json` | ✅ code |
| OpenCode dead `install-cli` channel | `preload/index.ts:15` vs absence of handler in `src/main` | ⚠️ agent-reported |
| Codex protocol drift tests | `app-server-protocol/src/schema_fixtures_tests.rs` | ⚠️ agent-reported |
| Codex backpressure / attestation / transport details | `app-server-transport/src/**`, README | ⚠️ agent-reported |
| OpenCode app-layer patterns (ServerConnection, context, i18n, persist) | `packages/app/src/**` | ⚠️ agent-reported |

Rows marked ⚠️ come from subagent deep-reads with `file:line` citations; I read the §1, §2, §5 rows myself. Worth spot-checking a claim before acting on it.