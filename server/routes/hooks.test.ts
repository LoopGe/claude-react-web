import { describe, expect, it, vi } from 'vitest'
import { buildHooksRouter } from './hooks.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    getHooks: vi.fn(() => ({ hooks: {}, runs: [] })),
    applyHooks: vi.fn(async (_id: string, hooks: unknown) => ({ session: { id: 's1' }, hooks })),
  }
  return { app: buildHooksRouter(sm as unknown as SessionManager), sm }
}

describe('hooks routes', () => {
  it('returns current hooks and runs', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/hooks')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hooks: {}, runs: [] })
    expect(sm.getHooks).toHaveBeenCalledWith('s1')
  })

  it('validates and applies supported hooks', async () => {
    const { app, sm } = makeApp()
    const hooks = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ok' }] }],
    }
    const res = await app.request('/sessions/s1/hooks', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hooks }),
    })

    expect(res.status).toBe(200)
    expect(sm.applyHooks).toHaveBeenCalledWith('s1', hooks)
  })

  it('rejects unsupported hook events', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/hooks', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hooks: { UnknownEvent: [{ hooks: [] }] } }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; errors: { path: string }[] }
    expect(body.error).toContain('UnknownEvent')
    expect(body.errors[0]?.path).toBe('UnknownEvent')
    expect(sm.applyHooks).not.toHaveBeenCalled()
  })
})
