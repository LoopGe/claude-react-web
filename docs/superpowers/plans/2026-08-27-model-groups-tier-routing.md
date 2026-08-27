# Model Groups: real three-tier routing (opus / sonnet / haiku) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user compose named Model Groups (Opus/Sonnet/Haiku slots → concrete models) in Global Settings, select a group or a single model per session, and have group sessions get real three-tier env routing, gateway capability declarations, a fallback degradation chain, and subagent tier routing — while single-model sessions keep today's behavior byte-for-byte.

**Architecture:** The group is config-native (`modelGroups` in `config.json`, written through the existing `PUT /api/config`). A new pure resolver (`server/model-groups.ts`) turns a group into `{ main, tiers }` and derives capability tokens + fallback aliases. The manager stores a persisted `modelGroupId` intent on `Session`/`SessionMeta`; the `claude` provider is the single place that resolves the group into the four CLI tier env vars at spawn, plus a post-spawn `applyFlagSettings({ fallbackModel })`. Runtime group switches apply main + fallback live; tier env vars land on the next respawn (SDK limitation, spec §7).

**Tech Stack:** TypeScript, Hono routes, `@anthropic-ai/claude-agent-sdk` v0.3.185, React 19, Vite, Vitest (jsdom client workspace + node server workspace).

**Spec:** `docs/superpowers/specs/2026-08-27-model-groups-tier-routing-design.md` (committed `45ea00b`). This plan argues from the spec; executors read both.

## Global Constraints

- `modelGroups` is written via the existing `PUT /api/config` path — `WRITABLE_CONFIG_KEYS` must gain `'modelGroups'`; nothing else about the PUT handler changes.
- Single-model sessions must keep today's exact behavior: the four env vars `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_` / `_HAIKU_` / `ANTHROPIC_SMALL_FAST_MODEL` collapse to the session model.
- **Regression guard:** the four tier env vars go in per-session `opts.env` (set in `applyStandardQueryOpts`), NEVER in `buildAnthropicEnv()`'s shared cache — otherwise sessions with different groups/models cross-contaminate. The existing "does not contaminate the shared env cache" test is the keeper.
- Capability declaration (`_NAME` / `_DESCRIPTION` / `_SUPPORTED_CAPABILITIES`) is emitted ONLY for opaque model ids (`isOpaqueModel`) and ONLY when `!isFirstPartyAnthropicUrl(defaultConfig.baseUrl)`.
- Empty group slot → falls back to the group's main model.
- Invalid group at **create** → 400 (explicit op rejects). Group deleted while sessions reference it → **respawn-time silent self-heal**: clear `modelGroupId`, collapse to the effective model, `log.warn`. No active server-wide scan.
- `setModel(id, model)` clears `modelGroupId` AND the fallback chain (`applyFlagSettings({ fallbackModel: null })`).
- All diagnostic logging through `createLogger(scope)` — never bare `console.*` in app code (exception: log.ts/cli.ts/errors.ts already use it).
- CSS: never hardcode color hex — use theme CSS variables. Reuse existing `settings-model-*` classes for the new UI.
- Git: each task ends with a commit only after a self-review of the task diff; commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- `npm run typecheck` runs BOTH `tsc -p tsconfig.json` and `tsc -p tsconfig.node.json`.

---

### Task 1: Config schema for `modelGroups`

**Files:**
- Modify: `server/config.ts` — `ConfigFile` (~line 24), `ServerConfig` (~line 98), `DEFAULTS` (~line 150), `applyParsedConfig` (insert after the `modelList` block, ~line 278), `WRITABLE_CONFIG_KEYS` (~line 417)
- Test: `server/config.test.ts`

**Interfaces:**
- Consumes: existing `ConfigFile` / `ServerConfig` / `DEFAULTS` / `applyParsedConfig` / `WRITABLE_CONFIG_KEYS` in `server/config.ts`.
- Produces: `interface ModelGroupConfig { id: string; name: string; opus?: string; sonnet?: string; haiku?: string; main?: 'opus' | 'sonnet' | 'haiku' }` exported from `server/config.ts`; `ServerConfig.modelGroups: readonly ModelGroupConfig[]`; `WRITABLE_CONFIG_KEYS` includes `'modelGroups'`. Task 2 imports the type; Task 3/4 read `defaultConfig.modelGroups`.

- [ ] **Step 1: Write the failing config tests**

Add to `server/config.test.ts` (it already imports `config`, `loadConfig`, and a `tempDir` helper; follow its existing `writeFileSync(join(dir, 'config.json'), …)` pattern):

```ts
import { WRITABLE_CONFIG_KEYS } from './config.js'

describe('modelGroups config', () => {
  it('WRITABLE_CONFIG_KEYS includes modelGroups', () => {
    expect(WRITABLE_CONFIG_KEYS).toContain('modelGroups')
  })

  it('loadConfig parses a valid modelGroups array and drops malformed entries', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        modelGroups: [
          { id: 'g_flagship', name: 'Flagship', opus: 'anthropic/claude-opus-4-20250514', main: 'opus' },
          // malformed: missing name → dropped; missing all slots → dropped; bad main → dropped
          { id: 'g_bad1', opus: 'op' },
          { id: 'g_bad2', name: 'NoSlots' },
          { id: 'g_bad3', name: 'BadMain', opus: 'op', main: 'claude' },
        ],
      }),
    )
    await loadConfig(dir)
    expect(config.modelGroups).toHaveLength(1)
    expect(config.modelGroups[0].id).toBe('g_flagship')
    expect(config.modelGroups[0].main).toBe('opus')
  })

  it('duplicate group ids keep the last entry', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        modelGroups: [
          { id: 'g1', name: 'First', opus: 'op' },
          { id: 'g1', name: 'Second', sonnet: 'sn' },
        ],
      }),
    )
    await loadConfig(dir)
    expect(config.modelGroups).toHaveLength(1)
    expect(config.modelGroups[0].name).toBe('Second')
    expect(config.modelGroups[0].opus).toBeUndefined()
    expect(config.modelGroups[0].sonnet).toBe('sn')
  })

  it('GET /api/config response shape includes modelGroups', () => {
    // Shape-level guard: the /config route reads serverConfig.modelGroups.
    // The route itself is exercised in Task 5; here we only pin the field's
    // existence on ServerConfig so a later rename can't silently drop it.
    expect('modelGroups' in config).toBe(true)
  })
})
```

Note: `config` is the module singleton and `loadConfig(dir)` re-freezes it. `afterEach` in the existing top-level `describe('config')` cleans `dir`; the singleton keeps whatever the last `loadConfig` set — that is fine because every test that reads `config.modelGroups` calls `loadConfig` first.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/config.test.ts`
Expected: FAIL — `WRITABLE_CONFIG_KEYS` has no `modelGroups`, `config.modelGroups` is `undefined` (`toHaveLength` fails), and `'modelGroups' in config` is `false`.

- [ ] **Step 3: Implement the schema**

In `server/config.ts`:

a) Add the exported type just above `interface ConfigFile` (~line 23):

```ts
/** A named bundle mapping the three CLI model tiers to concrete models.
 *  Empty slots fall back to the group's main model (see model-groups.ts).
 *  `main` is the slot used as the session's main model; defaults to 'opus'. */
export interface ModelGroupConfig {
  id: string
  name: string
  opus?: string
  sonnet?: string
  haiku?: string
  main?: 'opus' | 'sonnet' | 'haiku'
}
```

b) Add `modelGroups?: ModelGroupConfig[]` to `ConfigFile` (next to `modelList?: string[]`, ~line 25).

c) Add `readonly modelGroups: readonly ModelGroupConfig[]` to `ServerConfig` (next to `readonly modelList`, ~line 99).

d) Add `modelGroups: Object.freeze([])` to `DEFAULTS` (after `modelList`, ~line 155).

e) In `applyParsedConfig`, insert this block right after the `modelList` block (after line 278):

```ts
  // Model groups: a named bundle of tier-slot → concrete-model mappings.
  // A malformed entry is dropped with a warning (never blocks config load,
  // matching the file's tolerance for other fields); duplicate ids keep the
  // last entry. Groups with zero tier slots are unusable (resolveGroup's
  // main would fall to '') so they are dropped too.
  if (Array.isArray(file_.modelGroups)) {
    const byId = new Map<string, ModelGroupConfig>()
    for (const g of file_.modelGroups) {
      if (typeof g !== 'object' || g === null || Array.isArray(g)) {
        log.warn('dropping malformed model group (not an object)')
        continue
      }
      const { id, name, opus, sonnet, haiku, main } = g as Record<string, unknown>
      if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) {
        log.warn('dropping model group with a missing/blank id or name')
        continue
      }
      if (main !== undefined && main !== 'opus' && main !== 'sonnet' && main !== 'haiku') {
        log.warn(`dropping model group ${id}: main must be one of opus|sonnet|haiku`)
        continue
      }
      for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
        const v = (g as Record<string, unknown>)[slot]
        if (v !== undefined && typeof v !== 'string') {
          log.warn(`dropping model group ${id}: slot ${slot} must be a string`)
          break
        }
      }
      const entry: ModelGroupConfig = { id: id.trim(), name: name.trim() }
      for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
        const v = (g as Record<string, unknown>)[slot]
        if (typeof v === 'string' && v.trim()) entry[slot] = v.trim()
      }
      if (main !== undefined) entry.main = main as 'opus' | 'sonnet' | 'haiku'
      if (!entry.opus && !entry.sonnet && !entry.haiku) {
        log.warn(`dropping model group ${id}: no tier slots`)
        continue
      }
      byId.set(entry.id, entry)
    }
    if (byId.size > 0) {
      ;(merged as { modelGroups: readonly ModelGroupConfig[] }).modelGroups = Object.freeze([...byId.values()])
      log.info(`loaded ${byId.size} model group(s) from ${file}`)
    }
  }
```

f) Add `'modelGroups'` to `WRITABLE_CONFIG_KEYS` (after `'modelList'`, ~line 420).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/config.test.ts`
Expected: PASS (all prior config tests + the three new ones).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/config.ts server/config.test.ts
git commit -m "feat: add modelGroups config schema

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Pure resolver — `server/model-groups.ts`

**Files:**
- Create: `server/model-groups.ts`
- Test: `server/model-groups.test.ts` (new)

**Interfaces:**
- Consumes: `ModelGroupConfig` type from `./config.js` (Task 1).
- Produces:
  - `resolveGroup(group: ModelGroupConfig, resolve: (id: string) => string | undefined): { main: string; tiers: { opus: string; sonnet: string; haiku: string } }`
  - `isOpaqueModel(model: string): boolean`
  - `capabilitiesForTier(tier: 'opus' | 'sonnet' | 'haiku', model: string): string[]`
  - `fallbackAliasesFor(main: 'opus' | 'sonnet' | 'haiku'): string[]`
  - `resolveConfiguredModelId(model: string | undefined, modelList: readonly string[]): string | undefined`
  - Tasks 3 and 4 import these; Task 4's manager passes its private `resolveConfiguredModel` (same semantics as `resolveConfiguredModelId`) as the `resolve` callback; Task 3's provider passes a wrapper around `resolveConfiguredModelId`.

- [ ] **Step 1: Write the failing tests**

Create `server/model-groups.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  capabilitiesForTier,
  fallbackAliasesFor,
  isOpaqueModel,
  resolveConfiguredModelId,
  resolveGroup,
} from './model-groups.js'

describe('resolveGroup', () => {
  const resolve = (m: string) => (m === 'opus-model' ? 'provider/opus-model' : m)
  const base = {
    id: 'g1', name: 'G1',
    opus: 'opus-model', sonnet: 'sonnet-model', haiku: 'haiku-model',
  }

  it('defaults main to the opus slot and resolves bare names through resolve', () => {
    const r = resolveGroup(base, resolve)
    expect(r.main).toBe('provider/opus-model')
    expect(r.tiers).toEqual({ opus: 'provider/opus-model', sonnet: 'sonnet-model', haiku: 'haiku-model' })
  })

  it('falls empty slots back to the main model', () => {
    const r = resolveGroup({ id: 'g2', name: 'G2', opus: 'op' }, resolve)
    expect(r.tiers).toEqual({ opus: 'op', sonnet: 'op', haiku: 'op' })
    expect(r.main).toBe('op')
  })

  it('honors main=sonnet', () => {
    const r = resolveGroup({ ...base, main: 'sonnet' }, resolve)
    expect(r.main).toBe('sonnet-model')
  })
})

describe('isOpaqueModel', () => {
  it('recognizes keyword classes and flags opaque gateway ids', () => {
    expect(isOpaqueModel('claude-opus-4-20250514')).toBe(false)
    expect(isOpaqueModel('claude-sonnet-4-20250514')).toBe(false)
    expect(isOpaqueModel('claude-haiku-3-5-20241022')).toBe(false)
    expect(isOpaqueModel('anthropic/claude-opus-4-20250514')).toBe(false)
    expect(isOpaqueModel('gateway-xyz-9')).toBe(true)
    expect(isOpaqueModel('deepseek/deepseek-v4-flash')).toBe(true)
  })
})

describe('capabilitiesForTier', () => {
  it('returns the slot-class token list for opaque models', () => {
    expect(capabilitiesForTier('opus', 'gateway-xyz-9')).toEqual([
      'effort', 'xhigh_effort', 'max_effort', 'thinking', 'adaptive_thinking', 'interleaved_thinking',
    ])
    expect(capabilitiesForTier('sonnet', 'gateway-xyz-9')).toEqual([
      'effort', 'max_effort', 'thinking', 'adaptive_thinking', 'interleaved_thinking',
    ])
    expect(capabilitiesForTier('haiku', 'gateway-xyz-9')).toEqual([])
  })

  it('skips recognizable ids (let the CLI detect)', () => {
    expect(capabilitiesForTier('opus', 'claude-opus-4-20250514')).toEqual([])
    expect(capabilitiesForTier('sonnet', 'claude-sonnet-4-20250514')).toEqual([])
  })
})

describe('fallbackAliasesFor', () => {
  it('derives the degradation chain below the main slot', () => {
    expect(fallbackAliasesFor('opus')).toEqual(['sonnet', 'haiku'])
    expect(fallbackAliasesFor('sonnet')).toEqual(['haiku'])
    expect(fallbackAliasesFor('haiku')).toEqual([])
  })
})

describe('resolveConfiguredModelId', () => {
  const list = ['anthropic/claude-opus-4-20250514', 'claude-haiku-3-5-20241022']

  it('resolves bare short names and passes prefixed ids through unchanged', () => {
    expect(resolveConfiguredModelId('claude-opus-4-20250514', list)).toBe('anthropic/claude-opus-4-20250514')
    expect(resolveConfiguredModelId('anthropic/claude-opus-4-20250514', list)).toBe('anthropic/claude-opus-4-20250514')
    expect(resolveConfiguredModelId('no-such-model', list)).toBe('no-such-model')
    expect(resolveConfiguredModelId(undefined, list)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/model-groups.test.ts`
Expected: FAIL — `Cannot find module './model-groups.js'` (file not created yet).

- [ ] **Step 3: Implement the resolver**

Create `server/model-groups.ts`:

```ts
import type { ModelGroupConfig } from './config.js'

export interface ResolvedGroup {
  main: string
  tiers: { opus: string; sonnet: string; haiku: string }
}

/** Map a model id to the configured model list using the same resolution
 *  the manager applies to the main model: a BARE short name (no `/`) maps
 *  to the unique configured model whose last `/`-segment matches; a
 *  provider-prefixed id or an ambiguous short name is returned unchanged.
 *  Extracted here so the provider and the manager share one pure
 *  implementation (the manager's private resolveConfiguredModel keeps its
 *  existing behavior; this is the provider's entry point). */
export function resolveConfiguredModelId(
  model: string | undefined,
  modelList: readonly string[],
): string | undefined {
  if (!model) return undefined
  if (model.includes('/')) return model
  if (modelList.includes(model)) return model
  const matches = modelList.filter((m) => m.slice(m.lastIndexOf('/') + 1) === model)
  return matches.length === 1 ? matches[0] : model
}

/** Resolve a group to its main model + three concrete tier models. Empty
 *  slots fall back to the main model. Bare names are run through `resolve`. */
export function resolveGroup(
  group: ModelGroupConfig,
  resolve: (id: string) => string | undefined,
): ResolvedGroup {
  const slot = (t: 'opus' | 'sonnet' | 'haiku'): string | undefined => {
    const raw = group[t]
    if (!raw) return undefined
    return resolve(raw) ?? raw
  }
  const mainSlot = group.main ?? 'opus'
  // Config validation guarantees at least one non-empty slot, so the final
  // `?? ''` never triggers in practice — it only keeps the type non-optional.
  const main = slot(mainSlot) ?? slot('opus') ?? slot('sonnet') ?? slot('haiku') ?? ''
  return {
    main,
    tiers: {
      opus: slot('opus') ?? main,
      sonnet: slot('sonnet') ?? main,
      haiku: slot('haiku') ?? main,
    },
  }
}

/** True when the model id does NOT keyword-match a recognizable Claude class
 *  (no 'opus' / 'sonnet' / 'haiku' token) — i.e. an opaque gateway id that
 *  needs an explicit capability declaration. */
export function isOpaqueModel(model: string): boolean {
  const id = model.toLowerCase()
  return !(id.includes('opus') || id.includes('sonnet') || id.includes('haiku'))
}

/** Capability tokens for a tier slot, used only for opaque models. The slot
 *  position IS the class signal (putting a model in the opus slot declares
 *  opus-class capabilities). haiku → [] (skip the declaration). */
export function capabilitiesForTier(
  tier: 'opus' | 'sonnet' | 'haiku',
  model: string,
): string[] {
  if (!isOpaqueModel(model)) return []
  switch (tier) {
    case 'opus':
      return ['effort', 'xhigh_effort', 'max_effort', 'thinking', 'adaptive_thinking', 'interleaved_thinking']
    case 'sonnet':
      return ['effort', 'max_effort', 'thinking', 'adaptive_thinking', 'interleaved_thinking']
    case 'haiku':
      return []
  }
}

/** The fallback degradation chain for a group session: tier aliases BELOW the
 *  main slot, resolved by the CLI through the tier env vars. */
export function fallbackAliasesFor(main: 'opus' | 'sonnet' | 'haiku'): string[] {
  switch (main) {
    case 'opus': return ['sonnet', 'haiku']
    case 'sonnet': return ['haiku']
    case 'haiku': return []
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/model-groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx eslint server/model-groups.ts server/model-groups.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/model-groups.ts server/model-groups.test.ts
git commit -m "feat: add pure model-group resolver (resolveGroup / capabilities / fallback)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Provider env construction (levers A + B + spawn-time C)

**Files:**
- Modify: `server/providers/claude/claude-provider.ts` — imports (~line 12), a module-level `resolveConfiguredModel` helper (next to `isFirstPartyAnthropicUrl`, ~line 37), `createSession` (lines 77–206), `applyStandardQueryOpts` (lines 251–291)
- Test: `server/session-manager.test.ts` (new `describe('model groups (group sessions)')` — this file already mocks the SDK and captures `mockHandles[0].options.env`, the established harness for these env assertions)

**Interfaces:**
- Consumes: `resolveGroup`, `capabilitiesForTier`, `fallbackAliasesFor`, `resolveConfiguredModelId` from `../../model-groups.js` (Task 2); `ModelGroupConfig` type from `../../config.js` (Task 1).
- Produces: `applyStandardQueryOpts(opts, customEnv?, enabledPlugins?, group?)`; `createSession` reads `opts.providerExtras?.modelGroupId`, resolves the group, splits the four tier env vars, emits capability declarations, and post-spawn applies `applyFlagSettings({ fallbackModel })`. Task 4 passes `providerExtras.modelGroupId`; Task 5 exposes it over the wire.

- [ ] **Step 1: Write the failing group-session tests**

In `server/session-manager.test.ts`, extend the existing import on line 245 to include the test config hook:

```ts
import { __setConfigForTest, config as defaultConfig } from './config.js'
```

Then append a new describe block after the existing env tests (after line 325):

```ts
describe('model groups (group sessions)', () => {
  const GROUP = {
    id: 'g_flagship', name: 'Flagship',
    opus: 'anthropic/claude-opus-4-20250514',
    sonnet: 'anthropic/claude-sonnet-4-20250514',
    haiku: 'claude-haiku-3-5-20241022',
    main: 'opus',
  }

  afterEach(() => {
    __setConfigForTest({ modelGroups: [] })
  })

  it('maps the four tier env vars to the group slots and sets the main model', () => {
    __setConfigForTest({ modelGroups: [GROUP] })
    const info = sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' })
    const env = mockHandles[0].options.env as Record<string, string>
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-opus-4-20250514')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-3-5-20241022')
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('claude-haiku-3-5-20241022')
    expect(info.model).toBe('anthropic/claude-opus-4-20250514')
    expect(info.modelGroupId).toBe('g_flagship')
    expect(mockHandles[0].options.model).toBe('anthropic/claude-opus-4-20250514')
  })

  it('applies the fallback degradation chain on spawn for a group session', () => {
    __setConfigForTest({ modelGroups: [GROUP] })
    sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' })
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: ['sonnet', 'haiku'] })
  })

  it('empty slots fall back to the main model', () => {
    __setConfigForTest({
      modelGroups: [{ id: 'g_sonnet_only', name: 'Sonnet Only', sonnet: 'anthropic/claude-sonnet-4-20250514', main: 'sonnet' }],
    })
    sm.create({ cwd: '/tmp', modelGroupId: 'g_sonnet_only' })
    const env = mockHandles[0].options.env as Record<string, string>
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('anthropic/claude-sonnet-4-20250514')
  })

  it('single-model sessions still collapse all four aliases to the model', () => {
    // Regression guard for the single-model path (the existing tests above
    // cover it; this one pins it against accidental group leakage).
    __setConfigForTest({ modelGroups: [GROUP] })
    sm.create({ cwd: '/tmp', model: 'gw/some-model' })
    const env = mockHandles[0].options.env as Record<string, string>
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gw/some-model')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gw/some-model')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gw/some-model')
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('gw/some-model')
  })
})
```

Note: these tests exercise the provider through `sm.create`, the exact harness the existing env tests use. The `applyFlagSettings` call is made synchronously inside `createSession` (the promise resolution is async, the call is not), so `toHaveBeenCalledWith` is deterministic.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/session-manager.test.ts -t "model groups"`
Expected: FAIL — `create` throws because `providerExtras.modelGroupId` is not read yet, and `config.modelGroups` exists but the provider ignores it, so all four env vars collapse to `defaultModel`.

- [ ] **Step 3: Implement the provider changes**

In `server/providers/claude/claude-provider.ts`:

a) Add imports (after the existing `../../config.js` import):

```ts
import type { ModelGroupConfig } from '../../config.js'
import {
  capabilitiesForTier,
  fallbackAliasesFor,
  resolveConfiguredModelId,
  resolveGroup,
} from '../../model-groups.js'
```

b) Add a module-level resolver next to `isFirstPartyAnthropicUrl` (~line 37):

```ts
/** Same short-name → configured-model resolution the manager uses for the
 *  main model, wired to the provider's view of the configured list. */
function resolveConfiguredModel(model: string | undefined): string | undefined {
  return resolveConfiguredModelId(model, defaultConfig.modelList)
}
```

c) In `createSession`, after line 78 (`const sdkOptions = ...`), resolve the group:

```ts
    const modelGroupId = opts.providerExtras?.modelGroupId as string | undefined
    const group = modelGroupId ? defaultConfig.modelGroups.find((g) => g.id === modelGroupId) : undefined
```

d) Change line 111 to pass the group:

```ts
    this.applyStandardQueryOpts(sdkOptions, opts.env, opts.enabledPlugins, group)
```

e) After the effort block (after line 173), add the spawn-time fallback chain (lever C):

```ts
    // Fallback degradation chain for group sessions: tier aliases below the
    // main slot, resolved by the CLI through the tier env vars. Post-spawn
    // because fallbackModel is a Settings key with no spawn-time Options
    // equivalent — exactly like fastMode/effortLevel above.
    if (group) {
      const fallback = fallbackAliasesFor(group.main ?? 'opus')
      if (fallback.length > 0) {
        void q.applyFlagSettings({ fallbackModel: fallback }).catch((err) => {
          log.warn(`[${opts.id}] applying fallbackModel on spawn failed:`, err)
        })
      }
    }
```

f) Replace `applyStandardQueryOpts` with the tier-aware version:

```ts
  private applyStandardQueryOpts(
    opts: Options,
    customEnv?: Record<string, string>,
    enabledPlugins?: string[],
    group?: ModelGroupConfig,
  ): void {
    if (opts.includePartialMessages === undefined) opts.includePartialMessages = true
    if (!opts.pathToClaudeCodeExecutable && this.opts.claudeBinary) {
      opts.pathToClaudeCodeExecutable = this.opts.claudeBinary
    }
    const effectiveModel = opts.model || defaultConfig.defaultModel
    if (group) {
      // Real three-tier routing: each slot maps to its own model so the CLI
      // resolves tier aliases + background-subagent routing independently.
      // The four tier env vars stay in the per-session opts.env — NEVER in
      // buildAnthropicEnv()'s shared cache (cross-session contamination).
      const r = resolveGroup(group, resolveConfiguredModel)
      opts.model = r.main
      opts.env = {
        ...(opts.env ?? this.buildAnthropicEnv()),
        ANTHROPIC_DEFAULT_OPUS_MODEL: r.tiers.opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: r.tiers.sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: r.tiers.haiku,
        ANTHROPIC_SMALL_FAST_MODEL: r.tiers.haiku,
      }
      // Lever B — gateway capability declaration. Only for opaque models on
      // non-first-party base URLs: recognizable ids let the CLI's built-in
      // detection decide (more accurate), and first-party hosts need nothing.
      if (!isFirstPartyAnthropicUrl(defaultConfig.baseUrl)) {
        for (const tier of ['OPUS', 'SONNET', 'HAIKU'] as const) {
          const slot = tier.toLowerCase() as 'opus' | 'sonnet' | 'haiku'
          const caps = capabilitiesForTier(slot, r.tiers[slot])
          if (caps.length > 0) {
            opts.env[`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`] = r.tiers[slot]
            opts.env[`ANTHROPIC_DEFAULT_${tier}_MODEL_DESCRIPTION`] = r.tiers[slot]
            opts.env[`ANTHROPIC_DEFAULT_${tier}_MODEL_SUPPORTED_CAPABILITIES`] = caps.join(',')
          }
        }
      }
    } else {
      // Today's behavior unchanged: collapse all four aliases to the model.
      opts.model = effectiveModel
      opts.env = {
        ...(opts.env ?? this.buildAnthropicEnv()),
        ANTHROPIC_DEFAULT_OPUS_MODEL: effectiveModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: effectiveModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: effectiveModel,
        ANTHROPIC_SMALL_FAST_MODEL: effectiveModel,
      }
    }
    if (customEnv) opts.env = { ...opts.env, ...customEnv }
    // ... lines 265–290 unchanged (DISABLE_AUTOUPDATER pin + mpStore plugins).
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS — the four new group tests AND the three pre-existing env tests (`pins subagent model-alias env vars`, `falls back to the default model`, `does not contaminate the shared env cache`) all green.

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx eslint server/providers/claude/claude-provider.ts server/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/providers/claude/claude-provider.ts server/session-manager.test.ts
git commit -m "feat: tier-aware env routing + capability declaration + spawn fallback for group sessions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Session state, manager methods, persistence

**Files:**
- Modify: `server/session-types.ts` (`Session`, add `modelGroupId?: string` after `model?: string`, ~line 187)
- Modify: `shared/session-info.ts` (`SessionInfoBase`, add `modelGroupId?: string`)
- Modify: `server/persistence.ts` (`SessionMeta`, ~line 35; `coerceMeta`, after ~line 193)
- Modify: `server/session-manager.ts` — imports, `snapshotMeta` (939–978), `create` (984–1011), `spawn` (self-heal after line 1975; `providerExtras` at line 2210), `writeStore` (873–906), `setModel` (2915–2933), new `setModelGroup` after it, `info` (4495–4543), `resumeOpts` (1154–1180), `respawnFresh` freshOpts (1229–1245), `forkOpts` (1480–1510), `clear` settings (2630–2650) + freshOpts (2656–2671)
- Test: `server/session-manager.test.ts` (extend the Task 3 describe block)

**Interfaces:**
- Consumes: `resolveGroup`, `fallbackAliasesFor` from `./model-groups.js` (Task 2); `ModelGroupConfig` from `./config.js` (Task 1); `providerExtras.modelGroupId` handled by the provider (Task 3).
- Produces: `Session.modelGroupId`, `SessionMeta.modelGroupId`, `SessionInfo.modelGroupId`; `snapshotMeta` captures it; `spawn` self-heals; `setModel` clears it + fallback; new `setModelGroup(id: string, groupId: string): Promise<SessionInfo>`; `create(opts)` rejects an unknown group with 400. Task 5 wires routes to `setModelGroup` / `create`.

- [ ] **Step 1: Write the failing manager tests**

Extend the Task 3 `describe('model groups (group sessions)')` block in `server/session-manager.test.ts`:

```ts
  it('create rejects an unknown modelGroupId with 400', () => {
    __setConfigForTest({ modelGroups: [GROUP] })
    expect(() => sm.create({ cwd: '/tmp', modelGroupId: 'g_missing' })).toThrow(/model group g_missing not found/)
  })

  it('setModelGroup resolves main, switches model live, applies fallback, persists', async () => {
    __setConfigForTest({ modelGroups: [GROUP] })
    const info = sm.create({ cwd: '/tmp', model: 'gw/start' })
    const updated = await sm.setModelGroup(info.id, 'g_flagship')
    expect(updated.model).toBe('anthropic/claude-opus-4-20250514')
    expect(updated.modelGroupId).toBe('g_flagship')
    expect(mockHandles[0].setModel).toHaveBeenCalledWith('anthropic/claude-opus-4-20250514')
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: ['sonnet', 'haiku'] })
    expect(store.get(info.id)?.modelGroupId).toBe('g_flagship')
  })

  it('setModelGroup rejects an unknown group with 400', async () => {
    __setConfigForTest({ modelGroups: [GROUP] })
    const info = sm.create({ cwd: '/tmp' })
    await expect(sm.setModelGroup(info.id, 'g_missing')).rejects.toThrow(/model group g_missing not found/)
  })

  it('setModel clears modelGroupId and the fallback chain', async () => {
    __setConfigForTest({ modelGroups: [GROUP] })
    const info = sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' })
    mockHandles[0].applyFlagSettings.mockClear()
    const updated = await sm.setModel(info.id, 'gw/other')
    expect(updated.modelGroupId).toBeUndefined()
    expect(updated.model).toBe('gw/other')
    expect(mockHandles[0].applyFlagSettings).toHaveBeenCalledWith({ fallbackModel: null })
  })

  it('respawn with a deleted group self-heals: clears the reference and collapses', async () => {
    __setConfigForTest({ modelGroups: [GROUP] })
    const info = sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' })
    const id = info.id
    __setConfigForTest({ modelGroups: [] }) // delete the group
    const resumed = await sm.resume(id)
    expect(resumed.modelGroupId).toBeUndefined()
    // The persisted resolved main is kept; the provider collapses to it.
    expect(resumed.model).toBe('anthropic/claude-opus-4-20250514')
    const last = mockHandles[mockHandles.length - 1].options.env as Record<string, string>
    expect(last.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-opus-4-20250514')
    expect(last.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-opus-4-20250514')
    expect(last.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('anthropic/claude-opus-4-20250514')
  })

  it('respawn re-applies the persisted group', async () => {
    __setConfigForTest({ modelGroups: [GROUP] })
    const info = sm.create({ cwd: '/tmp', modelGroupId: 'g_flagship' })
    const resumed = await sm.resume(info.id)
    expect(resumed.modelGroupId).toBe('g_flagship')
    const last = mockHandles[mockHandles.length - 1].options.env as Record<string, string>
    expect(last.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-opus-4-20250514')
    expect(last.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-3-5-20241022')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/session-manager.test.ts -t "model groups"`
Expected: FAIL — `sm.create` does not reject unknown groups; `sm.setModelGroup` does not exist; `info.modelGroupId` is undefined; the self-heal/respawn tests fail because `snapshotMeta`/`writeStore` don't carry `modelGroupId`.

- [ ] **Step 3: Implement session state + persistence + manager**

a) `server/session-types.ts` — after `model?: string` (line 187):

```ts
  /** Persisted intent field: the id of the ModelGroup this session routes
   *  through (resolved to Session.model's main at spawn). Undefined for
   *  single-model sessions (today's behavior). Survives resume / fork /
   *  clear so group edits re-apply on the next spawn. */
  modelGroupId?: string
```

b) `shared/session-info.ts` — in `SessionInfoBase`, after `model`:

```ts
  modelGroupId?: string
```

c) `server/persistence.ts`:
- `SessionMeta`: after `model?: string` (line 35): `modelGroupId?: string`
- `coerceMeta`: after the `model:` line (~line 193):
```ts
      modelGroupId: typeof r.modelGroupId === 'string' ? r.modelGroupId : undefined,
```

d) `server/session-manager.ts` imports:

```ts
import { fallbackAliasesFor, resolveGroup } from './model-groups.js'
```

e) `snapshotMeta` (line 939): add `modelGroupId?: string` to the return-type annotation AND `modelGroupId: (opts as { modelGroupId?: string }).modelGroupId,` to the returned object (after `model: opts.model,` line 946).

f) `create` (line 984): widen the param + `withDefault` types and validate the group:

```ts
  create(
    opts: Options & { provider?: string; modelGroupId?: string },
    customEnv?: Record<string, string>,
    joinGroupOf?: string,
    evictingSource?: boolean,
  ): SessionInfo {
    // Explicit op: an unknown group at create is a 400, not a silent
    // fallback (contrast: a group deleted while sessions reference it
    // self-heals silently on the next respawn, below).
    const modelGroupId = (opts as { modelGroupId?: unknown }).modelGroupId
    if (modelGroupId !== undefined) {
      if (typeof modelGroupId !== 'string') {
        throw new HttpError(400, 'modelGroupId must be a string')
      }
      if (!defaultConfig.modelGroups.some((g) => g.id === modelGroupId)) {
        throw new HttpError(400, `model group ${modelGroupId} not found`)
      }
    }
    const withDefault: Options & { provider?: string; modelGroupId?: string } = {
      ...opts,
      provider: opts.provider ?? this.defaultProvider,
      model: opts.model ?? defaultConfig.defaultModel,
    }
    return this.spawn(randomUUID(), withDefault, customEnv, undefined, undefined, undefined, joinGroupOf, evictingSource)
  }
```

g) `spawn` — after `const metaSnapshot = this.snapshotMeta(fullOpts, providerName)` (line 1975), insert the self-heal resolution:

```ts
    // Model-group intent: carried via opts on create/fork/clear (new ids),
    // or re-read from the persisted meta on same-id respawn (resume /
    // respawnFresh). A deleted group self-heals: clear the reference and
    // collapse to the effective model (the provider's own `find` also
    // misses and collapses — both sides agree).
    const modelGroupId = (fullOpts as { modelGroupId?: string }).modelGroupId ?? existingMeta?.modelGroupId
    if (modelGroupId) {
      const group = defaultConfig.modelGroups.find((g) => g.id === modelGroupId)
      if (group) {
        metaSnapshot.model = resolveGroup(group, resolveConfiguredModel).main
        metaSnapshot.modelGroupId = modelGroupId
      } else {
        log.warn(`[session ${id}] model group ${modelGroupId} no longer exists — clearing reference`)
        metaSnapshot.modelGroupId = undefined
      }
    }
```

Also widen `spawn`'s opts param type to accept `modelGroupId` (add `modelGroupId?: string` to the `Options & { provider?: string }` union).

h) `spawn` — `providerExtras` (line 2210):

```ts
      providerExtras: { sdkOptions, modelGroupId: session.modelGroupId },
```

i) `writeStore` (line 873): add `modelGroupId: s.modelGroupId,` after `model: s.model,`.

j) `info` (line 4495): add `modelGroupId: s.modelGroupId,` after `model: s.model,`.

k) `setModel` (line 2915) — replace with the group-clearing version:

```ts
  async setModel(id: string, model?: string): Promise<SessionInfo> {
    const s = this.requireLive(id)
    const wasGroup = !!s.modelGroupId
    await this.requireHandleMethod<(model?: string) => Promise<void>>(
      s,
      'setModel',
      'model switching',
      'supportsModelSwitch',
    )(model)
    if (wasGroup) {
      // Switching to a single model fully reverts today's behavior: clear
      // the group reference AND the fallback degradation chain so no
      // residual aliases survive the switch.
      await this.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
        s,
        'applyFlagSettings',
        'fallback model',
        'supportsModelSwitch',
      )({ fallbackModel: null })
    }
    s.model = model
    s.modelGroupId = undefined
    s.lastActivityAt = Date.now()
    s.effortLevels = effortLevelsForModel(s.model)
    s.thinkingSupported = supportsThinkingForModel(s.model)
    this.persist(s)
    return this.info(s)
  }
```

l) Insert `setModelGroup` after `setModel` (after line 2933):

```ts
  /** Point a session at a ModelGroup. The main model + fallback chain switch
   *  immediately (live); the tier env vars (subagent routing) land on the
   *  next respawn — an SDK runtime limitation, not a bug (spec §7). */
  async setModelGroup(id: string, groupId: string): Promise<SessionInfo> {
    const s = this.requireLive(id)
    const group = defaultConfig.modelGroups.find((g) => g.id === groupId)
    if (!group) throw new HttpError(400, `model group ${groupId} not found`)
    const r = resolveGroup(group, resolveConfiguredModel)
    await this.requireHandleMethod<(model?: string) => Promise<void>>(
      s,
      'setModel',
      'model switching',
      'supportsModelSwitch',
    )(r.main)
    const fallback = fallbackAliasesFor(group.main ?? 'opus')
    if (fallback.length > 0) {
      await this.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
        s,
        'applyFlagSettings',
        'fallback model',
        'supportsModelSwitch',
      )({ fallbackModel: fallback })
    }
    s.model = r.main
    s.modelGroupId = groupId
    s.lastActivityAt = Date.now()
    s.effortLevels = effortLevelsForModel(s.model)
    s.thinkingSupported = supportsThinkingForModel(s.model)
    this.persist(s)
    return this.info(s)
  }
```

m) Carry-forward the intent on the four new-id/same-id spawn builders:
- `resumeOpts` (line 1154): add `modelGroupId?: string` to the type union and `modelGroupId: meta.modelGroupId,` to the literal.
- `respawnFresh` freshOpts (line 1229): add `modelGroupId?: string` to the union and `modelGroupId: meta.modelGroupId,`.
- `forkOpts` (line 1480): add `modelGroupId?: string` to the union and `modelGroupId: meta.modelGroupId,`.
- `clear` settings object (line 2630): add `modelGroupId: s.modelGroupId,`; `clear` freshOpts (line 2656): add `modelGroupId?: string` to the union and `modelGroupId: settings.modelGroupId,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/session-manager.test.ts server/persistence.test.ts`
Expected: PASS — all new manager tests plus the full existing suite.

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx eslint server/session-manager.ts server/session-types.ts server/persistence.ts shared/session-info.ts server/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/session-manager.ts server/session-types.ts server/persistence.ts shared/session-info.ts server/session-manager.test.ts
git commit -m "feat: persist modelGroupId intent + manager setModelGroup/self-heal + setModel clears group

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Routes — create body, `/model-group`, `/config` surfaces

**Files:**
- Modify: `server/routes/sessions.ts` — `narrowCreateBody` (line 92, add `'modelGroupId'` to `stringFields`), new `POST /sessions/:id/model-group` (after `/model`, line 465)
- Modify: `server/app.ts` — `GET /config` (line 211, add `modelGroups`)
- Modify: `server/routes/config-routes.ts` — `GET /config/full` (line 211, add `modelGroups`)
- Modify: `src/types/config.ts` — `ConfigResponse` + `FullServerConfig` + new `ModelGroupConfig` client type
- Test: `server/routes/sessions-model-group.test.ts` (new); `server/app-model-groups.test.ts` (new, light buildApp test); extend `server/session-manager.test.ts` create-body assertions

**Interfaces:**
- Consumes: `sm.create` with `modelGroupId` in the body; `sm.setModelGroup(id, groupId)` (Task 4); `serverConfig.modelGroups` (Task 1).
- Produces: wire contract `POST /sessions/:id/model-group` `{ groupId }` → 200 `{ session }` | 400; `POST /sessions` accepts `modelGroupId` (string; unknown group → 400 via `create`); `GET /config` and `GET /config/full` include `modelGroups`. Task 6 consumes these from the client.

- [ ] **Step 1: Write the failing route tests**

Create `server/routes/sessions-model-group.test.ts` (mirrors `sessions-memory.test.ts`'s mock-SessionManager pattern):

```ts
import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    setModelGroup: vi.fn(async () => ({ id: 's1', model: 'm', modelGroupId: 'g1' })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

function post(app: ReturnType<typeof makeApp>['app'], path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /sessions/:id/model-group', () => {
  it('forwards groupId to sm.setModelGroup and wraps the session', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/model-group', { groupId: 'g1' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: { modelGroupId: string } }
    expect(body.session.modelGroupId).toBe('g1')
    expect(sm.setModelGroup).toHaveBeenCalledWith('s1', 'g1')
  })

  it('rejects a missing groupId with 400 and does not call the manager', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/model-group', {})
    expect(res.status).toBe(400)
    expect(sm.setModelGroup).not.toHaveBeenCalled()
  })

  it('rejects a non-string groupId with 400', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/model-group', { groupId: 42 })
    expect(res.status).toBe(400)
    expect(sm.setModelGroup).not.toHaveBeenCalled()
  })
})

describe('POST /sessions create-time modelGroupId', () => {
  it('passes a valid modelGroupId through to sm.create', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions', { modelGroupId: 'g1' })
    expect(res.status).toBe(201)
    const calls = (sm.create as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const opts = calls[0][0] as { modelGroupId?: unknown }
    expect(opts.modelGroupId).toBe('g1')
  })

  it('rejects a non-string modelGroupId with 400 and does not create', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions', { modelGroupId: 42 })
    expect(res.status).toBe(400)
    expect(sm.create).not.toHaveBeenCalled()
  })
})
```

Create `server/app-model-groups.test.ts` (lightweight — `buildApp()` accepts no opts):

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { __setConfigForTest } from './config.js'

describe('GET /api/config modelGroups', () => {
  afterEach(() => {
    __setConfigForTest({ modelGroups: [] })
  })

  it('includes modelGroups in the /config response', async () => {
    __setConfigForTest({ modelGroups: [{ id: 'g1', name: 'G1', opus: 'op' }] })
    const { app } = buildApp()
    const res = await app.request('/api/config')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { modelGroups: unknown }
    expect(body.modelGroups).toEqual([{ id: 'g1', name: 'G1', opus: 'op' }])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/routes/sessions-model-group.test.ts server/app-model-groups.test.ts`
Expected: FAIL — `POST /sessions/:id/model-group` returns 404 (no route); `POST /sessions` accepts a numeric `modelGroupId` (no validation); `/config` response has no `modelGroups`.

- [ ] **Step 3: Implement the routes**

a) `server/routes/sessions.ts` `narrowCreateBody` (line 93):

```ts
  const stringFields = ['cwd', 'model', 'title', 'pathToClaudeCodeExecutable', 'modelGroupId']
```

b) `server/routes/sessions.ts` — insert after the `/model` route (after line 465):

```ts
  // Point the session at a ModelGroup. Unknown groups are a 400 (explicit op
  // rejects rather than silently falling back).
  app.post('/sessions/:id/model-group', async (c) => {
    const body = await safeJson<{ groupId?: string }>(c.req)
    if (!body.groupId || typeof body.groupId !== 'string') {
      return c.json({ error: 'groupId is required' }, 400)
    }
    const info = await sm.setModelGroup(c.req.param('id'), body.groupId)
    return c.json({ session: info })
  })
```

c) `server/app.ts` `GET /config` (line 211) — add `modelGroups: serverConfig.modelGroups,` after `models:`.

d) `server/routes/config-routes.ts` `GET /config/full` (line 215) — add `modelGroups: serverConfig.modelGroups,` after `modelList:`.

e) `src/types/config.ts`:

```ts
/** Client-side mirror of the server's ModelGroupConfig (server/config.ts). */
export interface ModelGroupConfig {
  id: string
  name: string
  opus?: string
  sonnet?: string
  haiku?: string
  main?: 'opus' | 'sonnet' | 'haiku'
}
```

Add `modelGroups?: ModelGroupConfig[]` to both `ConfigResponse` and `FullServerConfig`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/routes/sessions-model-group.test.ts server/app-model-groups.test.ts server/routes/sessions-memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npx eslint server/routes/sessions.ts server/app.ts server/routes/config-routes.ts src/types/config.ts`
Expected: PASS (both tsconfigs — the client type lives in `src/`).

- [ ] **Step 6: Commit**

```bash
git add server/routes/sessions.ts server/app.ts server/routes/config-routes.ts src/types/config.ts server/routes/sessions-model-group.test.ts server/app-model-groups.test.ts
git commit -m "feat: expose modelGroupId over POST /sessions + new /model-group route + config endpoints

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Client data layer — `useModelOptions` + `ModelPicker` + `ChatPanel`

**Files:**
- Modify: `src/hooks/useModelOptions.ts` — add `modelGroups` to `ModelOptions` + fetch
- Modify: `src/components/ModelPicker.tsx` — Model Groups group, `onSelectGroup`, `currentGroupId`
- Modify: `src/components/ChatPanel.tsx` — `commitGroup`, pass new props to `ModelPicker`
- Test: `src/hooks/useModelOptions.test.ts` (new); `src/components/ModelPicker.test.tsx` (new)

**Interfaces:**
- Consumes: `GET /config` `modelGroups` (Task 5); `session.modelGroupId` on `SessionInfo` (Task 4); `POST /sessions/:id/model-group` (Task 5).
- Produces: `ModelOptions.modelGroups: ModelGroupConfig[]`; `ModelPicker` prop `onSelectGroup?: (groupId: string) => void` and `currentGroupId?: string`. Task 7 reuses the `ModelGroupConfig` client type from `src/types/config.ts`.

- [ ] **Step 1: Write the failing client tests**

Create `src/hooks/useModelOptions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useModelOptions } from './useModelOptions'
import { api } from './useApi'

vi.mock('./useApi', () => ({ api: { get: vi.fn() } }))

describe('useModelOptions', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    // readRecentModels() reads localStorage; jsdom starts empty.
    window.localStorage.clear()
  })

  it('returns modelGroups from /config alongside models', async () => {
    vi.mocked(api.get).mockResolvedValue({
      models: ['m1'],
      modelGroups: [{ id: 'g1', name: 'Flagship', opus: 'm1', main: 'opus' }],
    })
    const { result } = renderHook(() => useModelOptions('s1', true))
    await waitFor(() => expect(result.current.modelGroups.length).toBe(1))
    expect(result.current.modelGroups[0]).toMatchObject({ id: 'g1', name: 'Flagship', opus: 'm1' })
    expect(result.current.models.map((m) => m.id)).toEqual(['m1'])
  })

  it('defaults modelGroups to [] when the response omits it', async () => {
    vi.mocked(api.get).mockResolvedValue({ models: ['m1'] })
    const { result } = renderHook(() => useModelOptions('s1', true))
    await waitFor(() => expect(result.current.models.length).toBe(1))
    expect(result.current.modelGroups).toEqual([])
  })
})
```

Create `src/components/ModelPicker.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ModelPicker } from './ModelPicker'
import type { ModelOptions } from '../hooks/useModelOptions'

function makeProps(overrides: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const options: ModelOptions = {
    models: [{ id: 'm1' }, { id: 'm2' }],
    recents: [],
    defaultModel: 'm1',
    modelGroups: [
      { id: 'g1', name: 'Flagship', opus: 'm1', sonnet: 'm2', main: 'opus' },
      { id: 'g2', name: 'Budget', haiku: 'm2', main: 'haiku' },
    ],
  }
  return {
    anchor: { x: 0, y: 0 },
    current: undefined,
    currentGroupId: undefined,
    options,
    onSelect: vi.fn(),
    onSelectGroup: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

describe('ModelPicker', () => {
  it('renders a Model Groups group before Models and calls onSelectGroup', () => {
    render(<ModelPicker {...makeProps()} />)
    expect(screen.getByText('Model Groups')).toBeTruthy()
    fireEvent.click(screen.getByText('Flagship'))
    expect(screen.getByText('Models')).toBeTruthy()
    expect(makeProps().onSelectGroup).not.toHaveBeenCalled() // fresh fn, see below
  })

  it('calls onSelectGroup with the group id', () => {
    const props = makeProps()
    render(<ModelPicker {...props} />)
    fireEvent.click(screen.getByText('Budget'))
    expect(props.onSelectGroup).toHaveBeenCalledWith('g2')
  })

  it('marks the active group row', () => {
    const props = makeProps({ currentGroupId: 'g1' })
    render(<ModelPicker {...props} />)
    const item = screen.getByText('Flagship').closest('button')
    expect(item?.className).toContain('active')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/hooks/useModelOptions.test.ts src/components/ModelPicker.test.tsx`
Expected: FAIL — `result.current.modelGroups` is `undefined`; `ModelPicker` renders no "Model Groups" heading and `onSelectGroup` is not a prop.

- [ ] **Step 3: Implement `useModelOptions`**

In `src/hooks/useModelOptions.ts`:

a) Import the client type: `import type { ModelGroupConfig } from '../types/config'`

b) Widen the interface:

```ts
export interface ModelOptions {
  models: ModelOption[]
  recents: string[]
  defaultModel?: string
  /** The user's configured ModelGroups (config.modelGroups), in order. */
  modelGroups: ModelGroupConfig[]
}
```

c) Widen the state shape and the fetch type:

```ts
  const [data, setData] = useState<{
    sessionId: string
    models: ModelOption[]
    defaultModel?: string
    modelGroups: ModelGroupConfig[]
  } | null>(null)
```

and the fetch:

```ts
      let cfg: { models?: string[]; modelGroups?: ModelGroupConfig[] }
      try {
        cfg = await api.get<{ models?: string[]; modelGroups?: ModelGroupConfig[] }>('/config', { signal: ac.signal })
      } catch {
```

and after computing `merged`, set the state:

```ts
      setData({ sessionId, models: merged, defaultModel, modelGroups: cfg.modelGroups ?? [] })
```

d) Return the new field:

```ts
  const modelGroups = fresh ? fresh.modelGroups : []
  return { models, recents, defaultModel, modelGroups }
```

- [ ] **Step 4: Implement `ModelPicker`**

In `src/components/ModelPicker.tsx`:

a) Props — add two optional fields:

```ts
  /** Currently selected ModelGroup id (session.modelGroupId). Undefined for
   *  single-model sessions. */
  currentGroupId?: string
  /** Called with the chosen ModelGroup id. */
  onSelectGroup?: (groupId: string) => void
```

b) In the `rows` `useMemo`, insert the Model Groups section BEFORE the recents section (right after `let firstInGroup = true`):

```ts
    // Model Groups — shown first when any exist. A group row marks the
    // session's current group as active; selecting it calls onSelectGroup.
    const groups = options.modelGroups.filter(
      (g) =>
        !q ||
        g.name.toLowerCase().includes(q) ||
        [g.opus, g.sonnet, g.haiku].some((m) => m?.toLowerCase().includes(q)),
    )
    if (groups.length > 0) {
      firstInGroup = true
      for (const g of groups) {
        const slotLabel = [g.opus, g.sonnet, g.haiku].filter(Boolean).join(' · ')
        result.push({
          key: `group:${g.id}`,
          label: g.name,
          sub: slotLabel,
          heading: firstInGroup ? 'Model Groups' : undefined,
          active: currentGroupId === g.id,
          select: () => onSelectGroup?.(g.id),
        })
        firstInGroup = false
      }
    }
```

c) Add `currentGroupId` to the `useMemo` dependency array: `[query, options, current, currentGroupId, onSelect, onSelectGroup]`.

- [ ] **Step 5: Implement `ChatPanel`**

In `src/components/ChatPanel.tsx`:

a) Add `commitGroup` next to `commitModel` (after line 412):

```ts
  const commitGroup = (groupId: string) => {
    setModelMenu(null)
    if (groupId === (session.modelGroupId ?? '')) return
    commitWithRollback(
      session,
      `/sessions/${session.id}/model-group`,
      { groupId },
      // Restore both the resolved main model AND the group reference on
      // failure — a group switch changes both on the session.
      { model: session.model, modelGroupId: session.modelGroupId },
      `Couldn't change model group`,
      onSessionUpdate,
      toast.error,
    )
  }
```

b) Pass the new props to `ModelPicker` (line 855–865):

```tsx
            <ModelPicker
              key="model"
              anchor={modelMenu}
              current={session.model}
              currentGroupId={session.modelGroupId}
              options={modelOptions}
              disabled={chipsDisabled}
              onSelect={(model) => commitModel(model)}
              onSelectGroup={(groupId) => commitGroup(groupId)}
              onClose={() => setModelMenu(null)}
            />
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/hooks/useModelOptions.test.ts src/components/ModelPicker.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck + lint**

Run: `npx tsc -p tsconfig.json --noEmit && npx eslint src/hooks/useModelOptions.ts src/components/ModelPicker.tsx src/components/ChatPanel.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useModelOptions.ts src/components/ModelPicker.tsx src/components/ChatPanel.tsx src/hooks/useModelOptions.test.ts src/components/ModelPicker.test.tsx
git commit -m "feat: surface ModelGroups in the model picker + ChatPanel group switch

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Global Settings — "Model Groups" tab

**Files:**
- Modify: `src/components/GlobalSettingsModal.tsx` — `Tab` union (line 54), `tabs` array (367–378), `modelGroups` state + load (196–224), `handleSave` (259–298), add/edit/move/remove handlers (near 327–346), render branch (next to the `ModelsTab` branch, 465–479), new `ModelGroupsTab` component (next to `ModelsTab`, ~686)
- Test: `src/components/GlobalSettingsModal.test.tsx` (new — tab list + save payload)

**Interfaces:**
- Consumes: `FullServerConfig.modelGroups` + `ModelGroupConfig` from `src/types/config.ts` (Task 5); `modelList` state already loaded; `api.put('/config', …)` already wired.
- Produces: the user's ModelGroup CRUD surface in Global Settings, persisted via the existing `PUT /api/config` payload. Task 6's picker consumes the saved groups on the next `GET /config`.

- [ ] **Step 1: Write the failing test**

Create `src/components/GlobalSettingsModal.test.tsx`. The modal is large and lazy-loads tabs; to keep the test hermetic, render it and drive the minimal surface we changed — the tab list must include "Model Groups", and saving with a group in state PUTs it:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { GlobalSettingsModal } from './GlobalSettingsModal'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), put: vi.fn() } }))

describe('GlobalSettingsModal Model Groups tab', () => {
  it('lists a Model Groups tab', async () => {
    vi.mocked(api.get).mockResolvedValue({ modelList: ['m1'], modelGroups: [] })
    render(
      <GlobalSettingsModal
        open
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    await waitFor(() => expect(screen.getByText('Model Groups')).toBeTruthy())
  })

  it('PUTs modelGroups on save', async () => {
    vi.mocked(api.get).mockResolvedValue({
      modelList: ['m1'],
      modelGroups: [{ id: 'g1', name: 'G1', opus: 'm1', main: 'opus' }],
    })
    vi.mocked(api.put).mockResolvedValue({ ok: true })
    render(<GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />)
    await waitFor(() => expect(screen.getByText('Model Groups')).toBeTruthy())
    // Save button — the modal footer's primary action.
    const save = screen.getByRole('button', { name: /save/i })
    save.click()
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        '/config',
        expect.objectContaining({ modelGroups: [{ id: 'g1', name: 'G1', opus: 'm1', main: 'opus' }] }),
      ),
    )
  })
})
```

Note: if the lazy `Tab` internals make the save button name differ, locate it via `screen.getByText('Save').closest('button')` instead. Adjust to the actual button label at implementation time.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx`
Expected: FAIL — "Model Groups" text not found (no tab), and `api.put` is not called with `modelGroups`.

- [ ] **Step 3: Implement the tab**

In `src/components/GlobalSettingsModal.tsx`:

a) Import the client type: `import type { ModelGroupConfig } from '../types/config'`

b) `Tab` union (line 54): add `'model-groups'`.

c) `tabs` array (line 367): insert `{ key: 'model-groups', label: 'Model Groups' }` after the Models entry.

d) State (near `const [modelList, setModelList]`, line 154):

```ts
  const [modelGroups, setModelGroups] = useState<ModelGroupConfig[]>([])
```

e) Load (in the `/config/full` effect, after `setModelList`, line 203):

```ts
        setModelGroups(cfg.modelGroups ?? [])
```

f) Handlers (near `addModel`/`removeModel`, ~line 327):

```ts
  const addModelGroup = () => {
    const id = crypto.randomUUID()
    setModelGroups([...modelGroups, { id, name: `Group ${modelGroups.length + 1}`, main: 'opus' }])
  }
  const removeModelGroup = (id: string) => {
    setModelGroups(modelGroups.filter((g) => g.id !== id))
  }
  const moveModelGroup = (index: number, direction: -1 | 1) => {
    const next = [...modelGroups]
    const j = index + direction
    if (j < 0 || j >= next.length) return
    ;[next[index], next[j]] = [next[j], next[index]]
    setModelGroups(next)
  }
  const updateModelGroup = (id: string, patch: Partial<ModelGroupConfig>) => {
    setModelGroups(modelGroups.map((g) => (g.id === id ? { ...g, ...patch } : g)))
  }
```

g) `handleSave` `updates` (after `modelList`, line 265):

```ts
        modelGroups: modelGroups.length > 0 ? modelGroups : null,
```

h) Render branch (after the `ModelsTab` branch, ~line 479):

```tsx
              {tab === 'model-groups' && (
                <ModelGroupsTab
                  groups={modelGroups}
                  modelList={modelList}
                  onAddGroup={addModelGroup}
                  onRemoveGroup={removeModelGroup}
                  onMoveGroup={moveModelGroup}
                  onUpdateGroup={updateModelGroup}
                />
              )}
```

i) The component — add `ModelGroupsTab` next to `ModelsTab` (after line 807):

```tsx
function ModelGroupsTab({
  groups, modelList, onAddGroup, onRemoveGroup, onMoveGroup, onUpdateGroup,
}: {
  groups: ModelGroupConfig[]
  modelList: string[]
  onAddGroup: () => void
  onRemoveGroup: (id: string) => void
  onMoveGroup: (index: number, direction: -1 | 1) => void
  onUpdateGroup: (id: string, patch: Partial<ModelGroupConfig>) => void
}) {
  const uid = useId()
  const slots: { key: 'opus' | 'sonnet' | 'haiku'; label: string }[] = [
    { key: 'opus', label: 'Opus' },
    { key: 'sonnet', label: 'Sonnet' },
    { key: 'haiku', label: 'Haiku' },
  ]
  return (
    <Field
      label="Model Groups"
      hint="Groups map Opus/Sonnet/Haiku slots to concrete models. Sessions can select a group or a single model; empty slots inherit the main slot."
    >
      <div className="settings-model-list">
        {groups.length === 0 && (
          <div className="settings-model-empty">No groups yet. Add one to bundle tier models.</div>
        )}
        {groups.map((g, i) => (
          <div key={g.id} className="settings-model-group">
            <div className="settings-model-row">
              <span className="settings-model-rank" title="Group">{i + 1}</span>
              <input
                className="input settings-model-input"
                value={g.name}
                onChange={(e) => onUpdateGroup(g.id, { name: e.target.value })}
                aria-label="Group name"
              />
              <div className="settings-model-move" role="group" aria-label="Move group priority">
                <button
                  className="btn-icon-sm settings-model-action"
                  onClick={() => onMoveGroup(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  aria-label="Move up"
                >
                  <IconArrowUp size={12} />
                </button>
                <button
                  className="btn-icon-sm settings-model-action"
                  onClick={() => onMoveGroup(i, 1)}
                  disabled={i === groups.length - 1}
                  title="Move down"
                  aria-label="Move down"
                >
                  <IconArrowDown size={12} />
                </button>
              </div>
              <button
                className="btn-icon-sm settings-model-action danger"
                onClick={() => onRemoveGroup(g.id)}
                title="Remove"
                aria-label="Remove"
              >
                <IconX size={12} />
              </button>
            </div>
            <div className="settings-model-group-slots">
              {slots.map((slot) => (
                <div key={slot.key} className="settings-model-group-slot">
                  <label className="settings-model-group-slot-label" htmlFor={`${uid}-${g.id}-${slot.key}`}>
                    {slot.label}
                  </label>
                  <input
                    className="input settings-model-input"
                    id={`${uid}-${g.id}-${slot.key}`}
                    list={`${uid}-model-list`}
                    value={g[slot.key] ?? ''}
                    placeholder="(inherit main)"
                    onChange={(e) => onUpdateGroup(g.id, { [slot.key]: e.target.value || undefined } as Partial<ModelGroupConfig>)}
                  />
                </div>
              ))}
              <div className="settings-model-group-main">
                <label className="settings-model-group-slot-label" htmlFor={`${uid}-${g.id}-main`}>Main</label>
                <select
                  className="input settings-model-select"
                  id={`${uid}-${g.id}-main`}
                  value={g.main ?? 'opus'}
                  onChange={(e) => onUpdateGroup(g.id, { main: e.target.value as 'opus' | 'sonnet' | 'haiku' })}
                >
                  <option value="opus">Opus</option>
                  <option value="sonnet">Sonnet</option>
                  <option value="haiku">Haiku</option>
                </select>
              </div>
            </div>
          </div>
        ))}
        <datalist id={`${uid}-model-list`}>
          {modelList.map((m) => <option key={m} value={m} />)}
        </datalist>
        <div className="settings-model-add-row">
          <button className="btn btn-xs settings-model-add-btn" onClick={onAddGroup}>Add Group</button>
        </div>
      </div>
    </Field>
  )
}
```

j) `heightAnimationKey` (line 380): add `modelGroups.length` to the join so the modal re-measures when groups change.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc -p tsconfig.json --noEmit && npx eslint src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.test.tsx`
Expected: PASS.

- [ ] **Step 6: Manual smoke (optional but recommended)**

Run: `npm run dev` → open Global Settings → Models tab now has a "Model Groups" entry. Add a group, save, reopen — the group persists in `~/.claude-react-web/config.json` under `modelGroups`.

- [ ] **Step 7: Commit**

```bash
git add src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.test.tsx
git commit -m "feat: add Model Groups management tab to Global Settings

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Lever D explicit layer — `subagentTiers` (probe + conditional)

**Files:**
- Create: `scripts/probe-subagent-agents.mjs` (throwaway probe; not committed in final state)
- Modify (conditional on probe result): `server/config.ts` (add `subagentTiers?: Record<string, 'opus' | 'sonnet' | 'haiku'>` to `ConfigFile`/`ServerConfig`/`DEFAULTS`/`applyParsedConfig`/`WRITABLE_CONFIG_KEYS`), `server/providers/claude/claude-provider.ts` (expand into `Options.agents`)
- Test: the probe's own output IS the verification; no unit test until the shape is confirmed.

**Interfaces:**
- Consumes: the automatic layer from Task 3 (split tier env vars already route background subagents to the haiku slot). `fallbackAliasesFor`/`resolveGroup` from Task 2.
- Produces: either the `subagentTiers` config key + `Options.agents` expansion, or a documented degradation ("new custom agents only") in the spec's error table.

**Context (spec §5, lever D):** the automatic layer is already shipped by Task 3 — once the tier env vars are split, the CLI natively routes background subagents to `ANTHROPIC_SMALL_FAST_MODEL` and resolves tier aliases to the group's models. The explicit layer (`subagentTiers` → `Options.agents`) is conditional on an implementation-time verification: `AgentDefinition` requires `description` + `prompt`, which the app does not hold for the CLI's built-in subagents. Whether passing a partial definition under a built-in agent's name merges with (or replaces) the CLI's built-in must be observed with a real session.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-subagent-agents.mjs`:

```js
// Throwaway probe (not committed in final state). Verifies whether the SDK
// MERGES an Options.agents entry under a built-in subagent's name over the
// CLI's built-in definition, or REPLACES it. Run with a real auth token:
//   ANTHROPIC_AUTH_TOKEN=... node scripts/probe-subagent-agents.mjs
import { query } from '@anthropic-ai/claude-agent-sdk'

const prompt = 'Use the Task tool to ask a subagent for the single word "ready". Then stop.'

const options = {
  cwd: process.cwd(),
  permissionMode: 'bypassPermissions',
  model: 'claude-sonnet-4-20250514',
  agents: {
    task: {
      description: 'PROBE: does a partial built-in-name definition merge?',
      prompt: 'You are a probe subagent. Reply with the single word "ready" and nothing else.',
      model: 'claude-haiku-3-5-20241022',
    },
  },
}

const result = await query({ prompt, options }).next()
console.log('=== probe result ===')
console.log(JSON.stringify(result, null, 2))
```

- [ ] **Step 2: Run the probe and record the behavior**

Run: `ANTHROPIC_AUTH_TOKEN=<token> node scripts/probe-subagent-agents.mjs`
Record which model the Task subagent actually used (look for the subagent's `model` in the tool_result, or an `agent` message with a model name). Two outcomes:

- **Merges** (the subagent ran on `claude-haiku-3-5-20241022` and the definition's prompt was honored) → proceed to Step 3.
- **Replaces/fails** (the Task tool errors with "agent definition requires prompt/description" or the subagent ignores the partial definition) → the explicit layer degrades to "new custom agents only"; document the degradation in the spec's error table (edit `docs/superpowers/specs/2026-08-27-model-groups-tier-routing-design.md` §5) and STOP the task here (skip Steps 3–4, do Step 5 with the documentation-only change).

- [ ] **Step 3 (conditional): Implement `subagentTiers`**

a) `server/config.ts`:
- `ConfigFile`: `subagentTiers?: Record<string, 'opus' | 'sonnet' | 'haiku'>`
- `ServerConfig`: `readonly subagentTiers: Readonly<Record<string, 'opus' | 'sonnet' | 'haiku'>>` (default `{}`)
- `DEFAULTS`: `subagentTiers: Object.freeze({})`
- `WRITABLE_CONFIG_KEYS`: add `'subagentTiers'`
- `applyParsedConfig` block (drop invalid values, keep valid keys):

```ts
  if (file_.subagentTiers && typeof file_.subagentTiers === 'object' && !Array.isArray(file_.subagentTiers)) {
    const tiers: Record<string, 'opus' | 'sonnet' | 'haiku'> = {}
    for (const [agent, slot] of Object.entries(file_.subagentTiers)) {
      if (slot === 'opus' || slot === 'sonnet' || slot === 'haiku') {
        tiers[agent] = slot
      } else {
        log.warn(`dropping subagentTiers entry ${agent}: slot must be opus|sonnet|haiku`)
      }
    }
    if (Object.keys(tiers).length > 0) {
      ;(merged as { subagentTiers: Readonly<Record<string, 'opus' | 'sonnet' | 'haiku'>> }).subagentTiers =
        Object.freeze(tiers)
    }
  }
```

b) `server/providers/claude/claude-provider.ts` — in `createSession`, when a `group` is present, expand the mapping into `Options.agents`. Add a module helper:

```ts
import type { ModelGroupConfig } from '../../config.js'
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'

/** Expand subagentTiers (agent name → tier slot) into SDK Options.agents.
 *  Only called for group sessions; each definition points at the slot's
 *  model so the CLI resolves it through the split tier env vars. */
function buildSubagentAgents(
  subagentTiers: Readonly<Record<string, 'opus' | 'sonnet' | 'haiku'>>,
  group: ModelGroupConfig,
  resolve: (m: string | undefined) => string | undefined,
): Record<string, AgentDefinition> {
  const r = resolveGroup(group, resolve)
  const agents: Record<string, AgentDefinition> = {}
  for (const [name, slot] of Object.entries(subagentTiers)) {
    const model = r.tiers[slot]
    agents[name] = {
      description: `Subagent for ${name} (ModelGroups: ${slot} slot)`,
      prompt: `You are the "${name}" subagent. Reply concisely and accurately.`,
      model,
    }
  }
  return agents
}
```

And in `createSession`, after the group env resolution (before `sdkOptions.permissionMode`), merge when non-empty:

```ts
    if (group && Object.keys(defaultConfig.subagentTiers).length > 0) {
      const agents = buildSubagentAgents(defaultConfig.subagentTiers, group, resolveConfiguredModel)
      sdkOptions.agents = { ...(sdkOptions.agents ?? {}), ...agents }
    }
```

- [ ] **Step 4 (conditional): Verify + unit test the expansion**

Add a pure test in `server/model-groups.test.ts` for `buildSubagentAgents` (if kept as a pure helper) or a provider-level test in `server/session-manager.test.ts` asserting `mockHandles[0].options.agents` is set for a group session when `__setConfigForTest({ subagentTiers: { task: 'haiku' } })`. Run `npx vitest run server/model-groups.test.ts server/session-manager.test.ts`. Then remove the probe script:

```bash
rm scripts/probe-subagent-agents.mjs
```

- [ ] **Step 5: Commit**

If the probe confirmed the merge (Steps 3–4 done):

```bash
git add server/config.ts server/providers/claude/claude-provider.ts server/model-groups.ts server/model-groups.test.ts
git commit -m "feat: add subagentTiers explicit routing for group sessions (lever D)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

If the probe showed the merge does NOT work (degradation documented):

```bash
git add docs/superpowers/specs/2026-08-27-model-groups-tier-routing-design.md
git commit -m "docs: record subagentTiers degradation (built-in agent definitions do not merge)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** — walked the spec section-by-section:

- §1 config schema → Task 1 (type, DEFAULTS, WRITABLE_CONFIG_KEYS, `applyParsedConfig` validation incl. last-wins duplicate handling + drop-malformed) + Task 5 (GET /config + /config/full exposure).
- §2 pure resolver → Task 2 (`resolveGroup` empty-slot fallback, `isOpaqueModel`, `capabilitiesForTier`, plus `fallbackAliasesFor` and `resolveConfiguredModelId` as the shared resolution helper).
- §3 provider env construction → Task 3 (group branch splits the four env vars; else branch byte-identical collapse; regression guard preserved: tier vars stay in per-session `opts.env`, never `buildAnthropicEnv()`).
- §4 capability declaration → Task 3 (`isFirstPartyAnthropicUrl` gate + `isOpaqueModel` gate; haiku → skipped).
- §5 C (fallback) → Task 3 spawn-time + Task 4 `setModelGroup` live apply; D automatic layer → Task 3; D explicit layer → Task 8 (probe + conditional).
- §6 session/API/persistence → Task 4 (`Session`/`SessionMeta`/`SessionInfo` `modelGroupId`, `snapshotMeta`, `writeStore`, `coerceMeta`, `create` 400, `setModel` clears, `setModelGroup`, self-heal in `spawn`, all four respawn builders) + Task 5 (route + body validation).
- §7 UI → Task 6 (picker group + `onSelectGroup` + `currentGroupId` + ChatPanel `commitGroup`) + Task 7 (Global Settings tab with add/edit/delete/reorder, save via PUT /config).
- Error table → create-400 (Task 4), self-heal (Task 4), empty-slot (Task 2/3), unknown-slot-resolution (resolver), setModel-clear (Task 4), concurrent-edit serialization (untouched existing `updateConfigFile` queue — no change needed).
- Testing section → every named test present in the task steps; the existing three env tests preserved as the single-model regression guard.

**2. Placeholder scan** — no TBD/TODO/"implement later". Every code step carries the actual diff. The only conditionals are in Task 8, which is explicitly probe-gated by the spec's own "implementation-time verification point" — both branches carry concrete code.

**3. Type consistency** — cross-checked names across tasks:
- `ModelGroupConfig` (Task 1 server / Task 5 client `src/types/config.ts`) — same field names (`id/name/opus/sonnet/haiku/main`).
- `resolveGroup(group, resolve)` returns `{ main, tiers }` — used identically in Task 2 definition, Task 3 provider, Task 4 manager.
- `fallbackAliasesFor(main)` — Task 2 defines, Task 3 spawn + Task 4 `setModelGroup` call; Task 4 `setModel` clears via `{ fallbackModel: null }`.
- `capabilitiesForTier(tier, model)` — Task 2 defines, Task 3 calls with `slot` + `r.tiers[slot]`.
- `providerExtras.modelGroupId` — Task 4 manager passes, Task 3 provider reads, Task 5 create-body carries.
- `setModelGroup(id, groupId)` — Task 4 defines, Task 5 route calls, Task 6 ChatPanel POSTs `/sessions/:id/model-group` with `{ groupId }`.
- `modelGroupId` field name consistent across `Session`, `SessionMeta`, `SessionInfo`, `writeStore` upsert, `coerceMeta`, `snapshotMeta`, `info()`.
- `Options.agents` / `AgentDefinition` only in Task 8's conditional branch (correctly deferred).

**One deliberate deviation from the spec, noted:** the spec's testing section labels the env tests "claude-provider tests", but the repo's established harness for those assertions is `session-manager.test.ts` (the SDK is mocked there and `mockHandles[i].options.env` is already captured). The plan follows the established harness — same assertions, same coverage, no new test-infrastructure.
