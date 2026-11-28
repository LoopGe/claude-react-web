# Native Default Flip + Auth-Aware Selection (Block 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the default provider to native, auth-aware (native when an API token is configured, else claude), across ALL create paths and default-provider consumers; make the native create-dialog plugin picker functional (selective plugin-skill loading); zero migration of existing sessions.

**Architecture:** A dynamic effective-default function reads current config auth (`serverConfig.authToken ? 'native' : 'claude'`); `SessionManager.defaultProvider` reflects it (live, not boot-static), so creates/resume-picker/runStructured follow. `GET /config` exposes it; the dialog preselects it and the non-dialog create paths omit `provider`. A new `supportsPluginSkills` capability (native true) gates the create-dialog picker (functional for both providers), distinct from `supportsPlugins` (settings tab, native locked). `StructuredPanel` omits `maxBudgetUsd` for native.

**Tech Stack:** TypeScript, React 19, Hono server, vitest (server Node + client happy-dom), theme CSS variables.

**Spec:** `docs/superpowers/specs/2026-11-27-native-default-flip-design.md`

## Global Constraints

- Auth source: `serverConfig.authToken` / `resolveActiveProfile`; `configured: !!serverConfig.authToken` exists (`config-routes.ts:158`). The effective default must be DYNAMIC (reflect setup/profile changes; `config` is a reassigned export, testable via `__setConfigForTest`).
- Reuse the B1 capability→SessionInfo→UI projection (`projectSharedSessionFields`) + pre-create `providerSupports` map; EXTEND, don't replace. `ProviderCapabilities` single source; the agreement pin covers any new flag.
- `meta.provider ?? defaultProvider` fallback chain stays (zero migration; `persistence.ts:252` coerces missing provider to claude on load).
- claude provider behavior + SDK contract unchanged; claude is the default when no token.
- An explicit `opts.defaultProvider` override (tests) still wins over the auth-aware default.
- Theme vars only for UI changes.
- Implementation isolates in a worktree branched from current `main`.
- Verify: `npm run typecheck`, `npx vitest run <path>`, `npm run lint`.

## Review Focus

- **Auth-aware rule.** Token configured → effective default native; no token → claude.
- **Dynamic after setup.** Adding a token (config change) flips the effective default without restart; the post-setup auto-create becomes native.
- **All create paths follow.** Quick-create "+" (`App.tsx:2140`), post-setup auto-create (`handleConfigured`), and the dialog all use the effective default (non-dialog paths omit `provider`).
- **Zero migration.** An existing session with `meta.provider:'claude'` stays claude after the flip.
- **Functional native picker.** Native create-dialog picker is usable (selective plugin-skill loading); `enabledPlugins` carries the intentional selection; payload pinned for both provider-switch directions. Settings plugins tab STILL locked on native.
- **Structured follows + budget omit.** `runStructured` uses the effective default; `StructuredPanel` omits `maxBudgetUsd` for native (no 501).
- **Claude no-regression.** No-token claude default + claude sessions behave exactly as before.

---

### Task 1: Auth-aware dynamic effective default (server)

**Files:**
- Modify: `server/config.ts` (effective-default helper) or `server/session-manager.ts`
- Modify: `server/session-manager.ts` (`defaultProvider` ~1124/1311; `runStructured` ~7488; rank ~2552)
- Modify: `server/bootstrap.ts` (wire if needed)
- Test: `server/session-manager.test.ts`

**Interfaces:**
- Produces: an effective-default source `native` when `serverConfig.authToken` truthy else `claude`, read DYNAMICALLY. `SessionManager.defaultProvider` reflects it (a getter over live config, or recompute) while an explicit `opts.defaultProvider` override still wins. `runStructured` (`providers.get(defaultProvider)`) and the resume-picker rank follow it.

- [ ] **Step 1: Write the failing tests**

```ts
// session-manager.test.ts — use __setConfigForTest to vary auth
it('effective default is native when a token is configured, claude when not', () => {
  __setConfigForTest({ authToken: 'tok' }); expect(smDefaultProvider()).toBe('native')
  __setConfigForTest({ authToken: '' }); expect(smDefaultProvider()).toBe('claude')
})
it('effective default is dynamic (reflects config change without restart)', () => {
  __setConfigForTest({ authToken: '' }); const sm = makeManager()
  __setConfigForTest({ authToken: 'tok' }); expect(smDefaultProvider(sm)).toBe('native')
})
it('explicit opts.defaultProvider override wins', () => {
  __setConfigForTest({ authToken: 'tok' }); const sm = makeManager({ defaultProvider: 'claude' })
  expect(smDefaultProvider(sm)).toBe('claude')
})
it('runStructured follows the effective default', async () => { /* token → native provider.runStructured called */ })
```

Adapt to the fixture helpers (`smDefaultProvider` reads the manager's effective default; read how existing tests construct the manager + set config).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/session-manager.test.ts -t "effective default"`
Expected: FAIL — default static claude.

- [ ] **Step 3: Implement the dynamic effective default**

Add an effective-default helper reading current `serverConfig.authToken` (native if truthy else claude). Make `SessionManager.defaultProvider` reflect it dynamically (getter over live config) while honoring an explicit `opts.defaultProvider` override. `runStructured` + rank already read `this.defaultProvider`, so they follow. Builder settles getter-vs-recompute; it must reflect `__setConfigForTest`/setup changes live.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS (no regression).

- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/session-manager.ts server/bootstrap.ts server/session-manager.test.ts
git commit -m "feat(native): auth-aware dynamic effective default provider"
```

---

### Task 2: supportsPluginSkills capability + projection + pre-create map

**Files:**
- Modify: `server/providers/types.ts`, `server/providers/native/native-provider.ts`, `server/providers/claude/claude-provider.ts`
- Modify: `shared/session-info.ts`, `server/session-manager.ts` (projection)
- Modify: `shared/provider-capabilities.ts` (+ `LOCKED_FEATURES`/feature union), `server/providers/provider-capabilities-pin.test.ts`
- Test: `server/session-manager.test.ts`, `shared/provider-capabilities.test.ts`

**Interfaces:**
- Produces: `ProviderCapabilities.supportsPluginSkills` (native `true`, claude `true`) distinct from `supportsPlugins` (native `false`). `SessionInfo.pluginSkillsSupported?` projected from capsOf. Pre-create `providerSupports(provider, 'pluginSkills')` (native true, claude true) + agreement-pin entry.

- [ ] **Step 1: Write the failing tests**

```ts
it('projects pluginSkillsSupported true for both providers (live + dormant)', () => { /* native & claude both true */ })
it('providerSupports pluginSkills is true for native and claude', () => {
  expect(providerSupports('native', 'pluginSkills')).toBe(true)
  expect(providerSupports('claude', 'pluginSkills')).toBe(true)
})
// agreement pin extends to pluginSkills (real literals)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/provider-capabilities.test.ts server/session-manager.test.ts -t "pluginSkills"`
Expected: FAIL — flag/feature absent.

- [ ] **Step 3: Implement the capability + projection + map**

Add `supportsPluginSkills` to ProviderCapabilities (native true, claude true). Project `pluginSkillsSupported` in projectSharedSessionFields (live + dormant). Add `pluginSkills` to the pre-create feature union + map (both true) + the agreement pin's FLAG roster. Keep `supportsPlugins` unchanged (native false).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/provider-capabilities.test.ts server/providers/provider-capabilities-pin.test.ts server/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/types.ts server/providers/native/native-provider.ts server/providers/claude/claude-provider.ts shared/session-info.ts server/session-manager.ts shared/provider-capabilities.ts server/providers/provider-capabilities-pin.test.ts shared/provider-capabilities.test.ts server/session-manager.test.ts
git commit -m "feat(native): supportsPluginSkills capability + projection + pre-create map"
```

---

### Task 3: GET /config defaultProvider + client preselect + all create paths

**Files:**
- Modify: `server/routes/config-routes.ts` (GET /config)
- Modify: `src/components/session-list/NewSessionDialog.tsx` (provider useState ~85)
- Modify: `src/App.tsx` (handleCreateDefaultSession ~2140; handleConfigured ~4995)
- Test: `src/components/session-list/NewSessionDialog.test.tsx`, `src/App.default-session.test.tsx`

**Interfaces:**
- Consumes: Task 1 effective default.
- Produces: `GET /config` returns `defaultProvider` (the effective default). `NewSessionDialog` initializes `provider` from it (fetch on mount; legacy/missing → claude). `App.tsx` non-dialog create paths OMIT `provider` so the server default governs.

- [ ] **Step 1: Write the failing tests**

```tsx
it('GET /config returns the effective defaultProvider', async () => { /* token → native */ })
it('NewSessionDialog preselects the effective default (native when configured)', () => { /* config defaultProvider native → provider state native */ })
it('quick-create omits provider so the server default governs', () => { /* handleCreateDefaultSession POST has no provider field */ })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/session-list/NewSessionDialog.test.tsx src/App.default-session.test.tsx -t "default"`
Expected: FAIL.

- [ ] **Step 3: Implement config field + preselect + create paths**

Add `defaultProvider` to GET /config (effective default). NewSessionDialog fetches it and initializes `provider` state (loading state before resolve; legacy/missing → claude). App.tsx `handleCreateDefaultSession` removes `provider:'claude'` (omit → server default); verify `handleConfigured` post-setup auto-create flows through it. `handleCreate` still POSTs the form's explicit provider for the dialog.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/session-list/NewSessionDialog.test.tsx src/App.default-session.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/config-routes.ts src/components/session-list/NewSessionDialog.tsx src/App.tsx src/components/session-list/NewSessionDialog.test.tsx src/App.default-session.test.tsx
git commit -m "feat(native): expose effective default + preselect dialog + all create paths follow"
```

---

### Task 4: Functional native plugin-skill picker + payload pin

**Files:**
- Modify: `src/components/session-list/NewSessionDialog.tsx` (pluginsLocked gate ~89, picker ~1037, submit ~520)
- Test: `src/components/session-list/NewSessionDialog.test.tsx`

**Interfaces:**
- Consumes: Task 2 `providerSupports(provider, 'pluginSkills')` / `pluginSkillsSupported`.
- Produces: the create-dialog picker gates on `pluginSkills` (FUNCTIONAL for both providers) instead of `plugins`. Native selects plugin skills (enabledPlugins subset); claude selects full plugins (unchanged). enabledPlugins carries the intentional selection; submit-payload pinned for both switch directions. Settings plugins tab unchanged (still pluginsSupported, native locked).

- [ ] **Step 1: Write the failing tests**

```tsx
it('native picker is functional (checkboxes enabled, no requires-CLI notice)', () => { /* provider native → picker enabled */ })
it('native create carries the intentional enabledPlugins selection', () => { /* uncheck plugin X under native → submit enabledPlugins excludes X */ })
it('claude-unchecked then switch to native carries the subset (intentional, pinned)', () => { /* payload pin both directions */ })
it('settings plugins tab still locked on native (unchanged)', () => { /* SettingsPanel pluginsSupported false → locked */ })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/session-list/NewSessionDialog.test.tsx -t "picker"`
Expected: FAIL — native picker locked.

- [ ] **Step 3: Implement the functional picker + pin**

Change the picker gate from `!providerSupports(provider,'plugins')` to `!providerSupports(provider,'pluginSkills')` (functional both). Remove the requires-CLI notice from the picker (it's functional now). enabledPlugins carries the selection for native (the narrowing is intentional). Add submit-payload pins for both provider-switch directions. Do NOT change the settings plugins tab gate.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/session-list/NewSessionDialog.test.tsx src/components/SettingsPanel.test.tsx`
Expected: PASS (settings tab still locked native).

- [ ] **Step 5: Commit**

```bash
git add src/components/session-list/NewSessionDialog.tsx src/components/session-list/NewSessionDialog.test.tsx
git commit -m "feat(native): functional native plugin-skill picker + submit payload pins"
```

---

### Task 5: StructuredPanel omits maxBudgetUsd for native

**Files:**
- Modify: `src/components/StructuredPanel.tsx` (maxBudgetUsd ~58/133/211)
- Test: `src/components/StructuredPanel.test.tsx`

**Interfaces:**
- Consumes: Task 3 effective default (GET /config defaultProvider).
- Produces: StructuredPanel reads the effective default; when native, the maxBudgetUsd field is hidden/disabled AND omitted from the request (native runStructured 501s on it). Claude unchanged.

- [ ] **Step 1: Write the failing test**

```tsx
it('native effective default: budget field hidden and omitted from request', () => { /* defaultProvider native → no maxBudgetUsd in req */ })
it('claude effective default: budget field present and sent', () => { /* unchanged */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/StructuredPanel.test.tsx -t "budget"`
Expected: FAIL.

- [ ] **Step 3: Implement the budget omit**

Read the effective default (config fetch). When native, hide/disable the maxBudgetUsd input and skip `req.maxBudgetUsd` (the ~133 block). Claude unchanged.

- [ ] **Step 4: Run test to verify it passes + final verification**

Run: `npx vitest run src/components/StructuredPanel.test.tsx` then `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/StructuredPanel.tsx src/components/StructuredPanel.test.tsx
git commit -m "feat(native): StructuredPanel omits maxBudgetUsd for native default"
```

---

### Task 6: Owning agent note

**Files:**
- Create: `.agents/notes/implemented/feature/2026-11-27-native-default-flip.md`

**Interfaces:**
- Consumes: the decisions above; `.agents/notes/README.md` contract.
- Produces: a decision record capturing the auth-aware dynamic default, all-create-paths flip, zero migration, supportsPluginSkills vs supportsPlugins distinction (functional picker supersedes B1's picker lock; settings tab lock stands), structured-follows + budget omit. Cross-link the B1 gating note (picker-lock supersession) + G2 structured note (budget follow-up activated).

- [ ] **Step 1: Write the note** per the README contract (Problem → Decision → Alternatives considered → Consequences; Status: implemented; relative links).

- [ ] **Step 2: Verify structure**

Run: `npm run verify:agent-notes`
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add .agents/notes/implemented/feature/2026-11-27-native-default-flip.md
git commit -m "docs(native): owning agent note for native default flip"
```

---

## Self-Review

**Spec coverage:** G1 auth-aware dynamic default (Task 1); G2 client preselect + all create paths (Task 3); G3 zero migration (Task 1 fallback chain + test); G4 functional native picker (Tasks 2/4); structured-follows + budget omit (Tasks 1/5); agent note (Task 6). Non-goals respected (no packaging, no plugin agent-extensions, no migration, no config override).

**Review Focus coverage:** auth-aware rule (Task 1), dynamic after setup (Task 1/3), all create paths (Task 3), zero migration (Task 1), functional native picker + payload pin (Task 4), settings tab still locked (Task 4), structured follows + budget omit (Task 1/5), claude no-regression (Tasks 1/3/4/5).

**Type consistency:** `supportsPluginSkills`/`pluginSkillsSupported`/`providerSupports(...,'pluginSkills')`/effective `defaultProvider` consistent across tasks; `supportsPlugins` unchanged.

**Proportion:** code blocks are test assertions + signatures; wiring bodies left to the implementer with named decisions.