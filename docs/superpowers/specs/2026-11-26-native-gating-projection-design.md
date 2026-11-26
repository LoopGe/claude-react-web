# Native capability gating projection (Block 1) — design

Date: 2026-11-26
Status: proposed

## Problem

The UI decides "is this feature usable on this session" through three inconsistent mechanisms:

1. **Capability-derived booleans** — `taskControlSupported`, `steeringSupported`, etc., projected from `ProviderCapabilities` into `SessionInfo` (`session-manager.ts:11811/11855`) and read by the UI. Clean.
2. **Hardcoded provider checks** — the plugins tab gates on `session.provider !== 'native'` (`SettingsPanel.tsx:259`), bypassing capabilities.
3. **No gating** — the hooks tab, the auto-memory section, the sandbox toggle, and the account section render for native sessions but are silently ineffective or throw on save (native has no hook engine; `applyFlagSettings` rejects `memory`/`sandbox`; `accountInfo()` returns undefined).

While claude is the default, category 3 is hidden (claude supports everything). Flipping the default to native (Block 3) would expose category 3 as user-visible broken experiences. This block unifies all gating into mechanism 1 so locked features degrade honestly — the safety foundation for the default flip.

## Goals

- **G1 — One projection.** Every locked surface gates on capabilities, not hardcoded provider checks. Post-create surfaces read a capability-derived `SessionInfo` boolean projected in `projectSharedSessionFields` (alongside `taskControlSupported`); the pre-create New Session dialog gates on a shared provider-capabilities source (same capability mechanism, pre-create source). No hardcoded `provider !== 'native'` feature gate remains.
- **G2 — Honest locked presentation.** A locked surface is **shown but disabled, with a "requires Claude CLI" note** (user-decided) — discoverable, and consistent with the optional-install upgrade path (the note becomes an install button when the packaging block lands).
- **G3 — No silent failures.** A native user cannot reach a control that silently does nothing or throws on save; the control is disabled with the note before any request.

## Non-goals and anti-goals

- **Not implementing the locked features** (hooks engine, memory pipeline, sandbox, plugins, account/plan windows) — those stay locked/deferred per the capability disposition.
- **Not the install mechanism.** The packaging block (CLI optional install) is deferred; the note is TEXT ("requires Claude CLI"), not a functioning install button. No placeholder button that does nothing.
- **Not changing capability semantics** — the flags reflect what each provider actually supports; this block only projects + presents them.
- **Not the default flip** (Block 3) or auth-aware selection.
- **Anti-goal: a fourth gating mechanism.** Consolidate into the existing capability→SessionInfo→UI pattern; do not invent a parallel system.
- **Anti-goal: hiding locked features.** The user chose show-but-disabled over hiding (discoverability + upgrade path). The current plugins-tab hiding is replaced by show-but-locked.

## Constraints

- CSS theme variables only (the note + disabled states defined in both `:root` and `[data-theme="light"]`).
- Reuse the existing projection site (`projectSharedSessionFields`) and the existing capability accessor (`capsOf(provider)`).
- Server routes stay capability-gated (memory/sandbox already reject on native; plugins capability-gated). The UI gate prevents reaching those errors; server behavior is unchanged.
- The claude provider and SDK contract are NOT modified; claude sessions see every surface enabled exactly as today.
- `ProviderCapabilities` is the single source; native declares the locked flags `false`, claude `true`.

## Decided approach

### Capability flags
`ProviderCapabilities` already has `supportsPlugins`, `supportsSandbox`, `supportsAccountInfo`. ADD `supportsHooks` and `supportsMemory` (native `false`, claude `true`). These reflect reality: native has no hook engine and rejects the memory settings keys.

### One projection
In `projectSharedSessionFields`, derive five booleans from `capsOf(provider)`:
`pluginsSupported`, `hooksSupported`, `memorySupported`, `sandboxSupported`, `accountInfoSupported` — projected for live AND dormant sessions (same as `taskControlSupported`). Add them to `SessionInfo` (`shared/session-info.ts`) with the three-state convention where appropriate (undefined = legacy frame retains claude-compatible UI; explicit false = locked).

### UI gates (show-but-disabled + note)
A reusable locked notice component (theme-var styled, e.g. "This feature requires the Claude CLI."). Each surface reads its boolean:
- **plugins tab** — replace the hardcoded `provider !== 'native'` check and the `SESSION_TAB_GROUPS_NO_PLUGINS` hiding with `pluginsSupported`; the tab stays visible but shows the locked notice (disabled) when unsupported.
- **hooks tab** — gate on `hooksSupported`; locked notice when unsupported.
- **memory section** (general tab) — gate the controls on `memorySupported`; disabled + note when unsupported (fold into the existing `memoryDisabled` logic).
- **sandbox section** (general tab) — gate on `sandboxSupported`; disabled + note (fold into `sandboxDisabled`).
- **account section** (UsagePanel) — gate on `accountInfoSupported`; locked note when unsupported.
- **New Session dialog plugin picker** (`NewSessionDialog.tsx:1028`, currently `provider !== 'native' && allPluginKeys.length > 0` hides it) — replace the hardcoded hide with show-but-locked: when the draft provider is native, the plugin picker is disabled with the "requires Claude CLI" note; switching the provider selector to claude unlocks it. This is the first surface a native-default user hits, so it is in scope (user-decided).

### Pre-create capability source
A session being created has no `SessionInfo`/handle — only a draft provider name. The dialog gates on a **shared provider-name → capabilities map** (a single source the client can read pre-create, e.g. a small shared module or a lightweight capabilities endpoint). This is the SAME capability mechanism as the post-create projection, sourced before create — not a fourth gating system. The map must agree with `ProviderCapabilities` (single source of truth; the builder settles whether the client imports a shared constant map or fetches a capabilities endpoint, keeping it consistent with the server flags). The post-create `SessionInfo` booleans remain the source for existing sessions.

### Account nuance (builder settles)
Native's `supportsAccountInfo` flag is currently `true` but `accountInfo()` returns undefined (API-key auth has no subscription account/plan windows). The display intent is "account info requires Claude CLI". The builder settles whether to flip native's `supportsAccountInfo` to `false` (the method exists but yields nothing displayable) or gate the account section on data presence — either way the section shows the honest note, not empty rows. Do not leave the flag claiming support while the section is empty.

## Left to builder

- The exact locked-tab interaction (a disabled tab entry vs a selectable tab showing a locked panel) — pick the pattern consistent with the existing settings nav; the notice text is fixed.
- The reusable notice component's placement/props and which specific controls disable per section.
- The account gating decision above (flag flip vs data-presence).
- The pre-create capability source shape (shared constant map vs capabilities endpoint) — must stay consistent with `ProviderCapabilities`; the create-dialog picker gates on it.
- Whether `accountInfoSupported` needs the three-state legacy convention or a plain boolean.
- Tests: projection pins (native false / claude true for each flag, live + dormant); UI gating tests (locked surface disabled + note, claude enabled); no-regression on existing capability gates.
- Owning agent note per the README contract.