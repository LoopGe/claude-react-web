import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { tempDir, rmRf } from '../__test-utils__/index.js'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query() {
    return {
      [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }), return: async () => ({ value: undefined, done: true }) } },
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async () => {}),
      reloadPlugins: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      supportedAgents: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({})),
      getContextUsage: vi.fn(async () => ({})),
    }
  },
}))
vi.mock('../app-plugins/marketplace-parser.js', async () => {
  const actual = await import('../app-plugins/marketplace-parser.js')
  return {
    ...actual,
    parseAppPluginMarketplaceAuto: vi.fn(async () => ({
      subdir: undefined,
      manifest: { name: 'Mods', plugins: [{ name: 'hello', dir: 'hello' }] },
    })),
  }
})
vi.mock('../git-clone.js', async () => {
  const { HttpError } = await import('../errors.js')
  return {
    assertHttpsUrl: (url: string) => { if (!url.startsWith('https://')) throw new HttpError(400, `bad url: ${url}`) },
    gitClone: vi.fn(async (_url: string, dest: string) => { mkdirSync(dest, { recursive: true }) }),
    gitGetHeadSha: vi.fn(async () => 'a'.repeat(40)),
    gitBranchName: vi.fn(async () => 'main'),
    gitPull: vi.fn(async () => ({ updated: false, newSha: 'a'.repeat(40) })),
  }
})

import { appPluginGroup } from './app-plugin.js'
import { parseArgs } from './parser.js'
import { CliContext } from './types.js'

describe('app-plugin group', () => {
  let dir: string
  let ctx: CliContext
  beforeEach(async () => { dir = tempDir('cli-appplugin'); ctx = { stateDir: dir } })
  afterEach(() => rmRf(dir))
  const sub = (n: string) => appPluginGroup.subcommands.find((s) => s.name === n)!

  it('adds and lists an app-plugin marketplace via the nested marketplace verb', async () => {
    await sub('marketplace').run(ctx, parseArgs(['add', 'https://github.com/acme/crw-plugins.git'], { minPositional: 1 }))
    const out = await sub('marketplace').run(ctx, parseArgs(['list'], { minPositional: 1 }))
    const action = out as { action: string; marketplaces: Array<{ id: string }> }
    expect(action.action).toBe('list')
    expect(action.marketplaces.map((m) => m.id)).toContain('crw-plugins')
  })

  it('removes an app-plugin marketplace with --yes', async () => {
    await sub('marketplace').run(ctx, parseArgs(['add', 'https://github.com/acme/crw-plugins.git'], { minPositional: 1 }))
    const out = await sub('marketplace').run(ctx, parseArgs(['remove', 'crw-plugins', '--yes'], { minPositional: 1 }))
    expect((out as { action: string; removed: string }).removed).toBe('crw-plugins')
  })
})
