// Elicitation-related routes: list pending, decide.
//
// Mirrors routes/permissions.ts. MCP elicitation requests (OAuth auth
// prompts / server-initiated forms) are parked in the session's
// elicitationPending map by the ElicitationBroker; these routes are the
// client's read + write surface. The broker resolves the SDK's awaited
// onElicitation promise with the decision handed to decide.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { createLogger } from '../log.js'
import { safeJson } from './index.js'

const log = createLogger('elicitation')

/** ElicitResult's content union (MCP SDK): string | number | boolean |
 *  string[]. Enforced here so an invalid payload 400s at the HTTP boundary
 *  instead of failing deep inside the MCP server. */
function isValidContentValue(v: unknown): boolean {
  if (typeof v === 'string') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'boolean') return true
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string')
  return false
}

export function buildElicitationRouter(sm: SessionManager): Hono {
  const app = new Hono()

  // List pending elicitation requests (used by the frontend on first load
  // to render any outstanding auth dialog before its WebSocket
  // subscription is established — mirrors GET /sessions/:id/permissions).
  app.get('/sessions/:id/elicitations', (c) => {
    const id = c.req.param('id')
    return c.json({ pending: sm.listPendingElicitation(id) })
  })

  // Decide a pending elicitation request.
  app.post('/sessions/:id/elicitations/:eid/decide', async (c) => {
    const id = c.req.param('id')
    const eid = c.req.param('eid')
    const raw = await safeJson<{ action?: unknown; content?: unknown }>(c.req)
    if (raw.action !== 'accept' && raw.action !== 'decline' && raw.action !== 'cancel') {
      return c.json({ error: "action must be 'accept', 'decline', or 'cancel'" }, 400)
    }
    let content: Record<string, unknown> | undefined
    if (raw.content !== undefined && raw.content !== null) {
      if (typeof raw.content !== 'object' || Array.isArray(raw.content)) {
        return c.json({ error: 'content must be an object' }, 400)
      }
      for (const [k, v] of Object.entries(raw.content as Record<string, unknown>)) {
        if (!isValidContentValue(v)) {
          return c.json(
            { error: `content.${k}: values must be string, number, boolean, or string[]` },
            400,
          )
        }
      }
      content = raw.content as Record<string, unknown>
    }
    log.info(`decide session=${id} eid=${eid} action=${raw.action}${content ? ` fields=${Object.keys(content).length}` : ''}`)
    sm.decideElicitation(id, eid, {
      action: raw.action,
      ...(content !== undefined ? { content } : {}),
    })
    return c.json({ ok: true })
  })

  return app
}
