import { vi, describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerHostApi } from './host-api.js'
import { SessionAdapter } from './session-adapter.js'
import { PermissionChecker, PermissionDeniedError } from '../permission-manager.js'
import { normalisePermissions } from '../../../shared/app-plugins/permissions.js'
import type { PluginConfigurationProperty } from '../../../shared/app-plugins/contributions.js'
import type { SessionManager } from '../../session-manager.js'
import type { RpcPeer } from '../rpc-peer.js'

// The idle-compact plugin's declared configuration — the defaults config.get
// must apply when nothing has been written yet.
const IDLE_COMPACT_PROPS: PluginConfigurationProperty[] = [
  { key: 'idle-compact.claude-react-web.enabled', type: 'boolean', title: 'Enabled', default: true },
  { key: 'idle-compact.claude-react-web.idleMinutes', type: 'number', title: 'Idle minutes', default: 10 },
  { key: 'idle-compact.claude-react-web.thresholdPercent', type: 'number', title: 'Context threshold (%)', default: 90 },
  { key: 'idle-compact.claude-react-web.minHistoryMessages', type: 'number', title: 'Min history messages', default: 20 },
]

function grants(...perms: Parameters<typeof normalisePermissions>[0]): ReturnType<typeof normalisePermissions>['permissions'] {
  return normalisePermissions(perms).permissions
}

describe('SessionAdapter — permission gates', () => {
  let checker: PermissionChecker
  let adapter: SessionAdapter
  // Minimal SessionManager stub exposing only the surfaces the adapter calls.
  const sm = {
    listActivity: () => [{ sessionId: 's1', provider: 'claude', running: true, terminated: false, pendingTurns: 0, pendingPermissions: 0, lastActivityAt: 1, historyLength: 0 }],
    getCachedContextUsage: (id: string) => (id === 's1' ? { totalTokens: 90_000, maxTokens: 100_000, rawMaxTokens: 100_000, percentage: 90, model: 'm' } : null),
    compact: async (id: string) => ({ id: `fresh-${id}` }),
  } as unknown as SessionManager

  function make(perms: ReturnType<typeof grants>) {
    checker = new PermissionChecker('idle-compact.claude-react-web', perms)
    adapter = new SessionAdapter(sm, checker, {} as unknown as RpcPeer, {} as any)
  }

  it('list() is denied without sessions.read', async () => {
    make(grants())
    await expect(adapter.list()).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('list() returns activity snapshots with sessions.read', async () => {
    make(grants('sessions.read'))
    const activity = await adapter.list()
    expect(activity).toHaveLength(1)
    expect(activity[0].sessionId).toBe('s1')
  })

  it('contextUsage() is denied without sessions.read and served with it', async () => {
    make(grants())
    await expect(adapter.contextUsage('s1')).rejects.toBeInstanceOf(PermissionDeniedError)

    make(grants('sessions.read'))
    const usage = await adapter.contextUsage('s1')
    expect(usage).toMatchObject({ totalTokens: 90_000, percentage: 90 })
    // Unknown session → null, not an error.
    expect(await adapter.contextUsage('ghost')).toBeNull()
  })

  it('compact() is denied without sessions.compact and served with it', async () => {
    make(grants('sessions.read'))
    await expect(adapter.compact('s1')).rejects.toBeInstanceOf(PermissionDeniedError)

    make(grants('sessions.read', 'sessions.compact'))
    const result = await adapter.compact('s1')
    expect(result).toEqual({ ok: true, sessionId: 'fresh-s1' })
  })
})

describe('registerHostApi — config.get wiring', () => {
  let dir: string
  let handlers: Record<string, (params: unknown) => Promise<unknown>>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-api-'))
    handlers = {}
    // A fake peer that just captures handlers — no subprocess. registerHostApi
    // wires every Host API method through this, so invoking the captured
    // handler exercises the same delegation the RPC peer would.
    const fakePeer = { registerHandler: (m: string, fn: (p: unknown) => Promise<unknown>) => { handlers[m] = fn } } as never
    registerHostApi(fakePeer, {
      pluginId: 'idle-compact.claude-react-web',
      dataDir: dir,
      stateDir: dir,
      grants: [],
      sm: {} as unknown as SessionManager,
      configurationProps: IDLE_COMPACT_PROPS,
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

  it('config.get applies declared defaults with no stored config', async () => {
    const cfg = (await handlers['config.get']({})) as Record<string, unknown>
    expect(cfg['idle-compact.claude-react-web.enabled']).toBe(true)
    expect(cfg['idle-compact.claude-react-web.idleMinutes']).toBe(10)
    expect(cfg['idle-compact.claude-react-web.thresholdPercent']).toBe(90)
    expect(cfg['idle-compact.claude-react-web.minHistoryMessages']).toBe(20)
  })

  it('config.get resolves even with zero grants (no permission gate)', async () => {
    // A plugin always reads only its OWN declared config, so there is no
    // permission check on this method.
    const cfg = (await handlers['config.get']({})) as Record<string, unknown>
    expect(cfg).toBeTruthy()
  })

  it('sessions.list / sessions.contextUsage / sessions.compact handlers are registered', async () => {
    for (const m of ['sessions.list', 'sessions.contextUsage', 'sessions.compact']) {
      expect(typeof handlers[m]).toBe('function')
    }
  })
})

describe('registerHostApi — sessions.subscribe', () => {
  let dir: string
  let handlers: Record<string, (params: unknown) => Promise<unknown>>
  let fakePeer: any

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-api-sub-'))
    handlers = {}
    fakePeer = {
      registerHandler: (m: string, fn: (p: unknown) => Promise<unknown>) => { handlers[m] = fn },
      notify: vi.fn(),
      closed: false,
    }
    registerHostApi(fakePeer, {
      pluginId: 'test-plugin',
      dataDir: dir,
      stateDir: dir,
      grants: [],
      sm: {} as unknown as SessionManager,
      configurationProps: [],
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

  it('sessions.subscribe is denied without sessions.read permission', async () => {
    expect(typeof handlers['sessions.subscribe']).toBe('function')
    await expect(handlers['sessions.subscribe']({ sessionId: 's1' })).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('sessions.subscribe registers subscriber with sessions.read permission', async () => {
    // Re-register handlers with the updated grants
    handlers = {}
    fakePeer = {
      registerHandler: (m: string, fn: (p: unknown) => Promise<unknown>) => { handlers[m] = fn },
      notify: vi.fn(),
      closed: false,
    } as unknown as RpcPeer
    registerHostApi(fakePeer, {
      pluginId: 'test-plugin',
      dataDir: dir,
      stateDir: dir,
      grants: grants('sessions.read'),
      sm: { get: () => ({ pluginSubscribers: new Map(), id: 's1' }) } as unknown as SessionManager,
      configurationProps: [],
    })

    const result = await handlers['sessions.subscribe']({ sessionId: 's1' })
    console.log('RESULT TYPE:', typeof result, 'RESULT:', result)
    expect((result as any).ok).toBe(true)
    console.log('UNSUBSCRIBE:', (result as any).unsubscribe)
    // Just test that true is true to see if expect works
    expect(true).toBe(true)
    // Test unsubscribe
    (result as any).unsubscribe()
  })
})
