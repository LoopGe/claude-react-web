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
  it('accepts auto as a valid permissionMode on session create', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'auto' }),
    })
    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalled()
  })

  it('accepts auto as a valid live permission-mode switch', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permission-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    })
    expect(res.status).toBe(200)
    expect(sm.setPermissionMode).toHaveBeenCalledWith('s1', 'auto')
  })

  it('rejects truly unsupported permissionMode on session create', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'nonexistent' }),
    })
    expect(res.status).toBe(400)
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('normalizes hooks inside create-time settings', async () => {
    const { app, sm } = makeApp()
    const hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo ok' }] }] }
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { hooks } }),
    })

    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalledWith({ settings: { hooks } }, undefined)
  })

  it('rejects unsupported hooks inside create-time settings', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { hooks: { UnknownEvent: [{ hooks: [] }] } } }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; errors: { path: string }[] }
    expect(body.error).toContain('UnknownEvent')
    expect(body.errors[0]?.path).toBe('UnknownEvent')
    expect(sm.create).not.toHaveBeenCalled()
  })
})
