// Session recap route — phase-checked RPC.
//
// The HTTP route is now a thin wrapper around `recapManager.requestGenerate`.
// The manager owns the lifecycle, in-flight dedup, and broadcast; this
// route's only jobs are:
//   1. Translate request → manager call
//   2. Surface the manager's HttpError throws (404/409/410/412) so the
//      client can distinguish "still working" from "dormant" from "gone"
//      without re-deriving phase from primitives.
//   3. Return the resulting SessionRecap as JSON for callers that don't
//      subscribe to the WS channel (and as a fallback for the same call's
//      own client when the broadcast lands after the HTTP response).
//
// Recap is not a synthetic message in the transcript any more — clients
// render it from `session.recap` (live updates ride the
// `session-recap-update` WS frame). We do NOT splice anything into the
// session history here.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'

export function buildRecapRouter(sm: SessionManager): Hono {
  const app = new Hono()

  app.post('/sessions/:id/recap', async (c) => {
    const id = c.req.param('id')
    // requestGenerate throws HttpError(404/409/410/412) for the
    // unrecoverable phases — the global onError hook in buildApiRouter
    // translates those into the matching HTTP responses. The client gates
    // on phase before firing, so a 409 here means a race (the user
    // started a turn between the client's gate and the server's check).
    const recap = await sm.recapManager.requestGenerate(id)
    return c.json(recap)
  })

  return app
}
