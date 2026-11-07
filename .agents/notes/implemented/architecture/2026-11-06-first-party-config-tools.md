# Agent Note: First-party config tools ship as three in-process MCP servers

Status: implemented

## Problem

The server already owns three configuration surfaces — skill files, the global
MCP server store, and the Claude plugin marketplace — but every one of them is
reachable only through REST routes. A user has to leave the conversation and
operate the Settings panels; the model itself has no way to configure what it
is allowed to use. The common requests ("set up the playwright MCP", "install
the document-skills plugin from this git repo", "create a skill for X") all
require the agent to act on host configuration.

Three constraints shaped the solution:

- Registry controls — whether a server is enabled, its read-only exemption and
  its mutating-tool set — are **per server**, not per tool.
- The three domains depend on **independent stores** (skill directories on
  disk, `mcp-config.json`, `mp-store`), so a single server would couple them
  and force every store to exist for any one capability.
- A tool handler runs inside one session's CLI subprocess and some operations
  must act on **that** session (attaching a newly added MCP server), while the
  same handler must also be buildable for metadata listing with no session at
  all.

## Decision

Three production in-process MCP servers are code-registered in
`FirstPartyToolRegistry`, all default-enabled and individually switchable in
Settings' first-party section:

- **`skills-tools`** — `list` / `get` / `validate` / `create` / `update` /
  `delete` for user- and project-scope skills. Project scope binds the calling
  session's cwd; every write calls `reloadSkillsForCwd` so the live Query
  re-discovers the change.
- **`mcp-tools`** — `list` / `get` / `add` / `update` / `remove` /
  `set_enabled` / `test` over the global MCP store. `add` and
  `set_enabled(true)` attach the server to the calling session by default
  (`attachToSession: false` opts out); `remove` and `set_enabled(false)`
  detach it.
- **`marketplace-tools`** — `list` / `plugins` / `add` / `check_updates` /
  `set_plugin_enabled` for the Claude plugin marketplace. Enabling a plugin is
  installing it, and the flag is pushed to every live session.

`registerConfigToolServers` runs from `createServerContext` once the
`SessionManager` and both stores exist, skipping names that are already
registered. The mutating store logic is extracted into `server/mcp-ops.ts` and
`server/mp-ops.ts` and used by both the tool handlers and the existing REST
routes, so the agent and the UI execute the same code instead of two copies
that can drift.

### Why three servers, not one

Every registry knob the host exposes — enable/disable, the read-only set the
permission broker exempts, and the mutating set that schedules a git-snapshot
broadcast — is scoped to a server. Combining the domains into one `config-tools`
server would make "enable MCP configuration but not marketplace writes"
inexpressible, would attach the mutating verdict of a skill write to a
marketplace toggle, and would force all three stores to be present for any one
domain. Three servers also let the failure of one domain's build be isolated by
`injectAll`, which skips only the failing server.

### Session identity rides in the `buildTools` context

`buildTools(cwd, ctx?)` now receives a `FirstPartyToolBuildContext` whose
`sessionId` is present only when the host builds a server for a real session;
`listToolDefs()` builds with no context for metadata. A cwd cannot identify a
session — several sessions can share the same working directory, and inferring
would attach a server to the wrong one. Handlers that need the session throw a
clear error when `sessionId` is absent; the metadata build never executes a
handler, so that error is not reachable in normal operation. This keeps the
session out of the tool parameters: the model never supplies (or sees) an id it
does not know.

### MCP attach is a two-phase membership decision

Adding a server writes the global store and then applies it to the calling
session. The session's own list and the runtime set are distinct truths:

- A session with an explicit `mcpServerNames` list **owns** its set, so the
  attach re-stamps that list.
- A session with `mcpServerNames === undefined` **inherits** the global enabled
  set. The attach must not pin it to a snapshot of today's globals — that would
  silently freeze the session against future global changes — so it applies the
  merged set through `setMcpServers` with `stampNames: false` and leaves the
  list undefined.
- Idempotency keys on the **runtime** set (`Object.keys(dynamicMcpServers)`),
  never on global membership: a globally enabled server added after the session
  spawned is not connected to it yet and still needs an attach.
- Inline (session-only) entries in `dynamicMcpServers` are carried through the
  plan, because `setMcpServers` replaces the dynamic set.

`remove` / `set_enabled(false)` mirror this: the global change lands first and
the calling session detaches; other live sessions keep their connection until
their next spawn picks up the global state. That is the existing semantics of
global configuration, not a new scope expansion.

### Live apply is synchronous, inside the handler

Write tools `await` the SDK control request in the handler rather than
scheduling work after the tool result. A throwaway spike on 2026-11-06 ran a
real `query` whose in-process MCP handler synchronously awaited
`setMcpServers` (payload containing the running server plus a new stdio
server) and `applyFlagSettings`:

- `setMcpServers` resolved normally in the handler
  (`{"added":["spike-echo"],"removed":[],"errors":{}}`) in about 0.9 s;
- `applyFlagSettings` resolved in about 20 ms;
- after the handler returned, the model could see and call the new server's
  tool (`mcp__spike-echo__echo` → `ECHO:hello`) in its **next assistant request
  within the same user turn**. One run instead had the model pre-judge the tool
  as invisible and skip the attempt; the successful runs came after the prompt
  forced a trial first, so same-turn visibility was established by those
  forced-attempt runs — the CLI's schema had refreshed and the model's prior
  was the variable.

The SDK source also confirms that `setMcpServers` only settings-diffs a
same-name SDK server — it does not reconnect or replace the instance currently
executing the tool call — so the feared self-restart does not happen. The
contract that follows: the handler awaits the live apply; the `setMcpServers`
payload includes **every** first-party server (the host's `injectAll` already
guarantees this, and replace semantics would otherwise drop them); the real
`added` / `removed` / `errors` are returned to the model. A live-apply failure
does not roll back the global save — writing the config was the user's intent —
but the error is reported so the model cannot claim a server is active when it
is not.

## Alternatives considered

**One combined `config-tools` server.** Rejected: registry enablement,
read-only exemption and mutating-tool detection are all server-scoped, the
three domains depend on unrelated stores, and a user may want only one domain
available. One server would couple the knobs and force all stores to exist
together.

**Defer live apply until after the tool result (a background queue).** Rejected:
the model could not use a server it just configured in the same turn, and it
would require a `wait_ready`/`deferAfterResult` protocol plus readiness state.
The spike showed the direct `await` resolves, so the extra machinery buys
nothing.

**Apply the change at the next turn boundary.** Rejected for the same reason:
the natural follow-up ("now use that server") would fail. It also adds a
pending-state model that every later reader has to understand.

**Let the model pass the session id as a tool parameter.** Rejected: the model
does not know its session id, and trusting a model-supplied id would let one
session's tool mutate another session's MCP set. Threading the id through
`buildTools` keeps the binding host-controlled.

## Consequences

- Every session now gets three additional default-enabled tool servers. They
  are visible and individually switchable in Settings; a user who does not want
  the agent configuring their setup can turn them off.
- Global config writes persist even when the live attach fails. This is
  deliberate (the save is the user's intent), but it means the model must read
  and report the returned error rather than assuming success.
- `remove` / `set_enabled(false)` only detach the calling session; other live
  sessions remain connected until their next spawn, matching the pre-existing
  global-config behavior.
- Marketplace enablement does not materialize a per-session `enabledPlugins`
  pin: the global store stays the truth, and the flag is pushed to live
  subprocesses. Assertions must read the store and the SDK state, not
  `SessionInfo.enabledPlugins`.
- Project-scope skill operations without a session cwd fail loudly instead of
  falling back to the user directory or `process.cwd()` — writing a "project"
  skill into the wrong tree is worse than refusing.
- Read-only tools (`skills-tools` list/get/validate, `mcp-tools` list/get,
  `marketplace-tools` list/plugins/check_updates) bypass the permission prompt;
  every write still goes through the normal broker. `mcp-tools.test` is
  deliberately excluded from the read-only set because it spawns or connects
  to the server.
- Deferred to a later phase: skills remote search/install, marketplace
  `refresh` / `remove`, and in-session MCP OAuth. `mcp-tools.test` reports a
  `needs-auth` status; completing authorization remains a Settings/browser
  flow.
