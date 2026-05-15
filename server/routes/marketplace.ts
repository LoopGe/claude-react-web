// Marketplace browsing routes: list marketplaces, plugins, install.

import { Hono } from 'hono'
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'

const CLAUDE_DIR = resolvePath(homedir(), '.claude')
const KNOWN_MARKETPLACES = resolvePath(CLAUDE_DIR, 'plugins', 'known_marketplaces.json')
const PLUGINS_CACHE = resolvePath(CLAUDE_DIR, 'plugins', 'cache')
const INSTALLED_PLUGINS = resolvePath(CLAUDE_DIR, 'plugins', 'installed_plugins.json')

/** Reject names containing path separators or leading dots — prevents
 *  path-traversal and CLI argument injection. */
function assertSafeName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.startsWith('.')) {
    throw new Error(`Invalid ${label}: "${name}" — must match [a-zA-Z0-9._-] and not start with a dot`)
  }
}

export function buildMarketplaceRouter(): Hono {
  const app = new Hono()

  /** List registered marketplaces. */
  app.get('/marketplaces', async (c) => {
    try {
      const raw = await readFile(KNOWN_MARKETPLACES, 'utf-8')
      const data = JSON.parse(raw) as Record<string, { source: string; [k: string]: unknown }>
      const marketplaces = Object.entries(data).map(([name, info]) => ({
        name,
        ...info,
      }))
      return c.json({ marketplaces })
    } catch {
      return c.json({ marketplaces: [] })
    }
  })

  /** List available plugins in a marketplace. */
  app.get('/marketplaces/:name/plugins', async (c) => {
    const marketplace = c.req.param('name')
    assertSafeName(marketplace, 'marketplace')
    const cacheDir = resolvePath(PLUGINS_CACHE, marketplace)
    try {
      await stat(cacheDir)
    } catch {
      return c.json({ plugins: [] })
    }

    const installed = new Set<string>()
    try {
      const raw = await readFile(INSTALLED_PLUGINS, 'utf-8')
      const data = JSON.parse(raw) as Record<string, unknown[]>
      for (const [key, entries] of Object.entries(data)) {
        if (Array.isArray(entries) && entries.length > 0) installed.add(key)
      }
    } catch { /* ignore */ }

    const entries = await readdir(cacheDir, { withFileTypes: true })
    const plugins = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const pluginDir = resolvePath(cacheDir, entry.name)
      let manifestPath: string | null = null
      try {
        const versions = await readdir(pluginDir)
        for (const v of versions) {
          const candidate = resolvePath(pluginDir, v, '.claude-plugin', 'marketplace.json')
          try { await stat(candidate); manifestPath = candidate; break } catch { /* skip */ }
        }
      } catch { /* skip */ }

      if (manifestPath) {
        try {
          const raw = await readFile(manifestPath, 'utf-8')
          const manifest = JSON.parse(raw) as { plugins?: Array<{ name: string; description: string; version: string; author?: { name: string } }> }
          const p = manifest.plugins?.[0]
          if (p) {
            plugins.push({
              name: p.name || entry.name,
              description: p.description || '',
              version: p.version || 'unknown',
              author: p.author?.name || '',
              marketplace,
              installed: installed.has(`${entry.name}@${marketplace}`),
            })
          }
        } catch { /* skip malformed */ }
      } else {
        plugins.push({
          name: entry.name,
          description: '',
          version: 'unknown',
          author: '',
          marketplace,
          installed: installed.has(`${entry.name}@${marketplace}`),
        })
      }
    }
    return c.json({ plugins })
  })

  /** Install a plugin from a marketplace by shelling out to claude CLI. */
  app.post('/marketplaces/:name/plugins/:plugin/install', async (c) => {
    const marketplace = c.req.param('name')
    const plugin = c.req.param('plugin')
    assertSafeName(marketplace, 'marketplace')
    assertSafeName(plugin, 'plugin')
    const pluginId = `${plugin}@${marketplace}`
    try {
      const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile('claude', ['plugin', 'install', pluginId], { timeout: 120_000 }, (err, stdout, stderr) => {
          if (err) {
            const msg = stderr || err.message
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              reject(new Error('claude CLI not found on PATH — install it first'))
            } else {
              reject(new Error(msg))
            }
          } else {
            resolve({ stdout, stderr })
          }
        })
      })
      return c.json({ ok: true, output: stdout })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  return app
}
