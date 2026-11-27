# Agent Note: Native provider Claude-plugin parity

Status: implemented

## Problem

The Claude Plugin Marketplace means one thing on the claude provider and another on native. Claude hands enabled plugin directory paths to the CLI (`Options.plugins`), and the CLI discovers each plugin's commands, agents, skills, hooks and MCP servers itself. Native has no CLI, so with `supportsPlugins: false` it consumed only plugin **skills** (the already-wired `plugin-skills.ts` scanner) and dropped the other four contribution types. A user who enabled a marketplace plugin got a different agent-extension surface depending on which provider backed the session — the marketplace was not provider-neutral.

The goal is parity of that extension surface, not a new plugin runtime. CRW's separate App Plugin (Mod) system extends the app shell and is provider-agnostic; it is unrelated to this agent-extension path and stays so.

## Decision

A native session resolves the same enabled plugin set as claude — the same `enabledPlugins` subset (`undefined` = all globally enabled, `[]` = none, else compound-key membership) through the same `MpStore.getEnabledPluginEntries` resolution — and loads each plugin's five contribution types into the matching native subsystem. `supportsPlugins` is `true`; the per-session toggle route and the global marketplace ripple both work on native.

### Host-side loader behind a port

`server/plugin-contributions.ts` generalizes the `plugin-skills.ts` pattern into one per-plugin `PluginContributions` record (`commands`, `agents`, `hooks`, `mcpServers`, `errors`). It lives host-side because it reads the marketplace store and the host's agent-definition coerce; the neutral core reaches it through `NativePluginPort` (`native/ports.ts`), exactly like the skill port. The core never imports `mpStore` or the parser — the [host-service ports](../architecture/2026-11-19-native-host-service-ports.md) and [provider-seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md) discipline holds, pinned by `neutrality.test.ts` and `host-free.test.ts`.

Discovery follows the CLI conventions (verified against the SDK bundle's manifest schemas and the CLI binary's loaders): a manifest `commands`/`agents` field shadows the convention dir; `hooks` and `mcpServers` manifest additions are additive to `hooks/hooks.json` and `.mcp.json`. `commands/` and `agents/` are walked recursively with subdirectory namespacing; command walks prune a skill dir. Every manifest and file is untrusted: containment is realpath-based (a lexical escape and a symlink resolving outside the plugin are both refused before any read), hooks files dedup by realpath, and names are sanitized rather than validated away so a CJK-named command loads under its dashed name. Failures contain twice — per contribution type (one bad `hooks.json` never loses the plugin's commands) and per plugin (one bad plugin never rejects the pass) — and every refusal is reported in the record's `errors` and logged.

### Data-only contributions

Claude marketplace contributions are **data** (markdown commands/agents/skills, JSON hooks/MCP), not executable host code. Native loads them as data into existing subsystems; no plugin code runs in-process. A `hooks.json` `modules` field (executable hook modules) is refused per plugin with a reported error while its `hooks` matchers still load.

This is the line between this system and DSH's Cordis microkernel ([research](../../../../docs/research/2026-11-10-dsh-plugin-system.md)), where the whole agent product is composed of in-process runtime code plugins on a shared `Context`. Three DSH ideas transfer to data contributions and are adopted: installed/enabled/available/running stay separate facts (the loader reports per-plugin availability/error rather than overloading `enabled`); a plugin's contributions are owned by its enabled state and revoked on disable (the data analogue of effect disposers); and the catalog is discovery only — what loads is decided by the plugin's actual manifest and files (index vs content). Three are rejected: in-process code plugins (they would bypass native's validation and trust model, and there is no code to sandbox), React Slots / arbitrary UI (irrelevant to agent extensions), and bundle/profile multi-layer override semantics (overkill for a per-plugin merge with a fixed precedence).

### Commands, agents, skills: namespacing and precedence

Commands and skills use the CLI `plugin:name` grammar; the plugin prefix is added at integration from the plugin's own manifest name (catalog name as fallback). The slash catalog precedence is builtin → user/project custom → plugin → skill rows, command winning over skill on a name collision (the existing rule, see [native slash surface](2026-11-26-native-slash-surface.md)). Plugin command names are gated to the slash grammar and manifest object-map keys are sanitized, so the catalog never lists a row the slash parser cannot tokenize.

Plugin agents resolve through a **merged read-only lookup** (`native/agent-lookup.ts`) wrapping the user `AgentDefinitionStore` — not upserts into the persisted `agent-definitions.json` (polluting the user's store is an anti-goal). Plugin agents are plugin-qualified; a user definition wins a bare-name collision. The lookup satisfies the same `get/has/list` surface the Agent tool consumes, so a plugin agent is live for subagents without respawn, and the main-thread persona switch (`applyFlagSettings({agent})`) resolves through it too. Plugin agent frontmatter validates against the closed `AGENT_FIELDS` set via the same `coerceStoredAgentDefinition` a user agent uses.

### Hooks

Each plugin's validated matchers register a `{ kind: 'plugin', collect }` `HookSource` in the [hook engine](2026-11-26-native-hook-engine.md)'s source array, in the engine's documented precedence flag → settings → plugin → agent. The engine re-collects per dispatch, so a plugin config replacement is live on the next event without respawn. Plugin hooks run under the same permission model as flag hooks (native has no `hooksMayAllow` plugin-ask gate).

Plugin hooks commit asynchronously in the command reload, so the init `SessionStart` seam awaits that discovery before dispatching when a plugin port exists — a plugin `SessionStart` matcher fires at init rather than silently missing it. `SessionStart` never blocks the session: a dispatch or application failure is logged and the session starts regardless.

### MCP two-map composition

Plugin MCP servers merge at the native provider/host boundary, not in the provider-agnostic manager — the claude path is untouched (the CLI reads plugin `.mcp.json` itself; native must not double-load). User/global/session servers win a name collision over plugin servers; plugin-vs-plugin collisions resolve by key order with a reported warning.

The composition is **two maps**, and this is load-bearing. Every live MCP mutation (`setMcpServers`, first-party toggle, global attach/detach) applies a wholesale replace through the connection manager. A spawn-only merge would drop every plugin MCP server the first time the user added or removed a dynamic server. So native tracks the last user-supplied map and the plugin map separately and re-composes `user ∪ plugin` (user-wins) on every `load` / `setMcpServers` / reload. Disabling a plugin re-composes without its servers; a user-driven replace re-composes with the current plugin set intact. The [MCP sharing](../architecture/2026-11-18-native-mcp-sharing.md) registry is unchanged underneath.

### Capability and live toggle

`supportsPlugins: true` ungates the per-session toggle route and `reloadPlugins`. Native's `applyFlagSettings({enabledPlugins})` takes the SDK's `{[pluginKey]: boolean}` toggle dict, resolves the post-toggle subset against the live base (the pinned subset, or the current global keys when unpinned), and re-resolves all five contribution types through the same shared discovery commit `reloadSkills` uses — `reloadPlugins` IS that pass, no parallel path. A content no-op (enabling a present key / disabling an absent one) keeps the spawn contract instead of pinning.

A per-session toggle broadcasts `commands-changed` from the manager: the claude CLI pushes that frame through the stream, but native has no such push, so the manager re-reads the committed catalog and broadcasts it (the same re-read + broadcast `applyDynamicSkillOverrides` uses). For claude the extra broadcast is a harmless duplicate of the CLI push.

The global marketplace ripple forwards the toggle delta on **both** providers before reloading the catalog. This is deliberate parity for pinned sessions: a global enable must reach a session whose pinned subset excludes the newly-enabled key, which a catalog re-read alone would never admit (the store resolution filters by subset membership). Neither ripple path materializes, so the persisted spawn pin is untouched and the live delta is transient until respawn — exactly claude's behavior. The catalog reload then covers the unpinned case, where the delta is a content no-op against the fresh global set, and broadcasts the picker refresh. Global disable works symmetrically: the store flag clears, so the subset resolution drops the key on either provider.

## Alternatives considered

**A neutral-core plugin parser.** Putting the loader inside `native/` would let the core read plugin files directly, but it needs `mpStore` (host-domain) and the host agent coerce, breaking the host-free pin. The port keeps the core neutral and the loader host-side, mirroring the skill port that already works this way.

**Upserting plugin agents into the user store.** Reusing `AgentDefinitionStore` directly would make plugin agents resolve through the existing path with no new lookup, but it pollutes the user's persisted `agent-definitions.json` with entries they did not author and cannot cleanly remove, and it makes disable/revoke a store mutation. The merged read-only lookup keeps plugin agents owned by their enabled state.

**A spawn-only MCP merge.** Merging plugin servers into the resolved map once at spawn is simpler, but the first user-driven `setMcpServers` replace drops them. The two-map composition is the minimum that survives the wholesale-replace contract.

**Keeping the global ripple native branch as a bare catalog re-read.** This respects the pinned subset (a pinned session never sees a newly globally-enabled plugin), which reads as "the pin is sticky" but diverges from claude, where the live delta applies regardless of pin. Forwarding the delta first matches claude and keeps the pin's meaning intact: the pin governs the persisted spawn set, not the live surface.

**Documenting the pinned-global-enable gap as a known divergence.** The fix is small (forward the delta, then reload — the structure the claude branch already uses) and carries no pin-semantics risk: the no-op guard keeps unpinned sessions unpinned, and the absence of materialize keeps the spawn pin untouched. A divergence would have been a permanent parity asterisk for a gap with a clean fix.

## Consequences

The marketplace is provider-neutral for the five contribution types: one enabled set, one resolution, the same surface on claude and native. The cost is a host-side loader and a merged agent lookup that must track CLI discovery conventions, plus a two-map MCP composition the connection manager's replace contract forces. Plugin contributions are data, so native's trust model is unchanged — untrusted artifacts are validated and contained, never executed.

The per-session toggle and the global ripple both refresh an open picker live on native, where there is no CLI push to rely on. The ripple's delta-forwarding means a global enable reaches pinned sessions live on both providers; the persisted spawn pin still governs respawn, so the live delta is transient by design.

### Left out

- **MCPB binary bundles (`.mcpb`/`.dxt`).** A manifest entry naming a binary bundle keeps its loud refusal; the extraction subsystem is beyond parity scope. An MCPB plugin's MCP servers do not load on native.
- **Manager-level plugin persona gate.** `SessionManager.setAgent` / `applySettings` validate a persona name against the user store only, so a plugin-qualified main-thread persona (`plugin:agent`) 400s at the HTTP doors. This is a **shared host limitation** — claude has the identical 400 (plugin agents are never in the user store on either provider) — so native is at parity, not behind. The provider-level `applyFlagSettings({agent})` resolves plugin personas through the merged lookup; a live-selected plugin persona survives resume via its persisted qualified snapshot. Spawn-time persona selection deliberately stays on the user store.
- **Output-styles and themes.** The CLI's parallel plugin contribution list includes them; native has no such subsystem.
- **App Plugins (Mods).** The separate app-shell extension system is provider-agnostic and unaffected.

### Testing

`server/providers/native/e2e-plugin-parity.test.ts` drives a native session through the real `SessionManager`, `MpStore`, host loader, permission broker, hook engine and MCP connections (only the Anthropic stream is scripted). A committed fixture plugin (`native/fixtures/plugin-parity/`) carries a command, an agent, a skill and a `hooks.json` matcher pair; the test writes the per-run `.mcp.json` stdio server. It asserts all five types resolve and invocable (command and skill slash expansion, an Agent call whose nested system carries the plugin prompt, a `SessionStart` marker and a `PreToolUse` block through a real turn, a routed stdio MCP call), that the plugin MCP server survives user-driven replaces, that a per-session toggle broadcasts the picker refresh and revokes/restores all five types, and that a global enable reaches both a pinned and an unpinned native session live without rewriting the spawn pin. The same enabled set the claude path injects is asserted to resolve the directory the native loader scanned.

## Related

- [Native skill invocation recovery](../architecture/2026-11-12-native-skill-invocation-recovery.md) — the skill half this generalizes.
- [Native slash surface](2026-11-26-native-slash-surface.md) — the command catalog plugin commands join.
- [Native hook engine](2026-11-26-native-hook-engine.md) — the source array plugin hooks register into.
- [Native MCP sharing](../architecture/2026-11-18-native-mcp-sharing.md) — the registry under the two-map composition.
- [Native host service ports](../architecture/2026-11-19-native-host-service-ports.md) and [provider seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md) — the boundary the plugin port respects.
- [Native task panel parity](2026-11-27-native-task-panel-parity.md) — a sibling provider-parity decision.
- [Design spec](../../../../docs/superpowers/specs/2026-11-27-native-plugin-parity-design.md).