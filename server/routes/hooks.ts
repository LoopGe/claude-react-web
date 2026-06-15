import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { safeJson } from './index.js'
import { formatHooksValidationErrors, validateSessionHooksConfig } from '../../shared/hooks.js'

export function buildHooksRouter(sm: SessionManager): Hono {
  const app = new Hono()

  app.get('/sessions/:id/hooks', (c) => {
    const result = sm.getHooks(c.req.param('id'))
    return c.json(result)
  })

  app.put('/sessions/:id/hooks', async (c) => {
    const body = await safeJson<{ hooks?: unknown }>(c.req)
    const parsed = validateSessionHooksConfig(body.hooks ?? {})
    if (!parsed.ok) return c.json({ error: formatHooksValidationErrors(parsed.errors), errors: parsed.errors }, 400)
    const result = await sm.applyHooks(c.req.param('id'), parsed.value)
    return c.json(result)
  })

  return app
}
