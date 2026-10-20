import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import {
  BUILTIN_MARKETPLACE_ID,
  resolveBundledPluginsDir,
  resolvePluginsDirFrom,
  buildBuiltinRecord,
  seedBuiltinMarketplace,
} from './builtin-marketplace.js'

/** Write a minimal-but-valid marketplace fixture at `dir`. */
function writeMarketplaceFixture(dir: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'app-plugins-marketplace.json'),
    JSON.stringify({
      name: 'Claude React Web Plugins',
      appPlugins: [
        { name: 'translator', dir: 'translator', description: 'Translate', version: '1.0.0' },
      ],
    }),
  )
}

describe('built-in app plugin marketplace', () => {
  let stateDir: string
  let pluginsDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'builtin-'))
    pluginsDir = join(stateDir, 'plugins')
    writeMarketplaceFixture(pluginsDir)
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('resolvePluginsDirFrom finds a dir containing the marketplace marker', () => {
    const found = resolvePluginsDirFrom(stateDir)
    expect(found).toBe(pluginsDir)
  })

  it('resolvePluginsDirFrom returns null when no marker is present', () => {
    const empty = join(stateDir, 'empty')
    mkdirSync(empty, { recursive: true })
    expect(resolvePluginsDirFrom(empty)).toBe(null)
  })

  it('resolveBundledPluginsDir resolves a real dir in the repo (dev layout)', () => {
    // In this repo the module lives at server/app-plugins → candidate
    // `join(here, '..', '..', 'plugins')` resolves to <repo>/plugins, which
    // exists and has the marker.
    expect(resolveBundledPluginsDir()).not.toBeNull()
  })

  it('buildBuiltinRecord builds a fully-populated local record (no subdir)', async () => {
    const record = await buildBuiltinRecord(pluginsDir)
    expect(record.id).toBe(BUILTIN_MARKETPLACE_ID)
    expect(record.source).toEqual({ type: 'local', path: pluginsDir })
    expect(record.cloneDir).toBe(pluginsDir)
    expect(record.subdir).toBeUndefined()
    expect(record.lastSha).toBe('')
    expect(record.manifest.name).toBe('Claude React Web Plugins')
    expect(record.manifest.plugins).toHaveLength(1)
    expect(record.manifest.plugins[0].name).toBe('translator')
  })

  it('seedBuiltinMarketplace seeds on first run and no-ops afterwards', async () => {
    const store = new AppPluginMarketplaceStore({ stateDir })
    await seedBuiltinMarketplace(store, pluginsDir)
    const seeded = store.get(BUILTIN_MARKETPLACE_ID)
    expect(seeded).toBeDefined()
    expect(seeded?.source.type).toBe('local')
    // The explicit flush inside seedBuiltinIfFirstRun created the file.
    expect(store.isFirstRun()).toBe(false)
    // Second call must not re-seed (file now exists).
    await seedBuiltinMarketplace(store, pluginsDir)
    expect(store.list()).toHaveLength(1)
  })

  it('re-parses an existing record so an app upgrade that adds bundled plugins shows up', async () => {
    const store = new AppPluginMarketplaceStore({ stateDir })
    await seedBuiltinMarketplace(store, pluginsDir)
    expect(store.get(BUILTIN_MARKETPLACE_ID)?.manifest.plugins).toHaveLength(1)

    // Simulate the upgraded app shipping one more plugin in the same bundled
    // dir. The record persists with its old manifest — and there is no Update
    // control on a marketplace with no upstream, so boot must heal it.
    writeFileSync(
      join(pluginsDir, 'app-plugins-marketplace.json'),
      JSON.stringify({
        name: 'Claude React Web Plugins',
        appPlugins: [
          { name: 'translator', dir: 'translator', description: 'Translate', version: '1.0.0' },
          { name: 'newcomer', dir: 'newcomer', description: 'New', version: '1.0.0' },
        ],
      }),
    )
    // Later launch: bootstrap loads the persisted store, then seeds.
    const later = new AppPluginMarketplaceStore({ stateDir })
    await later.load()
    await seedBuiltinMarketplace(later, pluginsDir)

    const refreshed = later.get(BUILTIN_MARKETPLACE_ID)
    expect(refreshed?.manifest.plugins.map((p) => p.name)).toEqual(['translator', 'newcomer'])
    // The record itself is reused — a re-parse must not re-add or duplicate it.
    expect(later.list()).toHaveLength(1)
    // Nor does it resurrect one the user removed.
    later.removeEntry(BUILTIN_MARKETPLACE_ID)
    await seedBuiltinMarketplace(later, pluginsDir)
    expect(later.get(BUILTIN_MARKETPLACE_ID)).toBeUndefined()
  })

  it('seedBuiltinMarketplace skips (no crash) when the dir is missing', async () => {
    const store = new AppPluginMarketplaceStore({ stateDir })
    await seedBuiltinMarketplace(store, join(stateDir, 'does-not-exist'))
    expect(store.list()).toHaveLength(0)
  })
})
