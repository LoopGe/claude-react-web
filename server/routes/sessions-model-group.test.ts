import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    setModelGroup: vi.fn(async () => ({ id: 's1', model: 'm', modelGroupId: 'g1' })),
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

describe('POST /sessions/:id/model-group', () => {
  it('forwards groupId to sm.setModelGroup and wraps the session', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/model-group', { groupId: 'g1' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: { modelGroupId: string } }
    expect(body.session.modelGroupId).toBe('g1')
    expect(sm.setModelGroup).toHaveBeenCalledWith('s1', 'g1')
  })

  it('rejects a missing groupId with 400 and does not call the manager', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/model-group', {})
    expect(res.status).toBe(400)
    expect(sm.setModelGroup).not.toHaveBeenCalled()
  })

  it('rejects a non-string groupId with 400', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/model-group', { groupId: 42 })
    expect(res.status).toBe(400)
    expect(sm.setModelGroup).not.toHaveBeenCalled()
  })
})

describe('POST /sessions create-time modelGroupId', () => {
  it('passes a valid modelGroupId through to sm.create', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions', { modelGroupId: 'g1' })
    expect(res.status).toBe(201)
    const calls = (sm.create as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const opts = calls[0][0] as { modelGroupId?: unknown }
    expect(opts.modelGroupId).toBe('g1')
  })

  it('rejects a non-string modelGroupId with 400 and does not create', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions', { modelGroupId: 42 })
    expect(res.status).toBe(400)
    expect(sm.create).not.toHaveBeenCalled()
  })
})
