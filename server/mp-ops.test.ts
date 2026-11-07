import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { tempDir, rmRf } from './__test-utils__/index.js'
import { MpStore, type MpEntry } from './mp-store.js'
import type { SessionManager } from './session-manager.js'
import {
  addMarketplaceByUrl,
  applyPluginToggleToLiveSessions,
  listMarketplaces,
  toPluginListItem,
} from './mp-ops.js'

const FAKE_SHA = '1'.repeat(40)

// Deterministic fixtures: git-clone materialises an empty clone dir;
// parseRepoManifest is stubbed so the test never depends on parser internals
// (the real parser is covered by server/routes/mp-marketplace.test.ts).
vi.mock('./git-clone.js', async () => {
  const { HttpError } = await import('./errors.js')
  return {
    assertHttpsUrl: (url: string) => { if (!url.startsWith('https://')) throw new HttpError(400, `bad url: ${url}`) },
    gitClone: vi.fn(async (_url: string, dest: string) => { mkdirSync(dest, { recursive: true }) }),
    gitGetHeadSha: vi.fn(async () => FAKE_SHA),
    gitBranchName: vi.fn(async () => 'main'),
    gitPull: vi.fn(async () => ({ updated: false, newSha: FAKE_SHA })),
  }
})
vi.mock('./marketplace-parser.js', async () => {
  const actual = await import('./marketplace-parser.js')
  return {
    ...actual,
    parseRepoManifest: vi.fn(async () => ({
      manifest: { name: 'Test MP', plugins: [{ name: 'p1', description: 'd', version: '1.0.0' }] },
      warnings: [],
    })),
  }
})

describe('addMarketplaceByUrl', () => {
  let dir: string
  let store: MpStore
  beforeEach(async () => { dir = tempDir('mp-ops'); store = new MpStore({ stateDir: dir }); await store.load() })
  afterEach(() => rmRf(dir))

  it('clones, parses, and persists an entry', async () => {
    const { entry, warnings } = await addMarketplaceByUrl(store, { url: 'https://github.com/acme/plugins.git' })
    expect(entry.id).toBe('plugins')
    expect(entry.displayName).toBe('Test MP')
    expect(entry.lastSha).toBe(FAKE_SHA)
    expect(warnings).toEqual([])
    expect(store.get('plugins')?.cloneDir).toBe(entry.cloneDir)
  })

  it('rejects non-https urls before cloning', async () => {
    await expect(addMarketplaceByUrl(store, { url: 'git@github.com:acme/plugins.git' })).rejects.toThrow(/bad url/)
  })
})

function entry(over: Partial<MpEntry> = {}): MpEntry {
  return {
    id: 'mp-id',
    displayName: 'MP',
    source: { type: 'https', url: 'https://github.com/a/b' },
    cloneDir: '/tmp/mp',
    addedAt: 1,
    lastRefreshedAt: 2,
    lastSha: 'a'.repeat(40),
    manifest: {
      name: 'MP',
      plugins: [
        { name: 'p1', dir: '/tmp/mp/p1' },
        { name: 'p2', dir: '/tmp/mp/p2' },
      ],
    },
    ...over,
  }
}

const store = {
  enabledMapFor: () => ({ p1: true }),
} as unknown as MpStore

describe('mp-ops', () => {
  it('listMarketplaces computes plugin/enabled counts', () => {
    const list = listMarketplaces({ list: () => [entry()], enabledMapFor: store.enabledMapFor } as unknown as MpStore)
    expect(list[0]).toMatchObject({ id: 'mp-id', pluginCount: 2, enabledCount: 1 })
  })

  it('toPluginListItem exposes the enabled flag and hides dir', () => {
    expect(toPluginListItem({ name: 'p1', dir: '/x', description: 'd' }, true)).toEqual({
      name: 'p1', description: 'd', version: undefined, author: undefined,
      category: undefined, tags: undefined, enabled: true,
    })
  })

  it('applyPluginToggleToLiveSessions touches only running sessions', async () => {
    const sm = {
      list: () => [
        { id: 'live', running: true },
        { id: 'sleep', running: false },
      ],
      togglePlugin: vi.fn(async () => ({})),
      reloadPlugins: vi.fn(async () => ({})),
    } as unknown as SessionManager
    await applyPluginToggleToLiveSessions(sm, 'p1@mp-id', true)
    expect(sm.togglePlugin).toHaveBeenCalledTimes(1)
    expect(sm.togglePlugin).toHaveBeenCalledWith('live', 'p1@mp-id', true)
    expect(sm.reloadPlugins).toHaveBeenCalledWith('live')
  })
})
