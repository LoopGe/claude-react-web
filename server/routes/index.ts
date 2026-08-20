// REST routes for the SessionManager.
//
// Real-time streaming (messages, permissions, context usage) is handled
// by the WebSocket layer in ws.ts, not here.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { HttpError, createErrorHandler } from '../errors.js'
import type { MpStore } from '../mp-store.js'
import { buildSessionRouter } from './sessions.js'
import { buildPermissionRouter } from './permissions.js'
import { buildElicitationRouter } from './elicitation.js'
import { buildUploadRouter } from './uploads.js'
import { buildRecapRouter } from './recap.js'
import { buildConfigRouter } from './config-routes.js'
import { buildHealthRouter } from './health-routes.js'
import { buildMpRouter } from './mp-marketplace.js'
import { buildGitWriteRouter } from './git-write.js'
import { buildUpdateRouter } from './update-routes.js'
import { buildSearchRouter } from './search.js'
import { buildSkillsRouter } from './skills.js'
import { buildHooksRouter } from './hooks.js'

/** Parse JSON body, returning 400 on malformed input instead of silently
 *  falling back to an empty object. */
export async function safeJson<T>(req: { json<T>(): Promise<T> }): Promise<T> {
  try {
    return await req.json<T>()
  } catch {
    throw new HttpError(400, 'Malformed JSON body')
  }
}

export function buildApiRouter(
  sm: SessionManager,
  configDir?: string,
  mpStore?: MpStore,
  claudeBinary?: string,
): Hono {
  const app = new Hono()

  app.onError(createErrorHandler('[api]'))

  // Health / version
  app.get('/health', (c) => c.json({ ok: true, sessions: sm.sessionCount() }))

  // Mount sub-routers in the same order as the original routes.ts
  // to preserve Hono's route-matching priority.
  app.route('/', buildHealthRouter(claudeBinary))
  app.route('/', buildConfigRouter(sm, configDir))
  app.route('/', buildSessionRouter(sm, mpStore))
  app.route('/', buildHooksRouter(sm))
  app.route('/', buildSkillsRouter(sm))
  app.route('/', buildUploadRouter(sm))
  app.route('/', buildPermissionRouter(sm))
  app.route('/', buildElicitationRouter(sm))
  app.route('/', buildRecapRouter(sm))
  app.route('/', buildSearchRouter(sm))
  // Homegrown git-repo marketplace lives under /mp/*. Only mounted when an
  // MpStore was provided — other buildApp callers (tests, standalone
  // tooling) skip it cleanly.
  if (mpStore) {
    app.route('/', buildMpRouter(sm, mpStore))
  }
  app.route('/', buildGitWriteRouter(sm))
  // Update checker — exposes GET /update-info for the in-app upgrade
  // prompt. Stateless, so no SessionManager or store dependency.
  // claudeBinary is threaded through so the About tab can surface the
  // CLI version alongside the npm-update info (single round-trip).
  app.route('/', buildUpdateRouter(claudeBinary))

  return app
}
