// REST routes for the SessionManager.
//
// Real-time streaming (messages, permissions, context usage) is handled
// by the WebSocket layer in ws.ts, not here.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { HttpError } from '../errors.js'
import { buildSessionRouter } from './sessions.js'
import { buildPermissionRouter } from './permissions.js'
import { buildUploadRouter } from './uploads.js'
import { buildRecapRouter } from './recap.js'
import { buildConfigRouter } from './config-routes.js'
import { buildMarketplaceRouter } from './marketplace.js'

/** Parse JSON body, returning 400 on malformed input instead of silently
 *  falling back to an empty object. */
export async function safeJson<T>(req: { json<T>(): Promise<T> }): Promise<T> {
  try {
    return await req.json<T>()
  } catch {
    throw new HttpError(400, 'Malformed JSON body')
  }
}

export function buildApiRouter(sm: SessionManager, configDir?: string): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 410 | 500)
    }
    console.error('[api] unhandled error:', err)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  })

  // Health / version
  app.get('/health', (c) => c.json({ ok: true, sessions: sm.list().length }))

  // Mount sub-routers in the same order as the original routes.ts
  // to preserve Hono's route-matching priority.
  app.route('/', buildConfigRouter(sm, configDir))
  app.route('/', buildSessionRouter(sm))
  app.route('/', buildUploadRouter(sm))
  app.route('/', buildPermissionRouter(sm))
  app.route('/', buildRecapRouter(sm))
  app.route('/', buildMarketplaceRouter())

  return app
}
