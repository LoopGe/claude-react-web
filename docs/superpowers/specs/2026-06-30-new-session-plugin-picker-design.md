# New Session Plugin Picker — Design

Date: 2026-06-30
Status: Approved (pending spec review)

## Problem

Every new session today unconditionally loads **all** globally-enabled
marketplace plugins. `server/providers/claude/claude-provider.ts:191-200`
(`applyStandardQueryOpts`) reads `mpStore.getEnabledPluginAbsolutePaths()` and
injects every enabled plugin into `Options.plugins` with no per-session
filtering. There is no way to start a session with a *subset* of the ON list.

The user wants: in the New Session dialog, pick which of the installed
(enabled/"ON") plugins to carry into this session.

## Constraint (shapes the whole design)

`Options.plugins` is an array of `{ type: 'local', path }` built **at spawn
time only**. The SDK has **no `setPlugins`** control analogous to
`setMcpServers`. The only mid-session plugin control is
`applyFlagSettings({ enabledPlugins })`, which flips the active/inactive flag
of an **already-loaded** plugin — it cannot load a new one.

Consequence: the new-session picker defines the session's plugin universe for
its entire lifetime. Adding a plugin to a running session requires a full
respawn. The UI must state this.

## Scope

**In scope:** a plugin checkbox section in `NewSessionDialog`, backend
threading of a selected subset through spawn, and persistence so the subset
survives resume / fork / clear / sideChat / auto-resume.

**Out of scope:** adding plugins to a *live* session (infeasible — no
`setPlugins`); opting into globally-*disabled* plugins per session (the
selectable set is the ON list only, per the user's request "从已安装的 ON
LIST 中选择").

## Decisions

1. **Selectable set = ON-list subset only.** The dialog lists globally-enabled
   plugins, all pre-checked. Unchecking removes a plugin from this session
   only. Disabled plugins are not shown and cannot be opted in. (Contrast
   with MCP, which was recently changed to allow opt-in for disabled servers;
   plugins deliberately stay ON-subset-only.)

2. **Selection persists across resume/fork and drives re-injection.**
   `enabledPlugins: string[]` (compound keys) is stored on `SessionMeta`. On
   resume/fork/clear-respawn/sideChat/auto-resume, the provider re-injects
   **exactly the persisted subset**, not "all enabled". This is deliberately
   stronger than MCP's current behavior: MCP persists `mcpServerNames` for UI
   display but resume re-injects *all* enabled servers
   (`session-manager.ts:578-581`). Plugins do it properly.

3. **Empty array `[]` ≠ omitted.**
   - `enabledPlugins` omitted / `undefined` → inject all enabled (current
     behavior; backward-compatible default).
   - `enabledPlugins: []` → inject **no** plugins for this session.
   - The provider distinguishes these two explicitly.

4. **No clone logic in the new flow.** git-subdir plugins are cloned at
   enable time (`mp-marketplace.ts:275-277`, clone-before-persist), so an
   ON-list plugin already has its clone on disk. The new
   `getEnabledPluginAbsolutePathsFor(keys)` inherits
   `getEnabledPluginAbsolutePaths()`'s `existsSync` guard
   (`mp-store.ts:297-310`): if a clone has vanished by spawn time, the plugin
   is **silently skipped** (never handed to the SDK, which would fail spawn).
   No logging is added, matching the existing silent-skip behavior. This is a
   pre-existing limitation, not expanded here.

## Data Model

- **Identity:** the MpStore compound key `<plugin>@<marketplace>`
  (`MpStore.keyOf`). Same key the SDK and `applyFlagSettings` use.
- **Persistence:** `SessionMeta.enabledPlugins?: string[]` (compound keys).
  Surfaced on `SessionInfo` for UI display.
  - `undefined` → "all enabled" (default).
  - `[]` → "none".
  - non-empty → exactly those.

## Backend Changes

### `server/mp-store.ts`

- **`getEnabledPluginAbsolutePathsFor(keys: string[]): string[]`** — same
  resolution logic as `getEnabledPluginAbsolutePaths()`, but only for entries
  whose key is in `keys` **and** `enabled === true`. Inherits the
  `existsSync` silent-skip for git-subdir and the path dedupe (`seen` set).
  Disabled or unknown keys are dropped.
- **`enabledPluginEntries(): { key, name, marketplace, description?, version? }[]`**
  — returns metadata for every enabled plugin, for the new dialog endpoint.
  `marketplace` is the marketplace id (or display name if available).

### `server/providers/types.ts`

- Add `enabledPlugins?: string[]` to `CreateSessionOptions`.

### `server/providers/claude/claude-provider.ts` (`applyStandardQueryOpts`, ~line 191)

- Read `createOpts.enabledPlugins`:
  - `undefined` → `mpStore.getEnabledPluginAbsolutePaths()` (current).
  - present (incl. `[]`) → `mpStore.getEnabledPluginAbsolutePathsFor(enabledPlugins)`.
- The resolved path list is applied with the existing guard
  `if (paths.length > 0) opts.plugins = [...]`. So `[]` → empty path list →
  `opts.plugins` is left unset → no plugins load. The `undefined` vs `[]`
  distinction is preserved by the caller passing the field through verbatim;
  both reach the provider, which selects the resolution method accordingly.

### `server/session-types.ts` + `server/persistence.ts`

- `SessionMeta.enabledPlugins?: string[]`; `SessionInfo.enabledPlugins?: string[]`.
- Persisted/restored like `mcpServerNames`.

### `server/session-manager.ts`

- `create()`: store the route-supplied `enabledPlugins` onto the new session's
  meta (verbatim: `undefined`, `[]`, or non-empty).
- **spawn / resume / fork / clear-respawn / sideChat / auto-resume** paths:
  before calling `provider.createSession()`, set
  `createOpts.enabledPlugins = meta.enabledPlugins` so the provider re-injects
  the same subset. Where `meta.enabledPlugins` is `undefined`, the provider
  falls back to all-enabled (unchanged).
- If a persisted key is no longer enabled / no longer installed at resume,
  `getEnabledPluginAbsolutePathsFor` silently drops it — graceful degradation,
  no error.

### `server/routes/sessions.ts`

- `POST /sessions` accepts `enabledPlugins?: string[]`. Validate exactly like
  `enabledMcpServers` (must be an array of strings; a stray string is a 400,
  not iterated char-by-char). Generalize the existing validator or add a
  parallel `validateEnabledPlugins`.
- Pass through to `sm.create()`.

### `server/routes/mp-marketplace.ts`

- `GET /mp/enabled-plugins` → `{ plugins: { key, name, marketplace, description?, version? }[] }`
  (enabled only). Mounted on the mp router.

## Frontend Changes

### `src/types.ts`

- `NewSessionForm.enabledPlugins?: string[]`.

### `src/components/session-list/NewSessionDialog.tsx`

Mirror the existing MCP checkbox block (lines ~580-610):

- On open: `GET /mp/enabled-plugins` → `setSelectedPlugins(new Set(keys))`
  (all pre-checked).
- Each row: plugin name + marketplace (secondary, `var(--fg-muted)`).
- One-line hint: "Plugins can't be added after the session starts — choose
  them here." (uses theme variables, defined in both `:root` and
  `[data-theme="light"]` — reuse existing `--fg-muted`).
- Submit:
  - if `selectedPlugins.size === allKeys.length` → omit `enabledPlugins`
    (default all-enabled, backward-compatible, smaller payload);
  - else → `enabledPlugins: Array.from(selectedPlugins)` (including `[]` when
    the user unchecked everything).
- Placement: directly under the MCP servers checkbox block, same "Advanced
  options" area.

## Edge Cases

- **All unchecked:** submit `enabledPlugins: []` → session loads no plugins.
  Distinct from "field omitted = all enabled."
- **Persisted key gone at resume:** silently dropped by
  `getEnabledPluginAbsolutePathsFor`; session still spawns with the remaining
  subset.
- **git-subdir clone missing at spawn:** silently skipped (inherited guard);
  no clone is triggered by the new flow.
- **Backward compat:** old clients / API callers that omit `enabledPlugins`
  get current behavior (all enabled). No migration needed.

## Testing (TDD)

- `server/mp-store.test.ts`:
  - `getEnabledPluginAbsolutePathsFor` returns paths only for keys that are
    both in `keys` and `enabled === true`.
  - Disabled key passed in → dropped. Unknown key → dropped.
  - git-subdir with missing clone → skipped (no path emitted, no throw).
  - Dedupe preserved (two keys → same dir → one path).
- `server/routes/sessions.ts` (route tests):
  - `enabledPlugins` as a non-array string → 400.
  - Valid string array → threaded to `sm.create`.
- `server/session-manager.test.ts`:
  - `create()` persists `enabledPlugins` to meta (including `[]` vs
    `undefined` distinction).
  - resume/fork pass `meta.enabledPlugins` into provider createOpts (assert
    via mock provider).
- `server/providers/claude/claude-provider.test.ts` (or unit on
  `applyStandardQueryOpts`):
  - `enabledPlugins === undefined` → calls `getEnabledPluginAbsolutePaths`.
  - `enabledPlugins` present → calls `getEnabledPluginAbsolutePathsFor` with
    it; `[]` yields no plugin paths.
- Frontend (`NewSessionDialog` test):
  - Renders plugin checkboxes from `GET /mp/enabled-plugins`, all pre-checked.
  - All-checked → submit body omits `enabledPlugins`.
  - Subset → submit body includes the subset array.
  - All unchecked → submit body includes `enabledPlugins: []`.

## Files Touched (~10)

- `server/mp-store.ts` — 2 new methods
- `server/providers/types.ts` — `CreateSessionOptions.enabledPlugins`
- `server/providers/claude/claude-provider.ts` — conditional injection
- `server/session-types.ts` — `SessionMeta`/`SessionInfo` field
- `server/persistence.ts` — persist field
- `server/session-manager.ts` — create/resume/fork/clear/sideChat threading
- `server/routes/sessions.ts` — accept + validate `enabledPlugins`
- `server/routes/mp-marketplace.ts` — `GET /mp/enabled-plugins`
- `src/types.ts` — `NewSessionForm.enabledPlugins`
- `src/components/session-list/NewSessionDialog.tsx` — plugin checkbox block

## Non-Goals

- Live-session plugin add/remove (SDK-infeasible).
- Opt-in for globally-disabled plugins per session (ON-subset only by design).
- Surfacing "selected plugin failed to load at spawn" feedback (pre-existing
  silent-skip limitation, unchanged).
