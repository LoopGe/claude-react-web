# Provider Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named provider profiles (`authToken` + `baseUrl` + model set) with an active-profile quick-switcher and per-session override, so switching subscriptions is one click.

**Architecture:** `config.json` gains `profiles: ProviderProfile[]` + `activeProfileId`; the six legacy top-level credential/model keys are hard-migrated into `profiles[0]` on first load. `ServerConfig` keeps its existing `authToken`/`baseUrl`/`modelList`/`modelGroups`/`defaultModel`/`recapModel`/`commitMessageModel` fields as **derived views** of the active profile, so every existing consumer keeps working. Sessions may pin a `profileId`; the session-manager resolves the effective profile at spawn and threads it into the `claude` provider, which builds the SDK `Options.env`/model from it.

**Tech Stack:** TypeScript (Node 20, ESM), Hono, React 19 + Vite, vitest (workspaces: Node server tests + jsdom client hook tests), `@anthropic-ai/claude-agent-sdk`.

**Spec:** `docs/superpowers/specs/2026-08-28-provider-profiles-design.md`

## Global Constraints

- Never log `authToken` — only `'authToken: configured'` (or the `****`+last4 mask). `baseUrl` may be logged.
- Credentials are spawn-time only (`Options.env`). A live session keeps its credentials until it respawns.
- Server `config.ts` reads no `process.env`; config lives in `<stateDir>/config.json`.
- `resolveActiveProfile` must never throw: empty `profiles` / dangling `activeProfileId` fall back to `profiles[0]`, then to a `DEFAULTS`-derived synthetic profile.
- Two tsconfigs exist (`tsconfig.json` for `src/`, `tsconfig.node.json` for `server/`); run both in `npm run typecheck`.
- CSS: never hardcode color hex — use theme CSS variables (`var(--…)`) defined in both `:root` and `[data-theme="light"]`.
- Every commit must end with the trailer `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Run the relevant test file (or `npm run test`) and `npm run typecheck` before committing each task.

---

### Task 1: `ProviderProfile` type + `server/profiles.ts` resolver

Pure, no runtime dependencies beyond `log.ts`. Everything later depends on these signatures.

**Files:**
- Modify: `server/config.ts` (add `ProviderProfile` interface; import `coerceProfiles`/`resolveActiveProfile`/`profileDefaultModel`; export `DEFAULT_PROFILE`)
- Create: `server/profiles.ts`
- Test: `server/profiles.test.ts`

**Interfaces:**
- Produces:
  - `interface ProviderProfile { id: string; name: string; authToken: string; baseUrl: string; modelList: string[]; modelGroups: ModelGroupConfig[]; recapModel: string; commitMessageModel: string }` (defined in `server/config.ts`, exported)
  - `profileDefaultModel(profile: ProviderProfile): string`
  - `findProfile(profiles: readonly ProviderProfile[], id: string | undefined): ProviderProfile | undefined`
  - `resolveActiveProfile(profiles: readonly ProviderProfile[], activeProfileId: string | undefined, fallback: ProviderProfile): ProviderProfile`
  - `profileFromLegacyFields(f: LegacyProfileFields, fallback: ProviderProfile): ProviderProfile`
  - `coerceProfiles(raw: unknown, fallback: ProviderProfile): ProviderProfile[]`
  - `coerceModelGroups(raw: unknown): ModelGroupConfig[]`
  - `maskToken(token: string | undefined): string | undefined`
  - `interface LegacyProfileFields { authToken?: string; baseUrl?: string; modelList?: string[]; modelGroups?: ModelGroupConfig[]; recapModel?: string; commitMessageModel?: string }`

- [ ] **Step 1: Write the failing test** — `server/profiles.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import type { ModelGroupConfig, ProviderProfile } from './config.js'
import {
  coerceModelGroups, coerceProfiles, findProfile, maskToken,
  profileDefaultModel, profileFromLegacyFields, resolveActiveProfile,
} from './profiles.js'

const FALLBACK: ProviderProfile = {
  id: 'default', name: 'Default', authToken: '',
  baseUrl: 'https://api.anthropic.com',
  modelList: ['anthropic/claude-sonnet-4-20250514'],
  modelGroups: [], recapModel: 'claude-haiku-4-5-20251001',
  commitMessageModel: 'claude-haiku-4-5-20251001',
}
const P = (id: string, modelList: string[] = ['a/' + id]): ProviderProfile =>
  ({ ...FALLBACK, id, name: 'P ' + id, modelList })

describe('resolveActiveProfile', () => {
  it('returns the active profile by id', () => {
    const profiles = [P('one'), P('two')]
    expect(resolveActiveProfile(profiles, 'two', FALLBACK).id).toBe('two')
  })
  it('falls back to profiles[0] on a dangling activeProfileId', () => {
    expect(resolveActiveProfile([P('one')], 'missing', FALLBACK).id).toBe('one')
  })
  it('falls back to the synthetic profile when profiles is empty', () => {
    expect(resolveActiveProfile([], 'default', FALLBACK)).toBe(FALLBACK)
  })
})

describe('findProfile / profileDefaultModel', () => {
  it('finds by id and returns undefined when absent', () => {
    const profiles = [P('one')]
    expect(findProfile(profiles, 'one')?.id).toBe('one')
    expect(findProfile(profiles, 'nope')).toBeUndefined()
    expect(findProfile(profiles, undefined)).toBeUndefined()
  })
  it('profileDefaultModel is modelList[0] or empty', () => {
    expect(profileDefaultModel(P('one'))).toBe('a/one')
    expect(profileDefaultModel({ ...P('one'), modelList: [] })).toBe('')
  })
})

describe('coerceProfiles', () => {
  it('drops malformed entries and keeps the last duplicate id', () => {
    const raw = [
      { id: '', name: 'x' },                          // dropped: blank id
      'nope',                                          // dropped: not an object
      { id: 'dup', name: 'first', modelList: ['m1'] },
      { id: 'dup', name: 'second', modelList: ['m2'] }, // last wins
    ]
    const out = coerceProfiles(raw, FALLBACK)
    expect(out.map((p) => p.id)).toEqual(['dup'])
    expect(out[0].name).toBe('second')
    expect(out[0].modelList).toEqual(['m2'])
  })
  it('fills missing fields from the fallback and trims baseUrl', () => {
    const out = coerceProfiles([{ id: 'x', name: 'X', baseUrl: 'https://gw.example.com/' }], FALLBACK)
    expect(out[0].baseUrl).toBe('https://gw.example.com')
    expect(out[0].modelList).toEqual(FALLBACK.modelList)
    expect(out[0].recapModel).toBe(FALLBACK.recapModel)
    expect(out[0].authToken).toBe('')
  })
})

describe('coerceModelGroups', () => {
  it('mirrors the legacy validation: drops malformed, keeps last dup', () => {
    const groups: ModelGroupConfig[] = [
      { id: 'g', name: 'G', opus: 'o', sonnet: 's' },
      { id: 'g', name: 'G2', main: 'sonnet', opus: 'o2' },
    ]
    expect(coerceModelGroups([{ id: 'bad' }, groups[0], groups[1]])).toEqual([
      { id: 'g', name: 'G2', main: 'sonnet', opus: 'o2' },
    ])
  })
})

describe('profileFromLegacyFields', () => {
  it('maps full legacy fields into a default profile', () => {
    const p = profileFromLegacyFields(
      { authToken: 'tok', baseUrl: 'https://gw/', modelList: ['m'], recapModel: 'r', commitMessageModel: 'c', modelGroups: [] },
      FALLBACK,
    )
    expect(p.id).toBe('default')
    expect(p.authToken).toBe('tok')
    expect(p.baseUrl).toBe('https://gw')
    expect(p.modelList).toEqual(['m'])
    expect(p.recapModel).toBe('r')
  })
  it('fills missing fields from the fallback', () => {
    const p = profileFromLegacyFields({}, FALLBACK)
    expect(p.modelList).toEqual(FALLBACK.modelList)
    expect(p.authToken).toBe('')
  })
})

describe('maskToken', () => {
  it('masks with last-4 suffix and returns undefined for blank', () => {
    expect(maskToken('sk-ant-abcdef')).toBe('****cdef')
    expect(maskToken('')).toBeUndefined()
    expect(maskToken(undefined)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/profiles.test.ts`
Expected: FAIL — `Cannot find module './profiles.js'`.

- [ ] **Step 3: Add `ProviderProfile` to `server/config.ts`**

Insert after the `ModelGroupConfig` interface (currently ends line 33):

```ts
/** A named subscription bundle. `modelList[0]` is the profile's default
 *  model. authToken is the Anthropic/gateway API key (NOT the web access
 *  token). */
export interface ProviderProfile {
  id: string
  name: string
  authToken: string
  baseUrl: string
  modelList: string[]
  modelGroups: ModelGroupConfig[]
  recapModel: string
  commitMessageModel: string
}
```

- [ ] **Step 4: Write `server/profiles.ts`**

```ts
// Provider-profile resolution + validation. Pure functions, no import of the
// live `config` singleton (config.ts imports these, never the reverse — the
// only imports here from config.ts are TYPE-only, erased at runtime).

import type { ModelGroupConfig, ProviderProfile } from './config.js'
import { createLogger } from './log.js'

const log = createLogger('profiles')

/** The six legacy top-level credential/model fields migrated into profiles[0]. */
export interface LegacyProfileFields {
  authToken?: string
  baseUrl?: string
  modelList?: string[]
  modelGroups?: ModelGroupConfig[]
  recapModel?: string
  commitMessageModel?: string
}

/** modelList[0], or '' for an empty list. */
export function profileDefaultModel(profile: ProviderProfile): string {
  return profile.modelList[0] ?? ''
}

export function findProfile(
  profiles: readonly ProviderProfile[],
  id: string | undefined,
): ProviderProfile | undefined {
  if (!id) return undefined
  return profiles.find((p) => p.id === id)
}

/** Never throws: empty profiles / dangling id fall back to profiles[0], then
 *  to the caller-supplied synthetic fallback (DEFAULTS-derived). */
export function resolveActiveProfile(
  profiles: readonly ProviderProfile[],
  activeProfileId: string | undefined,
  fallback: ProviderProfile,
): ProviderProfile {
  if (profiles.length === 0) return fallback
  return findProfile(profiles, activeProfileId) ?? profiles[0]
}

/** Mask a token for the wire: '****' + last 4 chars. Undefined for blank. */
export function maskToken(token: string | undefined): string | undefined {
  if (!token) return undefined
  return '****' + token.slice(-4)
}

/** Validate model groups exactly as the legacy config loader did: a malformed
 *  entry is dropped with a warning, duplicate ids keep the last entry, and
 *  groups with zero tier slots are dropped. */
export function coerceModelGroups(raw: unknown): ModelGroupConfig[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, ModelGroupConfig>()
  for (const g of raw) {
    if (typeof g !== 'object' || g === null || Array.isArray(g)) {
      log.warn('dropping malformed model group (not an object)')
      continue
    }
    const entry = g as Record<string, unknown>
    const { id, name, main } = entry
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) {
      log.warn('dropping model group with a missing/blank id or name')
      continue
    }
    if (main !== undefined && main !== 'opus' && main !== 'sonnet' && main !== 'haiku') {
      log.warn(`dropping model group ${id}: main must be one of opus|sonnet|haiku`)
      continue
    }
    let slotOk = true
    for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
      const v = entry[slot]
      if (v !== undefined && typeof v !== 'string') {
        log.warn(`dropping model group ${id}: slot ${slot} must be a string`)
        slotOk = false
        break
      }
    }
    if (!slotOk) continue
    const out: ModelGroupConfig = { id: id.trim(), name: name.trim() }
    for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
      const v = entry[slot]
      if (typeof v === 'string' && v.trim()) out[slot] = v.trim()
    }
    if (main !== undefined) out.main = main as 'opus' | 'sonnet' | 'haiku'
    if (!out.opus && !out.sonnet && !out.haiku) {
      log.warn(`dropping model group ${id}: no tier slots`)
      continue
    }
    byId.set(out.id, out)
  }
  return [...byId.values()]
}

/** Narrow untrusted JSON into a ProviderProfile[]. Malformed entries are
 *  dropped (never blocks config load); missing scalar fields fall back to the
 *  synthetic fallback; a blank authToken is allowed (matches the unset-token
 *  starter state — the server still refuses to spawn without one). */
export function coerceProfiles(raw: unknown, fallback: ProviderProfile): ProviderProfile[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, ProviderProfile>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      log.warn('dropping malformed profile (not an object)')
      continue
    }
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (!id || !name) {
      log.warn('dropping profile with a missing/blank id or name')
      continue
    }
    const baseUrl = typeof e.baseUrl === 'string' && e.baseUrl.trim()
      ? e.baseUrl.trim().replace(/\/+$/, '')
      : fallback.baseUrl
    const modelList = Array.isArray(e.modelList) && e.modelList.length > 0
      ? (e.modelList as unknown[]).filter((m): m is string => typeof m === 'string' && !!m.trim())
      : [...fallback.modelList]
    const recapModel = typeof e.recapModel === 'string' && e.recapModel.trim()
      ? e.recapModel.trim() : fallback.recapModel
    const commitMessageModel = typeof e.commitMessageModel === 'string' && e.commitMessageModel.trim()
      ? e.commitMessageModel.trim() : fallback.commitMessageModel
    const authToken = typeof e.authToken === 'string' ? e.authToken : ''
    byId.set(id, {
      id, name, authToken, baseUrl, modelList,
      modelGroups: coerceModelGroups(e.modelGroups),
      recapModel, commitMessageModel,
    })
  }
  return [...byId.values()]
}

/** Build a ProviderProfile from the six legacy top-level fields (migration
 *  helper). Missing fields fall back to the synthetic fallback. */
export function profileFromLegacyFields(
  f: LegacyProfileFields,
  fallback: ProviderProfile,
): ProviderProfile {
  return {
    id: 'default',
    name: 'Default',
    authToken: typeof f.authToken === 'string' ? f.authToken : '',
    baseUrl: typeof f.baseUrl === 'string' && f.baseUrl.trim()
      ? f.baseUrl.trim().replace(/\/+$/, '') : fallback.baseUrl,
    modelList: Array.isArray(f.modelList) && f.modelList.length > 0
      ? f.modelList.filter((m) => typeof m === 'string' && m.trim())
      : [...fallback.modelList],
    modelGroups: Array.isArray(f.modelGroups) ? coerceModelGroups(f.modelGroups) : [...fallback.modelGroups],
    recapModel: typeof f.recapModel === 'string' && f.recapModel.trim()
      ? f.recapModel.trim() : fallback.recapModel,
    commitMessageModel: typeof f.commitMessageModel === 'string' && f.commitMessageModel.trim()
      ? f.commitMessageModel.trim() : fallback.commitMessageModel,
  }
}
```

- [ ] **Step 5: Add `DEFAULT_PROFILE` to `server/config.ts`**

Insert after the `DEFAULTS` constant (ends line 193), before `export let config`:

```ts
/** Synthetic fallback profile derived from DEFAULTS. Used as the migration
 *  source, the coerce fallback, and resolveActiveProfile's last resort. */
export const DEFAULT_PROFILE: ProviderProfile = Object.freeze({
  id: 'default',
  name: 'Default',
  authToken: '',
  baseUrl: DEFAULTS.baseUrl,
  modelList: Object.freeze([...DEFAULTS.modelList]),
  modelGroups: Object.freeze([...DEFAULTS.modelGroups]),
  recapModel: DEFAULTS.recapModel,
  commitMessageModel: DEFAULTS.commitMessageModel,
})
```

Add the import at the top of `server/config.ts` (after the `ModelGroupConfig` interface or with the other `./` imports):

```ts
import { coerceModelGroups, coerceProfiles, profileDefaultModel, profileFromLegacyFields, resolveActiveProfile, type LegacyProfileFields } from './profiles.js'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run server/profiles.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/config.ts server/profiles.ts server/profiles.test.ts
git commit -m "feat(profiles): add ProviderProfile type and pure resolver"
```

---

### Task 2: config schema migration + derived fields

**Files:**
- Modify: `server/config.ts` (schema, `DEFAULTS`, `applyParsedConfig`, `loadConfig` scaffold + migration, `WRITABLE_CONFIG_KEYS`, `clearCredentials`)
- Test: `server/config.test.ts`

**Interfaces:**
- Consumes: `ProviderProfile`, `DEFAULT_PROFILE`, `coerceProfiles`, `resolveActiveProfile`, `profileDefaultModel`, `profileFromLegacyFields`, `LegacyProfileFields` (Task 1)
- Produces: `ServerConfig.profiles: readonly ProviderProfile[]`, `ServerConfig.activeProfileId: string`, and the already-existing derived fields `authToken/baseUrl/modelList/modelGroups/defaultModel/recapModel/commitMessageModel`.

- [ ] **Step 1: Write the failing test** — add to `server/config.test.ts`

```ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, config, WRITABLE_CONFIG_KEYS, clearCredentials, __setConfigForTest } from './config.js'

const tmp = () => fs.mkdtemp(join(tmpdir(), 'crw-profiles-'))
afterEach(() => { __setConfigForTest({}) })

describe('provider-profile migration + derived fields', () => {
  it('hard-migrates legacy fields into profiles[0] and deletes the top-level keys', async () => {
    const dir = await tmp()
    const file = join(dir, 'config.json')
    await fs.writeFile(file, JSON.stringify({
      authToken: 'legacy-token',
      baseUrl: 'https://gw.example.com/',
      modelList: ['m1', 'm2'],
      recapModel: 'r-model',
      commitMessageModel: 'c-model',
    }))
    await loadConfig(dir)
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(raw.profiles).toHaveLength(1)
    expect(raw.profiles[0].authToken).toBe('legacy-token')
    expect(raw.profiles[0].baseUrl).toBe('https://gw.example.com')
    expect(raw.activeProfileId).toBe('default')
    expect(raw.authToken).toBeUndefined()
    expect(raw.modelList).toBeUndefined()
    // Derived fields reflect the migrated profile.
    expect(config.modelList).toEqual(['m1', 'm2'])
    expect(config.authToken).toBe('legacy-token')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('is idempotent: a second load with profiles present does not re-migrate', async () => {
    const dir = await tmp()
    const file = join(dir, 'config.json')
    await fs.writeFile(file, JSON.stringify({
      profiles: [{ id: 'a', name: 'A', authToken: 'tok', baseUrl: 'https://gw', modelList: ['ma'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' }],
      activeProfileId: 'a',
    }))
    await loadConfig(dir)
    await loadConfig(dir)
    expect(config.activeProfileId).toBe('a')
    expect(config.modelList).toEqual(['ma'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('derives defaultModel from the active profile modelList[0] and WRITABLE_CONFIG_KEYS no longer lists legacy keys', async () => {
    const dir = await tmp()
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [
        { id: 'one', name: 'One', authToken: 't1', baseUrl: 'https://gw1', modelList: ['x/one', 'x/two'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
        { id: 'two', name: 'Two', authToken: 't2', baseUrl: 'https://gw2', modelList: ['y/one'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
      ],
      activeProfileId: 'two',
    }))
    await loadConfig(dir)
    expect(config.defaultModel).toBe('y/one')
    expect(config.baseUrl).toBe('https://gw2')
    expect(WRITABLE_CONFIG_KEYS as readonly string[]).not.toContain('authToken')
    expect(WRITABLE_CONFIG_KEYS as readonly string[]).toContain('profiles')
    expect(WRITABLE_CONFIG_KEYS as readonly string[]).toContain('activeProfileId')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('clearCredentials blanks every profile token and baseUrl', async () => {
    const dir = await tmp()
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [
        { id: 'a', name: 'A', authToken: 't1', baseUrl: 'https://gw1', modelList: ['ma'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
        { id: 'b', name: 'B', authToken: 't2', baseUrl: 'https://gw2', modelList: ['mb'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
      ],
      activeProfileId: 'a',
    }))
    await loadConfig(dir)
    await clearCredentials(dir)
    expect(config.authToken).toBeFalsy()
    const raw = JSON.parse(await fs.readFile(join(dir, 'config.json'), 'utf8'))
    expect(raw.profiles.every((p: { authToken: string; baseUrl: string }) => p.authToken === '')).toBe(true)
    expect(raw.profiles[0].baseUrl).toBe('https://api.anthropic.com')
    await fs.rm(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/config.test.ts`
Expected: FAIL — first migration assertion fails (no `profiles` key written).

- [ ] **Step 3: Add `profiles` / `activeProfileId` to `ServerConfig` and `DEFAULTS`**

In `ServerConfig` (after `commitMessageModel`):

```ts
  readonly profiles: readonly ProviderProfile[]
  readonly activeProfileId: string
```

In `DEFAULTS` (after `commitMessageModel: 'claude-haiku-4-5-20251001',`):

```ts
  profiles: Object.freeze([]),
  activeProfileId: 'default',
```

- [ ] **Step 4: Rewrite `applyParsedConfig` to derive fields from the active profile**

At the top of `applyParsedConfig`, after `const merged: ServerConfig = { ...DEFAULTS }`, add profile derivation, then **delete** the six old parsing blocks (`modelList` at 286-293, `modelGroups` at 300-343, `recapModel` at 345-347, `commitMessageModel` at 349-351, `authToken` at 383-387, `baseUrl` at 389-394):

```ts
  const profiles = coerceProfiles((file_ as unknown as Record<string, unknown>).profiles, DEFAULT_PROFILE)
  const activeProfileId =
    typeof (file_ as unknown as Record<string, unknown>).activeProfileId === 'string'
    && (file_ as unknown as Record<string, unknown>).activeProfileId.trim()
      ? (file_ as unknown as Record<string, unknown>).activeProfileId.trim()
      : 'default'
  const active = resolveActiveProfile(profiles, activeProfileId, DEFAULT_PROFILE)
  ;(merged as { profiles: readonly ProviderProfile[] }).profiles = Object.freeze(profiles)
  ;(merged as { activeProfileId: string }).activeProfileId = activeProfileId
  ;(merged as { modelList: readonly string[] }).modelList = Object.freeze([...active.modelList])
  ;(merged as { modelGroups: readonly ModelGroupConfig[] }).modelGroups = Object.freeze([...active.modelGroups])
  ;(merged as { defaultModel: string }).defaultModel = profileDefaultModel(active)
  ;(merged as { recapModel: string }).recapModel = active.recapModel
  ;(merged as { commitMessageModel: string }).commitMessageModel = active.commitMessageModel
  ;(merged as { authToken?: string }).authToken = active.authToken.trim() || undefined
  ;(merged as { baseUrl: string }).baseUrl = active.baseUrl
  if (profiles.length > 0) {
    log.info(`loaded ${profiles.length} profile(s); active=${active.id} (${active.name}), modelList[0]=${profileDefaultModel(active) || '(empty)'}`)
  }
  if (active.authToken) log.info('authToken: configured')
```

Note: `active.authToken.trim()` preserves the never-log-token rule (the value is assigned, not logged).

- [ ] **Step 5: Add migration + scaffold changes in `loadConfig`**

Replace the scaffold object (currently lines 235-248) with:

```ts
      const scaffold = JSON.stringify(
        {
          profiles: [{
            id: 'default',
            name: 'Default',
            authToken: '',
            baseUrl: DEFAULTS.baseUrl,
            modelList: [...config.modelList],
            modelGroups: [...config.modelGroups],
            recapModel: config.recapModel,
            commitMessageModel: config.commitMessageModel,
          }],
          activeProfileId: 'default',
          maxUploadBytes: config.maxUploadBytes,
          historyCap: config.historyCap,
          maxOpenPanels: config.maxOpenPanels,
        },
        null,
        2,
      )
```

Replace `applyParsedConfig(parsed as ConfigFile, stateDir, file)` (line 270) with:

```ts
  const migrated = await migrateLegacyProfiles(parsed as Record<string, unknown>, file)
  applyParsedConfig(migrated as unknown as ConfigFile, stateDir, file)
```

Add `migrateLegacyProfiles` (module-level, above `applyParsedConfig`):

```ts
const LEGACY_PROFILE_KEYS = ['authToken', 'baseUrl', 'modelList', 'modelGroups', 'recapModel', 'commitMessageModel'] as const

/** Hard-migrate the six legacy top-level credential/model fields into a
 *  `profiles[0]` + `activeProfileId` on first load. Runs once: when `profiles`
 *  is already present it is a no-op. Never throws — a write failure is logged
 *  and the in-memory migration still proceeds. */
async function migrateLegacyProfiles(
  parsed: Record<string, unknown>,
  file: string,
): Promise<Record<string, unknown>> {
  if (Array.isArray(parsed.profiles)) return parsed
  const hasLegacy = LEGACY_PROFILE_KEYS.some((k) => k in parsed)
  if (!hasLegacy) return parsed
  const profile = profileFromLegacyFields(parsed as unknown as LegacyProfileFields, DEFAULT_PROFILE)
  const migrated: Record<string, unknown> = { ...parsed, profiles: [profile], activeProfileId: 'default' }
  for (const k of LEGACY_PROFILE_KEYS) delete migrated[k]
  try {
    await fs.writeFile(file, JSON.stringify(migrated, null, 2), 'utf8')
    log.info(`migrated legacy authToken/model fields into profiles[0] (${file})`)
  } catch (err) {
    log.warn(`could not write back migrated config:`, (err as Error).message)
  }
  return migrated
}
```

- [ ] **Step 6: Update `WRITABLE_CONFIG_KEYS` and `clearCredentials`**

In `WRITABLE_CONFIG_KEYS`, remove `'authToken'`, `'baseUrl'`, `'modelList'`, `'modelGroups'`, `'recapModel'`, `'commitMessageModel'`; add `'profiles'`, `'activeProfileId'`.

Replace `clearCredentials` with:

```ts
export async function clearCredentials(stateDir: string): Promise<void> {
  await queueConfigWrite(stateDir, (existing) => {
    delete existing.accessToken
    const profiles = Array.isArray(existing.profiles) ? existing.profiles : []
    existing.profiles = profiles.map((p) => {
      if (typeof p !== 'object' || p === null || Array.isArray(p)) return p
      return { ...p, authToken: '', baseUrl: DEFAULTS.baseUrl }
    })
  })
  await loadConfig(stateDir)
  setWebAuth('', false)
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run server/config.test.ts server/profiles.test.ts`
Expected: PASS. If legacy config tests assert the old per-key parsing (e.g. `modelList` still loadable top-level), update them: they should now write `profiles`/`activeProfileId`.

- [ ] **Step 8: Commit**

```bash
git add server/config.ts server/config.test.ts
git commit -m "feat(profiles): migrate legacy config into profiles and derive ServerConfig fields"
```

---

### Task 3: thread `profileId`/`profileName` through session metadata

**Files:**
- Modify: `shared/session-info.ts` (`SessionInfoBase`), `server/session-types.ts` (`Session`), `server/persistence.ts` (`SessionMeta` + `coerceMeta`)
- Test: extend an existing persistence test (or add `server/persistence-profiles.test.ts` if none is handy — follow the existing `coerceMeta` test's shape)

**Interfaces:**
- Produces: optional `profileId?: string` on `Session`, `SessionMeta`, `SessionInfoBase`; optional `profileName?: string` on `SessionInfoBase`.

- [ ] **Step 1: Write the failing test** — `server/persistence-profiles.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { SessionStore } from './persistence.js'

describe('SessionMeta profileId coercion', () => {
  it('round-trips profileId and drops malformed values', async () => {
    const store = new SessionStore({ stateDir: await import('node:os').then((o) => o.tmpdir()) })
    // Use the internal coerce path via a parse: SessionStore.parseItems is protected;
    // instead assert through the public narrow by round-tripping a meta.
    const meta = {
      id: 's1', createdAt: 1, lastActivityAt: 1, messageCount: 0,
      terminated: false, profileId: 'p1',
    }
    store.upsert(meta)
    const items = store.items()
    expect(items[0].profileId).toBe('p1')
    store.remove('s1')
  })
})
```

Note: if `SessionStore.items()` is not public, test `coerceMeta` by importing it (export it from `persistence.ts` if currently private) — add `export` to `function coerceMeta` and import it directly:

```ts
import { coerceMeta } from './persistence.js'
expect(coerceMeta({ id: 's1', profileId: 'p1' })?.profileId).toBe('p1')
expect(coerceMeta({ id: 's1', profileId: 42 })?.profileId).toBeUndefined()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/persistence-profiles.test.ts`
Expected: FAIL — `profileId` not on the returned meta (or `coerceMeta` not exported).

- [ ] **Step 3: Add the fields**

`shared/session-info.ts` — in `SessionInfoBase`, after `modelGroupId?: string`:

```ts
  /** Provider profile id this session is pinned to. Undefined = follow the
   *  active (global) profile. Persisted so resume/fork/clear keep the pin. */
  profileId?: string
  /** Display name of the session's effective profile. Server-derived, not
   *  persisted — recomputed from profileId / the active profile at info time. */
  profileName?: string
```

`server/session-types.ts` — in `Session`, after `modelGroupId?: string`:

```ts
  /** Provider profile id this session is pinned to. Undefined = follow the
   *  active profile. Persisted via SessionMeta; resolved at spawn. */
  profileId?: string
```

`server/persistence.ts` — in `SessionMeta`, after `modelGroupId?: string`:

```ts
  /** Provider profile id this session is pinned to. Persisted so
   *  resume/fork/clear keep the pin. */
  profileId?: string
```

In `coerceMeta` return object, after `modelGroupId: ...`:

```ts
    profileId: typeof r.profileId === 'string' ? r.profileId : undefined,
```

Export `coerceMeta` (change `function coerceMeta` to `export function coerceMeta`) so the test can call it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/persistence-profiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/session-info.ts server/session-types.ts server/persistence.ts server/persistence-profiles.test.ts
git commit -m "feat(profiles): persist profileId on session metadata"
```

---

### Task 4: session-manager effective-profile resolution + `setProfile`

**Files:**
- Modify: `server/session-manager.ts`
- Test: `server/session-manager.test.ts` (extend)

**Interfaces:**
- Consumes: `ProviderProfile` (`./config.js`), `DEFAULT_PROFILE`, and `findProfile`/`resolveActiveProfile`/`profileDefaultModel` (`./profiles.js`)
- Produces:
  - module-level `function effectiveProfileFor(profileId: string | undefined): ProviderProfile`
  - `resolveConfiguredModel(model: string | undefined, modelList?: readonly string[]): string | undefined` (new optional param)
  - `async setProfile(id: string, profileId: string, apply: 'now' | 'deferred'): Promise<SessionInfo>`
  - `async restart(id: string): Promise<SessionInfo>`

- [ ] **Step 1: Write the failing test** — extend `server/session-manager.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { resolveConfiguredModel } from './session-manager.js'
import type { ProviderProfile } from './config.js'

// (If resolveConfiguredModel is not exported, export it — it is a pure module
//  function and this test is the seam that keeps its signature honest.)

describe('resolveConfiguredModel with a profile modelList', () => {
  const list = ['anthropic/claude-sonnet-4-20250514', 'deepseek/deepseek-v4-pro']
  it('resolves a bare short name against the given list', () => {
    expect(resolveConfiguredModel('deepseek-v4-pro', list)).toBe('deepseek/deepseek-v4-pro')
  })
  it('leaves a provider-prefixed id unchanged', () => {
    expect(resolveConfiguredModel('myprovider/gpt-5.6', list)).toBe('myprovider/gpt-5.6')
  })
  it('falls back to the default (active-profile) list when omitted', () => {
    expect(resolveConfiguredModel('claude-sonnet-4-20250514')).toBe('anthropic/claude-sonnet-4-20250514')
  })
})

// effectiveProfileFor + setProfile are exercised end-to-end via the route in
// Task 6; here assert the pure resolution behavior through the provider env
// test in Task 5. Keep this file's additions to the resolver seam above.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-manager.test.ts -t "resolveConfiguredModel with a profile modelList"`
Expected: FAIL — `resolveConfiguredModel` not exported / lacks the param.

- [ ] **Step 3: Change `resolveConfiguredModel` + add `effectiveProfileFor`**

Add imports near the top of `session-manager.ts`:

```ts
import { DEFAULT_PROFILE, type ProviderProfile } from './config.js'
import { findProfile, profileDefaultModel, resolveActiveProfile } from './profiles.js'
```

Change `resolveConfiguredModel` (line 170):

```ts
function resolveConfiguredModel(
  model: string | undefined,
  modelList: readonly string[] = defaultConfig.modelList,
): string | undefined {
  if (!model) return undefined
  if (model.includes('/')) return model
  const list = modelList
  if (list.includes(model)) return model
  const matches = list.filter((m) => m.slice(m.lastIndexOf('/') + 1) === model)
  return matches.length === 1 ? matches[0] : model
}
export { resolveConfiguredModel }
```

Add `effectiveProfileFor` right after it:

```ts
/** The profile a session should use: its pinned profile when present, else the
 *  active profile. A dangling pin self-heals to the active profile. */
export function effectiveProfileFor(profileId: string | undefined): ProviderProfile {
  if (profileId) {
    const found = findProfile(defaultConfig.profiles, profileId)
    if (found) return found
    log.warn(`[profile] ${profileId} no longer exists — falling back to active profile`)
  }
  return resolveActiveProfile(defaultConfig.profiles, defaultConfig.activeProfileId, DEFAULT_PROFILE)
}
```

- [ ] **Step 4: `snapshotMeta` gains `profileId`**

In `snapshotMeta`'s return type and body (line 941), add to the type union `profileId?: string` and to the returned object:

```ts
      profileId: (opts as { profileId?: string }).profileId,
```

- [ ] **Step 5: `create()` validates `profileId` and pins the profile default model**

After the model-group validation block (line 1011), add:

```ts
    const profileId = (opts as { profileId?: unknown }).profileId
    if (profileId !== undefined) {
      if (typeof profileId !== 'string') {
        throw new HttpError(400, 'profileId must be a string')
      }
      if (!findProfile(defaultConfig.profiles, profileId)) {
        throw new HttpError(400, `profile ${profileId} not found`)
      }
    }
```

Replace the `withDefault` default-model pin (line 1023):

```ts
      model: opts.model ?? profileDefaultModel(effectiveProfileFor(profileId as string | undefined)),
```

- [ ] **Step 6: `spawn()` resolves the effective profile and threads it to the provider**

After `const existingMeta = this.store?.get(id)` (line 1991), add profile resolution:

```ts
    const requestedProfileId =
      (fullOpts as { profileId?: string }).profileId ?? existingMeta?.profileId
    let profile = effectiveProfileFor(requestedProfileId)
    let profileId = requestedProfileId
    // Self-heal: a profile deleted while sessions referenced it falls back to
    // the active profile and clears the reference (mirrors the model-group
    // self-heal right below).
    if (profileId && !findProfile(defaultConfig.profiles, profileId)) {
      log.warn(`[session ${id}] profile ${profileId} no longer exists — clearing reference`)
      profileId = undefined
      profile = resolveActiveProfile(defaultConfig.profiles, defaultConfig.activeProfileId, DEFAULT_PROFILE)
    }
    metaSnapshot.profileId = profileId
```

In the model-group block (lines 2000-2010), replace `defaultConfig.modelGroups.find` and `resolveConfiguredModel` with the profile's:

```ts
    if (modelGroupId) {
      const group = profile.modelGroups.find((g) => g.id === modelGroupId)
      if (group) {
        metaSnapshot.model = resolveGroup(group, (m) => resolveConfiguredModel(m, profile.modelList)).main
        metaSnapshot.modelGroupId = modelGroupId
      } else {
        log.warn(`[session ${id}] model group ${modelGroupId} no longer exists — clearing reference`)
        metaSnapshot.modelGroupId = undefined
      }
    }
```

In `provider.createSession({...})` (line 2219), add one field after `provider: providerName,`:

```ts
      profile,
```

- [ ] **Step 7: `setModelGroup()` uses the session's effective profile**

Replace `setModelGroup`'s resolution (lines 3004-3006):

```ts
    const profile = effectiveProfileFor(s.profileId)
    const group = profile.modelGroups.find((g) => g.id === groupId)
    if (!group) throw new HttpError(400, `model group ${groupId} not found`)
    const r = resolveGroup(group, (m) => resolveConfiguredModel(m, profile.modelList))
```

- [ ] **Step 8: add `setProfile` + `restart`, and thread `profile` into `respawnInPlace`**

Add these two public methods (next to `setModelGroup`):

```ts
  /** Pin a session to a provider profile. Live-applies the profile's default
   *  model/group, persists the pin, and (when apply==='now' and the session is
   *  idle) restarts the Query so the new credentials take effect immediately.
   *  `deferred` only persists — credentials apply on the next respawn. */
  async setProfile(id: string, profileId: string, apply: 'now' | 'deferred' = 'now'): Promise<SessionInfo> {
    const s = this.requireLive(id)
    if (s.profileId === profileId) return this.info(s)
    const profile = findProfile(defaultConfig.profiles, profileId)
    if (!profile) throw new HttpError(400, `profile ${profileId} not found`)
    s.profileId = profileId
    s.lastActivityAt = Date.now()
    // Live-apply the profile's default model/group. A group pin only survives
    // if the new profile still has that group id; otherwise collapse to the
    // profile's default model (the old group's slots may not exist here).
    if (s.modelGroupId) {
      const group = profile.modelGroups.find((g) => g.id === s.modelGroupId)
      if (group) {
        await this.setModelGroup(id, s.modelGroupId)
      } else {
        await this.setModel(id, profileDefaultModel(profile))
      }
    } else {
      await this.setModel(id, profileDefaultModel(profile))
    }
    this.persist(s)
    if (apply === 'now') {
      await this.restart(id)
    }
    return this.info(s)
  }

  /** Restart a live session's Query in-place, preserving the transcript
   *  (same id, `resume: id`). No-op (deferred) while a turn is in flight or a
   *  clear is already driving its own respawn. */
  async restart(id: string): Promise<SessionInfo> {
    const s = this.requireLive(id)
    if (s.pendingTurns > 0 || s.handle.queueDepth > 0 || s.clearing) {
      return this.info(s)
    }
    const resumeOpts = await this.buildResumeOpts(s)
    this.respawnInPlace(s, resumeOpts, 'restart')
    return this.info(s)
  }
```

In `respawnInPlace`'s `provider.createSession({...})` (line 4971), add after `provider: session.provider,`:

```ts
      profile: effectiveProfileFor(session.profileId),
```

- [ ] **Step 9: populate `profileId`/`profileName` in `info()` and `infoFromMeta()`**

Add a small helper next to `info(s)`:

```ts
  private profileNameFor(profileId: string | undefined): string | undefined {
    return effectiveProfileFor(profileId).name
  }
```

In `info(s)` return object, after `modelGroupId: s.modelGroupId,`:

```ts
      profileId: s.profileId,
      profileName: this.profileNameFor(s.profileId),
```

In `infoFromMeta(meta)` return object, after `model: meta.model,`:

```ts
      modelGroupId: meta.modelGroupId,
      profileId: meta.profileId,
      profileName: this.profileNameFor(meta.profileId),
```

- [ ] **Step 10: run typecheck + the resolver test**

Run: `npx vitest run server/session-manager.test.ts -t "resolveConfiguredModel with a profile modelList"` then `npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 11: Commit**

```bash
git add server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(profiles): resolve effective profile per session and add setProfile"
```

---

### Task 5: provider profile env/model threading

**Files:**
- Modify: `server/providers/types.ts` (`CreateSessionOptions.profile`), `server/providers/claude/claude-provider.ts`
- Test: `server/providers/claude/claude-provider.test.ts` (extend)

**Interfaces:**
- Consumes: `ProviderProfile` (via `../../config.js`), `resolveActiveProfile`/`profileDefaultModel` (via `../../profiles.js`), `DEFAULT_PROFILE`
- Produces: exported `buildProfileEnv(profile: ProviderProfile, maxOutputTokens: number): NodeJS.ProcessEnv`; `applyStandardQueryOpts(..., group?, profile?)`; `buildAnthropicEnv(profile)`.

- [ ] **Step 1: Write the failing test** — extend `server/providers/claude/claude-provider.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { buildProfileEnv } from './claude-provider.js'
import type { ProviderProfile } from '../../config.js'

const PROFILE: ProviderProfile = {
  id: 'p', name: 'P', authToken: 'profile-token',
  baseUrl: 'https://gw.example.com',
  modelList: ['m/one'], modelGroups: [],
  recapModel: 'r', commitMessageModel: 'c',
}

describe('buildProfileEnv', () => {
  it('uses the profile authToken and baseUrl', () => {
    const env = buildProfileEnv(PROFILE, 0)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('profile-token')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com')
  })
  it('forces ENABLE_TOOL_SEARCH=false for non-first-party base URLs', () => {
    expect(buildProfileEnv(PROFILE, 0).ENABLE_TOOL_SEARCH).toBe('false')
  })
  it('propagates maxOutputTokens when non-zero', () => {
    expect(buildProfileEnv(PROFILE, 4096).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('4096')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/claude/claude-provider.test.ts -t "buildProfileEnv"`
Expected: FAIL — `buildProfileEnv` not exported.

- [ ] **Step 3: add `profile` to `CreateSessionOptions`**

In `server/providers/types.ts`, after `model?: string`:

```ts
  /** Resolved provider profile for this spawn. When present it overrides the
   *  global (active-profile) credentials + model list for this session. */
  profile?: ProviderProfile
```

Add the import at the top: `import type { ProviderProfile } from '../config.js'`.

- [ ] **Step 4: rewrite the provider's env + model resolution**

In `claude-provider.ts`, add imports:

```ts
import { DEFAULT_PROFILE, type ProviderProfile } from '../../config.js'
import { profileDefaultModel, resolveActiveProfile } from '../../profiles.js'
```

Replace the module-level `resolveConfiguredModel` (line 48) with:

```ts
function resolveConfiguredModel(
  model: string | undefined,
  modelList: readonly string[],
): string | undefined {
  return resolveConfiguredModelId(model, modelList)
}
```

Change `createSession`'s model-group lookup (line 93) to use the profile's groups:

```ts
    const profile = opts.profile ?? resolveActiveProfile(defaultConfig.profiles, defaultConfig.activeProfileId, DEFAULT_PROFILE)
    const group = modelGroupId ? profile.modelGroups.find((g) => g.id === modelGroupId) : undefined
```

Change the `applyStandardQueryOpts` call (line 126) to pass the profile:

```ts
    this.applyStandardQueryOpts(sdkOptions, opts.env, opts.enabledPlugins, group, profile)
```

Change `applyStandardQueryOpts` signature (line 279) to accept and use `profile`:

```ts
  private applyStandardQueryOpts(
    opts: Options,
    customEnv?: Record<string, string>,
    enabledPlugins?: string[],
    group?: ModelGroupConfig,
    profile: ProviderProfile = resolveActiveProfile(defaultConfig.profiles, defaultConfig.activeProfileId, DEFAULT_PROFILE),
  ): void {
```

Inside it, replace `defaultConfig.defaultModel` (line 289) with `profileDefaultModel(profile)`, and the group branch's `resolveConfiguredModel`/`defaultConfig.baseUrl` uses with profile-aware versions:

```ts
    const effectiveModel = opts.model || profileDefaultModel(profile)
    if (group) {
      const r = resolveGroup(group, (m) => resolveConfiguredModel(m, profile.modelList))
      opts.model = r.main
      opts.env = {
        ...(opts.env ?? this.buildAnthropicEnv(profile)),
        ANTHROPIC_DEFAULT_OPUS_MODEL: r.tiers.opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: r.tiers.sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: r.tiers.haiku,
        ANTHROPIC_SMALL_FAST_MODEL: r.tiers.haiku,
      }
      if (!isFirstPartyAnthropicUrl(profile.baseUrl)) {
        // ... same tier capability-declaration loop, but `profile.baseUrl`
      }
    } else {
      opts.model = effectiveModel
      opts.env = {
        ...(opts.env ?? this.buildAnthropicEnv(profile)),
        ANTHROPIC_DEFAULT_OPUS_MODEL: effectiveModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: effectiveModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: effectiveModel,
        ANTHROPIC_SMALL_FAST_MODEL: effectiveModel,
      }
    }
```

(Replace every `defaultConfig.baseUrl` inside `applyStandardQueryOpts` with `profile.baseUrl`; replace the group-branch `resolveConfiguredModel` with `(m) => resolveConfiguredModel(m, profile.modelList)`.)

Replace `buildAnthropicEnv()` (line 358) with a thin cached wrapper over the exported pure function:

```ts
  private buildAnthropicEnv(profile: ProviderProfile = resolveActiveProfile(defaultConfig.profiles, defaultConfig.activeProfileId, DEFAULT_PROFILE)): NodeJS.ProcessEnv {
    if (
      this.cachedEnv &&
      this.cachedAuthToken === profile.authToken &&
      this.cachedBaseUrl === profile.baseUrl
    ) {
      return this.cachedEnv
    }
    this.cachedAuthToken = profile.authToken
    this.cachedBaseUrl = profile.baseUrl
    this.cachedEnv = buildProfileEnv(profile, defaultConfig.maxOutputTokens)
    return this.cachedEnv
  }
```

Add the exported pure function (module-level, after `isFirstPartyAnthropicUrl`):

```ts
/** Build the SDK subprocess env for a profile. Exported pure for tests. */
export function buildProfileEnv(profile: ProviderProfile, maxOutputTokens: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? process.env.USERPROFILE,
    USERPROFILE: process.env.USERPROFILE,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    SHELL: process.env.SHELL,
    ComSpec: process.env.ComSpec,
    NODE_PATH: process.env.NODE_PATH,
    ANTHROPIC_AUTH_TOKEN: profile.authToken,
    ANTHROPIC_BASE_URL: profile.baseUrl,
    ANTHROPIC_API_KEY: undefined,
  }
  if (maxOutputTokens > 0) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens)
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ANTHROPIC_') && key !== 'ANTHROPIC_API_KEY' && !(key in env)) {
      env[key] = process.env[key]
    }
  }
  if (!('ENABLE_TOOL_SEARCH' in env) && profile.baseUrl && !isFirstPartyAnthropicUrl(profile.baseUrl)) {
    env.ENABLE_TOOL_SEARCH = 'false'
    log.info(`non-first-party ANTHROPIC_BASE_URL=${profile.baseUrl} — forcing ENABLE_TOOL_SEARCH=false`)
  }
  return env
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run server/providers/claude/claude-provider.test.ts` then `npm run typecheck`
Expected: PASS / clean. The existing contamination-guard test must still pass (cached env is keyed on `(authToken, baseUrl)`).

- [ ] **Step 6: Commit**

```bash
git add server/providers/types.ts server/providers/claude/claude-provider.ts server/providers/claude/claude-provider.test.ts
git commit -m "feat(profiles): thread provider profile into SDK env and model resolution"
```

---

### Task 6: profiles router + session routes + light/full config + reset

**Files:**
- Create: `server/routes/profiles.ts`
- Modify: `server/routes/index.ts` (mount), `server/routes/sessions.ts` (create `profileId` + `POST /sessions/:id/profile`), `server/app.ts` (light `/config`), `server/routes/config-routes.ts` (`/config/full` + `/config/setup`), `server/routes/reset.ts`
- Test: `server/routes/profiles.test.ts`

**Interfaces:**
- Consumes: `queueConfigWrite`, `readConfigFile`, `loadConfig`, `config as serverConfig`, `DEFAULT_PROFILE` (`../config.js`), `coerceProfiles`, `maskToken`, `profileDefaultModel` (`../profiles.js`), `SessionManager.setProfile` (Task 4)
- Produces:
  - `GET /api/profiles` → `{ profiles: Array<{ id, name, authTokenMasked, baseUrl, modelList, modelGroups, recapModel, commitMessageModel, isActive }>, activeProfileId }`
  - `POST /api/profiles`, `PUT /api/profiles/:id`, `DELETE /api/profiles/:id`, `POST /api/profiles/activate`, `POST /api/profiles/:id/test`
  - `POST /sessions/:id/profile` body `{ profileId, apply?: 'now' | 'deferred' }`

- [ ] **Step 1: Write the failing test** — `server/routes/profiles.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { buildProfilesRouter } from './profiles.js'
import { createErrorHandler } from '../errors.js'

function appWith(configDir: string) {
  const app = new Hono()
  app.onError(createErrorHandler('[profiles]'))
  app.route('/', buildProfilesRouter(configDir))
  return app
}

describe('profiles router', () => {
  it('round-trips CRUD and masks tokens', async () => {
    // Use a temp dir seeded with a Default profile via fs (same as config tests).
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-routes-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-abcdef', baseUrl: 'https://api.anthropic.com', modelList: ['m1'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' }],
      activeProfileId: 'default',
    }))
    const app = appWith(dir)

    const created = await app.request('/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second', authToken: 'tok-two', baseUrl: 'https://gw2', modelList: ['m2'] }),
    })
    expect(created.status).toBe(201)
    const createdJson = await created.json()
    expect(createdJson.profile.id).toBeTruthy()
    expect(createdJson.profile.authTokenMasked).toBe('****-two')

    const list = await (await app.request('/profiles')).json()
    expect(list.profiles).toHaveLength(2)
    expect(list.profiles[0].authTokenMasked).toBe('****cdef')

    const del = await app.request('/profiles/default', { method: 'DELETE' })
    expect(del.status).toBe(400) // active profile cannot be deleted
    await fs.rm(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/routes/profiles.test.ts`
Expected: FAIL — `buildProfilesRouter` not found.

- [ ] **Step 3: Write `server/routes/profiles.ts`**

```ts
// Provider-profile CRUD + activation. All writes serialize through the config
// write queue (queueConfigWrite) because profiles is a nested array needing
// read-modify-write semantics — never a blind PUT /config.

import { Hono } from 'hono'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import {
  config as serverConfig, DEFAULT_PROFILE, loadConfig, queueConfigWrite,
} from '../config.js'
import { coerceProfiles, maskToken, profileDefaultModel } from '../profiles.js'
import { createLogger } from '../log.js'

const log = createLogger('profiles')

function toWire(profiles: readonly unknown[], activeProfileId: string) {
  return {
    profiles: profiles.map((p) => {
      const raw = p as Record<string, unknown>
      return {
        id: raw.id,
        name: raw.name,
        authTokenMasked: maskToken(typeof raw.authToken === 'string' ? raw.authToken : undefined),
        baseUrl: raw.baseUrl,
        modelList: raw.modelList,
        modelGroups: raw.modelGroups ?? [],
        recapModel: raw.recapModel,
        commitMessageModel: raw.commitMessageModel,
        isActive: raw.id === activeProfileId,
      }
    }),
    activeProfileId,
  }
}

export function buildProfilesRouter(configDir?: string): Hono {
  const app = new Hono()

  app.get('/profiles', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const profiles = serverConfig.profiles
    return c.json(toWire(profiles as unknown[], serverConfig.activeProfileId))
  })

  app.post('/profiles', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<{
      name?: string; authToken?: string; baseUrl?: string; modelList?: string[];
      modelGroups?: unknown[]; recapModel?: string; commitMessageModel?: string
    }>(c.req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new HttpError(400, 'name is required')
    const active = serverConfig.profiles[0]
    const id = 'p_' + Math.random().toString(36).slice(2, 10)
    const created: Record<string, unknown> = {
      id,
      name,
      authToken: typeof body.authToken === 'string' ? body.authToken : '',
      baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim()
        ? body.baseUrl.trim().replace(/\/+$/, '') : active?.baseUrl ?? DEFAULT_PROFILE.baseUrl,
      modelList: Array.isArray(body.modelList) && body.modelList.length > 0
        ? body.modelList.filter((m) => typeof m === 'string' && m.trim())
        : active?.modelList ?? DEFAULT_PROFILE.modelList,
      modelGroups: Array.isArray(body.modelGroups) ? body.modelGroups : active?.modelGroups ?? DEFAULT_PROFILE.modelGroups,
      recapModel: typeof body.recapModel === 'string' && body.recapModel.trim()
        ? body.recapModel.trim() : active?.recapModel ?? DEFAULT_PROFILE.recapModel,
      commitMessageModel: typeof body.commitMessageModel === 'string' && body.commitMessageModel.trim()
        ? body.commitMessageModel.trim() : active?.commitMessageModel ?? DEFAULT_PROFILE.commitMessageModel,
    }
    await queueConfigWrite(configDir, (existing) => {
      const profiles = Array.isArray(existing.profiles) ? existing.profiles : []
      existing.profiles = [...profiles, created]
    })
    await loadConfig(configDir)
    return c.json({ profile: toWire([created], serverConfig.activeProfileId).profiles[0] }, 201)
  })

  app.put('/profiles/:id', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const id = c.req.param('id')
    const body = await safeJson<Record<string, unknown>>(c.req)
    let found = false
    await queueConfigWrite(configDir, (existing) => {
      const profiles = Array.isArray(existing.profiles) ? existing.profiles : []
      const idx = profiles.findIndex((p) => (p as Record<string, unknown>).id === id)
      if (idx === -1) throw new HttpError(404, `profile ${id} not found`)
      found = true
      const prev = profiles[idx] as Record<string, unknown>
      const next: Record<string, unknown> = { ...prev }
      if (typeof body.name === 'string' && body.name.trim()) next.name = body.name.trim()
      // authToken only written when non-empty (empty/absent = keep existing).
      if (typeof body.authToken === 'string' && body.authToken.trim()) next.authToken = body.authToken
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
        next.baseUrl = body.baseUrl.trim().replace(/\/+$/, '')
      }
      if (Array.isArray(body.modelList)) {
        next.modelList = body.modelList.filter((m) => typeof m === 'string' && m.trim())
      }
      if (Array.isArray(body.modelGroups)) next.modelGroups = body.modelGroups
      if (typeof body.recapModel === 'string') next.recapModel = body.recapModel.trim()
      if (typeof body.commitMessageModel === 'string') next.commitMessageModel = body.commitMessageModel.trim()
      profiles[idx] = next
      existing.profiles = profiles
    })
    if (!found) throw new HttpError(404, `profile ${id} not found`)
    await loadConfig(configDir)
    return c.json({ ok: true })
  })

  app.delete('/profiles/:id', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const id = c.req.param('id')
    if (id === serverConfig.activeProfileId) {
      throw new HttpError(400, 'cannot delete the active profile — switch active first')
    }
    if (serverConfig.profiles.length <= 1) {
      throw new HttpError(400, 'cannot delete the last remaining profile')
    }
    await queueConfigWrite(configDir, (existing) => {
      const profiles = Array.isArray(existing.profiles) ? existing.profiles : []
      existing.profiles = profiles.filter((p) => (p as Record<string, unknown>).id !== id)
    })
    await loadConfig(configDir)
    return c.json({ ok: true })
  })

  app.post('/profiles/activate', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<{ profileId?: string }>(c.req)
    const profileId = body.profileId
    if (typeof profileId !== 'string' || !serverConfig.profiles.some((p) => p.id === profileId)) {
      throw new HttpError(400, `profile ${profileId} not found`)
    }
    await queueConfigWrite(configDir, (existing) => {
      existing.activeProfileId = profileId
    })
    await loadConfig(configDir)
    return c.json({ ok: true, activeProfileId: serverConfig.activeProfileId })
  })

  app.post('/profiles/:id/test', async (c) => {
    // Reuse the sentinel test from /config/test-connection by delegating to
    // the same logic against this profile's credentials. Simplest correct
    // implementation: read the profile from the live config and replay the
    // exact fetch classification from config-routes.ts's /config/test-connection.
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const id = c.req.param('id')
    const profile = serverConfig.profiles.find((p) => p.id === id)
    if (!profile) throw new HttpError(404, `profile ${id} not found`)
    if (!profile.authToken) throw new HttpError(400, 'No auth token to test — save one first')
    const { testConnection } = await import('../config-test-connection.js')
    return c.json(await testConnection(profile.authToken, profile.baseUrl))
  })

  return app
}
```

To avoid duplicating the test-connection fetch logic, extract it: in `config-routes.ts`, move the classification body of `POST /config/test-connection` (everything after the token/baseUrl resolution, lines 102-167) into a new exported `server/config-test-connection.ts`:

```ts
import { validateOutboundUrl } from './ssrf.js'
import { createLogger } from './log.js'
const log = createLogger('config')
const SENTINEL_MODEL = '__claude_react_web_connection_test__'
export async function testConnection(token: string, baseUrl: string) {
  const ssrfCheck = await validateOutboundUrl(baseUrl)
  if (!ssrfCheck.ok) return { ok: false, error: ssrfCheck.error }
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, { /* same as today */ })
    /* ... classify exactly as config-routes.ts does today ... */
  } catch (e) { /* same timeout/network classification */ }
}
```

`config-routes.ts`'s `/config/test-connection` then calls `testConnection(token, baseUrl)` (behavior unchanged).

- [ ] **Step 4: mount the router**

In `server/routes/index.ts`, import `buildProfilesRouter` and mount it right after `buildConfigRouter`:

```ts
import { buildProfilesRouter } from './profiles.js'
...
  app.route('/', buildConfigRouter(sm, configDir))
  app.route('/', buildProfilesRouter(configDir))
```

- [ ] **Step 5: session routes**

In `server/routes/sessions.ts`:
- Add `'profileId'` to the `stringFields` array in `narrowCreateBody` (line 93).
- Add a new route after `/model-group` (line 476):

```ts
  // Pin a session to a provider profile. `apply: 'now'` restarts the Query so
  // new credentials apply immediately; `deferred` applies on the next respawn.
  app.post('/sessions/:id/profile', async (c) => {
    const body = await safeJson<{ profileId?: unknown; apply?: unknown }>(c.req)
    if (typeof body.profileId !== 'string' || !body.profileId) {
      return c.json({ error: 'profileId is required' }, 400)
    }
    if (body.apply !== undefined && body.apply !== 'now' && body.apply !== 'deferred') {
      return c.json({ error: "apply must be 'now' or 'deferred'" }, 400)
    }
    const info = await sm.setProfile(c.req.param('id'), body.profileId, body.apply ?? 'now')
    return c.json({ session: info })
  })
```

- [ ] **Step 6: light `/config` + `/config/full` + `/config/setup`**

`server/app.ts` light `/config` (line 211): add two fields to the returned object:

```ts
      activeProfileId: serverConfig.activeProfileId,
      activeProfileName: serverConfig.profiles.find((p) => p.id === serverConfig.activeProfileId)?.name ?? 'Default',
```

`server/routes/config-routes.ts` `/config/full` (line 211): add:

```ts
      profiles: serverConfig.profiles.map((p) => ({
        id: p.id, name: p.name,
        authTokenMasked: p.authToken ? '****' + p.authToken.slice(-4) : undefined,
        baseUrl: p.baseUrl, modelList: p.modelList, modelGroups: p.modelGroups,
        recapModel: p.recapModel, commitMessageModel: p.commitMessageModel,
        isActive: p.id === serverConfig.activeProfileId,
      })),
      activeProfileId: serverConfig.activeProfileId,
```

`/config/setup` (line 27): keep writing `authToken`/`baseUrl`/`modelList`/`recapModel`/`commitMessageModel` into `existing` — after `loadConfig` these are re-migrated into a Default profile by `migrateLegacyProfiles` if `profiles` is absent. Add `profiles` + `activeProfileId` as an explicit alternative so a fresh setup writes the profile shape directly:

```ts
    // If profiles already exist, write the setup fields into profiles[0].
    if (Array.isArray(existing.profiles) && existing.profiles.length > 0) {
      const p0 = { ...(existing.profiles[0] as Record<string, unknown>) }
      if (body.authToken?.trim()) p0.authToken = body.authToken.trim()
      if (body.baseUrl?.trim()) p0.baseUrl = body.baseUrl.trim().replace(/\/+$/, '')
      if (Array.isArray(body.modelList) && body.modelList.length > 0) {
        p0.modelList = body.modelList.filter((m) => typeof m === 'string' && m.trim())
      }
      if (typeof body.recapModel === 'string') p0.recapModel = body.recapModel.trim() || undefined
      if (typeof body.commitMessageModel === 'string') p0.commitMessageModel = body.commitMessageModel.trim() || undefined
      existing.profiles[0] = p0
    }
```

- [ ] **Step 7: reset.ts**

`server/routes/reset.ts` — the `app-settings` item no longer clears top-level model keys. Replace its `run` body with a `queueConfigWrite` that resets each profile's model fields to `DEFAULT_PROFILE` values (keeping credentials):

```ts
        case 'app-settings':
          await run(item, async () => {
            await queueConfigWrite(deps.configDir, (existing) => {
              const profiles = Array.isArray(existing.profiles) ? existing.profiles : []
              existing.profiles = profiles.map((p) => {
                if (typeof p !== 'object' || p === null) return p
                return {
                  ...p,
                  modelList: [...DEFAULT_PROFILE.modelList],
                  modelGroups: [...DEFAULT_PROFILE.modelGroups],
                  recapModel: DEFAULT_PROFILE.recapModel,
                  commitMessageModel: DEFAULT_PROFILE.commitMessageModel,
                }
              })
            })
            await loadConfig(deps.configDir)
          })
          break
```

Update imports: replace `updateConfigFile` with `queueConfigWrite`, and add `DEFAULT_PROFILE`; drop `APP_SETTING_KEYS` (no longer used) or keep it only for the non-model keys — remove `'modelList', 'recapModel', 'commitMessageModel'` from it and stop using it (the model fields move into profiles; the remaining keys still clear via `updateConfigFile`). Concretely, keep the non-model keys clearing via `updateConfigFile(deps.configDir, nulls)` and add the `queueConfigWrite` profiles reset:

```ts
            const nulls: Record<string, null> = {}
            for (const k of APP_SETTING_KEYS) nulls[k] = null
            await updateConfigFile(deps.configDir, nulls)
            await queueConfigWrite(deps.configDir, (existing) => { /* reset profiles' model fields as above */ })
            await loadConfig(deps.configDir)
```

- [ ] **Step 8: run tests + typecheck**

Run: `npx vitest run server/routes/profiles.test.ts` then `npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 9: Commit**

```bash
git add server/routes/profiles.ts server/config-test-connection.ts server/routes/index.ts server/routes/sessions.ts server/routes/config-routes.ts server/routes/reset.ts server/app.ts server/routes/profiles.test.ts
git commit -m "feat(profiles): add profiles REST surface and wire session profile switch"
```

---

### Task 7: client types + `useProfiles` hook

**Files:**
- Modify: `src/types/config.ts`
- Create: `src/hooks/useProfiles.ts`
- Test: `src/hooks/useProfiles.test.ts` (jsdom workspace — follow `useModelOptions.test.ts` style)

**Interfaces:**
- Produces:
  - `interface ProviderProfile { id: string; name: string; authTokenMasked?: string; baseUrl: string; modelList: string[]; modelGroups: ModelGroupConfig[]; recapModel: string; commitMessageModel: string; isActive: boolean }` (client mirror, `src/types/config.ts`)
  - `useProfiles(): { profiles: ProviderProfile[]; activeProfileId?: string; refresh(): void; create(input): Promise<void>; update(id, input): Promise<void>; remove(id): Promise<void>; activate(id): Promise<void> }`

- [ ] **Step 1: Write the failing test** — `src/hooks/useProfiles.test.ts`

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useProfiles } from './useProfiles'
import { api } from './useApi'

vi.mock('./useApi', () => ({ api: { get: vi.fn() } }))

const PROFILES = {
  profiles: [
    { id: 'a', name: 'A', authTokenMasked: '****cdef', baseUrl: 'https://gw1', modelList: ['ma'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c', isActive: true },
    { id: 'b', name: 'B', authTokenMasked: '****1234', baseUrl: 'https://gw2', modelList: ['mb'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c', isActive: false },
  ],
  activeProfileId: 'a',
}

describe('useProfiles', () => {
  beforeEach(() => { vi.mocked(api.get).mockReset() })

  it('fetches and exposes profiles', async () => {
    vi.mocked(api.get).mockResolvedValue(PROFILES)
    const { result } = renderHook(() => useProfiles())
    await waitFor(() => expect(result.current.profiles).toHaveLength(2))
    expect(result.current.activeProfileId).toBe('a')
    expect(result.current.profiles[0].isActive).toBe(true)
  })

  it('calls activate on activate()', async () => {
    vi.mocked(api.get).mockResolvedValue(PROFILES)
    vi.spyOn(api, 'post' as never).mockResolvedValue({ ok: true } as never)
    const { result } = renderHook(() => useProfiles())
    await waitFor(() => expect(result.current.profiles.length).toBeGreaterThan(0))
    await act(() => result.current.activate('b'))
    expect(api.post).toHaveBeenCalledWith('/profiles/activate', { profileId: 'b' })
  })
})
```

Note: extend `useApi`'s `api` object with `post`/`put`/`delete` if it only has `get` today — check `src/hooks/useApi.ts`; if `api` exposes a generic `request`, use that. Adjust the mock accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useProfiles.test.ts`
Expected: FAIL — `useProfiles` not found.

- [ ] **Step 3: add client types**

In `src/types/config.ts`, add:

```ts
export interface ProviderProfile {
  id: string
  name: string
  authTokenMasked?: string
  baseUrl: string
  modelList: string[]
  modelGroups: ModelGroupConfig[]
  recapModel: string
  commitMessageModel: string
  isActive: boolean
}
```

Add to `ConfigResponse`: `activeProfileId?: string; activeProfileName?: string`.
Add to `FullServerConfig`: `profiles?: ProviderProfile[]; activeProfileId?: string`.

- [ ] **Step 4: write `src/hooks/useProfiles.ts`**

Follow the `useModelOptions` pattern (lazy fetch, `useState` + `useEffect` + `useCallback` refresh; `api` from `./useApi`):

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import type { ProviderProfile } from '../types/config'

export interface ProfilesData {
  profiles: ProviderProfile[]
  activeProfileId?: string
  refresh: () => Promise<void>
  create: (input: Record<string, unknown>) => Promise<void>
  update: (id: string, input: Record<string, unknown>) => Promise<void>
  remove: (id: string) => Promise<void>
  activate: (id: string) => Promise<void>
}

export function useProfiles(): ProfilesData {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>()
  const inFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current
    const p = api.get<{ profiles: ProviderProfile[]; activeProfileId: string }>('/profiles')
      .then((data) => {
        setProfiles(data.profiles ?? [])
        setActiveProfileId(data.activeProfileId)
      })
      .catch(() => {})
    inFlight.current = p
    try { await p } finally { inFlight.current = null }
    return p
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const create = useCallback(async (input: Record<string, unknown>) => {
    await api.post('/profiles', input)
    await refresh()
  }, [refresh])

  const update = useCallback(async (id: string, input: Record<string, unknown>) => {
    await api.put(`/profiles/${id}`, input)
    await refresh()
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    await api.delete(`/profiles/${id}`)
    await refresh()
  }, [refresh])

  const activate = useCallback(async (id: string) => {
    await api.post('/profiles/activate', { profileId: id })
    await refresh()
  }, [refresh])

  return { profiles, activeProfileId, refresh, create, update, remove, activate }
}
```

- [ ] **Step 5: run tests**

Run: `npx vitest run src/hooks/useProfiles.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/config.ts src/hooks/useProfiles.ts src/hooks/useProfiles.test.ts
git commit -m "feat(profiles): add client types and useProfiles hook"
```

---

### Task 8: top-bar quick switcher

**Files:**
- Create: `src/components/ProfileSwitcher.tsx`
- Modify: `src/App.tsx` (render `<ProfileSwitcher />` in the top bar)

**Interfaces:**
- Consumes: `useProfiles` (Task 7)
- Produces: a self-contained `<ProfileSwitcher />` that renders the active profile name + a dropdown; selecting a profile calls `activate(id)`.

- [ ] **Step 1: Write the failing test** — `src/components/ProfileSwitcher.test.tsx`

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProfileSwitcher } from './ProfileSwitcher'
import * as useProfiles from '../hooks/useProfiles'

vi.mock('../hooks/useProfiles', () => ({ useProfiles: vi.fn() }))

describe('ProfileSwitcher', () => {
  it('shows the active profile name and activates on select', () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    vi.mocked(useProfiles.useProfiles).mockReturnValue({
      profiles: [
        { id: 'a', name: 'A', isActive: true, baseUrl: '', modelList: [], modelGroups: [], recapModel: '', commitMessageModel: '' },
        { id: 'b', name: 'B', isActive: false, baseUrl: '', modelList: [], modelGroups: [], recapModel: '', commitMessageModel: '' },
      ],
      activeProfileId: 'a', refresh: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), activate,
    })
    render(<ProfileSwitcher />)
    expect(screen.getByText('A')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    expect(activate).toHaveBeenCalledWith('b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ProfileSwitcher.test.tsx`
Expected: FAIL — `ProfileSwitcher` not found.

- [ ] **Step 3: write `src/components/ProfileSwitcher.tsx`**

```tsx
import { useState } from 'react'
import { useProfiles } from '../hooks/useProfiles'

export function ProfileSwitcher() {
  const { profiles, activeProfileId, activate } = useProfiles()
  const [open, setOpen] = useState(false)
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]

  return (
    <div className="profile-switcher">
      <button
        type="button"
        className="profile-switcher__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active ? `Profile: ${active.name}` : 'No profile'}
      >
        <span className="profile-switcher__dot" aria-hidden />
        <span className="profile-switcher__name">{active?.name ?? 'Default'}</span>
        <span className="profile-switcher__chevron" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="profile-switcher__menu" role="menu">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === activeProfileId}
              className="profile-switcher__item"
              onClick={() => { void activate(p.id).then(() => setOpen(false)) }}
            >
              <span className="profile-switcher__item-name">{p.name}</span>
              {p.id === activeProfileId && <span className="profile-switcher__check" aria-hidden>✓</span>}
            </button>
          ))}
          {profiles.length === 0 && <div className="profile-switcher__empty">No profiles</div>}
        </div>
      )}
    </div>
  )
}
```

Add minimal styles to the theme CSS (variables only — no hex): `.profile-switcher` (position relative), `.profile-switcher__trigger` / `__menu` (absolute dropdown using `var(--panel-bg)`, `var(--border)`, `var(--text)`), `__dot` (a small `var(--accent)` circle), `__check` (accent). Place next to the other top-bar styles in `src/styles/` (find the existing top-bar/header stylesheet).

- [ ] **Step 4: mount in `src/App.tsx`**

Import and render `<ProfileSwitcher />` inside the top bar, immediately to the right of the sidebar-collapse toggle button (in the same header element that also shows the session-group title). Since `ProfileSwitcher` fetches its own data, no prop threading is needed.

- [ ] **Step 5: run tests + typecheck**

Run: `npx vitest run src/components/ProfileSwitcher.test.tsx` then `npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/ProfileSwitcher.tsx src/components/ProfileSwitcher.test.tsx src/App.tsx
git commit -m "feat(profiles): add top-bar active-profile quick switcher"
```

---

### Task 9: Settings → Profiles tab (replace API / Models / Model Groups)

**Files:**
- Modify: `src/components/GlobalSettingsModal.tsx`
- Create: `src/components/ProfilesSettingsTab.tsx` (the card-per-profile editor)

**Interfaces:**
- Consumes: `useProfiles` (Task 7), `ProviderProfile` (Task 7)
- Produces: `ProfilesSettingsTab` component; the modal's `Tab` union drops `'api' | 'models' | 'model-groups'`, adds `'profiles'`.

- [ ] **Step 1: write the failing test** — `src/components/ProfilesSettingsTab.test.tsx`

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProfilesSettingsTab } from './ProfilesSettingsTab'
import * as useProfiles from '../hooks/useProfiles'

vi.mock('../hooks/useProfiles', () => ({ useProfiles: vi.fn() }))

describe('ProfilesSettingsTab', () => {
  it('renders one card per profile with the active badge', () => {
    vi.mocked(useProfiles.useProfiles).mockReturnValue({
      profiles: [
        { id: 'a', name: 'A', isActive: true, authTokenMasked: '****cdef', baseUrl: 'https://gw1', modelList: ['ma'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
        { id: 'b', name: 'B', isActive: false, authTokenMasked: undefined, baseUrl: 'https://gw2', modelList: ['mb'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
      ],
      activeProfileId: 'a', refresh: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), activate: vi.fn(),
    })
    render(<ProfilesSettingsTab />)
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('B')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
  })
})
```

- [ ] **Step 2: run test to verify it fails**

Run: `npx vitest run src/components/ProfilesSettingsTab.test.tsx`
Expected: FAIL — `ProfilesSettingsTab` not found.

- [ ] **Step 3: write `src/components/ProfilesSettingsTab.tsx`**

A card per profile, each with: editable `name` / `baseUrl` / `modelList` (ordered textarea/list editor) / `modelGroups` (reuse the existing model-group editor markup from the old `model-groups` tab) / `recapModel` / `commitMessageModel` dropdowns, an `authToken` masked field (dirty-token pattern: empty = keep existing on save), "Test connection", "Set active", and "Delete". Top-level "Add profile" button. Wire mutations through `useProfiles.create/update/remove/activate`. Reuse the existing modal styles/classnames already in `GlobalSettingsModal` for form rows and buttons (copy the markup patterns from the old API/Models/Model Groups tabs — do not invent new CSS). Delete is gated client-side (disable for the active / last profile), matching the server guards.

Because this is a large UI surface, implement it in one component and render it in the modal (Step 4); the unit test above covers the render + active-badge behavior; manual verification covers the full editor.

- [ ] **Step 4: swap the tabs in `GlobalSettingsModal.tsx`**

- Change `type Tab` (line 55): replace `'api' | 'models' | 'model-groups'` with `'profiles'`.
- Change the default tab (line 135): `useState<Tab>('profiles')`.
- Remove the `authToken`/`baseUrl`/`modelList`/`modelGroups`/`recapModel`/`commitMessageModel`/`newModel` state + their `handleSave` branches (they're now profile-scoped).
- Replace the tab array entries (lines 390-392) with `{ key: 'profiles', label: 'Profiles' }`.
- Replace the `{tab === 'api' && (...)}` / `models` / `model-groups` render blocks (line 476 onward) with `{tab === 'profiles' && <ProfilesSettingsTab />}`.

- [ ] **Step 5: run tests + typecheck**

Run: `npx vitest run src/components/ProfilesSettingsTab.test.tsx` then `npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/GlobalSettingsModal.tsx src/components/ProfilesSettingsTab.tsx src/components/ProfilesSettingsTab.test.tsx
git commit -m "feat(profiles): replace API/Models/Model Groups tabs with a Profiles tab"
```

---

### Task 10: per-session profile dropdown + profile-aware model picker

**Files:**
- Modify: `src/components/SettingsPanel.tsx` (add profile dropdown), `src/components/ChatPanel.tsx` (pass `profileId` to the model picker), `src/hooks/useModelOptions.ts`
- Create: `src/components/SessionProfileSelect.tsx`
- Test: `src/components/SessionProfileSelect.test.tsx` + extend `src/hooks/useModelOptions.test.ts`

**Interfaces:**
- Consumes: `useProfiles` (Task 7), `api.post('/sessions/:id/profile')`, `SessionInfo.profileId/profileName`
- Produces: `SessionProfileSelect({ session, onSessionUpdate })`; `useModelOptions(sessionId, enabled, profileId?)`.

- [ ] **Step 1: write the failing tests**

`src/components/SessionProfileSelect.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionProfileSelect } from './SessionProfileSelect'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useProfiles', () => ({ useProfiles: () => ({
  profiles: [
    { id: 'a', name: 'A', isActive: true, baseUrl: '', modelList: [], modelGroups: [], recapModel: '', commitMessageModel: '' },
    { id: 'b', name: 'B', isActive: false, baseUrl: '', modelList: [], modelGroups: [], recapModel: '', commitMessageModel: '' },
  ],
  activeProfileId: 'a',
}) }))
vi.mock('../hooks/useApi', () => ({ api: { post: vi.fn() } }))

describe('SessionProfileSelect', () => {
  it('POSTs the chosen profile + apply mode', () => {
    vi.mocked(api.post).mockResolvedValue({})
    const onSessionUpdate = vi.fn()
    render(<SessionProfileSelect session={{ id: 's1', profileId: 'a' } as never} onSessionUpdate={onSessionUpdate} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    fireEvent.click(screen.getByText('Restart now'))
    expect(api.post).toHaveBeenCalledWith('/sessions/s1/profile', { profileId: 'b', apply: 'now' })
  })
})
```

Extend `src/hooks/useModelOptions.test.ts`: a session with `profileId` resolves `models`/`defaultModel`/`modelGroups` from the profile (override wins), and one without falls back to `/config`.

- [ ] **Step 2: run tests to verify they fail**

Run: `npx vitest run src/components/SessionProfileSelect.test.tsx src/hooks/useModelOptions.test.ts`
Expected: FAIL.

- [ ] **Step 3: write `src/components/SessionProfileSelect.tsx`**

```tsx
import { useState } from 'react'
import { api } from '../hooks/useApi'
import { useProfiles } from '../hooks/useProfiles'
import type { SessionInfoBase } from '../../shared/session-info'

export function SessionProfileSelect({
  session,
  onSessionUpdate,
}: {
  session: SessionInfoBase
  onSessionUpdate: (s: SessionInfoBase) => void
}) {
  const { profiles, activeProfileId } = useProfiles()
  const [value, setValue] = useState(session.profileId ?? '')
  const [apply, setApply] = useState<'now' | 'deferred'>('now')

  const choose = async (profileId: string, mode: 'now' | 'deferred') => {
    const res = await api.post<{ session: SessionInfoBase }>(`/sessions/${session.id}/profile`, {
      profileId, apply: mode,
    })
    setValue(profileId)
    onSessionUpdate(res.session)
  }

  return (
    <div className="session-profile-select">
      <label>
        Profile
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={profiles.length === 0}
        >
          <option value="">Follow global ({activeProfileId})</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      {value && value !== session.profileId && (
        <div className="session-profile-select__actions">
          <button type="button" onClick={() => void choose(value, 'now')}>Restart now</button>
          <button type="button" onClick={() => void choose(value, 'deferred')}>Apply next restart</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: render it in `SettingsPanel.tsx`**

In `SettingsPanel` (props already include `session` and `onSessionUpdate`), render `<SessionProfileSelect session={session} onSessionUpdate={onSessionUpdate} />` above the model section. The panel header already shows `session.profileName` via `SessionInfo` (add it if the header doesn't yet render it).

- [ ] **Step 5: make `useModelOptions` profile-aware**

Change `src/hooks/useModelOptions.ts` signature to `useModelOptions(sessionId: string, enabled: boolean, profileId?: string)`. In the fetch effect:

```ts
      const profileList = profileId
        ? await api.get<{ profiles: { id: string; modelList: string[]; modelGroups: ModelGroupConfig[] }[] }>('/profiles')
            .then((d) => d.profiles?.find((p) => p.id === profileId))
            .catch(() => undefined)
        : undefined
      const cfg = profileList
        ? { models: profileList.modelList, modelGroups: profileList.modelGroups }
        : await api.get<{ models?: string[]; modelGroups?: ModelGroupConfig[] }>('/config', { signal: ac.signal })
```

Add `profileId` to the effect dependency array, and pass it from `ChatPanel.tsx` line 360: `useModelOptions(session.id, !!modelMenu && !!session.running, session.profileId)`.

- [ ] **Step 6: run tests + typecheck**

Run: `npx vitest run src/components/SessionProfileSelect.test.tsx src/hooks/useModelOptions.test.ts` then `npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/SettingsPanel.tsx src/components/ChatPanel.tsx src/hooks/useModelOptions.ts src/components/SessionProfileSelect.tsx src/components/SessionProfileSelect.test.tsx src/hooks/useModelOptions.test.ts
git commit -m "feat(profiles): per-session profile dropdown and profile-aware model picker"
```

---

## Self-review notes

- **Spec coverage:** §1 (schema + migration) → Tasks 1-2; §2 (resolver + derived fields) → Tasks 1-2; §3 (API) → Task 6; §4 (per-session override) → Tasks 3-5; §5 (UI) → Tasks 7-10; §6 (files) covered across tasks; §7 (testing) covered per-task.
- **Type consistency:** `ProviderProfile` (server) is defined once in `server/config.ts`; the client mirror is named `ProviderProfile` in `src/types/config.ts` (distinct bundle, no collision). `profileDefaultModel`, `findProfile`, `resolveActiveProfile`, `effectiveProfileFor`, `setProfile`, `restart`, `buildProfileEnv` names are used identically in the tasks that define and consume them.
- **Known follow-ups surfaced for the executor:** `useApi` may need `post`/`put`/`delete` helpers if absent (Task 7 Step 1 notes this); `coerceMeta` must be exported (Task 3); `resolveConfiguredModel` must be exported (Task 4). Each is called out in its task.
