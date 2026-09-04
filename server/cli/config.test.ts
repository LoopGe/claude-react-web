import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { loadConfig } from '../config.js'
import { configGroup } from './config.js'
import { parseArgs } from './parser.js'
import { CliContext } from './types.js'

function seed(dir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-secret12345678', baseUrl: 'https://api.anthropic.com', modelList: [] }],
    activeProfileId: 'default',
    ...extra,
  }), 'utf8')
}

describe('config group', () => {
  let dir: string
  let ctx: CliContext
  beforeEach(async () => { dir = tempDir('cli-config'); ctx = { stateDir: dir } })
  afterEach(() => rmRf(dir))
  const sub = (n: string) => configGroup.subcommands.find((s) => s.name === n)!

  it('get masks auth tokens and surfaces settings', async () => {
    seed(dir)
    await loadConfig(dir)
    const out = await sub('get').run(ctx, parseArgs([]))
    const g = out as { authTokenMasked: string | undefined; configured: boolean }
    expect(g.configured).toBe(true)
    expect(g.authTokenMasked).toBe('****5678')
  })

  it('set updates a writable scalar key', async () => {
    seed(dir, { maxUploadBytes: 100 })
    await loadConfig(dir)
    await sub('set').run(ctx, parseArgs(['maxUploadBytes', '999'], { minPositional: 2, maxPositional: 2 }))
    const out = await sub('get').run(ctx, parseArgs([]))
    expect((out as { maxUploadBytes: number }).maxUploadBytes).toBe(999)
  })

  it('rejects non-writable keys', async () => {
    seed(dir)
    await loadConfig(dir)
    await expect(sub('set').run(ctx, parseArgs(['accessToken', 'x'], { minPositional: 2, maxPositional: 2 }))).rejects.toThrow(/non-writable/)
  })
})
