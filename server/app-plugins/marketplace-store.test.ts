import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import type { AppPluginMarketplaceRecord } from '../../shared/app-plugins/marketplace.js'

function makeRecord(id: string, source: AppPluginMarketplaceRecord['source'], cloneDir: string): AppPluginMarketplaceRecord {
  const now = Date.now()
  return {
    id,
    displayName: id,
    source,
    cloneDir,
    addedAt: now,
    lastRefreshedAt: now,
    lastSha: '',
    manifest: { plugins: [] },
  }
}

describe('AppPluginMarketplaceStore — built-in seeding', () => {
  let stateDir: string
  let store: AppPluginMarketplaceStore

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mp-store-'))
    store = new AppPluginMarketplaceStore({ stateDir })
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('seedBuiltinIfFirstRun seeds + persists when the store file is absent', async () => {
    expect(store.isFirstRun()).toBe(true)
    const record = makeRecord('builtin', { type: 'local', path: join(stateDir, 'plugins') }, join(stateDir, 'plugins'))
    const seeded = await store.seedBuiltinIfFirstRun(record)
    expect(seeded).toBe(true)
    expect(store.get('builtin')).toBeDefined()
    // The explicit flush inside seedBuiltinIfFirstRun materialised the file.
    expect(store.isFirstRun()).toBe(false)
  })

  it('seedBuiltinIfFirstRun is a no-op when the store file already exists', async () => {
    const record = makeRecord('builtin', { type: 'local', path: join(stateDir, 'plugins') }, join(stateDir, 'plugins'))
    await store.seedBuiltinIfFirstRun(record)
    // Second call — the file now exists.
    const seededAgain = await store.seedBuiltinIfFirstRun(record)
    expect(seededAgain).toBe(false)
  })

  it('seedBuiltinIfFirstRun is a no-op when the id is already present', async () => {
    const record = makeRecord('builtin', { type: 'local', path: join(stateDir, 'plugins') }, join(stateDir, 'plugins'))
    store.upsert(record)
    // File may not exist yet (debounced) — the id check must still guard.
    const seeded = await store.seedBuiltinIfFirstRun(record)
    expect(seeded).toBe(false)
    await store.flush() // settle the pending debounced write before teardown
  })

  it('removeEntry deletes an https cloneDir but keeps a local one', async () => {
    const localDir = join(stateDir, 'plugins')
    const cloneDir = join(stateDir, 'clone')
    mkdirSync(localDir, { recursive: true })
    mkdirSync(cloneDir, { recursive: true })
    writeFileSync(join(localDir, 'marker.txt'), 'x')
    writeFileSync(join(cloneDir, 'marker.txt'), 'x')

    store.upsert(makeRecord('local', { type: 'local', path: localDir }, localDir))
    store.upsert(makeRecord('https', { type: 'https', url: 'https://example.com/x.git' }, cloneDir))
    await store.flush()

    await store.removeEntry('https')
    expect(existsSync(cloneDir)).toBe(false)

    await store.removeEntry('local')
    expect(existsSync(localDir)).toBe(true)
  })

  it('load coerces an optional valid subdir and drops an invalid one', async () => {
    const now = Date.now()
    mkdirSync(join(stateDir, 'app-plugins'), { recursive: true })
    writeFileSync(join(stateDir, 'app-plugins', 'marketplaces.json'), JSON.stringify({
      version: 1,
      marketplaces: {
        good: { id: 'good', displayName: 'Good', source: { type: 'https', url: 'https://example.com/g.git' }, subdir: 'plugins', cloneDir: join(stateDir, 'g'), addedAt: now, lastRefreshedAt: now, lastSha: '', manifest: { plugins: [] } },
        bad: { id: 'bad', displayName: 'Bad', source: { type: 'https', url: 'https://example.com/b.git' }, subdir: '../escape', cloneDir: join(stateDir, 'b'), addedAt: now, lastRefreshedAt: now, lastSha: '', manifest: { plugins: [] } },
      },
    }))
    await store.load()
    expect(store.get('good')?.subdir).toBe('plugins')
    expect(store.get('bad')).toBeUndefined()
  })
})
