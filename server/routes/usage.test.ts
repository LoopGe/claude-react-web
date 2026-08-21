import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    usage: vi.fn(async () => ({
      session: { total_cost_usd: 0.0123 },
      subscription_type: null,
      rate_limits_available: false,
    })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

describe('session usage route', () => {
  it('passes the session id through to sm.usage and wraps the payload', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/usage')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { usage: { session?: { total_cost_usd?: number } } }
    expect(body.usage.session?.total_cost_usd).toBe(0.0123)
    expect(sm.usage).toHaveBeenCalledWith('s1')
  })
})
