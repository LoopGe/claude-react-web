// REST routes for global MCP server configuration management.
//
// Mounted at /api/mcp-config by app.ts. Provides CRUD operations for
// persistent MCP server configs stored in ~/.claude-react-web/mcp-config.json.
// Secrets (env vars, headers) are never returned to the client — only
// key names are exposed via the maskSecrets helper.

import { Hono } from 'hono'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  McpConfigStore,
  buildExportFile,
  clearMcpOAuth,
  coerceStoredMcpServer,
  finishMcpOAuth,
  maskSecrets,
  startMcpOAuth,
  testMcpConnection,
  validateMcpServer,
  type StoredMcpServer,
  type McpServerInput,
  type MaskedMcpServer,
} from './mcp-config.js'
import { HttpError, createErrorHandler } from './errors.js'
import { safeJson } from './routes/index.js'

const OAUTH_CALLBACK_PATH = '/api/mcp-config/oauth/callback'

/** Path to the Claude CLI's own user config, which holds its global
 *  `mcpServers` map. We only read this file — never write it. */
function claudeUserConfigPath(): string {
  return join(homedir(), '.claude.json')
}

/** mtime-keyed cache of the parsed `mcpServers` object. ~/.claude.json can
 *  be tens of MB (Claude Code stores project history under `projects`), and
 *  JSON.parse is synchronous — without this, a user importing servers
 *  one-checkbox-at-a-time would re-read + re-parse the whole file per POST.
 *  The file is mutated by the Claude CLI, not by us, so an mtime check is
 *  sufficient invalidation; a stale cache survives only until the CLI
 *  touches the file. `null` = no cached read yet. */
let claudeMcpCache: { mtimeMs: number; data: Record<string, unknown> } | null = null

/** Read the top-level `mcpServers` object from ~/.claude.json. Returns an
 *  empty record when the file is missing, malformed, or lacks the key —
 *  never throws for those cases, so the setup wizard isn't blocked by a
 *  corrupt foreign file. A real I/O error (permissions, etc.) still throws
 *  HttpError(500) so it surfaces rather than silently looking empty. */
async function readClaudeMcpServers(): Promise<Record<string, unknown>> {
  const file = claudeUserConfigPath()
  let st
  try {
    st = await stat(file)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return {}
    throw new HttpError(500, `Could not stat ~/.claude.json: ${e.message}`)
  }
  // Cache hit: the file hasn't changed since the last read.
  if (claudeMcpCache && claudeMcpCache.mtimeMs === st.mtimeMs) return claudeMcpCache.data

  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return {}
    throw new HttpError(500, `Could not read ~/.claude.json: ${e.message}`)
  }
  // Strip a leading UTF-8 BOM — some Windows editors save ~/.claude.json
  // with one, and JSON.parse throws on the BOM (U+FEFF) prefix. Claude Code
  // itself never writes a BOM, but the file is hand-editable.
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)

  const empty: Record<string, unknown> = {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Malformed JSON — honor the "returns empty" contract instead of 500-ing
    // the setup wizard. Cache the empty result against this mtime so a retry
    // doesn't re-attempt the parse until the file changes.
    claudeMcpCache = { mtimeMs: st.mtimeMs, data: empty }
    return empty
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    claudeMcpCache = { mtimeMs: st.mtimeMs, data: empty }
    return empty
  }
  const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
    claudeMcpCache = { mtimeMs: st.mtimeMs, data: empty }
    return empty
  }
  const data = mcpServers as Record<string, unknown>
  claudeMcpCache = { mtimeMs: st.mtimeMs, data }
  return data
}

export function buildMcpConfigRouter(store: McpConfigStore): Hono {
  const app = new Hono()

  app.onError(createErrorHandler('[mcp-config]'))

  // List all servers (secrets masked)
  app.get('/', (c) => {
    const servers = store.list().map(maskSecrets)
    return c.json({ servers })
  })

  // ── Import from Claude CLI config (~/.claude.json) ─────────────────
  // Registered BEFORE `/:name` so the literal `claude-import` segment
  // isn't captured by the `:name` param route below.

  /** GET /claude-import — surface native MCP servers (secrets masked) plus
   *  per-server validation errors so the UI can show which entries the
   *  command allowlist would reject before the user tries to import. */
  app.get('/claude-import', async (c) => {
    const mcpServers = await readClaudeMcpServers()
    const servers: Array<MaskedMcpServer & { importErrors: string[]; exists: boolean }> = []
    for (const [name, raw] of Object.entries(mcpServers)) {
      const server = coerceStoredMcpServer(raw, name)
      if (!server) continue
      const errors = validateMcpServer(server)
      servers.push({
        ...maskSecrets(server),
        importErrors: errors,
        exists: !!store.get(server.name),
      })
    }
    return c.json({ servers })
  })

  /** POST /claude-import — import a subset (by name) into the global store.
   *  Re-reads ~/.claude.json server-side so secret env/headers values never
   *  cross the wire. Names that already exist are skipped (not overwritten);
   *  names that fail validation are reported per-entry. */
  app.post('/claude-import', async (c) => {
    const body = await safeJson<{ names?: unknown }>(c.req)
    if (!body || typeof body !== 'object' || !Array.isArray(body.names)) {
      throw new HttpError(400, 'names must be an array of strings')
    }
    const names = body.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    const mcpServers = await readClaudeMcpServers()
    // Index entries by their COERCED name (the same value GET returned to the
    // client). An entry's object key and its `name` field can disagree
    // (coerceStoredMcpServer prefers an explicit `name`), so looking the
    // client-sent name up directly in `mcpServers` would miss those entries.
    // Dedupes by coerced name so two keys resolving to the same name don't
    // produce both an `imported` and a `skipped` for one server.
    const byName = new Map<string, unknown>()
    for (const [key, raw] of Object.entries(mcpServers)) {
      const server = coerceStoredMcpServer(raw, key)
      if (server && !byName.has(server.name)) byName.set(server.name, raw)
    }
    const imported: string[] = []
    const skipped: string[] = []
    const failed: { name: string; error: string }[] = []
    let dirty = false
    for (const name of names) {
      const raw = byName.get(name)
      const server = raw ? coerceStoredMcpServer(raw, name) : null
      if (!server) {
        failed.push({ name, error: 'not found in ~/.claude.json mcpServers' })
        continue
      }
      const errors = validateMcpServer(server)
      if (errors.length > 0) {
        failed.push({ name, error: errors.join('; ') })
        continue
      }
      if (store.get(server.name)) {
        skipped.push(server.name)
        continue
      }
      store.upsert({ ...server, enabled: true })
      imported.push(server.name)
      dirty = true
    }
    // Persist immediately — the debounced flush timer is unref()'d, so an
    // abrupt exit within the 500ms window would lose the just-imported
    // servers. Import is a deliberate user action expecting durability.
    if (dirty) await store.flush()
    return c.json({ imported, skipped, failed })
  })

  // ── Export ───────────────────────────────────────────────────────
  /** GET /export — serialize the configured servers as a versioned JSON
   *  envelope. `includeSecrets=1` keeps real env/header values; oauth is
   *  never exported. Optional `names=a,b,c` filters. */
  app.get('/export', (c) => {
    const rawNames = c.req.query('names')
    const names = rawNames ? rawNames.split(',').map((n) => n.trim()).filter(Boolean) : undefined
    const includeSecrets = c.req.query('includeSecrets') === '1'
    let servers = store.list()
    if (names && names.length > 0) {
      const set = new Set(names)
      servers = servers.filter((s) => set.has(s.name))
    }
    return c.json(buildExportFile(servers, includeSecrets))
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
