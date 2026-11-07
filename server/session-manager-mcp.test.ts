import { describe, it, expect, vi } from 'vitest'
import { SessionMcpManager, type McpManagerDeps } from './session-manager-mcp.js'

function makeDeps(session: Record<string, unknown>) {
  const setMcpServers = vi.fn(async () => ({ added: ['b'], removed: [], errors: {} }))
  const configs: Record<string, unknown> = { a: { type: 'stdio', command: 'node' }, b: { type: 'stdio', command: 'node' } }
  const mcpStore = {
    toSdkConfig: () => ({ a: configs.a }),
    getSdkServerConfig: (n: string) => configs[n] ?? null,
    get: (n: string) => (n in configs ? { name: n } : undefined),
    refreshOAuthTokens: async () => {},
  }
  const deps = {
    requireLive: () => session,
    require: () => session,
    requireHandleMethod: () => setMcpServers,
    writeStore: vi.fn(),
    broadcastGlobal: vi.fn(),
    info: () => ({}),
    persist: vi.fn(),
    mcpStore,
    timeSdkControl: async (_id: string, _label: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as McpManagerDeps
  return { deps, setMcpServers }
}

describe('SessionMcpManager attach', () => {
  it('attach preserves an inheriting session (no mcpServerNames stamp)', async () => {
    const session: Record<string, unknown> = { id: 's1', cwd: undefined, mcpServerNames: undefined, dynamicMcpServers: { inline: { type: 'stdio', command: 'node' } } }
    const { deps, setMcpServers } = makeDeps(session)
    const m = new SessionMcpManager(deps)
    const res = await m.attachGlobalMcpServer('s1', 'b')
    expect(res.added).toEqual(['b'])
    expect(session.mcpServerNames).toBeUndefined()
    expect(setMcpServers).toHaveBeenCalledWith({ a: expect.anything(), inline: { type: 'stdio', command: 'node' }, b: expect.anything() })
  })

  it('attach stamps an own-list session', async () => {
    const session: Record<string, unknown> = { id: 's1', cwd: undefined, mcpServerNames: ['a'], dynamicMcpServers: undefined }
    const { deps } = makeDeps(session)
    const m = new SessionMcpManager(deps)
    await m.attachGlobalMcpServer('s1', 'b')
    expect(session.mcpServerNames).toEqual(['a', 'b'])
  })
})