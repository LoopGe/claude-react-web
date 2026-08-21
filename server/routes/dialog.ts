// User-dialog routes: list pending, decide.
//
// Mirrors routes/elicitation.ts. User dialogs (blocking CLI prompts, e.g.
// the refusal-fallback dialog) are parked in the session's dialogPending map
// by the DialogBroker; these routes are the client's read + write surface.
// The broker resolves the SDK's awaited onUserDialog promise with the
// decision handed to decide.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { createLogger } from '../log.js'
import { safeJson } from './index.js'
import { REFUSAL_FALLBACK_RESULTS, SUPPORTED_DIALOG_KINDS } from '../../shared/user-dialog.js'

const log = createLogger('dialog')

export function buildDialogRouter(sm: SessionManager): Hono {
  const app = new Hono()

  // List pending user dialogs (used by the frontend on first load to render
  // any outstanding dialog before its WebSocket subscription is established
  // — mirrors GET /sessions/:id/elicitations).
  app.get('/sessions/:id/dialogs', (c) => {
    const id = c.req.param('id')
    return c.json({ pending: sm.listPendingDialogs(id) })
  })

  // Decide a pending user dialog.
  app.post('/sessions/:id/dialogs/:did/decide', async (c) => {
    const id = c.req.param('id')
    const did = c.req.param('did')
    const raw = await safeJson<{ behavior?: unknown; result?: unknown }>(c.req)
    if (raw.behavior !== 'completed' && raw.behavior !== 'cancelled') {
      return c.json({ error: "behavior must be 'completed' or 'cancelled'" }, 400)
    }
    if (raw.behavior === 'cancelled') {
      if (raw.result !== undefined) {
        return c.json({ error: 'result must be absent when behavior is cancelled' }, 400)
      }
      log.info(`decide session=${id} did=${did} behavior=cancelled`)
      sm.decideDialog(id, did, { behavior: 'cancelled' })
      return c.json({ ok: true })
    }
    // 'completed': the SDK contract requires a result. For the known
    // refusal_fallback_prompt kind the CLI's zod enum must hold; anything
    // else makes its safeParse fall back to 'cancelled' server-side anyway,
    // so rejecting here gives the client an actionable 400 instead.
    if (raw.result === undefined || raw.result === null) {
      return c.json({ error: 'result is required when behavior is completed' }, 400)
    }
    const pending = sm.listPendingDialogs(id).find((d) => d.id === did)
    if (
      pending &&
      SUPPORTED_DIALOG_KINDS.includes(pending.dialogKind) &&
      pending.dialogKind === 'refusal_fallback_prompt' &&
      !REFUSAL_FALLBACK_RESULTS.includes(String(raw.result))
    ) {
      return c.json(
        { error: `result must be one of: ${REFUSAL_FALLBACK_RESULTS.join(', ')}` },
        400,
      )
    }
    log.info(`decide session=${id} did=${did} behavior=completed result=${String(raw.result)}`)
    sm.decideDialog(id, did, {
      behavior: 'completed',
      result: raw.result,
    })
    return c.json({ ok: true })
  })

  return app
}
