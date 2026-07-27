// REST routes for App Plugins, mounted at /api/app-plugins.
//
// The router is built only when an AppPluginManager was provided (see
// server/app.ts). Real-time state sync (snapshot/state/contributions) goes
// over the WebSocket app-plugin frames, not here; these endpoints cover the
// management + command-invocation surface.

import { Hono } from 'hono'
import { promises as fs } from 'node:fs'
import { resolve as resolvePath, extname } from 'node:path'
import { HttpError, createErrorHandler } from '../errors.js'
import { safeJson } from '../routes/index.js'
import { validateRelativePath, isPathInside } from '../../shared/app-plugins/path-security.js'
import type { AppPluginManager } from './app-plugin-manager.js'
import type { InstallSource } from './app-plugin-manager.js'

const ASSET_MAX_BYTES = 1024 * 1024 // 1 MB
const ASSET_MIMES: Record<string, string> = {
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

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

  // Static asset serving for plugin-supplied images (status indicators, etc.).
  // Path-containment-checked: the asset must be inside the plugin's install dir.
  app.get('/:id/assets/*', async (c) => {
    const id = c.req.param('id')
    const info = manager.get(id)
    if (!info) throw new HttpError(404, 'app plugin not found')
    // The plugin's install dir is record.source.path (the manager stores it).
    const record = manager.getRecord(id)
    if (!record) throw new HttpError(404, 'app plugin record not found')
    const pluginDir = record.source.path
    // Extract the asset path from the URL (everything after /assets/).
    const assetPath = c.req.path.replace(/^\/[^/]+\/assets\//, '')
    if (!assetPath) throw new HttpError(400, 'asset path is required')
    const pErr = validateRelativePath(assetPath, { isWindows: process.platform === 'win32' })
    if (pErr) throw new HttpError(400, `invalid asset path: ${pErr}`)
    const ext = extname(assetPath).toLowerCase()
    const mime = ASSET_MIMES[ext]
    if (!mime) throw new HttpError(400, `unsupported asset type: ${ext || '(none)'}`)
    const target = resolvePath(pluginDir, assetPath)
    // realpath both sides + containment check (symlink escape defense).
    const realTarget = await fs.realpath(target).catch(() => { throw new HttpError(404, 'asset not found') })
    const realPluginDir = await fs.realpath(pluginDir).catch(() => pluginDir)
    if (!isPathInside(realTarget, realPluginDir, { isWindows: process.platform === 'win32' })) {
      throw new HttpError(400, 'asset path escapes the plugin directory')
    }
    const stat = await fs.stat(realTarget).catch(() => { throw new HttpError(404, 'asset not found') })
    if (!stat.isFile()) throw new HttpError(400, 'asset is not a file')
    if (stat.size > ASSET_MAX_BYTES) throw new HttpError(413, `asset exceeds ${ASSET_MAX_BYTES} bytes`)
    const body = await fs.readFile(realTarget)
    return c.body(body, 200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
  })

  return app
}
