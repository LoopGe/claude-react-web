// Shared error types for the server.

import type { ErrorHandler } from 'hono'

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Build a Hono onError handler that formats HttpError / generic errors
 *  as JSON responses. Each sub-router passes its own log prefix. */
export function createErrorHandler(prefix: string): ErrorHandler {
  return (err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 410 | 500)
    }
    console.error(`${prefix} unhandled error:`, err)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}
