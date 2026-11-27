# Agent Note: Native capability gating projection

Status: implemented

## Problem

The UI decides "is this feature usable on this session" through three
inconsistent mechanisms: capability-derived `SessionInfo` booleans
(`taskControlSupported` and siblings), hardcoded provider checks (the plugins
tab gates on `provider !== 'native'`), and no gating at all — the hooks tab,
auto-memory section, sandbox toggle and account section render for native
sessions but are silently ineffective or throw on save (native has no hook
engine, `applyFlagSettings` rejects the memory/sandbox keys, and
`accountInfo()` resolves undefined). While claude is the default the ungated
category is invisible; flipping the default to native would expose it as
user-visible broken surfaces.

The full contract lives in the
[native capability gating projection design](../../../../docs/superpowers/specs/2026-11-26-native-gating-projection-design.md)
(Block 1); this note records the decisions and what they beat. The locked
features themselves (hooks, memory, sandbox, plugins, account/plan windows)
stay locked per the capability disposition in the
[native capability fills design](../../../../docs/superpowers/specs/2026-11-26-native-capability-fills-design.md)
— this block gates their UI, it does not implement them. The
[implementation plan](../../../../docs/superpowers/plans/2026-11-26-native-gating-projection.md)
records the task breakdown.

## Decision

All feature gating consolidates into the existing capability → SessionInfo →
UI projection. `ProviderCapabilities` is the single source; no hardcoded
`provider !== 'native'` feature gate remains.

### Capability flags + one projection

`ProviderCapabilities` carries `supportsHooks` and `supportsMemory` (native
`false`, claude `true`) alongside the existing `supportsPlugins`,
`supportsSandbox` and `supportsAccountInfo`. `projectSharedSessionFields`
(`server/session-manager.ts`) derives five `SessionInfo` booleans from
`capsOf(provider)` — `pluginsSupported`, `hooksSupported`, `memorySupported`,
`sandboxSupported`, `accountInfoSupported`. That single site serves live
`info()`, dormant `infoFromMeta()` and every broadcast, so a dormant native
session projects the same locks as a live one. The fields are not persisted;
they are re-derived on every projection.

The booleans follow the `taskControlSupported` three-state convention:
`undefined` on a legacy frame retains the claude-compatible UI, so consumers
gate with `!== false`; an explicit `false` locks the surface.

### Show-but-disabled with a text notice

A locked surface is shown but disabled with a "requires Claude CLI" note —
user-decided over hiding, for discoverability and the optional-install
upgrade path. `RequiresCliNotice` (`src/components/RequiresCliNotice.tsx`)
renders the fixed text "This feature requires the Claude CLI." — TEXT only;
the install button awaits the packaging block, and there is deliberately no
placeholder button. Its color tokens are defined in both themes.

- **Plugins and hooks tabs** are selectable but locked: the locked tab body
  renders the notice instead of the live content — no fetches, no dead
  controls. The `SESSION_TAB_GROUPS_NO_PLUGINS` hiding and the plugins
  deep-link redirect are gone; the plugins auto-reload stays gated, so no
  501-bound POST fires.
- **Memory and sandbox sections** (General tab) stay rendered with their
  controls disabled and the notice; each folds its own boolean into its own
  disabled flag (the two are independent). The "resume the session" hint is
  suppressed while locked — resume never unlocks a capability lock.
- **Account section** (UsagePanel) renders its title + the notice on explicit
  `accountInfoSupported === false`, fail-closed even if rows were present.
- **New Session dialog plugin picker** is show-but-locked on a native draft
  (pre-create source below); switching the provider selector to claude
  unlocks it live on the same mounted dialog.

### Pre-create capability source

A session being created has no `SessionInfo` — only a draft provider name.
`shared/provider-capabilities.ts` exports `providerSupports(provider,
feature)` over a provider-name → feature-support map (`GATED_FEATURES`:
plugins, hooks, memory, sandbox, account, pluginSkills). This is the SAME
capability mechanism sourced before create, not a fourth gating system; the
post-create `SessionInfo` booleans remain the source for existing sessions.
The module is browser-safe (zero imports) and total over all string inputs (a
`Map`, so prototype-key names like `constructor` cannot resolve);
unknown/undefined providers default claude-compatible.

The map mirrors the server literals (the five CLI features: native false,
claude true; pluginSkills: true for both) and cannot drift unnoticed:
`server/providers/provider-capabilities-pin.test.ts` constructs the real
providers and asserts `providerSupports` agrees with each
`ProviderCapabilities` flag, through an exhaustively typed feature→flag
roster. The create-dialog picker gates on this source; its submit payload is
unchanged — but `enabledPlugins` is NOT inert on native: native consumes it
for read-only plugin-skill discovery (`NativeSkillCatalog` →
`listPluginSkills` → `getEnabledPluginEntries`; undefined = all enabled,
`[]` = none, a subset = membership), so a selection carried over from a
claude draft narrows the native session's discovered plugin skills. It
affects discovery only, not native spawn or tools.

### Account: the flag reflects display reality

Native's `supportsAccountInfo` is `false`. `accountInfo()` resolves
`undefined` for API-key auth (no subscription account/plan windows), so a
`true` flag claimed support the provider cannot display. The projection stays
a pure `capsOf` mirror for live AND dormant sessions — a dormant session has
no handle, so data-presence gating cannot project consistently. With the flag
flipped, `GET /sessions/:id/account` on native rejects 501 (the standard
capability gate) instead of returning `{account: null}`; the client's account
fetch is supplementary and tolerates the failure, and the UsagePanel shows
the locked note.

This supersedes the account paragraph ("`accountInfo` 诚实为空") of the
[native session persistence design](../../../../docs/superpowers/specs/2026-11-09-native-session-persistence-design.md),
which encodes `supportsAccountInfo: true` → `{account: null}`. That record's
core fact stands (native invents no account fields); the capability value and
route behavior it chose are replaced by this decision.

## Alternatives considered

- **Hiding locked features** (the prior plugins-tab behavior). Rejected by
  user decision: show-but-disabled keeps the feature discoverable and gives
  the optional-install upgrade path a place to land.
- **Data-presence gating for the account section.** Rejected: a dormant
  session has no handle to read data from, so presence cannot project
  live+dormant; a provider-name special case in the projection would break
  the one-mechanism goal.
- **Keeping `supportsAccountInfo: true` → `{account: null}`** (the
  2026-11-09 persistence decision). Rejected: the flag claims support while
  the section is empty — the gating spec explicitly forbids that state.
- **A capabilities endpoint for pre-create gating.** Rejected: the values
  are static per provider; a shared constant map needs no round-trip or
  async state in the dialog, and the server pin guards drift.
- **Deriving the shared map from the server capability literals.** Rejected:
  `shared/` cannot import the server (browser tsconfig), and moving the
  flags into shared would scatter the commented provider literals. The pin
  keeps the literals authoritative.
- **A disabled tab leaf in SettingsTabNav.** Rejected: the nav has no
  disabled-leaf mechanism and is shared with GlobalSettingsModal — a
  nav-wide change for one consumer. The selectable-tab + locked-panel
  pattern fits the existing nav.

## Consequences

One projection owns every locked surface, live and dormant; claude sessions
see every surface enabled exactly as before (the two new claude flags are
`true` — they lock nothing on claude; every gate passes). Locked features
degrade honestly —
the safety foundation for the native default flip (Block 3). The notice is
the upgrade-path seam: when the packaging block lands, the text becomes an
install button without touching the gates.

What it costs / discloses:

- **The native account route's wire behavior changed**: 501 instead of
  `{account: null}`. Direct API callers see the rejection; the app client
  tolerates it (account stays null).
- **Two sources, pinned not derived**: the server literals and the shared
  pre-create map agree by test pin, not construction. The pin roster is
  hand-maintained (see Deferred).
- **The account fetch still fires on native** (a tolerated 501 round-trip) —
  the section gate is display-side; see Deferred.

## Deferred

- **Install button** — awaits the CLI-optional packaging block; the notice
  is text today.
- **`useSessionUsage` account fetch not capability-gated** — a native Usage
  refresh still round-trips `GET /account` into the tolerated 501. Optional
  future skip when `accountInfoSupported === false`.
- **Pre-create pin roster hand-maintained** — a future third provider needs
  a map row and a pin entry; until then `providerSupports` defaults it
  claude-compatible. The feature→flag roster's exhaustive typing guards
  omission, not mis-mapping: a wrong feature→flag pairing type-checks, and
  the runtime pin catches it only where the two flags' values differ.
- **Create-dialog submit path on a provider switch** — unchecking plugin X
  under a claude draft then switching to native submits the narrowed
  `enabledPlugins` subset, which narrows native's plugin-skill discovery
  (above). This is real behavior, not inert: no test pins the payload, and
  whether native creates should omit `enabledPlugins` — so a claude-era
  selection never narrows discovery unintentionally — is an open follow-up
  decision.
- **Test hygiene** — `RequiresCliNotice.tsx` lacks a trailing newline; the
  `selectProvider` test helper duplicates the provider-picker helpers.

## Testing

`server/session-manager.test.ts` pins the five booleans × {claude true,
native false} × {live create, dormant list} through the real providers.
`shared/provider-capabilities.test.ts` pins the map's concrete values and the
legacy/prototype-key default; `server/providers/provider-capabilities-pin.test.ts`
pins agreement with the real provider literals (verified non-vacuous by a
drift mutation). `SettingsPanel.test.tsx` / `UsagePanel.test.tsx` pin
show-but-locked panels with zero fetches, per-boolean independence, and
claude/legacy no-regression; `NewSessionDialog.test.tsx` pins the locked
picker and live unlock in both provider-switch directions.

## Related

[Auth-aware native default flip](2026-11-27-native-default-flip.md) (Block 3)
supersedes the create-dialog picker lock above: the picker gates on
`pluginSkills` (functional on both providers), and native's `enabledPlugins`
narrowing is an intentional, payload-pinned selection — resolving the open
submit-path follow-up under Deferred. The settings plugins tab lock
(`pluginsSupported`) and every other gate in this note stand. The picker tests
now pin the functional behavior.
