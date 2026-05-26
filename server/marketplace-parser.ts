// Marketplace manifest parser.
//
// A marketplace is a git repository containing
// `<repoRoot>/.claude-plugin/marketplace.json`. The manifest lists plugins,
// each backed by a directory inside the same repo. We're defensive on every
// field — a malformed manifest can drop entries without rejecting the whole
// marketplace, and the file is treated as untrusted JSON (it came off the
// internet).

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'

/** Manifest filename, relative to the repo root. */
export const MANIFEST_REL_PATH = '.claude-plugin/marketplace.json'

/** A single plugin entry, post-parse, post-validation. The `dir` field is
 *  the absolute path on disk to the plugin's directory; resolved during
 *  `parseMarketplace` so consumers don't have to redo the lookup. Plugins
 *  whose dir doesn't exist are dropped from the parsed result. */
export interface ParsedPlugin {
  name: string
  description?: string
  version?: string
  author?: string
  category?: string
  tags?: string[]
  /** Absolute on-disk plugin directory inside the cloned repo. */
  dir: string
}

export interface MarketplaceManifest {
  /** Marketplace display name (from manifest; may differ from our slug). */
  name: string
  version?: string
  owner?: { name?: string; url?: string }
  plugins: ParsedPlugin[]
}

/** Parser warning surfaced to the route layer for logging / UI display.
 *  Non-fatal: a manifest can produce warnings AND a usable plugin list. */
export interface ParseWarning {
  kind: 'plugin-missing-name' | 'plugin-dir-not-found' | 'plugin-invalid-name' | 'plugin-bad-shape'
  detail: string
}

export interface ParseResult {
  manifest: MarketplaceManifest
  warnings: ParseWarning[]
}

const PLUGIN_NAME_RE = /^[a-zA-Z0-9._-]+$/

/** Restrict plugin names to a charset that's safe to embed in URLs and
 *  JSON keys without escaping. Matches what `assertSafeName` enforces in
 *  the existing CLI-shelling marketplace.ts. */
function isSafeName(s: string): boolean {
  return PLUGIN_NAME_RE.test(s) && !s.startsWith('.')
}

/** Coerce a raw author entry — either `"Alice"` or `{ name: "Alice", … }` — to
 *  a flat string, or undefined when neither shape is present. */
function flattenAuthor(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (typeof r.name === 'string' && r.name.trim()) return r.name.trim()
  }
  return undefined
}

/** Validate a plugin's source.path: must be relative to the repo, no `..`
 *  segments, no leading slash. Returns the normalised path or null on reject.
 *  We deliberately don't allow absolute paths — every plugin dir must live
 *  inside the cloned repo. */
function validateRelativePath(p: string): string | null {
  if (typeof p !== 'string' || !p) return null
  if (isAbsolute(p)) return null
  const normalised = normalize(p).split(sep).join('/')
  if (normalised.startsWith('/') || normalised.startsWith('../')) return null
  if (normalised.split('/').some((seg) => seg === '..')) return null
  return normalised
}

/** Read and parse a marketplace manifest from a cloned repo. Returns the
 *  parsed manifest (with plugins whose directories were verified to exist)
 *  plus a list of non-fatal warnings. Throws if:
 *    - the manifest file is missing or unreadable
 *    - the JSON is malformed
 *    - the top-level shape isn't an object with a `plugins` array
 *
 *  Per-plugin failures (missing name, missing dir) are warnings, not errors:
 *  the caller still gets a usable marketplace with the surviving plugins. */
export async function parseMarketplace(repoRoot: string): Promise<ParseResult> {
  const manifestPath = join(repoRoot, MANIFEST_REL_PATH)
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      throw new Error(`marketplace manifest not found at ${MANIFEST_REL_PATH}`)
    }
    throw new Error(`failed to read marketplace manifest: ${e.message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`marketplace manifest is not valid JSON: ${(err as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('marketplace manifest must be a JSON object')
  }

  const root = parsed as Record<string, unknown>
  const warnings: ParseWarning[] = []

  // Top-level fields
  const name = typeof root.name === 'string' && root.name.trim() ? root.name.trim() : 'unnamed'
  const version = typeof root.version === 'string' ? root.version.trim() || undefined : undefined
  const owner = root.owner && typeof root.owner === 'object' && !Array.isArray(root.owner)
    ? coerceOwner(root.owner as Record<string, unknown>)
    : undefined

  if (!Array.isArray(root.plugins)) {
    throw new Error('marketplace manifest must have a `plugins` array')
  }

  const plugins: ParsedPlugin[] = []
  const seenNames = new Set<string>()

  for (const rawEntry of root.plugins) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      warnings.push({ kind: 'plugin-bad-shape', detail: 'plugin entry is not an object' })
      continue
    }
    const entry = rawEntry as Record<string, unknown>

    const pName = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!pName) {
      warnings.push({ kind: 'plugin-missing-name', detail: 'plugin entry missing `name` field' })
      continue
    }
    if (!isSafeName(pName)) {
      warnings.push({
        kind: 'plugin-invalid-name',
        detail: `plugin name "${pName}" rejected — must match [a-zA-Z0-9._-] and not start with a dot`,
      })
      continue
    }
    if (seenNames.has(pName)) {
      // Duplicate names within one manifest break our `<plugin>@<marketplace>`
      // key scheme. Keep the first; warn on the rest.
      warnings.push({ kind: 'plugin-bad-shape', detail: `duplicate plugin name "${pName}"; ignoring later entry` })
      continue
    }
    seenNames.add(pName)

    // Resolve plugin directory. Convention: each plugin lives at
    // `<repo>/<plugin.source.path>` if the manifest specifies a path,
    // otherwise at `<repo>/<plugin.name>`. (Both conventions show up in
    // real-world Anthropic marketplaces.) The source object's exact shape
    // varies — we accept `{path: '...'}` as the canonical form and ignore
    // every other variant for now.
    let relDir: string | null = pName
    if (entry.source && typeof entry.source === 'object' && !Array.isArray(entry.source)) {
      const src = entry.source as Record<string, unknown>
      if (typeof src.path === 'string' && src.path.trim()) {
        relDir = validateRelativePath(src.path.trim())
        if (!relDir) {
          warnings.push({
            kind: 'plugin-bad-shape',
            detail: `plugin "${pName}" has invalid source.path; falling back to plugin name as directory`,
          })
          relDir = pName
        }
      }
    }
    const absDir = join(repoRoot, relDir)
    if (!existsSync(absDir)) {
      warnings.push({
        kind: 'plugin-dir-not-found',
        detail: `plugin "${pName}" directory not found at ${relDir}; skipping`,
      })
      continue
    }

    plugins.push({
      name: pName,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      version: typeof entry.version === 'string' ? entry.version : undefined,
      author: flattenAuthor(entry.author),
      category: typeof entry.category === 'string' ? entry.category : undefined,
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((t): t is string => typeof t === 'string')
        : undefined,
      dir: absDir,
    })
  }

  return {
    manifest: { name, version, owner, plugins },
    warnings,
  }
}

function coerceOwner(raw: Record<string, unknown>): MarketplaceManifest['owner'] {
  const out: { name?: string; url?: string } = {}
  if (typeof raw.name === 'string' && raw.name.trim()) out.name = raw.name.trim()
  if (typeof raw.url === 'string' && raw.url.trim()) out.url = raw.url.trim()
  return Object.keys(out).length > 0 ? out : undefined
}
