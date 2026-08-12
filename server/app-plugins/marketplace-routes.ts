// REST routes for App Plugin marketplaces, mounted at /api/app-plugins/marketplaces.
//
// Mirrors the Claude Plugin marketplace routes (server/routes/mp-marketplace.ts)
// but for App Plugins — own store, own parser, routes through AppPluginManager
// for install (so the WS state-changed frame fires). Reuses the safe git-clone
// helpers (server/git-clone.ts): HTTPS-only URLs, no shell, fixed argv.

import { Hono } from 'hono'
import { promises as fs } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HttpError, createErrorHandler } from '../errors.js'
import { safeJson } from '../routes/index.js'
import { assertHttpsUrl, gitClone, gitGetHeadSha, gitPull } from '../git-clone.js'
import { parseAppPluginMarketplace } from './marketplace-parser.js'
import { validateRelativePath } from '../../shared/app-plugins/path-security.js'
import { createLogger } from '../log.js'
import type { AppPluginMarketplaceStore } from './marketplace-store.js'
import type { AppPluginManager } from './app-plugin-manager.js'
import type { AppPluginMarketplaceInfo, AppPluginMarketplaceRecord } from '../../shared/app-plugins/marketplace.js'

const log = createLogger('app-plugins:mp-routes')

// `:id` / `:pluginName` must be URL-safe slugs — reject anything else to keep
// path params from being misinterpreted.
const SAFE_NAME = /^[a-zA-Z0-9._-]+$/

export function buildAppPluginMarketplaceRouter(store: AppPluginMarketplaceStore, manager: AppPluginManager): Hono {
  const app = new Hono()
  app.onError(createErrorHandler('[app-plugins:mp]'))

  app.get('/', (c) => c.json({ marketplaces: store.list().map(toInfo) }))

  app.post('/', async (c) => {
    const body = await safeJson<{ url?: string; ref?: string; subdir?: string }>(c.req)
    const url = body.url?.trim()
    if (!url) throw new HttpError(400, 'url is required')
    assertHttpsUrl(url)
    const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined
    let subdir: string | undefined
    if (typeof body.subdir === 'string' && body.subdir.trim()) {
      subdir = body.subdir.trim()
      const subErr = validateRelativePath(subdir, { isWindows: process.platform === 'win32' })
      if (subErr) throw new HttpError(400, `invalid subdir: ${subErr}`)
    }
    const id = store.generateId(url)
    const cloneDir = store.cloneDirFor(id)
    await fs.mkdir(dirname(cloneDir), { recursive: true })
    try {
      await gitClone(url, cloneDir, ref ? { ref } : {})
    } catch (err) {
      await rm(cloneDir, { recursive: true, force: true }).catch(() => {})
      throw new HttpError(400, `clone failed: ${(err as Error).message}`)
    }
    let manifest
    try {
      manifest = await parseAppPluginMarketplace(cloneDir, subdir)
    } catch (err) {
      await rm(cloneDir, { recursive: true, force: true }).catch(() => {})
      throw new HttpError(400, `marketplace parse failed: ${(err as Error).message}`)
    }
    const sha = await gitGetHeadSha(cloneDir)
    const now = Date.now()
    const record: AppPluginMarketplaceRecord = {
      id,
      displayName: manifest.name ?? id,
      source: { type: 'https', url, ref },
      subdir,
      cloneDir,
      addedAt: now,
      lastRefreshedAt: now,
      lastSha: sha,
      manifest,
    }
    store.upsert(record)
    await store.flush()
    log.info(`added marketplace ${id} (${manifest.plugins.length} plugins) from ${url}`)
    return c.json({ ok: true, marketplace: toInfo(record) })
  })

  app.post('/:id/refresh', async (c) => {
    const id = c.req.param('id')
    if (!SAFE_NAME.test(id)) throw new HttpError(400, 'invalid marketplace id')
    const record = store.get(id)
    if (!record) throw new HttpError(404, 'marketplace not found')

    // Local (bundled) marketplaces have no git remote — refresh re-parses the
    // on-disk catalog in place. https marketplaces git-pull as before. Both
    // re-parse from the effective root (cloneDir + optional subdir).
    let updated: AppPluginMarketplaceRecord
    let didUpdate = false
    if (record.source.type === 'local') {
      const manifest = await parseAppPluginMarketplace(record.cloneDir, record.subdir)
      updated = { ...record, manifest, lastRefreshedAt: Date.now() }
    } else {
      let pull
      try {
        pull = await gitPull(record.cloneDir)
      } catch (err) {
        throw new HttpError(400, `refresh failed: ${(err as Error).message}`)
      }
      const manifest = await parseAppPluginMarketplace(record.cloneDir, record.subdir)
      updated = { ...record, manifest, lastRefreshedAt: Date.now(), lastSha: pull.newSha }
      didUpdate = pull.updated
    }
    store.upsert(updated)
    await store.flush()
    // Re-validate every plugin installed from this marketplace so version /
    // permission changes from the refreshed content surface (escalation →
    // permission-required; new version → updated record).
    for (const pluginRecord of manager.recordsForMarketplace(id)) {
      try {
        await manager.revalidatePlugin(pluginRecord.id)
      } catch (err) {
        log.warn(`revalidate ${pluginRecord.id} after marketplace refresh failed: ${(err as Error).message}`)
      }
    }
    return c.json({ ok: true, updated: didUpdate, marketplace: toInfo(updated) })
  })

  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    if (!SAFE_NAME.test(id)) throw new HttpError(400, 'invalid marketplace id')
    const body = await safeJson<{ confirm?: boolean }>(c.req).catch(() => ({}) as { confirm?: boolean })
    if (!body.confirm) throw new HttpError(400, 'removal requires { confirm: true }')
    const record = store.get(id)
    if (!record) throw new HttpError(404, 'marketplace not found')
    // Uninstall every plugin sourced from this marketplace (its clone — their
    // source path — is about to be deleted). Keep plugin data in case the
    // user re-adds the marketplace.
    for (const pluginRecord of manager.recordsForMarketplace(id)) {
      try {
        await manager.uninstall(pluginRecord.id, { deleteData: false })
      } catch (err) {
        log.warn(`uninstall ${pluginRecord.id} during marketplace removal failed: ${(err as Error).message}`)
      }
    }
    await store.removeEntry(id)
    return c.json({ ok: true })
  })

  app.get('/:id/plugins', (c) => {
    const id = c.req.param('id')
    if (!SAFE_NAME.test(id)) throw new HttpError(400, 'invalid marketplace id')
    const record = store.get(id)
    if (!record) throw new HttpError(404, 'marketplace not found')
    return c.json({ plugins: record.manifest.plugins })
  })

  app.post('/:id/plugins/:pluginName/install', async (c) => {
    const id = c.req.param('id')
    const pluginName = c.req.param('pluginName')
    if (!SAFE_NAME.test(id) || !SAFE_NAME.test(pluginName)) throw new HttpError(400, 'invalid id or plugin name')
    const record = store.get(id)
    if (!record) throw new HttpError(404, 'marketplace not found')
    if (!record.manifest.plugins.some((p) => p.name === pluginName)) {
      throw new HttpError(404, `plugin '${pluginName}' not found in marketplace`)
    }
    const result = await manager.install({ type: 'marketplace', marketplaceId: id, pluginName })
    return c.json({ ok: true, result })
  })

  return app
}

function toInfo(r: AppPluginMarketplaceRecord): AppPluginMarketplaceInfo {
  return {
    id: r.id,
    displayName: r.displayName,
    sourceType: r.source.type,
    url: r.source.type === 'https' ? r.source.url : undefined,
    ref: r.source.type === 'https' ? r.source.ref : undefined,
    subdir: r.subdir,
    addedAt: r.addedAt,
    lastRefreshedAt: r.lastRefreshedAt,
    lastSha: r.lastSha,
    pluginCount: r.manifest.plugins.length,
  }
}
