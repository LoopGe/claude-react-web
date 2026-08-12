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
      const exists = await fs.access(manifestPath).then(() => true).catch(() => false)
      if (!exists) return
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
