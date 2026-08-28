import { describe, it, expect, vi } from 'vitest'
import { buildResetRouter } from './reset'
import { updateConfigFile, loadConfig, queueConfigWrite } from '../config.js'

vi.mock('../config.js', () => ({
  updateConfigFile: vi.fn(async () => {}),
  loadConfig: vi.fn(async () => {}),
  queueConfigWrite: vi.fn(async () => {}),
  DEFAULT_PROFILE: {
    modelList: ['default-m1'],
    modelGroups: [],
    recapModel: 'default-r',
    commitMessageModel: 'default-c',
  },
  WRITABLE_CONFIG_KEYS: [],
  get config() {
    return { logToFile: false }
  },
}))

vi.mock('../log.js', () => ({
  clearLogFile: vi.fn(async () => {}),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}))

function makeDeps(overrides = {}) {
  return {
    sm: { list: vi.fn(() => []), delete: vi.fn(async () => {}) },
    configDir: '/tmp/cfg',
    mcpStore: { clearAll: vi.fn(async () => {}) },
    mpStore: { clearAll: vi.fn(async () => {}) },
    snippetStore: { clearAll: vi.fn(async () => {}) },
    uiStateStore: { clearAll: vi.fn(async () => {}) },
    ...overrides,
  }
}

describe('POST /config/reset', () => {
  it('clears only the requested items, best-effort, returns results', async () => {
    const deps = makeDeps()
    const app = buildResetRouter(deps as any)
    const res = await app.request('/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['mcp-configs', 'snippets'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.results['mcp-configs']).toEqual({ ok: true })
    expect(body.results['snippets']).toEqual({ ok: true })
    expect(deps.mcpStore.clearAll).toHaveBeenCalledOnce()
    expect(deps.snippetStore.clearAll).toHaveBeenCalledOnce()
    expect(deps.mpStore.clearAll).not.toHaveBeenCalled()
  })

  it('continues on per-item failure and reports the error', async () => {
    const deps = makeDeps({ mcpStore: { clearAll: vi.fn(async () => { throw new Error('boom') }) } })
    const app = buildResetRouter(deps as any)
    const res = await app.request('/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['mcp-configs', 'snippets'] }),
    })
    const body = (await res.json()) as any
    expect(body.results['mcp-configs']).toEqual({ ok: false, error: 'boom' })
    expect(body.results['snippets']).toEqual({ ok: true })
  })

  it('sessions clear deletes all sessions and returns their ids', async () => {
    const deps = makeDeps({ sm: { list: vi.fn(() => [{ id: 'a' }, { id: 'b' }]), delete: vi.fn(async () => {}) } })
    const app = buildResetRouter(deps as any)
    const res = await app.request('/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['sessions'] }),
    })
    const body = (await res.json()) as any
    expect(body.deletedSessionIds).toEqual(['a', 'b'])
    expect(deps.sm.delete).toHaveBeenCalledWith('a')
    expect(deps.sm.delete).toHaveBeenCalledWith('b')
  })

  it('sessions clear is best-effort: a failing delete does not abort the rest', async () => {
    // 'b' fails (stuck subprocess); 'a' and 'c' still attempted + recorded.
    const deleteFn = vi.fn(async (id: string) => {
      if (id === 'b') throw new Error('stuck')
    })
    const deps = makeDeps({
      sm: { list: vi.fn(() => [{ id: 'a' }, { id: 'b' }, { id: 'c' }]), delete: deleteFn },
    })
    const app = buildResetRouter(deps as any)
    const res = await app.request('/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['sessions'] }),
    })
    const body = (await res.json()) as any
    // All three attempted (b's failure didn't skip c).
    expect(deleteFn).toHaveBeenCalledWith('a')
    expect(deleteFn).toHaveBeenCalledWith('b')
    expect(deleteFn).toHaveBeenCalledWith('c')
    // Only the actually-deleted ids are returned (b is absent).
    expect(body.deletedSessionIds).toEqual(['a', 'c'])
    // The item is marked failed with a count, but the request still 200s.
    expect(body.results.sessions).toEqual({ ok: false, error: '1 session(s) could not be deleted' })
  })

  it('app-settings clears non-model keys via updateConfigFile and resets profile model fields via queueConfigWrite', async () => {
    const deps = makeDeps()
    const app = buildResetRouter(deps as any)
    const res = await app.request('/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['app-settings'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.results['app-settings']).toEqual({ ok: true })
    // Non-model keys cleared top-level.
    expect(updateConfigFile).toHaveBeenCalled()
    const nulls = (updateConfigFile as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, null>
    expect(nulls.modelList).toBeUndefined()
    expect(nulls.recapModel).toBeUndefined()
    expect(nulls.commitMessageModel).toBeUndefined()
    expect(nulls.maxUploadBytes).toBeNull()
    // Profile model fields reset through the config write queue.
    expect(queueConfigWrite).toHaveBeenCalled()
    expect(loadConfig).toHaveBeenCalled()
  })

  it('rejects unknown items with 400', async () => {
    const app = buildResetRouter(makeDeps() as any)
    const res = await app.request('/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['bogus'] }),
    })
    expect(res.status).toBe(400)
  })
})
