import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

// The route only normalizes the body shape — existence / enabled-ness lives in
// SessionManager.setAgent (shared with create via agentUnusableReason), so a
// store stub isn't needed here. That validation is covered by the
// `setAgent (mid-session persona switch)` suite in session-manager.test.ts.
function makeApp() {
  const sm = {
    setAgent: vi.fn(async (_id: string, name: string | null) => ({ id: 's1', agent: name ?? undefined })),
  }
  const app = buildSessionRouter(sm as unknown as SessionManager)
  return { app, sm }
}

function post(app: ReturnType<typeof makeApp>['app'], body: unknown) {
  return app.request('/sessions/s1/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /sessions/:id/agent', () => {
  it('forwards a name and echoes the updated session', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, { agent: 'reviewer' })
    expect(res.status).toBe(200)
    expect(sm.setAgent).toHaveBeenCalledWith('s1', 'reviewer')
    expect(await res.json()).toEqual({ session: { id: 's1', agent: 'reviewer' } })
  })

  it('trims the name before forwarding', async () => {
    const { app, sm } = makeApp()
    await post(app, { agent: '  reviewer  ' })
    expect(sm.setAgent).toHaveBeenCalledWith('s1', 'reviewer')
  })

  it('treats null, an absent key, and a blank string as "clear"', async () => {
    const { app, sm } = makeApp()
    for (const body of [{ agent: null }, {}, { agent: '' }, { agent: '   ' }]) {
      sm.setAgent.mockClear()
      const res = await post(app, body)
      expect(res.status).toBe(200)
      // Blank must NOT reach the manager as '' — agentUnusableReason would
      // 400 with a confusing `agent "" is not defined`.
      expect(sm.setAgent).toHaveBeenCalledWith('s1', null)
    }
  })

  it('400s on a non-string, non-null agent without touching the manager', async () => {
    const { app, sm } = makeApp()
    for (const body of [{ agent: 42 }, { agent: ['reviewer'] }, { agent: { name: 'reviewer' } }, { agent: true }]) {
      sm.setAgent.mockClear()
      const res = await post(app, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'agent must be a string or null' })
      expect(sm.setAgent).not.toHaveBeenCalled()
    }
  })
})
