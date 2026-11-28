# Native default flip + auth-aware selection (Block 3) — design

Date: 2026-11-27
Status: proposed

## Problem

The native provider is now capable (G1 plan mode, G2 structured output, G3 slash surface) and the UI gates locked features honestly (B1). The default provider is still `claude` (`session-manager.ts:1311` `opts.defaultProvider ?? 'claude'`, never passed by the host; `NewSessionDialog.tsx:85` hardcodes `useState('claude')`). This block flips the default to native, auth-aware, so the capable provider is the front door — while users without an API token keep the CLI.

It also resolves the `enabledPlugins` wart flagged before this block: B1 locked the create-dialog plugin picker for native (`supportsPlugins:false`), yet native consumes `enabledPlugins` for selective plugin-skill discovery, so a carried claude-era selection silently narrowed native discovery with no way to adjust it.

## Goals

- **G1 — Auth-aware default.** The effective default provider is `native` when an API token is configured (`!!serverConfig.authToken`), else `claude`. Computed dynamically so adding a token via setup flips the new-session default without a restart.
- **G2 — Client preselect.** The effective default is exposed to the client (`GET /config`); `NewSessionDialog` preselects it instead of hardcoded `'claude'`. The user can still switch the provider selector.
- **G3 — Zero migration.** Existing sessions keep `meta.provider` (the fallback chain already does this); the flip affects new creates (ALL paths), resume-picker ordering, and default-provider consumers (`runStructured` follows the effective default — user-decided).
- **G4 — Functional native plugin-skill picker.** The create-dialog plugin picker is FUNCTIONAL for native (selective plugin-skill loading): `enabledPlugins` carries the user's intentional selection. Distinguish "plugin skills" (selectable on native) from "plugins as agent extensions" (the settings plugins tab, still locked on native).

## Non-goals and anti-goals

- **Not the CLI-optional packaging** (separate block; CLI remains a hard dependency for now). The auth-aware `claude` fallback assumes the CLI is installed.
- **Not a config override** (user-decided: auth-aware only; no `defaultProvider` config field). The user can still pick a provider per-session in the dialog.
- **Not implementing plugin agent-extensions on native** — `supportsPlugins` stays false; the settings plugins tab stays locked. Only plugin-SKILL selection becomes functional.
- **Not migrating existing sessions** — `meta.provider` is authoritative for them.
- **Anti-goal: a static boot-time default that goes stale after setup.** The effective default must reflect current auth.
- **Anti-goal: re-locking the native picker.** G4 makes it functional; this supersedes B1's picker lock (the settings plugins tab lock is unchanged).

## Constraints

- Reuse `serverConfig.authToken` / `resolveActiveProfile` as the auth source; `configured: !!serverConfig.authToken` already exists (`config-routes.ts:158`).
- Reuse the B1 capability→SessionInfo→UI projection + the pre-create `providerSupports` map (extend, don't replace).
- `ProviderCapabilities` stays the single source; the pre-create map agreement pin must cover any new flag.
- The claude provider behavior + SDK contract unchanged; claude sessions/default unaffected when no token.
- Theme vars only for any UI change.
- Existing `meta.provider ?? defaultProvider` fallback chain stays (zero migration).

## Decided approach

### Auth-aware effective default (server)
The effective default = `serverConfig.authToken ? 'native' : 'claude'`, read dynamically (current config, not a boot snapshot). The host passes it to `SessionManager` (or the manager reads it via a getter) so `defaultProvider` reflects current auth. The `registry.get` default and the resume-picker rank (`session-manager.ts:2552`) follow the effective default. Builder settles the dynamic mechanism (a getter reading current config vs recomputing on config change) — it must not go stale after the setup wizard writes a token.

### Client preselect + ALL create paths
Add the effective default provider to `GET /config` (e.g. `defaultProvider`). `NewSessionDialog` initializes its `provider` state from it (fetch on mount) instead of `useState('claude')`. The provider selector still lets the user switch. Legacy/missing field defaults claude-compatible.

The flip covers EVERY create path, not just the dialog (controller ruling — G1's intent demands it): `App.tsx:2141` `handleCreateDefaultSession` hardcodes `provider:'claude'` and feeds the sidebar quick-create "+" AND the post-setup auto-create (`handleConfigured` ~4995). The post-setup auto-create is the exact moment the default should become native. These non-dialog paths OMIT `provider` so the server's effective default governs (or read `defaultProvider` from the config fetch). `handleCreate` (~1998) POSTs whatever the form carries; the dialog still sends its explicit selection.

### Functional native plugin-skill picker (G4)
- Add a capability `supportsPluginSkills` (native `true`, claude `true`) distinct from `supportsPlugins` (native `false`, claude `true`). Project `pluginSkillsSupported` to SessionInfo + add a `pluginSkills` feature to the pre-create `providerSupports` map (agreement pin covers it).
- The create-dialog plugin picker gates on `pluginSkillsSupported` (functional for BOTH providers) instead of `pluginsSupported`. For native it selects which plugin skills to discover (`enabledPlugins` subset); for claude it selects full plugins (unchanged semantics).
- The settings plugins tab keeps gating on `pluginsSupported` (native locked, unchanged from B1).
- `enabledPlugins` carries the user's intentional selection for native; the narrowing is now a FEATURE (user chose), not a silent carry-over. Add a submit-payload pin for both provider-switch directions.
- This supersedes B1's create-dialog picker lock; record the supersession in the owning note (B1's settings-tab lock stands).

### Structured runs follow the default (user-decided)
`SessionManager.runStructured` (`session-manager.ts:7488`, serving session-agnostic `POST /api/structured`) resolves `providers.get(defaultProvider)`; a dynamic effective default flips it to native when a token is configured. This is consistent with the flip (no special-casing). It activates the G2 follow-ups that were parked for Block 3:
- `StructuredPanel` must OMIT `maxBudgetUsd` when the effective provider is native (native `runStructured` 501s on it). The panel reads the effective default (from the config fetch) and drops the budget field for native.
- Native's lean one-shot tool set + headless `auto` fail-closed are native's documented behavior (G2 note); acceptable, no change.
- The structured route's `permissionMode` set already excludes `plan`; native handles the rest.

## Left to builder

- The dynamic effective-default mechanism (getter vs config-change recompute) and where the host wires it.
- The `GET /config` field name + the dialog fetch/preselect wiring (loading state before the fetch resolves).
- The non-dialog create paths (`App.tsx` `handleCreateDefaultSession` quick-create + post-setup auto-create) omitting `provider` so the server default governs.
- `StructuredPanel` omitting `maxBudgetUsd` when the effective provider is native (reads the effective default).
- `supportsPluginSkills` flag + projection + pre-create map row + agreement-pin entry.
- The picker gate change (pluginsSupported → pluginSkillsSupported) + any label nuance ("Plugins" vs "Plugin skills" per provider — optional polish).
- The submit-payload pin (native carries intentional selection; claude unchanged; switch directions).
- Tests: auth-aware default (token→native, no-token→claude, dynamic after setup); client preselect; zero-migration (existing meta.provider); functional native picker + payload pin; claude no-regression.
- Owning agent note (record the B1 picker-lock supersession).