// REST routes for global MCP server configuration management.
//
// Mounted at /api/mcp-config by app.ts. Provides CRUD operations for
// persistent MCP server configs stored in ~/.claude-react-web/mcp-config.json.
// Secrets (env vars, headers) are never returned to the client — only
// key names are exposed via the maskSecrets helper.

import { Hono } from 'hono'
import {
  McpConfigStore,
  clearMcpOAuth,
  finishMcpOAuth,
  maskSecrets,
  startMcpOAuth,
  testMcpConnection,
  validateMcpServer,
  type StoredMcpServer,
  type McpServerInput,
} from './mcp-config.js'
import { HttpError, createErrorHandler } from './errors.js'
import { safeJson } from './routes/index.js'

const OAUTH_CALLBACK_PATH = '/api/mcp-config/oauth/callback'

export function buildMcpConfigRouter(store: McpConfigStore): Hono {
  const app = new Hono()

  app.onError(createErrorHandler('[mcp-config]'))

  // List all servers (secrets masked)
  app.get('/', (c) => {
    const servers = store.list().map(maskSecrets)
    return c.json({ servers })
  })

  // OAuth redirect target. Completes token exchange and shows a tiny close page.
  app.get('/oauth/callback', async (c) => {
    const name = c.req.query('server')
    const code = c.req.query('code')
    const error = c.req.query('error')
    const state = c.req.query('state')
    if (!name) throw new HttpError(400, 'server is required')
    const server = store.get(name)
    if (!server) throw new HttpError(404, `MCP server "${name}" not found`)
    if (error) {
      return c.html(renderOAuthResultPage(false, `Authorization failed: ${error}`), 400)
    }
    if (server.oauth?.state && state !== server.oauth.state) {
      return c.html(renderOAuthResultPage(false, 'Authorization state did not match. Please start auth again.'), 400)
    }
    if (!code) throw new HttpError(400, 'code is required')

    const redirectUrl = server.oauth?.redirectUrl ?? new URL(OAUTH_CALLBACK_PATH, c.req.url).toString()
    await finishMcpOAuth(server, code, redirectUrl)
    server.updatedAt = Date.now()
    store.upsert(server)
    await store.flush()
    return c.html(renderOAuthResultPage(true, `MCP server "${name}" is authorized.`))
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
    const body = await safeJson<McpServerInput>(c.req)
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
      timeout: body.timeout,
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

    const body = await safeJson<Partial<McpServerInput>>(c.req)

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
    if (body.timeout !== undefined) updated.timeout = body.timeout

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

    const body = await safeJson<{ enabled: boolean }>(c.req)
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean')

    const updated: StoredMcpServer = { ...existing, enabled: body.enabled, updatedAt: Date.now() }
    store.upsert(updated)
    return c.json({ server: maskSecrets(updated) })
  })

  // Start OAuth for a remote MCP server. The frontend opens authorizationUrl.
  app.post('/:name/auth/start', async (c) => {
    const name = c.req.param('name')
    const server = store.get(name)
    if (!server) throw new HttpError(404, `MCP server "${name}" not found`)
    if (server.type === 'stdio') throw new HttpError(400, 'OAuth auth is only available for remote MCP servers')

    const redirectUrl = new URL(OAUTH_CALLBACK_PATH, c.req.url)
    redirectUrl.searchParams.set('server', name)
    const result = await startMcpOAuth(server, redirectUrl.toString())
    server.updatedAt = Date.now()
    store.upsert(server)
    await store.flush()
    return c.json(result)
  })

  // Clear stored OAuth credentials for a remote MCP server.
  app.delete('/:name/auth', async (c) => {
    const name = c.req.param('name')
    const server = store.get(name)
    if (!server) throw new HttpError(404, `MCP server "${name}" not found`)
    clearMcpOAuth(server)
    server.updatedAt = Date.now()
    store.upsert(server)
    await store.flush()
    return c.json({ server: maskSecrets(server) })
  })

  // Probe a saved server with a real MCP initialize handshake.
  app.post('/:name/test', async (c) => {
    const name = c.req.param('name')
    const server = store.get(name)
    if (!server) throw new HttpError(404, `MCP server "${name}" not found`)

    const result = await testMcpConnection(server, { includeTools: false })
    if (server.type !== 'stdio') {
      store.upsert(server)
      await store.flush()
    }
    return c.json({ result })
  })

  // Probe and return the tool list for a saved server.
  app.get('/:name/tools', async (c) => {
    const name = c.req.param('name')
    const server = store.get(name)
    if (!server) throw new HttpError(404, `MCP server "${name}" not found`)

    const result = await testMcpConnection(server, { includeTools: true })
    if (server.type !== 'stdio') {
      store.upsert(server)
      await store.flush()
    }
    if (!result.success) return c.json({ result, tools: [] })
    return c.json({ result, tools: result.tools ?? [] })
  })

  // Validate a server config (schema check only, no connection test)
  app.post('/validate', async (c) => {
    const body = await safeJson<Partial<StoredMcpServer>>(c.req)
    const errors = validateMcpServer(body)
    return c.json({ valid: errors.length === 0, errors })
  })

  return app
}

function renderOAuthResultPage(ok: boolean, message: string): string {
  const safeMessage = escapeHtml(message)
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MCP Authorization</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0f1115; color: #e6e8eb; }
    .card { max-width: 460px; padding: 24px; border: 1px solid #262b36; border-radius: 12px; background: #15181f; box-shadow: 0 16px 48px rgba(0,0,0,.35); }
    h1 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0 0 16px; color: #8c94a3; line-height: 1.5; }
    button { border: 1px solid #262b36; border-radius: 8px; padding: 8px 12px; background: #1c2029; color: #e6e8eb; cursor: pointer; }
  </style>
</head>
<body>
  <main class="card">
    <h1>${ok ? 'Authorization complete' : 'Authorization failed'}</h1>
    <p>${safeMessage}</p>
    <button onclick="window.close()">Close window</button>
  </main>
  <script>
    try { localStorage.setItem('claude-react-web:mcp-oauth-complete', String(Date.now())); } catch {}
    try { new BroadcastChannel('claude-react-web:mcp-oauth').postMessage({ ok: ${ok ? 'true' : 'false'} }); } catch {}
  </script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
