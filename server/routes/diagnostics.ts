import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { safeJson } from './index.js'

export function buildDiagnosticsRouter(sm: SessionManager): Hono {
  const app = new Hono()

  app.get('/sessions/:id/diagnostics', async (c) => {
    return c.json(await sm.getDiagnostics(c.req.param('id')))
  })

  app.put('/sessions/:id/diagnostics', async (c) => {
    const body = await safeJson<{ cliDebug?: boolean | null }>(c.req)
    return c.json(await sm.setCliDebug(c.req.param('id'), body ?? {}))
  })

  return app
}