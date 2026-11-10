import { describe, it, expect, vi } from 'vitest'
import { SessionMcpManager, type McpManagerDeps } from './session-manager-mcp.js'

function makeDeps(session: Record<string, unknown>, extraConfigs: Record<string, unknown> = {}) {
  const setMcpServers = vi.fn(async () => ({ added: ['b'], removed: [], errors: {} }))
  const configs: Record<string, unknown> = {
    a: { type: 'stdio', command: 'node' },
    b: { type: 'stdio', command: 'node' },
    ...extraConfigs,
  }
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

describe('SessionMcpManager setFirstPartyTool', () => {
  it('re-runs setMcpServers on a live session and persists the override', async () => {
    const session: Record<string, unknown> = {
      id: 's1',
      running: true,
      cwd: '/tmp',
      firstPartyTools: undefined,
      dynamicMcpServers: { inline: { type: 'stdio', command: 'node' } },
    }
    const { deps, setMcpServers } = makeDeps(session)
    const m = new SessionMcpManager(deps)

    await m.setFirstPartyTool('s1', 'git-tools', false)

    expect(setMcpServers).toHaveBeenCalledTimes(1)
    // The session's own inline server survives the replace-semantics call.
    expect(setMcpServers).toHaveBeenCalledWith(
      expect.objectContaining({ inline: { type: 'stdio', command: 'node' } }),
    )
    expect(session.firstPartyTools).toEqual({ 'git-tools': false })
  })

  it('reverts the override when live re-injection fails', async () => {
    const prior = { 'git-tools': true }
    const session: Record<string, unknown> = {
      id: 's1',
      running: true,
      cwd: '/tmp',
      firstPartyTools: prior,
      appToolsGit: true,
      dynamicMcpServers: { inline: { type: 'stdio', command: 'node' } },
    }
    const { deps, setMcpServers } = makeDeps(session)
    setMcpServers.mockRejectedValueOnce(new Error('boom'))
    const m = new SessionMcpManager(deps)

    await expect(m.setFirstPartyTool('s1', 'git-tools', false)).rejects.toThrow('boom')

    expect(session.firstPartyTools).toEqual(prior)
    // The legacy appToolsGit surface is reverted alongside the canonical map.
    expect(session.appToolsGit).toBe(true)
  })
})

describe('SessionMcpManager detach', () => {
  // Post-remove state: the global store no longer defines the target. It must
  // NOT be re-carried as an inline entry (that would re-add it).
  it('drops the removed server from an own-list session', async () => {
    const session: Record<string, unknown> = {
      id: 's1',
      cwd: undefined,
      mcpServerNames: ['a', 'pw'],
      dynamicMcpServers: { a: { type: 'stdio', command: 'node' }, pw: { type: 'stdio', command: 'node' } },
    }
    const { deps, setMcpServers } = makeDeps(session)
    const m = new SessionMcpManager(deps)
    await m.detachGlobalMcpServer('s1', 'pw')
    expect(setMcpServers).toHaveBeenCalledTimes(1)
    expect(setMcpServers).toHaveBeenCalledWith({ a: expect.anything() })
    expect(session.mcpServerNames).toEqual(['a'])
  })

  it('leaves an inheriting session inheriting', async () => {
    const session: Record<string, unknown> = {
      id: 's1',
      cwd: undefined,
      mcpServerNames: undefined,
      dynamicMcpServers: { a: { type: 'stdio', command: 'node' }, pw: { type: 'stdio', command: 'node' } },
    }
    const { deps, setMcpServers } = makeDeps(session)
    const m = new SessionMcpManager(deps)
    await m.detachGlobalMcpServer('s1', 'pw')
    expect(setMcpServers).toHaveBeenCalledWith({ a: expect.anything() })
    expect(session.mcpServerNames).toBeUndefined()
  })

  it('drops a still-stored disabled server (set_enabled(false) shape)', async () => {
    const session: Record<string, unknown> = {
      id: 's1',
      cwd: undefined,
      mcpServerNames: ['a', 'pw'],
      dynamicMcpServers: { a: { type: 'stdio', command: 'node' }, pw: { type: 'stdio', command: 'node' } },
    }
    const { deps, setMcpServers } = makeDeps(session, { pw: { type: 'stdio', command: 'node', enabled: false } })
    const m = new SessionMcpManager(deps)
    await m.detachGlobalMcpServer('s1', 'pw')
    expect(setMcpServers).toHaveBeenCalledWith({ a: expect.anything() })
    expect(session.mcpServerNames).toEqual(['a'])
  })
})
