// REST routes for the SessionManager.
//
// Real-time streaming (messages, permissions, context usage) is handled
// by the WebSocket layer in ws.ts, not here.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { HttpError, createErrorHandler } from '../errors.js'
import { isJsonContentType } from '../request-guard.js'
import type { MpStore } from '../mp-store.js'
import type { UploadStore } from '../upload-store.js'
import type { AgentDefinitionStore } from '../agent-definition-store.js'
import { buildSessionRouter } from './sessions.js'
import { buildPermissionRouter } from './permissions.js'
import { buildElicitationRouter } from './elicitation.js'
import { buildDialogRouter } from './dialog.js'
import { buildClientDebugRouter } from './client-debug.js'
import { buildUploadRouter } from './uploads.js'
import { buildRecapRouter } from './recap.js'
import { buildConfigRouter } from './config-routes.js'
import { buildDaemonRouter } from './daemon-routes.js'
import { buildProfilesRouter } from './profiles.js'
import { buildHealthRouter } from './health-routes.js'
import { buildMpRouter } from './mp-marketplace.js'
import { buildGitWriteRouter } from './git-write.js'
import { buildUpdateRouter } from './update-routes.js'
import { buildSearchRouter } from './search.js'
import { buildSkillsRouter } from './skills.js'
import { buildHooksRouter } from './hooks.js'
import { buildDiagnosticsRouter } from './diagnostics.js'
import { buildStructuredRouter } from './structured.js'
import { buildFirstPartyRouter } from './first-party.js'
import { buildOpenPathRouter } from './open-path.js'
import { ScheduledSendManager } from '../scheduled-send-manager.js'
import { buildScheduledSendRouter } from './scheduled-sends.js'
import { buildMetricsRouter } from './metrics.js'

/** Minimal request surface the JSON helpers need. Hono's `c.req` satisfies it. */
export interface JsonBodyReader {
  json<T>(): Promise<T>
  header(name: string): string | undefined
}

/** Parse a JSON body of ANY shape and return it as T. Malformed input is a 400
 *  rather than a silent fallback to `{}`; nothing else is validated — use
 *  safeJson when the handler needs an object.
 *
 *  The body MUST be declared `Content-Type: application/json` (charset
 *  optional), else 415. This is the CSRF choke point for JSON writes: a
 *  cross-site page can only send text/plain / form bodies without a CORS
 *  preflight, so refusing them here covers every JSON-body route at once.
 *  Multipart upload routes never call this helper. */
export async function safeJsonValue<T>(req: JsonBodyReader): Promise<T> {
  if (!isJsonContentType(req.header('content-type'))) {
    throw new HttpError(415, 'Content-Type must be application/json')
  }
  try {
    return await req.json<T>()
  } catch {
    throw new HttpError(400, 'Malformed JSON body')
  }
}

/** Parse a JSON body that MUST be an object.
 *
 *  The type parameter is an assertion, not a check: a JSON `null` parses fine
 *  and comes back as null, so a handler reading `body.field` off it threw a
 *  TypeError and answered an opaque 500 — and a JSON array/array-of-anything
 *  sailed past per-field guards into a bogus 200. Validating here covers every
 *  endpoint at once instead of a hand-rolled copy in each one (they had already
 *  grown to 14 in 4 different spellings, one omitting the array check).
 *
 *  Use safeJsonValue for a body that may legitimately be a non-object —
 *  POST /sessions/:id/sandbox takes a literal `null` to clear the setting.
 *  Same Content-Type rule as safeJsonValue (415 when not application/json). */
export async function safeJson<T>(req: JsonBodyReader): Promise<T> {
  const value = await safeJsonValue<unknown>(req)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Body must be a JSON object')
  }
  return value as T
}

/** Optional JSON-object body for routes whose body is all-optional flags
 *  (resume, fork, uninstall, marketplace remove). Callers used to wrap
 *  safeJson in `.catch(() => fallback)`, which also swallowed the 415 — a
 *  declared text/plain body was silently read as "no body".
 *
 *  - No Content-Type → `fallback` (a body-less POST/DELETE; any body bytes are
 *    ignored, so an untyped cross-site body can't set a flag either).
 *  - Declared non-JSON Content-Type → 415, same as safeJson.
 *  - Malformed JSON / non-object → `fallback` (the historical lenience). */
export async function safeJsonOptional<T>(req: JsonBodyReader, fallback: T): Promise<T> {
  if (!req.header('content-type')) return fallback
  return safeJson<T>(req).catch((err: unknown) => {
    if (err instanceof HttpError && err.status === 415) throw err
    return fallback
  })
}

export function buildApiRouter(
  sm: SessionManager,
  configDir?: string,
  mpStore?: MpStore,
  claudeBinary?: string,
  uploadStore?: UploadStore,
  agentDefinitionStore?: AgentDefinitionStore,
): Hono {
  const app = new Hono()

  app.onError(createErrorHandler('[api]'))

  // Scheduled sends: in-memory manager whose `send` delegate routes through
  // the same sm.send/sendContent as POST /messages. Session deletion is
  // observed via the global removed feed and drops that session's schedules.
  const scheduledSends = new ScheduledSendManager({
    send: (sessionId, body) => {
      const sent =
        'content' in body
          ? sm.sendContent(sessionId, body.content as Array<{ type: string; [k: string]: unknown }>)
          : sm.send(sessionId, body.text)
      return { uuid: sent.uuid }
    },
    subscribeGlobal: () => sm.subscribeGlobal(),
  })
  app.route('/', buildScheduledSendRouter(sm, scheduledSends))

  // Health / version
  app.get('/health', (c) => c.json({ ok: true, sessions: sm.sessionCount() }))

  // Mount sub-routers in the same order as the original routes.ts
  // to preserve Hono's route-matching priority.
  app.route('/', buildHealthRouter(claudeBinary))
  app.route('/', buildMetricsRouter({
    // Derived at read time — see buildMetricsRouter's doc comment.
    permissions_pending: () => sm.totalPendingPermissions(),
  }))
  app.route('/', buildConfigRouter(sm, configDir))
  // Daemon auto-start — needs the state dir for the <stateDir>/daemon/* control
  // files; configDir IS the state dir (the same value buildConfigRouter writes).
  // Only mounted when a configDir was provided — other buildApp callers (tests,
  // standalone tooling) skip it cleanly, same as the mpStore router below.
  if (configDir) {
    app.route('/', buildDaemonRouter(configDir))
  }
  app.route('/', buildProfilesRouter(configDir, sm))
  app.route('/', buildSessionRouter(sm, mpStore, agentDefinitionStore, configDir))
  app.route('/', buildHooksRouter(sm))
  app.route('/', buildSkillsRouter(sm))
  app.route('/', buildDiagnosticsRouter(sm))
  app.route('/', buildUploadRouter(sm, uploadStore))
  app.route('/', buildPermissionRouter(sm))
  app.route('/', buildElicitationRouter(sm))
  app.route('/', buildDialogRouter(sm))
  app.route('/', buildClientDebugRouter(sm))
  app.route('/', buildRecapRouter(sm))
  app.route('/', buildSearchRouter(sm))
  app.route('/', buildStructuredRouter(sm))
  app.route('/', buildOpenPathRouter())
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
  // Static first-party tool-server listing (GET /first-party-tools) — the
  // in-process analog of the normal MCP "List tools" probe. Stateless, like
  // the update router: serves the code-registered registry directly.
  app.route('/', buildFirstPartyRouter())

  return app
}
