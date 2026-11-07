// Git-repo marketplace routes. This is the sole plugin-marketplace
// implementation. It:
//   1. Clones the user's https git URL into our own state-dir cache.
//   2. Parses .claude-plugin/marketplace.json (or plugin.json for a single-
//      plugin repo) ourselves.
//   3. Stores marketplace + per-plugin enabled state in MpStore.
//   4. Pushes enable/disable changes into every live session via the
//      SessionManager so mid-conversation toggles take effect immediately.
//
// All paths live under /api/mp/*. The DTO shapes and multi-step flows live in
// ../mp-ops.ts so first-party tools can drive the same operations without
// going through HTTP.

import { Hono } from 'hono'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import type { SessionManager } from '../session-manager.js'
import { MpStore, type MpEntry } from '../mp-store.js'
import { gitBranchName, gitPull } from '../git-clone.js'
import { parseRepoManifest } from '../marketplace-parser.js'
import {
  addMarketplaceByUrl,
  applyPluginToggleToLiveSessions,
  assertSafeName,
  checkMarketplaceUpdates,
  ensureExternalClone,
  listMarketplacePlugins,
  listMarketplaces,
  setMarketplacePluginEnabled,
  toMpListItem,
} from '../mp-ops.js'
import { createLogger } from '../log.js'

const log = createLogger('mp-marketplace')

export function buildMpRouter(sm: SessionManager, store: MpStore): Hono {
  const app = new Hono()

  // ─── Marketplace listing ─────────────────────────────────────────

  app.get('/mp/marketplaces', (c) => {
    return c.json({ marketplaces: listMarketplaces(store) })
  })

  // ─── Check for updates (non-mutating) ─────────────────────────────

  app.post('/mp/marketplaces/check-updates', async (c) => {
    const updates = await checkMarketplaceUpdates(store)
    return c.json({ ok: true, updates })
  })

  // ─── Add ─────────────────────────────────────────────────────────

  app.post('/mp/marketplaces', async (c) => {
    const body = await safeJson<{ url?: unknown; ref?: unknown }>(c.req)
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url) throw new HttpError(400, 'url is required')
    const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined
    const { entry, warnings } = await addMarketplaceByUrl(store, { url, ref })
    return c.json({ ok: true, entry: toMpListItem(entry, store), warnings })
  })

  // ─── Refresh ─────────────────────────────────────────────────────

  app.post('/mp/marketplaces/:id/refresh', async (c) => {
    const id = c.req.param('id')
    assertSafeName(id, 'marketplace id')
    const entry = store.get(id)
    if (!entry) throw new HttpError(404, `marketplace ${id} not found`)
    const { newSha, updated } = await gitPull(entry.cloneDir)
    const parseResult = await parseRepoManifest(entry.cloneDir)
    const next: MpEntry = {
      ...entry,
      lastRefreshedAt: Date.now(),
      lastSha: newSha,
      manifest: parseResult.manifest,
      // Update displayName from manifest in case the upstream renamed.
      displayName: parseResult.manifest.name || entry.displayName,
      // Re-resolve the branch after the pull (the remote may have switched
      // its default branch; --ff-only keeps us on the same one either way).
      branch: (await gitBranchName(entry.cloneDir)) || entry.source.ref || undefined,
    }
    store.upsert(next)
    await store.flush()
    // A refresh may bump pinned shas in the manifest. For any git-subdir
    // plugin still enabled, re-materialise its clone at the NEW sha before
    // pruning — otherwise the plugin would silently drop from sessions
    // (its old-sha clone gets GC'd and the new one was never cloned).
    const enabledMap = store.enabledMapFor(id)
    for (const p of next.manifest.plugins) {
      if (p.source?.kind === 'git-subdir' && enabledMap[p.name] === true) {
        try {
          await ensureExternalClone(store, p.source)
        } catch (err) {
          log.warn(`refresh re-clone failed for ${p.name}@${id}: ${(err as Error).message}`)
        }
      }
    }
    // GC external clones no longer referenced by any enabled plugin.
    await store.pruneExternalClones()
    return c.json({
      ok: true,
      entry: toMpListItem(next, store),
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
      await applyPluginToggleToLiveSessions(sm, key, false)
    }

    await store.removeEntry(id)
    return c.json({ ok: true })
  })

  // ─── Plugin list ─────────────────────────────────────────────────

  app.get('/mp/marketplaces/:id/plugins', (c) => {
    const id = c.req.param('id')
    assertSafeName(id, 'marketplace id')
    return c.json({ plugins: listMarketplacePlugins(store, id) })
  })

  // ─── Toggle plugin enable/disable ────────────────────────────────

  app.post('/mp/marketplaces/:id/plugins/:plugin/toggle', async (c) => {
    const id = c.req.param('id')
    const plugin = c.req.param('plugin')
    assertSafeName(id, 'marketplace id')
    assertSafeName(plugin, 'plugin name')
    // Existence is checked before body parsing so an unknown marketplace or
    // plugin answers 404 even when the body is malformed — the
    // pre-extraction precedence.
    const entry = store.get(id)
    if (!entry) throw new HttpError(404, `marketplace ${id} not found`)
    if (!entry.manifest.plugins.find((p) => p.name === plugin)) {
      throw new HttpError(404, `plugin ${plugin} not in marketplace ${id}`)
    }
    const body = await safeJson<{ enabled?: unknown }>(c.req)
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled boolean required')
    }
    const item = await setMarketplacePluginEnabled(store, sm, id, plugin, body.enabled)
    return c.json({ ok: true, plugin: item })
  })

  // ─── Enabled plugins (flat list for plugin picker) ──────────────

  app.get('/mp/enabled-plugins', (c) => {
    const plugins = store.enabledPluginEntries()
    return c.json({ plugins })
  })

  return app
}
