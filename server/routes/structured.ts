// One-shot structured-output route (SDK Options.outputFormat / JSON-schema).
//
// Deliberately session-agnostic: unlike the /sessions/* routes there is no
// SessionMeta, no resident, no history ring, no WS broadcast. This just
// validates a request, runs a fresh headless query to a terminal `result`
// frame, and returns the parsed JSON (or a narrowed error). Client cancel
// (disconnect) and a server timeout both abort the subprocess via an
// AbortSignal threaded down to the provider.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { HttpError } from '../errors.js'
import { createLogger } from '../log.js'
import { safeJson } from './index.js'
import type { StructuredPermissionMode, StructuredRunRequest } from '../../shared/structured.js'

const log = createLogger('structured')

/** Hard cap on concurrent structured runs — each spawns a CLI subprocess, so
 *  an unbounded spike would exhaust the machine. */
const MAX_CONCURRENT = 4
/** Default wall-clock timeout per run (matches a generous max-turns run). On
 *  expiry the subprocess is aborted and the client gets a 408. */
const TIMEOUT_MS = 120_000

const PERMISSION_MODES = new Set<StructuredPermissionMode>([
  'default', 'acceptEdits', 'bypassPermissions', 'dontAsk',
])

let active = 0

/** Validate + normalize a parsed body into StructuredRunRequest, throwing 400
 *  HttpError on any malformed field. */
function validateBody(body: unknown): StructuredRunRequest {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'body must be an object')
  const b = body as Record<string, unknown>
  const out: StructuredRunRequest = {} as StructuredRunRequest
  if (typeof b.prompt !== 'string' || !b.prompt.trim()) throw new HttpError(400, 'prompt (non-empty string) is required')
  const schema = b.schema
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new HttpError(400, 'schema must be a JSON-schema object')
  }
  out.prompt = b.prompt
  out.schema = schema as Record<string, unknown>
  if (b.cwd !== undefined) {
    if (typeof b.cwd !== 'string' || !b.cwd) throw new HttpError(400, 'cwd must be a non-empty string')
    out.cwd = b.cwd
  }
  if (b.model !== undefined) {
    if (typeof b.model !== 'string' || !b.model.trim()) throw new HttpError(400, 'model must be a non-empty string')
    out.model = b.model
  }
  for (const key of ['maxTurns', 'maxBudgetUsd'] as const) {
    if (b[key] !== undefined) {
      if (typeof b[key] !== 'number' || !Number.isFinite(b[key]) || b[key] <= 0) {
        throw new HttpError(400, `${key} must be a positive number`)
      }
      ;(out as unknown as Record<string, number>)[key] = b[key]
    }
  }
  if (b.permissionMode !== undefined) {
    if (typeof b.permissionMode !== 'string' || !PERMISSION_MODES.has(b.permissionMode as StructuredPermissionMode)) {
      throw new HttpError(400, `permissionMode must be one of: ${[...PERMISSION_MODES].join(', ')}`)
    }
    out.permissionMode = b.permissionMode as StructuredPermissionMode
  }
  return out
}

export function buildStructuredRouter(sm: SessionManager, opts: { timeoutMs?: number } = {}): Hono {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const app = new Hono()

  app.post('/structured', async (c) => {
    const req = validateBody(await safeJson(c.req))

    if (active >= MAX_CONCURRENT) {
      throw new HttpError(429, `too many concurrent structured runs (max ${MAX_CONCURRENT})`)
    }
    active++

    const controller = new AbortController()
    // Client cancel: teardown the subprocess when the connection closes.
    const reqSignal = c.req.raw.signal
    if (reqSignal.aborted) controller.abort()
    else reqSignal.addEventListener('abort', () => controller.abort(), { once: true })
    // Server timeout: same teardown, then surface a distinct 408.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        controller.abort()
        rej(new HttpError(408, 'structured run timed out'))
      }, timeoutMs)
    })

    try {
      const run = sm.runStructured(req, { signal: controller.signal })
      log.info(`structured run start prompt=${req.prompt.length}ch schema=${JSON.stringify(req.schema).length}ch`)
      const result = await Promise.race([run, timeout])
      log.info(`structured run done ok=${result.ok}`)
      return c.json(result)
    } finally {
      if (timer) clearTimeout(timer)
      active--
    }
  })

  return app
}