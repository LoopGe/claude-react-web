import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppPluginStore } from './app-plugin-store.js'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import { AppPluginManager } from './app-plugin-manager.js'
import { buildAppPluginRouter } from './routes.js'
import { buildAppPluginMarketplaceRouter } from './marketplace-routes.js'
import type { SessionManager } from '../session-manager.js'

const smStub = { subscribeSessionCleared: () => null } as unknown as SessionManager

// C1 regression: the marketplace router MUST be mounted before the generic
// /:id router, otherwise `GET /api/app-plugins/marketplaces` is swallowed by
// `GET /:id` (id="marketplaces") and 404s.
describe('app-plugins route ordering (C1)', () => {
  let stateDir: string
  let manager: AppPluginManager
  let mpStore: AppPluginMarketplaceStore

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mp-route-'))
    const store = new AppPluginStore({ stateDir })
    mpStore = new AppPluginMarketplaceStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub, marketplaceStore: mpStore })
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('GET /api/app-plugins/marketplaces returns the list (not a 404 from /:id)', async () => {
    // Compose in the same order app.ts does (marketplace FIRST, then generic).
    const app = new Hono()
    app.route('/api/app-plugins/marketplaces', buildAppPluginMarketplaceRouter(mpStore, manager))
    app.route('/api/app-plugins', buildAppPluginRouter(manager))

    const res = await app.request('/api/app-plugins/marketplaces')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { marketplaces: unknown[] }
    expect(body).toHaveProperty('marketplaces')
    expect(Array.isArray(body.marketplaces)).toBe(true)
  })

  it('mounting generic FIRST breaks the marketplace route (negative control)', async () => {
    // Wrong order — proves the test is meaningful: /marketplaces is caught by /:id.
    const app = new Hono()
    app.route('/api/app-plugins', buildAppPluginRouter(manager))
    app.route('/api/app-plugins/marketplaces', buildAppPluginMarketplaceRouter(mpStore, manager))

    const res = await app.request('/api/app-plugins/marketplaces')
    // Swallowed by GET /:id → manager.get('marketplaces') → undefined → 404.
    expect(res.status).toBe(404)
  })
})

describe('marketplace refresh — local source (bundled)', () => {
  let stateDir: string
  let manager: AppPluginManager
  let mpStore: AppPluginMarketplaceStore
  let pluginsDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mp-refresh-'))
    pluginsDir = join(stateDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(
      join(pluginsDir, 'app-plugins-marketplace.json'),
      JSON.stringify({
        name: 'Claude React Web Plugins',
        appPlugins: [
          { name: 'translator', dir: 'translator', description: 'Translate', version: '1.0.0' },
        ],
      }),
    )
    const store = new AppPluginStore({ stateDir })
    mpStore = new AppPluginMarketplaceStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub, marketplaceStore: mpStore })
    const now = Date.now()
    mpStore.upsert({
      id: 'bundled',
      displayName: 'Claude React Web Plugins',
      source: { type: 'local', path: pluginsDir },
      cloneDir: pluginsDir,
      addedAt: now,
      lastRefreshedAt: 0,
      lastSha: '',
      manifest: { name: 'Claude React Web Plugins', plugins: [] },
    })
    return mpStore.flush()
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('POST /:id/refresh re-parses a local marketplace without git', async () => {
    const app = new Hono()
    app.route('/api/app-plugins/marketplaces', buildAppPluginMarketplaceRouter(mpStore, manager))
    const res = await app.request('/api/app-plugins/marketplaces/bundled/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      updated: boolean
      marketplace: { pluginCount: number; sourceType: string }
    }
    expect(body.ok).toBe(true)
    expect(body.updated).toBe(false)
    expect(body.marketplace.pluginCount).toBe(1)
    expect(body.marketplace.sourceType).toBe('local')
    // Local dir is read in place — the cloneDir must be untouched.
    expect(mpStore.get('bundled')?.cloneDir).toBe(pluginsDir)
  })

  it('DELETE /:id keeps a local cloneDir on disk', async () => {
    const app = new Hono()
    app.route('/api/app-plugins/marketplaces', buildAppPluginMarketplaceRouter(mpStore, manager))
    const res = await app.request('/api/app-plugins/marketplaces/bundled', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    })
    expect(res.status).toBe(200)
    expect(mpStore.get('bundled')).toBeUndefined()
    // Local (bundled) source dir is app code — never deleted.
    expect(existsSync(pluginsDir)).toBe(true)
  })
})

describe('marketplace refresh — subdir marketplace', () => {
  let stateDir: string
  let manager: AppPluginManager
  let mpStore: AppPluginMarketplaceStore
  let cloneDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mp-refresh-sub-'))
    cloneDir = mkdtempSync(join(tmpdir(), 'mp-clone-sub-'))
    // Nested marketplace content (catalog under <clone>/plugins/). Local
    // source so refresh re-parses without a real git repo.
    mkdirSync(join(cloneDir, 'plugins'), { recursive: true })
    writeFileSync(join(cloneDir, 'plugins', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Claude React Web Plugins',
      appPlugins: [{ name: 'translator', dir: 'translator', description: 'Translate', version: '1.0.0' }],
    }))
    const store = new AppPluginStore({ stateDir })
    mpStore = new AppPluginMarketplaceStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub, marketplaceStore: mpStore })
    const now = Date.now()
    mpStore.upsert({
      id: 'nested',
      displayName: 'Claude React Web Plugins',
      source: { type: 'local', path: cloneDir },
      subdir: 'plugins',
      cloneDir,
      addedAt: now,
      lastRefreshedAt: 0,
      lastSha: '',
      manifest: { name: 'Claude React Web Plugins', plugins: [] },
    })
    return mpStore.flush()
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(cloneDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('POST /:id/refresh re-parses the catalog inside the subdir', async () => {
    const app = new Hono()
    app.route('/api/app-plugins/marketplaces', buildAppPluginMarketplaceRouter(mpStore, manager))
    const res = await app.request('/api/app-plugins/marketplaces/nested/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; marketplace: { pluginCount: number; subdir?: string; sourceType: string } }
    expect(body.ok).toBe(true)
    expect(body.marketplace.pluginCount).toBe(1)
    expect(body.marketplace.subdir).toBe('plugins')
    expect(body.marketplace.sourceType).toBe('local')
  })
})
