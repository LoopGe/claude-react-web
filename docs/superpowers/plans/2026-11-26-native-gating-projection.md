# Native Capability Gating Projection (Block 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify feature gating into one capability→SessionInfo→UI projection so locked surfaces (plugins, hooks, memory, sandbox, account, and the create-dialog plugin picker) show-but-disabled with a "requires Claude CLI" note on native — the safety foundation for the native default flip.

**Architecture:** Add the missing capability flags (`supportsHooks`, `supportsMemory`), project five capability-derived booleans into `SessionInfo` (live + dormant) alongside the existing `taskControlSupported`, and gate each UI surface on its boolean. A reusable locked-notice component presents the disabled state. The pre-create New Session dialog gates on a shared provider-name→capabilities source (same capability mechanism, pre-create source). No hardcoded `provider !== 'native'` feature gate remains.

**Tech Stack:** TypeScript, React 19, Hono server, vitest (server Node + client happy-dom), theme CSS variables.

**Spec:** `docs/superpowers/specs/2026-11-26-native-gating-projection-design.md`

## Global Constraints

- CSS theme variables ONLY — the notice + disabled states defined in BOTH `:root` (dark) and `[data-theme="light"]`.
- Reuse the existing projection site `projectSharedSessionFields` (`session-manager.ts:~11756`) and `capsOf(provider)` (`~11702`); dormant projection via `infoFromMeta`.
- `SessionInfo` booleans use the three-state convention: `undefined` = legacy frame retains claude-compatible UI; gate with `!== false` (the `taskControlSupported` precedent, pinned in App.tsx/Chat.tsx/task-actions.ts).
- `ProviderCapabilities` is the single source of truth; the pre-create map MUST agree with it.
- Server routes stay capability-gated (native `applyFlagSettings` already rejects hooks/memory/sandbox); server behavior UNCHANGED. The UI gate prevents reaching those errors.
- The claude provider + SDK contract NOT modified; claude sessions see every surface enabled exactly as today.
- The note is TEXT ("requires Claude CLI"), NOT a functioning install button (packaging block deferred).
- Implementation isolates in a worktree branched from current `main`.
- Verify: `npm run typecheck`, `npx vitest run <path>`, `npm run lint`.

## Review Focus

- **Native locked surfaces honest.** On a native session each locked surface is disabled with the note; the user cannot reach a control that silently does nothing or throws on save.
- **Claude no-regression.** On a claude session every surface is enabled exactly as today (the booleans are true; nothing newly disabled).
- **Dormant projection.** A dormant native session's gates project correctly via `infoFromMeta` (not only live).
- **Legacy-frame safety.** An older frame with an undefined boolean retains claude-compatible UI (`!== false`), not newly locked.
- **Create dialog.** Native draft → plugin picker disabled + note; switching the provider selector to claude unlocks it live.
- **Account honest.** The account section shows the note on native, not empty rows.
- **Pre-create consistency.** The pre-create capability source agrees with the server `ProviderCapabilities` (no drift).

---

### Task 1: Capability flags + SessionInfo projection

**Files:**
- Modify: `server/providers/types.ts` (`ProviderCapabilities`)
- Modify: `server/providers/native/native-provider.ts` (capabilities ~116), `server/providers/claude/claude-provider.ts` (capabilities ~355)
- Modify: `shared/session-info.ts` (`SessionInfo`)
- Modify: `server/session-manager.ts` (`projectSharedSessionFields` ~11756; `infoFromMeta` dormant path)
- Test: `server/session-manager.test.ts` (projection pins)

**Interfaces:**
- Produces: `ProviderCapabilities.supportsHooks: boolean`, `supportsMemory: boolean` (native `false`, claude `true`; reuse existing `supportsPlugins`/`supportsSandbox`/`supportsAccountInfo`). `SessionInfo.pluginsSupported?`, `hooksSupported?`, `memorySupported?`, `sandboxSupported?`, `accountInfoSupported?` (three-state booleans), projected from `capsOf(provider)` for live AND dormant.

- [ ] **Step 1: Write the failing tests**

```ts
// session-manager.test.ts — projection pins (use the existing manager fixture)
it('projects locked-feature booleans false for native, true for claude (live)', async () => {
  const native = await createNativeSession(); const claude = await createClaudeSession()
  const ni = sm.info(native); const ci = sm.info(claude)
  for (const k of ['pluginsSupported','hooksSupported','memorySupported','sandboxSupported','accountInfoSupported']) {
    expect(ni[k]).toBe(false); expect(ci[k]).toBe(true)
  }
})
it('projects the booleans for dormant sessions via infoFromMeta', async () => {
  // native meta with no live handle → infoFromMeta yields the false booleans
})
```

Adapt to the existing fixture helpers (read how `taskControlSupported` is pinned).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/session-manager.test.ts -t "locked-feature booleans"`
Expected: FAIL — fields absent.

- [ ] **Step 3: Implement flags + projection**

Add `supportsHooks`/`supportsMemory` to `ProviderCapabilities`; set native `false`, claude `true` (claude already has the others true). Add the five optional booleans to `SessionInfo` with the three-state doc comment. Project them in `projectSharedSessionFields` from `capsOf(provider)` (mirror `taskControlSupported`); ensure `infoFromMeta` (dormant) projects them too. Account: settle the flag-flip-vs-data-presence per the spec (native `accountInfo()` returns undefined — make `accountInfoSupported` reflect display reality so the section shows the note, not empty rows).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS (no regression).

- [ ] **Step 5: Commit**

```bash
git add server/providers/types.ts server/providers/native/native-provider.ts server/providers/claude/claude-provider.ts shared/session-info.ts server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(native): capability flags + locked-feature SessionInfo projection"
```

---

### Task 2: Pre-create capability source

**Files:**
- Create: `shared/provider-capabilities.ts` (or a lightweight endpoint — builder's choice per spec)
- Test: `shared/provider-capabilities.test.ts`

**Interfaces:**
- Consumes: `ProviderCapabilities` shape (the source of truth).
- Produces: a client-readable provider-name → locked-feature-capabilities source for pre-create gating, e.g. `export function providerSupports(provider: string | undefined, feature: 'plugins'|'hooks'|'memory'|'sandbox'|'account'): boolean` backed by a map consistent with the server flags (native false / claude true / unknown defaults claude-compatible). Must not drift from `ProviderCapabilities`.

- [ ] **Step 1: Write the failing tests**

```ts
import { providerSupports } from './provider-capabilities.js'
it('native locks the five features; claude supports them', () => {
  for (const f of ['plugins','hooks','memory','sandbox','account']) {
    expect(providerSupports('native', f)).toBe(false)
    expect(providerSupports('claude', f)).toBe(true)
  }
})
it('unknown/undefined provider defaults claude-compatible (legacy safety)', () => {
  expect(providerSupports(undefined, 'plugins')).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/provider-capabilities.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implement the source**

A shared constant map keyed by provider name, consistent with `ProviderCapabilities` (builder settles shared-map vs endpoint; a shared map is simplest and browser-safe). If a map, add a pin/assertion that it agrees with the server flags (or derive both from one shared constant) so they cannot drift.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/provider-capabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/provider-capabilities.ts shared/provider-capabilities.test.ts
git commit -m "feat(shared): pre-create provider capability source for gating"
```

---

### Task 3: Locked-notice component + Settings UI gates

**Files:**
- Create: `src/components/RequiresCliNotice.tsx` (+ CSS in the settings stylesheet, theme vars both themes)
- Modify: `src/components/SettingsPanel.tsx` (plugins gate ~259, tab groups ~76/119/1082, hooks tab ~1793, plugins tab ~1801, memory ~639, sandbox ~667/1387)
- Modify: `src/components/UsagePanel.tsx` (account section)
- Test: `src/components/SettingsPanel.test.tsx`, `src/components/UsagePanel` test (client happy-dom)

**Interfaces:**
- Consumes: Task 1 `SessionInfo` booleans (`!== false` gate).
- Produces: `RequiresCliNotice` (theme-var styled "This feature requires the Claude CLI."); each settings surface gated on its boolean — plugins/hooks tabs show-but-locked (replace the hardcoded `provider !== 'native'` + `SESSION_TAB_GROUPS_NO_PLUGINS` hiding), memory/sandbox sections disabled + note (replace the sandbox hiding wrapper at ~1387), account section note.

- [ ] **Step 1: Write the failing tests**

```tsx
// SettingsPanel.test.tsx — render with a native SessionInfo (booleans false) vs claude (true)
it('native: plugins/hooks tabs show the locked notice; memory/sandbox controls disabled', () => {
  render(<SettingsPanel session={nativeSession} ... />)
  // navigate to plugins/hooks → RequiresCliNotice present; memory/sandbox inputs disabled
})
it('claude: every surface enabled, no notice (no regression)', () => {
  render(<SettingsPanel session={claudeSession} ... />)
  // no RequiresCliNotice; controls enabled
})
it('legacy frame (booleans undefined): claude-compatible, not locked', () => { ... })
// UsagePanel: native account section shows the note, not empty rows
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/SettingsPanel.test.tsx`
Expected: FAIL — notice absent / surfaces ungated.

- [ ] **Step 3: Implement the notice + gates**

Create `RequiresCliNotice` (theme vars; CSS in both `:root` and light). Gate each surface on its `SessionInfo` boolean (`!== false`): plugins tab uses `pluginsSupported` (keep the tab visible, show the notice when locked — remove `SESSION_TAB_GROUPS_NO_PLUGINS` hiding); hooks tab on `hooksSupported`; memory controls fold `memorySupported` into `memoryDisabled`; sandbox fold `sandboxSupported` into `sandboxDisabled` and replace the `provider !== 'native'` hiding wrapper with show-but-locked; account section shows the note when `accountInfoSupported === false`. Builder settles the locked-tab interaction (disabled entry vs selectable locked panel) consistent with the settings nav.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/SettingsPanel.test.tsx`
Expected: PASS (claude no-regression).

- [ ] **Step 5: Commit**

```bash
git add src/components/RequiresCliNotice.tsx src/components/SettingsPanel.tsx src/components/UsagePanel.tsx src/styles src/components/SettingsPanel.test.tsx
git commit -m "feat(ui): show-but-locked settings surfaces with requires-CLI notice"
```

---

### Task 4: New Session dialog plugin picker gate

**Files:**
- Modify: `src/components/session-list/NewSessionDialog.tsx` (plugin picker ~1028)
- Test: `src/components/session-list/NewSessionDialog.test.tsx`

**Interfaces:**
- Consumes: Task 2 `providerSupports(provider, 'plugins')`; Task 3 `RequiresCliNotice`.
- Produces: the create-dialog plugin picker shows-but-locked when the draft provider is native (disabled checkboxes + notice); switching the provider selector to claude unlocks it live. Replaces the `provider !== 'native' && allPluginKeys.length > 0` hide.

- [ ] **Step 1: Write the failing test**

```tsx
it('native draft: plugin picker disabled + notice; claude draft: enabled', () => {
  const { rerender } = render(<NewSessionDialog ... provider="native" />)
  // plugin checkboxes disabled, RequiresCliNotice present
  rerender(<NewSessionDialog ... provider="claude" />)
  // checkboxes enabled, no notice
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/session-list/NewSessionDialog.test.tsx -t "plugin picker"`
Expected: FAIL — picker hidden for native.

- [ ] **Step 3: Implement the gate**

Replace the hide with: render the picker when `allPluginKeys.length > 0`; disable the checkboxes + show `RequiresCliNotice` when `!providerSupports(provider, 'plugins')`. The provider selector switching re-renders and unlocks. Keep the "can't be added after start" hint.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/session-list/NewSessionDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Final verification + commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

```bash
git add src/components/session-list/NewSessionDialog.tsx src/components/session-list/NewSessionDialog.test.tsx
git commit -m "feat(ui): show-but-locked create-dialog plugin picker via pre-create capabilities"
```

---

### Task 5: Owning agent note

**Files:**
- Create: `.agents/notes/implemented/feature/2026-11-26-native-gating-projection.md`

**Interfaces:**
- Consumes: the decisions above; `.agents/notes/README.md` contract.
- Produces: a decision record capturing the unified capability→SessionInfo→UI projection, the show-but-disabled presentation (vs hiding), the pre-create capability source (same mechanism, not a fourth system), the account flag decision, and that the install button awaits the packaging block.

- [ ] **Step 1: Write the note** per the README contract (Problem → Decision → Alternatives considered → Consequences; Status: implemented; relative links to the spec + capability-fills spec).

- [ ] **Step 2: Verify structure**

Run: `npm run verify:agent-notes`
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add .agents/notes/implemented/feature/2026-11-26-native-gating-projection.md
git commit -m "docs(native): owning agent note for capability gating projection"
```

---

## Self-Review

**Spec coverage:** G1 one projection (Tasks 1–4, no hardcoded gate remains); G2 show-but-disabled + note (Tasks 3–4); G3 no silent failures (gates before request). Capability flags + projection (Task 1), pre-create source (Task 2), settings surfaces (Task 3), create-dialog picker (Task 4), account nuance (Task 1/3), agent note (Task 5). Non-goals respected (no feature implementation, no install button, no flip).

**Review Focus coverage:** native locked (Task 3/4 tests), claude no-regression (Task 3), dormant projection (Task 1), legacy-frame safety (Task 1/3), create dialog switch (Task 4), account honest (Task 1/3), pre-create consistency (Task 2).

**Type consistency:** `supportsHooks`/`supportsMemory`, the five `SessionInfo` booleans, `providerSupports`, `RequiresCliNotice` consistent across tasks; `!== false` gate convention.

**Proportion:** code blocks are test assertions + signatures; UI component bodies left to the implementer with named decisions.