// GET /api/metrics — JSON snapshot of the in-process metrics registry.
// Mounted by routes/index.ts under the api router (app.ts mounts that at
// /api), inheriting the auth gate / CORS / request-log middleware. With
// METRICS=0 the registry is disabled and this returns the empty snapshot
// shape (200, never an error).
//
// `gaugeSources` lets process-wide values that the SessionManager owns be
// DERIVED at snapshot time instead of being pushed from every mutation site
// (a per-session `pending.size` pushed into a global gauge would be
// last-writer-wins, and every future clear path would have to remember to
// update it).

import { Hono } from 'hono'
import { metrics } from '../metrics.js'
import type { MetricsSnapshot } from '../../shared/metrics.js'

export function buildMetricsRouter(gaugeSources?: Record<string, () => number>): Hono {
  const app = new Hono()
  app.get('/metrics', (c) => {
    const snap = metrics.snapshot()
    if (!gaugeSources) return c.json(snap)
    const gauges: MetricsSnapshot['gauges'] = { ...snap.gauges }
    for (const [name, get] of Object.entries(gaugeSources)) {
      gauges[name] = get()
    }
    return c.json({ ...snap, gauges })
  })
  return app
}
