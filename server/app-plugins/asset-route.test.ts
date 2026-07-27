import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppPluginStore } from './app-plugin-store.js'
import { AppPluginManager } from './app-plugin-manager.js'
import { buildAppPluginRouter } from './routes.js'
import type { SessionManager } from '../session-manager.js'

const smStub = { subscribeSessionCleared: () => null } as unknown as SessionManager

describe('app-plugins asset route', () => {
  let stateDir: string
  let pluginDir: string
  let manager: AppPluginManager
  let app: Hono

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'asset-route-'))
    pluginDir = mkdtempSync(join(tmpdir(), 'asset-plugin-'))
    // Place the asset at the plugin root (the /assets/ in the URL is the
    // route prefix, not a directory — the manifest's `asset` field is
    // relative to the plugin dir, and the URL is /:id/assets/<asset>).
    writeFileSync(join(pluginDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>')
    writeFileSync(join(pluginDir, 'crw-plugin.json'), JSON.stringify({
      manifestVersion: 1, id: 'test.asset', name: 'test', version: '1.0.0',
      engines: { claudeReactWeb: '^0.6.0', node: '>=20' },
      runtime: { service: 'dist/service.mjs' },
      permissions: [],
      contributes: { commands: [], contextMenus: [], actions: [], configuration: { properties: [] } },
    }))
    const store = new AppPluginStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub })
    await manager.install({ type: 'local', path: pluginDir })
    await manager.enable('test.asset')
    app = new Hono()
    app.route('/', buildAppPluginRouter(manager))
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(pluginDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('serves a valid SVG asset with correct Content-Type', async () => {
    const res = await app.request('/test.asset/assets/icon.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const body = await res.text()
    expect(body).toMatch(/<svg/)
  })

  it('rejects path traversal (.. normalised by Hono before routing → 404)', async () => {
    // Hono normalises URL-encoded .. before routing, so the path never
    // reaches the handler. The validateRelativePath defense (which catches
    // .. at the handler level) is tested separately in path-security.test.ts.
    const res = await app.request('/test.asset/assets/%2e%2e/%2e%2e/etc/passwd')
    expect([400, 404]).toContain(res.status)
  })

  it('rejects non-whitelisted extensions', async () => {
    const res = await app.request('/test.asset/assets/icon.txt')
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown plugin', async () => {
    const res = await app.request('/nonexistent/assets/icon.svg')
    expect(res.status).toBe(404)
  })

  it('returns 404 for missing asset', async () => {
    const res = await app.request('/test.asset/assets/nonexistent.svg')
    expect(res.status).toBe(404)
  })

  it('sets CSP header on SVG responses', async () => {
    const res = await app.request('/test.asset/assets/icon.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toMatch(/default-src/)
  })
})
