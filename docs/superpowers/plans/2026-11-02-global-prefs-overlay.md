# Global Prefs and Panel Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify global preference types/defaulting/session resolution, consolidate GlobalSettingsModal appearance state, and replace four independent panel-overlay states with one discriminated union while preserving all current UI behavior.

**Architecture:** Add a canonical `GlobalPrefs` contract in `src/types/config.ts` and reuse it in config responses and UI consumers. Introduce a single staged `AppearancePrefs` object for GlobalSettingsModal, then model the active panel overlay as `{ kind, sessionId } | null` with derived compatibility fields and handlers for App.

**Tech Stack:** TypeScript, React 19, Vitest, Testing Library, existing config/App/settings/overlay modules.

**Spec:** `docs/superpowers/specs/2026-11-02-global-prefs-overlay-design.md`

## Global Constraints

- No new or removed preference fields, defaults, save semantics, or overlay behaviors.
- Explicit `false` values always win over defaults; `undefined` alone falls back to defaults.
- `firstPartyTools` keeps optional presence and reference-identity comparison.
- `streamingRenderMode` and spacing/font/animation presets remain global-only, not per-session overrides.
- Existing App/ChatPanel props and derived overlay handler names remain as the migration adapter; do not recreate duplicate state sources.
- Keep `settingsTabRequest` and its nonce separate from the overlay union.
- Stage only exact task files and run `code-review` on the full diff before every commit.

## Review Focus

1. **Explicit false vs undefined:** false is preserved while undefined inherits defaults — pinned in Task 1.
2. **Reference identity:** unchanged prefs and `firstPartyTools` must preserve object identity and avoid panel rerenders — pinned in Task 1.
3. **Appearance save:** patch updates one field without dropping others or explicit false values — pinned in Task 2.
4. **Deep links:** settings tab request sessionId and nonce still route correctly — pinned in Tasks 2 and 3.
5. **Overlay exclusivity:** opening replaces the previous overlay and close only affects the matching kind — pinned in Task 3.

## File Structure

- `src/types/config.ts` — GlobalPrefs/SessionPrefs/AppearancePrefs, defaults, config mapping/equality/session resolution, and config response inheritance.
- `src/types/global-prefs.test.ts` — preference contract tests.
- `src/App.tsx` — applyConfigResponse uses the canonical mapper/equality.
- `src/components/Chat.tsx`, `ChatPanel.tsx`, `SettingsPanel.tsx` — shared preference type and resolver.
- `src/components/GlobalSettingsModal.tsx` — one staged appearance object and patch-based AppearanceTab.
- `src/components/GlobalSettingsModal.appearance.test.tsx` — staged appearance and save tests.
- `src/app/useAppOverlays.ts` — single PanelOverlay union plus derived compatibility fields.
- `src/app/useAppOverlays.test.tsx` — union lifecycle and deep-link tests.

---

### Task 1: Canonical Preference Types and Resolution

**Files:**
- Modify: `src/types/config.ts`
- Create: `src/types/global-prefs.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/Chat.tsx`
- Modify: `src/components/ChatPanel.tsx`
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/components/SettingsPanel.test.tsx`
- Modify: `src/components/ChatPanel.side-chat.test.tsx`

**Interfaces:**
- Produces:
  - `GlobalPrefs`, `SessionPrefs`, `AppearancePrefs`, `DEFAULT_GLOBAL_PREFS`
  - `globalPrefsFromConfig(config: Partial<GlobalPrefs>): GlobalPrefs`
  - `appearanceFromFullConfig(config: FullServerConfig): AppearancePrefs`
  - `sameGlobalPrefs(a: GlobalPrefs, b: GlobalPrefs): boolean`
  - `resolveSessionPrefs(session: SessionInfo, globalPrefs: GlobalPrefs): SessionPrefs`
  - `ConfigResponse extends Partial<GlobalPrefs>`, `FullServerConfig extends GlobalPrefs`

- [ ] **Step 1: Write failing preference contract tests**

Cover:
- every default and every explicit false/defined value;
- `sameGlobalPrefs` true only when scalar fields and firstPartyTools reference are identical;
- `resolveSessionPrefs` explicit false vs inherited undefined;
- ConfigResponse/FullServerConfig type compatibility;
- existing SettingsPanel and Side Chat override behavior as integration controls.

- [ ] **Step 2: Run the tests to verify the new contract is missing**

Run: `npm test -- src/types/global-prefs.test.ts`
Expected: FAIL because the canonical helpers do not exist.

- [ ] **Step 3: Implement and migrate to the canonical contract**

Add the types/helpers in `src/types/config.ts`, inherit config response shapes from them, and replace App's hand-built nextPrefs/equality chain. Replace duplicated prop shapes and inline session-resolution chains in Chat, ChatPanel, and SettingsPanel with `resolveSessionPrefs`. Keep `globalPrefs.streamingRenderMode` and firstPartyTools read directly where already used.

- [ ] **Step 4: Run preference and UI suites**

Run: `npm test -- src/types/global-prefs.test.ts src/components/SettingsPanel.test.tsx src/components/ChatPanel.side-chat.test.tsx src/components/streaming-render-isolation.test.tsx`
Expected: PASS, including unchanged appearance/override behavior and no extra panel renders.

Run: `npm run typecheck && npm test`
Expected: typecheck PASS and full suite PASS, or only documented pre-existing server baseline failures.

- [ ] **Step 5: Review and commit**

```bash
git add src/types/config.ts src/types/global-prefs.test.ts src/App.tsx src/components/Chat.tsx src/components/ChatPanel.tsx src/components/SettingsPanel.tsx src/components/SettingsPanel.test.tsx src/components/ChatPanel.side-chat.test.tsx
git commit -m "refactor: unify global preference contract" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: Consolidate GlobalSettingsModal Appearance State

**Files:**
- Modify: `src/components/GlobalSettingsModal.tsx`
- Create: `src/components/GlobalSettingsModal.appearance.test.tsx`

**Interfaces:**
- `AppearanceTab` props become `{ values: AppearancePrefs; onPatch: (patch: Partial<AppearancePrefs>) => void }`.
- GlobalSettingsModal uses one `appearance` state object and `patchAppearance(patch)`.

- [ ] **Step 1: Write failing staged appearance tests**

Assert config initialization preserves explicit false values; each Switch/Segmented patch changes only its target field; `onPatch` preserves other fields and callback identity semantics; Save spreads the entire appearance object and sends every field, including false. Keep deep-link and modal open/close behavior as integration controls.

- [ ] **Step 2: Run the appearance tests to verify the old shape fails**

Run: `npm test -- src/components/GlobalSettingsModal.appearance.test.tsx`
Expected: FAIL because `values`/`onPatch` are not implemented and state is still split.

- [ ] **Step 3: Replace split appearance state with staged object and patch**

Use `appearanceFromFullConfig` for initialization, one `appearance` state object, and `patchAppearance`. Change AppearanceTab to `values`/`onPatch` and update each control to patch its own key. Save with `...appearance` while leaving firstPartyTools and other tabs unchanged.

- [ ] **Step 4: Run appearance and existing modal suites**

Run: `npm test -- src/components/GlobalSettingsModal.appearance.test.tsx src/components/GlobalSettingsModal.test.tsx src/components/GlobalSettingsModal.skills-add.test.tsx src/components/GlobalSettingsModal.skills-updates.test.tsx`
Expected: PASS with identical UI and save behavior.

Run: `npm run typecheck && npm test`
Expected: typecheck PASS and full suite PASS, or only documented pre-existing server baseline failures.

- [ ] **Step 5: Review and commit**

```bash
git add src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.appearance.test.tsx
git commit -m "refactor: consolidate global appearance state" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: Replace Independent Overlay States with PanelOverlay

**Files:**
- Modify: `src/app/useAppOverlays.ts`
- Create: `src/app/useAppOverlays.test.tsx`

**Interfaces:**
- `PanelOverlayKind = 'settings' | 'git' | 'tasks' | 'worktree'`
- `PanelOverlay = { kind: PanelOverlayKind; sessionId: string } | null`
- `openPanelOverlay(kind, sessionId)` and `closePanelOverlay(kind)`.
- Derived `settingsOpenFor`, `gitPanelOpenFor`, `tasksPanelOpenFor`, `worktreeOpenFor` and existing open/close handler names remain as the adapter.

- [ ] **Step 1: Write failing overlay lifecycle tests**

Using `renderHook`, assert:
- each open replaces the previous `{kind, sessionId}` and derived openFor fields agree with the union;
- opening a different kind never leaves both open;
- close clears only a matching kind;
- `openSettingsTab` opens settings and produces a fresh nonce with the correct sessionId/tab, without losing the current overlay semantics.

- [ ] **Step 2: Run the tests to verify the union is missing**

Run: `npm test -- src/app/useAppOverlays.test.tsx`
Expected: FAIL because PanelOverlay and open/close helpers do not exist.

- [ ] **Step 3: Implement the union and compatibility adapter**

Replace four independent states with one PanelOverlay. Implement open/close helpers and settings-tab flow, then derive the existing openFor fields and delegate existing handlers. Keep helpOpen/helpCommands and settingsTabRequest outside the union, and do not change App JSX.

- [ ] **Step 4: Run overlay and affected settings suites**

Run: `npm test -- src/app/useAppOverlays.test.tsx src/components/SettingsPanel.test.tsx src/components/ChatPanel.side-chat.test.tsx`
Expected: PASS with unchanged overlay/deep-link behavior.

Run: `npm run typecheck && npx vitest run src && npm run build && npm test`
Expected: typecheck PASS, all client tests PASS, build PASS, and full suite PASS, or only documented pre-existing server baseline failures.

- [ ] **Step 5: Review and commit**

```bash
git add src/app/useAppOverlays.ts src/app/useAppOverlays.test.tsx docs/superpowers/specs/2026-11-02-global-prefs-overlay-design.md docs/superpowers/plans/2026-11-02-global-prefs-overlay.md
git commit -m "refactor: unify panel overlay state" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
