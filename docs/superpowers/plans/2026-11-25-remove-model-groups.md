# Remove Model Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the model-group feature end-to-end (config, client UI, server runtime, persistence) so no session can carry a group, while preserving the always-on single-model tier routing and general model resolution.

**Architecture:** Model groups are an additive, Claude-CLI-shaped feature whose group protocol leaks across the provider seam (no capability, duplicated resolution, non-atomic two-step switch — verified to 502 half-applied on native). Removing the feature deletes the whole defect class. The tier env-var mechanism is independent of groups and STAYS in its no-group form (all four aliases collapse to the session model). Work proceeds behavior-first (types intact), then data-model removal, then docs, so every task ends typecheck-green.

**Tech Stack:** TypeScript (Node server + React 19 client), Hono, vitest (happy-dom client), esbuild/vite.

**Spec:** `docs/superpowers/specs/2026-08-27-model-groups-tier-routing-design.md` — the feature being REMOVED (superseded by this plan). The removal rationale and decisions live in this plan and are distilled into a decision note in Task 9.

## Global Constraints

- `npm run typecheck` runs BOTH tsconfigs (`tsconfig.json` + `tsconfig.node.json`); every task ends green on both.
- `npm run test` (vitest) green; client tests run under happy-dom, server under Node.
- **Name-collision hazard:** "model group" (`modelGroups` / `modelGroupId` / `ModelGroupConfig`) is DELETED. "session group" (sidebar grouping: `groups` / `groupId` / `newGroupName` / `SessionGroup` / `maxGroupSize`) is KEPT untouched. Never remove the latter.
- **Keep list (load-bearing, do NOT delete):**
  - Claude provider tier env vars in no-group form: `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` all = the session model (`claude-provider.ts:970-980` `else` branch becomes the only path).
  - `mergeTierEnvIntoSettings` (`claude-provider.ts:209`, applied at 986) and `DISABLE_AUTOUPDATER` (1000).
  - `resolveConfiguredModelId` (general bare-short-name → configured-full-id resolution; used by `claude-provider.ts:299` and the aux path) — RELOCATED, not deleted (Task 8).
  - The aux per-field override path (`recapModel` / `commitMessageModel` / `autoClassifierModel`) in `auxTargetFor`.
  - The model picker's single-model rows, recents, and free-text custom row.
- CSS: no hardcoded hex; use theme vars (only relevant if group CSS classes are cleaned).
- Decision note written in the same change (Task 9); `npm run verify:agent-notes` green.
- Review the full diff (`code-review` skill) before each commit lands; this plan's tasks are the review units.

## Review Focus

- **Legacy persisted session with `modelGroupId`** must still load and resume: `model` preserved, group tag dropped, no crash/404. (Task 5 test.)
- **Legacy `config.json` with `modelGroups`** must load without error and without wiping the profile: the key is ignored. (Task 6 test.)
- **Claude tier env vars still set after removal** — all four = session model; subagents/aliases must not lose routing. (Task 3 test.)
- **Session-group sidebar feature untouched** — creating/grouping sessions in the sidebar still works; `NewSessionDialog` `groups`/`initialGroupId` props intact. (Task 2 test.)
- **Desktop web-import still detects usable fields** with the count reduced 7→6 (`PresentFields` / `hasUsableProfileFields`); a profile with only credentials still imports. (Task 6 test.)
- **Aux calls resolve** to the session model or the per-field override (never undefined) for recap / commitMessage / classifier / pluginAi. (Task 4 test.)

---

## File Structure

**Deleted outright:**
- `server/model-groups.ts` → renamed `server/model-resolution.ts`, slimmed to `resolveConfiguredModelId` only (Task 8).
- `server/model-groups.test.ts` → group cases deleted; `resolveConfiguredModelId` cases move to `server/model-resolution.test.ts` (Task 8).
- `server/routes/sessions-model-group.test.ts`, `server/app-model-groups.test.ts` (whole files, group-only).

**Modified — server runtime:** `server/session-manager.ts`, `server/session-types.ts`, `server/persistence.ts`, `server/routes/sessions.ts`, `server/providers/claude/claude-provider.ts`.

**Modified — server config/profile:** `shared/profile.ts`, `server/config.ts`, `server/profiles.ts`, `server/routes/reset.ts`, `server/web-import.ts`, `server/routes/web-import.ts`, `server/routes/profiles.ts`, `server/routes/config-routes.ts`, `server/app.ts`.

**Modified — shared/client types:** `shared/session-info.ts`, `src/types.ts`, `src/types/config.ts`.

**Modified — client UI:** `src/components/ModelPicker.tsx`, `src/components/ChatPanel.tsx`, `src/components/session-list/NewSessionDialog.tsx`, `src/components/ProfilesSettingsTab.tsx`, `src/state/modelOptionsStore.ts`, `src/hooks/useModelOptions.ts`, `src/hooks/useProfileListDnd.ts`, `src/dnd/payload.ts`, `src/App.tsx`, `src/utils/new-like-this.ts`, `src/styles/utilities.css` (group classes only).

**Tests/fixtures updated (grep-driven):** every `*.test.ts(x)` in the footprint drops `modelGroups: []` / `modelGroupId` from fixtures and deletes group-specific cases. Native provider test fixtures (`server/providers/native/**`) only carry `modelGroups: []` — drop the key.

**Docs:** new decision note `.agents/notes/implemented/simplification/2026-11-25-remove-model-groups.md`; `CHANGELOG.md`; `AGENTS.md` / `CLAUDE.md` mentions; superseded banner on the tier-routing spec/plan.

---

## Phase 1 — Remove runtime behavior (types intact)

### Task 1: Remove the live group-switch surface

**Files:**
- Modify: `server/routes/sessions.ts` (delete `POST /sessions/:id/model-group`, ~906-913)
- Modify: `server/session-manager.ts` (delete `setModelGroup` ~6463-6493; the `wasGroup` fallback branch in `setModel` ~6417/6427-6437; the group nesting in `setProfile` ~6511-6514)
- Modify: `src/components/ChatPanel.tsx` (delete `commitGroup` ~584-602; `currentGroupId` / `onSelectGroup` props passed to ModelPicker ~1207/1214)
- Modify: `src/components/ModelPicker.tsx` (delete group rows ~94-112, `onSelectGroup` prop ~50, `currentGroupId` prop ~42/67)
- Test: `server/routes/sessions-model-group.test.ts` (delete file), `server/session-manager.test.ts` (delete `setModelGroup` cases ~878-925), `src/components/ModelPicker.test.tsx` (delete group cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ModelPicker` props lose `onSelectGroup` / `currentGroupId`; `SessionManager` loses `setModelGroup`. `setModel(id, model?)` keeps its signature but no longer touches `fallbackModel` / `modelGroupId`.

- [ ] **Step 1: Write the failing test** — in `server/session-manager.test.ts`, replace the group-switch cases with:

```ts
it('setModel never applies a fallbackModel flag setting', async () => {
  const info = await sm.create({ cwd: TEST_CWD, model: 'model-a' })
  const handle = mockHandles[0]
  await sm.setModel(info.id, 'model-b')
  expect(handle.applyFlagSettings).not.toHaveBeenCalledWith(
    expect.objectContaining({ fallbackModel: expect.anything() }),
  )
  expect(info.model).toBe('model-b')
})
```

And a route test (new small file or fold into `sessions` route tests): `POST /sessions/:id/model-group` returns 404.

- [ ] **Step 2: Run to verify fail** — `npx vitest run server/session-manager.test.ts -t 'fallbackModel'`. Expected: FAIL (current `setModel`/`setModelGroup` still call `applyFlagSettings({fallbackModel})`).

- [ ] **Step 3: Implement removal** — delete the route handler, `setModelGroup`, the `wasGroup` branch (so `setModel` just switches model + recomputes capabilities + persists), and the `setProfile` group nesting (collapse to the plain `setModel(profileDefaultModel(profile))` path). Delete `commitGroup` and the ModelPicker group rows/props. Remove now-unused `fallbackAliasesFor` usage in the manager (import stays until Task 8).

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/session-manager.test.ts server/routes/ src/components/ModelPicker.test.tsx`. Expected: PASS. Then `npm run typecheck`. Expected: green.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "refactor: remove live model-group switch surface"`

### Task 2: Remove create-time group selection

**Files:**
- Modify: `server/session-manager.ts` (delete create `modelGroupId` validation ~2018-2026; the spawn group block ~3600-3610 — `metaSnapshot.model` stays `fullOpts.model`)
- Modify: `server/routes/sessions.ts` (drop `modelGroupId` from `CREATE_BODY_FIELDS` ~113 and `stringFields` ~142)
- Modify: `src/components/session-list/NewSessionDialog.tsx` (delete `modelGroups` prop ~55/74, `NO_MODEL_GROUPS`, `modelGroupId` state ~93, model-group picker options ~238-300, `activeModelGroup` ~325, submit `modelGroupId` ~530 and the `activeModelGroup ? undefined :` model branch ~527 → always `model.trim() || undefined`, trigger label group branch ~778-781). **KEEP** `groups` / `initialGroupId` / `maxGroupSize` / `newGroupName` (session groups).
- Modify: `src/utils/new-like-this.ts` (drop the `modelGroupId` comment ~29)
- Modify: `src/components/SessionList.tsx` (drop `modelGroups={modelGroups}` passed to NewSessionDialog ~981; SessionList's OWN `modelGroups` prop ~103/216 stays until Task 7)
- Modify: `src/App.tsx` (stop passing `modelGroups` toward the dialog ~5207 area; the App-level `modelGroups` state stays until Task 7)
- Test: `src/components/session-list/NewSessionDialog.test.tsx` (delete model-group cases ~637-859; KEEP session-group cases), `server/session-manager.test.ts` (create-with-group cases ~732-755 → replace)

**Interfaces:**
- Consumes: Task 1's `setModel` (no group).
- Produces: `NewSessionForm` still has optional `modelGroupId` (removed in Task 5) but the dialog never sets it; `NewSessionDialog` props lose `modelGroups`. Create ignores any stray `modelGroupId` body key (dropped by whitelist).

- [ ] **Step 1: Write the failing test** — in `server/session-manager.test.ts`:

```ts
it('create ignores a modelGroupId body key and pins the requested model', async () => {
  __setConfigForTest({ modelGroups: [{ id: 'g1', name: 'G', opus: 'model-b' }] })
  const info = await sm.create({ cwd: TEST_CWD, model: 'model-a', modelGroupId: 'g1' } as any)
  expect(info.model).toBe('model-a')
  expect(info.modelGroupId).toBeUndefined()
})
```

And a client test: `NewSessionDialog` renders no model-group rows and submits `model` (session-group picker still present).

- [ ] **Step 2: Run to verify fail** — `npx vitest run server/session-manager.test.ts -t 'ignores a modelGroupId'`. Expected: FAIL (spawn currently resolves group main into `metaSnapshot.model`).

- [ ] **Step 3: Implement removal** — delete the create validation + spawn group block; drop the body whitelist key; strip the dialog's model-group surface (keep session-group). `metaSnapshot.model` is now just the resolved `fullOpts.model`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/session-manager.test.ts src/components/session-list/NewSessionDialog.test.tsx`. Expected: PASS. `npm run typecheck` green.

- [ ] **Step 5: Commit** — `git commit -am "refactor: remove create-time model-group selection"`

### Task 3: Collapse the Claude provider to single-model tier routing

**Files:**
- Modify: `server/providers/claude/claude-provider.ts` (delete group lookup ~428-430; the `if (group)` branch ~942-969 incl. `capabilitiesForTier` env; post-spawn fallback ~662-673; `providerExtras.modelGroupId` read ~150; group-function imports ~24-27 except `resolveConfiguredModelId`). The `else` branch ~970-980 becomes unconditional.
- Test: `server/providers/claude/claude-provider.test.ts` (delete group cases; keep/extend tier-env cases)

**Interfaces:**
- Consumes: `resolveConfiguredModelId` (still from `model-groups.ts` until Task 8).
- Produces: `applyStandardQueryOpts` always sets the four tier env vars to `effectiveModel`; no group parameter. `mergeTierEnvIntoSettings` unchanged.

- [ ] **Step 1: Write the failing test** — in `claude-provider.test.ts`:

```ts
it('sets all four tier env vars to the session model (no group routing)', () => {
  const handle = provider.createSession({ id: 's', cwd: '/x', model: 'gw/main', profile } as any)
  const env = (handle as any).options.env as Record<string, string>
  for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_SMALL_FAST_MODEL']) {
    expect(env[k]).toBe('gw/main')
  }
  expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES).toBeUndefined()
})
```

(Adapt `provider`/`profile`/`options` access to the file's existing fixture helpers.)

- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/claude/claude-provider.test.ts -t 'four tier env'`. Expected: FAIL if a group fixture still differentiates tiers; otherwise this pins the surviving behavior — confirm it exercises the unconditional path.

- [ ] **Step 3: Implement removal** — delete the group branch and post-spawn fallback; make the no-group collapse the only path; drop the group parameter from `applyStandardQueryOpts` and its call site (~511).

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/providers/claude/claude-provider.test.ts`. Expected: PASS. `npm run typecheck` green.

- [ ] **Step 5: Commit** — `git commit -am "refactor: collapse claude provider to single-model tier routing"`

### Task 4: Simplify the aux-model resolution

**Files:**
- Modify: `server/session-manager.ts` (`auxTargetFor` ~11426-11431: delete the group lookup; `const fallback = session.model` — preserving the no-group return of `auxFallbackModel`; drop `auxFallbackModel` import usage; update the doc comment ~11407-11412/11437-11441)
- Test: `server/session-manager.test.ts` (aux cases ~745-755 → replace)

**Interfaces:**
- Consumes: nothing new.
- Produces: `auxTargetFor(id, field)` unchanged signature; fallback is the session model, override path intact.

- [ ] **Step 1: Write the failing test**:

```ts
it('aux target falls back to the session model (no group haiku tier)', async () => {
  const info = await sm.create({ cwd: TEST_CWD, model: 'gw/some-model' })
  expect(sm.auxTargetFor(info.id, 'recap')).toMatchObject({ model: 'gw/some-model' })
  expect(sm.auxTargetFor(info.id, 'pluginAi')).toMatchObject({ model: 'gw/some-model' })
})
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run server/session-manager.test.ts -t 'aux target falls back'`. Expected: PASS already for no-group (pins behavior); add a case with a legacy `modelGroupId` set on the session to prove the group lookup is gone (FAIL before removal).

- [ ] **Step 3: Implement removal** — replace `auxFallbackModel(...)` with `session.model`; delete the group lookup lines.

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/session-manager.test.ts`. Expected: PASS. `npm run typecheck` green.

- [ ] **Step 5: Commit** — `git commit -am "refactor: aux model falls back to session model without groups"`

---

## Phase 2 — Remove the data model (fields/types)

### Task 5: Remove `modelGroupId` from session types, persistence, and carriers

**Files:**
- Modify: `shared/session-info.ts` (~192-195), `server/session-types.ts` (~324-326), `server/persistence.ts` (~44-46, 262), `src/types.ts` (`NewSessionForm.modelGroupId` ~108)
- Modify: `server/session-manager.ts` (all `modelGroupId` carries: `writeStore` ~1801, `snapshotMeta` ~1915, `info` projection, `baseSpawnOptions` ~12553/12574, meta carries ~2398/2519/2806/5682/5771/11877, `providerExtras.modelGroupId` ~3952)
- Modify: `src/components/ChatPanel.tsx` / `src/components/ModelPicker.tsx` (any remaining `session.modelGroupId` / `currentGroupId` reads)
- Test: `server/persistence`/`session-manager` tests — add legacy-load case; drop `modelGroupId` from fixtures everywhere (grep)

**Interfaces:**
- Consumes: Tasks 1-4 (no runtime writes `modelGroupId`).
- Produces: `SessionMeta` / `SessionInfo` / `Session` / `NewSessionForm` have no `modelGroupId`. Persistence reader ignores a legacy on-disk `modelGroupId`.

- [ ] **Step 1: Write the failing test** — persistence round-trip:

```ts
it('loads a legacy session carrying modelGroupId, preserving model and dropping the tag', () => {
  const meta = coerceSessionMeta({ id: 's', cwd: '/x', model: 'gw/main', modelGroupId: 'g1' } as any)
  expect(meta.model).toBe('gw/main')
  expect((meta as any).modelGroupId).toBeUndefined()
})
```

(Use the persistence module's actual reader name — `coerceSessionMeta`/`parseSessionMeta`, whichever exists at `persistence.ts:260`.)

- [ ] **Step 2: Run to verify fail** — `npx vitest run server/ -t 'legacy session carrying modelGroupId'`. Expected: FAIL (reader currently preserves the tag).

- [ ] **Step 3: Implement removal** — delete the field from all four type defs and every manager carrier; the persistence reader simply stops reading the key (graceful drop-on-read, no destructive migration). Remove client reads.

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/ src/`. Expected: PASS. `npm run typecheck` green (both).

- [ ] **Step 5: Commit** — `git commit -am "refactor: drop modelGroupId from session model and persistence"`

### Task 6: Remove `modelGroups` from the server config/profile layer

**Files:**
- Modify: `shared/profile.ts` (delete `ModelGroupConfig` ~5-15; `ProviderProfile.modelGroups` ~26)
- Modify: `server/config.ts` (re-export ~16/40, `modelGroups` field ~45/214, DEFAULTS ~332/396, merge ~479/581, `LEGACY_PROFILE_KEYS` entry ~521)
- Modify: `server/profiles.ts` (`coerceModelGroups` ~74-110, calls ~201/229, `RawProfile.modelGroups` ~21, import ~5)
- Modify: `server/session-manager.ts` (`effectiveProfileFor` legacy group inheritance ~374-380)
- Modify: `server/routes/reset.ts` (~86), `server/routes/profiles.ts`, `server/routes/config-routes.ts` (~255/264), `server/app.ts` (~264)
- Modify: `server/providers/native-host-adapters.ts` (drop `modelGroups: config.modelGroups` ~65 from the native profile view)
- Modify: `server/web-import.ts` (`PresentFields.modelGroups` ~42, `ProfileFields.modelGroups` ~54, read ~106/114-120, `hasUsableProfileFields` ~136 — reduce 7→6 fields), `server/routes/web-import.ts`
- Test: `server/config.test.ts` (group cases ~632-706 → replace with ignore-case), `server/profiles.test.ts`, `server/web-import.test.ts`, `server/routes/reset.test.ts`, `server/routes/config-routes*.test.ts`, `server/routes/profiles.test.ts`, `server/app-model-groups.test.ts` (delete file)

**Interfaces:**
- Consumes: Tasks 1-5 (no server runtime reads `profile.modelGroups`).
- Produces: `ProviderProfile` (server/shared) has no `modelGroups`; `coerceModelGroups` gone; web-import `PresentFields` has 6 fields. The client `ProviderProfile` mirror (`src/types/config.ts`) is a SEPARATE type, untouched until Task 7.

- [ ] **Step 1: Write the failing test** — config load ignores legacy groups:

```ts
it('loadConfig ignores a legacy modelGroups key without wiping the profile', async () => {
  const cfg = await loadConfigFrom({ modelList: ['gw/a'], modelGroups: [{ id: 'g', name: 'G', opus: 'gw/a' }] } as any)
  expect(cfg.modelList).toEqual(['gw/a'])
  expect((cfg as any).modelGroups).toBeUndefined()
})
```

(Use the file's actual load helper.) And a web-import case: a source profile with only `authToken`+`baseUrl` still reports `hasUsableProfileFields === true` (6-field logic).

- [ ] **Step 2: Run to verify fail** — `npx vitest run server/config.test.ts server/web-import.test.ts -t 'legacy modelGroups'`. Expected: FAIL.

- [ ] **Step 3: Implement removal** — delete the type/field/coercion/defaults/merge/legacy-key; simplify `effectiveProfileFor` (drop the inheritance block); reduce web-import to 6 fields (remove `modelGroups` from `PresentFields`, `ProfileFields`, the read mapping, and `hasUsableProfileFields`); drop the reset/profiles/config-routes/app group lines.

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/`. Expected: PASS. `npm run typecheck` green.

- [ ] **Step 5: Commit** — `git commit -am "refactor: remove modelGroups from config, profiles, and web-import"`

### Task 7: Remove the client config/profile group surface

**Files:**
- Modify: `src/types/config.ts` (`ModelGroupConfig` ~173-180, `modelGroups` ~166/197/220)
- Modify: `src/state/modelOptionsStore.ts` (`modelGroups` ~40/43/101/114/179/229/238), `src/hooks/useModelOptions.ts` (~56-57/114/122)
- Modify: `src/App.tsx` (`modelGroups` state ~354, set ~676, remaining props)
- Modify: `src/components/SessionList.tsx` (drop the `modelGroups` prop ~103/216 left over from Task 2)
- Modify: `src/components/ProfilesSettingsTab.tsx` (group editor section ~912+, `rewriteGroupSlots` ~45-60, group state ~308/356, handlers ~493-557, group DnD ~459-460/530/533; KEEP model-list editor + recap/commit fields; update aux help copy ~857/887)
- Modify: `src/hooks/useProfileListDnd.ts` (drop `modelGroups`/`setModelGroups` params + group drag logic), `src/dnd/payload.ts` (`profile-model-group` kind ~35-38/48; KEEP `profile-model`)
- Modify: `src/styles/utilities.css` (`.settings-model-group*` classes only — keep session-group styles)
- Test: `src/state/modelOptionsStore.test.ts`, `src/hooks/useModelOptions.test.ts`, `src/hooks/useProfileListDnd.test.ts`, `src/dnd/payload.test.ts`, `src/components/ProfilesSettingsTab.test.tsx`, `src/components/ProfileCreateDialog.test.tsx`, `src/components/ProfileSwitcher.test.tsx`, `src/components/SessionProfileSelect.test.tsx`, `src/components/FloatingSurfacePolicy.test.tsx`, `src/types/global-prefs.test.ts`, `src/App.default-session.test.tsx`, `src/components/ModelPicker.height.test.tsx` — drop group fixtures/cases

**Interfaces:**
- Consumes: Task 6 (server already ignores `modelGroups` on POST).
- Produces: client `ProviderProfile` / `ConfigResponse` / `ModelOptionsSnapshot` have no `modelGroups`; `useModelOptions` returns `{ models, recents, defaultModel }`; dnd payload has no `profile-model-group`.

- [ ] **Step 1: Write the failing test** — `modelOptionsStore` snapshot has no groups; `ProfilesSettingsTab` renders no model-group editor (query by the group section heading absent) while the model-list editor remains.

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/state/modelOptionsStore.test.ts src/components/ProfilesSettingsTab.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement removal** — delete the client type/field/store/hook/settings-editor/dnd kind; drop `modelGroups` from all client fixtures (grep `modelGroups` under `src/`).

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/`. Expected: PASS. `npm run typecheck` green.

- [ ] **Step 5: Commit** — `git commit -am "refactor: remove client model-group config and profile UI"`

### Task 8: Relocate `resolveConfiguredModelId`, delete the group module

**Files:**
- Rename: `server/model-groups.ts` → `server/model-resolution.ts` (keep ONLY `resolveConfiguredModelId`; delete `ResolvedGroup`, `resolveGroup`, `isOpaqueModel`, `capabilitiesForTier`, `auxFallbackModel`, `fallbackAliasesFor`)
- Rename/split: `server/model-groups.test.ts` → `server/model-resolution.test.ts` (keep `resolveConfiguredModelId` cases ~101-108; delete the rest)
- Modify: `server/session-manager.ts:81` and `server/providers/claude/claude-provider.ts:24-28` imports → `./model-resolution.js` / `../../model-resolution.js`, importing only `resolveConfiguredModelId`
- Test: grep gate — no remaining references to `model-groups`, `resolveGroup`, `fallbackAliasesFor`, `auxFallbackModel`, `capabilitiesForTier`, `isOpaqueModel`, `ModelGroupConfig`, `modelGroups`, `modelGroupId` in `server/`, `src/`, `shared/` (docs excluded)

**Interfaces:**
- Consumes: Tasks 1-7 (no group-function consumers remain).
- Produces: `server/model-resolution.ts` exporting `resolveConfiguredModelId(model: string | undefined, modelList: readonly string[]): string | undefined`. The manager's private `resolveConfiguredModel` (~349) and the provider's private wrapper (~295) are LEFT AS-IS (deduping them is out of scope).

- [ ] **Step 1: Write the failing test** — `server/model-resolution.test.ts` keeps the existing `resolveConfiguredModelId` assertions (bare→full, prefixed unchanged, no-match unchanged, undefined→undefined).

- [ ] **Step 2: Run to verify fail** — `npx vitest run server/model-resolution.test.ts`. Expected: FAIL (file/module not yet renamed).

- [ ] **Step 3: Implement** — rename the module, slim it, update the two importers, delete the group test cases.

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/model-resolution.test.ts`. Expected: PASS. `npm run typecheck` green. Run the grep gate: `rg -n "model-groups|resolveGroup|fallbackAliasesFor|auxFallbackModel|capabilitiesForTier|isOpaqueModel|ModelGroupConfig|modelGroups|modelGroupId" server src shared` → no matches.

- [ ] **Step 5: Commit** — `git commit -am "refactor: relocate resolveConfiguredModelId, delete model-groups module"`

---

## Phase 3 — Docs

### Task 9: Decision note, changelog, superseded banners

**Files:**
- Create: `.agents/notes/implemented/simplification/2026-11-25-remove-model-groups.md`
- Modify: `CHANGELOG.md` (removed-feature entry)
- Modify: `AGENTS.md` / `CLAUDE.md` (remove model-group mentions; keep tier-env description in its no-group form)
- Modify: `docs/superpowers/specs/2026-08-27-model-groups-tier-routing-design.md` + `docs/superpowers/plans/2026-08-27-model-groups-tier-routing.md` (superseded banner pointing to the note). Leave historical `docs/superpowers/sdd/*.diff` and other plans' incidental mentions untouched.

**Interfaces:** none (documentation).

- [ ] **Step 1: Write the note** — record: the verified defect (native create runs modelList[0] while group-tagged; live `setModelGroup`/`setModel(wasGroup)` 502 half-applied because native rejects `fallbackModel`), the root cause (group protocol leaks across the provider seam: no capability, duplicated resolution, non-atomic switch), the decision (delete the feature; user confirmed it is unused going forward), what was kept (no-group tier collapse, `mergeTierEnvIntoSettings`, `resolveConfiguredModelId`, aux override path), and the drop-on-read migration for legacy `modelGroupId`/`modelGroups`. Link the verification evidence and this plan.

- [ ] **Step 2: Verify structure** — `npm run verify:agent-notes`. Expected: PASS.

- [ ] **Step 3: Update changelog + AGENTS/CLAUDE + banners.**

- [ ] **Step 4: Full verification** — `npm run typecheck && npm run test && npm run lint && npm run verify:agent-notes`. Expected: all green.

- [ ] **Step 5: Commit** — `git commit -am "docs: record model-group removal decision"`

---

## Final whole-branch review

After Task 9, run the `code-review` skill on the full branch diff (`git diff main...HEAD`) before merging. Confirm the keep-list survived (tier env, `mergeTierEnvIntoSettings`, `resolveConfiguredModelId`, aux overrides, session-group sidebar) and the grep gate is clean.