// Shared error types for the server.

import type { ErrorHandler } from 'hono'
import { classifyControlError } from '../shared/control-errors.js'

export class HttpError extends Error {
  /** Optional structured response body. When set, the error handler emits
   *  this verbatim instead of `{ error: message }` — used for typed error
   *  contracts (e.g. PluginCommandError) the client branches on by field. */
  body?: unknown
  constructor(public status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.body = body
  }
}

/** Build a Hono onError handler that formats HttpError / generic errors
 *  as JSON responses. Each sub-router passes its own log prefix. */
export function createErrorHandler(prefix: string): ErrorHandler {
  return (err, c) => {
    if (err instanceof HttpError) {
      if (err.body !== undefined) return c.json(err.body, err.status as 400 | 404 | 409 | 410 | 502 | 500)
      return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 410 | 502 | 500)
    }
    console.error(`${prefix} unhandled error:`, err)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

/** Options for the SDK-control error wrappers. A named exported type (not a
 *  hand-inlined shape) so every deps interface and wiring arrow shares one
 *  definition — the unnamed variant is what let a fewer-parameter deps arrow
 *  typecheck while silently dropping the flag. */
export interface ControlWrapOpts {
  /** Attach the shared control-error taxonomy (code/title/hint) when the
   *  upstream message matches a known pattern. Opt-in per call site — see
   *  controlHttpError for why this must not be universal. */
  classify?: boolean
}

/** Wrap a raw SDK-control failure into the semantic 502 HttpError the
 *  control-call wrappers (requireHandleMethod / timeSdkControl) throw.
 *  When `opts.classify` is set AND the upstream message matches a known
 *  pattern (shared/control-errors), the response body becomes the structured
 *  `{ error: { code, message, hint } }` shape the Transport layer already
 *  parses (ApiError.code); the prose stays identical either way, so logs and
 *  callers that only read `message` see no change. Classification is
 *  opt-in on purpose: the taxonomy (npm E401, start command, …) describes
 *  MCP-server processes, and attaching it to e.g. a failed interrupt on the
 *  session subprocess would hand out nonsense advice. HttpErrors pass
 *  through untouched — never re-wrapped. */
export function controlHttpError(
  action: string,
  err: unknown,
  opts?: ControlWrapOpts,
): HttpError {
  if (err instanceof HttpError) return err
  const msg = err instanceof Error ? err.message : String(err)
  const message = `${action} failed: ${msg}`
  const info = opts?.classify ? classifyControlError(msg) : null
  if (!info) return new HttpError(502, message)
  return new HttpError(502, message, {
    error: { code: info.code, message, hint: info.hint },
  })
}
