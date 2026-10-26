# Skills Remote Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users search the public skills.sh catalog and install Agent Skills into `.claude/skills` from the web UI, either one-at-a-time from search results or multi-select from a cloned repo.

**Architecture:** A new `server/skills-remote.ts` owns clone→discover→stage→import. Discovery walks a cloned tree for `SKILL.md` dirs; install stages each selected skill into a clean temp dir (skip list) and hands it to the existing `importSkillFromPath`, so validation/overwrite/hot-reload are unchanged. Three routes on the existing skills router: a search proxy to skills.sh, plus preview/install. The client adds a `RemoteInstallSection` and a `BatchPickerModal` inside the existing `SkillsTab`.

**Tech Stack:** TypeScript, Hono routes, vitest, React 19 + existing `api` fetch wrapper. Clone via the existing `gitClone` in `server/git-clone.ts` (no new `execFile`).

**Spec:** `docs/superpowers/specs/2026-10-26-skills-remote-install-design.md`

## Global Constraints

- Git clone goes through `gitClone` from `server/git-clone.ts` — never a hand-rolled `execFile('git', …)`, never a shell.
- Only `github.com`. URL is constructed as `https://github.com/${owner}/${repo}.git` from a validated `owner/repo`, never taken from user text.
- All UI colors via theme CSS variables (`var(--…)`). No hardcoded hex. New classes use the `settings-skill-*` prefix.
- Client code never imports `@anthropic-ai/claude-agent-sdk`; use the existing `api` wrapper from `src/hooks/useApi`.
- Existing "Install from folder" flow must be untouched.
- `npm run typecheck` runs both tsconfigs and must pass (`tsc -p tsconfig.json` + `tsc -p tsconfig.node.json`).
- Diagnostic logging only via `createLogger(scope)`; no bare `console.*`.
- Every commit message ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Tests run under vitest; server tests in Node, client tests with jsdom (`environmentMatchGlobs`). Never add per-file `afterEach(cleanup)` — `src/test-setup.ts` already registers it.

## Review Focus

- **A repo whose root is the skill** (`SKILL.md` at clone root): must install without dragging `.git` into the import. → Task 4 staging test `stages a root-level skill without .git or node_modules`.
- **Partial batch failure**: one 409 must not abort the rest of the batch. → Task 4 test `continues past a failing skill and reports it in failed[]`.
- **Replace unchecked + name exists**: that skill reports the 409 text inline; the modal stays open. → Task 4 test `reports Skill already exists per-skill when overwrite is false`.
- **Search hit matches nothing in the cloned repo**: row shows `Not found in <source>` and Browse stays clickable — never silently falls through to the picker. → Task 1 test `returns zero matches when neither skillId nor name matches`.
- **Two `SKILL.md`s sharing a frontmatter name** in one repo: install is keyed by `relativePath`, so both must be addressable and the response reports the resolved name. → Task 4 test `installs two skills that share a frontmatter name by relativePath`.

---

### Task 1: Shared types + owner/repo parsing + search-hit matching

**Files:**
- Modify: `shared/skills.ts`
- Test: `shared/skills.test.ts`

**Interfaces:**
- Produces: `RemoteSearchHit`, `DiscoveredSkill`, `RemotePreviewResponse`, `RemoteInstallRequest`, `RemoteInstallResponse`, `parseOwnerRepo(input: string): { owner: string; repo: string } | null`, `matchSearchHit(skills, hit): { skill: DiscoveredSkill | null; matchCount: number }`. All later tasks consume these.

- [ ] **Step 1: Write the failing tests** in `shared/skills.test.ts`

```ts
import { matchSearchHit, parseOwnerRepo } from './skills.js'

describe('parseOwnerRepo', () => {
  it('accepts owner/repo shorthand', () => {
    expect(parseOwnerRepo('vercel-labs/agent-skills')).toEqual({ owner: 'vercel-labs', repo: 'agent-skills' })
  })
  it('accepts a github.com URL and strips .git', () => {
    expect(parseOwnerRepo('https://github.com/vercel-labs/agent-skills.git')).toEqual({ owner: 'vercel-labs', repo: 'agent-skills' })
  })
  it('rejects non-github hosts and bare words', () => {
    expect(parseOwnerRepo('https://gitlab.com/a/b')).toBeNull()
    expect(parseOwnerRepo('react')).toBeNull()
    expect(parseOwnerRepo('a/b/c')).toBeNull()
  })
})

describe('matchSearchHit', () => {
  const skills = [
    { name: 'pdf', description: '', relativePath: 'skills/pdf' },
    { name: 'docx', description: '', relativePath: 'skills/docx' },
    { name: 'pdf', description: '', relativePath: 'other/pdf' },
  ]
  it('prefers basename(relativePath) === skillId', () => {
    const r = matchSearchHit(skills, { skillId: 'docx', name: 'pdf' })
    expect(r.skill?.relativePath).toBe('skills/docx')
    expect(r.matchCount).toBe(1)
  })
  it('falls back to discovered name when skillId misses', () => {
    const r = matchSearchHit([{ name: 'pdf', description: '', relativePath: 'skills/pdf' }], { skillId: 'nope', name: 'pdf' })
    expect(r.skill?.relativePath).toBe('skills/pdf')
    expect(r.matchCount).toBe(1)
  })
  it('returns zero matches when neither skillId nor name matches', () => {
    const r = matchSearchHit(skills, { skillId: 'zzz', name: 'yyy' })
    expect(r.skill).toBeNull()
    expect(r.matchCount).toBe(0)
  })
  it('reports matchCount above 1 when several dirs share a basename', () => {
    const r = matchSearchHit(skills, { skillId: 'pdf', name: 'pdf' })
    expect(r.matchCount).toBe(2)
    expect(r.skill?.relativePath).toBe('skills/pdf')  // first in order
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/skills.test.ts`
Expected: FAIL — `parseOwnerRepo` / `matchSearchHit` not exported

- [ ] **Step 3: Add the types and functions to `shared/skills.ts`**

Types (append after the existing `SessionSkillOverride` block):

```ts
export interface RemoteSearchHit {
  id: string
  source: string      // "owner/repo"
  skillId: string
  name: string
  installs: number
}

export interface DiscoveredSkill {
  name: string          // frontmatter.name ?? directory basename
  description: string   // frontmatter.description ?? ''
  relativePath: string  // '' means the clone root itself
}

export interface RemotePreviewResponse {
  source: string
  skills: DiscoveredSkill[]
}

export interface RemoteInstallRequest {
  source: string
  scope: SkillScope
  cwd?: string
  paths: string[]       // relativePath values from preview
  overwrite?: boolean
}

export interface RemoteInstallResponse {
  installed: Array<{ name: string; relativePath: string }>
  failed: Array<{ name: string; relativePath: string; error: string }>
}
```

`parseOwnerRepo(input)`: match against
`/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/`
and return `{ owner, repo }` (repo with any `.git` suffix stripped), else `null`.

`matchSearchHit(skills, hit)`: step 1 of the spec's matching rule — collect
entries where `basename(relativePath) === hit.skillId`; if none, collect where
`name === hit.name`; return `{ skill: matches[0] ?? null, matchCount: matches.length }`.
`basename('')` is `''` and will not equal a non-empty `skillId`, which is the
desired behaviour for root-level skills.

**Do not import `basename` from `node:path` here.** `shared/` is compiled by
`tsconfig.json` for the browser bundle (no node types) and `npm run typecheck`
will fail. Use a portable helper local to `shared/skills.ts`:

```ts
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? ''
```

Type `matchSearchHit`'s second parameter as
`Pick<RemoteSearchHit, 'skillId' | 'name'>` so the tests can pass bare
`{ skillId, name }` objects without fabricating `id`/`source`/`installs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/skills.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/skills.ts shared/skills.test.ts
git commit -m "feat(skills): shared types for remote install + owner/repo matching

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `discoverSkills` — walk a tree for SKILL.md dirs

**Files:**
- Create: `server/skills-remote.ts`
- Test: `server/skills-remote.test.ts`

**Interfaces:**
- Consumes: `DiscoveredSkill`, `parseSkillFrontmatter` from `server/skills.js`
- Produces: `discoverSkills(baseDir: string): Promise<DiscoveredSkill[]>`, `SKIP_DIRS: readonly string[]`, `MAX_SKILL_DEPTH = 5`

- [ ] **Step 1: Write the failing tests** in `server/skills-remote.test.ts`

Build fixture trees under `fs.mkdtemp` in each test (no network, no git).

```ts
import { discoverSkills } from './skills-remote.js'

describe('discoverSkills', () => {
  it('finds nested skills and reads description from frontmatter', async () => {
    // base/skills/pdf/SKILL.md  with frontmatter name: pdf, description: 'Read PDFs'
    // base/skills/docx/SKILL.md with frontmatter description: 'Read DOCX'
    const found = await discoverSkills(base)
    expect(found).toEqual(expect.arrayContaining([
      { name: 'pdf', description: 'Read PDFs', relativePath: 'skills/pdf' },
      { name: 'docx', description: 'Read DOCX', relativePath: 'skills/docx' },
    ]))
  })

  it('reports a root-level skill with relativePath ""', async () => {
    // base/SKILL.md with frontmatter name: root-skill
    const found = await discoverSkills(base)
    expect(found).toEqual([{ name: 'root-skill', description: '', relativePath: '' }])
  })

  it('skips SKIP_DIRS and stops at depth 5', async () => {
    // base/node_modules/x/SKILL.md         -> must NOT appear
    // base/a/b/c/d/e/SKILL.md (depth 6)    -> must NOT appear
    // base/a/b/c/d/SKILL.md   (depth 5)    -> must appear
    const found = await discoverSkills(base)
    expect(found.map((s) => s.relativePath)).toEqual(['a/b/c/d'])
  })

  it('falls back to the directory basename when frontmatter has no name', async () => {
    // base/skills/my-tool/SKILL.md with only description in frontmatter
    const found = await discoverSkills(base)
    expect(found[0].name).toBe('my-tool')
  })

  it('skips a SKILL.md larger than MAX_SKILL_BYTES', async () => {
    // write a SKILL.md of 1 MiB + 1 bytes
    expect(await discoverSkills(base)).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/skills-remote.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `discoverSkills` in `server/skills-remote.ts`**

Export `SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'vendor'] as const`
and `MAX_SKILL_DEPTH = 5`.

Recursive walk from `baseDir` (depth 0 = the base itself, so a root
`SKILL.md` is depth 0 and is included). For each directory that contains
`SKILL.md`, read it (skip the entry entirely if the file exceeds
`MAX_SKILL_BYTES`). **`MAX_SKILL_BYTES` is currently a module-private const in
`server/skills.ts:12` — export it from there** (`export const MAX_SKILL_BYTES`)
and import it into `server/skills-remote.ts`. Do not redeclare the constant and
do not look for it in `server/constants.ts`; it is not there. Run the content
through the existing `parseSkillFrontmatter`, and push
`{ name: parsed.name?.trim() || basename(dir), description: parsed.description ?? '', relativePath: slash(relative(baseDir, dir)) }`
where the base dir itself yields `relativePath: ''`. Do not descend into a
directory that contains `SKILL.md`. Do not descend into `SKIP_DIRS`. Do not
descend past depth 5.

Forward slashes in `relativePath` (`path.posix.join` or `split(sep).join('/')`)
so it round-trips through JSON on Windows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/skills-remote.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/skills-remote.ts server/skills-remote.test.ts
git commit -m "feat(skills): discoverSkills walk for remote install

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `cloneAndDiscover` — temp cache + gitClone + discovery

**Files:**
- Modify: `server/skills-remote.ts`
- Test: `server/skills-remote.test.ts`

**Interfaces:**
- Consumes: `gitClone` from `server/git-clone.js`, `discoverSkills` (Task 2), `DiscoveredSkill`
- Produces: `cloneAndDiscover(source: string): Promise<{ dir: string; skills: DiscoveredSkill[] }>` where `dir` is the clone directory (kept in the cache), `searchCatalog(q: string, limit: number): Promise<RemoteSearchHit[]>`

- [ ] **Step 1: Write the failing tests** in `server/skills-remote.test.ts`

Mock the clone so no network is touched:

```ts
vi.mock('./git-clone.js', () => ({ gitClone: vi.fn(async (_url: string, dest: string) => { mkdirSync(dest, { recursive: true }) }) }))
```

```ts
describe('cloneAndDiscover', () => {
  it('constructs a github.com URL from owner/repo and clones into a fresh dir', async () => {
    // assert gitClone called with 'https://github.com/vercel-labs/agent-skills.git'
    // and dest that does not exist before the call
  })

  it('rejects a source that is not owner/repo', async () => {
    await expect(cloneAndDiscover('https://evil.example/x/y')).rejects.toThrow(/source must be/)
  })

  it('reuses the cached clone dir for a second call with the same source', async () => {
    // two calls, same source -> gitClone called once, same dir returned
  })

  it('re-clones after the cache TTL expires', async () => {
    // call, advance fake timers past 10 minutes, call -> gitClone called twice
  })

  it('does not cache when the clone fails', async () => {
    // make gitClone reject -> the call rejects and a later successful call clones again
  })
})

describe('searchCatalog', () => {
  it('rejects a query shorter than 2 characters', async () => {
    await expect(searchCatalog('a', 20)).rejects.toThrow(/at least 2/)
  })

  it('caps limit at 50 and forwards the skills.sh payload', async () => {
    // stub global.fetch to return { skills: [{ id, source, skillId, name, installs }] }
    // assert the request URL is https://skills.sh/api/search?q=react&limit=50
  })

  it('throws when skills.sh responds non-2xx', async () => {
    // fetch -> 503 -> rejects with an Error mentioning the status
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/skills-remote.test.ts`
Expected: FAIL — `cloneAndDiscover` / `searchCatalog` not exported

- [ ] **Step 3: Implement `cloneAndDiscover`, the cache, and `searchCatalog`**

Module-private `cloneCache = new Map<string, { dir: string; expiresAt: number }>()`.
TTL `10 * 60 * 1000`. A module-level `setInterval(sweep, 60_000).unref()` removes
expired entries with `fs.rm(dir, { recursive: true, force: true })`.

`cloneAndDiscover(source)`:
1. `parseOwnerRepo(source)` — throw `HttpError(400, 'source must be owner/repo or a github.com URL')` on null.
2. Cache hit (entry present and `expiresAt > Date.now()`) → return `{ dir: entry.dir, skills: await discoverSkills(entry.dir) }`.
3. `const tmp = await fs.mkdtemp(join(os.tmpdir(), 'crw-skill-'))`; `const dir = join(tmp, 'repo')`.
4. `await gitClone('https://github.com/${owner}/${repo}.git', dir)` — `gitClone` requires the destination not to exist, which `join(tmp, 'repo')` satisfies.
5. On clone success: `cloneCache.set(source, { dir, expiresAt: Date.now() + TTL })` where **the cached `dir` is `join(tmp, 'repo')`** — the clone root, not `tmp`. Both the cache-hit return value and the `discoverSkills` base must be that same `join(tmp, 'repo')`, because `relativePath` is computed relative to it. Track `tmp` in a second field (`tmpRoot`) purely so the sweeper can `rm` the whole mkdtemp tree. On clone failure: `rm(tmp, {recursive, force})` and rethrow.

`searchCatalog(q, limit)`:
- `if (q.trim().length < 2) throw new HttpError(400, 'q must be at least 2 characters')`
- `const capped = Math.min(Math.max(limit || 20, 1), 50)`
- `fetch('https://skills.sh/api/search?q=' + encodeURIComponent(q.trim()) + '&limit=' + capped)`, 15 s `AbortSignal.timeout(15_000)`.
- non-OK → `throw new HttpError(502, 'skills.sh search failed (status ' + res.status + ')')`
- Parse `{ skills: [...] }` and map to `RemoteSearchHit` (`id`, `source`, `skillId`, `name`, `installs`, coercing missing numbers to 0). Sort by `installs` desc.

Also export nothing else from this module — the cache is module-private and
expires on its own TTL.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/skills-remote.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/skills-remote.ts server/skills-remote.test.ts
git commit -m "feat(skills): cloneAndDiscover temp cache and skills.sh search proxy

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `installRemoteSkills` — stage + import via `importSkillFromPath`

**Files:**
- Modify: `server/skills-remote.ts`
- Test: `server/skills-remote.test.ts`

**Interfaces:**
- Consumes: `cloneAndDiscover` (Task 3), `importSkillFromPath` from `server/skills.js`, `RemoteInstallRequest`, `RemoteInstallResponse`
- Produces: `installRemoteSkills(req: RemoteInstallRequest): Promise<RemoteInstallResponse>`, `stageSkillInto(cloneDir: string, relativePath: string, destDir: string): Promise<void>`

- [ ] **Step 1: Write the failing tests** in `server/skills-remote.test.ts`

Use real `importSkillFromPath` against a temp project `cwd` (project scope writes to `join(cwd, '.claude', 'skills')`), and a mocked `gitClone` that populates the destination from a fixture tree.

```ts
describe('installRemoteSkills', () => {
  it('stages a root-level skill without .git or node_modules', async () => {
    // clone fixture: SKILL.md + .git/config + node_modules/x/index.js + notes.md
    // install paths: ['']
    // expect installed[0].name === 'root-skill'
    // expect join(cwd, '.claude/skills/root-skill/notes.md') exists
    // expect join(cwd, '.claude/skills/root-skill/.git') does NOT exist
  })

  it('continues past a failing skill and reports it in failed[]', async () => {
    // install two paths, one of which points at a dir with no SKILL.md
    // expect installed.length === 1 and failed[0].error is non-empty
  })

  it('reports Skill already exists per-skill when overwrite is false', async () => {
    // install once successfully, then install the same path again with overwrite: false
    // expect failed[0].error to contain 'already exists'
  })

  it('installs two skills that share a frontmatter name by relativePath', async () => {
    // fixture: skills/a/SKILL.md (name: dup) and skills/b/SKILL.md (name: dup)
    // install paths: ['skills/a', 'skills/b'] with overwrite: true
    // expect both attempted; second succeeds only because overwrite replaced the first
    // expect response entries carry relativePath 'skills/a' / 'skills/b'
  })

  it('rejects an empty paths array', async () => {
    await expect(installRemoteSkills({ source: 'a/b', scope: 'project', cwd, paths: [] })).rejects.toThrow(/paths/)
  })

  it('reports an unknown relativePath as not found', async () => {
    // paths: ['../outside'] -> failed[0].error is 'Not found in repository'
    // (the discovery lookup runs first, so an escaping path never reaches
    // stageSkillInto; stageSkillInto's containment check is defense-in-depth)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/skills-remote.test.ts`
Expected: FAIL — `installRemoteSkills` not exported

- [ ] **Step 3: Implement `stageSkillInto` and `installRemoteSkills`**

`stageSkillInto(cloneDir, relativePath, destDir)`:
- Resolve `src = resolve(cloneDir, relativePath)` and assert `src` is inside
  `cloneDir` (`relative(cloneDir, src)` must not start with `..`) — reject with
  `HttpError(400, 'path escapes the repository')` otherwise. `relativePath: ''`
  resolves to `cloneDir` itself and is allowed.
- Copy `src` → `destDir` recursively with `fs.cp(src, destDir, { recursive: true, filter })`
  where the filter drops any path segment in `SKIP_DIRS` (Task 2). That is what
  keeps a root-level skill's `.git` / `node_modules` out of the import.

`installRemoteSkills(req)`:
- `if (!req.paths?.length) throw new HttpError(400, 'paths is required')`
- `const { dir } = await cloneAndDiscover(req.source)` then
  `const skills = await discoverSkills(dir)`.
- For each `p` in `req.paths`, try:
  - find the discovered entry with `relativePath === p`; if none,
    `failed.push({ name: p, relativePath: p, error: 'Not found in repository' })` and continue.
  - `const staged = await fs.mkdtemp(join(os.tmpdir(), 'crw-skill-stage-'))`
  - `await stageSkillInto(dir, p, staged)`
  - `const result = await importSkillFromPath({ scope: req.scope, cwd: req.cwd, path: staged, name: entry.name, overwrite: req.overwrite })`
    — **`name: entry.name` is required.** The staging dir is an `fs.mkdtemp`
    name, so without an explicit name a skill whose frontmatter has no `name`
    would install as `crw-skill-stage-…`. Passing the discovered name keeps the
    resolved install name equal to what discovery reported.
  - `installed.push({ name: result.skill.name, relativePath: p })`
  - `finally { await fs.rm(staged, { recursive: true, force: true }) }`
  - catch any throw into `failed.push({ name: entry.name, relativePath: p, error: (err as Error).message })` — one bad skill never aborts the batch.
- Return `{ installed, failed }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/skills-remote.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/skills-remote.ts server/skills-remote.test.ts
git commit -m "feat(skills): stage-and-import install path for remote skills

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Server routes — search / preview / install

**Files:**
- Modify: `server/routes/skills.ts`
- Test: `server/routes/skills-remote.test.ts`

**Interfaces:**
- Consumes: `searchCatalog`, `cloneAndDiscover`, `installRemoteSkills` (Tasks 3–4), `parseOwnerRepo`, `SkillScope`
- Produces: `GET /api/skills/search?q=&limit=`, `POST /api/skills/remote/preview`, `POST /api/skills/remote/install`

- [ ] **Step 1: Write the failing tests** in `server/routes/skills-remote.test.ts`

Mock `../skills-remote.js` so routes are tested without cloning:

```ts
vi.mock('../skills-remote.js', () => ({
  searchCatalog: vi.fn(),
  cloneAndDiscover: vi.fn(),
  installRemoteSkills: vi.fn(),
}))
```

Build the router with a stub `SessionManager` (`{ reloadSkillsForCwd: vi.fn(async () => 0) }`), matching the pattern in `server/routes/hooks.test.ts`.

```ts
describe('skills remote routes', () => {
  it('GET /skills/search forwards q and limit', async () => {
    // searchCatalog resolves to one hit; expect 200 and the same shape out
    // expect searchCatalog called with ('react', 20)
  })

  it('GET /skills/search rejects q shorter than 2', async () => {
    // ?q=a -> 400
  })

  it('POST /skills/remote/preview returns discovered skills', async () => {
    // cloneAndDiscover resolves { dir, skills: [...] }
    // expect 200 body { source, skills }
  })

  it('POST /skills/remote/preview 400s on a non-owner/repo source', async () => {
    // body { source: 'https://evil.example/x/y' } -> 400
  })

  it('POST /skills/remote/install returns installed and failed', async () => {
    // installRemoteSkills resolves both lists; expect 200 with both
    // expect it called with { source, scope: 'project', cwd, paths, overwrite: true }
  })

  it('POST /skills/remote/install 400s on empty paths', async () => {
    // body { source: 'a/b', scope: 'project', paths: [] } -> 400
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/routes/skills-remote.test.ts`
Expected: FAIL — routes not registered

- [ ] **Step 3: Register the three routes in `buildSkillsRouter`**

In `server/routes/skills.ts`, add near the other `/skills` routes (keep them
together at the top of the router). **Ordering is safe because of HTTP method
separation, not segment counts:** `POST /skills/remote/preview` and
`POST /skills/remote/install` share the two-segment shape of
`/skills/:scope/:name`, but that route only registers `GET`/`PUT`/`DELETE`, so
no `POST` can be shadowed. Verify that stays true if anyone later adds
`POST /skills/:scope/:name`.

- `app.get('/skills/search', …)` — read `q` and `limit` from the query,
  delegate to `searchCatalog(q, limit ?? 20)`, return `{ skills }`.
- `app.post('/skills/remote/preview', …)` — body `{ source }`; validate with
  `parseOwnerRepo` and `HttpError(400, …)` on null; delegate to
  `cloneAndDiscover(source)`; return `{ source, skills }`.
- `app.post('/skills/remote/install', …)` — body `RemoteInstallRequest`;
  validate `source` via `parseOwnerRepo`, `scope` via the existing `parseScope`,
  `paths` a non-empty string array (400 otherwise); delegate to
  `installRemoteSkills`, then call the existing `reloadAffectedSessions(sm, scope, cwd)`
  once and return the response.

Wrap each handler in the router's existing `HttpError`→JSON convention (the
`safeJson` / `onError` pattern the other routes already use).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/routes/skills-remote.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full server test suite to check for regressions**

Run: `npx vitest run server/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/routes/skills.ts server/routes/skills-remote.test.ts
git commit -m "feat(skills): search/preview/install routes for remote skills

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Client — `RemoteInstallSection` (search + quick install)

**Files:**
- Modify: `src/components/GlobalSettingsModal.tsx`
- Test: `src/components/GlobalSettingsModal.test.tsx`
- Modify: `src/styles/utilities.css`

**Interfaces:**
- Consumes: `parseOwnerRepo`, `matchSearchHit`, `RemoteSearchHit`, `DiscoveredSkill`, `RemotePreviewResponse` from `shared/skills`; `api` from `src/hooks/useApi`
- Produces: `RemoteInstallSection` React component rendered inside `SkillsTab` above the existing `settings-skill-import-group`, receiving `{ cwd, importScope, skills }` (the already-loaded `SkillRecord[]`, used for `✓ Installed`) and an `onInstalled: () => void` callback that triggers `refresh()`.

- [ ] **Step 1: Write the failing tests** in `src/components/GlobalSettingsModal.test.tsx`

Follow the file's existing fetch-stub pattern — **but first extend the `useApi`
mock factory**: it currently declares only `{ api: { get: vi.fn(), put: vi.fn() } }`
and the remote-install flow needs `api.post`. Add `post: vi.fn()` to that
factory, and add a `/skills/search` branch to the `get` stub (it currently has
no `/skills` branch and falls through).

```ts
it('shows Open repository when the query parses as owner/repo', async () => {
  // type 'vercel-labs/agent-skills' into the Browse skills input
  // expect a button labelled 'Open repository' to appear
})

it('renders search results with Install buttons', async () => {
  // stub GET /api/skills/search to return one hit
  // type 'react', advance timers past the 300 ms debounce
  // expect the row to show the skill name, source, and an Install button
})

it('flips a row to Installed after a successful install', async () => {
  // stub POST /api/skills/remote/preview + install to succeed
  // click Install on the row, expect '✓ Installed' and onInstalled called
})

it('shows an inline error when the skill is not found in the repo', async () => {
  // preview resolves with skills that matchSearchHit misses
  // expect text matching /Not found in/ and the Browse button still enabled
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx`
Expected: FAIL — no Browse-skills section

- [ ] **Step 3: Implement `RemoteInstallSection` and mount it in `SkillsTab`**

State (local to the component):
`searchQuery`, `searchResults: RemoteSearchHit[]`, `searchError`, `searching`,
`installingId: string | null`, `installedIds: Set<string>`,
`rowError: Record<string, string>`, `replaceExisting: boolean`, plus an
`AbortController` ref for the in-flight search.

Behaviour:
- 300 ms debounce on `searchQuery`; abort the previous fetch; empty query
  clears results. `api.get('/skills/search?q=' + encodeURIComponent(q))`.
- `parseOwnerRepo(searchQuery)` non-null → render an
  `Open repository` button above the results that opens the picker (Task 7
  supplies `openPicker(source)` — in this task render it disabled with
  `data-open-repo`, wired up in Task 7).
- Each row: `name`, `source`, `installs` (formatted with `toLocaleString`),
  `Install`, `Browse`. Row id = `hit.id`.
- `Install` click → `const preview = await api.post('/skills/remote/preview', { source: hit.source })`,
  then `matchSearchHit(preview.skills, hit)`.
  **The `skills` passed to `matchSearchHit` must be the PREVIEW response's
  `DiscoveredSkill[]`, not the component's `skills: SkillRecord[]` prop.** The
  two types are structurally similar (`name`/`description`/`relativePath`) but
  `SkillRecord.relativePath` is the path to `SKILL.md` relative to `cwd`, not a
  clone-relative directory — passing the prop typechecks and silently installs
  the wrong thing.
  - `matchCount === 0` → `rowError[id] = 'Not found in ' + hit.source`, Browse stays enabled
  - `matchCount > 1` → `rowError[id] = matchCount + ' matches — installed the first'` (warning, still installs)
  - `skill` non-null → `api.post('/skills/remote/install', { source, scope: importScope, cwd: importScope === 'project' ? cwd : undefined, paths: [skill.relativePath], overwrite: replaceExisting })`; on success mark `installedId` and call `onInstalled()`; on failure put the message in `rowError[id]`.
- While installing: button label `Installing…`, disabled.
- `replaceExisting` checkbox sits in the section head, labelled `Replace existing`.

Mount in `SkillsTab` immediately above the existing
`section.settings-skill-import-group`, passing `importScope`, `cwd`, the current
`skills` array (for `✓ Installed`: show that state when
`skills.some((s) => s.scope === importScope && s.name === hit.name)`), and
`onInstalled={refresh}`.

- [ ] **Step 4: Add the styles** in `src/styles/utilities.css` beside the existing `settings-skill-*` rules

Classes: `settings-skill-remote-group`, `settings-skill-remote-head`,
`settings-skill-result-row`, `settings-skill-result-name`,
`settings-skill-result-source`, `settings-skill-result-installs`,
`settings-skill-row-error`, `settings-skill-installed-badge`. Use existing
variables (`--fg-muted`, `--btn-hover-bg`, `--border`, `--accent`, …) — no hex.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.test.tsx src/styles/utilities.css
git commit -m "feat(skills): remote search + quick install section

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Client — `BatchPickerModal` (multi-select)

**Files:**
- Modify: `src/components/GlobalSettingsModal.tsx`
- Test: `src/components/GlobalSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `RemotePreviewResponse`, `RemoteInstallResponse`, `api`; the `RemoteInstallSection`'s `openPicker` hook from Task 6
- Produces: `BatchPickerModal` React component `{ source, cwd, importScope, onClose, onInstalled }`, and wiring so `RemoteInstallSection`'s `Browse` / `Open repository` buttons set `pickerSource`

- [ ] **Step 1: Write the failing tests** in `src/components/GlobalSettingsModal.test.tsx`

```ts
it('opens the picker with descriptions and Select All', async () => {
  // stub POST /api/skills/remote/preview -> two skills with descriptions
  // click Browse on a result row
  // expect 'Select skills to install', subtitle containing the source and '2 skills found',
  //   a 'Select All' row, and both descriptions rendered
})

it('installs only the checked skills and keeps the modal open with per-row status', async () => {
  // check one of two rows, click 'Install 1 skills'
  // stub install to return { installed: [...], failed: [{ name, relativePath, error }] }
  // expect the modal STILL open, one row showing ✓ and the other showing the error text,
  //   and the footer button now labelled 'Done'
})

it('filters the list with the picker search box', async () => {
  // type into the picker's filter input, expect only matching rows
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement `BatchPickerModal` and wire it up**

State: `skills`, `loading`, `error`, `filter`, `selected: Set<string>` (keys are
`relativePath`), `replaceExisting: boolean`, `phase: 'select' | 'installing' | 'done'`,
`results: RemoteInstallResponse | null`.

- On mount: `api.post('/skills/remote/preview', { source })` → `skills`.
- Title `Select skills to install`; subtitle
  `` `${source} · ${skills.length} skills found` ``.
- Filter input (`Search:`) filters rows client-side on name and description.
- `Select All (x/N)` row: toggles every **visible** (post-filter) skill.
- Checkbox rows: skill `name` + `description`. Row id = `relativePath`.
- Footer: scope readout (`` `Scope: ${importScope}` ``) + `Replace existing`
  checkbox + `Cancel` + button labelled `` `Install ${n} skills` ``.
- Clicking install sets `phase: 'installing'`, posts
  `{ source, scope: importScope, cwd: importScope === 'project' ? cwd : undefined, paths: [...selected], overwrite: replaceExisting }`.
- **Do not close the modal when the response lands.** Map `installed` /
  `failed` onto the rows (✓ vs inline error), set `phase: 'done'`, and relabel
  the button `Done` — clicking it (and only it) calls `onInstalled()` then
  `onClose()`.
- `Cancel` closes immediately without installing.

Wire into `SkillsTab`: `RemoteInstallSection`'s `Browse` button and
`Open repository` button both set `pickerSource`; `SkillsTab` renders
`<BatchPickerModal>` when `pickerSource` is non-null.

- [ ] **Step 4: Add the styles** for `settings-skill-picker`, `settings-skill-picker-row`,
`settings-skill-picker-select-all`, `settings-skill-picker-footer`,
`settings-skill-picker-status` (theme variables only).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/GlobalSettingsModal.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/GlobalSettingsModal.tsx src/components/GlobalSettingsModal.test.tsx src/styles/utilities.css
git commit -m "feat(skills): batch picker modal for multi-select install

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Full verification and typecheck

**Files:** none (verification only)

- [ ] **Step 1: Typecheck both tsconfigs**

Run: `npm run typecheck`
Expected: PASS (both `tsc` invocations clean)

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: PASS — no regressions in existing skills/marketplace/settings tests

- [ ] **Step 4: Fix anything the above surfaces, then commit**

```bash
git add -A
git commit -m "chore(skills): typecheck/lint cleanups for remote install

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
