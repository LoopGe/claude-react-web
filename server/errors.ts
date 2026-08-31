// Shared error types for the server.

import type { ErrorHandler } from 'hono'

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
