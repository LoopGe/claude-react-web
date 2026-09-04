import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import { addAppPluginMarketplaceByUrl } from './marketplace-ops.js'

const FAKE_SHA = '3'.repeat(40)

vi.mock('../git-clone.js', async () => {
  const { HttpError } = await import('../errors.js')
  return {
    assertHttpsUrl: (url: string) => { if (!url.startsWith('https://')) throw new HttpError(400, `bad url: ${url}`) },
    gitClone: vi.fn(async (_url: string, dest: string) => { mkdirSync(dest, { recursive: true }) }),
    gitGetHeadSha: vi.fn(async () => FAKE_SHA),
    gitBranchName: vi.fn(async () => 'main'),
    gitPull: vi.fn(async () => ({ updated: false, newSha: FAKE_SHA })),
  }
})
vi.mock('./marketplace-parser.js', () => ({
  parseAppPluginMarketplaceAuto: vi.fn(async () => ({
    subdir: undefined,
    manifest: { name: 'Acme Mods', plugins: [{ name: 'm1', dir: 'm1' }] },
  })),
}))

describe('addAppPluginMarketplaceByUrl', () => {
  let dir: string
  let store: AppPluginMarketplaceStore
  beforeEach(async () => { dir = tempDir('appmp-ops'); store = new AppPluginMarketplaceStore({ stateDir: dir }); await store.load() })
  afterEach(() => rmRf(dir))

  it('clones, parses, persists a record', async () => {
    const { record } = await addAppPluginMarketplaceByUrl(store, { url: 'https://github.com/acme/crw-plugins.git' })
    expect(record.id).toBe('crw-plugins')
    expect(record.displayName).toBe('Acme Mods')
    expect(store.get(record.id)?.lastSha).toBe(FAKE_SHA)
  })

  it('rejects non-https urls', async () => {
    await expect(addAppPluginMarketplaceByUrl(store, { url: 'git@github.com:acme/crw-plugins.git' })).rejects.toThrow(/bad url/)
  })
})
