# Native Plugin-Skill Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native-provider sessions discover enabled mp-store plugins' skills as `plugin:skill` slash commands + model Skill-tool entries, mirroring the claude provider's set.

**Architecture:** A host-side scanner (`listPluginSkills`) reads enabled plugin entries from mp-store and scans each plugin's skills dirs in the CLI's shape (research §5.8). Host `listSkills` gains an OPT-IN plugin parameter; the native skill port and the policy keyspace use the plugin-aware form, while the skill-manager UI route stays user/project (decision Q1=b). Plugin records are read-only `scope:'plugin'`, ride the existing catalog (composed-name keys, frozen view, budget), and group in the picker via a `(pluginName)` description tag. Plugin toggle/refresh fans out a native skill reload.

**Tech Stack:** TypeScript, Node 20, vitest (server tests in Node). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-native-plugin-skill-discovery-design.md`
**Research:** `docs/research/2026-11-25-native-slash-skill-discovery.md` §5.8 (CLI scan oracle), §4 (DSH contrast).

## Global Constraints

- Neutral core: `server/providers/native/skills.ts` imports only `shared/*` + sibling vocabulary + Node builtins; plugin discovery is HOST-side, reaching the catalog through `NativeSkillPort.listSkills`. neutrality.test.ts + host-free.test.ts stay green.
- `shared/skills.ts` is browser-safe (no `node:path`).
- Composed `plugin:skill` name lives only on `record.name`; `VALID_SKILL_NAME` (bare) stays the filesystem/frontmatter validator; `CANONICAL_SKILL_NAME` (A batch) already accepts `:`.
- Plugin records: `scope:'plugin'`, `readOnly:true`, `plugin:<ownerName>`. Write/import/delete routes reject plugin scope (`isSkillScope` stays user/project).
- CLI scan fidelity (§5.8): default `skills/` one-level root-of-subdirs (name = sanitized dir basename, frontmatter.name IGNORED); manifest `skills` string|string[] auto-detect single-dir (frontmatter.name ?? basename, strip `N:` prefix) vs subdirs-root; marketplace-root exception (dir===cloneDir → manifest subdir REPLACES default); fallback pluginRoot/SKILL.md; one level, realpath dedup.
- Prefix `N` = plugin's `.claude-plugin/plugin.json` `name` read fresh, fallback catalog name `ParsedPlugin.name`.
- Plugin validity = description + structure only; NAME-validation errors excluded.
- `supportsPlugins` stays `false`. `enabledPlugins === undefined` = all enabled; `[]` = none.
- Errors loud; `createLogger(scope)` only. Commit header ≤100 chars (commitlint); end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Verify: targeted `npx vitest run <file>`; `npm run typecheck` before final commit. A parallel session may pollute the FULL suite with timing/fs flakes — judge scoped/isolation runs, diagnose environmental failures (pass in isolation), never attribute them to this branch.

## Review Focus

- A manifest-less plugin dir (no plugin.json) still surfaces skills under the catalog-name prefix — not skipped. (Task 2 test)
- A git-subdir plugin whose external clone is absent is silently omitted, never crashes the pass. (Task 1/2 test)
- A plugin skill whose frontmatter.name fails the bare grammar is still valid and surfaced (name derived independently). (Task 2 test)
- A single-plugin repo (dir===cloneDir) with a manifest skills subdir does NOT double-load the default skills/ scan. (Task 2 test)
- Toggling a plugin mid-session reloads the native catalog and pushes commands-changed (no stale picker). (Task 5 test)

## File Structure

- `shared/skills.ts` — `SkillScope` + `'plugin'`; `SkillRecord.plugin?`.
- `server/mp-store.ts` — public `getEnabledPluginEntries()` accessor.
- `server/plugin-skills.ts` (CREATE) — `listPluginSkills` scanner (CLI shape).
- `server/skills.ts` — opt-in `listSkills(cwd?, pluginOpts?)` merge + realpath dedup.
- `server/providers/native/ports.ts`, `native-host-adapters.ts`, `native-provider.ts`, `native-session.ts`, `native/skills.ts` — port/provider/session/catalog wiring + picker tag.
- `server/providers/default-providers.ts` — pass mpStore to ports.
- `server/session-manager-skills.ts`, `session-manager.ts` — plugin-aware policy keyspace.
- `server/mp-ops.ts` — toggle/refresh native skill-reload fan-out.

---

### Task 1: Plugin source type + mp-store entry accessor

**Files:**
- Modify: `shared/skills.ts:1` (SkillScope), `:130-151` (SkillRecord)
- Modify: `server/mp-store.ts` (add public accessor near `enabledPluginEntries` :425)
- Test: `server/mp-store.test.ts` (or the existing mp-store test file)

**Interfaces:**
- Produces:
  - `SkillScope = 'user' | 'project' | 'plugin'`; `SkillRecord.plugin?: string`.
  - `MpStore.getEnabledPluginEntries(): Array<{ key: string; name: string; dir: string; source?: ParsedPluginSource; cloneDir: string }>` — enabled plugins, dir resolved like `getEnabledPluginAbsolutePaths` (git-subdir → `externalCloneDir(url,sha)/subPath` guarded by `existsSync`; in-repo → `plugin.dir`), deduped by dir, carrying catalog `name`, `source`, and the marketplace `cloneDir` (`entry.cloneDir`).

- [ ] **Step 1: Write the failing accessor test** — construct an MpStore at a temp dir with one marketplace whose manifest has an in-repo plugin (dir set) and enable it; assert `getEnabledPluginEntries()` returns `[{ key:'p@m', name:'p', dir:<pluginDir>, cloneDir:<cloneDirFor('m')>, ... }]`. Add a disabled-plugin case (omitted) and a git-subdir plugin whose external clone is absent (omitted, no throw). Also pin the read-only guard (server/skills.test.ts): `createSkill({scope:'plugin',...})` and `deleteSkill('plugin',...)` throw 400 — `isSkillScope` stays user/project, so widening the SkillScope TYPE must not widen the writable guard.

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/mp-store.test.ts`. Expected: FAIL (`getEnabledPluginEntries is not a function`).

- [ ] **Step 3: Implement** — widen `SkillScope`/`SkillRecord` in shared/skills.ts (browser-safe). Add `getEnabledPluginEntries()` to MpStore: iterate `this.enabled`, `resolveEnabledPlugin(key)`, resolve dir (mirror `getEnabledPluginAbsolutePaths`'s git-subdir/in-repo branches + existsSync guard), dedupe by dir, push `{ key, name: plugin.name, dir, source: plugin.source, cloneDir: this.get(marketplaceId)!.cloneDir }`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/mp-store.test.ts server/skills.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/skills.ts server/mp-store.ts server/mp-store.test.ts server/skills.test.ts
git commit -m "feat(skills): plugin scope type + mp-store enabled-entry accessor

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Plugin skill scanner + opt-in listSkills merge

**Files:**
- Create: `server/plugin-skills.ts`
- Modify: `server/skills.ts:201-204` (listSkills opt-in + dedup)
- Test: `server/plugin-skills.test.ts` (CREATE), `server/skills.test.ts`

**Interfaces:**
- Consumes: `MpStore.getEnabledPluginEntries()` (Task 1); `SkillRecord` plugin field; `parseSkillFrontmatter`, `MAX_SKILL_BYTES` (shared/skills).
- Produces:
  - `listPluginSkills(mpStore: MpStore, enabledPlugins?: string[]): Promise<SkillRecord[]>` — plugin records, `scope:'plugin'`, `readOnly:true`, `plugin:N`, composed `name:` `${N}:${skillName}`.
  - `listSkills(cwd?: string, pluginOpts?: { mpStore: MpStore; enabledPlugins?: string[] }): Promise<{ roots: SkillRootInfo[]; skills: SkillRecord[] }>` — without pluginOpts unchanged; with, appends plugin records minus realpath collisions with user/project.

- [ ] **Step 1: Write the failing scanner tests** — `server/plugin-skills.test.ts`, temp plugin dirs + a stub MpStore-like object exposing `getEnabledPluginEntries()`. Cases (exact expectations):
  - default root: `P/skills/brainstorming/SKILL.md` (frontmatter `name: ignored`) → record name `superpowers:brainstorming` (dir basename, frontmatter ignored), `plugin:'superpowers'`, `scope:'plugin'`, `readOnly:true`.
  - manifest single-dir: plugin.json `skills:['./skills/tdd']`, `tdd/SKILL.md` frontmatter `name: tdd` → `superpowers:tdd` (frontmatter name).
  - marketplace-root exception: entry `dir===cloneDir`, plugin.json `skills:['./custom']` with `custom/SKILL.md`, AND a `skills/other/SKILL.md` present → only `superpowers:<custom-skill>` surfaced, NOT `skills/other`.
  - fallback: no skills/, no manifest skills, `P/SKILL.md` → `N:<basename(P)>`.
  - prefix authority: plugin.json `name:'real-name'` differs from catalog `name:'catalog-name'` → prefix `real-name`; no plugin.json → prefix `catalog-name`.
  - validity: a SKILL.md whose frontmatter.name is `weird:name` (fails bare grammar) but description present → record `valid:true` (name error excluded); missing description → `valid:false`.
  - cross-plugin realpath dedup: two plugins symlink the same SKILL.md realpath → first wins.
  - contained failure: one plugin dir unreadable → its skills omitted, others surfaced, no throw.

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/plugin-skills.test.ts`. Expected: FAIL (module/function missing).

- [ ] **Step 3: Implement `listPluginSkills`** in server/plugin-skills.ts. Per entry: read `P/.claude-plugin/plugin.json` fresh for `name` (fallback catalog name) = `N`; determine `isRoot = (dir === cloneDir)`; collect skill dirs:
  - default `P/skills/` root-of-subdirs (readdir dirs/symlinks → `<e>/SKILL.md`, name = sanitize(basename));
  - manifest `skills` (string|string[]) resolved relative to P with traversal containment, skip entries equal to default; if `isRoot` and manifest declares a subdir → REPLACE default; auto-detect each entry (SKILL.md directly → single dir, name = frontmatter.name ?? basename stripped of `N:` prefix sanitized; else subdirs-root);
  - fallback `P/SKILL.md` when neither present.
  Read each SKILL.md (≤MAX_SKILL_BYTES), `parseSkillFrontmatter`; validity = description non-empty + delimiters ok, IGNORING the name error; compose `${N}:${skillName}`; realpath dedup (cross-plugin first-wins). Contain per-plugin/per-skill failures (warn + omit). Use `createLogger('plugin-skills')`.

- [ ] **Step 4: Run scanner pass** — `npx vitest run server/plugin-skills.test.ts`. Expected: PASS.

- [ ] **Step 5: Write the failing merge test** — `server/skills.test.ts`: `listSkills(cwd)` unchanged (user/project only); `listSkills(cwd, { mpStore })` includes plugin records; a plugin skill whose realpath equals a user skill's realpath is dropped from the plugin set.

- [ ] **Step 6: Implement the merge** — `listSkills(cwd, pluginOpts?)`: collect user/project as today; if pluginOpts, `pluginRecords = await listPluginSkills(pluginOpts.mpStore, pluginOpts.enabledPlugins)`, drop any whose `fs.realpathSync(path)` matches a user/project realpath, append. `roots` stays user/project.

- [ ] **Step 7: Run pass** — `npx vitest run server/plugin-skills.test.ts server/skills.test.ts`. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/plugin-skills.ts server/plugin-skills.test.ts server/skills.ts server/skills.test.ts
git commit -m "feat(skills): CLI-shaped plugin skill scanner + opt-in listSkills

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Native wiring (port → provider → session → catalog) + picker tag

**Files:**
- Modify: `server/providers/native/ports.ts:66-68`, `server/providers/native-host-adapters.ts:23-35,90-92`, `server/providers/default-providers.ts:56`, `server/providers/native/native-provider.ts:281+`, `server/providers/native/native-session.ts:327-329,554-556`, `server/providers/native/skills.ts` (catalog enabledPlugins + commandsFor tag)
- Test: `server/providers/native/skills.test.ts`, `server/providers/native/e2e-skills.test.ts`

**Interfaces:**
- Consumes: `listSkills(cwd, pluginOpts?)` (Task 2).
- Produces:
  - `NativeSkillPort.listSkills(cwd?: string, enabledPlugins?: string[]): Promise<{ roots; skills }>`.
  - `NativeHostPortsDeps.mpStore?: MpStore`; binding `listSkills: (cwd, enabledPlugins) => listSkills(cwd, deps.mpStore ? { mpStore: deps.mpStore, enabledPlugins } : undefined)`.
  - `NativeSessionOptions.enabledPlugins?: string[]`; catalog constructed with it; `NativeSkillCatalog.reload` forwards it to the port.
  - `commandsFor` prefixes `(<plugin>) ` to the description for `scope:'plugin'` records (picker grouping via `pluginTagOf`).

- [ ] **Step 1: Write the failing catalog test** — `skills.test.ts`: a stub port returning a plugin record (`scope:'plugin'`, `plugin:'superpowers'`, name `superpowers:demo`) → `catalog.commands()` entry description starts `(superpowers) `; `catalog.expand('superpowers:demo','a b')` works. Add an enabledPlugins-forwarding test: the catalog passes its enabledPlugins to `port.listSkills` (spy).

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/providers/native/skills.test.ts`. Expected: FAIL (tag/forwarding absent).

- [ ] **Step 3: Implement wiring** — widen the port signature; add `mpStore` to `NativeHostPortsDeps` + the binding; pass `mpStore: opts.mpStore` in default-providers:56; add `enabledPlugins` to `NativeSessionOptions`, forward from `createSession` (`opts.enabledPlugins`), pass it as a third constructor arg to `NativeSkillCatalog(cwd, skillPort, enabledPlugins)` and forward in `reload`; `commandsFor` adds the `(plugin)` tag for plugin-scope records (model `sectionFor` description stays plain).

- [ ] **Step 4: Run pass** — `npx vitest run server/providers/native/skills.test.ts server/providers/native/e2e-skills.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/ports.ts server/providers/native-host-adapters.ts server/providers/default-providers.ts server/providers/native/native-provider.ts server/providers/native/native-session.ts server/providers/native/skills.ts server/providers/native/skills.test.ts
git commit -m "feat(native): wire plugin skills through port, session, catalog

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Plugin-aware policy keyspace

**Files:**
- Modify: `server/session-manager-skills.ts:36-67` (SkillManagerDeps), `:160-189` (applyDynamicSkillOverrides)
- Modify: `server/session-manager.ts` (wire deps.mpStore)
- Test: `server/session-manager-skills.test.ts` (or the existing skill-policy test)

**Interfaces:**
- Consumes: `listSkills(cwd, pluginOpts?)` (Task 2); `Session.enabledPlugins` (session-types.ts:589).
- Produces: `SkillManagerDeps.mpStore?: MpStore`; `applyDynamicSkillOverrides` builds the override map from the plugin-aware `listSkills(s.cwd, deps.mpStore ? { mpStore: deps.mpStore, enabledPlugins: s.enabledPlugins } : undefined)`.

- [ ] **Step 1: Write the failing policy test** — a live native session with a plugin skill `superpowers:demo` available; `setSkillOverride(id, {kind:'disabled'})` → the `applyFlagSettings({skillOverrides})` map contains `'superpowers:demo':'off'`; `{kind:'mode',mode:'allowlist',allowlist:['superpowers:demo']}` → `'superpowers:demo':'on'` and other plugin skills `'off'`. (Stub the provider handle's applyFlagSettings to capture the map; stub listSkills via a temp mpStore or inject.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/session-manager-skills.test.ts`. Expected: FAIL (plugin name absent from map).

- [ ] **Step 3: Implement** — add `mpStore?` to SkillManagerDeps; in applyDynamicSkillOverrides call the plugin-aware listSkills (reapplyGlobalSkillsToInheritingSessions inherits via applyDynamicSkillOverrides). Wire `mpStore` into the deps where SessionManager constructs SessionSkillManager.

- [ ] **Step 4: Run pass** — `npx vitest run server/session-manager-skills.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/session-manager-skills.ts server/session-manager.ts server/session-manager-skills.test.ts
git commit -m "feat(skills): plugin-aware policy override keyspace

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Plugin toggle/refresh → native skill-reload fan-out

**Files:**
- Modify: `server/mp-ops.ts:175-199` (applyPluginToggleToLiveSessions), refresh path
- Test: `server/mp-ops.test.ts` (or the marketplace-ops test)

**Interfaces:**
- Consumes: `SessionManager.reloadSkills(id)` / `reloadSkillsForCwd(cwd?)` (existing); native catalog plugin-aware (Task 3).
- Produces: native sessions reload their skill catalog on plugin toggle/refresh and broadcast `commands-changed`.

- [ ] **Step 1: Write the failing fan-out test** — a running native session; `applyPluginToggleToLiveSessions(sm, key, enabled)` calls `sm.reloadSkills(id)` for the native session (spy), and the catalog re-reads the enabled set. Assert a claude session still gets togglePlugin+reloadPlugins (unchanged).

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/mp-ops.test.ts`. Expected: FAIL (native reload not called).

- [ ] **Step 3: Implement** — in applyPluginToggleToLiveSessions, branch per session provider: native (info.provider==='native') → `await sm.reloadSkills(id)`; claude → existing togglePlugin+reloadPlugins. Hook the marketplace refresh path to `sm.reloadSkillsForCwd()` (all native sessions) after a refresh mutates plugin dirs. Keep per-session failure containment.

- [ ] **Step 4: Run pass** — `npx vitest run server/mp-ops.test.ts`. Expected: PASS.

- [ ] **Step 5: Full gate + commit** — `npm run typecheck` clean; scoped native + skills + mp suites green (diagnose any environmental full-suite flakes in isolation), then:

```bash
git add server/mp-ops.ts server/mp-ops.test.ts
git commit -m "feat(native): reload skill catalog on plugin toggle/refresh

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm run typecheck` clean.
- [ ] Scoped suites green: `npx vitest run server/plugin-skills.test.ts server/skills.test.ts server/mp-store.test.ts server/providers/native/skills.test.ts server/providers/native/e2e-skills.test.ts server/session-manager-skills.test.ts server/mp-ops.test.ts`; neutrality/host-free pins green.
- [ ] `npm run lint` clean on touched files.
- [ ] Whole-branch code review before merge (CLAUDE.md: never commit unreviewed code).