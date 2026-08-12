import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppPluginStore } from './app-plugin-store.js'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import { AppPluginManager } from './app-plugin-manager.js'
import type { AppPluginMarketplaceRecord } from '../../shared/app-plugins/marketplace.js'
import type { SessionManager } from '../session-manager.js'

const smStub = { subscribeSessionCleared: () => null } as unknown as SessionManager

function writePlugin(dir: string, id: string) {
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'service.mjs'), `export function activate(){}`)
  writeFileSync(join(dir, 'crw-plugin.json'), JSON.stringify({
    manifestVersion: 1, id, name: id, version: '1.0.0',
    engines: { claudeReactWeb: '^0.6.0', node: '>=20' },
    runtime: { service: 'dist/service.mjs' },
    permissions: ['storage'],
    contributes: { commands: [{ id: `${id}.run`, title: 'Run' }], contextMenus: [], actions: [], configuration: { properties: [] } },
  }))
}

describe('AppPluginManager — marketplace install', () => {
  let stateDir: string
  let cloneDir: string
  let store: AppPluginStore
  let mpStore: AppPluginMarketplaceStore
  let manager: AppPluginManager

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mp-inst-'))
    cloneDir = mkdtempSync(join(tmpdir(), 'mp-clone-'))
    // Build a fake marketplace clone: a plugin subdir + a catalog manifest.
    writePlugin(join(cloneDir, 'translator'), 'translator.claude-react-web')
    writeFileSync(join(cloneDir, 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Test Market',
      appPlugins: [{ name: 'translator', dir: 'translator', description: 'translate', version: '1.0.0' }],
    }))
    store = new AppPluginStore({ stateDir })
    mpStore = new AppPluginMarketplaceStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub, marketplaceStore: mpStore })
    // Pre-populate the marketplace store with a record pointing at the clone
    // (bypasses gitClone — the route does that in production).
    const now = Date.now()
    const record: AppPluginMarketplaceRecord = {
      id: 'test-mp',
      displayName: 'Test Market',
      source: { type: 'https', url: 'https://example.com/test.git' },
      cloneDir,
      addedAt: now,
      lastRefreshedAt: now,
      lastSha: 'abc123',
      manifest: { name: 'Test Market', plugins: [{ name: 'translator', dir: 'translator' }] },
    }
    mpStore.upsert(record)
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(cloneDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('installs a plugin from a marketplace with marketplace source provenance', async () => {
    const result = await manager.install({ type: 'marketplace', marketplaceId: 'test-mp', pluginName: 'translator' })
    expect(result.id).toBe('translator.claude-react-web')
    expect(result.permissionRequired).toBe(false)

    const installed = manager.list()
    expect(installed).toHaveLength(1)
    expect(installed[0].id).toBe('translator.claude-react-web')
    // Source provenance is marketplace, not local.
    const rec = store.get('translator.claude-react-web')!
    expect(rec.source.type).toBe('marketplace')
    if (rec.source.type === 'marketplace') {
      expect(rec.source.marketplaceId).toBe('test-mp')
      expect(rec.source.pluginName).toBe('translator')
    }
  })

  it('recordsForMarketplace lists installed plugins from a marketplace', async () => {
    await manager.install({ type: 'marketplace', marketplaceId: 'test-mp', pluginName: 'translator' })
    const recs = manager.recordsForMarketplace('test-mp')
    expect(recs).toHaveLength(1)
    expect(recs[0].id).toBe('translator.claude-react-web')
  })

  it('rejects install when the marketplace is unknown', async () => {
    await expect(manager.install({ type: 'marketplace', marketplaceId: 'nope', pluginName: 'translator' }))
      .rejects.toThrow(/marketplace not found/)
  })

  it('rejects install when the plugin name is not in the marketplace', async () => {
    await expect(manager.install({ type: 'marketplace', marketplaceId: 'test-mp', pluginName: 'ghost' }))
      .rejects.toThrow(/not found/)
  })

  it('revalidatePlugin re-reads the manifest from the clone', async () => {
    await manager.install({ type: 'marketplace', marketplaceId: 'test-mp', pluginName: 'translator' })
    const before = store.get('translator.claude-react-web')!
    // Touch the manifest (re-write identical) → revalidate is a no-op ref-stable.
    const info = await manager.revalidatePlugin('translator.claude-react-web')
    expect(info?.id).toBe('translator.claude-react-web')
    const after = store.get('translator.claude-react-web')!
    void before
    expect(after.source.type).toBe('marketplace')
  })

  it('revalidatePlugin escalates to permission-required when a new version adds permissions', async () => {
    await manager.install({ type: 'marketplace', marketplaceId: 'test-mp', pluginName: 'translator' })
    await manager.enable('translator.claude-react-web')
    // Simulate a marketplace `gitPull` that lands v1.1.0 with an ADDED
    // permission the user hasn't consented to.
    const pluginDir = join(cloneDir, 'translator')
    writeFileSync(join(pluginDir, 'crw-plugin.json'), JSON.stringify({
      manifestVersion: 1, id: 'translator.claude-react-web', name: 'translator', version: '1.1.0',
      engines: { claudeReactWeb: '^0.6.0', node: '>=20' },
      runtime: { service: 'dist/service.mjs' },
      permissions: ['storage', 'ai.request'], // ai.request is new
      contributes: { commands: [], contextMenus: [], actions: [], configuration: { properties: [] } },
    }))
    const info = await manager.revalidatePlugin('translator.claude-react-web')
    expect(info?.runtimeState).toBe('permission-required')
    expect(info?.permissionRequired).toBe(true)
  })

  it('escalation gates a disabled plugin on enable (not just enabled ones)', async () => {
    // Install but DON'T enable. A marketplace refresh lands a version with an
    // added permission. The plugin goes permission-required; enable() must
    // refuse until the user re-consents.
    await manager.install({ type: 'marketplace', marketplaceId: 'test-mp', pluginName: 'translator' })
    const pluginDir = join(cloneDir, 'translator')
    writeFileSync(join(pluginDir, 'crw-plugin.json'), JSON.stringify({
      manifestVersion: 1, id: 'translator.claude-react-web', name: 'translator', version: '1.1.0',
      engines: { claudeReactWeb: '^0.6.0', node: '>=20' },
      runtime: { service: 'dist/service.mjs' },
      permissions: ['storage', 'ai.request'],
      contributes: { commands: [], contextMenus: [], actions: [], configuration: { properties: [] } },
    }))
    const info = await manager.revalidatePlugin('translator.claude-react-web')
    expect(info?.runtimeState).toBe('permission-required')
    // enable() must refuse (re-consent required).
    await expect(manager.enable('translator.claude-react-web')).rejects.toThrow(/re-consent|permission/i)
  })
})

describe('AppPluginManager — marketplace install with subdir', () => {
  let stateDir: string
  let cloneDir: string
  let store: AppPluginStore
  let mpStore: AppPluginMarketplaceStore
  let manager: AppPluginManager

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mp-inst-sub-'))
    cloneDir = mkdtempSync(join(tmpdir(), 'mp-clone-sub-'))
    // Marketplace content lives under <clone>/plugins/ — the layout of the
    // official host repo (catalog is NOT at the clone root).
    writePlugin(join(cloneDir, 'plugins', 'translator'), 'translator.claude-react-web')
    writeFileSync(join(cloneDir, 'plugins', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Nested Market',
      appPlugins: [{ name: 'translator', dir: 'translator', description: 'translate', version: '1.0.0' }],
    }))
    store = new AppPluginStore({ stateDir })
    mpStore = new AppPluginMarketplaceStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub, marketplaceStore: mpStore })
    const now = Date.now()
    const record: AppPluginMarketplaceRecord = {
      id: 'sub-mp',
      displayName: 'Nested Market',
      source: { type: 'https', url: 'https://github.com/loopge/claude-react-web' },
      subdir: 'plugins',
      cloneDir,
      addedAt: now,
      lastRefreshedAt: now,
      lastSha: 'abc123',
      manifest: { name: 'Nested Market', plugins: [{ name: 'translator', dir: 'translator' }] },
    }
    mpStore.upsert(record)
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(cloneDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('installs a plugin from a subdir marketplace (content under clone/subdir)', async () => {
    const result = await manager.install({ type: 'marketplace', marketplaceId: 'sub-mp', pluginName: 'translator' })
    expect(result.id).toBe('translator.claude-react-web')
    const rec = store.get('translator.claude-react-web')!
    expect(rec.source.type).toBe('marketplace')
    if (rec.source.type === 'marketplace') {
      expect(rec.source.marketplaceId).toBe('sub-mp')
      // The path is realpath'd by resolvePluginDir; just verify it ends with
      // the expected subdir-relative suffix (avoids Windows 8.3 name issues).
      expect(rec.source.path).toMatch(/plugins[/\\]translator$/)
    }
  })
})
