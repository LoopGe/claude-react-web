# Terminal Management Subcommands for claude-react-web

Date: 2026-09-04 · Status: Draft for review

## Background

`claude-react-web` is a single `npx` binary that today only **launches the local
Web UI** (`server/cli.ts`): a flat flag parser plus `buildApp()`/`serve()`. There
is no way to manage the persisted config surfaces — global MCP servers
(`mcp-config.json`), the git-repo plugin marketplace (`marketplaces.json`), the
App-plugin marketplace (`app-plugins/marketplaces.json`), `config.json`, or the
session store — without opening the browser.

We want terminal subcommands, in the spirit of the `claude` CLI, so power users
can run management operations headless and scriptable: `claude-react-web mcp add
…`, `claude-react-web marketplace add <url>`, etc.

This spec is scoped to **management/config subcommands only**. Interactive
"print a prompt and stream an answer" modes (`-p`, `--continue`, `--resume`)
are **out of scope** (separate future work).

## Goals

- Add a subcommand layer to the `claude-react-web` bin. **No subcommand = today's
  server-launch behaviour, unchanged.**
- Each subcommand runs once, headless: no HTTP server, no port, no live
  sessions, no `buildApp`, exits when the operation finishes.
- Subcommand syntax **aligns with the Web UI / on-disk store field names**
  (`--type stdio`, `--command npx`, `--env KEY=V`, `--url`, `--headers K=V`),
  **not** the `claude mcp add … -- cmd args` form.
- Reuse the existing store classes and standalone helpers; extract the few
  inline route orchestrations into shared functions so CLI and REST do not
  diverge.
- Testable: command modules return structured data; a thin dispatcher renders.

## Non-goals (explicitly excluded from v1)

- `-p/--print`, `--continue`, `--resume`, stdin-pipe Q&A, stream-json output.
- Interactive REPL.
- Enabling/disabling **agent** plugins from the marketplace (mp-store
  `plugin enable/disable`): needs live-session plugin reload semantics; defer.
- Enabling/disabling **app** plugins (`enable` activates a plugin subprocess —
  inappropriate for a one-shot headless process).
- Remote MCP **OAuth** flows (browser-callback only). `mcp test` reports
  `needs-auth` and points at the Web UI.
- Editing `authToken`/`accessToken` directly through `config set` (secrets on a
  command line are a footgun; `config.json` stays the place for raw tokens).

## Terminology

- **mp / plugin marketplace** — the "homegrown git-repo marketplace"
  (`MpStore`, `server/mp-store.ts`, `<stateDir>/marketplaces.json`). A git repo
  containing `.claude-plugin/marketplace.json` (or `plugin.json`); enabled
  plugins are injected into agent sessions as `Options.plugins`. CLI group name:
  `marketplace`.
- **App-plugin marketplace** — the app-shell extension marketplace
  (`AppPluginMarketplaceStore`, `server/app-plugins/marketplace-store.ts`,
  `<stateDir>/app-plugins/marketplaces.json`). A GitHub repo with an
  `app-plugins-marketplace.json` catalog (or auto-scanned `crw-plugin.json`).
  CLI group name: `app-plugin`.
- **Provider profile / config** — `server/config.ts` (`<stateDir>/config.json`).
- **Sessions** — `SessionStore` + `SessionManager` persisted metadata.

## Architecture

### Dispatch: top-level subcommand routing in `server/cli.ts`

`main()` currently: `parseArgs` → `loadConfig(stateDir)` → construct *every*
store + `SessionManager` + `AppPluginManager` → `buildApp` → `serve` → signal
handlers.

New flow:

1. `parseArgv(process.argv.slice(2))` returns
   `{ stateDir?: string; command?: string; commandArgv: string[]; serverArgv: string[] }`.
2. `await loadConfig(stateDir)` once (all modes).
3. If `command` is set → `await runCliCommand(command, commandArgv, { stateDir })`
   then return (process exits naturally).
4. Else → existing server path (`runServer(serverArgv)`), byte-for-byte current
   behaviour except `parseArgs` reads `serverArgv`.

**Detection rule:** a `--state-dir <path>` / `--state-dir=<path>` token pair is
stripped from argv *anywhere* and captured first (valid in both modes). After
stripping, if the **first remaining token does not start with `-`** and equals a
known command name, it is a subcommand; the rest of the argv is `commandArgv`.
Otherwise the whole original argv goes to the server parser.

Examples:

```sh
claude-react-web                       # server mode (unchanged)
claude-react-web --port 3456           # server mode (unchanged)
claude-react-web mcp list              # subcommand
claude-react-web --state-dir ~/x mcp list
claude-react-web mcp list --state-dir ~/x     # --state-dir accepted anywhere
claude-react-web mcp --help            # per-command help
```

`--version`/`--help` with no subcommand keep today's behaviour; the top-level
`HELP` text is extended with a command list.

### Context loading: lazy, per group

`server/cli/context.ts` exports a loader that constructs **only** what a group
needs. Each store is created with `{ stateDir }` and `.load()`ed on first
access. Groups:

| Group | Loads |
|---|---|
| `mcp` | `McpConfigStore` |
| `marketplace` | `MpStore` |
| `app-plugin` | `AppPluginStore`, `AppPluginMarketplaceStore`, then a **minimal** `SessionManager` (`new SessionManager({ stateDir })`) + `AppPluginManager` constructed with `safeMode: true` (nothing can activate a plugin subprocess) |
| `config` | config via `loadConfig` + `readConfigFile`/`updateConfigFile` |
| `sessions` | `SessionStore` + `new SessionManager({ store, stateDir })` |
| `doctor` | config + `resolveClaudeBinary` |
| `update` | config (for `updateCheckRegistry`) + `checkForUpdates` |

### Module layout

```
server/cli.ts                              # bin entry: dispatch (+ runServer)
server/cli/
  types.ts        # CliContext, CliCommand, flag/arg helpers
  parser.ts       # shared flag parser (repeatable flags, --json, --yes)
  render.ts       # table/text formatting helpers; masks secrets
  context.ts      # lazy store/manager loader (above)
  mcp.ts
  marketplace.ts      # agent-plugin marketplace (mp-store)
  app-plugin.ts       # app-plugin marketplace + registry ops
  config.ts
  sessions.ts
  doctor.ts
  update.ts
server/mp-ops.ts                            # NEW shared orchestration (agent-plugin mp)
server/app-plugins/marketplace-ops.ts       # NEW shared orchestration (app-plugin mp)
server/routes/mp-marketplace.ts             # MODIFIED: add handler → calls mp-ops
server/routes/app-plugins/marketplace-routes.ts  # MODIFIED: add handler → calls app-plugins marketplace-ops
```

All files under `server/cli/` are imported by `server/cli.ts` and thus bundled
into the existing single-file `dist/cli.mjs` by `build.mjs`; **no `package.json`
`bin` change and no build change**.

### Shared orchestration extraction

Two inline route sequences become shared functions so the REST API and CLI call
the same code (single source of truth at the store level):

1. `server/mp-ops.ts` → `addMarketplaceByUrl(store: MpStore, opts: { url: string; ref?: string })`
   returns `{ entry: MpEntry; warnings: ParseWarning[] }`.
   Body is lifted verbatim from `mp-marketplace.ts` `POST /mp/marketplaces`
   (`:175–229`): `assertHttpsUrl` → `store.generateId` → `cloneDirFor` → `mkdir`
   → `gitClone` → `parseRepoManifest` (rm clone on parse failure) →
   `gitGetHeadSha`/`gitBranchName` → build `MpEntry` → `store.upsert` + `flush`.
   The route handler becomes a thin wrapper returning `{ ok, entry, warnings }`
   via the existing `toListItem`.

2. `server/app-plugins/marketplace-ops.ts` →
   `addAppPluginMarketplaceByUrl(store: AppPluginMarketplaceStore, opts: { url: string; ref?: string; subdir?: string })`
   returns `{ record: AppPluginMarketplaceRecord }`. Lifted from
   `marketplace-routes.ts` `POST /` (`:39–88`). The route handler becomes a thin
   wrapper.

Other v1 operations map **directly onto store methods** — no extraction needed:

- `MpStore.removeEntry(id)`, `MpStore.list()`, `marketplace list` reads
  `store.list()`.
- `McpConfigStore.list/upsert/remove` + `validateMcpServer` + `maskSecrets` +
  `testMcpConnection` (all already exported).
- `AppPluginStore.list` / `AppPluginManager.uninstall` / `.recordsForMarketplace`
  / `.install({ type: 'marketplace', marketplaceId, pluginName })`.
- `readConfigFile`/`updateConfigFile` from `server/config.ts`.
- `SessionManager.list()` / `.delete(id)`.

Live-session broadcasts (e.g. `applyToggleToLiveSessions`, `revalidatePlugin`
fan-out over the WS bus) are **intentionally absent** in CLI flows: there are no
live sessions in a one-shot process. Mutations persist; the next server boot
reads them.

## Command surface (v1)

Common rules:

- Every command accepts `--json` (structured data on stdout, no tables) and
  `--help`.
- Destructive commands require `--yes` (mirrors the REST `confirm: true`
  contract).
- `--env KEY=V` / `--headers K=V` are repeatable; `=`-split on first `=`.
- Unknown option → usage error on stderr + exit code `2` (matches today's
  `parseArgs`). Operation failure → stderr message + exit code `1`. Success → `0`.

### `mcp`

| Command | Args | Notes |
|---|---|---|
| `mcp list` | | table: name, type, command\|url, enabled, alwaysLoad, envKeys, headerKeys |
| `mcp add <name>` | `--type stdio\|sse\|http` (default stdio), stdio: `--command <cmd>` `--args '<json array>'` `--env K=V…`; sse/http: `--url <url>` `--headers K=V…`; `--always-load`; `--disabled` | validates via `validateMcpServer` (stdio command allowlist, url required for remote). Name collision → error |
| `mcp update <name>` | same flags, partial | env/headers **merge** (PUT semantics), scalars replace |
| `mcp remove <name>` | `--yes` | |
| `mcp enable <name>` / `mcp disable <name>` | | sets `enabled` |
| `mcp test <name>` | | `testMcpConnection`; `needs-auth` → exit non-zero + "authorize in the Web UI" hint |

### `marketplace` (agent-plugin marketplace, mp-store)

| Command | Args | Notes |
|---|---|---|
| `marketplace add <url>` | `--ref <ref>` | via `addMarketplaceByUrl`; network clone |
| `marketplace list` | | table: id, displayName, plugins(n), enabled, addedAt |
| `marketplace remove <id-or-url>` | `--yes` | `MpStore.removeEntry` (no live-session push) |

### `app-plugin`

| Command | Args | Notes |
|---|---|---|
| `app-plugin marketplace add <url>` | `--ref`, `--subdir <dir>` | via shared op; network clone |
| `app-plugin marketplace list` | | |
| `app-plugin marketplace remove <id>` | `--yes` | constructs manager (`safeMode`); uninstalls installed plugins first, then `store.removeEntry` |
| `app-plugin list` | | table of installed AppPlugin records (id, marketplace, version, enabled, status) |
| `app-plugin install <marketplaceId>:<pluginName>` | | `manager.install({ type:'marketplace', … })`; marketplace must already be added |
| `app-plugin uninstall <id>` | `--yes` | `manager.uninstall(id, { deleteData:false })` |

### `config`

| Command | Args | Notes |
|---|---|---|
| `config get [key]` | | curated view identical to `GET /config/full`; tokens masked `****+last4`; bare `config get` prints all keys, `config get <key>` prints one value |
| `config set <key> <value>` | | only `WRITABLE_CONFIG_KEYS` allowed (unknown key → error, unlike REST which drops silently). `null`/`''` clears the key. Value parsed as JSON when valid, else kept as a bare string. Warning printed when writing `profiles` that embed an `authToken` |

### `sessions`

| Command | Args | Notes |
|---|---|---|
| `sessions list` | | merged live + persisted view via `SessionManager.list()` |
| `sessions delete <id>` | `--yes` | `SessionManager.delete(id)` (full sidecar cleanup) |

### `doctor`

`doctor` — runs checks and prints a table: authToken configured (and which
profile is active), `baseUrl`, config.json parseable, stateDir exists+writable,
`claude` binary resolvable (`resolveClaudeBinary`, optional `--claude-binary`),
mcp-config/marketplaces files valid JSON. Exit `0` when all pass, `1` when any
fails. Each check prints how to fix a failure (edit `config.json`, `config set
…`, `--claude-binary`).

### `update`

`update` — `checkForUpdates()`; prints current, latest (if any), and the
upgrade command (`npx claude-react-web@latest`). No `--json` secrets; result is
the `UpdateInfo` shape.

## Output & formatting

- **stdout** carries only the command result (human table/text, or `--json`).
- **stderr** carries progress (git clone messages), warnings, and errors.
- Diagnostics use `createLogger` (server convention); the logger is **not**
  wired to the CLI result stream.
- Tables are simple fixed-width aligned columns (no external dep). JSON output
  is `JSON.stringify(data, null, 2)`.
- No secrets (authToken, env/header values, OAuth) are ever printed by `list`/
  `get`/`add` — masking mirrors `maskSecrets` and the config route's
  `****+last4`.

## Error handling & exit codes

- `2` — usage error (unknown command/option, missing required arg).
- `1` — operation failure (store/network/validation); message on stderr.
- `0` — success (and `doctor` all-pass).

The command modules never call `process.exit` themselves; they throw
`CliError(code, message)` (new, in `server/cli/types.ts`) or return structured
data. `runCliCommand` is the only place that maps results/exceptions to exit
codes — which is what makes the modules unit-testable.

## Security notes

- Reuse `validateMcpServer` so the stdio command allowlist (`node`, `npx`,
  `python`, `docker`, …) applies unchanged to CLI-created servers.
- Reuse `assertHttpsUrl` for marketplace URLs (no `file://` / `git@`).
- `--yes` on every destructive verb (removes/uninstalls/deletes).
- Secrets never echoed in `--json`/tables; `config set` on secret-bearing keys
  warns. `authToken`/`accessToken` are not writable keys.

## Testing plan

Follow the existing server test patterns (`server/routes/mp-marketplace.test.ts`,
`server/__test-utils__/tempDir`/`rmRf`).

- New `server/cli/*.test.ts` per group, calling the exported
  `runCliCommand(group, argv, ctx)` (or per-group `run`) with a temp
  `stateDir`, asserting on the **structured result**, plus a couple of
  render/exit-code assertions through the dispatcher.
- `vi.mock('@anthropic-ai/claude-agent-sdk')` and `vi.mock('…/git-clone.js')`
  wherever a group touches the SDK or the network (git clone/pull/test). Mock
  `gitClone` to materialise an on-disk fixture (existing technique).
- `server/cli.ts` dispatch: export `parseArgv`; unit test detection rules
  (command vs server, `--state-dir` anywhere, unknown command → 2).
- Refactor safety: existing route tests (`mp-marketplace.test.ts`,
  app-plugin marketplace tests) must still pass after the add-handler
  extraction, proving REST behaviour is unchanged.

## Files touched

**New**
- `server/cli/types.ts`, `parser.ts`, `render.ts`, `context.ts`
- `server/cli/mcp.ts`, `marketplace.ts`, `app-plugin.ts`, `config.ts`,
  `sessions.ts`, `doctor.ts`, `update.ts`
- `server/mp-ops.ts`, `server/app-plugins/marketplace-ops.ts`
- tests alongside each module + `server/cli.test.ts`

**Modified**
- `server/cli.ts` — dispatch + `runServer` split; export `parseArgv`;
  extended `HELP`
- `server/routes/mp-marketplace.ts` — add handler delegates to `mp-ops`
- `server/routes/app-plugins/marketplace-routes.ts` — add handler delegates to
  app-plugin marketplace-ops

## Implementation order (for the future plan)

1. `server/cli/types.ts` + `parser.ts` + `context.ts` + dispatch refactor in
   `server/cli.ts` (no commands yet; detection tests green; server path green).
2. `mcp` group (pure store — lowest risk) + tests.
3. `marketplace` group + `mp-ops.ts` extraction + route refactor + tests.
4. `config` + `sessions` groups + tests.
5. `app-plugin` group + app-plugin marketplace-ops extraction + manager-context
   + tests.
6. `doctor` + `update` + top-level HELP + README/CONFIG.md notes.

Each step lands independently; nothing in steps 1–5 depends on the app-plugin
manager being built first.
