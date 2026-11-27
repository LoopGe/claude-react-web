# Native provider Claude-plugin parity — design

Date: 2026-11-27
Status: proposed
Owner: native provider

## Intent

A native session should be able to use the same Claude Plugin Marketplace
plugins a claude session uses. Today `supportsPlugins: false`
(`native-provider.ts:130`): the claude provider hands enabled plugin directory
paths to the CLI (`Options.plugins` via
`mpStore.getEnabledPluginAbsolutePathsFor`, `claude-provider.ts:948-956`), and
the CLI discovers each plugin's commands / agents / skills / hooks / MCP
servers itself. Native has no CLI, so it must do that discovery host-side and
feed its own subsystems. This design closes that gap so the marketplace means
the same thing on both providers.

The why is parity of the agent-extension surface, not a new plugin runtime.
CRW already has a separate App Plugin (Mod) system for the app shell; that is
provider-agnostic and out of scope here. This is specifically the Claude
Plugin Marketplace agent-extension path.

## Current state

CRW parses only the marketplace **catalog** (plugin names / sources / dirs,
`server/marketplace-parser.ts:378-389`), with one exception: plugin **skills**
are already fully wired. `server/plugin-skills.ts` is a CLI-shaped plugin-skill
scanner (binary-verified against the CLI's §5.8 scan branches), fed through
`NativeSkillPort.listSkills` (`ports.ts:79-81`) into `NativeSkillCatalog.reload`
(`skills.ts:118-153`). Plugin skills already appear as slash rows with a
`(plugin)` tag and `plugin:name` grammar. **This scanner is the template for the
other four contribution types.**

The four gaps, each with its existing feed function:

| Type | Feed function | Plugin parsed today? |
|---|---|---|
| Commands | `discoverCommands(cwd, userRoot)` (`native/commands.ts:149`), roots `:79-83` (user + project only) | no |
| Agents | `AgentDefinitionStore.get` / `getEnabledDefinitions` (`agent-definition-store.ts:80-88`), consumed at `subagent.ts:209` | no (no `.md` frontmatter parser exists) |
| Hooks | `HookEngineOptions.sources()` (`native/hooks/engine.ts:87-89`); session wires only `kind:'flag'` (`native-session.ts:736,744`) | no (`kind:'plugin'` reserved in `hooks/types.ts:12`, unwired) |
| MCP | `NativeMcpConnections.load` (`native/mcp/connections.ts:201`), input resolved by `mergeMcpServers` + `injectAll` | no (no plugin `.mcp.json` reader) |

Native already receives `CreateSessionOptions.enabledPlugins`
(`native-provider.ts:336`) but routes it only to the skill catalog. The
per-session live plugin-toggle route is capability-gated on `supportsPlugins`
(`session-manager.ts:7304`), so native is rejected there; the global toggle
ripple already has a native branch (`mp-ops.ts:189-193`, `reloadSkills`).

## Goals

- A native session resolves the same enabled plugin set as claude (same
  `enabledPlugins` subset, same `mpStore.getEnabledPluginEntries` resolution).
- Each enabled plugin's commands, agents, hooks, and MCP servers load into the
  matching native subsystem, alongside the already-wired skills, following the
  CLI's discovery conventions (directory auto-load + manifest overrides).
- Plugin contributions are namespaced and collision-safe (CLI `plugin:name`
  grammar for commands/agents/skills; a defined precedence for hooks and MCP).
- Live parity: enabling/disabling a plugin (global ripple or per-session toggle)
  refreshes all five contribution types, not just skills.
- `supportsPlugins: true` once the surface is real.

## Non-goals

- No new runtime plugin model. Claude marketplace contributions are **data**
  (markdown commands/agents/skills, JSON hooks/MCP), not executable host code.
  Native loads them as data into existing subsystems; it does not execute
  plugin code in-process.
- No change to the App Plugin (Mod) system or MCP global config.
- No change to the claude provider's plugin path (the CLI keeps loading plugins
  itself; native must not double-load).
- No plugin output-styles / themes (the CLI's parallel-stats list includes
  them, but native has no such subsystem; explicitly out of scope).

## Anti-goals

- Polluting the user's persisted `agent-definitions.json` with plugin agents.
- A plugin MCP server silently shadowing a global/session server (or vice
  versa) without a defined rule.
- Plugin hooks bypassing the shared validation or the engine's precedence.
- Loading plugin contributions into the neutral core via a host import
  (neutrality violation).
- Treating the marketplace catalog as trusted: every plugin file is untrusted
  JSON/markdown off the internet.

## DSH comparison

The DSH plugin system (`docs/research/2026-11-10-dsh-plugin-system.md`) is a
**Cordis microkernel**: the whole agent product (tools, LLM adapters, agent
loop) is composed of in-process runtime plugins on a shared `Context`, with
service injection, five event modes, HMR, and bundle/profile composition. That
is a different layer from the Claude Plugin Marketplace, which ships **static
artifact directories** the host loads by convention. The contrast that matters
for this design:

| Axis | DSH Cordis | Claude marketplace / native loader |
|---|---|---|
| Unit | runtime code plugin (function / `apply` / `Service`) on a Context | static artifact dir (commands/agents/skills `.md`, hooks/MCP `.json`) |
| Execution | plugin code runs in the host process, full TS service API | contributions are data; native feeds them to existing subsystems, no plugin code executes |
| Composition | bundle + multi-layer profile patch, ordered override | per-plugin contribution merge with a fixed precedence |
| Lifecycle | Fiber state + effect disposers + HMR | spawn discovery + live reload; contributions revoked on disable |
| Trust | trusted host code + per-operation approval | untrusted artifacts, validated; no arbitrary code |

**Borrowed from DSH (the doc's §13, adapted to data contributions):**
- Keep *installed / enabled / available / running* as separate facts. The
  loader reports per-plugin availability/error (manifest unreadable, dir
  missing, contribution invalid) rather than overloading `enabled`.
- Resource ownership + teardown: a plugin's contributions are owned by its
  enabled state; disabling revokes them (commands/agents drop from the surface,
  hooks source removed, MCP servers disconnected) — the data analogue of DSH's
  effect disposers.
- Index vs content separation: the catalog is discovery only; what loads is
  decided by the plugin's actual manifest + files (mp-store already keeps this
  discipline).

**Rejected from DSH (the doc's §13.5):**
- In-process code plugins — would bypass native's validation and trust model;
  Claude contributions are data, so there is no code to sandbox.
- React Slots / arbitrary UI — irrelevant to agent extensions.
- Bundle/profile multi-layer override semantics — overkill for per-plugin
  contribution merge; native uses a fixed precedence, not ordered patch layers.

## Design

### A. Shared plugin-contribution loader (host-side, behind a port)

Generalize the `plugin-skills.ts` pattern into a plugin-contribution resolver.
It lives **host-side** (it needs `mpStore`, which is host-domain), exposed to
the neutral core through a port exactly like `NativeSkillPort`. The core never
imports `mpStore` or the parser.

- Input: the session's `enabledPlugins` subset (undefined = all enabled, `[]` =
  none) — the same contract the skill catalog uses.
- Resolution: `mpStore.getEnabledPluginEntries(enabledPlugins)`
  (`mp-store.ts:468-501`) → `{ key, name, dir, source, cloneDir }` per enabled
  plugin (git-subdir external clones already resolved by the store).
- Per plugin: read `.claude-plugin/plugin.json` fresh (untrusted), then discover
  contributions by the CLI conventions (verified against the SDK bundle):
  - `commands/` auto-loaded **unless** the manifest `commands` field is set
    (then only the listed files; object-map variant names the slash command).
  - `agents/` auto-loaded **unless** the manifest `agents` field is set.
  - `skills/` additive (already handled by `plugin-skills.ts`).
  - `hooks/hooks.json` (`hooks` matchers and/or `modules`) **plus** manifest
    `hooks` additions.
  - `.mcp.json` **plus** manifest `mcpServers` additions.
- Output: a typed `PluginContributions` record per plugin
  `{ commands, agents, hooks, mcpServers, skills, errors[] }`, each contribution
  carrying its plugin key for namespacing. Per-plugin failure is isolated (one
  bad plugin reports errors, never rejects the whole set) — the marketplace
  parser's existing discipline.

A shared frontmatter parser is needed for agent `.md` (none exists today);
commands already reuse `parseSkillFrontmatter`. The agent parser produces
`StoredAgentDefinition`-shaped defs against the closed `AGENT_FIELDS` set
(`shared/agent-definitions.ts:25-30`), reusing `coerceStoredAgentDefinition`
(`agent-definition-store.ts:129-194`) so plugin agents validate identically to
user agents.

### B. Commands

Extend command discovery with plugin command dirs, host-resolved through the
loader port (parallel to the skill port). Feed plugin commands into the merged
`commandCatalog` (`native-session.ts:1948-1965`) namespaced `/plugin:command`
(the CLI grammar, SDK bundle). Precedence in the catalog: builtin → user/project
custom → plugin → skill rows (command wins over skill, existing rule). Manifest
`commands` shadows the `commands/` dir (CLI rule). Live: `reloadSkills` already
re-reads commands (`native-session.ts:3373`); the plugin command set refreshes
with it.

### C. Agents

Parse plugin `agents/*.md` frontmatter into defs (A). Feed them through a
**merged read-only lookup** that wraps the user `AgentDefinitionStore` and
satisfies the same `get/has/list` surface consumed at `subagent.ts:209` — NOT
upserts into the persisted JSON store (anti-goal). Plugin agents are
plugin-qualified (`plugin:agent`) to avoid colliding with user/builtin names;
user definitions win on a bare-name collision. The `/agents` route union
(`routes/sessions.ts:1362-1374`) includes plugin defs. Because the store is read
per Agent-tool call, plugin agents are live for subagents without respawn; the
main-thread persona path (`applyFlagSettings({agent})`) resolves through the
same merged lookup.

### D. Hooks

Parse each enabled plugin's `hooks/hooks.json` (+ manifest `hooks` additions),
validate with the shared `validateSessionHooksConfig` (`shared/hooks.ts:284`),
and register a `{ kind: 'plugin', collect }` `HookSource` in the engine's
`sources()` array (`native-session.ts:744`). A `hooks.json` may carry `hooks`
(matchers) and/or `modules` (executable hook modules); **`modules` are rejected
per-plugin** (a reported error, not a crash) by the data-only non-goal — native
loads only the `hooks` matchers, never executes plugin code. The engine already
concatenates sources in order with earlier-wins dedupe
(`hooks/collection.ts:22-37`) and re-collects per dispatch, so the plugin source
is live once its parsed config is refreshable. Precedence follows the engine's
documented order: flag → settings → plugin → agent. Native deliberately has no
`hooksMayAllow` plugin-ask gate (`native-session.ts:1373`); plugin hooks run under
the same permission model as flag hooks.

### E. MCP

Parse plugin `.mcp.json` + manifest `mcpServers` (A). Merge into the resolved
`mcpServers` map **at the native provider/host boundary** (native resolves plugin
MCP via the loader port), NOT in the provider-agnostic manager — so the claude
path is untouched (the CLI reads plugin `.mcp.json` itself; native must not
double-load). Name-collision policy: global/session servers win over plugin
servers (a plugin cannot shadow an explicitly-configured server); plugin-vs-plugin
collisions resolve by plugin key order with a reported warning. `${VAR}` env
expansion follows the existing MCP config semantics.

**Plugin MCP must be durable across user-driven replaces (load-bearing).** Every
live MCP mutation goes through `SessionMcpManager.setMcpServers`
(`session-manager-mcp.ts:146`), which builds a map of the user's dynamic servers
+ first-party injection with NO knowledge of plugin servers, and the core applies
it via `mcp.setServers` → `replaceAll` (`mcp/connections.ts:276,378`) — a wholesale
replace. A spawn-only merge would therefore DROP every plugin MCP server the first
time the user adds/removes a dynamic server, attaches/detaches a global, or toggles
a first-party server. So native owns a **two-map composition**: it tracks the last
user-supplied map (from `load`/`setMcpServers`) and the plugin map (from the loader)
separately, and re-composes `user ∪ plugin` (user-wins on collision) on EVERY
`load` / `setMcpServers` / `reloadPlugins`. This composition lives native-side
(provider/host boundary), reachable from both spawn (`createSession`) and the live
`setMcpServers` path — consistent with "NOT in the manager". Disabling a plugin
re-composes without its servers; a user-driven replace re-composes with the current
plugin set intact.

### F. Capability + live toggle

Flip `supportsPlugins: true`. Implement a native `reloadPlugins` handle method
and accept the `enabledPlugins` key in `applyFlagSettings` so the per-session
toggle route (`session-manager.ts:7280-7306`) works. The global ripple native
branch (`mp-ops.ts:189-193`) grows from `reloadSkills` to a full contribution
reload (commands/agents/hooks/MCP/skills). Disabling a plugin revokes its
contributions (B–E teardown). The `enabledPlugins` subset is frozen at spawn
(existing skill-catalog rule); a reload re-reads the store with the same subset,
and the per-session toggle changes the subset.

## Constraints

- **Neutrality**: the loader/parser live host-side; the core consumes via ports
  (like `NativeSkillPort`). No `mpStore`/parser import in `native/**` core.
  Pins: `neutrality.test.ts`, `host-free.test.ts`.
- **Untrusted input**: every plugin manifest/file is untrusted; reuse the
  marketplace parser's defensive coercion + traversal guards (`plugin-skills.ts`
  manifest `skills` traversal guard is the model). A bad plugin isolates to
  errors, never rejects the set or crashes spawn.
- **No double-load**: native plugin resolution must not reach the claude path.
- **Namespacing**: commands/agents/skills use the CLI `plugin:name` grammar;
  hooks/MCP use the defined precedence (D/E).
- **Closed agent field set**: plugin agents validate against `AGENT_FIELDS`
  (native's `profileFromDefinition` asserts unsupported fields,
  `agent-profile.ts:49-62`).
- Diagnostics via `createLogger(scope)`; metrics labels finite enums only.

## Decisions made here (builder calls)

- Loader is host-side behind a port, generalizing `plugin-skills.ts` (not a
  neutral-core parser). Keeps `mpStore` host-domain.
- MCP merge at the native provider/host boundary, not the manager — preserves
  provider-agnosticism and avoids claude double-load. Global/session wins over
  plugin; plugin-vs-plugin by key order + warning. Native owns a two-map
  composition (user map + plugin map) re-composed on every load/setMcpServers/
  reloadPlugins, so plugin servers survive user-driven replaces (the builder-check
  gap; required by the live-parity goal).
- Hooks `modules` (executable hook modules) rejected per-plugin — data-only;
  only `hooks` matchers load.
- Agents via a merged read-only lookup wrapping the user store (no JSON
  pollution); plugin-qualified names; user wins bare-name collisions.
- Hooks precedence flag → settings → plugin → agent (the engine's documented
  order); shared validation; no `hooksMayAllow` gate.
- Commands precedence builtin → custom → plugin → skill; `/plugin:command`
  namespace; manifest shadows `commands/` dir.
- Flip `supportsPlugins: true` + native `reloadPlugins`/`enabledPlugins` path
  (full live parity), rather than keeping skill-only ripple.
- Output-styles/themes out of scope (no native subsystem).

## Left to the builder

- Exact port shape (`NativePluginPort`?) and whether one port returns all
  contribution types or per-type ports mirroring the skill port.
- The agent `.md` frontmatter parser's module home and reuse of
  `parseSkillFrontmatter` vs a dedicated parser.
- Plugin manifest caching/refresh strategy (plugin-skills reads fresh per scan;
  match that or add a generation fence).
- The merged agent-lookup wrapper's exact interface and where it's constructed.
- Test fixture plugin dirs and the e2e assertion shape.

## Test plan

- Loader unit tests: catalog resolution via `getEnabledPluginEntries`;
  convention discovery (commands/agents auto-load, manifest shadowing, hooks
  hooks.json + manifest additions, .mcp.json + manifest additions); per-plugin
  failure isolation; traversal guards; untrusted-manifest coercion.
- Commands: plugin commands appear namespaced `/plugin:command`, manifest
  shadows dir, precedence vs builtin/custom/skill, live reload.
- Agents: plugin agents resolve via the merged lookup (no JSON pollution),
  plugin-qualified names, user-wins collision, `/agents` union, closed-field
  validation rejects unsupported fields.
- Hooks: plugin source registered, precedence flag→settings→plugin→agent,
  shared validation rejects bad config, per-dispatch re-collection live.
- MCP: plugin servers merge, global/session-wins collision, plugin-vs-plugin
  warning, no claude double-load, live setServers.
- Capability/live: per-session toggle works on native; global ripple refreshes
  all five types; disable revokes contributions.
- Neutrality/host-free pins extended for the new port/parser boundary.
- E2E: a native session with an enabled fixture plugin gets its command, agent,
  hook, and MCP server alongside its skill; parity with the claude path.

## Files touched

- `server/plugin-contributions.ts` (new) — host-side loader/parser generalizing
  `plugin-skills.ts`; agent `.md` frontmatter parser.
- `server/providers/native/ports.ts` — `NativePluginPort` (or per-type ports).
- `server/providers/native-host-adapters.ts` — port adapter backed by mpStore.
- `server/providers/native/commands.ts` + `native-session.ts` — plugin command
  discovery + catalog precedence.
- `server/providers/native/subagent.ts` + a merged agent lookup — plugin agents.
- `server/providers/native/native-session.ts` — plugin `HookSource`, plugin MCP
  merge, `reloadPlugins`, `enabledPlugins` flag, capability flip.
- `server/providers/native/native-provider.ts` — `supportsPlugins: true`, plugin
  resolution wiring.
- `server/mp-ops.ts` — global ripple native branch grows to full reload.
- Tests alongside each; e2e fixture plugin; decision record on implementation:
  `.agents/notes/implemented/feature/2026-11-27-native-plugin-parity.md`.