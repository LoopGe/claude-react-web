import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => ({ id: 's1', permissionMode: 'default' })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

describe('session permission mode routes', () => {
  it('rejects unsupported permissionMode on session create', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'auto' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'permissionMode must be one of default, acceptEdits, plan, bypassPermissions, dontAsk' })
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('rejects unsupported live permission-mode switches', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permission-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'mode must be one of default, acceptEdits, plan, bypassPermissions, dontAsk' })
    expect(sm.setPermissionMode).not.toHaveBeenCalled()
  })
})
