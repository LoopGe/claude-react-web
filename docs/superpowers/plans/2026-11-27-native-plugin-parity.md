# Native Claude-Plugin Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native session loads the same Claude Plugin Marketplace plugins a claude session uses — commands, agents, hooks, and MCP servers alongside the already-wired skills — with live enable/disable parity.

**Architecture:** A host-side plugin-contribution loader (generalizing `server/plugin-skills.ts`) resolves the enabled plugin set via `mpStore.getEnabledPluginEntries`, parses each plugin's contributions by CLI convention, and feeds native's existing subsystems through a port (the core never imports mpStore). Plugin skills already work; this adds the other four types. MCP uses a native-side two-map composition so plugin servers survive user-driven replaces.

**Tech Stack:** TypeScript (Node server), vitest, the native provider subsystems (commands/skills/hooks/MCP/agents), `shared/hooks.ts` + `shared/skills.ts` parsers, `AgentDefinitionStore`.

**Spec:** `docs/superpowers/specs/2026-11-27-native-plugin-parity-design.md`

## Global Constraints

- Neutrality: the loader/parser live HOST-side (`server/plugin-contributions.ts`); native core (`server/providers/native/**`) consumes via a port (like `NativeSkillPort`). No mpStore/parser import in core. Pins: `native/vocabulary/neutrality.test.ts`, `native/host-free.test.ts`.
- Untrusted input: every plugin manifest/file is untrusted; reuse the marketplace parser's defensive coercion + traversal guards (`plugin-skills.ts:208-220` is the model). Per-plugin failure isolates to errors, never rejects the set or crashes spawn.
- No double-load: native plugin resolution must NOT reach the claude provider path (the CLI loads plugins itself).
- Data-only: contributions are data (markdown/JSON). Plugin hooks `modules` (executable code) are REJECTED per-plugin; no plugin code executes.
- Namespacing: commands/agents/skills use CLI `plugin:name` grammar; hooks precedence flag→settings→plugin→agent (engine's documented order, `hooks/types.ts:9`); MCP global/session wins over plugin, plugin-vs-plugin by key order + warning.
- Agents validate against the closed `AGENT_FIELDS` set (`shared/agent-definitions.ts:25-30`) via `coerceStoredAgentDefinition`; plugin agents must NOT pollute the persisted `agent-definitions.json`.
- Diagnostics via `createLogger(scope)`; metrics labels finite enums only. Never commit unreviewed code; `code-review` the full diff before the final commit.
- COORDINATION: another live session is integrating native-hooks. Before touching `native-session.ts` hooks wiring / `hooks/engine.ts`, confirm against committed HEAD and avoid clobbering their WIP (targeted commits only, never `git add -A`, never `git stash` on the shared tree).

## Review Focus

1. **Plugin MCP dropped on a user-driven `setMcpServers` replace** (the manager builds a user-only map → `replaceAll`): the two-map composition must re-add plugin servers on every user-driven replace. → Task 5 test.
2. **Plugin agent pollutes the user JSON store, or a bare-name plugin agent shadows a user agent**: merged read-only lookup, no store writes, user-wins collision. → Task 3 test.
3. **Plugin hooks `modules` executed, or a bad hooks config crashes spawn**: modules rejected per-plugin, shared validation, contained failure. → Task 4 test.
4. **Malicious manifest path (`../../`) escapes the plugin dir**: traversal guards on every manifest-declared path. → Task 1 test.
5. **Name collision across plugins / vs builtin/user**: `plugin:name` namespacing + catalog precedence. → Tasks 2/3 test.
6. **Native plugin resolution leaks into the claude path (double-load)**: claude provider untouched. → Tasks 5/6 test.

## File Structure

- `server/plugin-contributions.ts` (new) — host-side loader: generalized manifest reader, per-type parsers (commands/agents/hooks/MCP), agent `.md` frontmatter parser, `PluginContributions` record, `listPluginContributions`. (Task 1)
- `server/providers/native/ports.ts` — `NativePluginPort`. (Task 1)
- `server/providers/native-host-adapters.ts` — plugin port adapter backed by mpStore. (Task 1)
- `server/providers/native/commands.ts` + `native-session.ts` — plugin command discovery + catalog precedence. (Task 2)
- `server/providers/native/agent-lookup.ts` (new) + `subagent.ts` + `native-session.ts` + `routes/sessions.ts` — merged read-only agent lookup. (Task 3)
- `server/providers/native/native-session.ts` — plugin `HookSource`. (Task 4)
- `server/providers/native/native-session.ts` + `native-provider.ts` — MCP two-map composition. (Task 5)
- `server/providers/native/native-provider.ts` + `native-session.ts` + `server/mp-ops.ts` — capability flip + live toggle/ripple. (Task 6)
- Tests alongside each; e2e fixture plugin; decision record. (Task 7)

---

### Task 1: Host-side plugin-contribution loader + port

**Files:**
- Create: `server/plugin-contributions.ts`
- Modify: `server/providers/native/ports.ts` (add `NativePluginPort`)
- Modify: `server/providers/native-host-adapters.ts` (plugin port adapter)
- Test: `server/plugin-contributions.test.ts`

**Interfaces:**
- Consumes: `MpStore.getEnabledPluginEntries(enabledPlugins?)` → `EnabledPluginEntry[]` (`{key,name,dir,source,cloneDir}`); `parseSkillFrontmatter` (`shared/skills.ts`); `validateSessionHooksConfig` (`shared/hooks.ts:284`); `coerceStoredAgentDefinition` (`agent-definition-store.ts:129`).
- Produces:
  - `type PluginContributionSource = Pick<MpStore, 'getEnabledPluginEntries'>`
  - `interface PluginContributions { key: string; name: string; dir: string; commands: PluginCommand[]; agents: StoredAgentDefinition[]; hooks: SessionHooksConfig; mcpServers: Record<string, unknown>; errors: PluginContributionError[] }` where `PluginCommand = { name: string; description: string; argumentHint: string; body: string }` (name is the bare command name; namespacing happens at integration), `PluginContributionError = { kind: string; detail: string }`.
  - `listPluginContributions(source: PluginContributionSource, enabledPlugins?: string[]): Promise<PluginContributions[]>`
  - `interface NativePluginPort { listContributions(enabledPlugins?: string[]): Promise<PluginContributions[]> }`

- [ ] **Step 1: Write the failing loader tests**

Fixture plugin dirs (temp): manifest `.claude-plugin/plugin.json` + `commands/*.md`, `agents/*.md`, `hooks/hooks.json`, `.mcp.json`. Assert:
- conventions: `commands/` and `agents/` auto-load; manifest `commands`/`agents` field SHADOWS the dir (only listed files); `hooks/hooks.json` `hooks` matchers load + manifest `hooks` additions; `.mcp.json` + manifest `mcpServers` additions merge.
- agent frontmatter: an `agents/foo.md` with `name/description` frontmatter + body → a `StoredAgentDefinition`-shaped def (prompt = body, enabled true, bookkeeping filled) passing `coerceStoredAgentDefinition`; unsupported fields stripped.
- hooks `modules`: a `hooks.json` with `modules` → a per-plugin error, `hooks` matchers still load (data-only).
- traversal: a manifest `commands`/`agents`/`hooks`/`mcpServers` entry resolving outside the plugin dir (`../../x`) → skipped + error, never read.
- isolation: one corrupt plugin (bad JSON) → its `errors` populated, other plugins still returned; never throws the pass.
- subset: `enabledPlugins: []` → `[]`; `undefined` → all enabled; key membership filtered.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/plugin-contributions.test.ts`
Expected: FAIL (module not defined).

- [ ] **Step 3: Implement the loader**

Mirror `plugin-skills.ts`: `readPluginManifest(dir)` fresh per scan (ENOENT → undefined), generalized to read `commands/agents/hooks/mcpServers` declarations (string | string[] | object-map for commands). Per-plugin `scanPluginContributions(entry)` discovers each type by convention with traversal guards (the `relative(dir,target)` escape check, `plugin-skills.ts:208-220`). Agent parser: read `.md`, `parseSkillFrontmatter`, build `{name: frontmatter.name ?? basename, description, prompt: body, enabled: true, createdAt/updatedAt: mtimeMs}`, then `coerceStoredAgentDefinition` (drop on null). Hooks: read `hooks.json`, reject `modules` (error), validate `hooks` via `validateSessionHooksConfig`. MCP: parse `.mcp.json` + manifest `mcpServers` (additive). `listPluginContributions` iterates entries with per-plugin try/catch (warn + errors, never throw). Prefix authority: manifest `name` ?? catalog name (same as skills).

- [ ] **Step 4: Add the port + host adapter**

`NativePluginPort` in `ports.ts`. In `native-host-adapters.ts`, add a `pluginPort` (mirroring the skill port at `:102-104`) backed by `deps.mpStore ? { listContributions: (enabled) => listPluginContributions(mpStore, enabled) } : undefined`. Thread it through `default-providers.ts` like the skill port.

- [ ] **Step 5: Run tests + neutrality pins + typecheck**

Run: `npx vitest run server/plugin-contributions.test.ts server/providers/native/vocabulary/neutrality.test.ts server/providers/native/host-free.test.ts` then `npm run typecheck`
Expected: PASS (loader is host-side; core gains only a port type).

- [ ] **Step 6: Commit**

```bash
git add server/plugin-contributions.ts server/plugin-contributions.test.ts server/providers/native/ports.ts server/providers/native-host-adapters.ts server/providers/default-providers.ts
git commit -m "feat(native): host-side plugin-contribution loader + port (commands/agents/hooks/mcp)"
```

---

### Task 2: Plugin commands integration

**Files:**
- Modify: `server/providers/native/commands.ts` (plugin command discovery)
- Modify: `server/providers/native/native-session.ts` (catalog precedence + port wiring)
- Test: `server/providers/native/commands.test.ts`, `native-session.test.ts`

**Interfaces:**
- Consumes: `NativePluginPort.listContributions` (Task 1); `NativeCommand` (`{name,description,argumentHint,builtin,body?}`); `commandCatalog` (`native-session.ts:1948-1965`).
- Produces: plugin commands in the merged catalog namespaced `plugin:command` (bare name from the loader, prefixed at integration); precedence builtin → user/project custom → plugin → skill.

- [ ] **Step 1: Write the failing test**

With a fixture plugin carrying `commands/about.md` (+ a manifest `commands` shadow case), assert the session's `supportedCommands()` includes `plugin:about` with the right body/description; a user custom command of the same bare name does NOT collide (namespaced); manifest `commands` shadows the `commands/` dir; builtin wins over a plugin command of the same qualified name. Live: `reloadSkills` refreshes plugin commands.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/providers/native/commands.test.ts -t plugin`
Expected: FAIL.

- [ ] **Step 3: Implement plugin command discovery + catalog merge**

Add a plugin-command pass fed by the plugin port (host-resolved, parallel to the skill port). Namespace each `PluginCommand` as `${pluginName}:${cmd.name}`. In `commandCatalog`, insert plugin rows after user/project custom and before skill rows (case-folded dedupe, command wins over skill — existing rule). Manifest shadowing is already applied by the loader (Task 1). Wire the port into `native-session.ts` opts; `reloadSkills` (`:3371-3377`) re-reads plugin commands too.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run server/providers/native/commands.test.ts server/providers/native/native-session.test.ts` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/commands.ts server/providers/native/native-session.ts server/providers/native/commands.test.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): discover plugin commands namespaced plugin:command in the slash catalog"
```

---

### Task 3: Plugin agents integration (merged read-only lookup)

**Files:**
- Create: `server/providers/native/agent-lookup.ts`
- Modify: `server/providers/native/subagent.ts` (consume the merged lookup), `native-session.ts` (persona path), `server/routes/sessions.ts` (`/agents` union)
- Test: `server/providers/native/agent-lookup.test.ts`, `subagent.test.ts`

**Interfaces:**
- Consumes: `NativePluginPort.listContributions` (Task 1, `.agents`); `AgentDefinitionStore.get/getEnabledDefinitions/list` (`agent-definition-store.ts`); `StoredAgentDefinition`.
- Produces: `class PluginAgentLookup` wrapping the user store + plugin defs, exposing `get(name): StoredAgentDefinition | undefined`, `getEnabledDefinitions(): Record<string, AgentDefinition>`, `list(): StoredAgentDefinition[]`. Plugin agents are plugin-qualified (`plugin:agent`); user/builtin wins a bare-name collision. NO writes to the user store.

- [ ] **Step 1: Write the failing test**

Assert: a plugin agent resolves via `get('plugin:foo')`; `getEnabledDefinitions()` includes plugin defs (bookkeeping stripped) unioned with user defs; a user agent named `foo` and a plugin agent `foo` → the plugin is qualified `plugin:foo`, the user `foo` wins bare `get('foo')`; the user store file is UNCHANGED after resolution (no pollution); an unsupported-field plugin agent is stripped/rejected by coerce. `/agents` route lists plugin defs.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/providers/native/agent-lookup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the merged lookup**

`PluginAgentLookup` holds the user store ref + plugin defs (from the port, refreshed on reload). `get(name)`: user store first (bare names), then plugin-qualified. `getEnabledDefinitions()`: user defs ∪ plugin defs (plugin keys qualified). Construct it in `native-session.ts` and pass as `AgentToolDeps.agentStore` (the surface `subagent.ts:209` consumes — `get` + `.enabled`). If `AgentToolDeps.agentStore` is typed as the concrete `AgentDefinitionStore` class, widen it to the structural surface the lookup satisfies (`get`/`getEnabledDefinitions`/`list`) rather than subclassing the store. The main-thread persona path (`applyFlagSettings({agent})`, `native-session.ts:3599`) resolves through the same lookup. The `/agents` route (`routes/sessions.ts:1362-1374`) unions plugin defs via native `supportedAgents`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run server/providers/native/agent-lookup.test.ts server/providers/native/subagent.test.ts` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/agent-lookup.ts server/providers/native/agent-lookup.test.ts server/providers/native/subagent.ts server/providers/native/native-session.ts server/routes/sessions.ts server/providers/native/subagent.test.ts
git commit -m "feat(native): plugin agents via merged read-only lookup (no store pollution, user-wins)"
```

---

### Task 4: Plugin hooks integration

**Files:**
- Modify: `server/providers/native/native-session.ts` (plugin `HookSource` in `sources()`)
- Test: `server/providers/native/native-session.test.ts` (or a hooks integration test)

**Interfaces:**
- Consumes: `NativePluginPort.listContributions` (Task 1, `.hooks` already validated + modules-rejected); `HookSource` (`hooks/types.ts:11`); `HookEngineOptions.sources()` (`hooks/engine.ts:87`); `collectForEvent` precedence (`hooks/collection.ts:22-37`).
- Produces: a `{ kind: 'plugin', collect(event) }` source registered between flag and (future) settings/agent sources; re-collected per dispatch (live).

- [ ] **Step 1: Write the failing test**

With a fixture plugin whose `hooks.json` has a `PreToolUse` matcher, assert: the engine dispatches the plugin hook (matcher fires); precedence flag→plugin (a flag hook and plugin hook both present → flag wins on dedupe); a plugin hooks config refresh takes effect on the next dispatch (live re-collection); modules-only plugin contributes no matchers (rejected at loader).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/providers/native/native-session.test.ts -t "plugin hook"`
Expected: FAIL.

- [ ] **Step 3: Implement the plugin HookSource**

In `native-session.ts` hooks wiring (`:736,744`), add a `{ kind: 'plugin', collect: (event) => pluginHooks[event] ?? [] }` source to the `sources()` array (after flag). `pluginHooks` is the merged validated plugin hooks config from the port, refreshed on reload. COORDINATION: confirm against committed HEAD first (another session edits hooks wiring); add the source without clobbering their WIP.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run server/providers/native/native-session.test.ts server/providers/native/hooks` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): register plugin HookSource (flag→plugin precedence, live re-collection)"
```

---

### Task 5: Plugin MCP integration (two-map composition)

**Files:**
- Modify: `server/providers/native/native-session.ts` (user/plugin map composition), `native-provider.ts` (plugin MCP resolution at spawn)
- Test: `server/providers/native/native-session.test.ts`, `server/providers/native/mcp/connections.test.ts`

**Interfaces:**
- Consumes: `NativePluginPort.listContributions` (Task 1, `.mcpServers`); `NativeMcpConnections.load/setServers` (`mcp/connections.ts:201,276`); the host adapter's `setMcpServers` path (manager `session-manager-mcp.ts:146` → handle → core).
- Produces: native-side `userMcpServers` + `pluginMcpServers` maps and a `composeMcpServers()` (user ∪ plugin, user-wins) applied on every `load`/`setMcpServers`/plugin-reload. Plugin-vs-plugin collision by key order + warning.

- [ ] **Step 1: Write the failing test (the load-bearing durability case)**

Assert: spawn with a plugin MCP server → connected; a user-driven `setMcpServers` (add a dynamic server) → BOTH the user server AND the plugin server remain connected (plugin NOT dropped); removing the user server keeps the plugin; a plugin reload re-composes; global/session server wins a name collision with a plugin server; plugin-vs-plugin collision warns + first-key wins; the claude provider path is untouched (no plugin MCP injected into claude).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/providers/native/native-session.test.ts -t "plugin mcp"`
Expected: FAIL (spawn-only merge drops plugin on replace).

- [ ] **Step 3: Implement the two-map composition**

Native-session holds `userMcpServers` (last user-supplied map from `load`/`setMcpServers`) and `pluginMcpServers` (from the port). `composeMcpServers()` merges user-wins and calls `mcp.setServers(composed)`. The host adapter's `setMcpServers` forwards the user map to the core, which stores it and re-composes (NOT a blind replaceAll of the user map). Spawn (`native-provider.ts`) resolves plugin MCP via the port into `pluginMcpServers` before the first compose. Plugin-vs-plugin collisions resolved by key order with a logged warning. Keep this native-side — the manager and claude path unchanged.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run server/providers/native/native-session.test.ts server/providers/native/mcp` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/native-provider.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): plugin MCP via two-map composition durable across user-driven replaces"
```

---

### Task 6: Capability flip + live toggle/ripple

**Files:**
- Modify: `server/providers/native/native-provider.ts` (`supportsPlugins: true`), `native-session.ts` (`reloadPlugins`, `enabledPlugins` flag), `server/mp-ops.ts` (global ripple native branch)
- Test: `server/providers/native/native-session.test.ts`, `server/mp-ops.test.ts`, `server/session-manager.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5 (all contribution reloads); `togglePlugin` capability gate (`session-manager.ts:7304`); `applyFlagSettings` supported set (`native-session.ts:3561`); global ripple (`mp-ops.ts:179-207`).
- Produces: `supportsPlugins: true`; native handle `reloadPlugins()`; `enabledPlugins` accepted in `applyFlagSettings`; per-session toggle route works on native; global ripple refreshes all five types; disable revokes contributions.

- [ ] **Step 1: Write the failing test**

Assert: per-session plugin toggle (`togglePlugin`) succeeds on native (no longer 501/rejected); enabling a plugin adds its command/agent/hook/MCP/skill; disabling revokes them (MCP disconnected, command/agent gone, hook source empty); the global ripple native branch refreshes all five types (not just skills); the `enabledPlugins` subset change re-resolves.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/providers/native/native-session.test.ts -t "plugin toggle"`
Expected: FAIL (capability false / no reloadPlugins).

- [ ] **Step 3: Implement capability + live path**

Flip `supportsPlugins: true`. Add native handle `reloadPlugins()` (re-resolve the plugin port + refresh commands/agents/hooks/MCP/skills). Accept `enabledPlugins` in `applyFlagSettings` (re-resolve subset + reload). Grow the `mp-ops.ts` native branch (`:189-193`) from `reloadSkills` to the full reload. Disable teardown falls out of the composition (plugin map empty → compose drops servers; catalog/lookup/hook source re-read empty).

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `npx vitest run server/providers/native/native-session.test.ts server/mp-ops.test.ts server/session-manager.test.ts` then `npm run typecheck` then `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-provider.ts server/providers/native/native-session.ts server/mp-ops.ts server/providers/native/native-session.test.ts server/mp-ops.test.ts
git commit -m "feat(native): supportsPlugins + live plugin toggle/ripple across all contribution types"
```

---

### Task 7: E2E parity, decision record, final review

**Files:**
- Create: `server/providers/native/e2e-plugin-parity.test.ts` + a fixture plugin dir
- Create: `.agents/notes/implemented/feature/2026-11-27-native-plugin-parity.md`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: an e2e proving a native session with an enabled fixture plugin gets its command, agent, hook, and MCP server alongside its skill; the decision record.

- [ ] **Step 1: Write the failing e2e**

Drive a native session through `SessionManager` with an enabled fixture plugin carrying all five contribution types. Assert: the plugin skill is invocable (existing parity), `plugin:command` in `supportedCommands`, the plugin agent resolves via an Agent call, the plugin hook fires on its event, the plugin MCP server connects — and a user-driven MCP change keeps the plugin server. Compare against the claude path's enabled set (same plugin resolves on both).

- [ ] **Step 2: Run to verify failure, then make it pass**

Run: `npx vitest run server/providers/native/e2e-plugin-parity.test.ts`
Expected: FAIL → fix any wiring gap at the owning layer (no client source change) → PASS.

- [ ] **Step 3: Write the decision record**

Per `.agents/notes/README.md`: the why (parity), the host-side loader generalizing plugin-skills, the data-only model (vs DSH Cordis code-plugins), the MCP two-map composition (the builder-check gap), agents merged lookup (no pollution), hooks modules rejection, namespacing/precedence, what was left out (output-styles/themes, App Plugins). Durable prose, no stack narration.

- [ ] **Step 4: Gates**

Run: `npm run verify:agent-notes` then `npm run typecheck` then `npm run lint` then `npx vitest run server/providers/native server/plugin-contributions.test.ts`
Expected: PASS (known environmental e2e-mcp EBUSY flake passes in isolation — not attributable).

- [ ] **Step 5: Code review the full diff, fix confirmed findings, commit**

Run `code-review` on the feature diff; verify + fix confirmed findings; re-review non-trivial fixes. Then:

```bash
git add server/providers/native/e2e-plugin-parity.test.ts .agents/notes/implemented/feature/2026-11-27-native-plugin-parity.md
git commit -m "test(native): plugin parity e2e + decision record"
```