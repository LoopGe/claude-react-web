import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { parseOwnerRepo, type DiscoveredSkill, type RemoteSearchHit } from '../shared/skills.js'
import { HttpError } from './errors.js'
import { gitClone } from './git-clone.js'
import { createLogger } from './log.js'
import { MAX_SKILL_BYTES, parseSkillFrontmatter } from './skills.js'

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
  /** The clone root — `join(tmpRoot, 'repo')`. This is what `discoverSkills`
   *  walks and what `cloneAndDiscover` returns, so every `relativePath` is
   *  relative to the clone root with no `repo/` prefix. */
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
 * raw `source` string, so a repeated preview of the same repo reuses the same
 * tree; after the TTL (or on a clone failure) the next call clones fresh.
 */
export async function cloneAndDiscover(
  source: string,
): Promise<{ dir: string; skills: DiscoveredSkill[] }> {
  const parsed = parseOwnerRepo(source)
  if (!parsed) {
    throw new HttpError(400, 'source must be owner/repo or a github.com URL')
  }
  const { owner, repo } = parsed

  const hit = cloneCache.get(source)
  if (hit) {
    if (hit.expiresAt > Date.now()) {
      return { dir: hit.dir, skills: await discoverSkills(hit.dir) }
    }
    // Expired: drop it now and tear down its tree. Overwriting the key below
    // would hide it from the sweeper forever.
    cloneCache.delete(source)
    await fs.rm(hit.tmpRoot, { recursive: true, force: true })
  }

  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'crw-skill-'))
  // gitClone requires the destination NOT to exist, so clone into a fresh
  // child of the mkdtemp tree rather than the tree itself.
  const dir = join(tmpRoot, 'repo')
  try {
    await gitClone(`https://github.com/${owner}/${repo}.git`, dir)
  } catch (err) {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    throw err
  }
  cloneCache.set(source, { dir, tmpRoot, expiresAt: Date.now() + CLONE_TTL_MS })
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
  const body = (await res.json()) as { skills: unknown[] }
  const hits: RemoteSearchHit[] = body.skills.map((raw) => {
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
