import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  parseOwnerRepo,
  SKILL_SOURCE_FILE,
  type DiscoveredSkill,
  type RemoteInstallRequest,
  type RemoteInstallResponse,
  type RemoteSearchHit,
  type SkillRecord,
  type SkillScope,
  type SkillUpdateStatus,
} from '../shared/skills.js'
import { HttpError } from './errors.js'
import { gitClone, gitHeadSha, gitLsRemoteHead } from './git-clone.js'
import { createLogger } from './log.js'
import { importSkillFromPath, getSkill, listSkills, MAX_SKILL_BYTES, parseSkillFrontmatter } from './skills.js'

/** Directory names never entered while walking a skill tree. */
export const SKIP_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'vendor',
] as const

/**
 * Deepest level of the walk that may hold a SKILL.md. `depth` counts
 * directory levels below `baseDir` (the base itself is 0), and a directory is
 * entered while `depth <= MAX_SKILL_DEPTH` — so `base/a/b/c/d/e` (depth 5) is
 * the deepest discoverable skill and `base/a/b/c/d/e/f` (depth 6) is never
 * visited.
 */
export const MAX_SKILL_DEPTH = 5

const SKIP_DIR_SET: ReadonlySet<string> = new Set(SKIP_DIRS)

function toPosix(relPath: string): string {
  return relPath === '' ? '' : relPath.split(sep).join('/')
}

export async function discoverSkills(baseDir: string): Promise<DiscoveredSkill[]> {
  const found: DiscoveredSkill[] = []
  await walk(baseDir, baseDir, 0, found)
  return found
}

async function walk(
  baseDir: string,
  dir: string,
  depth: number,
  found: DiscoveredSkill[],
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) return

  const entries = await fs.readdir(dir, { withFileTypes: true })
  const skillEntry = entries.find((e) => e.isFile() && e.name === 'SKILL.md')
  if (skillEntry) {
    const skillPath = join(dir, 'SKILL.md')
    const stat = await fs.stat(skillPath)
    // Skip the entry entirely when oversized; still a skill dir, so no descent.
    if (stat.size <= MAX_SKILL_BYTES) {
      const content = await fs.readFile(skillPath, 'utf8')
      const parsed = parseSkillFrontmatter(content)
      found.push({
        name: parsed.name?.trim() || basename(dir),
        description: parsed.description ?? '',
        relativePath: toPosix(relative(baseDir, dir)),
      })
    }
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (SKIP_DIR_SET.has(entry.name)) continue
    await walk(baseDir, join(dir, entry.name), depth + 1, found)
  }
}

// ── Remote install: temp clone cache + skills.sh search proxy ──────────────

const log = createLogger('skills-remote')

/** How long a clone stays reusable before the next request re-clones. */
const CLONE_TTL_MS = 10 * 60 * 1000
/** Expired entries are swept (and their temp trees deleted) this often. */
const SWEEP_INTERVAL_MS = 60_000

interface CloneCacheEntry {
  /** The clone root — `join(tmpRoot, repo)`. This is what `discoverSkills`
   *  walks and what `cloneAndDiscover` returns, so every `relativePath` is
   *  relative to the clone root with no `repo/` prefix. Naming the child after
   *  the repo keeps `basename(dir)` meaningful: a root-level skill with no
   *  `frontmatter.name` falls back to it. */
  dir: string
  /** The mkdtemp tree root (parent of `dir`) — purely so the sweeper can `rm`
   *  the whole throwaway tree, not just the clone dir inside it. */
  tmpRoot: string
  expiresAt: number
}

const cloneCache = new Map<string, CloneCacheEntry>()

function sweep(): void {
  const now = Date.now()
  for (const [key, entry] of cloneCache) {
    if (now <= entry.expiresAt) continue
    cloneCache.delete(key)
    fs.rm(entry.tmpRoot, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn(`failed to remove expired clone ${entry.tmpRoot}: ${(err as Error).message}`)
    })
  }
}

setInterval(sweep, SWEEP_INTERVAL_MS).unref()

/**
 * Shallow-clone a GitHub repo into a throwaway temp tree and discover the
 * Agent Skills inside it. The clone is cached for `CLONE_TTL_MS` keyed on the
 * normalized `owner/repo` (so `owner/repo` and `https://github.com/owner/repo`
 * share one entry), so a repeated preview of the same repo reuses the same
 * tree; after the TTL (or on a clone failure) the next call clones fresh.
 */
export async function cloneAndDiscover(
  source: string,
  opts?: { forceRefresh?: boolean },
): Promise<{ dir: string; skills: DiscoveredSkill[] }> {
  const parsed = parseOwnerRepo(source)
  if (!parsed) {
    throw new HttpError(400, 'source must be owner/repo or a github.com URL')
  }
  const { owner, repo } = parsed
  const cacheKey = `${owner}/${repo}`

  const hit = cloneCache.get(cacheKey)
  if (hit) {
    if (hit.expiresAt > Date.now() && !opts?.forceRefresh) {
      return { dir: hit.dir, skills: await discoverSkills(hit.dir) }
    }
    // Expired, or an update explicitly asked for a fresh tree: drop the entry
    // now and tear down its tree. Overwriting the key below would hide it
    // from the sweeper forever.
    cloneCache.delete(cacheKey)
    await fs.rm(hit.tmpRoot, { recursive: true, force: true })
  }

  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'crw-skill-'))
  // gitClone requires the destination NOT to exist, so clone into a fresh
  // child of the mkdtemp tree rather than the tree itself. The child is named
  // after the repo, so a root-level skill with no frontmatter.name falls back
  // to the repo name instead of an artificial folder name.
  const dir = join(tmpRoot, repo)
  try {
    await gitClone(`https://github.com/${owner}/${repo}.git`, dir)
  } catch (err) {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    throw err
  }
  cloneCache.set(cacheKey, { dir, tmpRoot, expiresAt: Date.now() + CLONE_TTL_MS })
  return { dir, skills: await discoverSkills(dir) }
}

/** Query the public skills.sh catalog. Proxied so the browser never talks to
 *  a third-party host directly. */
export async function searchCatalog(q: string, limit: number): Promise<RemoteSearchHit[]> {
  if (q.trim().length < 2) {
    throw new HttpError(400, 'q must be at least 2 characters')
  }
  const capped = Math.min(Math.max(limit || 20, 1), 50)
  const res = await fetch(
    'https://skills.sh/api/search?q=' + encodeURIComponent(q.trim()) + '&limit=' + capped,
    { signal: AbortSignal.timeout(15_000) },
  )
  if (!res.ok) {
    throw new HttpError(502, 'skills.sh search failed (status ' + res.status + ')')
  }
  // External wire input: a body without a `skills` array is an upstream
  // failure, not a TypeError 500 out of `.map`.
  const payload = (await res.json()) as { skills?: unknown } | null
  const rawSkills = payload?.skills
  if (!Array.isArray(rawSkills)) {
    throw new HttpError(502, 'skills.sh search returned a malformed payload')
  }
  const hits: RemoteSearchHit[] = rawSkills.map((raw) => {
    const s = raw as Record<string, unknown>
    return {
      id: String(s.id ?? ''),
      source: String(s.source ?? ''),
      skillId: String(s.skillId ?? ''),
      name: String(s.name ?? ''),
      installs: typeof s.installs === 'number' && Number.isFinite(s.installs) ? s.installs : 0,
    }
  })
  hits.sort((a, b) => b.installs - a.installs)
  return hits
}

// ── Remote install: stage + import ─────────────────────────────────────────

/**
 * Copy one discovered skill directory out of a clone tree into `destDir`,
 * dropping `SKIP_DIRS` subtrees (a root-level skill's `.git` / `node_modules`
 * must not reach the import). `relativePath: ''` stages the clone root itself.
 * The copy is a staging step — the real install goes through
 * `importSkillFromPath`.
 */
export async function stageSkillInto(
  cloneDir: string,
  relativePath: string,
  destDir: string,
): Promise<void> {
  const src = resolve(cloneDir, relativePath)
  const rel = relative(cloneDir, src)
  if (rel.startsWith('..')) {
    throw new HttpError(400, 'path escapes the repository')
  }
  await fs.cp(src, destDir, {
    recursive: true,
    filter: (candidate) => {
      // Filter against the copied root's own tree only, so a SKIP_DIRS name
      // somewhere in the temp path can't exclude the root itself.
      const relToSrc = relative(src, candidate)
      if (relToSrc === '') return true
      return relToSrc.split(sep).every((segment) => !SKIP_DIR_SET.has(segment))
    },
  })
}

/**
 * Install skills out of a GitHub repo into the real skill root. Each selected
 * `relativePath` is staged into a throwaway temp dir and imported via the
 * existing `importSkillFromPath`, so remote installs land exactly where
 * "Install from folder" puts them. Failures are per-skill: one bad entry is
 * reported in `failed` and the rest of the batch continues.
 */
export async function installRemoteSkills(
  req: RemoteInstallRequest,
): Promise<RemoteInstallResponse> {
  if (!req.paths?.length) throw new HttpError(400, 'paths is required')
  const { dir } = await cloneAndDiscover(req.source)
  const skills = await discoverSkills(dir)
  // One HEAD sha per install batch: it becomes every installed skill's
  // `.crw-source.json` provenance (the update check compares it against the
  // upstream HEAD later).
  const lastSha = await gitHeadSha(dir)

  const installed: RemoteInstallResponse['installed'] = []
  const failed: RemoteInstallResponse['failed'] = []
  for (const p of req.paths) {
    const entry = skills.find((s) => s.relativePath === p)
    if (!entry) {
      failed.push({ name: p, relativePath: p, error: 'Not found in repository' })
      continue
    }
    let staged: string | undefined
    try {
      staged = await fs.mkdtemp(join(tmpdir(), 'crw-skill-stage-'))
      await stageSkillInto(dir, p, staged)
      // Provenance travels with the staged tree, so it lands atomically with
      // the skill (never "installed but metadata missing").
      await fs.writeFile(
        join(staged, SKILL_SOURCE_FILE),
        JSON.stringify({ source: req.source, relativePath: p, lastSha }, null, 2),
        'utf8',
      )
      // name: entry.name is required — the staging dir is an mkdtemp random
      // name, so without it a skill with no frontmatter.name would install as
      // `crw-skill-stage-…` instead of the name discovery reported.
      const result = await importSkillFromPath({
        scope: req.scope,
        cwd: req.cwd,
        path: staged,
        name: entry.name,
        overwrite: req.overwrite,
      })
      installed.push({ name: result.skill.name, relativePath: p })
    } catch (err) {
      failed.push({ name: entry.name, relativePath: p, error: (err as Error).message })
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true })
    }
  }
  return { installed, failed }
}

/**
 * Non-mutating update check for GitHub-installed skills: compare each skill's
 * sidecar `lastSha` against the repo's CURRENT upstream HEAD (`git ls-remote`,
 * same channel as the marketplace check). Skills without a sidecar (folder
 * imports, hand-written) are skipped, exactly like the marketplace's `local`
 * records. One ls-remote per repo, failures isolated to that repo's rows.
 */
export async function checkSkillUpdates(input: { scope: SkillScope; cwd?: string }): Promise<SkillUpdateStatus[]> {
  const { skills } = await listSkills(input.cwd)
  const remote = skills.filter((s) => s.scope === input.scope && s.source)
  const byRepo = new Map<string, typeof remote>()
  for (const s of remote) {
    const list = byRepo.get(s.source!.source) ?? []
    list.push(s)
    byRepo.set(s.source!.source, list)
  }
  const settled = await Promise.allSettled(
    [...byRepo.keys()].map((repo) => gitLsRemoteHead(`https://github.com/${repo}.git`)),
  )
  const updates: SkillUpdateStatus[] = []
  let index = 0
  for (const [, group] of byRepo) {
    const result = settled[index++]
    for (const s of group) {
      if (result.status === 'fulfilled') {
        updates.push({ scope: s.scope, name: s.name, hasUpdate: result.value !== s.source!.lastSha, remoteSha: result.value })
      } else {
        const reason = result.reason
        const message = reason instanceof HttpError
          ? reason.message
          : reason instanceof Error
            ? reason.message
            : String(reason)
        updates.push({ scope: s.scope, name: s.name, hasUpdate: false, error: message })
      }
    }
  }
  return updates
}

/**
 * Apply an update to one GitHub-installed skill: force a FRESH clone (never
 * the TTL-cached tree), then overwrite-install it with the new HEAD sha.
 * An upstream rename is REJECTED — it must not create a second skill or
 * delete the old installation; the user installs the new name themselves.
 */
export async function updateRemoteSkill(input: { scope: SkillScope; cwd?: string; name: string }): Promise<{ skill: SkillRecord; lastSha: string }> {
  const existing = await getSkill(input.scope, input.name, input.cwd)
  const source = existing.source
  if (!source) throw new HttpError(400, 'Not a GitHub-installed skill')

  const { dir } = await cloneAndDiscover(source.source, { forceRefresh: true })
  const skills = await discoverSkills(dir)
  const entry = skills.find((s) => s.relativePath === source.relativePath)
  if (!entry) throw new HttpError(400, 'Not found in repository')
  if (entry.name !== input.name) {
    throw new HttpError(400, `Upstream renamed this skill to "${entry.name}"; install the new name and remove the old one instead`)
  }

  const lastSha = await gitHeadSha(dir)
  const staged = await fs.mkdtemp(join(tmpdir(), 'crw-skill-stage-'))
  try {
    await stageSkillInto(dir, source.relativePath, staged)
    await fs.writeFile(
      join(staged, SKILL_SOURCE_FILE),
      JSON.stringify({ source: source.source, relativePath: source.relativePath, lastSha }, null, 2),
      'utf8',
    )
    const result = await importSkillFromPath({
      scope: input.scope,
      cwd: input.cwd,
      path: staged,
      name: input.name,
      overwrite: true,
    })
    return { skill: result.skill, lastSha }
  } finally {
    await fs.rm(staged, { recursive: true, force: true })
  }
}
