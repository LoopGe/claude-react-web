import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
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
