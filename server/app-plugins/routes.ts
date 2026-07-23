// REST routes for App Plugins, mounted at /api/app-plugins.
//
// The router is built only when an AppPluginManager was provided (see
// server/app.ts). Real-time state sync (snapshot/state/contributions) goes
// over the WebSocket app-plugin frames, not here; these endpoints cover the
// management + command-invocation surface.

import { Hono } from 'hono'
import { HttpError, createErrorHandler } from '../errors.js'
import { safeJson } from '../routes/index.js'
import type { AppPluginManager } from './app-plugin-manager.js'
import type { InstallSource } from './app-plugin-manager.js'

export function buildAppPluginRouter(manager: AppPluginManager): Hono {
  const app = new Hono()
  app.onError(createErrorHandler('[app-plugins]'))

  app.get('/', (c) => c.json({ plugins: manager.list() }))

  app.get('/:id', (c) => {
    const info = manager.get(c.req.param('id'))
    if (!info) throw new HttpError(404, 'app plugin not found')
    return c.json({ plugin: info })
  })

  app.post('/install', async (c) => {
    const body = await safeJson<{ source?: InstallSource; confirm?: boolean }>(c.req)
    if (!body.source) throw new HttpError(400, 'source is required')
    if (body.source.type !== 'local') throw new HttpError(400, 'only local-directory install is supported in v1')
    const result = await manager.install(body.source)
    return c.json({ result })
  })

  app.post('/:id/enable', async (c) => {
    await manager.enable(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/:id/disable', async (c) => {
    await manager.disable(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.delete('/:id', async (c) => {
    const body = await safeJson<{ confirm?: boolean; deleteData?: boolean }>(c.req).catch(() => ({}) as { confirm?: boolean; deleteData?: boolean })
    if (!body.confirm) throw new HttpError(400, 'uninstall requires { confirm: true }')
    await manager.uninstall(c.req.param('id'), { deleteData: !!body.deleteData })
    return c.json({ ok: true })
  })

  app.get('/:id/permissions', (c) => {
    const perms = manager.getPermissions(c.req.param('id'))
    return c.json(perms)
  })

  app.put('/:id/permissions', async (c) => {
    const body = await safeJson<{ granted?: unknown }>(c.req)
    if (!Array.isArray(body.granted)) throw new HttpError(400, 'granted must be an array')
    await manager.setPermissions(c.req.param('id'), body.granted as never)
    return c.json({ ok: true })
  })

  app.get('/:id/configuration', async (c) => {
    const config = await manager.getConfiguration(c.req.param('id'))
    return c.json({ configuration: config })
  })

  app.put('/:id/configuration', async (c) => {
    const body = await safeJson<{ values?: Record<string, unknown> }>(c.req)
    if (!body.values || typeof body.values !== 'object') throw new HttpError(400, 'values object is required')
    await manager.putConfiguration(c.req.param('id'), body.values)
    return c.json({ ok: true })
  })

  app.get('/:id/logs', (c) => {
    // B2: stream captured stderr logs. B1 returns an empty log list so the
    // management UI's logs panel renders without error.
    return c.json({ logs: [] })
  })

  app.post('/:id/commands/:commandId', async (c) => {
    const pluginId = c.req.param('id')
    const commandId = c.req.param('commandId')
    const body = await safeJson<{ context?: unknown }>(c.req)
    if (!body.context) throw new HttpError(400, 'context is required')
    const result = await manager.executeCommand({
      pluginId,
      commandId,
      context: body.context as never,
    })
    return c.json({ result })
  })

  return app
}
