import { promises as fs, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createLogger } from './log.js'
import type { EnabledPluginEntry, MpStore } from './mp-store.js'
import type { SkillRecord } from '../shared/skills.js'
import { MAX_SKILL_BYTES, parseSkillFrontmatter } from '../shared/skills.js'

const log = createLogger('plugin-skills')

const SKILL_FILE = 'SKILL.md'
const DEFAULT_SKILLS_DIR = 'skills'

/** The structural minimum the scanner consumes from MpStore — a real MpStore
 *  satisfies it; tests stub just this method. */
export type PluginSkillSource = Pick<MpStore, 'getEnabledPluginEntries'>

/** parseSkillFrontmatter's bare-grammar name error (shared/skills.ts). Plugin
 *  skill names are derived independently per scan branch (dir basename or
 *  frontmatter.name with the plugin prefix stripped), so this one error never
 *  invalidates a plugin record; description/delimiter errors still do. */
const FRONTMATTER_NAME_ERROR = 'frontmatter.name is not a valid skill name'

/** CLI §5.8 sanitizer: every character outside [a-zA-Z0-9_-] becomes '-'. */
function sanitizeSkillName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-')
}

/** Single-dir branch name (§5.8): frontmatter.name first, a leading `N:`
 *  prefix stripped, directory basename as fallback, then sanitized. */
function singleDirSkillName(prefix: string, frontmatterName: string | undefined, dir: string): string {
  const trimmed = frontmatterName?.trim() ?? ''
  const stripped = trimmed.startsWith(`${prefix}:`) ? trimmed.slice(prefix.length + 1) : trimmed
  return sanitizeSkillName(stripped || basename(dir))
}

interface PluginManifest {
  name?: string
  /** Normalized `skills` field: declared = the CLI's truthy `ke.skills` test
   *  (non-empty string or any array); entries = the string members. */
  skillsDeclared: boolean
  skillEntries: string[]
}

/** Fresh per-scan read of the plugin's own manifest. Absent (ENOENT) →
 *  undefined (catalog-name fallback, no skills declaration). Any other read
 *  failure or corrupt JSON throws — the caller contains it per plugin. */
async function readPluginManifest(dir: string): Promise<PluginManifest | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  const parsed = JSON.parse(raw) as { name?: unknown; skills?: unknown }
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined
  const rawSkills = parsed.skills
  if (typeof rawSkills === 'string') {
    return { name, skillsDeclared: rawSkills !== '', skillEntries: rawSkills ? [rawSkills] : [] }
  }
  if (Array.isArray(rawSkills)) {
    const entries = rawSkills.filter((s): s is string => typeof s === 'string')
    if (entries.length !== rawSkills.length) {
      log.warn(`plugin manifest ${dir}: non-string skills entries ignored`)
    }
    return { name, skillsDeclared: true, skillEntries: entries }
  }
  if (rawSkills !== undefined) {
    log.warn(`plugin manifest ${dir}: skills field must be a string or string[], ignored`)
  }
  return { name, skillsDeclared: false, skillEntries: [] }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Read one plugin SKILL.md into a record. `deriveName` is the branch-specific
 *  name rule (root scan: sanitized basename; single dir: frontmatter-first).
 *  Returns null for a contained failure (warn + omit) or a realpath duplicate
 *  (first wins). A missing SKILL.md is a silent skip — root-scan subdirs
 *  without one are normal (§5.8). */
async function readPluginSkill(
  file: string,
  pluginDir: string,
  prefix: string,
  seen: Set<string>,
  deriveName: (frontmatterName: string | undefined, dir: string) => string,
): Promise<SkillRecord | null> {
  let stat
  try {
    stat = await fs.stat(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`plugin skill stat failed ${file}: ${(err as Error).message ?? err}`)
    }
    return null
  }
  if (!stat.isFile()) return null
  if (stat.size > MAX_SKILL_BYTES) {
    log.warn(`plugin skill over ${MAX_SKILL_BYTES} bytes, omitting: ${file}`)
    return null
  }
  // realpath dedup (§5.8 Eze/VXt): a resolution failure keeps the record but
  // gives up cross-plugin dedup — the raw path is the best-effort key.
  let key: string
  try {
    key = realpathSync(file)
  } catch (err) {
    log.warn(`plugin skill realpath failed, keeping without dedup ${file}: ${(err as Error).message ?? err}`)
    key = file
  }
  if (seen.has(key)) {
    log.debug(`skipping duplicate plugin skill (realpath already loaded): ${file}`)
    return null
  }
  let content: string
  try {
    content = await fs.readFile(file, 'utf8')
  } catch (err) {
    log.warn(`plugin skill read failed, omitting ${file}: ${(err as Error).message ?? err}`)
    return null
  }
  seen.add(key)
  const parsed = parseSkillFrontmatter(content)
  const errors = parsed.errors.filter((e) => e !== FRONTMATTER_NAME_ERROR)
  const skillName = deriveName(parsed.name, dirname(file))
  return {
    scope: 'plugin',
    name: `${prefix}:${skillName}`,
    description: parsed.description ?? '',
    path: file,
    relativePath: relative(pluginDir, file),
    readOnly: true,
    valid: errors.length === 0,
    errors,
    updatedAt: stat.mtimeMs,
    size: stat.size,
    plugin: prefix,
    ...(parsed.disableModelInvocation !== undefined ? { disableModelInvocation: parsed.disableModelInvocation } : {}),
    ...(parsed.userInvocable !== undefined ? { userInvocable: parsed.userInvocable } : {}),
    ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
  }
}

/** Root-of-subdirs scan (§5.8 branch 2): one level, directories/symlinks only,
 *  each `<entry>/SKILL.md`; name = sanitized entry basename, frontmatter.name
 *  ignored. Sorted for deterministic first-wins dedup. */
async function scanSkillsRoot(root: string, pluginDir: string, prefix: string, seen: Set<string>): Promise<SkillRecord[]> {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (err) {
    log.warn(`plugin skills root readdir failed, omitting ${root}: ${(err as Error).message ?? err}`)
    return []
  }
  const dirs = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name))
  const out: SkillRecord[] = []
  for (const entry of dirs) {
    const record = await readPluginSkill(
      join(root, entry.name, SKILL_FILE),
      pluginDir,
      prefix,
      seen,
      (_frontmatterName, dir) => sanitizeSkillName(basename(dir)),
    )
    if (record) out.push(record)
  }
  return out
}

/** Manifest-entry auto-detect (§5.8 YXt): SKILL.md directly inside → single
 *  skill dir (frontmatter-first name); otherwise a subdirs-root. */
async function scanManifestEntry(target: string, pluginDir: string, prefix: string, seen: Set<string>): Promise<SkillRecord[]> {
  const direct = join(target, SKILL_FILE)
  if (await isFile(direct)) {
    const record = await readPluginSkill(direct, pluginDir, prefix, seen, (fmName, dir) => singleDirSkillName(prefix, fmName, dir))
    return record ? [record] : []
  }
  return scanSkillsRoot(target, pluginDir, prefix, seen)
}

async function scanPlugin(entry: EnabledPluginEntry, seen: Set<string>): Promise<SkillRecord[]> {
  const dir = entry.dir
  const manifest = await readPluginManifest(dir)
  // Prefix authority: the plugin's OWN manifest name read fresh, catalog name
  // as fallback (§5.8; CRW admits manifest-less plugin dirs).
  const prefix = manifest?.name ?? entry.name
  // Marketplace-root case: a single-plugin repo whose dir IS the clone root.
  const isRoot = dir === entry.cloneDir

  const defaultRoot = resolve(dir, DEFAULT_SKILLS_DIR)
  const resolvedEntries: string[] = []
  for (const raw of manifest?.skillEntries ?? []) {
    const target = resolve(dir, raw)
    const rel = relative(dir, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      log.warn(`plugin ${prefix}: manifest skills entry escapes the plugin dir, skipping: ${raw}`)
      continue
    }
    // The default skills/ dir is already covered by the root scan; at the
    // marketplace root the plugin root itself is also filtered (§5.8).
    if (target === defaultRoot) continue
    if (isRoot && target === resolve(dir)) continue
    resolvedEntries.push(target)
  }

  const out: SkillRecord[] = []
  const defaultExists = await isDirectory(defaultRoot)
  // At the marketplace root a manifest skills subdir declaration REPLACES the
  // default scan; everywhere else manifest entries load IN ADDITION to it.
  if (defaultExists && !(isRoot && resolvedEntries.length > 0)) {
    out.push(...await scanSkillsRoot(defaultRoot, dir, prefix, seen))
  }
  for (const target of resolvedEntries) {
    out.push(...await scanManifestEntry(target, dir, prefix, seen))
  }
  // Fallback: no skills/ dir AND no manifest skills declaration AND a root
  // SKILL.md → the plugin dir itself is a single skill dir (§5.8 branch 3).
  if (!defaultExists && !manifest?.skillsDeclared && (await isFile(join(dir, SKILL_FILE)))) {
    const record = await readPluginSkill(join(dir, SKILL_FILE), dir, prefix, seen, (fmName, skillDir) =>
      singleDirSkillName(prefix, fmName, skillDir),
    )
    if (record) out.push(record)
  }
  return out
}

/** CLI-shaped plugin skill discovery (§5.8 scan oracle). Iterates enabled
 *  plugin entries (undefined enabledPlugins = all; [] = none; otherwise key
 *  membership), scans each plugin's skills, and dedups by SKILL.md realpath
 *  across plugins (first wins). Per-plugin/per-skill failures are contained:
 *  warn + omit, never throw the whole pass. */
export async function listPluginSkills(mpStore: PluginSkillSource, enabledPlugins?: string[]): Promise<SkillRecord[]> {
  let entries = mpStore.getEnabledPluginEntries()
  if (enabledPlugins !== undefined) {
    const allow = new Set(enabledPlugins)
    entries = entries.filter((e) => allow.has(e.key))
  }
  const out: SkillRecord[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    try {
      out.push(...(await scanPlugin(entry, seen)))
    } catch (err) {
      log.warn(`plugin ${entry.name} (${entry.dir}): skill scan failed, omitting: ${(err as Error).message ?? err}`)
    }
  }
  return out
}
