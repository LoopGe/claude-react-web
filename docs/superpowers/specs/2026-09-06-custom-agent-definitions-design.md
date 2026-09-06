# Custom Agent Definitions — Design

Date: 2026-09-06
Status: Proposed

## Problem

The claude-react-web app surfaces the SDK's built-in agents read-only
(`GET /sessions/:id/agents` → `Query.supportedAgents()`), but can't define or
use custom `Options.agents` (`Record<string, AgentDefinition>`). Two SDK-native
capabilities are therefore unreachable from the UI:

1. **Custom subagents** — programmatically-defined agents (name + prompt + tools
   + model + …) that the main thread can spawn via the Agent tool. Delivered by
   passing `Options.agents` at spawn.
2. **Start a session "as" an agent** — drive the main thread with a custom
   agent's config; its `initialPrompt` is auto-submitted as the first user turn.
   Delivered by passing `Options.agent: <name>` (plus the agents map) at spawn.

This design adds a persisted global store of custom agent definitions, injects
them into every session at spawn, exposes a management UI, and surfaces a
start-as entry point. It does **not** implement per-session opt-in, auto-restart,
or a `.claude/agents/` filesystem bridge.

## Scope decisions (confirmed)

- **Approach**: A — global store, global injection (`Options.agents` set on every
  spawn, like `mpStore` does for plugins). **Selected.**
- **Field coverage**: **full** — every `AgentDefinition` field is exposed. No
  truncation.
- **Application timing**: restart-to-apply — definitions take effect on
  sessions spawned after the change; running sessions get a "restart to apply"
  hint, **no** auto-respawn.
- **UI placement**: management lives in a new `SettingsPanel` **Agents** tab;
  start-as lives in `NewSessionDialog`.

## Constraints

- Agents are **spawn-time only** — the `Query` surface has `reloadPlugins()` and
  `reloadSkills()` but **no `reloadAgents()`**, so a definition edited after a
  session spawns will not reach that running process. Any "apply" story must be
  spawn/new-session-scoped.
- `initialPrompt` only fires **when the agent is the main-thread agent** (i.e.
  selected via `Options.agent`), not when spawned as a subagent. This is exactly
  the split that justifies supporting both use-cases.

## Empirical unknowns (de-risk with a spike before implementation)

1. Do injected `Options.agents` surface in `Query.supportedAgents()` and in the
   in-session Agent tool picker? (Determines whether `GET /sessions/:id/agents`
   must explicitly union-in the store's enabled definitions.)
2. When `Options.agent` selects the main-thread agent, does the CLI honor the
   definition's `model` / `permissionMode` / `effort` and auto-run
   `initialPrompt` — and how does that merge with top-level `Options.model`?
   (Determines whether NewSessionDialog should mirror the def's model into the
   create body, or rely on `Options.agent` alone.)

Both are cheap to probe with a throwaway script against a real `query()`; if
either answers "no," the fallback is explicit in the design (union-in the list;
copy the def's model/permission into the create body). Treat spike output as
decisive and update this spec (only the affected integration detail) before
planning.

---

## 1. Data model (server)

New global store, persisted to `<stateDir>/agent-definitions.json`, following the
existing `JsonFileStore` pattern (`server/json-file-store.ts`, used by
`SnippetStore`, `McpConfigStore`, `UiStateStore`, uploads, mp-store).

```
StoredAgentDefinition {
  name: string                // key, required, unique, stable id
  enabled: boolean            // default true; false defs are not injected
  // ---- AgentDefinition, verbatim, no truncation ----
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  mcpServers?: AgentMcpServerSpec[]
  skills?: string[]
  memory?: 'user' | 'project' | 'local'
  effort?: EffortLevel | number
  permissionMode?: PermissionMode
  maxTurns?: number
  background?: boolean
  initialPrompt?: string
  observer?: string
  observerMessage?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  // ---- bookkeeping ----
  createdAt: number
  updatedAt: number
}
```

Keyed by `name` (also the `Options.agents` key). `mcpServers` is stored as
`AgentMcpServerSpec[]` (string server names; the `{ name: config }` record form
is accepted verbatim if provided). Order is preserved (base `JsonFileStore`
preserves `Map` insertion order — meaningful because it doubles as the Agents-tab
display order).

## 2. Store (`server/agent-definition-store.ts`)

`AgentDefinitionStore extends JsonFileStore<StoredAgentDefinition>`:

- `constructor(opts)` → `super(opts, 'agent-definitions.json', DEFAULT_DIR_NAME, 'agent-definitions')`
- `getKey(def)` → `def.name`
- `parseItems(raw)` → array; drops malformed entries defensively
- `serializeForWrite(items)` → plain array (preserve order)
- `load()` → default-missing/corrupt → empty store
- expose:
  - `getEnabledDefinitions(): Record<string, AgentDefinition>` — strips
    `name`/`enabled`/`createdAt`/`updatedAt`, returns only `enabled` defs in
    `Options.agents` shape (the physical injection payload; schema-derived via a
    pick).
  - `getDefinition(name)`, `exists(name)`, `upsert`, `remove` — base-provided.
  - `coerceStoredAgentDefinition(raw)` module export, defensive parse.

## 3. Routes (`server/routes/agent-definitions.ts`)

Mounted under `/api/agent-definitions` in `server/app.ts` **only when the store
is provided** (mirrors snippet/mcp-config mounting).

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/agent-definitions` | list all defs |
| `POST` | `/agent-definitions` | create; `name` uniqueness → 409 on dup |
| `PUT` | `/agent-definitions/:name` | update (name immutable; rename = delete+create) |
| `DELETE` | `/agent-definitions/:name` | remove |

Shape validation shared with the client form (validate required `name`/
`description`/`prompt`; enum membership for `memory`/`permissionMode`/`effort`;
string/number/bool type checks; finite numbers) → 400 on malformed input.

## 4. Spawn injection (server)

In `server/providers/claude/claude-provider.ts` `applyStandardQueryOpts`
(alongside the existing `if (this.opts.mpStore)` block, ~line 620):

```ts
if (this.opts.agentStore) {
  const agents = this.opts.agentStore.getEnabledDefinitions()
  if (Object.keys(agents).length > 0) {
    opts.agents = { ...agents, ...(opts.agents ?? {}) }
  }
}
```

- `agentStore` is threaded **exactly along `mpStore`'s path** — not a direct
  app→provider route:
  `cli.ts` (instantiate) → `app.ts` (`opts.agentStore`, passed into the
  `SessionManager` options, mirroring `mpStore` at app.ts:137) →
  `session-manager.ts` `createDefaultProviders({ claudeBinary, mpStore,
  onProcessExit, agentStore, … })` (session-manager.ts:477) → claude-provider
  `ClaudeProviderOptions.agentStore` (mirroring `mpStore` at claude-provider.ts:182).
  The route router receives the store separately, via `buildApiRouter`
  (app.ts:215), so `server/routes/agent-definitions.ts` is mounted there.
- This makes every session — create, resume, fork, respawn — expose all enabled
  custom agents as subagents automatically.

### Start-as-agent

- `POST /sessions` accepts `agent?: string`; validated against the store (unknown
  or disabled name → 400). Provider passes `agent` → `Options.agent`.
- `snapshotMeta` captures `agent` onto `SessionMeta`, so resume/fork/re-spawn
  re-apply it (same multi-point propagation as `model`/`thinking`: snapshotMeta
  at session-manager.ts:982; `resumeOpts.agent = meta.agent` at :1241-1268;
  forkOpts at :1545-1601).
- **Resume/fork guard**: a start-as agent may have been deleted or disabled since
  the session's meta was written. When resuming or forking, only set `agent` if
  the name still exists **and** is enabled in the current store; otherwise drop
  it and log a warning (resume as a normal session rather than point
  `Options.agent` at an un-injected definition).
- If spike #2 shows `Options.agent` does **not** carry the def's `model`
  /`permissionMode`/`effort`, mirror those fields into the create body
  (pre-fill from the def in NewSessionDialog).

### Agents list union

`GET /sessions/:id/agents` (`server/routes/sessions.ts:834`) returns
`sm.supportedAgents()`. Regardless of spike #1's answer, server-side **union** the
store's enabled definition names into the returned agent list so custom agents
are always visible in the client's agent list. **De-dupe on name collision** with
a built-in agent: the built-in entry wins; the custom definition is offered under
a `custom:` namespace marker in the payload if colliding names are shown.

## 5. Client

### Management — `SettingsPanel` **Agents** tab

- Add `'agents'` to `SettingsTab` union + `tabs` array (`src/components/SettingsPanel.tsx:45,832`).
- List view: each row = name, description, enabled toggle, edit / duplicate /
  delete.
- Edit *or* create form (full fields), grouped:
  - **Basic** — `name`, `description`, `prompt`
  - **Tools & Capabilities** — `tools`, `disallowedTools` (tag inputs — tool names
    are open-ended incl. `mcp__*`, so a fixed picker is wrong), `model`,
    `mcpServers`, `skills` (tag inputs), `effort` (select), `permissionMode`
    (select)
  - **Runtime** — `maxTurns` (number), `background` (toggle), `memory` (select),
    `initialPrompt` (textarea; used by start-as)
  - **Advanced (collapsible)** — `observer`, `observerMessage`,
    `criticalSystemReminder_EXPERIMENTAL`

### Start-as — `NewSessionDialog`

- Add an **Agent** dropdown: `None` (normal session) + each enabled custom
  definition.
- Selecting an agent pre-fills `model`/`permissionMode`/`effort` from the def
  (see spike #2) and sends `agent: <name>` in the create body.
- A hint line explains what start-as does (auto-submits the def's `initialPrompt`
  as the first turn).

### Restart-to-apply

- Spawn-time constraint means definitions only reach sessions started *after* a
  change. Lightweight notification, no auto-respawn:
  - On any successful `POST/PUT/DELETE /api/agent-definitions`, broadcast a global
    `agents-updated` WS event (mirrors the `git-status-changed` broadcast shape).
  - Client shows a one-time toast: "Custom agents changed — new/restarted
    sessions will see the update." Running sessions that want the change can be
    restarted manually.

## 6. Error handling

- **Store layer**: corrupt/non-array/malformed entries dropped on `load()` (fail
  soft, spawn unaffected); store load failure → empty store.
- **Route layer**: shape validation → 400; duplicate `name` → 409; unknown or
  disabled create `agent` → 400.
- **Resume/fork layer**: stored `agent` missing or disabled in the current store
  → drop the selection + log a warning, never fail the resume/fork.
- **Client form**: shared validator with routes; inline field errors; save blocked
  while invalid.

## 7. Testing & verification

**Spike (de-risking, throwaway, before implementation):**
1. `supportedAgents()` reflectivity of injected `Options.agents`.
2. `Options.agent`-as-main-thread honoring `initialPrompt` + def `model`/merge
   with `Options.model`.

**Unit/integration (TDD where applicable):**
- `agent-definition-store.test.ts` — getKey/parse/coerce/upsert/remove/
  getEnabledDefinitions/bootstrap. (Mirror `snippet-store.test.ts`.)
- `agent-definitions routes test` — validation 400s, 409 dup name.
- Provider spawn injection test — `Options.agents` set from store; `Options.agent`
  set for start-as; `getEnabledDefinitions` strips bookkeeping fields.
- `snapshotMeta` / resume / fork — `agent` survives resume & fork (mirror
  existing model/thinking propagation tests); **resume with a deleted/disabled
  start-as agent degrades to a normal session**.
- `/sessions/:id/agents` — union includes store defs; built-in name collision
  de-dupes (built-in wins).
- Client — form validation + rendering.

**Manual:**
- Create a def → new session sees it as a subagent.
- Start a session as an agent → `initialPrompt` auto-runs as first turn.
- Edit store while session open → toast, no crash, no forced restart.

## 8. Explicitly out of scope

- Per-session opt-in of which agents load (Approach B).
- Auto-respawn of running sessions on definition change.
- `.claude/agents/*.md` filesystem bridge (Approach C).
- Rename-in-place (name is the immutable key).