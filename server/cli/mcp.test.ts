import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { McpConfigStore } from '../mcp-config.js'
import { mcpGroup } from './mcp.js'
import { parseArgs } from './parser.js'
import { CliContext } from './types.js'

const MCP_ADD_SPEC = {
  string: ['type', 'command', 'args', 'url'],
  repeatable: ['env', 'headers'],
  boolean: ['always-load', 'disabled'],
  minPositional: 1,
  maxPositional: 1,
} as const

describe('mcp group', () => {
  let dir: string
  let ctx: CliContext
  beforeEach(async () => {
    dir = tempDir('cli-mcp')
    ctx = { stateDir: dir }
  })
  afterEach(() => rmRf(dir))

  const freshStore = async (): Promise<McpConfigStore> => {
    const s = new McpConfigStore({ stateDir: dir })
    await s.load()
    return s
  }
  const sub = (name: string) => mcpGroup.subcommands.find((s) => s.name === name)!

  it('adds a stdio server and lists it masked', async () => {
    const add = await sub('add').run(ctx, parseArgs(['filesys', '--command', 'npx', '--args', '["-y","x"]', '--env', 'A=1'], MCP_ADD_SPEC))
    expect((add as { ok: boolean }).ok).toBe(true)
    const store = await freshStore()
    expect(store.has('filesys')).toBe(true)
    const stored = store.get('filesys')!
    expect(stored.command).toBe('npx')
    expect(stored.args).toEqual(['-y', 'x'])
    expect(stored.env).toEqual({ A: '1' })

    const listed = await sub('list').run(ctx, parseArgs([]))
    const servers = (listed as { servers: Array<{ name: string }> }).servers
    expect(servers.map((s) => s.name)).toContain('filesys')
  })

  it('rejects a command outside the allowlist', async () => {
    await expect(
      sub('add').run(ctx, parseArgs(['evil', '--command', 'curl'], MCP_ADD_SPEC)),
    ).rejects.toThrow(/not in the allowlist/)
  })

  it('adds then removes (with --yes) a server', async () => {
    await sub('add').run(ctx, parseArgs(['db', '--command', 'node'], { string: ['command'], minPositional: 1, maxPositional: 1 }))
    expect((await freshStore()).has('db')).toBe(true)
    await expect(sub('remove').run(ctx, parseArgs(['db'], { minPositional: 1, maxPositional: 1 }))).rejects.toThrow(/--yes/)
    await sub('remove').run(ctx, parseArgs(['db', '--yes'], { minPositional: 1, maxPositional: 1 }))
    expect((await freshStore()).has('db')).toBe(false)
  })

  it('toggles enabled state', async () => {
    await sub('add').run(ctx, parseArgs(['s', '--command', 'node'], { string: ['command'], minPositional: 1, maxPositional: 1 }))
    await sub('disable').run(ctx, parseArgs(['s'], { minPositional: 1, maxPositional: 1 }))
    expect((await freshStore()).get('s')!.enabled).toBe(false)
    await sub('enable').run(ctx, parseArgs(['s'], { minPositional: 1, maxPositional: 1 }))
    expect((await freshStore()).get('s')!.enabled).toBe(true)
  })
})
