// Client-debug answer route — the browser's reply half of the dev-only
// `appdebug` client-debug channel. The host broadcasts a
// `client-debug-request` WS frame; the executing tab answers here. See
// shared/client-debug.ts for the op vocabulary and the security notes
// (dev-mode-only reachability; first answer wins).

import { Hono } from 'hono'
import type { SessionManager } from '../session-manager.js'
import { safeJson } from './index.js'
import type { ClientDebugAnswer } from '../../shared/client-debug.js'

/** Structural validation of the browser's answer body. `result` is
 *  deliberately unvalidated (op-specific JSON from the executor); `error`
 *  must be a string so the MCP tool's `isError` message is presentable. */
function isAnswer(body: unknown): body is ClientDebugAnswer {
  if (!body || typeof body !== 'object') return false
  const b = body as { ok?: unknown; result?: unknown; error?: unknown }
  if (b.ok === true) return 'result' in b
  if (b.ok === false) return typeof b.error === 'string'
  return false
}

export function buildClientDebugRouter(sm: SessionManager): Hono {
  const app = new Hono()

  app.post('/client-debug/:id/answer', async (c) => {
    const id = c.req.param('id')
    const raw = await safeJson<unknown>(c.req)
    if (!isAnswer(raw)) {
      return c.json(
        { error: 'answer must be { ok: true, result } or { ok: false, error: string }' },
        400,
      )
    }
    // First-answer-wins: a losing tab's answer resolves false → 404.
    if (!sm.resolveClientDebug(id, raw)) {
      return c.json({ error: `unknown or already-answered client-debug request ${id}` }, 404)
    }
    return c.json({ ok: true })
  })

  return app
}
