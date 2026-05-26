// Homegrown git-repo marketplace routes.
//
// Independent from the existing CLI-shelling marketplace.ts (which talks to
// the `claude` CLI). This implementation:
//   1. Clones the user's https git URL into our own state-dir cache.
//   2. Parses .claude-plugin/marketplace.json ourselves.
//   3. Stores marketplace + per-plugin enabled state in MpStore.
//   4. Pushes enable/disable changes into every live session via the
//      SessionManager so mid-conversation toggles take effect immediately.
//
// All paths live under /api/mp/* to avoid colliding with the CLI-based
// /api/marketplaces/* route group. Coexistence is intentional during the
// rollout period; either can be deprecated later.

import { Hono } from 'hono'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import type { SessionManager } from '../session-manager.js'
import { MpStore, type MpEntry } from '../mp-store.js'
import { gitClone, gitPull, gitGetHeadSha, assertHttpsUrl } from '../git-clone.js'
import { parseMarketplace, type ParsedPlugin } from '../marketplace-parser.js'

/** Same charset rule the CLI marketplace router uses. Applied to :id and
 *  :plugin so user-supplied path params can't escape into the filesystem
 *  or carry shell-meta payloads. */
function assertSafeName(name: string, label: string): void {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name) || name.startsWith('.')) {
    throw new HttpError(400, `invalid ${label}: "${name}" — must match [a-zA-Z0-9._-] and not start with a dot`)
  }
}

/** Lightweight DTO for marketplace listings. Strips the cached manifest
 *  to keep the response small; per-plugin detail lives behind /plugins. */
interface MpListItem {
  id: string
  displayName: string
  source: MpEntry['source']
  addedAt: number
  lastRefreshedAt: number
  lastSha: string
  pluginCount: number
  manifestVersion?: string
  ownerName?: string
}

function toListItem(e: MpEntry): MpListItem {
  return {
    id: e.id,
    displayName: e.displayName,
    source: e.source,
    addedAt: e.addedAt,
    lastRefreshedAt: e.lastRefreshedAt,
    lastSha: e.lastSha,
    pluginCount: e.manifest.plugins.length,
    manifestVersion: e.manifest.version,
    ownerName: e.manifest.owner?.name,
  }
}

/** Plugin DTO. The on-disk dir is intentionally NOT exposed — clients
 *  don't need it and surfacing absolute paths from the server's own
 *  state dir leaks irrelevant filesystem details into the API. */
interface PluginListItem {
  name: string
  description?: string
  version?: string
  author?: string
  category?: string
  tags?: string[]
  enabled: boolean
}

function toPluginListItem(p: ParsedPlugin, enabled: boolean): PluginListItem {
  return {
    name: p.name,
    description: p.description,
    version: p.version,
    author: p.author,
    category: p.category,
    tags: p.tags,
    enabled,
  }
}

export function buildMpRouter(sm: SessionManager, store: MpStore): Hono {
  const app = new Hono()

  // ─── Marketplace listing ─────────────────────────────────────────

  app.get('/mp/marketplaces', (c) => {
    const items = store.list().map(toListItem)
    items.sort((a, b) => a.displayName.localeCompare(b.displayName))
    return c.json({ marketplaces: items })
  })

  // ─── Add ─────────────────────────────────────────────────────────

  app.post('/mp/marketplaces', async (c) => {
    const body = await safeJson<{ url?: unknown; ref?: unknown }>(c.req)
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url) throw new HttpError(400, 'url is required')
    assertHttpsUrl(url)
    const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined

    const id = store.generateId(url)
    const cloneDir = store.cloneDirFor(id)

    // Mkdir the parent (cache root) before clone — git itself creates the
    // final dest dir. If the user wiped their state dir mid-session, the
    // base JsonFileStore won't have re-created the cache subdir for us.
    await mkdir(dirname(cloneDir), { recursive: true })

    // Clone failures leave nothing behind (git's clone is atomic w.r.t.
    // the dest dir — failure means the dir wasn't created or was
    // partial; either way we don't track the entry, so the HttpError
    // from gitClone propagates straight out.
    await gitClone(url, cloneDir, { ref })

    let parseResult
    try {
      parseResult = await parseMarketplace(cloneDir)
    } catch (err) {
      // Parse failure means we've cloned a repo that isn't actually a
      // marketplace. Tear down the clone before rethrowing — keeping it
      // around would orphan disk space and confuse the user.
      try {
        const { rm } = await import('node:fs/promises')
        await rm(cloneDir, { recursive: true, force: true })
      } catch { /* best-effort cleanup */ }
      throw new HttpError(400, `marketplace parse failed: ${(err as Error).message}`)
    }

    const sha = await gitGetHeadSha(cloneDir)
    const now = Date.now()
    const entry: MpEntry = {
      id,
      displayName: parseResult.manifest.name || id,
      source: { type: 'https', url, ref },
      cloneDir,
      addedAt: now,
      lastRefreshedAt: now,
      lastSha: sha,
      manifest: parseResult.manifest,
    }
    store.upsert(entry)
    await store.flush()

    return c.json({
      ok: true,
      entry: toListItem(entry),
      warnings: parseResult.warnings,
    })
  })

  // ─── Refresh ─────────────────────────────────────────────────────

  app.post('/mp/marketplaces/:id/refresh', async (c) => {
    const id = c.req.param('id')
    assertSafeName(id, 'marketplace id')
    const entry = store.get(id)
    if (!entry) throw new HttpError(404, `marketplace ${id} not found`)
    const { newSha, updated } = await gitPull(entry.cloneDir)
    const parseResult = await parseMarketplace(entry.cloneDir)
    const next: MpEntry = {
      ...entry,
      lastRefreshedAt: Date.now(),
      lastSha: newSha,
      manifest: parseResult.manifest,
      // Update displayName from manifest in case the upstream renamed.
      displayName: parseResult.manifest.name || entry.displayName,
    }
    store.upsert(next)
    await store.flush()
    return c.json({
      ok: true,
      entry: toListItem(next),
      updated,
      warnings: parseResult.warnings,
    })
  })

  // ─── Remove ──────────────────────────────────────────────────────

  app.delete('/mp/marketplaces/:id', async (c) => {
    const id = c.req.param('id')
    assertSafeName(id, 'marketplace id')
    const confirm = c.req.query('confirm')
    if (confirm !== 'true') {
      throw new HttpError(400, 'confirm=true required for destructive remove')
    }
    if (!store.has(id)) throw new HttpError(404, `marketplace ${id} not found`)

    // Best-effort: tell every live session to disable the plugins from
    // this marketplace BEFORE we drop the entry, so the SDK doesn't
    // briefly see stale enabled flags pointing at a deleted dir.
    const removedKeys = store.enabledKeys().filter((k) => k.endsWith(`@${id}`))
    for (const key of removedKeys) {
      await applyToggleToLiveSessions(sm, key, false)
    }

    await store.removeEntry(id)
    return c.json({ ok: true })
  })

  // ─── Plugin list ─────────────────────────────────────────────────

  app.get('/mp/marketplaces/:id/plugins', (c) => {
    const id = c.req.param('id')
    assertSafeName(id, 'marketplace id')
    const entry = store.get(id)
    if (!entry) throw new HttpError(404, `marketplace ${id} not found`)
    const enabledMap = store.enabledMapFor(id)
    const plugins = entry.manifest.plugins.map((p) => toPluginListItem(p, enabledMap[p.name] === true))
    plugins.sort((a, b) => a.name.localeCompare(b.name))
    return c.json({ plugins })
  })

  // ─── Toggle plugin enable/disable ────────────────────────────────

  app.post('/mp/marketplaces/:id/plugins/:plugin/toggle', async (c) => {
    const id = c.req.param('id')
    const plugin = c.req.param('plugin')
    assertSafeName(id, 'marketplace id')
    assertSafeName(plugin, 'plugin name')
    const entry = store.get(id)
    if (!entry) throw new HttpError(404, `marketplace ${id} not found`)
    if (!entry.manifest.plugins.find((p) => p.name === plugin)) {
      throw new HttpError(404, `plugin ${plugin} not in marketplace ${id}`)
    }
    const body = await safeJson<{ enabled?: unknown }>(c.req)
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled boolean required')
    }
    const enabled = body.enabled

    // Persist FIRST so a server restart mid-toggle leaves the store in
    // a coherent state. The live-session push is best-effort and can
    // miss without losing user intent.
    store.setEnabled(plugin, id, enabled)
    await store.flush()

    // Push to every live session. We use the SDK's "<plugin>@<marketplace>"
    // key shape directly — applyFlagSettings forwards the dict to the CLI
    // subprocess which interprets it identically to the disk-based
    // enabledPlugins setting.
    const key = MpStore.keyOf(plugin, id)
    await applyToggleToLiveSessions(sm, key, enabled)

    return c.json({
      ok: true,
      plugin: toPluginListItem(
        entry.manifest.plugins.find((p) => p.name === plugin)!,
        enabled,
      ),
    })
  })

  return app
}

/** Walk every live session and push the plugin toggle through. Failures
 *  on a single session are swallowed (logged) so one stuck session can't
 *  block toggles for the rest. The next spawn of any failed session will
 *  pick up the persisted state via spawn-time injection anyway. */
async function applyToggleToLiveSessions(
  sm: SessionManager,
  pluginKey: string,
  enabled: boolean,
): Promise<void> {
  // Iterate via the SessionManager's public surface. We need ids of
  // running sessions only — list() returns hibernated ones too.
  const ids: string[] = []
  for (const info of sm.list()) {
    if (info.running) ids.push(info.id)
  }
  for (const id of ids) {
    try {
      await sm.togglePlugin(id, pluginKey, enabled)
      // togglePlugin already calls applyFlagSettings; reloadPlugins picks
      // up changes that came from disk-side plugin path mutations. For a
      // pure enable-flag toggle on a path the SDK already knows, it's a
      // no-op — but cheap, and required when the underlying plugin set
      // changed (e.g. immediately after `marketplace refresh` adds a
      // new plugin).
      await sm.reloadPlugins(id)
    } catch (err) {
      console.warn(`[mp-marketplace] live toggle failed for session ${id}: ${(err as Error).message}`)
    }
  }
}
