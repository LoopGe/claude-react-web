import { promises as fs } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import type { DiscoveredSkill } from '../shared/skills.js'
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
