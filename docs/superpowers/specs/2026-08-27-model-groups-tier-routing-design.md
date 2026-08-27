# Model Groups: real three-tier routing (opus / sonnet / haiku)

Date: 2026-08-27

## Problem

Today the project collapses all four CLI model-tier env vars to the session's single model in `applyStandardQueryOpts` (`server/providers/claude/claude-provider.ts`):

```ts
ANTHROPIC_DEFAULT_OPUS_MODEL    = effectiveModel
ANTHROPIC_DEFAULT_SONNET_MODEL  = effectiveModel
ANTHROPIC_DEFAULT_HAIKU_MODEL   = effectiveModel
ANTHROPIC_SMALL_FAST_MODEL      = effectiveModel
```

There is no real tier distinction: background tasks, subagents, and model-switch aliases all resolve to the same model. This spec implements a *real* three-tier routing layer aligned with the SDK/CLI's native capabilities, using four levers (A–D):

- **A** — split the tier-model env mapping so opus/sonnet/haiku are independently configurable.
- **B** — gateway capability declaration (`ANTHROPIC_DEFAULT_<TIER>_MODEL_NAME` / `_DESCRIPTION` / `_SUPPORTED_CAPABILITIES` companion env vars).
- **C** — runtime `fallbackModel` degradation chain.
- **D** — per-subagent tier routing.

**User's UI decision (approved):** *ModelGroups* — in Global Settings, a group is a named bundle mapping Opus/Sonnet/Haiku slots to concrete models chosen from the Models list. A session can select a group **or** a single model; selecting a single model keeps today's behavior exactly.

## Goal / non-goals

- **Goal:** `modelGroups` in `config.json`, writable through the existing `PUT /api/config` path (same mechanism as `modelList`).
- **Goal:** group sessions get split tier env vars (A), a gateway capability declaration (B), a derived fallback chain (C), and subagent tier routing (D); single-model sessions are today's behavior unchanged.
- **Goal:** a "Model Groups" management surface in Global Settings + a Model Groups section in the ModelPicker.
- **Non-goal:** a CLI flag for groups (groups are an app-level concept).
- **Non-goal:** changing spawn-time tier env vars at runtime — they apply on the next respawn (SDK limitation; see live-switch note in §7).
- **Non-goal:** relying on `CLAUDE_CODE_SUBAGENT_MODEL` (known bug history); subagent routing goes through the tier env vars and optional `Options.agents`.

## Design

### 1. Config schema

New structured key in `config.json`, alongside `modelList`:

```ts
interface ModelGroupConfig {
  id: string                 // stable identifier, e.g. 'g_xxx', unique
  name: string               // display name, e.g. "旗舰三档"
  opus?: string              // model id from modelList (or a custom gateway id)
  sonnet?: string
  haiku?: string
  main?: 'opus' | 'sonnet' | 'haiku'   // which slot is the session's main model; default 'opus'
}
```

Touch points in `server/config.ts`:

- `ConfigFile.modelGroups?: ModelGroupConfig[]`
- `ServerConfig.modelGroups: readonly ModelGroupConfig[]` (default `[]`)
- `DEFAULTS.modelGroups = Object.freeze([])`
- `WRITABLE_CONFIG_KEYS` gains `'modelGroups'` (so `PUT /api/config` can write it, and `null` clears it back to default).
- Validation in `applyParsedConfig`: `id`/`name` required non-empty strings; slot values must be strings; `main` ∈ `{'opus','sonnet','haiku'}`; duplicate ids → last wins; a malformed entry is **dropped** with `log.warn`, never blocking the whole config load (matches the file's existing tolerance).
- `GET /api/config` response includes `modelGroups` (consumed by Global Settings and the ModelPicker).

Slot values go through the existing `resolveConfiguredModel` (map a bare short name to the unique configured model whose last `/`-segment matches; a provider-prefixed id is returned unchanged), the same resolution path as the main model. An **empty slot falls back to the group's main model**.

No new CLI flag.

### 2. Pure resolver — `server/model-groups.ts` (new)

Shared by the manager (to compute `Session.model`) and the provider (to build env). Keeps one source of truth:

```ts
/** Resolve a group → main model + three concrete tier models. Empty slots
 *  fall back to the main model. Bare names resolved via resolveConfiguredModel. */
export function resolveGroup(
  group: ModelGroupConfig,
  resolve: (id: string) => string | undefined,
): { main: string; tiers: { opus: string; sonnet: string; haiku: string } }

/** True when the model id does NOT keyword-match a recognizable Claude class
 *  (no 'opus' / 'sonnet' / 'haiku' token) — i.e. an opaque gateway id that
 *  needs an explicit capability declaration. */
export function isOpaqueModel(model: string): boolean

/** Capability tokens for a tier slot, used only for opaque models. The slot
 *  position IS the class signal. haiku → [] (skip the declaration). */
export function capabilitiesForTier(
  tier: 'opus' | 'sonnet' | 'haiku',
  model: string,
): string[]
```

### 3. Provider env construction — the core change

`applyStandardQueryOpts` (currently lines 251–291) becomes tier-aware. The manager passes the group reference via `providerExtras.modelGroupId`; the provider is the single resolver for env:

```ts
const effectiveModel = opts.model || defaultConfig.defaultModel
const group = providerExtras?.modelGroupId
  ? defaultConfig.modelGroups.find((g) => g.id === providerExtras.modelGroupId)
  : undefined

if (group) {
  const r = resolveGroup(group, resolveConfiguredModel)
  opts.model = r.main                                  // session main model = main slot
  opts.env = {
    ...(opts.env ?? this.buildAnthropicEnv()),
    ANTHROPIC_DEFAULT_OPUS_MODEL: r.tiers.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: r.tiers.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: r.tiers.haiku,
    ANTHROPIC_SMALL_FAST_MODEL: r.tiers.haiku,
  }
} else {
  opts.model = effectiveModel                          // today's behavior: collapse
  opts.env = { /* unchanged: all four env vars pinned to effectiveModel */ }
}
```

**Deleted / invalid group** → the `find` misses, we take the `else` branch and collapse to `effectiveModel`. Never crashes. (Manager-side self-heal in §6.)

**Critical regression guard:** the four tier env vars are set in `applyStandardQueryOpts` (per-session `opts.env`), **never** in `buildAnthropicEnv()`'s shared cache — otherwise sessions with different groups/models would cross-contaminate. The existing `does not contaminate the shared env cache` test guards exactly this.

### 4. Lever B — gateway capability declaration

Only when `!isFirstPartyAnthropicUrl(defaultConfig.baseUrl)`. For each tier slot:

- **Recognizable id** (keyword-classifiable) → **skip** the declaration; the CLI's built-in detection is more accurate.
- **Opaque id** (`isOpaqueModel`) → declare, using the **slot as the class signal** (putting a model in the opus slot declares opus-class capabilities):

| slot | tokens |
|---|---|
| opus | `effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking` |
| sonnet | `effort,max_effort,thinking,adaptive_thinking,interleaved_thinking` |
| haiku | (none — skip) |

(The token list is a per-class constant to be validated against the actual target model at implementation time — declaring an unsupported token enables a feature the gateway may reject; declaring too few only hides an option.)

```ts
opts.env[`ANTHROPIC_DEFAULT_${T}_MODEL_NAME`] = model
opts.env[`ANTHROPIC_DEFAULT_${T}_MODEL_DESCRIPTION`] = model
opts.env[`ANTHROPIC_DEFAULT_${T}_MODEL_SUPPORTED_CAPABILITIES`] = caps.join(',')
```

Why this matters for the app: on opaque gateway models the CLI otherwise rejects / strips `Options.effortLevel` and `Options.thinking`; declaring the capability is what makes the app's own effort/thinking controls actually work through a gateway.

### 5. Levers C + D — fallback chain and subagent tiers

**C — `fallbackModel`:** for a group session, `Settings.fallbackModel` is the tier aliases below the main slot (the CLI resolves aliases through the tier env vars):

- main=opus → `['sonnet','haiku']`
- main=sonnet → `['haiku']`
- main=haiku → not set

Applied via `applyFlagSettings({ fallbackModel })` right after spawn (alongside the existing post-spawn settings batch) and again on every group switch.

**D — subagent tier routing, two layers:**

- **Automatic (from A):** once the tier env vars are split, the CLI natively routes background subagents to the haiku slot (`ANTHROPIC_SMALL_FAST_MODEL`) and resolves tier aliases to the group's models.
- **Explicit:** an optional top-level config.json key `subagentTiers?: Record<string, 'opus'|'sonnet'|'haiku'>` (agent name → slot); the provider expands it into `Options.agents` (`Record<string, AgentDefinition>`) with `model: <slot alias>`.
  - **Implementation-time verification point:** `AgentDefinition` requires `description` + `prompt`; we do not hold the CLI's built-in subagent definitions. Whether passing a partial definition under a built-in agent's name merges with the CLI's built-in must be verified with a real session. If it does not merge, this layer degrades to "new custom agents only", and the automatic layer still delivers the routing value.
  - **Verified 2026-08-27:** Probe ran with `Options.agents: { task: { model: 'deepseek/deepseek-v4-flash', description: '...', prompt: '...' } }` using `xiaomi/mimo-v2.5-pro` as main model. The model **did not honor the `agents.task` entry**: it called the `Agent` tool (not `Task`) with `model: haiku` (tier alias) and its own description/prompt, completely ignoring the provided definition. A second probe with a custom agent name (`probe-agent`) was similarly not honored (model used default parameters). **Conclusion: `Options.agents` built-in-name definitions do not merge with the CLI's built-in subagents.** The explicit layer (`subagentTiers`) is degraded to "new custom agents only"; the automatic layer (lever A: split tier env vars → `ANTHROPIC_SMALL_FAST_MODEL`) still delivers background-subagent routing.

### 6. Session state, API, persistence

- `Session` (`server/session-types.ts`) gains `modelGroupId?: string` — a persisted intent field (survives resume / fork / clear).
- A group session's `Session.model` = the resolved **main** model, so effort/thinking chips, usage, and recap all keep working unchanged.
- `shared/session-info.ts` gains `modelGroupId?: string` so the client can mark the active group in the picker and render a group badge.

Manager methods:

- `setModelGroup(id, groupId)`: validate the group exists (400 if not) → `s.model = resolveGroup(...).main`, `s.modelGroupId = groupId` → recompute `effortLevels` / `thinkingSupported` from the new main → `handle.setModel(main)` → `applyFlagSettings({ fallbackModel })` → persist.
- `setModel(id, model)`: existing behavior **plus** `s.modelGroupId = undefined` and `applyFlagSettings({ fallbackModel: undefined })` — switching to a single model fully reverts to today's behavior.

Routes:

- **New** `POST /sessions/:id/model-group`, body `{ groupId }` (unknown group → 400).
- `POST /sessions/:id/model` — unchanged externally; internally clears the group.
- `POST /sessions` body may carry `modelGroupId`; spawn passes it through `providerExtras.modelGroupId`, and `Session.model` is the resolved main. Invalid group at create → **400**.

Persistence: `SessionMeta` gains `modelGroupId`; on respawn / resume / fork the id is re-read and `resolveGroup` runs again — this is what makes group edits take effect globally on the next spawn (Approach 1's semantics).

### 7. UI

**GlobalSettingsModal** — a new **"Model Groups" tab** next to Models:
- Group list (name + opus/sonnet/haiku badges + main-slot marker).
- Add / edit: name input, per-slot dropdown (options = `modelList` + a custom-id row), main-slot three-way selector.
- Delete / reorder.
- Save via `PUT /api/config` with the `modelGroups` key.

**useModelOptions** — `GET /config` response adds `modelGroups`; the hook returns `{ id, name, tiers }[]`.

**ModelPicker** — a "Model Groups" group at the top (shown only when groups exist), then Recent / Models. Selecting a group calls a new `onSelectGroup(groupId)` prop → `POST /model-group`. `current` matching also compares `modelGroupId`.

**ChatPanel model chip** — shows `Session.model` (the resolved main model). Group sessions may show a small group-name sub-label; not required.

## Error handling & edge cases

| Scenario | Behavior |
|---|---|
| Group deleted while sessions reference it | On respawn, `find` misses → provider collapses; manager **self-heals**: clears `s.modelGroupId`, falls back to `effectiveModel`, `log.warn`. No dangling reference. |
| Group edited (slots / main changed) | Takes effect on next spawn; live sessions keep the old tiers until respawn (consistent with the live-switch note). |
| Empty slot | Falls back to the main model; multiple aliases may point at one model — harmless. |
| Slot value fails to resolve (bare name not in modelList) | That slot falls back to the main model + `log.warn`. |
| Capability mis-slot (e.g. sonnet placed in the opus slot) | The CLI declares opus-class caps for it; the app's own chips still classify by keyword. Inconsistency is confined to the CLI's internal surface; documented as "slot must be placed correctly". |
| Switching back to a single model | `setModel` clears `modelGroupId` **and** `fallbackModel` — no residual degradation chain. |
| Invalid group at create | `POST /sessions` → 400 (explicit operation rejects rather than silently falling back). |
| Concurrent config edits | Reuse the existing `updateConfigFile` promise queue — already serialized. |
| `subagentTiers` names an unknown agent | Harmless; the CLI ignores it or applies only to a same-named definition. |
| `Options.agents` built-in name merge (lever D explicit) | **Degraded (verified 2026-08-27):** probe showed `Options.agents` entries for built-in names (`task`) are not honored by the CLI — the model uses its own agent dispatch parameters. The explicit `subagentTiers` layer is degraded to "new custom agents only". The automatic layer (lever A: split tier env vars → `ANTHROPIC_SMALL_FAST_MODEL`) still delivers background-subagent routing. |

**Live-switch trade-off (approved):** a group switch applies **immediately** for the main model (`handle.setModel`) and the fallback chain (`applyFlagSettings`); the **tier env vars (subagent routing) are spawn-time** and land on the next respawn (restart / resume / clear). There is a short window after a live group switch where subagent tiers still reflect the previous spawn's env. This is an SDK runtime limitation, not a bug; documented.

## Testing

### New unit tests

**`server/model-groups.test.ts`** (pure resolver)
- `resolveGroup`: main defaults to opus; empty slots fall back to main; bare names resolve via `resolveConfiguredModel`; `main='sonnet'` picks the sonnet slot.
- `isOpaqueModel`: `claude-opus-4-20250514` → false; `gateway-xyz-9` → true.
- `capabilitiesForTier`: recognizable id → no declaration; opaque id → slot-class tokens; haiku → `[]`.

**Provider env construction** (`claude-provider` tests)
- Single model: four env vars collapse (existing tests preserved, relabeled as the single-model path).
- Group session: four env vars map to the three tiers; `opts.model` = main.
- Deleted group: collapses to `effectiveModel`.
- Capability declaration: non-first-party + opaque → `_NAME`/`_DESCRIPTION`/`_SUPPORTED_CAPABILITIES` set; first-party → not set; recognizable id → not set.
- `fallbackModel` derivation: main=opus → `['sonnet','haiku']`; main=sonnet → `['haiku']`; main=haiku → unset.

**Manager** (`session-manager.test.ts` extension)
- `POST /sessions` with `modelGroupId` → `Session.model` = main, `modelGroupId` set.
- `setModelGroup`: resolves main, switches model, recomputes effort/thinking, applies fallback.
- `setModel`: clears `modelGroupId` and `fallbackModel`.
- Respawn with a deleted group → self-heal (clear + collapse).
- `POST /sessions` with invalid group → 400.
- Respawn re-applies the persisted group.

**Config**
- `WRITABLE_CONFIG_KEYS` includes `modelGroups`.
- A malformed group entry is dropped without blocking config load.
- `GET /config` includes `modelGroups`.

**Client**
- `useModelOptions` returns `modelGroups`.
- `ModelPicker` renders the Model Groups group and calls `onSelectGroup`.

### Existing-test updates

- `session-manager.test.ts:297–313` (four-alias pinning + default fallback): keep for the single-model path, add a group path.
- The env-cache contamination test (line 315) is the key regression guard: tier env vars must stay in per-session `opts.env`, never in the cached base env.

### Implementation-time verification (not a unit test)

The `Options.agents` merge semantics with the CLI's built-in subagents (§5, lever D) — verified with a real session before finalizing the explicit layer's shape.
