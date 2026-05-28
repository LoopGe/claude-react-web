// Update-info route. Reads the cached UpdateInfo from update-checker.ts
// and (optionally) triggers a fresh probe.
//
// `GET /api/update-info`         — returns the cached snapshot. If we have
//                                  never queried npm before, kicks off a
//                                  background probe and returns
//                                  `{ checking: true }` on top of the
//                                  current-version-only snapshot. The
//                                  client polls or just refreshes manually.
// `GET /api/update-info?force=1` — awaits a fresh probe and returns the
//                                  result (still capped at the
//                                  update-checker's 5s fetch timeout).

import { Hono } from 'hono'
import { checkForUpdates, getCachedUpdateInfo } from '../update-checker.js'

export function buildUpdateRouter(): Hono {
  const app = new Hono()

  app.get('/update-info', async (c) => {
    const force = c.req.query('force') === '1'
    if (force) {
      const info = await checkForUpdates(true)
      return c.json(info)
    }
    const cached = getCachedUpdateInfo()
    if (cached.checkedAt) {
      // We already have a snapshot — return it without blocking on the
      // network. The cache layer in update-checker.ts decides when the
      // next refresh happens.
      return c.json(cached)
    }
    // No probe has completed yet (CLI just started, or the first probe
    // was rejected with an error and the snapshot was reset). Kick off
    // a background fetch but don't block this request — we want the UI
    // to feel snappy on first load. The next GET will see the result.
    void checkForUpdates().catch(() => {
      /* errors land in the cached snapshot via update-checker's
       * try/catch — nothing to do here. */
    })
    return c.json({ ...cached, checking: true })
  })

  return app
}
