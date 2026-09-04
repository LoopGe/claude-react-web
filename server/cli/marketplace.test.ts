import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { MpStore } from '../mp-store.js'
import { marketplaceGroup } from './marketplace.js'
import { parseArgs } from './parser.js'
import { CliContext } from './types.js'

const FAKE_SHA = '2'.repeat(40)

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
vi.mock('../marketplace-parser.js', async () => {
  const actual = await import('../marketplace-parser.js')
  return {
    ...actual,
    parseRepoManifest: vi.fn(async () => ({
      manifest: { name: 'Acme', plugins: [{ name: 'p1', description: 'd', version: '1.0.0' }] },
      warnings: [],
    })),
  }
})

describe('marketplace group', () => {
  let dir: string
  let ctx: CliContext
  beforeEach(async () => {
    dir = tempDir('cli-mp')
    ctx = { stateDir: dir }
  })
  afterEach(() => rmRf(dir))

  const freshStore = async (): Promise<MpStore> => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    return s
  }
  const sub = (n: string) => marketplaceGroup.subcommands.find((s) => s.name === n)!

  it('adds a marketplace by url', async () => {
    const out = await sub('add').run(ctx, parseArgs(['https://github.com/acme/plugins.git'], { minPositional: 1, maxPositional: 1 }))
    expect((out as { ok: boolean }).ok).toBe(true)
    expect((await freshStore()).has('plugins')).toBe(true)
  })

  it('lists marketplaces', async () => {
    await sub('add').run(ctx, parseArgs(['https://github.com/acme/plugins.git'], { minPositional: 1, maxPositional: 1 }))
    const out = await sub('list').run(ctx, parseArgs([]))
    const items = (out as { marketplaces: Array<{ id: string; displayName: string; pluginCount: number }> }).marketplaces
    expect(items[0]).toMatchObject({ id: 'plugins', displayName: 'Acme', pluginCount: 1 })
  })

  it('removes by id or by url (with --yes)', async () => {
    await sub('add').run(ctx, parseArgs(['https://github.com/acme/plugins.git'], { minPositional: 1, maxPositional: 1 }))
    await expect(sub('remove').run(ctx, parseArgs(['plugins'], { minPositional: 1, maxPositional: 1 }))).rejects.toThrow(/--yes/)
    await sub('remove').run(ctx, parseArgs(['plugins', '--yes'], { minPositional: 1, maxPositional: 1 }))
    expect((await freshStore()).has('plugins')).toBe(false)
  })
})
