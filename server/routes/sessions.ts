// Session routes: CRUD, messaging, control, MCP/plugin per-session, queries.

import { Hono } from 'hono'
import type { Options, PermissionMode, Settings } from '@anthropic-ai/claude-agent-sdk'
import { SessionManager } from '../session-manager.js'
import { safeJson } from './index.js'

const VALID_IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** Validate the optional `enabledMcpServers` field shared by the create and
 *  dynamic-MCP routes. Returns an error string if present-but-malformed, or
 *  null if absent or a valid string[]. Guards against a string being passed
 *  where an array is expected (mergeMcpServers would otherwise iterate it
 *  character-by-character). */
function validateEnabledMcpServers(value: unknown): string | null {
  if (value == null) return null
  if (!Array.isArray(value) || !value.every((s) => typeof s === 'string')) {
    return 'enabledMcpServers must be an array of strings'
  }
  return null
}

/** Validate the optional `env` field accepted by session creation. The SDK
 *  expects a string-to-string map for subprocess environment overrides; reject
 *  malformed input instead of letting object spread coerce arrays/strings into
 *  numeric env var names or pass non-string values to the child process. */
function validateEnv(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'env must be an object with string values'
  }
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue !== 'string') {
      return `env.${key} must be a string`
    }
  }
  return null
}

export function buildSessionRouter(sm: SessionManager): Hono {
  const app = new Hono()

  // List sessions (snapshot only — for push-based updates the frontend
  // subscribes to the WebSocket channel in ws.ts).
  app.get('/sessions', (c) => c.json({ sessions: sm.list() }))

  // Create session
  app.post('/sessions', async (c) => {
    const body = await safeJson<Partial<Options> & { cwd?: string; provider?: string; enabledMcpServers?: string[] }>(c.req)
    const { enabledMcpServers, mcpServers, env: customEnv, ...rest } = body as Record<string, unknown> & {
      enabledMcpServers?: string[]
      mcpServers?: Record<string, unknown>
      env?: Record<string, string>
    }
    const enabledErr = validateEnabledMcpServers(enabledMcpServers)
    if (enabledErr) return c.json({ error: enabledErr }, 400)
    const envErr = validateEnv(customEnv)
    if (envErr) return c.json({ error: envErr }, 400)
    const mergedMcp = sm.mergeMcpServers(enabledMcpServers, mcpServers)
    if (mergedMcp) rest.mcpServers = mergedMcp
    const info = sm.create(rest as Options & { provider?: string }, customEnv as Record<string, string> | undefined)
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

  // Toggle fast mode (research-preview Opus speedup). Forwards the intent to
  // the SDK via applyFlagSettings; the SDK reports the real runtime state back
  // through messages (parsed by the pump into session.fastModeState).
  app.post('/sessions/:id/fast-mode', async (c) => {
    const body = await safeJson<{ enabled?: boolean }>(c.req)
    const info = await sm.setFastMode(c.req.param('id'), body.enabled === true)
    return c.json({ session: info })
  })

  // Set reasoning effort level (low/medium/high/xhigh/max). Forwarded to the
  // SDK via applyFlagSettings; unsupported levels are silently downgraded.
  app.post('/sessions/:id/effort-level', async (c) => {
    const body = await safeJson<{ level?: string }>(c.req)
    const level = body.level
    if (level !== 'low' && level !== 'medium' && level !== 'high' && level !== 'xhigh' && level !== 'max') {
      return c.json({ error: 'level must be one of low, medium, high, xhigh, max' }, 400)
    }
    const info = await sm.setEffortLevel(c.req.param('id'), level)
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
      supportsFastMode?: boolean
      supportsEffort?: boolean
      supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
    }
    const raw = (await sm.supportedModels(c.req.param('id'))) as unknown as SdkModelInfo[]
    const models = raw
      .filter((m) => typeof m.value === 'string' && m.value.trim().length > 0)
      .map((m) => ({
        id: m.value as string,
        display_name: m.displayName,
        description: m.description,
        supports_fast_mode: m.supportsFastMode,
        supports_effort: m.supportsEffort,
        supported_effort_levels: m.supportedEffortLevels,
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

  // Add/remove MCP servers on a live session. Accepts the same two inputs
  // as session creation: `enabledMcpServers` (names of global servers to
  // resolve from the McpConfigStore) and/or `servers` (full inline configs,
  // which win on name collision). They are merged via mergeMcpServers before
  // being handed to the SDK's setMcpServers — so the dynamic path can
  // reference global servers by name just like the create path.
  //
  // Note: setMcpServers has REPLACE semantics over the dynamically-added set,
  // so the merged object must list every dynamic server that should remain
  // connected. An explicit empty result (e.g. servers:{} with no enabled
  // names) clears all dynamic servers.
  app.post('/sessions/:id/mcp/servers', async (c) => {
    const body = await safeJson<{
      servers?: Record<string, unknown>
      enabledMcpServers?: string[]
    }>(c.req)
    const hasServers = body.servers != null
    const hasEnabled = body.enabledMcpServers != null
    if (!hasServers && !hasEnabled) {
      return c.json({ error: 'servers (object) or enabledMcpServers (string[]) is required' }, 400)
    }
    if (hasServers && (typeof body.servers !== 'object' || Array.isArray(body.servers))) {
      return c.json({ error: 'servers must be an object' }, 400)
    }
    const enabledErr = validateEnabledMcpServers(body.enabledMcpServers)
    if (enabledErr) return c.json({ error: enabledErr }, 400)
    const merged = sm.mergeMcpServers(body.enabledMcpServers, body.servers) ?? {}
    const result = await sm.setMcpServers(c.req.param('id'), merged)
    return c.json({ result })
  })

  return app
}
