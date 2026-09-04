// Parse an App Plugin marketplace clone.
//
// Reads an optional `app-plugins-marketplace.json` at the repo root; if
// absent, auto-scans immediate top-level subdirectories for a
// `crw-plugin.json` (the plugin manifests ARE the catalog). Each entry's
// `dir` is validated for containment (relative, no `..` / absolute) so a
// malicious catalog can't point install at a path outside the clone.
//
// Pure filesystem read — no git. The route layer does the clone (via
// server/git-clone.ts) then hands the clone dir here.

import { promises as fs } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { createLogger } from '../log.js'
import { validateRelativePath } from '../../shared/app-plugins/path-security.js'
import { MANIFEST_FILE } from '../../shared/app-plugins/manifest.js'
import type {
  AppPluginMarketplaceManifest,
  AppPluginMarketplacePlugin,
} from '../../shared/app-plugins/marketplace.js'

const log = createLogger('app-plugins:mp-parser')

const MARKETPLACE_FILE = 'app-plugins-marketplace.json'

/** Parse a marketplace clone. Returns the catalog (name + plugins). Throws
 *  on a malformed marketplace.json; an empty catalog (no plugins found) is
 *  a valid result, not an error. `subdir` is an optional contained relative
 *  path within `repoRoot` that holds the marketplace content (the official
 *  host repo keeps its catalog in `plugins/`). */
export async function parseAppPluginMarketplace(repoRoot: string, subdir?: string): Promise<AppPluginMarketplaceManifest> {
  const root = marketplaceRoot(repoRoot, subdir)
  const manifestPath = join(root, MARKETPLACE_FILE)
  let fromManifest = false
  let name: string | undefined
  let entries: AppPluginMarketplacePlugin[] = []

  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as { name?: unknown; appPlugins?: unknown }
      name = typeof obj.name === 'string' ? obj.name : undefined
      if (Array.isArray(obj.appPlugins)) {
        entries = coerceEntries(obj.appPlugins)
        fromManifest = true
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') {
      throw new Error(`failed to read ${MARKETPLACE_FILE}: ${e.message}`)
    }
    // No manifest file → fall through to auto-scan.
  }

  if (!fromManifest) {
    entries = await autoScan(root)
    if (entries.length === 0) {
      log.warn(`no ${MARKETPLACE_FILE} and no plugins found by auto-scan in ${root}`)
    }
  }

  // De-duplicate by name (keep first); drop entries with duplicate dirs.
  const seen = new Set<string>()
  const plugins = entries.filter((e) => {
    if (seen.has(e.name)) return false
    seen.add(e.name)
    return true
  })

  return { name, plugins }
}

/** Coerce a raw `appPlugins` array into validated plugin entries. Entries
 *  with a non-contained `dir` are dropped (with a warning). */
function coerceEntries(raw: unknown[]): AppPluginMarketplacePlugin[] {
  const out: AppPluginMarketplacePlugin[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const e = item as { name?: unknown; dir?: unknown; description?: unknown; version?: unknown }
    if (typeof e.name !== 'string' || !e.name) continue
    if (typeof e.dir !== 'string' || !e.dir) continue
    const err = validateRelativePath(e.dir, { isWindows: process.platform === 'win32' })
    if (err) {
      log.warn(`marketplace entry '${e.name}' has invalid dir '${e.dir}': ${err}`)
      continue
    }
    out.push({
      name: e.name,
      dir: e.dir,
      description: typeof e.description === 'string' ? e.description : undefined,
      version: typeof e.version === 'string' ? e.version : undefined,
    })
  }
  return out
}

/** Auto-scan: list immediate subdirectories of `repoRoot` that contain a
 *  `crw-plugin.json`. Reads just the manifest's id/name/description/version
 *  for the catalog; full validation happens at install. */
async function autoScan(repoRoot: string): Promise<AppPluginMarketplacePlugin[]> {
  let names: string[]
  try {
    names = await fs.readdir(repoRoot)
  } catch (err) {
    log.warn(`auto-scan readdir failed on ${repoRoot}: ${(err as Error).message}`)
    return []
  }
  const out: AppPluginMarketplacePlugin[] = []
  await Promise.all(
    names.map(async (nm) => {
      const sub = join(repoRoot, nm)
      const stat = await fs.stat(sub).catch(() => null)
      if (!stat || !stat.isDirectory()) return
      const manifestPath = join(sub, MANIFEST_FILE)
      if (!(await pathExists(manifestPath))) return
      // Read id/name/description/version for the catalog. A parse failure
      // here is non-fatal — the entry is just skipped (install re-validates).
      try {
        const raw = await fs.readFile(manifestPath, 'utf8')
        const m = JSON.parse(raw) as { id?: string; name?: string; description?: string; version?: string }
        out.push({
          name: m.id ?? nm,
          dir: nm,
          description: typeof m.description === 'string' ? m.description : undefined,
          version: typeof m.version === 'string' ? m.version : undefined,
        })
      } catch (err) {
        log.warn(`auto-scan: skipping ${nm} (unparseable ${MANIFEST_FILE}): ${(err as Error).message}`)
      }
    }),
  )
  return out
}

/** Auto-detect the marketplace content subdirectory of a clone whose root has
 *  no catalog or plugin dirs directly. A top-level directory counts as a
 *  candidate only when it can actually yield plugins: it has an immediate
 *  child that is a plugin dir (contains a `crw-plugin.json`), or it ships an
 *  `app-plugins-marketplace.json` whose `appPlugins` list is non-empty (an
 *  empty or malformed catalog — a common vestige after a restructure — is not
 *  content). Returns the sole candidate (relative to `repoRoot`), or
 *  `undefined` when there is none or several — ambiguity is left to the caller
 *  (an explicit `subdir` override). */
export async function detectAppPluginMarketplaceSubdir(repoRoot: string): Promise<string | undefined> {
  const names = await fs.readdir(repoRoot).catch(() => [])
  const candidates: string[] = []
  await Promise.all(
    names.map(async (nm) => {
      const sub = join(repoRoot, nm)
      const stat = await fs.stat(sub).catch(() => null)
      if (!stat || !stat.isDirectory()) return
      if ((await childHasPluginManifest(sub)) || (await shipsNonEmptyCatalog(sub))) {
        candidates.push(nm)
      }
    }),
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

/** True when some immediate child of `dir` is itself a plugin dir (contains a
 *  `crw-plugin.json`). */
async function childHasPluginManifest(dir: string): Promise<boolean> {
  const names = await fs.readdir(dir).catch(() => [])
  for (const child of names) {
    const cstat = await fs.stat(join(dir, child)).catch(() => null)
    if (cstat?.isDirectory() && await pathExists(join(dir, child, MANIFEST_FILE))) return true
  }
  return false
}

/** True when `dir` ships a marketplace catalog that actually yields at least
 *  one plugin. A missing, malformed, or empty `appPlugins` array is not
 *  content — and neither is a catalog whose entries all get dropped by
 *  coercion (invalid dirs), since it would produce zero plugins. */
async function shipsNonEmptyCatalog(dir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(join(dir, MARKETPLACE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const appPlugins = (parsed as { appPlugins?: unknown }).appPlugins
    return Array.isArray(appPlugins) && coerceEntries(appPlugins).length > 0
  } catch {
    return false
  }
}

/** Result of a content-preferred parse: the manifest actually used, plus an
 *  optional malformed-catalog error retained so the caller can surface it when
 *  nothing else yields content (see parseAppPluginMarketplaceAuto). */
interface ContentParse {
  manifest: AppPluginMarketplaceManifest
  malformed?: Error
}

/** Content-preferring parse used by the auto/heal path. Unlike the plain
 *  parser, an EMPTY or MALFORMED `app-plugins-marketplace.json` is not treated
 *  as authoritative: if the effective root actually holds plugin dirs
 *  (auto-scan finds `crw-plugin.json` entries), the on-disk plugins win over
 *  the vestige. A non-empty catalog is still trusted verbatim. */
async function parseContentPreferred(repoRoot: string, subdir?: string): Promise<ContentParse> {
  const root = marketplaceRoot(repoRoot, subdir)
  let manifest: AppPluginMarketplaceManifest
  let malformed: Error | undefined
  try {
    manifest = await parseAppPluginMarketplace(repoRoot, subdir)
  } catch (err) {
    malformed = err as Error
    manifest = { plugins: [] }
  }
  if (manifest.plugins.length > 0) return { manifest }
  const scanned = await autoScan(root)
  if (scanned.length > 0) return { manifest: { name: manifest.name, plugins: scanned } }
  return { manifest, malformed }
}

/** Parse a marketplace clone, returning the content root that actually yields
 *  plugins. Candidates are tried in order — the explicitly-requested subdir,
 *  then the repo root, then a unique nested content dir — and the FIRST that
 *  yields plugins wins. Returns the subdir used (so callers can persist it for
 *  later refresh / install resolution) alongside the manifest.
 *
 *  This is deliberately content-preferring: an empty or malformed result from
 *  an earlier candidate (a dead/renamed subdir, an empty or broken catalog, a
 *  repo restructure that moved content while leaving a vestigial dir behind)
 *  falls through instead of pinning an empty marketplace on the record. A
 *  subdir is only ever persisted when it produced plugins, so a refresh always
 *  re-runs the search and heals. A malformed catalog is only surfaced as an
 *  error when NO candidate yields content (a wholly-broken marketplace), so
 *  the caller still gets a 400 instead of a silent empty marketplace. */
export async function parseAppPluginMarketplaceAuto(
  repoRoot: string,
  explicitSubdir?: string,
): Promise<{ subdir?: string; manifest: AppPluginMarketplaceManifest }> {
  let malformed: Error | undefined
  const empty: AppPluginMarketplaceManifest = { plugins: [] }

  if (explicitSubdir && (await pathExists(join(repoRoot, explicitSubdir)))) {
    const attempt = await parseContentPreferred(repoRoot, explicitSubdir)
    malformed ??= attempt.malformed
    if (attempt.manifest.plugins.length > 0) return { subdir: explicitSubdir, manifest: attempt.manifest }
  }
  const rootAttempt = await parseContentPreferred(repoRoot)
  malformed ??= rootAttempt.malformed
  if (rootAttempt.manifest.plugins.length > 0) return { subdir: undefined, manifest: rootAttempt.manifest }
  const detected = await detectAppPluginMarketplaceSubdir(repoRoot)
  if (detected) {
    const attempt = await parseContentPreferred(repoRoot, detected)
    malformed ??= attempt.malformed
    if (attempt.manifest.plugins.length > 0) return { subdir: detected, manifest: attempt.manifest }
  }
  if (malformed) throw malformed
  return { subdir: undefined, manifest: empty }
}

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false)
}

/** Resolve a plugin entry's absolute dir within the clone (after containment
 *  was already validated). Used by the install route. `subdir` is the
 *  marketplace content subdir, resolved first. */
export function pluginDirInClone(repoRoot: string, dir: string, subdir?: string): string {
  // resolvePath with a relative `dir` stays under the effective root; the
  // entry was already validated to be relative + contained, and the subdir
  // is validated by marketplaceRoot.
  return resolvePath(marketplaceRoot(repoRoot, subdir), dir)
}

/** Resolve the effective marketplace root (clone root + optional subdir),
 *  validating that the subdir stays inside the clone. The record layer
 *  validates on persist; this re-checks as defense-in-depth because the
 *  parser can also be called directly. */
function marketplaceRoot(repoRoot: string, subdir?: string): string {
  if (!subdir) return repoRoot
  const err = validateRelativePath(subdir, { isWindows: process.platform === 'win32' })
  if (err) throw new Error(`invalid marketplace subdir '${subdir}': ${err}`)
  return join(repoRoot, subdir)
}
