// Permission-related routes: list pending, decide, answer-question.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { safeJson } from './index.js'

export function buildPermissionRouter(sm: SessionManager): Hono {
  const app = new Hono()

  // List pending requests (used by the frontend on first load to render any
  // outstanding modal before its WebSocket subscription is established).
  app.get('/sessions/:id/permissions', (c) => {
    const id = c.req.param('id')
    return c.json({ pending: sm.listPending(id) })
  })

  // Decide a pending request.
  app.post('/sessions/:id/permissions/:pid/decide', async (c) => {
    const id = c.req.param('id')
    const pid = c.req.param('pid')
    const raw = await safeJson<{ behavior?: unknown; persistForSession?: unknown; message?: unknown }>(c.req)
    if (raw.behavior === 'allow') {
      sm.decide(id, pid, {
        behavior: 'allow',
        persistForSession: typeof raw.persistForSession === 'boolean' ? raw.persistForSession : false,
      })
      return c.json({ ok: true })
    }
    if (raw.behavior === 'deny') {
      sm.decide(id, pid, {
        behavior: 'deny',
        message: typeof raw.message === 'string' ? raw.message : undefined,
      })
      return c.json({ ok: true })
    }
    return c.json({ error: "behavior must be 'allow' or 'deny'" }, 400)
  })

  // Answer a pending AskUserQuestion.
  app.post('/sessions/:id/permissions/:pid/answer-question', async (c) => {
    const id = c.req.param('id')
    const pid = c.req.param('pid')
    const raw = await safeJson<{ answers?: unknown }>(c.req)
    if (!Array.isArray(raw.answers)) {
      return c.json({ error: 'answers must be an array' }, 400)
    }
    const answers = raw.answers.map((a) => {
      if (typeof a === 'string') return a
      if (Array.isArray(a) && a.every((x) => typeof x === 'string')) return a as string[]
      return null
    })
    sm.answerQuestion(id, pid, answers)
    return c.json({ ok: true })
  })

  return app
}
