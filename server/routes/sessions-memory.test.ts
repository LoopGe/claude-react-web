import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    setMemorySettings: vi.fn(async () => ({ id: 's1', memory: { autoMemoryEnabled: true } })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

function post(app: ReturnType<typeof makeApp>['app'], path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /sessions/:id/memory', () => {
  it('forwards present keys to sm.setMemorySettings and wraps the session', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/memory', { autoMemoryEnabled: true, autoMemoryDirectory: '~/mem' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: { id: string } }
    expect(body.session.id).toBe('s1')
    expect(sm.setMemorySettings).toHaveBeenCalledWith('s1', { autoMemoryEnabled: true, autoMemoryDirectory: '~/mem' })
  })

  it('forwards null to clear a key', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/memory', { autoMemoryDirectory: null })
    expect(res.status).toBe(200)
    expect(sm.setMemorySettings).toHaveBeenCalledWith('s1', { autoMemoryDirectory: null })
  })

  it('treats an empty body as a no-op partial', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/memory', {})
    expect(res.status).toBe(200)
    expect(sm.setMemorySettings).toHaveBeenCalledWith('s1', {})
  })

  it('rejects a non-boolean autoMemoryEnabled', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/memory', { autoMemoryEnabled: 'yes' })
    expect(res.status).toBe(400)
    expect(sm.setMemorySettings).not.toHaveBeenCalled()
  })

  it('rejects a non-string autoMemoryDirectory', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/memory', { autoMemoryDirectory: 42 })
    expect(res.status).toBe(400)
    expect(sm.setMemorySettings).not.toHaveBeenCalled()
  })

  it('rejects control characters in autoMemoryDirectory', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/memory', { autoMemoryDirectory: '/mem\n/../etc' })
    expect(res.status).toBe(400)
    expect(sm.setMemorySettings).not.toHaveBeenCalled()
  })

  it('ignores unrelated body keys', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/memory', { autoDreamEnabled: true, fastMode: true })
    expect(res.status).toBe(200)
    expect(sm.setMemorySettings).toHaveBeenCalledWith('s1', { autoDreamEnabled: true })
  })
})

describe('POST /sessions create-time memory field', () => {
  it('passes a valid memory object through to sm.create', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions', { memory: { autoMemoryEnabled: true, autoDreamEnabled: false } })
    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalledTimes(1)
    // The stub's create signature takes no args, so read the captured calls
    // through an untyped lens.
    const calls = (sm.create as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const opts = calls[0][0] as { memory?: unknown }
    expect(opts.memory).toEqual({ autoMemoryEnabled: true, autoDreamEnabled: false })
  })

  it('rejects a non-boolean autoMemoryEnabled with 400 and does not create', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions', { memory: { autoMemoryEnabled: 1 } })
    expect(res.status).toBe(400)
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('rejects an unknown memory key with 400', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions', { memory: { autoMemoryEnabled: true, bogus: 'x' } })
    expect(res.status).toBe(400)
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('rejects an empty-string autoMemoryDirectory with 400', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions', { memory: { autoMemoryDirectory: '  ' } })
    expect(res.status).toBe(400)
    expect(sm.create).not.toHaveBeenCalled()
  })
})
