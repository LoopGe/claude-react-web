import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    setAppTools: vi.fn(async () => ({ id: 's1', appToolsGit: false })),
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

describe('POST /sessions/:id/app-tools', () => {
  it('forwards a false override to sm.setAppTools and wraps the session', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/app-tools', { enabled: false })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: { id: string } }
    expect(body.session.id).toBe('s1')
    expect(sm.setAppTools).toHaveBeenCalledWith('s1', false)
  })

  it('forwards a true override', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/app-tools', { enabled: true })
    expect(res.status).toBe(200)
    expect(sm.setAppTools).toHaveBeenCalledWith('s1', true)
  })

  it('forwards null to clear the override (inherit global)', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/app-tools', { enabled: null })
    expect(res.status).toBe(200)
    expect(sm.setAppTools).toHaveBeenCalledWith('s1', null)
  })

  it('treats a missing enabled field as clear (null)', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, '/sessions/s1/app-tools', {})
    expect(res.status).toBe(200)
    expect(sm.setAppTools).toHaveBeenCalledWith('s1', null)
  })

  it('400s on a non-boolean/non-null body', async () => {
    const { app, sm } = makeApp()
    for (const bad of [{ enabled: 'yes' }, { enabled: 1 }, { enabled: {} }]) {
      const res = await post(app, '/sessions/s1/app-tools', bad)
      expect(res.status).toBe(400)
    }
    expect(sm.setAppTools).not.toHaveBeenCalled()
  })
})