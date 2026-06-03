// Session routes: CRUD, messaging, control, MCP/plugin per-session, queries.

import { Hono } from 'hono'
import type { Options, PermissionMode, Settings } from '@anthropic-ai/claude-agent-sdk'
import { SessionManager } from '../session-manager.js'
import { safeJson } from './index.js'

const VALID_IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export function buildSessionRouter(sm: SessionManager): Hono {
  const app = new Hono()

  // List sessions (snapshot only — for push-based updates the frontend
  // subscribes to the WebSocket channel in ws.ts).
  app.get('/sessions', (c) => c.json({ sessions: sm.list() }))

  // Create session
  app.post('/sessions', async (c) => {
    const body = await safeJson<Partial<Options> & { cwd?: string; enabledMcpServers?: string[] }>(c.req)
    const { enabledMcpServers, mcpServers, ...rest } = body as Record<string, unknown> & {
      enabledMcpServers?: string[]
      mcpServers?: Record<string, unknown>
    }
    const mergedMcp = sm.mergeMcpServers(enabledMcpServers, mcpServers)
    if (mergedMcp) rest.mcpServers = mergedMcp
    const info = sm.create(rest as Options)
    return c.json({ session: info }, 201)
  })

  // List sessions resumable from disk (the /resume picker). Scans
  // ~/.claude/projects/ via the SDK, including CLI-created sessions this
  // app never tracked. Registered BEFORE /sessions/:id so "resumable" is
  // not captured as an :id param. Optional ?dir scopes to a project dir.
  app.get('/sessions/resumable', async (c) => {
    const dir = c.req.query('dir') || undefined
    const sessions = await sm.listResumable({ dir })
    return c.json({ sessions })
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

  // Patch session metadata (title).
  app.patch('/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson<{ title?: string }>(c.req)
    if (typeof body.title !== 'string') return c.json({ error: 'title is required' }, 400)
    const info = sm.rename(id, body.title)
    return c.json({ session: info })
  })

  // Resume a dormant session.
  app.post('/sessions/:id/resume', async (c) => {
    const info = await sm.resume(c.req.param('id'))
    return c.json({ session: info })
  })

  // Fork a session.
  app.post('/sessions/:id/fork', async (c) => {
    const info = await sm.fork(c.req.param('id'))
    return c.json({ session: info }, 201)
  })

  // Send user message — text or content array (multimodal).
  app.post('/sessions/:id/messages', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson<{ text?: string; content?: unknown[] }>(c.req)

    if (Array.isArray(body.content) && body.content.length > 0) {
      let totalBase64 = 0
      for (const block of body.content) {
        const b = block as Record<string, unknown>
        if (b.type === 'image') {
          const source = b.source as Record<string, unknown> | undefined
          if (!source || source.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') {
            return c.json({ error: 'invalid image block: missing base64 source' }, 400)
          }
          if (!VALID_IMG_TYPES.has(source.media_type as string)) {
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

  // Paginated history (lazy-load older messages from disk).
  //
  // Query params:
  //   before — disk index to page backwards from (exclusive). Omit for the
  //            newest page. Pass the previous response's `startIndex` to walk
  //            further back.
  //   limit  — page size (default 200, clamped server-side to [1, 1000]).
  //
  // Returns { messages, totalCount, startIndex, hasMore }. Messages are in
  // chronological order and shape-compatible with live SDK messages.
  app.get('/sessions/:id/history', async (c) => {
    const id = c.req.param('id')
    const beforeRaw = c.req.query('before')
    const beforeUuid = c.req.query('beforeUuid') || undefined
    const limitRaw = c.req.query('limit')
    const before = beforeRaw != null && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : undefined
    const limit = limitRaw != null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 200
    const page = await sm.getHistoryPage(id, { before, beforeUuid, limit })
    return c.json(page)
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

  // Supported models
  //
  // The SDK's ModelInfo uses { value, displayName, description, ... } —
  // camelCase plus a generic `value` key. The browser bundle has its own
  // ModelInfo type using snake_case `display_name` and id-shaped `id`.
  // We translate at the wire so the browser type doesn't have to know
  // about the SDK's shape; if the SDK ever renames fields again (it has
  // before), only this one mapping changes. Drop entries with no
  // identifier — defensive, since rendering an <option> with neither id
  // nor label produces an invisible row that looks like a layout bug.
  app.get('/sessions/:id/models', async (c) => {
    type SdkModelInfo = {
      value?: string
      displayName?: string
      description?: string
    }
    const raw = (await sm.supportedModels(c.req.param('id'))) as unknown as SdkModelInfo[]
    const models = raw
      .filter((m) => typeof m.value === 'string' && m.value.trim().length > 0)
      .map((m) => ({
        id: m.value as string,
        display_name: m.displayName,
        description: m.description,
      }))
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

  // Reload plugins from disk
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

  // Add/remove MCP servers on a live session
  app.post('/sessions/:id/mcp/servers', async (c) => {
    const body = await safeJson<{ servers?: Record<string, unknown> }>(c.req)
    if (!body.servers || typeof body.servers !== 'object') {
      return c.json({ error: 'servers (object) is required' }, 400)
    }
    const result = await sm.setMcpServers(c.req.param('id'), body.servers as Record<string, unknown>)
    return c.json({ result })
  })

  return app
}
