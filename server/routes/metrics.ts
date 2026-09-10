// GET /api/metrics — JSON snapshot of the in-process metrics registry.
// Mounted by routes/index.ts under the api router (app.ts mounts that at
// /api), inheriting the auth gate / CORS / request-log middleware. With
// METRICS=0 the registry is disabled and this returns the empty snapshot
// shape (200, never an error).

import { Hono } from 'hono'
import { metrics } from '../metrics.js'

export function buildMetricsRouter(): Hono {
  const app = new Hono()
  app.get('/metrics', (c) => c.json(metrics.snapshot()))
  return app
}
