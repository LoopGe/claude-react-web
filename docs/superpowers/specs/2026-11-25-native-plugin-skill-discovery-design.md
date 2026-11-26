# Native plugin-skill discovery — design

Date: 2026-11-25
Status: proposed

## Problem

A native-provider session cannot see plugin-sourced skills (`superpowers:*` and
similar). The claude provider gets them for free: it resolves enabled mp-store
plugins into `Options.plugins` local paths
(`server/providers/claude/claude-provider.ts:1001-1022`) and the CLI subprocess
scans each plugin's skills directories internally. The native provider has no
CLI subprocess and no plugin skill source — `listSkills` (`server/skills.ts:201`)
scans only the user and project roots. The A batch
(`2026-11-25-native-skill-cli-parity-design.md`) already widened the slash name
grammar to the canonical `plugin:skill` shape; this design adds the discovery
that feeds it.

Research basis: `docs/research/2026-11-25-native-slash-skill-discovery.md`
§5.6 (plugin contribution), §5.8 (CLI plugin skills-dir scan, binary-verified),
§4 (DSH contrast). DSH deep-dive facts cited inline.

## Goals

- **G1 — Discovery.** A native session surfaces the skills of every ENABLED
  mp-store plugin (the same set the claude provider injects), as `plugin:skill`
  entries in the `/` command catalog, the model-facing `Skill` tool, and the
  `<available_skills>` listing.
- **G2 — CLI-faithful scan.** Mirror the CLI's plugin skills-dir scan (§5.8):
  default `<pluginDir>/skills/` as a one-level root-of-subdirs, PLUS manifest
  `skills` (string|string[]) entries auto-detected as single skill dirs or
  subdirs-roots; per-branch name derivation; realpath dedup against user/project
  and cross-plugin.
- **G3 — Read-only + policy + picker.** Plugin skills are read-only (external
  clones), participate in the same per-session skill policy layer, and group in
  the command picker under their plugin name.
- **G4 — Live invalidation.** Enabling/disabling/refreshing a plugin reloads
  affected native sessions' skill catalogs and broadcasts `commands-changed`
  (the DSH `plugin-manager/changed → clearAll` lesson).

## Non-goals and anti-goals

- **Not plugin commands / agents / hooks / output-styles.** Only skills. The
  `supportsPlugins` capability stays `false` — it gates only the `togglePlugin` /
  `reloadPlugins` control routes (`session-manager.ts:7307,7520`), which native
  does not implement; plugin SKILL discovery is independent of that capability.
- **Not DSH's provider-registration model.** DSH plugins register skill providers
  programmatically via Cordis (`ctx.skills.registerProvider`,
  `packages/skill/skill/src/index.ts:393`; bare kebab names + rank/scope
  arbitration, no `plugin:skill`). CRW's plugin system is marketplace clones
  (CLI-shaped), so CRW follows the CLI directory-scan model, not Cordis providers.
- **Not plugin skill authoring.** Plugin skills are read-only; the skill-manager
  write/import/delete routes reject the plugin source. No editing of clone files.
- **Not the Plugins settings tab for native.** The client gate is
  provider-hardcoded (`SettingsPanel.tsx:258` `provider !== 'native'`); plugin
  enable/disable stays in the global marketplace panel. This design does not
  restore a native Plugins tab.
- **Not plugin skills in the skill-manager UI (decision Q1=b).** `GET /skills` and
  the read route `GET /skills/:scope/:name` stay user/project; plugin skills reach
  only the native catalog + the policy keyspace. Read-only UI display of plugin
  skills (and a plugin read path) is a separate future change.
- **Not bare-name allowlist suffix matching.** The policy allowlist matches the
  exact composed `plugin:skill` name. The CLI's `:name` suffix matching
  (§5.1) is a deferred nicety, not required for parity of visibility.
- **Anti-goal: a broken plugin failing the whole catalog.** Per-plugin scan
  failures are contained (DSH provider-failure containment,
  `skill/src/index.ts:605-611`); one unreadable plugin omits its skills, never
  rejects the discovery pass.

## Constraints

- **Neutral core boundary.** `server/providers/native/skills.ts` (the catalog)
  stays neutral — no host imports. Plugin discovery is HOST-side (mp-store is a
  host dependency); plugin records reach the catalog through the existing
  `NativeSkillPort.listSkills` seam (`native/ports.ts:66`, bound at
  `native-host-adapters.ts:91-93`). The catalog already re-stats/re-reads
  `record.path` (`native/skills.ts:132-134`), so plugin records must point at
  real, readable `SKILL.md` files.
- **Composed name on the record.** `:` is illegal in Windows directory names and
  `VALID_SKILL_NAME` rejects it; the `plugin:skill` name lives only on
  `record.name` (the catalog keys `byName` on it verbatim, `native/skills.ts:147`).
  The A-batch forward-compat test (`native/skills.test.ts:453-490`) already proves
  composed names flow through the catalog.
- **Name derivation differs from `readSkill`.** CLI root-scan uses the sanitized
  dir basename and IGNORES `frontmatter.name`; single-dir uses `frontmatter.name`
  first (§5.8). `readSkill` (`server/skills.ts:119-157`) instead enforces
  `frontmatter.name == dir-name`. The plugin scanner needs its own name logic, not
  `readSkill`'s contract.
- **mp-store path resolution.** Enabled plugin paths come from
  `getEnabledPluginAbsolutePaths()` / `...For(keys)` (`mp-store.ts:320-388`) —
  these are plugin DIRECTORIES (`ParsedPlugin.dir`), not marketplace clone roots;
  git-subdir paths are existence-guarded (lazy clone). The scanner starts from
  each plugin dir.
- **One frozen view per turn** (A-batch invariant) and the listing budget
  (A-batch G3) apply to plugin skills unchanged — they ride the same catalog.

## Decided approach

### Source and wiring (one opt-in merge point; UI unchanged — decision Q1=b)

- Host `listSkills(cwd?, pluginOpts?: { mpStore: MpStore; enabledPlugins?: string[] })`
  gains an OPT-IN plugin parameter. Without `pluginOpts` it returns user/project
  records exactly as today — the skill-manager UI `GET /skills` keeps this call, so
  the UI is unchanged. With `pluginOpts` it appends plugin records from a new
  `listPluginSkills(mpStore, enabledPlugins)` scanner. `enabledPlugins === undefined`
  = all enabled; `[]` = none (mirrors `CreateSessionOptions.enabledPlugins`,
  `providers/types.ts:68`).
- Plugin-aware callers: (1) the native skill port binding
  (`native-host-adapters.ts:91-93`) calls `listSkills(cwd, { mpStore, enabledPlugins })`;
  (2) the policy keyspace build `applyDynamicSkillOverrides`
  (`session-manager-skills.ts:161-176`) and `reapplyGlobalSkillsToInheritingSessions`
  call `listSkills(s.cwd, { mpStore: deps.mpStore, enabledPlugins: s.enabledPlugins })`,
  so mid-session disabled / allowlist / all cover plugin skills (this closes the
  policy hole — the keyspace and the catalog read the SAME plugin-aware source).
  The plain `GET /skills` UI route and the read route `GET /skills/:scope/:name`
  stay user/project; plugin skills are not listed or previewed there.
- `listPluginSkills` iterates enabled plugin ENTRIES via
  `mpStore.resolveEnabledPlugin(key)` (`mp-store.ts:303-313`), yielding
  `ParsedPlugin { name, dir, source }` — not the path-only
  `getEnabledPluginAbsolutePaths` — so the scanner has the catalog name, the plugin
  dir, and the source kind (needed for the marketplace-root exception and the
  prefix fallback). git-subdir dirs are existence-guarded (lazy clone).
- `NativeSkillPort.listSkills` gains the optional `enabledPlugins` parameter; the
  binding closure captures `mpStore` (injected into `NativeProvider`, mirroring
  claude's `opts.mpStore`). `NativeSessionOptions` carries `enabledPlugins`; the
  session stores it and forwards it to the catalog → port on reload.
  `NativeProvider` gains an optional `mpStore` (absent → no plugin skills, native
  still works).

### Scan shape (CLI-faithful, §5.8)

Per enabled plugin entry (catalog name `C`, dir `P`, source kind): the composed
prefix `N` = the plugin's own `.claude-plugin/plugin.json` `name` read fresh,
falling back to the catalog name `C` when plugin.json is absent (the CLI composes
from the plugin-manifest name, §5.8; CRW admits manifest-less plugin dirs, so the
catalog name is the fallback). `record.plugin` and the picker group label use `N`.
1. **Default root** `P/skills/` (if it exists): one-level `readdir`,
   directories/symlinks only, each `<entry>/SKILL.md`. Skill name = sanitized dir
   basename (`[^a-zA-Z0-9_-] → -`); `frontmatter.name` IGNORED (root-scan branch).
2. **Manifest `skills`** (string|string[]): each entry resolved relative to `P`
   with traversal containment; entries equal to the default `skills/` skipped.
   Auto-detect each: `SKILL.md` directly inside → single skill dir (name =
   `frontmatter.name` ?? basename, strip a leading `N:` prefix, sanitize); else →
   subdirs-root (name = sanitized basename per subdir). Loaded IN ADDITION to the
   default root — EXCEPT the CLI's marketplace-root case (§5.8): when the plugin
   source resolves to the marketplace/clone root (single-plugin repo,
   `ParsedPlugin.dir === cloneDir`), a manifest `skills` subdirectory declaration
   REPLACES the default `skills/` scan. The scanner detects this from the entry's
   source kind + dir vs the marketplace cloneDir.
3. **Fallback**: no `skills/` dir AND no manifest `skills` AND `P/SKILL.md`
   present → `P` itself is a single skill dir.
4. Composed name = `` `${N}:${skillName}` `` (join `rP`, §5.8).
5. **realpath dedup** against the user/project skill realpath set and
   cross-plugin (first wins; CLI `Eze` @256343862).
6. Read each `SKILL.md` (≤ `MAX_SKILL_BYTES`), parse frontmatter for
   description / disable-model-invocation / user-invocable / argument-hint;
   per-plugin/per-skill read failures contained (omit, warn, continue).
   **Plugin record validity is description + structure only** — frontmatter
   delimiter presence and a non-empty description. NAME-validation errors are
   EXCLUDED: the name is derived independently per branch, so the shared parser's
   bare `VALID_SKILL_NAME` check (`shared/skills.ts:93`) must not drop a root-scan
   (frontmatter.name ignored) or prefix-stripped skill. `parseSkillFrontmatter`'s
   name error is ignored for plugin records; its other errors (missing description,
   bad delimiters) still invalidate.

### Source marker, read-only, picker

- `SkillScope` widens to `'user' | 'project' | 'plugin'` (`shared/skills.ts:1`).
  `SkillRecord` gains `plugin?: string` (owning plugin name). Plugin records:
  `scope: 'plugin'`, `readOnly: true`, `valid` per frontmatter parse.
- `skillRoot` / `getSkillRoots` stay user/project (the writable roots); plugin
  discovery does not route through them. `isSkillScope` accepts `'plugin'`;
  the write/import/delete routes reject `'plugin'` (read-only). `projectRootOfSkill`
  returns null for plugin scope.
- Picker grouping: `commandsFor` (`native/skills.ts:258`) prefixes the description
  with `(<pluginName>) ` for plugin-scope records, so `CommandPicker.pluginTagOf`
  (`src/utils/text.ts:13-17`, `CommandPicker.tsx:52-67`) groups them under the
  plugin name. The model listing (`sectionFor`) keeps the plain description (the
  tag is a picker affordance, not model-facing).

### Policy

- Plugin records enter the policy keyspace under their exact composed name because
  `applyDynamicSkillOverrides` calls the PLUGIN-AWARE
  `listSkills(s.cwd, { mpStore, enabledPlugins })` (§ Source and wiring), so the
  override map covers `plugin:skill` names; `stateOf` matches `policy.includes(name)`
  (`native/skills.ts:297-300`). An allowlist must list the literal `plugin:skill`.
  `disable-model-invocation` / `user-invocable` frontmatter flags clamp exactly as
  for user/project skills (A-batch visibility model).

### Live invalidation (G4)

- Plugin enable/disable (`mp-store.setEnabled`, driven by the marketplace route)
  and marketplace refresh fan out a skill reload to affected native sessions,
  re-reading the catalog and broadcasting `commands-changed` (the existing
  `reloadSkillsForCwd` / `SessionSkillManager.reloadSkills` path,
  `session-manager-skills.ts:72-105`). This is the CRW analogue of DSH's
  `plugin-manager/changed → ui-skill clearAll` (`ui-skill/src/client/index.ts:254`).
- The reload trigger is keyed by repoGroup/cwd as the existing skill fan-out is;
  plugin enablement is global, so the fan-out reaches all live native sessions
  (a switched plugin contributes to the global enabled set every session reads).

## Left to builder

- The opt-in `listSkills` parameter threading through `NativeProvider` →
  `NativeSession` → catalog → port, and the policy callers' access to
  `deps.mpStore` + `s.enabledPlugins` (exact hook points).
- Manifest `skills` parse (string|string[]) + auto-detect + traversal containment
  implementation; the marketplace-root detection (dir vs cloneDir).
- A fresh per-scan read of `P/.claude-plugin/plugin.json` for the prefix name
  (mp-store caches only catalog metadata for marketplace-form repos).
- realpath dedup implementation (against user/project + cross-plugin).
- The plugin toggle/refresh → native skill-reload fan-out path (which route hooks
  it; whether `reloadSkillsForCwd` suffices or a plugin-specific fan-out is needed).
- `SkillScope 'plugin'` guard updates across write/import/delete + `isSkillScope`.
- Tests: scan shape (default root, manifest single-dir + root, marketplace-root
  exception, fallback), name derivation per branch + prefix authority, dedup,
  validity (name errors excluded), read-only guards, policy keyspace coverage,
  picker tag, toggle invalidation; neutrality/host-free pins stay green.