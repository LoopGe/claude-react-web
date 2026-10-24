import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildSessionRouter } from './sessions.js'
import { HttpError, createErrorHandler } from '../errors.js'
import type { SessionManager } from '../session-manager.js'

function makeApp(handoff?: () => unknown) {
  const sm = {
    compact: vi.fn(async () => (handoff ? handoff() : {})),
  }
  const app = new Hono()
  app.onError(createErrorHandler('[sessions-handoff-test]'))
  app.route('/', buildSessionRouter(sm as unknown as SessionManager))
  return { app, sm }
}

describe('session handoff route', () => {
  it('returns the continuation session info for POST /handoff', async () => {
    const continuation = { id: 'Y', title: 'handed-off continuation' }
    const { app, sm } = makeApp(() => continuation)
    const res = await app.request('/sessions/X/handoff', { method: 'POST' })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, session: continuation })
    expect(sm.compact).toHaveBeenCalledWith('X', { handoff: true })
  })

  it('404 for an unknown session', async () => {
    const { app } = makeApp(() => {
      throw new HttpError(404, 'unknown session')
    })
    const res = await app.request('/sessions/ghost/handoff', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('409 when the session is working (mid-turn)', async () => {
    const { app } = makeApp(() => {
      throw new HttpError(409, 'session is working')
    })
    const res = await app.request('/sessions/X/handoff', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('410 for a terminated session', async () => {
    const { app } = makeApp(() => {
      throw new HttpError(410, 'session is terminated')
    })
    const res = await app.request('/sessions/X/handoff', { method: 'POST' })
    expect(res.status).toBe(410)
  })
})
