import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

import { SessionStore } from '../persistence.js'
import { sessionsGroup } from './sessions.js'
import { parseArgs } from './parser.js'
import { CliContext } from './types.js'

describe('sessions group', () => {
  let dir: string
  let ctx: CliContext
  beforeEach(async () => { dir = tempDir('cli-sessions'); ctx = { stateDir: dir } })
  afterEach(() => rmRf(dir))
  const sub = (n: string) => sessionsGroup.subcommands.find((s) => s.name === n)!

  const seed = async (): Promise<void> => {
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    const now = Date.now()
    store.upsert({
      id: 's1',
      title: 'hello',
      provider: 'claude',
      createdAt: now,
      lastActivityAt: now,
      messageCount: 1,
      cwd: '/tmp',
      model: 'claude-haiku-3-5-20241022',
      terminated: false,
    })
    await store.flush()
  }

  it('lists persisted sessions', async () => {
    await seed()
    const out = await sub('list').run(ctx, parseArgs([]))
    const sessions = (out as { sessions: Array<{ id: string }> }).sessions
    expect(sessions.map((s) => s.id)).toContain('s1')
  })

  it('deletes a persisted session only with --yes', async () => {
    await seed()
    await expect(sub('delete').run(ctx, parseArgs(['s1'], { minPositional: 1, maxPositional: 1 }))).rejects.toThrow(/--yes/)
    const res = await sub('delete').run(ctx, parseArgs(['s1', '--yes'], { minPositional: 1, maxPositional: 1 }))
    expect((res as { deleted: string }).deleted).toBe('s1')
    const after = await sub('list').run(ctx, parseArgs([]))
    expect((after as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).not.toContain('s1')
  })
})
