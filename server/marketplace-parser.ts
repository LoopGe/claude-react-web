// Plugin-source manifest parser.
//
// A cloned repo can be either of two forms:
//   - a marketplace: `<repoRoot>/.claude-plugin/marketplace.json` lists plugins,
//     each backed by a directory inside the same repo (or an external repo).
//   - a single plugin: `<repoRoot>/.claude-plugin/plugin.json` names ONE plugin
//     whose files live at the repo root (e.g. mattpocock/skills). The SDK loads
//     plugin.json itself to discover skills/commands/agents, so we only extract
//     the plugin's `name` + display metadata and treat the repo root as the
//     plugin directory.
// `parseRepoManifest` dispatches between the two (marketplace.json wins on
// conflict). We're defensive on every field — a malformed manifest can drop
// entries without rejecting the whole marketplace, and every file is treated as
// untrusted JSON (it came off the internet).

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

/** Manifest filename, relative to the repo root. */
export const MANIFEST_REL_PATH = '.claude-plugin/marketplace.json'

/** A single-plugin repo's manifest, relative to the repo root. When a repo
 *  has this and no `marketplace.json`, the whole repo root IS the plugin
 *  directory (the SDK loads `<root>/.claude-plugin/plugin.json` itself). */
export const PLUGIN_MANIFEST_REL_PATH = '.claude-plugin/plugin.json'

/** Where a plugin physically lives.
 *   - `in-repo`: a directory inside the marketplace's own cloned repo. The
 *     `dir` field on ParsedPlugin holds its resolved absolute path.
 *   - `git-subdir`: a subdirectory of a SEPARATE git repo. The plugin's files
 *     aren't present until that external repo is cloned (lazily, on first
 *     enable). `dir` stays null until then; the store resolves the eventual
 *     path from `url`+`sha`+`subPath`. */
export type ParsedPluginSource =
  | { kind: 'in-repo' }
  | { kind: 'git-subdir'; url: string; subPath: string; ref?: string; sha: string }

/** A single plugin entry, post-parse, post-validation. For in-repo plugins
 *  `dir` is the absolute path on disk, resolved during `parseMarketplace` so
 *  consumers don't have to redo the lookup (in-repo plugins whose dir doesn't
 *  exist are dropped). For git-subdir plugins `dir` is null until the external
 *  repo is cloned. */
export interface ParsedPlugin {
  name: string
  description?: string
  version?: string
  author?: string
  category?: string
  tags?: string[]
  /** Absolute on-disk plugin directory for in-repo plugins; null for
   *  git-subdir plugins until their external repo has been cloned. */
  dir: string | null
  /** Physical location discriminator. Undefined is treated as in-repo
   *  (back-compat with manifests persisted before this field existed). */
  source?: ParsedPluginSource
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

/** Non-throwing https-URL check. Mirrors `assertHttpsUrl` in git-clone.ts
 *  but returns a boolean — the parser emits warnings rather than throwing
 *  HttpError, so importing the throwing version would be the wrong layer. */
function isHttpsUrl(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    url.length > 0 &&
    url.length <= 4096 &&
    !url.includes('\0') &&
    /^https:\/\/[^\s]+$/.test(url)
  )
}

/** Validate a git commit SHA (full or abbreviated, 7-40 hex chars). */
function isValidSha(sha: unknown): sha is string {
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha)
}

/** Re-validate an already-parsed plugin's source. Used when loading a
 *  PERSISTED manifest from disk (marketplaces.json) — the file is treated as
 *  untrusted (a user could hand-edit it), so we re-apply the same checks the
 *  live parser does rather than trusting the cast. A git-subdir source must
 *  have an https url, a containment-safe relative subPath (no `..`, not
 *  absolute), and a valid sha; in-repo / undefined sources are always OK. */
export function isValidParsedSource(source: ParsedPluginSource | undefined): boolean {
  if (!source || source.kind === 'in-repo') return true
  return (
    isHttpsUrl(source.url) &&
    validateRelativePath(source.subPath) !== null &&
    isValidSha(source.sha)
  )
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

    // Common metadata shared by every source kind.
    const meta = {
      name: pName,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      version: typeof entry.version === 'string' ? entry.version : undefined,
      author: flattenAuthor(entry.author),
      category: typeof entry.category === 'string' ? entry.category : undefined,
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((t): t is string => typeof t === 'string')
        : undefined,
    }

    // External-repo plugins: the plugin's files live in a SEPARATE git repo,
    // not in the marketplace repo. Two manifest shapes map to this:
    //   - `source: 'git-subdir'` — a SUBDIRECTORY of the external repo (`path`
    //     required).
    //   - `source: 'url'`        — the WHOLE external repo (no `path`; the
    //     plugin is the repo root).
    // Both clone the external repo at `sha` lazily on first enable, so we
    // don't resolve a local dir here — capture url/subPath/ref/sha and move
    // on WITHOUT emitting plugin-dir-not-found.
    const srcType = entry.source && typeof entry.source === 'object' && !Array.isArray(entry.source)
      ? (entry.source as Record<string, unknown>).source
      : undefined
    if (srcType === 'git-subdir' || srcType === 'url') {
      const src = entry.source as Record<string, unknown>
      if (!isHttpsUrl(src.url)) {
        warnings.push({
          kind: 'plugin-bad-shape',
          detail: `plugin "${pName}" ${srcType} source has a non-https url; skipping`,
        })
        continue
      }
      // git-subdir requires a path; url defaults to the repo root (`.`).
      let subPath: string | null
      if (srcType === 'url') {
        subPath = typeof src.path === 'string' && src.path.trim() ? validateRelativePath(src.path) : '.'
      } else {
        subPath = typeof src.path === 'string' ? validateRelativePath(src.path) : null
      }
      if (!subPath) {
        warnings.push({
          kind: 'plugin-bad-shape',
          detail: `plugin "${pName}" ${srcType} source has an invalid path; skipping`,
        })
        continue
      }
      if (!isValidSha(src.sha)) {
        warnings.push({
          kind: 'plugin-bad-shape',
          detail: `plugin "${pName}" ${srcType} source is missing a valid sha; skipping`,
        })
        continue
      }
      const ref = typeof src.ref === 'string' && src.ref.trim() && !src.ref.includes('\0') && src.ref.length <= 256
        ? src.ref.trim()
        : undefined
      plugins.push({
        ...meta,
        dir: null,
        source: { kind: 'git-subdir', url: src.url, subPath, ref, sha: src.sha },
      })
      continue
    }

    // Resolve plugin directory. Convention: each plugin lives at
    // `<repo>/<plugin.source>` if the manifest specifies one, otherwise at
    // `<repo>/<plugin.name>`. (Both conventions show up in real-world
    // Anthropic marketplaces.) Two `source` shapes are accepted:
    //   "source": "./"             — string shorthand, the value IS the path
    //   "source": { path: "./" }   — canonical object form
    // Anything else (number, array, object without `path`) is ignored and we
    // fall back to the plugin name.
    let relDir: string | null = pName
    let rawSourcePath: string | null = null
    if (typeof entry.source === 'string') {
      const trimmed = entry.source.trim()
      if (trimmed) rawSourcePath = trimmed
    } else if (entry.source && typeof entry.source === 'object' && !Array.isArray(entry.source)) {
      const src = entry.source as Record<string, unknown>
      if (typeof src.path === 'string' && src.path.trim()) {
        rawSourcePath = src.path.trim()
      }
    }
    if (rawSourcePath !== null) {
      const validated = validateRelativePath(rawSourcePath)
      if (!validated) {
        warnings.push({
          kind: 'plugin-bad-shape',
          detail: `plugin "${pName}" has invalid source path; falling back to plugin name as directory`,
        })
      } else {
        relDir = validated
      }
    }
    // resolve() (vs join) canonicalises trailing separators — `'./'` produces
    // exactly `repoRoot` instead of `repoRoot + sep`.
    const absDir = resolve(repoRoot, relDir)
    if (!existsSync(absDir)) {
      warnings.push({
        kind: 'plugin-dir-not-found',
        detail: `plugin "${pName}" directory not found at ${relDir}; skipping`,
      })
      continue
    }

    plugins.push({
      ...meta,
      dir: absDir,
      source: { kind: 'in-repo' },
    })
  }

  return {
    manifest: { name, version, owner, plugins },
    warnings,
  }
}

/** Parse a single-plugin repo: one whose root IS the plugin directory and
 *  whose identity lives in `.claude-plugin/plugin.json` (no marketplace.json).
 *  This is the form popularised by repos like mattpocock/skills — the manifest
 *  names the plugin and lists its components (skills/commands/agents/...), but
 *  we DON'T parse those components: the SDK discovers them itself when we hand
 *  it the repo root as a local plugin path. We only need the plugin's `name`
 *  (to build the `<plugin>@<marketplace>` key) and display metadata.
 *
 *  Synthesises a one-plugin `MarketplaceManifest` whose single entry is an
 *  in-repo plugin with `dir === repoRoot`. Throws if `plugin.json` is missing,
 *  malformed, or lacks a valid `name` — without a name we can't build a safe
 *  key, and a plugin.json without one is malformed per the spec. */
export async function parseSinglePlugin(repoRoot: string): Promise<ParseResult> {
  const manifestPath = join(repoRoot, PLUGIN_MANIFEST_REL_PATH)
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      throw new Error(`plugin manifest not found at ${PLUGIN_MANIFEST_REL_PATH}`)
    }
    throw new Error(`failed to read plugin manifest: ${e.message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`plugin manifest is not valid JSON: ${(err as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('plugin manifest must be a JSON object')
  }

  const root = parsed as Record<string, unknown>

  const pName = typeof root.name === 'string' ? root.name.trim() : ''
  if (!pName) {
    throw new Error('plugin manifest must have a non-empty `name` field')
  }
  if (!isSafeName(pName)) {
    throw new Error(
      `plugin name "${pName}" rejected — must match [a-zA-Z0-9._-] and not start with a dot`,
    )
  }

  const description = typeof root.description === 'string' ? root.description : undefined
  const version = typeof root.version === 'string' ? root.version.trim() || undefined : undefined
  const author = flattenAuthor(root.author)

  // The repo root is the plugin directory; it always exists (we just cloned
  // it), so no existsSync check is needed — mirroring how in-repo marketplace
  // plugins trust their parse-time-verified dir.
  const plugin: ParsedPlugin = {
    name: pName,
    description,
    version,
    author,
    dir: repoRoot,
    source: { kind: 'in-repo' },
  }

  // Surface the author as the manifest owner for the marketplace list UI.
  // `author` may be `{ name, url }` or a bare string.
  let owner: MarketplaceManifest['owner']
  if (root.author && typeof root.author === 'object' && !Array.isArray(root.author)) {
    owner = coerceOwner(root.author as Record<string, unknown>)
  } else if (author) {
    owner = { name: author }
  } else {
    owner = undefined
  }

  // Use the plugin name as the marketplace display name; the route falls back
  // to the URL slug when this is empty, but the plugin name is the more
  // meaningful label here.
  return {
    manifest: { name: pName, version, owner, plugins: [plugin] },
    warnings: [],
  }
}

/** Parse a cloned repo into a marketplace manifest, accepting either of the
 *  two manifest forms a plugin source repo can take:
 *    - a marketplace:  `.claude-plugin/marketplace.json` (lists plugins)
 *    - a single plugin: `.claude-plugin/plugin.json`     (repo root = plugin)
 *  `marketplace.json` wins when both are present. Throws when neither exists
 *  (the repo isn't a plugin source we can use) — the route turns that into a
 *  400 and tears down the clone. This is the entry point callers should use;
 *  `parseMarketplace` / `parseSinglePlugin` are the form-specific specialists. */
export async function parseRepoManifest(repoRoot: string): Promise<ParseResult> {
  if (existsSync(join(repoRoot, MANIFEST_REL_PATH))) {
    return parseMarketplace(repoRoot)
  }
  if (existsSync(join(repoRoot, PLUGIN_MANIFEST_REL_PATH))) {
    return parseSinglePlugin(repoRoot)
  }
  throw new Error(
    'no plugin manifest found — expected .claude-plugin/marketplace.json or .claude-plugin/plugin.json',
  )
}

function coerceOwner(raw: Record<string, unknown>): MarketplaceManifest['owner'] {
  const out: { name?: string; url?: string } = {}
  if (typeof raw.name === 'string' && raw.name.trim()) out.name = raw.name.trim()
  if (typeof raw.url === 'string' && raw.url.trim()) out.url = raw.url.trim()
  return Object.keys(out).length > 0 ? out : undefined
}
