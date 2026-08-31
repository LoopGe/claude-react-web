# Provider Profiles: one-click switching of API + model configuration

Date: 2026-08-28

## Problem

The app keeps exactly one set of connection credentials and one model list in
`config.json` — top-level `authToken` / `baseUrl` / `modelList` / `modelGroups` /
`recapModel` / `commitMessageModel`. A user with two subscriptions (e.g. two
gateway accounts, or an Anthropic account plus a DeepSeek gateway) must hand-edit
four separate settings surfaces to switch between them: the API tab (token +
URL), the Models tab (model list + recap/commit models), and the Model Groups tab
(tier bundles). Switching subscriptions almost always means changing all of them
together, because each subscription exposes a different model catalogue.

This spec introduces **provider profiles** — a named bundle of
`{ authToken, baseUrl, modelList, modelGroups, recapModel, commitMessageModel }` —
plus an `activeProfileId`, so switching subscriptions becomes a single action.
Sessions default to the active profile but may override to a specific profile.

## Goal / non-goals

- **Goal:** a `profiles` array + `activeProfileId` in `config.json`, hard-migrated
  from the existing top-level credential/model fields on first load.
- **Goal:** a one-click "switch active profile" affordance that changes the
  credential + model configuration the whole app uses for new sessions.
- **Goal:** per-session profile override: a session can be spawned (or switched)
  to a non-active profile; the profile's `authToken` / `baseUrl` / model set
  apply to that session.
- **Goal:** the credential/model fields remain readable as `ServerConfig`
  properties derived from the active profile, so every existing consumer keeps
  working without change.
- **Non-goal:** multiple provider *implementations* per profile (see rejected
  Approach 2). Every profile still runs through the single `claude` SDK/CLI; only
  the credential/model inputs differ.
- **Non-goal:** changing the credentials of an already-running SDK subprocess.
  Credentials are spawn-time (`Options.env`); a live session keeps its current
  credentials until it respawns. This is an SDK limitation, not a bug.
- **Non-goal:** moving subscription-independent fields (`maxUploadBytes`,
  `historyCap`, `maxOpenPanels`, `workingStuckMs`, `skillLoadMode`, `accessToken`,
  `maxOutputTokens`, …) into profiles. They stay top-level.

## Design

### 1. Config schema + migration

New types in `server/config.ts`:

```ts
/** A named subscription bundle. `modelList[0]` is the profile's default model. */
export interface ProviderProfile {
  id: string                      // stable, e.g. 'p_default'
  name: string                    // display name, e.g. 'Subscription A'
  authToken: string
  baseUrl: string
  modelList: string[]
  modelGroups: ModelGroupConfig[] // reuses the existing ModelGroupConfig
  recapModel: string
  commitMessageModel: string
}
```

`ConfigFile` gains:

```ts
profiles?: ProviderProfile[]
activeProfileId?: string
```

and **drops** the top-level `authToken` / `baseUrl` / `modelList` / `modelGroups` /
`recapModel` / `commitMessageModel` fields (they become derived — §2).

**Hard migration** (user-approved): inside `loadConfig`, after parsing the raw
JSON and before `applyParsedConfig`, if `profiles` is absent and any legacy field
is present:

1. Build `profiles = [{ id: 'default', name: 'Default', authToken, baseUrl,
   modelList, modelGroups, recapModel, commitMessageModel }]` from the legacy
   fields (each falling back to the current `DEFAULTS` value when absent).
2. Set `activeProfileId = 'default'`.
3. Delete the six legacy top-level keys.
4. Write the migrated object back to `config.json` (atomic write), so the next
   boot skips migration.

The migration is idempotent: after it runs, `profiles` is present, so it never
runs again. It never blocks startup — a malformed legacy field falls back to the
`DEFAULTS` value, matching the file's existing tolerance.

The **scaffold** path (no `config.json` exists) is updated to write a starter
`profiles: [{ id: 'default', name: 'Default', authToken: '', baseUrl, modelList,
recapModel, commitMessageModel }]` + `activeProfileId: 'default'` instead of the
six top-level keys.

Validation in `applyParsedConfig`: `id` / `name` / `baseUrl` required non-empty
strings; `modelList` a non-empty string array; `modelGroups` validated exactly as
today (malformed entries dropped with `log.warn`); duplicate profile ids keep the
last entry; `authToken` never logged (only "configured"). A profile with a blank
`authToken` is **allowed** (matches today's unset-token starter state) — the
server still refuses to spawn without an effective token.

### 2. Resolver + derived fields

New `server/profiles.ts`:

```ts
/** Profile the app should use when a session has no override. Never throws:
 *  empty profiles / dangling activeProfileId fall back to profiles[0], then to
 *  a synthetic "default profile" built from DEFAULTS (today's defaults). */
export function resolveActiveProfile(config: ServerConfig): ProviderProfile

/** Look up a profile by id; undefined when absent. */
export function findProfile(config: ServerConfig, id: string): ProviderProfile | undefined

/** modelList[0], or '' for an empty list. */
export function profileDefaultModel(profile: ProviderProfile): string

/** Build a ProviderProfile from legacy top-level fields (migration helper). */
export function profileFromLegacyFields(fields: LegacyProfileFields): ProviderProfile
```

`ServerConfig` **keeps** the read-only fields `authToken` / `baseUrl` / `modelList`
/ `modelGroups` / `defaultModel` / `recapModel` / `commitMessageModel`, but their
values are now **derived from the active profile** at the end of
`applyParsedConfig`:

```ts
const active = resolveActiveProfile(config)
config.authToken            = active.authToken
config.baseUrl              = active.baseUrl
config.modelList            = active.modelList
config.modelGroups          = active.modelGroups
config.recapModel           = active.recapModel
config.commitMessageModel   = active.commitMessageModel
config.defaultModel         = profileDefaultModel(active)
```

Because these stay on `ServerConfig`, every existing consumer (`session-manager`,
`claude-provider` default path, `recap`, `commit-message`, `anthropic-api`,
`test-connection`, the light `GET /api/config`, `requireAuthToken`) keeps working
unchanged — they now see the active profile.

`DEFAULTS` retains its current values so they serve as the synthetic fallback
profile's contents when no profile exists.

`WRITABLE_CONFIG_KEYS`: remove `authToken` / `baseUrl` / `modelList` / `modelGroups`
/ `recapModel` / `commitMessageModel`; add `profiles` / `activeProfileId`.
Profile writes therefore go through the same serialized `queueConfigWrite` /
`updateConfigFile` machinery as today.

`requireAuthToken()` is unchanged — it reads the derived `config.authToken`, so a
blank active-profile token still surfaces as HTTP 401.

### 3. API surface

New `server/routes/profiles.ts` (`buildProfilesRouter({ configDir })`), mounted in
`buildApiRouter` alongside the other store routers. All writes serialize through
`queueConfigWrite`.

- `GET /api/profiles` → `{ profiles: [{ id, name, authTokenMasked, baseUrl,
  modelList, modelGroups, recapModel, commitMessageModel, isActive }] }`.
  Tokens are masked (`'****' + last4`); the client never holds a saved token's
  plaintext.
- `POST /api/profiles` → `{ name?, authToken?, baseUrl?, modelList?, modelGroups?,
  recapModel?, commitMessageModel? }`. Missing fields template from the active
  profile. Returns the created profile (masked).
- `PUT /api/profiles/:id` → merge update; `authToken` only written when non-empty
  (empty/absent = keep existing). Unknown id → 404.
- `DELETE /api/profiles/:id` → deletes. **Guards:** cannot delete the active
  profile (400, switch away first); cannot delete the last remaining profile
  (400).
- `POST /api/profiles/activate` `{ profileId }` → sets `activeProfileId`, reloads
  config, returns `{ ok, activeProfileId }`. Unknown id → 400. **This is the
  one-click switch.**
- `POST /api/profiles/:id/test` → reuses the existing sentinel-model
  connection-test logic against that profile's `authToken` + `baseUrl` (the
  existing `/config/test-connection` endpoint continues to test the active
  profile, since it reads the derived `serverConfig`).

`GET /api/config` (light, in `server/app.ts`) gains `activeProfileId` and
`activeProfileName` (for the top-bar switcher). `GET /api/config/full` gains
`profiles` (masked) + `activeProfileId` (for the settings modal).

`POST /sessions` body gains optional `profileId` (create with an override;
unknown id → 400). New `POST /sessions/:id/profile` — see §4.

### 4. Per-session override

**Session state.** `Session` (`server/session-types.ts`), `SessionMeta`
(`server/persistence.ts`), and `SessionInfoBase` (`shared/session-info.ts`) each
gain `profileId?: string`. `SessionInfoBase` also gains `profileName?: string`
for display. `snapshotMeta` and `coerceMeta` forward `profileId`.

**Resolution.** New manager helper `effectiveProfileFor(profileId?: string):
ProviderProfile` → `profileId ? findProfile(config, profileId) : resolveActiveProfile(config)`.
A session whose `profileId` points at a deleted profile **self-heals** on the
next spawn: clear `profileId`, fall back to the active profile, `log.warn` —
exactly like the existing model-group self-heal.

**Manager touch points.** Every spawn-time read of `defaultConfig.modelList` /
`modelGroups` / `defaultModel` becomes the effective profile's field:

- `resolveConfiguredModel` (module-level, `session-manager.ts`) gains a
  `modelList` parameter; all call sites (`spawn`, `setModelGroup`, `resume`,
  `clear`) pass `effectiveProfileFor(...).modelList`.
- `create()` pins `model: opts.model ?? profileDefaultModel(effective)`.
- `spawn()`'s model-group block resolves `modelGroupId` against the effective
  profile's `modelGroups`.
- `setModelGroup()` resolves against the session's effective profile.

**Provider touch points.** `CreateSessionOptions` (`server/providers/types.ts`)
gains `profile?: ProviderProfile`. `session-manager.spawn()` always passes the
resolved effective profile (active or override). `claude-provider.createSession()`
threads it through:

- `applyStandardQueryOpts(sdkOptions, customEnv, enabledPlugins, group, profile)`
  reads `profile.modelList` / `profile.baseUrl` / `profileDefaultModel(profile)`
  instead of `defaultConfig.*`, and builds the tier env vars from the profile's
  group + model list. When `profile` is undefined (defensive), fall back to
  `defaultConfig` (the active profile).
- `buildAnthropicEnv(profile)` reads `profile.authToken` / `profile.baseUrl`
  (and still `defaultConfig.maxOutputTokens`, which stays global). The existing
  `cachedEnv` cache is keyed on `(authToken, baseUrl)`; two profiles alternating
  on spawn thrash the single-entry cache (an env-object rebuild, negligible), so
  correctness holds without re-architecting the cache.
- The provider's module-level `resolveConfiguredModel` (used for bare-name
  resolution) reads the profile's `modelList`.

**`POST /sessions/:id/profile`** body `{ profileId, apply: 'now' | 'deferred' }`
(default `'now'`):

- Unknown profileId → 400. Same profileId as current → no-op.
- Persist `s.profileId`, live-apply the profile's default model/group via the
  existing `setModel` / `setModelGroup` paths (recompute `effortLevels` /
  `thinkingSupported`).
- `apply: 'now'` → respawn through the existing **restart path** (transcript
  preserved) so the new credentials take effect immediately.
- `apply: 'deferred'` → no respawn; credentials apply on the next respawn /
  restart / resume. Live sessions keep their old credentials until then.
- Dormant sessions only persist (no respawn).

### 5. UI

**Top-bar quick switcher** — a persistent dropdown in the top bar, on the left
right of the sidebar-collapse button. Shows the active profile name; the menu
lists all profiles with a checkmark on the active one and a "Manage profiles…"
item (opens Settings → Profiles). Selecting a profile calls
`POST /api/profiles/activate` and refetches. Uses a new `useProfiles` hook shared
with the settings modal so the switcher, modal, and any future consumer stay in
sync.

**Settings → Profiles tab** — replaces the API / Models / Model Groups tabs
(user-approved). One card per profile: name, `isActive` badge, "Set active" /
"Test connection" actions, and a collapsible editor for the full field set
(authToken with the existing masked + dirty-token pattern, baseUrl, modelList
ordered editor, modelGroups editor, recapModel / commitMessageModel dropdowns).
Add / delete / reorder cards. Deletes are gated client-side on the same
server-side guards (active / last profile). Save writes through `PUT /api/profiles/:id`
(or `POST /api/profiles`); "Set active" through `POST /api/profiles/activate`.

**Per-session override** — in the per-panel `SettingsPanel`, a "Profile" dropdown
above the model section (default "Follow global"). Choosing a different profile
opens a small confirm with two buttons matching the server's `apply` modes:
"Restart now" (`now`) and "Apply next restart" (`deferred`). The panel header
shows the session's effective profile name (`profileName` on `SessionInfo`).

`useModelOptions` / `ModelPicker` become profile-aware. `GET /api/config`
continues to reflect the **active** profile (the default for new sessions), but
a session pinned to a non-active profile must offer that profile's catalogue.
The hook therefore resolves its `models` / `defaultModel` / `modelGroups` from
the session's effective profile: when `session.profileId` is set, it reads that
profile's `modelList` / `modelGroups` from the profiles data already held by
`useProfiles` (the fields ride `GET /api/profiles` unmasked); otherwise it falls
back to the active profile via `GET /api/config` exactly as today. `defaultModel`
is that profile's `modelList[0]`, matching the server's spawn-time pin.

### 6. Files touched

- `server/config.ts` — `ProviderProfile`, `ConfigFile.profiles`/`activeProfileId`,
  migration, derived fields, `WRITABLE_CONFIG_KEYS`, scaffold, `clearCredentials`.
- `server/profiles.ts` (new) — resolver + `profileFromLegacyFields`.
- `server/routes/profiles.ts` (new) — profile router.
- `server/routes/index.ts` / `server/app.ts` — mount router; light `/config`
  gains `activeProfileId`/`activeProfileName`; `GET /api/config/full` gains
  `profiles`.
- `server/routes/config-routes.ts` — `/config/setup` writes the initial Default
  profile; `/config/full` returns profiles.
- `server/routes/reset.ts` — `app-settings` clears profiles' model fields (keeps
  credentials); `credentials` clears every profile's `authToken`/`baseUrl`.
- `server/session-types.ts`, `server/persistence.ts`, `shared/session-info.ts` —
  `profileId` (+ `profileName`).
- `server/session-manager.ts` — effective-profile resolution, `resolveConfiguredModel`
  signature, `create`/`spawn`/`setModelGroup`, `setProfile`, `POST /sessions`
  `profileId`, pass `profile` in `providerExtras`/`CreateSessionOptions`.
- `server/providers/types.ts` — `CreateSessionOptions.profile`.
- `server/providers/claude/claude-provider.ts` — `buildAnthropicEnv(profile)`,
  `applyStandardQueryOpts(profile)`, profile-aware `resolveConfiguredModel`.
- `src/types/config.ts` — `ProviderProfile` (client mirror), `FullServerConfig.profiles`
  + `activeProfileId`, `ConfigResponse.activeProfileId/activeProfileName`.
- `src/components/GlobalSettingsModal.tsx` — Profiles tab replaces API/Models/
  Model Groups.
- `src/App.tsx` / top-bar component — quick switcher.
- `src/components/ChatPanel.tsx` + `SettingsPanel.tsx` — per-session profile
  dropdown + effective-profile name.
- `src/hooks/useProfiles.ts` (new) — shared profile fetch/mutate/activate hook.

## Error handling & edge cases

| Scenario | Behavior |
|---|---|
| Delete the active profile | 400 — switch away first. |
| Delete the last profile | 400. |
| Session references a deleted profile | Self-heal on next spawn: clear `profileId`, fall back to active profile, `log.warn`. |
| Switch active profile | Config write + reload; new sessions use the new profile; existing sessions keep their credentials until respawn. |
| `POST /sessions/:id/profile` with unknown id | 400. |
| `POST /sessions/:id/profile` with the same id | No-op. |
| `apply: 'now'` on a mid-turn session | Defer the respawn until the turn completes (mirror the existing restart guard). |
| Migration | Runs once (profiles absent + legacy fields present); malformed legacy fields fall back to `DEFAULTS`; never blocks startup. |
| No profiles at all | `resolveActiveProfile` synthesizes a DEFAULTS-based profile — today's behavior preserved. |
| Concurrent config writes | All profile writes serialize through `queueConfigWrite`. |
| Blank authToken in a profile | Allowed; `requireAuthToken` still 401s at spawn time. |

## Testing

### New unit tests

**`server/profiles.test.ts`** (pure resolver)
- `resolveActiveProfile`: active id present; dangling active id → profiles[0];
  empty → synthetic DEFAULTS profile.
- `findProfile` present/absent.
- `profileFromLegacyFields`: full, partial (defaults fill in), empty.

**`server/config.test.ts`** (extend)
- Migration: legacy fields → `profiles[0]` + `activeProfileId='default'`, legacy
  keys removed, write-back, idempotent (second load no-op).
- Derived fields equal the active profile's; `defaultModel === modelList[0]`.
- `WRITABLE_CONFIG_KEYS` no longer contains the six legacy keys; contains
  `profiles` + `activeProfileId`.
- Malformed profile entries dropped without blocking load; token never logged.
- `clearCredentials` clears every profile's `authToken`/`baseUrl`.

**`server/routes/profiles.test.ts`** (extend `app-*.test.ts` style)
- CRUD round-trip; masked tokens; `POST /api/profiles/activate` reloads;
  delete guards (active / last); `POST /api/profiles/:id/test`.

**`server/session-manager.test.ts`** (extend)
- `POST /sessions` with `profileId` → `Session.profileId` set, `Session.model` =
  that profile's default.
- Spawn resolves `effectiveProfileFor` (override wins over active).
- Deleted-profile self-heal on respawn.
- `setProfile` with `apply:'now'` respawns (transcript preserved) and applies the
  profile's model/group; `deferred` persists without respawn; unknown id → 400.

**`server/providers/claude/claude-provider.test.ts`** (extend)
- `buildAnthropicEnv(profile)` uses `profile.authToken`/`profile.baseUrl`.
- `applyStandardQueryOpts` with a profile uses `profile.modelList` / baseUrl /
  default model; undefined profile falls back to `defaultConfig`.
- Cache stays keyed on (token, baseUrl) — a different profile returns a different
  env (no cross-contamination; the existing contamination guard test extended).

**Client**
- `useProfiles` hook; quick switcher renders + activates; Profiles tab CRUD;
  per-session dropdown → `POST /sessions/:id/profile` with the chosen `apply`;
  `useModelOptions` resolves models/defaultModel/modelGroups from the session's
  effective profile (override wins, active-profile fallback).

### Existing-test updates

- Tests asserting the six legacy keys are writable/readable at the top level are
  rewritten against `profiles` / the derived fields.
- `config.test.ts` modelGroups + `app-model-groups.test.ts` keep passing (they
  assert the derived `config.modelGroups` / light `/config` shape, which are
  preserved).
