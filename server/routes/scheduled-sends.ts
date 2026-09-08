// Scheduled-send REST routes — per-session, thin over ScheduledSendManager.
// Body validation is shared with POST /sessions/:id/messages (validateSendBody).

import { Hono } from 'hono'
import type { SessionManager } from '../session-manager.js'
import type { ScheduledSendManager } from '../scheduled-send-manager.js'
import { validateSendBody } from '../send-body.js'
import { safeJson } from './index.js'

export function buildScheduledSendRouter(
  sm: Pick<SessionManager, 'get'>,
  manager: ScheduledSendManager,
): Hono {
  const app = new Hono()

  app.post('/sessions/:id/schedules', async (c) => {
    const id = c.req.param('id')
    sm.get(id) // throws 404 for unknown sessions
    const body = await safeJson<{ fireAt?: unknown; text?: unknown; content?: unknown }>(c.req)
    const v = validateSendBody(body)
    if (!v.ok) return c.json({ error: v.error }, v.status)
    if (typeof body.fireAt !== 'number') {
      return c.json({ error: 'fireAt is required (epoch ms)' }, 400)
    }
    const schedule = manager.create(id, v.body, body.fireAt)
    return c.json({ schedule }, 201)
  })

  app.get('/sessions/:id/schedules', async (c) => {
    const id = c.req.param('id')
    sm.get(id) // throws 404 for unknown sessions
    return c.json({ schedules: manager.list(id) })
  })

  app.delete('/sessions/:id/schedules/:scheduleId', async (c) => {
    const id = c.req.param('id')
    const scheduleId = c.req.param('scheduleId')
    manager.remove(id, scheduleId) // throws 404 for unknown ids
    return c.body(null, 204)
  })

  return app
}
