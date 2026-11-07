import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { FirstPartyToolRegistry } from './registry.js'
import { registerConfigToolServers } from './config-tools.js'
import { McpConfigStore } from '../mcp-config.js'
import { createMcpServer } from '../mcp-ops.js'
import { MpStore } from '../mp-store.js'
import { tempDir } from '../__test-utils__/index.js'
import type { SessionManager } from '../session-manager.js'

describe('registerConfigToolServers', () => {
  let dir: string
  let mcpStore: McpConfigStore
  let mpStore: MpStore
  beforeEach(async () => {
    dir = tempDir('config-tools')
    mcpStore = new McpConfigStore({ stateDir: dir })
    await mcpStore.load()
    mpStore = new MpStore({ stateDir: dir })
    await mpStore.load()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const sm = {
    attachGlobalMcpServer: vi.fn(async () => ({ alreadyAttached: false, added: ['pw'], removed: [], errors: {} })),
    detachGlobalMcpServer: vi.fn(async () => ({ alreadyAttached: false, added: [], removed: ['pw'], errors: {} })),
    reloadSkillsForCwd: vi.fn(async () => ({ reloaded: [], failed: [] })),
  } as unknown as SessionManager

  it('registers the three servers and is idempotent', () => {
    const registry = new FirstPartyToolRegistry()
    registerConfigToolServers({ registry, sm, mcpStore, mpStore })
    registerConfigToolServers({ registry, sm, mcpStore, mpStore })
    expect(registry.list().map((s) => s.name).sort()).toEqual([
      'marketplace-tools', 'mcp-tools', 'skills-tools',
    ])
    for (const name of ['skills-tools', 'mcp-tools', 'marketplace-tools']) {
      const server = registry.get(name)!
      expect(server.defaultEnabled).toBe(true)
      expect(server.requiresCwd).toBe(false)
    }
  })

  it('wires mcp-tools add to the store and the calling session', async () => {
    const registry = new FirstPartyToolRegistry()
    registerConfigToolServers({ registry, sm, mcpStore, mpStore })
    const tool = registry.get('mcp-tools')!.buildTools(null, { sessionId: 's1' }).find((t) => t.name === 'add')!
    const res = await tool.handler({ name: 'pw', command: 'node', args: ['x.js'] } as never, undefined)
    expect(res.isError ?? false).toBe(false)
    expect(mcpStore.get('pw')?.command).toBe('node')
    expect(sm.attachGlobalMcpServer).toHaveBeenCalledWith('s1', 'pw')
  })

  it('mcp-tools list never exposes env/header values', async () => {
    const registry = new FirstPartyToolRegistry()
    registerConfigToolServers({ registry, sm, mcpStore, mpStore })
    createMcpServer(mcpStore, { name: 'pw', command: 'node', env: { TOKEN: 's3cr3t' } })
    const tool = registry.get('mcp-tools')!.buildTools(null, { sessionId: 's1' }).find((t) => t.name === 'list')!
    const res = await tool.handler({} as never, undefined)
    const firstText = (r: { content?: Array<{ type: string; text?: string }> }) =>
      r.content?.find((c) => c.type === 'text')?.text ?? ''
    const body = firstText(res)
    expect(body).toContain('envKeys')
    expect(body).not.toContain('s3cr3t')
  })
})