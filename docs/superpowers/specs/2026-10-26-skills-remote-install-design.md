# Skills remote install — search + clone + import

Date: 2026-10-26

## Problem

Installing an Agent Skill today requires the skill folder to already be on the
server (or dragged in from the browser). There is no way to discover or fetch
skills from the public ecosystem. The reference experience is the `skills` CLI
(`npx skills`):

- `npx skills find <q>` searches a public catalog and prints `owner/repo@skill`
- `npx skills add <owner/repo>` clones the repo, lists every `SKILL.md` inside,
  and lets you multi-select which to install

We want both shapes in the web UI, on the existing Skills tab.

Research findings (verified against `skills@1.7.4` bundle + live probes):

- Search backend is `GET https://skills.sh/api/search?q=&limit=&owner=`,
  **public, no auth**. Returns `{id, source, skillId, name, installs}` —
  **no description**. Sorted by installs desc. (`SEARCH_API_BASE` is
  overridable via `SKILLS_API_URL` in the CLI; we will hardcode skills.sh.)
- The detail/files API on skills.sh requires Vercel OIDC — **not usable** from
  our server. So skill *content* can never come from the catalog; it always
  comes from cloning the source repo.
- `skills add` clones to a temp dir, then `discoverSkills`: recursive scan
  (depth ≤ 5) for directories containing `SKILL.md`, skipping
  `node_modules/.git/dist/build` etc.
- Install targets it uses for Claude Code are `./.claude/skills` (project) and
  `join(claudeHome, 'skills')` (global) — **identical to our `skillRoot()`**.
  So a clone+copy into that root is exactly what our
  `importSkillFromPath` already does.

## Goal / non-goals

- **Goal:** search box on the Skills tab that queries the skills.sh catalog and
  lists hits with name / source repo / install count.
- **Goal — quick install:** each search-result row has an `Install` button that
  installs that one skill immediately (find's interactive flow).
- **Goal — batch install:** a way to open the source repo and multi-select
  among its skills, with descriptions (add's flow, the reference screenshot).
- **Goal:** both Project and User scope, reusing the existing scope toggle.
- **Goal:** the existing "Install from folder" import (server path / drag-drop /
  local folder) stays untouched and keeps working.
- **Non-goal (v1):** `skills-lock.json` / `update` / `check`. There is no
  provenance and no "is there a newer version" check; updating is "tick
  Replace existing and install again" (§4).
- **Non-goal (v1):** private repositories. Public only — this is inherited
  from the project's git access layer, not a skills-specific cut:
  `server/git-clone.ts` is https-only and non-interactive by design
  (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `GCM_INTERACTIVE=never`), so a
  clone needing credentials fails fast. The marketplace uses the same layer
  with the same limit. Adding private support later means teaching
  `git-clone.ts` about credentials once, and both surfaces gain it.
- **Non-goal (v1):** symlink install mode. We copy (existing
  `importSkillFromPath` semantics).
- **Non-goal (v1):** non-GitHub hosts (GitLab / Azure / arbitrary git URLs),
  `.well-known` discovery, direct `SKILL.md`/zip download URLs, npm-packaged
  skills. GitHub `owner/repo` only.
- **Non-goal:** audit/security badges (skills.sh audit API is also OIDC-gated).

## Design

### 1. Two entry shapes on the Skills tab

A new section **above** the existing "Install from folder", headed
**Browse skills**. The existing three sections (Session Skill Loading /
Install from folder / Installed Skills) do not move.

The section has one text input plus a results list. The input accepts two
things:

- a **keyword** → run a catalog search
- an **`owner/repo` token** (or a `github.com/owner/repo` URL) → offer to open
  that repo directly (this is the `npx skills add owner/repo` path from the
  reference screenshot)

Input classification is a single regex: `/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/`.
A match shows an "Open repository" affordance *in addition to* running the
keyword search, so both paths stay one keystroke away.

### 2. Search results list (quick install)

Each row: skill `name`, source `owner/repo`, install count. **No description** —
the catalog does not return one and npx has none either. Sorted by installs
desc, limit 20.

Row actions:

- **Install** — installs just this skill (§4), into the scope currently
  selected by the existing Project/User toggle. While installing the button
  shows `Installing…` and disables; on success the row flips to `✓ Installed`
  (matching an `Installed Skills` entry by `name`); on failure the row shows
  the error inline and the button returns.
- **Browse** — opens the batch picker for that row's source repo (§3).

**Search hit → one discovered skill (my call).** The catalog row carries
`skillId` (the repo-relative slug, in practice the directory basename) and
`name`. Matching against `cloneAndDiscover`'s output is:

1. `basename(relativePath) === skillId` — exact, preferred
2. else `discovered.name === name` (the frontmatter-or-basename name
   `importSkillFromPath` would install under)
3. **zero matches** → inline error on the row, `Not found in <source>`, with
   the `Browse` button still live so the user can fall through to the picker.
   Never silently open the picker as a substitute.
4. **more than one match** (two dirs whose basename collides) → install the
   first by step 1's order and show a `2 matches` warning on the row. Do not
   build disambiguation UI.

Debounce input by 300 ms. Empty input clears the list. A failed search shows a
single inline error line, never a toast.

### 3. Batch picker (multi-select)

Opened by a row's **Browse**, or by the "Open repository" affordance.

Server clones the repo (§5), runs discovery, and returns
`[{ name, description, relativePath }]`. The picker is a modal overlay styled
like the reference screenshot:

- title `Select skills to install`, subtitle `owner/repo · N skills found`
- a filter input (`Search:`) that filters the list client-side
- a `Select All (x/N)` toggle row at the top
- one checkbox row per skill: name + description (description is available
  here because the clone already happened — this is the one place it appears)
- footer: current scope + `Replace existing` checkbox (§4) + `Cancel` +
  `Install N skills`

`Install N skills` imports every checked skill (§4). **The modal does not
close on click (my call)** — it stays open and each row flips to `✓` or to its
inline error as the response lands, so a partial failure is visible where the
user is looking. The footer button becomes `Done` once the response is in, and
only then does the modal close. Closing on click and reporting `failed[]`
afterwards would make exactly the failures this API shape exists to surface
invisible. Checkbox state is purely client-side and resets each time the
picker opens.

### 4. Install = clone once, copy each selected skill

One install operation (quick or batch) for a given `owner/repo`:

1. `git clone --depth 1 https://github.com/<owner>/<repo>.git <tmpdir>`
2. `discoverSkills` — recursive scan for `SKILL.md` dirs (depth ≤ 5, skip
   `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `coverage`,
   `vendor`), reading `description` from each `SKILL.md`'s frontmatter via the
   existing `parseSkillFrontmatter`.
3. For each selected skill, call the existing `importSkillFromPath({ scope,
   cwd, path: <tmpdir>/<relativePath>, name, overwrite })`.
4. `rm -rf <tmpdir>`.

Because step 3 is the existing importer, everything downstream — validation,
frontmatter name/directory-name match, overwrite semantics, `reloadSkillsForCwd`
hot-reload — is already correct and needs no changes.

**Root-level skills are in scope (my call).** A repo whose *root* is the skill
(`SKILL.md` at the clone root, a common single-skill packaging) must install,
because the catalog is full of them. But `importSkillFromPath` copies its
source directory verbatim and has no skip list, so pointing it at the clone
root would drag in `.git` and blow the 200-file cap. So `cloneAndDiscover`
reports such a skill with `relativePath: ''`, and the install step **stages**
every selected skill into a clean temp dir first — copying only the skill
subtree with the same skip list the discovery walk uses
(`node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `coverage`,
`vendor`) — then calls `importSkillFromPath` on the staged dir. Nested skills
are staged the same way, so the two cases share one code path and the importer
stays untouched.

**Overwrite policy (chosen: explicit replace).** Remote install — both quick
and batch — exposes a **Replace existing** checkbox, default **unchecked**,
mirroring the wording and behavior of the folder importer's checkbox so one
phrase means one thing across the tab. Unchecked and the name already exists in
the target scope → that skill fails with the existing 409 `Skill already
exists` and the error is surfaced; the rest of the batch continues. Checked →
`overwrite: true` is sent and the existing entry is replaced. This is what
makes "update a skill" reachable: tick Replace and install again. The checkbox
lives in the Browse-skills section header (quick install) and in the picker
footer next to the scope readout (batch), one instance per flow.

### 5. Server API

Three new routes, mounted in the existing skills router
(`server/routes/skills.ts`) so auth and `HttpError` handling come for free:

```
GET  /api/skills/search?q=&limit=          → { skills: [{ name, source, skillId, id, installs }] }
POST /api/skills/remote/preview            → { source, skills: [{ name, description, relativePath }] }
POST /api/skills/remote/install            → { installed: [...], failed: [{ name, error }] }
```

**Install keys on `relativePath`, not `name` (my call).** The `install` body is
`{ source, scope, cwd?, paths: string[], overwrite? }` where `paths` are the
`relativePath` values `preview` returned. `name` is not a key: the importer
installs under `frontmatter.name ?? basename`, so the picker's label, the
request key, and the on-disk name can legitimately be three different strings,
and two `SKILL.md`s in one repo may share a frontmatter name. `relativePath` is
unique and is already what the picker has in hand. The response's
`installed`/`failed` entries still report the resolved `name` for display.

**`search`** — server-side proxy of `https://skills.sh/api/search`. Rejects
`q.length < 2`. Caps `limit` at 50, default 20. Forwards the JSON body
unchanged. The proxy exists so the browser never talks to skills.sh directly
(no CORS dependency on a third party) and so a future cache lives in one place.
v1 adds no cache — the catalog itself is CDN-cached for 30–60 s.

**`preview`** — body `{ source }` where `source` is `owner/repo`. Validates
against `/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/`, clones, discovers, returns the
list, and **keeps the temp dir keyed by `source`** for a short window (see §6)
so the subsequent `install` does not re-clone.

**`install`** — body `{ source, scope, cwd?, paths: string[], overwrite? }`.
Reuses the temp dir if still present, else clones. Imports each selected skill,
collecting per-skill success/failure into `installed` / `failed` (one bad skill
must not abort the batch). Returns 200 with both lists; 400 only for a bad
`source` / `scope` / empty `paths`.

Both `preview` and `install` call the same internal `cloneAndDiscover(source)`
helper in a new `server/skills-remote.ts`. That helper owns URL construction
(`https://github.com/${source}.git`), the clone, the discovery walk, and temp
lifecycle. **The clone itself is the existing `gitClone` from
`server/git-clone.ts`** — the same call the marketplace makes
(`mp-ops.ts` / `app-plugins/marketplace-ops.ts`) — so skills inherit its
`assertHttpsUrl` gate, `--depth 1 --single-branch` shape, `--` URL guard,
timeout, output cap, and trimmed stderr surfacing for free. Do not hand-roll
another `execFile('git', …)`.

### 6. Clone safety and lifecycle

- **Host allowlist:** only `github.com`. The URL is *constructed* from the
  validated `owner/repo`, never taken from user text — so this is not an SSRF
  surface in the usual sense. A `github.com/...` URL the user typed is first
  reduced to `owner/repo` by the same regex, then reconstructed. The
  constructed URL still goes through `assertHttpsUrl` inside `gitClone`.
- **Temp dir:** `fs.mkdtemp` under the OS tmp dir. One dir per
  `cloneAndDiscover` call, tracked in an in-memory `Map<source, { dir,
  expiresAt }>`. TTL 10 minutes, swept every 60 s by a `setInterval` in the
  module (unref'd). A clone failure rejects; the map entry is not created.
  Note `gitClone` requires the destination **not** to exist, so clone into
  `<mkdtemp-result>/repo` (or `rm` the mkdtemp dir first) rather than into the
  mkdtemp dir itself.
- **Clone:** `gitClone(url, dest)` from `server/git-clone.ts` — `--depth 1
  --single-branch`, non-interactive (credential prompts fail fast), `--` URL
  guard, `CLONE_TIMEOUT_MS`, `MAX_BUFFER_BYTES` cap, trimmed stderr in errors.
  Same call and same limits the marketplace clones under. No credentials are
  read or passed.
- **Size guard:** discovery stops walking any single directory tree at 5
  (`SKILL.md` may live at any depth ≤ 5), and a `SKILL.md` larger than the
  existing `MAX_SKILL_BYTES` is skipped rather than read.

### 7. Client surface

`src/components/GlobalSettingsModal.tsx` `SkillsTab` gains a
`RemoteInstallSection` above the current import group, and a
`BatchPickerModal` overlay. Both live in that file next to the existing
sections (this file already holds several tabs' worth of subcomponents).

State is local to `SkillsTab`:

```
searchQuery, searchResults, searchError, searching
previewSource, previewSkills, previewLoading
selectedPaths: Set<string>       // relativePath keys — see §5
installing: Set<string>          // search-row ids currently installing (quick)
```

Existing `refresh()` is called after any successful install so
`Installed Skills` and the `✓ Installed` marks stay true. The existing
`importScope` (Project/User) governs remote installs too — one toggle, no
second scope control.

Error text comes back from the API and is rendered inline on the row or in the
picker footer. No new toasts.

### 8. Styling

All colors via existing theme CSS variables (no hex). New class names follow
the existing `settings-skill-*` convention
(`settings-skill-remote-group`, `settings-skill-result-row`,
`settings-skill-picker`, …) and live beside the current skill styles. Light
and dark both work through the variables already defined in `:root` and
`[data-theme="light"]`.

## What's left to the builder

- Exact debounce / request-cancel behaviour for the search box (AbortController
  on the in-flight fetch is the obvious shape).
- Where `cloneAndDiscover`'s 60 s sweeper interval is started and stopped —
  module-level `setInterval` + `unref()` is fine; don't overthink it.
- The precise icon glyphs for Install / Browse / ✓ Installed — reuse whatever
  `IconSparkles` / `IconRefresh` set the tab already pulls from.
- Unit-test shape for `cloneAndDiscover` (mock `gitClone`, feed a fixture tree).
  Test discovery + import mapping; do not test against the network.
- Whether `preview` should return `invalid` skills (present `SKILL.md` but
  failing frontmatter) in the list with an `errors` field, or hide them.
  Hiding is fine; showing them is fine. Pick one and be consistent.
