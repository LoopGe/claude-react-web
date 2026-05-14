// REST routes for the SessionManager.
//
// Real-time streaming (messages, permissions, context usage) is handled
// by the WebSocket layer in ws.ts, not here.

import { Hono } from 'hono'
import type { Options, PermissionMode, Settings } from '@anthropic-ai/claude-agent-sdk'
import { mkdir, writeFile, unlink, readFile, readdir, stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { HttpError, SessionManager } from './session-manager.js'
import { generateRecap } from './recap.js'

/** Where per-session uploads land inside the session's cwd. Kept visible
 *  (not dot-prefixed) so users can see what the UI dropped in. */
const UPLOAD_SUBDIR = 'claude-web-uploads'
import { config as serverConfig } from './config.js'

/** Parse JSON body, returning 400 on malformed input instead of silently
 *  falling back to an empty object. */
async function safeJson<T>(req: { json<T>(): Promise<T> }): Promise<T> {
  try {
    return await req.json<T>()
  } catch {
    throw new HttpError(400, 'Malformed JSON body')
  }
}

export function buildApiRouter(sm: SessionManager): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 410 | 500)
    }
    console.error('[api] unhandled error:', err)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  })

  // Health / version
  app.get('/health', (c) => c.json({ ok: true, sessions: sm.list().length }))

  // List sessions (snapshot only — for push-based updates the frontend
  // subscribes to the WebSocket channel in ws.ts).
  app.get('/sessions', (c) => c.json({ sessions: sm.list() }))

  // Create session
  app.post('/sessions', async (c) => {
    const body = await c.req.json<Partial<Options> & { cwd?: string; enabledMcpServers?: string[] }>().catch(
      () => ({}) as Partial<Options> & { enabledMcpServers?: string[] },
    )
    // Merge global MCP configs with session-specific overrides
    const { enabledMcpServers, mcpServers, ...rest } = body as Record<string, unknown> & {
      enabledMcpServers?: string[]
      mcpServers?: Record<string, unknown>
    }
    const mergedMcp = sm.mergeMcpServers(enabledMcpServers, mcpServers)
    if (mergedMcp) rest.mcpServers = mergedMcp
    const info = sm.create(rest as Options)
    return c.json({ session: info }, 201)
  })

  // Get session info
  app.get('/sessions/:id', (c) => {
    const id = c.req.param('id')
    return c.json({ session: sm.get(id) })
  })

  // Delete session
  app.delete('/sessions/:id', async (c) => {
    await sm.delete(c.req.param('id'))
    return c.json({ ok: true })
  })

  // Patch session metadata. Currently the only mutable field is `title`.
  // Unknown fields are ignored (forward-compatible). Accepts both live
  // and dormant sessions so the user can rename a terminated session
  // before deleting it.
  app.patch('/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson<{ title?: string }>(c.req)
    if (typeof body.title !== 'string') return c.json({ error: 'title is required' }, 400)
    const info = sm.rename(id, body.title)
    return c.json({ session: info })
  })

  // Resume a dormant (persisted but unloaded) session. Idempotent — calling
  // on an already-live session just returns its current info.
  app.post('/sessions/:id/resume', (c) => {
    const info = sm.resume(c.req.param('id'))
    return c.json({ session: info })
  })

  // Fork a session. Creates a brand-new session whose starting transcript
  // is copied from the source, then diverges from there. Sidebar can
  // show both in parallel and future turns don't collide.
  app.post('/sessions/:id/fork', (c) => {
    const info = sm.fork(c.req.param('id'))
    return c.json({ session: info }, 201)
  })

  // Send user message — accepts either legacy `text` string or `content` array
  // (text + image blocks for multimodal input).
  app.post('/sessions/:id/messages', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson<{ text?: string; content?: unknown[] }>(c.req)

    if (Array.isArray(body.content) && body.content.length > 0) {
      // Validate content blocks
      const VALID_IMG_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
      let totalBase64 = 0
      for (const block of body.content) {
        const b = block as Record<string, unknown>
        if (b.type === 'image') {
          const source = b.source as Record<string, unknown> | undefined
          if (!source || source.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') {
            return c.json({ error: 'invalid image block: missing base64 source' }, 400)
          }
          if (!VALID_IMG_TYPES.includes(source.media_type as string)) {
            return c.json({ error: `unsupported image type: ${source.media_type}` }, 400)
          }
          totalBase64 += (source.data as string).length
        } else if (b.type !== 'text') {
          return c.json({ error: `unsupported content block type: ${b.type}` }, 400)
        }
      }
      if (totalBase64 > 28_000_000) {
        return c.json({ error: 'total image payload too large' }, 413)
      }
      console.log(`[http] POST /sessions/${id}/messages — content array with ${body.content.length} blocks`)
      sm.sendContent(id, body.content as Array<{ type: string; [k: string]: unknown }>)
    } else {
      const text = typeof body.text === 'string' ? body.text : ''
      if (!text.trim()) return c.json({ error: 'text is required' }, 400)
      console.log(`[http] POST /sessions/${id}/messages — ${text.length} chars`)
      sm.send(id, text)
    }
    return c.json({ ok: true })
  })

  // Interrupt
  app.post('/sessions/:id/interrupt', async (c) => {
    await sm.interrupt(c.req.param('id'))
    return c.json({ ok: true })
  })

  // Change model
  app.post('/sessions/:id/model', async (c) => {
    const body = await safeJson<{ model?: string }>(c.req)
    const info = await sm.setModel(c.req.param('id'), body.model)
    return c.json({ session: info })
  })

  // Change permission mode
  app.post('/sessions/:id/permission-mode', async (c) => {
    const body = await safeJson<{ mode?: PermissionMode }>(c.req)
    if (!body.mode) return c.json({ error: 'mode is required' }, 400)
    const info = await sm.setPermissionMode(c.req.param('id'), body.mode)
    return c.json({ session: info })
  })

  // Apply flag settings
  app.post('/sessions/:id/settings', async (c) => {
    const body = await safeJson<{ settings?: Settings }>(c.req)
    const info = await sm.applySettings(c.req.param('id'), body.settings ?? {})
    return c.json({ session: info })
  })

  // Context usage
  app.get('/sessions/:id/context-usage', async (c) => {
    const usage = await sm.contextUsage(c.req.param('id'))
    return c.json({ usage })
  })

  // Supported models (per session — reflects any flag-settings overrides)
  app.get('/sessions/:id/models', async (c) => {
    const models = await sm.supportedModels(c.req.param('id'))
    return c.json({ models })
  })

  // Supported commands
  app.get('/sessions/:id/commands', async (c) => {
    const commands = await sm.supportedCommands(c.req.param('id'))
    return c.json({ commands })
  })

  // Supported agents
  app.get('/sessions/:id/agents', async (c) => {
    const agents = await sm.supportedAgents(c.req.param('id'))
    return c.json({ agents })
  })

  // Upload one or more files into the session's cwd. Files land under
  // <cwd>/claude-web-uploads/<timestamp>-<name> so repeated uploads with
  // the same filename don't collide and the assistant can Read them by
  // absolute path (returned to the caller).
  app.post('/sessions/:id/uploads', async (c) => {
    const id = c.req.param('id')
    const info = sm.get(id)
    if (!info.cwd) {
      return c.json({ error: 'session has no cwd; uploads require a working directory' }, 400)
    }
    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'expected multipart/form-data' }, 400)
    }

    // parseBody with `all: true` collects multi-valued fields (same-name
    // files) into arrays. Anything else (stray text fields) is ignored.
    const body = await c.req.parseBody({ all: true }).catch(() => null)
    if (!body) return c.json({ error: 'invalid multipart payload' }, 400)

    const files: File[] = []
    for (const v of Object.values(body)) {
      if (v instanceof File) files.push(v)
      else if (Array.isArray(v)) for (const x of v) if (x instanceof File) files.push(x)
    }
    if (files.length === 0) return c.json({ error: 'no files in request' }, 400)

    const uploadDir = resolvePath(info.cwd, UPLOAD_SUBDIR)
    await mkdir(uploadDir, { recursive: true })

    const now = Date.now()
    const saved: Array<{ path: string; name: string; size: number }> = []
    for (const f of files) {
      if (f.size > serverConfig.maxUploadBytes) {
        return c.json(
          { error: `file ${f.name} exceeds ${serverConfig.maxUploadBytes} bytes` },
          413 as 400 | 404 | 410 | 500,
        )
      }
      // Sanitize the filename so a malicious client can't break out via
      // `../` or absolute paths. Only the basename is kept, then any
      // remaining path separators / null bytes are scrubbed.
      const rawName = f.name || 'upload'
      const baseName = rawName.split(/[\\/]/).pop() || 'upload'
      const safeName = baseName.replace(/[\0/\\]/g, '_').slice(0, 200) || 'upload'
      const destName = `${now}-${safeName}`
      const dest = resolvePath(uploadDir, destName)
      const buf = Buffer.from(await f.arrayBuffer())
      await writeFile(dest, buf)
      saved.push({ path: dest, name: safeName, size: f.size })
    }

    return c.json({ uploads: saved })
  })

  // Delete a previously uploaded file.
  app.delete('/sessions/:id/uploads/:filename', async (c) => {
    const id = c.req.param('id')
    const filename = c.req.param('filename')
    const info = sm.get(id)
    if (!info.cwd) {
      return c.json({ error: 'session has no cwd' }, 400)
    }
    const target = resolvePath(info.cwd, UPLOAD_SUBDIR, filename)
    // Ensure the resolved path is still inside the upload dir (no path traversal).
    const uploadDir = resolvePath(info.cwd, UPLOAD_SUBDIR)
    if (!target.startsWith(uploadDir + '/') && target !== uploadDir) {
      return c.json({ error: 'invalid filename' }, 400)
    }
    try {
      await unlink(target)
      return c.json({ ok: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'file not found' }, 404)
      }
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  // MCP server status
  app.get('/sessions/:id/mcp-status', async (c) => {
    const mcp = await sm.mcpServerStatus(c.req.param('id'))
    return c.json({ mcp })
  })

  // Reconnect a failed/disconnected MCP server
  app.post('/sessions/:id/mcp/:name/reconnect', async (c) => {
    await sm.reconnectMcpServer(c.req.param('id'), c.req.param('name'))
    return c.json({ ok: true })
  })

  // Enable or disable an MCP server
  app.post('/sessions/:id/mcp/:name/toggle', async (c) => {
    const body = await safeJson<{ enabled?: boolean }>(c.req)
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400)
    await sm.toggleMcpServer(c.req.param('id'), c.req.param('name'), body.enabled)
    return c.json({ ok: true })
  })

  // Reload plugins from disk and refresh MCP status
  app.post('/sessions/:id/plugins/reload', async (c) => {
    const result = await sm.reloadPlugins(c.req.param('id'))
    return c.json({ result })
  })

  // Toggle a plugin's enabled state
  app.post('/sessions/:id/plugins/:name/toggle', async (c) => {
    const body = await safeJson<{ enabled?: boolean }>(c.req)
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400)
    const info = await sm.togglePlugin(c.req.param('id'), c.req.param('name'), body.enabled)
    return c.json({ session: info })
  })

  // Add/remove MCP servers on a live session via SDK setMcpServers
  app.post('/sessions/:id/mcp/servers', async (c) => {
    const body = await safeJson<{ servers?: Record<string, unknown> }>(c.req)
    if (!body.servers || typeof body.servers !== 'object') {
      return c.json({ error: 'servers (object) is required' }, 400)
    }
    const result = await sm.setMcpServers(c.req.param('id'), body.servers as Record<string, unknown>)
    return c.json({ result })
  })

  // List pending requests (used by the frontend on first load to render any
  // outstanding modal before its WebSocket subscription is established).
  app.get('/sessions/:id/permissions', (c) => {
    const id = c.req.param('id')
    return c.json({ pending: sm.listPending(id) })
  })

  // Decide a pending request.
  app.post('/sessions/:id/permissions/:pid/decide', async (c) => {
    const id = c.req.param('id')
    const pid = c.req.param('pid')
    const raw = await safeJson<{ behavior?: unknown; persistForSession?: unknown; message?: unknown }>(c.req)
    if (raw.behavior === 'allow') {
      sm.decide(id, pid, {
        behavior: 'allow',
        persistForSession: typeof raw.persistForSession === 'boolean' ? raw.persistForSession : false,
      })
      return c.json({ ok: true })
    }
    if (raw.behavior === 'deny') {
      sm.decide(id, pid, {
        behavior: 'deny',
        message: typeof raw.message === 'string' ? raw.message : undefined,
      })
      return c.json({ ok: true })
    }
    return c.json({ error: "behavior must be 'allow' or 'deny'" }, 400)
  })

  // Answer a pending AskUserQuestion. Body shape:
  //   { answers: Array<string | string[] | null> }
  // Each answer aligns positionally with the pending request's questions;
  // strings for single-select, arrays for multi-select, null for skipped.
  // Anything else falls back to null (same as "skipped") rather than
  // failing the request — the SDK doesn't care, and the user may have
  // closed the dialog mid-answer.
  app.post('/sessions/:id/permissions/:pid/answer-question', async (c) => {
    const id = c.req.param('id')
    const pid = c.req.param('pid')
    const raw = await safeJson<{ answers?: unknown }>(c.req)
    if (!Array.isArray(raw.answers)) {
      return c.json({ error: 'answers must be an array' }, 400)
    }
    const answers = raw.answers.map((a) => {
      if (typeof a === 'string') return a
      if (Array.isArray(a) && a.every((x) => typeof x === 'string')) return a as string[]
      return null
    })
    sm.answerQuestion(id, pid, answers)
    return c.json({ ok: true })
  })

  // Session recap — AI-generated summary of a session's conversation.
  // Returns a fallback summary for dormant sessions (their in-memory
  // history has been unloaded by the idle GC) so the UI can show
  // something useful without needing a full resume.
  app.post('/sessions/:id/recap', async (c) => {
    const id = c.req.param('id')
    const info = sm.get(id) // throws 404 if not found
    const history = sm.getHistory(id)
    if (!history) {
      // Dormant session — history is gone but metadata persists.
      // Return a lightweight fallback so the banner has content.
      const msgCount = info.messageCount
      if (msgCount > 0) {
        return c.json({
          summary: `Session with ${msgCount} message${msgCount === 1 ? '' : 's'} (dormant — resume to generate full recap).`,
          stats: { messageCount: msgCount, userTurns: 0, assistantTurns: 0, totalCostUsd: 0, durationMs: 0, toolsUsed: [] },
          cached: false,
          generatedAt: Date.now(),
          fallback: true,
        })
      }
      return c.json({
        summary: 'No messages yet.',
        stats: { messageCount: 0, userTurns: 0, assistantTurns: 0, totalCostUsd: 0, durationMs: 0, toolsUsed: [] },
        cached: false,
        generatedAt: Date.now(),
        fallback: true,
      })
    }
    const result = await generateRecap(history, id)
    // Persist the recap as a synthetic message in the session history so
    // it survives page refresh and appears in replay for all tabs.
    const recapMsg = {
      type: 'recap',
      uuid: `recap:${id}:${result.generatedAt}`,
      session_id: id,
      recap: result,
      state: 'ready',
    }
    sm.appendRecap(id, recapMsg)
    return c.json(result)
  })

  // ── Marketplace browsing ──────────────────────────────────────

  const CLAUDE_DIR = resolvePath(homedir(), '.claude')
  const KNOWN_MARKETPLACES = resolvePath(CLAUDE_DIR, 'plugins', 'known_marketplaces.json')
  const PLUGINS_CACHE = resolvePath(CLAUDE_DIR, 'plugins', 'cache')
  const INSTALLED_PLUGINS = resolvePath(CLAUDE_DIR, 'plugins', 'installed_plugins.json')

  /** List registered marketplaces. */
  app.get('/marketplaces', async (c) => {
    try {
      const raw = await readFile(KNOWN_MARKETPLACES, 'utf-8')
      const data = JSON.parse(raw) as Record<string, { source: string; [k: string]: unknown }>
      const marketplaces = Object.entries(data).map(([name, info]) => ({
        name,
        ...info,
      }))
      return c.json({ marketplaces })
    } catch {
      return c.json({ marketplaces: [] })
    }
  })

  /** List available plugins in a marketplace. */
  app.get('/marketplaces/:name/plugins', async (c) => {
    const marketplace = c.req.param('name')
    const cacheDir = resolvePath(PLUGINS_CACHE, marketplace)
    try {
      await stat(cacheDir)
    } catch {
      return c.json({ plugins: [] })
    }

    // Load installed plugins for status check
    let installed = new Set<string>()
    try {
      const raw = await readFile(INSTALLED_PLUGINS, 'utf-8')
      const data = JSON.parse(raw) as Record<string, unknown[]>
      for (const [key, entries] of Object.entries(data)) {
        if (Array.isArray(entries) && entries.length > 0) installed.add(key)
      }
    } catch { /* ignore */ }

    const entries = await readdir(cacheDir, { withFileTypes: true })
    const plugins = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const pluginDir = resolvePath(cacheDir, entry.name)
      // Look for .claude-plugin/marketplace.json in any version subdirectory
      let manifestPath: string | null = null
      try {
        const versions = await readdir(pluginDir)
        for (const v of versions) {
          const candidate = resolvePath(pluginDir, v, '.claude-plugin', 'marketplace.json')
          try { await stat(candidate); manifestPath = candidate; break } catch { /* skip */ }
        }
      } catch { /* skip */ }

      if (manifestPath) {
        try {
          const raw = await readFile(manifestPath, 'utf-8')
          const manifest = JSON.parse(raw) as { plugins?: Array<{ name: string; description: string; version: string; author?: { name: string } }> }
          const p = manifest.plugins?.[0]
          if (p) {
            plugins.push({
              name: p.name || entry.name,
              description: p.description || '',
              version: p.version || 'unknown',
              author: p.author?.name || '',
              marketplace,
              installed: installed.has(`${entry.name}@${marketplace}`),
            })
          }
        } catch { /* skip malformed */ }
      } else {
        // No manifest — still list the directory name
        plugins.push({
          name: entry.name,
          description: '',
          version: 'unknown',
          author: '',
          marketplace,
          installed: installed.has(`${entry.name}@${marketplace}`),
        })
      }
    }
    return c.json({ plugins })
  })

  /** Install a plugin from a marketplace by shelling out to claude CLI. */
  app.post('/marketplaces/:name/plugins/:plugin/install', async (c) => {
    const marketplace = c.req.param('name')
    const plugin = c.req.param('plugin')
    const pluginId = `${plugin}@${marketplace}`
    try {
      const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile('claude', ['plugin', 'install', pluginId], { timeout: 120_000 }, (err, stdout, stderr) => {
          if (err) {
            const msg = stderr || err.message
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              reject(new Error('claude CLI not found on PATH — install it first'))
            } else {
              reject(new Error(msg))
            }
          } else {
            resolve({ stdout, stderr })
          }
        })
      })
      return c.json({ ok: true, output: stdout })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  return app
}
