# Agent Note: Auth-aware native default flip

Status: implemented

## Problem

The default provider was static `claude` at every layer: `SessionManager`
assigned `opts.defaultProvider ?? 'claude'` (the host never passes an override),
`NewSessionDialog` hardcoded `useState('claude')`, and `App.tsx`'s
`handleCreateDefaultSession` hardcoded `provider: 'claude'` for the sidebar
quick-create and the post-setup auto-create. The native provider is now capable
(plan mode, structured output, slash surface) and the
[native capability gating projection](2026-11-26-native-gating-projection.md)
(Block 1) gates its locked features honestly — so the capable provider can be
the front door for users with an API token, while tokenless users keep the CLI.
A boot-static default would not do: the post-setup auto-create fires at the
exact moment a token lands, and must already see the new default.

The flip also resolves the `enabledPlugins` wart B1 disclosed: B1 locked the
create-dialog plugin picker for native (`supportsPlugins: false`), yet native
consumes `enabledPlugins` for selective plugin-skill discovery — a selection
carried over from a claude draft silently narrowed native discovery with no
way to adjust it.

The full contract lives in the
[native default flip design](../../../../docs/superpowers/specs/2026-11-27-native-default-flip-design.md)
(Block 3); the
[implementation plan](../../../../docs/superpowers/plans/2026-11-27-native-default-flip.md)
records the task breakdown. This note records the decisions and what they beat.

## Decision

### Auth-aware effective default, read live

`effectiveDefaultProvider()` (`server/config.ts`) returns
`config.authToken ? 'native' : 'claude'`, reading the module-level `config`
export at CALL time. That export is a reassigned binding — production setup
and config writes rebuild it through `applyParsedConfig`, tests through
`__setConfigForTest` — so the default flips without a restart. It is the same
auth fact `GET /config` reports as `configured`.

`SessionManager.defaultProvider` is a getter:
`defaultProviderOverride ?? effectiveDefaultProvider()`. The constructor stores
`opts.defaultProvider` as the override (tests / embedded hosts), which wins by
construction order. Every consumer reads this one member and follows
automatically: the create fallback (`opts.provider ?? …`), every
`meta.provider ?? …` fallback, `runStructured`, and the disk-adoption rank that
orders the resume picker. The getter replaced the static field in place — no
read site changed, and there is no invalidation machinery to keep in sync.

`GET /config` (composed in `server/app.ts`) exposes the effective default as
`defaultProvider`, read live per request. It deliberately does NOT honor a
manager-level override: the production host never passes one, and the route
reports the server's auth-aware fact.

### All create paths follow

- **NewSessionDialog** preselects the effective default through the shared
  `modelOptionsStore` (`peekConfig` / `fetchConfig`) — the same store App's
  mount fetch uses, so there is no second fetcher and in-flight requests are
  deduped. A warm cache (the normal case: App fetches `/config` on mount) seeds
  the provider synchronously with no loading gate. A cold cache resolves
  through the store fetch, and Create stays disabled (button + `submit()`
  guard) until it lands, so a quick click cannot submit the placeholder. A
  manual pick while the fetch is in flight wins over the late-landing default
  (`providerTouchedRef`); the provider picker stays interactive throughout.
  Legacy/missing field and fetch failure both fall back to `claude`. The dialog
  still ALWAYS sends its explicit `provider` in the submit payload — preselect
  only initializes the state.
- **App.tsx `handleCreateDefaultSession`** omits `provider` entirely, so the
  server's effective default governs. This one shared path feeds the sidebar
  quick-create "+" AND the post-setup auto-create (`handleConfigured`) — the
  exact moment the default should become native.

### Zero migration

Existing sessions keep `meta.provider`. Every `meta.provider ?? this.defaultProvider`
fallback site is byte-identical (the getter replaced the field in place), and
the persistence load-coercion (a missing stored provider coerces to `claude`)
is untouched. Only provider-less fallbacks see the new default; a stored
`claude` session stays claude after the flip.

### Plugin skills are not plugin agent extensions

A new capability `supportsPluginSkills` (native `true`, claude `true`) is
distinct from `supportsPlugins` (native `false`, claude `true`): native has no
plugin agent-extension runtime but DOES consume `enabledPlugins` to narrow its
plugin-skill catalog. `projectSharedSessionFields` projects
`SessionInfo.pluginSkillsSupported` from `capsOf(provider)` at the single B1
site (live and dormant, three-state like the other capability booleans, never
persisted). The pre-create `providerSupports` map gains a `pluginSkills` row,
and the agreement pin covers it (12 cases against the real provider literals).

The pre-create roster renamed `LOCKED_FEATURES` → `GATED_FEATURES`: it is the
set of features `providerSupports` covers, not an all-locked list —
`pluginSkills` is locked on neither provider.

The create-dialog plugin picker gates on `pluginSkills`, so it is FUNCTIONAL
for both providers:

- **Native** selects which plugin skills to discover — `enabledPlugins`
  undefined = all, `[]` = none, a subset = membership. The narrowing is now an
  intentional user choice, not a silent carry-over.
- **Claude** selects full plugins, unchanged.

The `RequiresCliNotice` is gone from the picker; the submit sentinel
(all-selected → undefined, else the subset array) is provider-agnostic and
unchanged, with the payload pinned for both provider-switch directions. This
SUPERSEDES the create-dialog picker lock of the
[native capability gating projection](2026-11-26-native-gating-projection.md)
and resolves its open `enabledPlugins` submit-path follow-up. The settings
plugins tab lock (`pluginsSupported`) STANDS — native plugin agent extensions
remain unimplemented.

### Structured runs follow the default; the panel omits the budget

`SessionManager.runStructured` resolves `providers.get(this.defaultProvider)`,
so the session-agnostic structured route rides native when a token is
configured (user-decided: consistent with the flip, no special-casing). This
activates the live-panel routing deferred by the
[native structured output](2026-11-26-native-structured-output.md) note (G2).

`StructuredPanel` has no provider picker, so it reads the effective default
through the same shared store (warm seed + cold fetch; legacy/missing field
and fetch failure → claude). For native, the Budget (USD) field is hidden AND
`maxBudgetUsd` is omitted from the request by a submit guard — native
`runStructured` rejects a budget with 501 (no USD cost model), so the panel
must not send one. Both layers are load-bearing: a budget typed before a cold
native resolve must still be omitted after the field hides. Claude is
unchanged (field present, budget sent). Native's lean one-shot tool set and
headless `auto` fail-closed remain as G2 documented them.

## Alternatives considered

- **A static boot-time default.** Rejected (spec anti-goal): it goes stale the
  moment the setup wizard writes a token — the post-setup auto-create would
  still spawn claude. The effective default must reflect current auth.
- **A `defaultProvider` config override field.** Rejected (user-decided):
  auth-aware only. The per-session choice stays in the dialog's provider
  selector; a config field would add a third default source.
- **Recompute-on-config-change instead of a getter.** Rejected: it needs
  invalidation machinery wired to every config write. The getter is a drop-in
  for the field, reads live by construction, and leaves every read site
  unchanged.
- **Migrating existing sessions to native.** Rejected (spec non-goal):
  `meta.provider` is authoritative for existing sessions; the fallback chain
  and load-coercion already give zero migration for free.
- **Keeping B1's native picker lock.** Rejected: native consumes
  `enabledPlugins` for discovery, so the lock left a silent narrowing with no
  adjustment path. The functional picker makes the selection intentional; the
  supersession is recorded above and in B1's note.
- **Special-casing `runStructured` to stay claude, or a panel provider
  picker.** Rejected (user-decided in G2): the panel follows the default
  provider. A provider-selection mechanism for one panel would be a fourth
  extension surface; the flip is the routing event.
- **Hiding the budget field without the submit guard.** Rejected: the cold-race
  test proves the gap — a budget typed while the config fetch is pending would
  still send after the native resolve hides the field, hitting the 501. The
  guard is the authoritative omission; the hiding is display.
- **A dedicated dialog config fetch.** Rejected: the shared `modelOptionsStore`
  already dedupes in-flight requests and fences staleness across consumers; a
  second fetcher would race App's mount fetch and duplicate that machinery.

## Consequences

Native is the front door when an API token is configured; tokenless users keep
claude at every layer exactly as before. One live source owns the default, so
setup flips it without a restart — including the post-setup auto-create. The
picker narrowing is intentional and payload-pinned, closing B1's
`enabledPlugins` wart, and the structured panel rides native without a budget
501.

What it costs / discloses:

- **`GET /config` reports the auth-aware default, not a manager override.** The
  production host never passes an override; an embedded host that does would
  see the route and the manager disagree.
- **`pluginPickerLocked` is effectively always false today** (both known
  providers support plugin skills; unknown providers default claude-compatible).
  The gate stays as the capability seam a future plugin-skill-less provider
  would lock through — not a hardcoded provider check. No notice renders if it
  ever locks; that would be a future product decision.
- **The client preselect is only as fresh as the config cache** — see Deferred.
- **Native's headless structured behavior is unchanged** (lean tool set,
  fail-closed `auto`): acceptable per G2, not a parity regression of this flip.

## Deferred

- **Warm-cache staleness (dialog preselect).** The dialog trusts the last
  fetched default; a token configured outside the tab's refresh paths
  preselects claude until the cache invalidates. Mitigated by App's
  force-refresh (`handleConfigured` / the fresh defaults read) and the store's
  `onProfilesChanged` invalidation; a manual pick always wins.
- **StructuredPanel mount-seed staleness.** The panel seeds its provider on
  mount; an effective-default flip mid-open shows/sends the budget until
  reopen. The failure is a visible 501, not silent, and the window is narrow
  (inherent to the mount-seed idiom shared with the dialog).
- **Loose `defaultProvider?: string`** on `ConfigResponse` (matches the
  client's loose `provider?: string` convention); cold-load Create is disabled
  with no spinner (the disabled state IS the loading signal — a visible
  "Loading…" label is optional polish).
- **Cosmetic comment/test nits** — a few comments still use the retired
  "locked-feature" vocabulary for the five CLI features (accurate for them,
  but the roster is now `GATED_FEATURES`); `StructuredPanel.test.tsx` lacks a
  trailing newline; minor test-fixture helper nits from the per-task reviews.

## Testing

`server/session-manager.test.ts` (auth-aware describe) pins token → native /
no-token → claude, the dynamic flip on one manager instance, the explicit
override winning both directions, `runStructured` following the default, and
the adoption rank following it. `server/routes/config-routes.test.ts` pins
`GET /config` reporting the live default across config changes on one app
instance. `NewSessionDialog.test.tsx` pins the preselect (warm synchronous
seed, cold Create gate, manual-pick-wins, failure/legacy → claude), the
functional native picker, the undefined/`[]`/subset sentinels, and the submit
payload in both provider-switch directions. `App.default-session.test.tsx`
pins quick-create and post-setup auto-create omitting `provider`.
`StructuredPanel.test.tsx` pins native hidden-and-omitted, claude
present-and-sent, and the cold-race discriminator (guard independent of
hiding). `shared/provider-capabilities.test.ts` +
`server/providers/provider-capabilities-pin.test.ts` pin the six-feature
roster and the 12-case agreement with the real literals;
`server/session-manager.test.ts` pins the `pluginSkillsSupported` projection
live and dormant. `SettingsPanel.test.tsx`'s existing native-lock pins guard
the settings plugins tab (untouched).

## Related

- [Native capability gating projection](2026-11-26-native-gating-projection.md)
  (B1) — its create-dialog picker lock is superseded here; the settings
  plugins tab lock and every other gate stand.
- [Native structured output](2026-11-26-native-structured-output.md) (G2) —
  its deferred live-panel routing and budget omission are activated here.
