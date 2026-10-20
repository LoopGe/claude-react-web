// REST surface for daemon auto-start. Thin by design: all semantics live in
// daemon/ops.ts; the stop route is the one place the HTTP layer touches the
// daemon protocol (marker) and the shutdown seam directly.
import { Hono } from 'hono'
import { daemonStatus, daemonEnable, daemonDisable, daemonRequestStart } from '../daemon/ops.js'
import { requestStop } from '../daemon/server-bridge.js'
import { requestShutdown } from '../daemon/shutdown-request.js'

export function buildDaemonRouter(stateDir: string): Hono {
  const app = new Hono()

  app.get('/daemon/status', async (c) => c.json(await daemonStatus(stateDir)))

  app.post('/daemon/enable', async (c) => c.json(await daemonEnable(stateDir)))
  app.post('/daemon/disable', async (c) => c.json(await daemonDisable(stateDir)))

  app.post('/daemon/start', async (c) => {
    const { started } = await daemonRequestStart(stateDir)
    return c.json({ ok: true, started })
  })

  app.post('/daemon/stop', async (c) => {
    // Marker first (daemon children only — a manually-started server must not
    // leave an orphan marker behind), then the SAME graceful shutdown SIGTERM
    // takes, delayed just long enough for this response to flush.
    await requestStop(stateDir)
    setTimeout(() => { void requestShutdown() }, 100)
    return c.json({ ok: true, stopping: true })
  })

  return app
}
