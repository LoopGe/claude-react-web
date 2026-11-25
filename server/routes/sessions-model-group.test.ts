import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
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

describe('POST /sessions/:id/model-group (removed)', () => {
  it('is gone — returns 404', async () => {
    const { app } = makeApp()
    const res = await post(app, '/sessions/s1/model-group', { groupId: 'g1' })
    expect(res.status).toBe(404)
  })
})

describe('POST /sessions create-time modelGroupId (removed)', () => {
  it('drops a modelGroupId body key — not forwarded to create', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions', { modelGroupId: 'g1', model: 'm1' })
    expect(res.status).toBe(201)
    const calls = (sm.create as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const opts = calls[0][0] as { modelGroupId?: unknown; model?: unknown }
    expect(opts.modelGroupId).toBeUndefined()
    expect(opts.model).toBe('m1')
  })
})