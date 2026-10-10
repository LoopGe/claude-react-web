import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildSessionRouter } from './sessions.js'
import { HttpError, createErrorHandler } from '../errors.js'
import type { SessionManager } from '../session-manager.js'

function makeApp(overrides: { tasklistSnapshot?: (id: string) => unknown } = {}) {
  const sm = {
    tasklistSnapshot: vi.fn(async (id: string) => {
      if (overrides.tasklistSnapshot) return overrides.tasklistSnapshot(id)
      return { rev: 1, tasks: [] }
    }),
  }
  const app = new Hono()
  app.onError(createErrorHandler('[sessions-tasklist-test]'))
  app.route('/', buildSessionRouter(sm as unknown as SessionManager))
  return { app, sm }
}

describe('GET /sessions/:id/tasklist', () => {
  it('returns the derived payload', async () => {
    const { app, sm } = makeApp({ tasklistSnapshot: () => ({ rev: 2, tasks: [{ id: '1', subject: 'S', status: 'pending', stale: false }] }) })
    const res = await app.request('/sessions/s1/tasklist')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rev: 2, tasks: [{ id: '1', subject: 'S', status: 'pending', stale: false }] })
    expect(sm.tasklistSnapshot).toHaveBeenCalledWith('s1')
  })

  it('404 for an unknown session (sm.get throws)', async () => {
    const { app } = makeApp({ tasklistSnapshot: () => { throw new HttpError(404, 'session X not found') } })
    const res = await app.request('/sessions/X/tasklist')
    expect(res.status).toBe(404)
  })
})
