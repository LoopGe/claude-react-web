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

describe('session handoff cancel route', () => {
  function makeCancelApp(opts: { exists?: boolean; cancelled?: boolean }) {
    const sm = {
      get: vi.fn(() => {
        if (opts.exists === false) throw new HttpError(404, 'unknown session')
        return {}
      }),
      cancelHandoff: vi.fn(() => opts.cancelled ?? false),
    }
    const app = new Hono()
    app.onError(createErrorHandler('[sessions-handoff-cancel-test]'))
    app.route('/', buildSessionRouter(sm as unknown as SessionManager))
    return { app, sm }
  }

  it('reports cancelled:true when the summarize window was aborted', async () => {
    const { app, sm } = makeCancelApp({ cancelled: true })
    const res = await app.request('/sessions/X/handoff/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, cancelled: true })
    expect(sm.cancelHandoff).toHaveBeenCalledWith('X')
  })

  it('reports cancelled:false outside the summarize window (idempotent no-op)', async () => {
    const { app } = makeCancelApp({ cancelled: false })
    const res = await app.request('/sessions/X/handoff/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, cancelled: false })
  })

  it('404 for an unknown session', async () => {
    const { app } = makeCancelApp({ exists: false })
    const res = await app.request('/sessions/ghost/handoff/cancel', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
