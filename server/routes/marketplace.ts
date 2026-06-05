// Plugin marketplace routes.
//
// All mutating operations (add / remove / refresh marketplace,
// install / uninstall / enable / disable plugin) shell out to the
// `claude` CLI via execFile (never a shell). The CLI is the source of
// truth for installed/enabled state, so listing also defers to
// `claude plugin list --json --available` rather than scraping the
// on-disk cache layout (which the CLI changes between versions — the
// previous direct-cache implementation broke silently when the layout
// shifted from `cache/<m>/<p>/<v>/...` to `marketplaces/<m>/...`).

import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { execPath } from 'node:process'

const CLAUDE_DIR = resolvePath(homedir(), '.claude')
const KNOWN_MARKETPLACES = resolvePath(CLAUDE_DIR, 'plugins', 'known_marketplaces.json')

/** Reject names containing path separators or leading dots — prevents
 *  path-traversal and CLI argument injection. Marketplace and plugin
 *  names produced by the CLI all match this character set. */
function assertSafeName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.startsWith('.')) {
    throw new Error(`Invalid ${label}: "${name}" — must match [a-zA-Z0-9._-] and not start with a dot`)
  }
}

/** How to invoke the `claude` CLI: a command plus any leading argv elements
 *  that must precede the per-call arguments. */
interface ClaudeInvocation {
  cmd: string
  prefix: string[]
}

/** Resolve how to invoke the CLI from the binary path the server already
 *  resolved (cli.ts `resolveClaudeBinary`). That value can be:
 *   - undefined → fall back to the bare name `claude` and let the OS / SDK
 *     resolve it (preserves prior behavior on hosts where resolution failed).
 *   - a `.js` script path (the common Windows case — npm's `.cmd` shim is
 *     de-shimmed to its underlying script). `execFile` cannot run a `.js`
 *     directly, so we run it with the current Node, mirroring how
 *     npm-install.ts invokes npm-cli.js.
 *   - any other absolute path (e.g. a native `claude.exe` on Windows or the
 *     Unix launcher) → run it directly. Crucially this is an absolute path,
 *     so `execFile` does NOT depend on PATHEXT — which is exactly the bug
 *     that made a bare `claude` fail on Windows. */
function resolveClaudeInvocation(claudeBinary: string | undefined): ClaudeInvocation {
  if (!claudeBinary) return { cmd: 'claude', prefix: [] }
  if (claudeBinary.toLowerCase().endsWith('.js')) {
    return { cmd: execPath, prefix: [claudeBinary] }
  }
  return { cmd: claudeBinary, prefix: [] }
}

/** Run the `claude` CLI with a fixed argv. NEVER goes through a shell —
 *  arbitrary-looking source strings (URLs, paths) are passed verbatim
 *  as a single argv element so shell metacharacters carry no meaning.
 *  Default timeout is generous because `marketplace add` and
 *  `marketplace update` may clone repos. */
async function execClaude(
  invocation: ClaudeInvocation,
  args: string[],
  timeoutMs = 120_000,
): Promise<string> {
  const argv = [...invocation.prefix, ...args]
  return new Promise<string>((resolve, reject) => {
    execFile(invocation.cmd, argv, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          reject(new Error('claude CLI not found on PATH — install it first'))
        } else {
          // Prefer stderr (CLI's actual diagnostic) over the Node error message
          // (which is usually "Command failed: ..." with no useful detail).
          const detail = (stderr || (err as Error).message || '').trim()
          reject(new Error(detail || `claude CLI exited with code ${code ?? 'unknown'}`))
        }
      } else {
        resolve(stdout)
      }
    })
  })
}

// ─── Source normalization ──────────────────────────────────────────
//
// known_marketplaces.json stores `source` as a structured object whose
// shape varies by source type:
//   - { source: 'github', repo: 'owner/repo' }
//   - { source: 'url',    url: 'https://...' }
//   - { source: 'path',   path: '/abs/...' }
//   - { source: 'git-subdir', url, path, ref, sha }
// The client just wants a single display string, so we collapse the
// object here. Unknown shapes fall back to `JSON.stringify` so we can
// at least show *something* rather than `[object Object]`.

interface SourceShape {
  source?: string
  repo?: string
  url?: string
  path?: string
}

function formatSource(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const o = value as SourceShape
    if (typeof o.repo === 'string') return `github:${o.repo}`
    if (typeof o.url === 'string') return o.url
    if (typeof o.path === 'string') return o.path
    if (typeof o.source === 'string') return o.source
    try { return JSON.stringify(o) } catch { /* fall through */ }
  }
  return ''
}

// ─── Plugin listing via `claude plugin list --json --available` ────
//
// Cached for 10s to keep the per-marketplace UI snappy without burning
// a subprocess on every keystroke in the filter input. Mutations
// (install/uninstall/enable/disable) invalidate the cache so the list
// reflects fresh state immediately.

interface RawPlugin {
  pluginId?: string
  name?: string
  description?: string
  marketplaceName?: string
  source?: unknown
  installCount?: number
  // Best-effort enabled flag; falls back to true if absent on installed
  // plugins. The CLI's exact schema for `installed[]` may evolve.
  enabled?: boolean
  version?: string
  author?: { name?: string } | string
}

interface PluginListJson {
  installed: RawPlugin[]
  available: RawPlugin[]
}

let pluginListCache: { fetchedAt: number; data: PluginListJson } | null = null
const PLUGIN_LIST_TTL = 10_000

function invalidatePluginListCache(): void {
  pluginListCache = null
}

async function getPluginList(invocation: ClaudeInvocation): Promise<PluginListJson> {
  if (pluginListCache && Date.now() - pluginListCache.fetchedAt < PLUGIN_LIST_TTL) {
    return pluginListCache.data
  }
  const stdout = await execClaude(invocation, ['plugin', 'list', '--json', '--available'], 30_000)
  try {
    const parsed = JSON.parse(stdout) as Partial<PluginListJson>
    const data: PluginListJson = {
      installed: Array.isArray(parsed.installed) ? parsed.installed : [],
      available: Array.isArray(parsed.available) ? parsed.available : [],
    }
    pluginListCache = { fetchedAt: Date.now(), data }
    return data
  } catch {
    // If the CLI ever changes its output shape, return an empty list
    // rather than 500 — the UI already handles the empty case.
    return { installed: [], available: [] }
  }
}

function authorOf(p: RawPlugin): string {
  if (typeof p.author === 'string') return p.author
  if (p.author && typeof p.author.name === 'string') return p.author.name
  return ''
}

export function buildMarketplaceRouter(claudeBinary?: string): Hono {
  const app = new Hono()
  // Resolve once at build time; reused by every route's execClaude call.
  const invocation = resolveClaudeInvocation(claudeBinary)

  // ─── Marketplace endpoints ────────────────────────────────────

  /** List registered marketplaces. */
  app.get('/marketplaces', async (c) => {
    try {
      const raw = await readFile(KNOWN_MARKETPLACES, 'utf-8')
      const data = JSON.parse(raw) as Record<string, { source?: unknown; lastUpdated?: string }>
      const marketplaces = Object.entries(data).map(([name, info]) => ({
        name,
        source: formatSource(info?.source),
        lastUpdated: typeof info?.lastUpdated === 'string' ? info.lastUpdated : undefined,
      }))
      return c.json({ marketplaces })
    } catch {
      return c.json({ marketplaces: [] })
    }
  })

  /** Add a marketplace. Body: { source }. The CLI accepts a wide range
   *  of source forms (GitHub `owner/repo`, full git URL, https URL,
   *  local absolute or relative path). We don't try to second-guess
   *  the format — the CLI validates and reports useful errors that we
   *  pass straight through. */
  app.post('/marketplaces', async (c) => {
    const body = await c.req.json<{ source?: unknown }>().catch(() => ({} as { source?: unknown }))
    const source = typeof body.source === 'string' ? body.source.trim() : ''
    if (!source) return c.json({ error: 'source is required' }, 400)
    if (source.length > 4096) return c.json({ error: 'source too long' }, 400)
    if (source.includes('\0')) return c.json({ error: 'source contains NUL byte' }, 400)
    try {
      const output = await execClaude(invocation, ['plugin', 'marketplace', 'add', source])
      invalidatePluginListCache()
      return c.json({ ok: true, output })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  /** Remove a marketplace's registration. Plugins from this marketplace
   *  stay installed — the UI must surface this clearly. */
  app.delete('/marketplaces/:name', async (c) => {
    const name = c.req.param('name')
    try {
      assertSafeName(name, 'marketplace')
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    try {
      const output = await execClaude(invocation, ['plugin', 'marketplace', 'remove', name])
      invalidatePluginListCache()
      return c.json({ ok: true, output })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  /** Refresh a single marketplace from its source. */
  app.post('/marketplaces/:name/refresh', async (c) => {
    const name = c.req.param('name')
    try {
      assertSafeName(name, 'marketplace')
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    try {
      const output = await execClaude(invocation, ['plugin', 'marketplace', 'update', name])
      invalidatePluginListCache()
      return c.json({ ok: true, output })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  /** Refresh all marketplaces. CLI: `claude plugin marketplace update`
   *  with no name. Note: the route is registered BEFORE
   *  `/marketplaces/:name/refresh` so it doesn't get swallowed by the
   *  parametrized variant — but Hono matches in declaration order
   *  per-method anyway, and POST `/marketplaces/refresh-all` doesn't
   *  shape-collide with `/marketplaces/:name/refresh` (different path
   *  segments), so order is harmless either way. */
  app.post('/marketplaces/refresh-all', async (c) => {
    try {
      const output = await execClaude(invocation, ['plugin', 'marketplace', 'update'])
      invalidatePluginListCache()
      return c.json({ ok: true, output })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  // ─── Plugin endpoints ─────────────────────────────────────────

  /** List plugins available in a given marketplace. We fetch the union
   *  of installed + available from the CLI and filter by marketplace
   *  name. Each plugin is annotated with `installed` and (when
   *  installed) `enabled`. */
  app.get('/marketplaces/:name/plugins', async (c) => {
    const marketplace = c.req.param('name')
    try {
      assertSafeName(marketplace, 'marketplace')
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    try {
      const list = await getPluginList(invocation)
      // Build a map of installed entries keyed by pluginId so we can
      // O(1) merge them onto the available list — and surface installed
      // plugins whose marketplace is no longer registered (rare, but
      // the user should still see them if they want to uninstall).
      const installedById = new Map<string, RawPlugin>()
      for (const p of list.installed) {
        if (p.pluginId) installedById.set(p.pluginId, p)
      }
      const seenIds = new Set<string>()
      const plugins: Array<{
        name: string
        description: string
        version: string
        author: string
        marketplace: string
        installed: boolean
        enabled: boolean
      }> = []
      // Available plugins for this marketplace, with installed-state merge.
      for (const p of list.available) {
        if (p.marketplaceName !== marketplace) continue
        const id = p.pluginId ?? `${p.name ?? ''}@${marketplace}`
        seenIds.add(id)
        const inst = installedById.get(id)
        plugins.push({
          name: p.name ?? id.split('@')[0],
          description: p.description ?? '',
          version: p.version ?? (inst?.version ?? 'unknown'),
          author: authorOf(p) || authorOf(inst ?? {}),
          marketplace,
          installed: !!inst,
          // Default to true (enabled) when the CLI doesn't expose an
          // explicit flag — most installed plugins are enabled by default.
          enabled: inst ? inst.enabled !== false : false,
        })
      }
      // Installed plugins for this marketplace that aren't in available
      // (e.g. version no longer published, or marketplace changed name).
      for (const p of list.installed) {
        if (p.marketplaceName !== marketplace) continue
        const id = p.pluginId ?? `${p.name ?? ''}@${marketplace}`
        if (seenIds.has(id)) continue
        plugins.push({
          name: p.name ?? id.split('@')[0],
          description: p.description ?? '',
          version: p.version ?? 'unknown',
          author: authorOf(p),
          marketplace,
          installed: true,
          enabled: p.enabled !== false,
        })
      }
      // Stable, name-sorted order so the UI doesn't reshuffle on refetch.
      plugins.sort((a, b) => a.name.localeCompare(b.name))
      return c.json({ plugins })
    } catch (e) {
      // CLI errors propagate as 500 with the diagnostic — useful for
      // debugging missing CLI / network failures.
      return c.json({ error: (e as Error).message, plugins: [] }, 500)
    }
  })

  /** Install a plugin from a marketplace. */
  app.post('/marketplaces/:name/plugins/:plugin/install', async (c) => {
    const marketplace = c.req.param('name')
    const plugin = c.req.param('plugin')
    try {
      assertSafeName(marketplace, 'marketplace')
      assertSafeName(plugin, 'plugin')
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    try {
      const output = await execClaude(invocation, ['plugin', 'install', `${plugin}@${marketplace}`])
      invalidatePluginListCache()
      return c.json({ ok: true, output })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  /** Uninstall a plugin. `-y` is required because we're not running on
   *  a TTY; without it the CLI prompts and we'd hang. We don't pass
   *  --prune (would also remove unrelated auto-installed deps) — the
   *  user can run that explicitly via the CLI if they want. */
  app.delete('/marketplaces/:name/plugins/:plugin', async (c) => {
    const marketplace = c.req.param('name')
    const plugin = c.req.param('plugin')
    try {
      assertSafeName(marketplace, 'marketplace')
      assertSafeName(plugin, 'plugin')
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    try {
      const output = await execClaude(invocation, ['plugin', 'uninstall', `${plugin}@${marketplace}`, '-y'])
      invalidatePluginListCache()
      return c.json({ ok: true, output })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  /** Enable an installed-but-disabled plugin. */
  app.post('/marketplaces/:name/plugins/:plugin/enable', async (c) => {
    const marketplace = c.req.param('name')
    const plugin = c.req.param('plugin')
    try {
      assertSafeName(marketplace, 'marketplace')
      assertSafeName(plugin, 'plugin')
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    try {
      const output = await execClaude(invocation, ['plugin', 'enable', `${plugin}@${marketplace}`])
      invalidatePluginListCache()
      return c.json({ ok: true, output })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  /** Disable an installed plugin without uninstalling it. */
  app.post('/marketplaces/:name/plugins/:plugin/disable', async (c) => {
    const marketplace = c.req.param('name')
    const plugin = c.req.param('plugin')
    try {
      assertSafeName(marketplace, 'marketplace')
      assertSafeName(plugin, 'plugin')
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    try {
      const output = await execClaude(invocation, ['plugin', 'disable', `${plugin}@${marketplace}`])
      invalidatePluginListCache()
      return c.json({ ok: true, output })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  return app
}
