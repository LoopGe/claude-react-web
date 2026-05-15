// REST routes for global MCP server configuration management.
//
// Mounted at /api/mcp-config by app.ts. Provides CRUD operations for
// persistent MCP server configs stored in ~/.claude-react-web/mcp-config.json.
// Secrets (env vars, headers) are never returned to the client — only
// key names are exposed via the maskSecrets helper.

import { Hono } from 'hono'
import {
  McpConfigStore,
  maskSecrets,
  validateMcpServer,
  type StoredMcpServer,
  type McpServerInput,
} from './mcp-config.js'
import { HttpError } from './errors.js'

export function buildMcpConfigRouter(store: McpConfigStore): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 410 | 500)
    }
    console.error('[mcp-config] unhandled error:', err)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  })

  // List all servers (secrets masked)
  app.get('/', (c) => {
    const servers = store.list().map(maskSecrets)
    return c.json({ servers })
  })

  // Get one server (secrets masked)
  app.get('/:name', (c) => {
    const name = c.req.param('name')
    const server = store.get(name)
    if (!server) throw new HttpError(404, `MCP server "${name}" not found`)
    return c.json({ server: maskSecrets(server) })
  })

  // Create a new server
  app.post('/', async (c) => {
    const body = await c.req.json<McpServerInput>().catch(() => {
      throw new HttpError(400, 'Invalid JSON body')
    })
    if (!body.name || !body.name.trim()) throw new HttpError(400, 'name is required')
    if (store.get(body.name.trim())) throw new HttpError(409, `MCP server "${body.name}" already exists; use PUT to update`)

    const errors = validateMcpServer(body)
    if (errors.length > 0) throw new HttpError(400, errors.join('; '))

    const now = Date.now()
    const server: StoredMcpServer = {
      name: body.name.trim(),
      type: body.type ?? 'stdio',
      command: body.command,
      args: body.args,
      env: body.env,
      url: body.url,
      headers: body.headers,
      alwaysLoad: body.alwaysLoad,
      enabled: body.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    }
    store.upsert(server)
    return c.json({ server: maskSecrets(server) }, 201)
  })

  // Update an existing server (env/headers merge, not replace)
  app.put('/:name', async (c) => {
    const name = c.req.param('name')
    const existing = store.get(name)
    if (!existing) throw new HttpError(404, `MCP server "${name}" not found`)

    const body = await c.req.json<Partial<McpServerInput>>().catch(() => {
      throw new HttpError(400, 'Invalid JSON body')
    })

    // Merge fields — env/headers are merged (not replaced) to prevent
    // accidental secret deletion when the user only wanted to change args.
    const updated: StoredMcpServer = {
      ...existing,
      type: body.type ?? existing.type,
      updatedAt: Date.now(),
    }
    if (body.command !== undefined) updated.command = body.command
    if (body.args !== undefined) updated.args = body.args
    if (body.url !== undefined) updated.url = body.url
    if (body.alwaysLoad !== undefined) updated.alwaysLoad = body.alwaysLoad
    if (body.enabled !== undefined) updated.enabled = body.enabled

    // Merge env: new keys added, existing keys kept unless overwritten
    if (body.env) {
      updated.env = { ...(existing.env ?? {}), ...body.env }
    }
    // Merge headers: same strategy
    if (body.headers) {
      updated.headers = { ...(existing.headers ?? {}), ...body.headers }
    }

    const errors = validateMcpServer(updated)
    if (errors.length > 0) throw new HttpError(400, errors.join('; '))

    store.upsert(updated)
    return c.json({ server: maskSecrets(updated) })
  })

  // Delete a server
  app.delete('/:name', (c) => {
    const name = c.req.param('name')
    if (!store.get(name)) throw new HttpError(404, `MCP server "${name}" not found`)
    store.remove(name)
    return c.json({ ok: true })
  })

  // Toggle enabled/disabled
  app.post('/:name/toggle', async (c) => {
    const name = c.req.param('name')
    const existing = store.get(name)
    if (!existing) throw new HttpError(404, `MCP server "${name}" not found`)

    const body = await c.req.json<{ enabled: boolean }>().catch(() => {
      throw new HttpError(400, 'Invalid JSON body')
    })
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean')

    const updated: StoredMcpServer = { ...existing, enabled: body.enabled, updatedAt: Date.now() }
    store.upsert(updated)
    return c.json({ server: maskSecrets(updated) })
  })

  // Validate a server config (schema check only, no connection test)
  app.post('/validate', async (c) => {
    const body = await c.req.json<Partial<StoredMcpServer>>().catch(() => {
      throw new HttpError(400, 'Invalid JSON body')
    })
    const errors = validateMcpServer(body)
    return c.json({ valid: errors.length === 0, errors })
  })

  return app
}
