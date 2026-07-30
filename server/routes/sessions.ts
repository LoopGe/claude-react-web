// Session routes: CRUD, messaging, control, MCP/plugin per-session, queries.

import { Hono } from 'hono'
import type { Options, PermissionMode, Settings } from '@anthropic-ai/claude-agent-sdk'
import { SessionManager } from '../session-manager.js'
import { safeJson } from './index.js'
import type { MpStore } from '../mp-store.js'
import { isUserSelectablePermissionMode, permissionModeList } from '../permission-modes.js'
import { formatHooksValidationErrors, toSdkHooksSettings, validateSessionHooksConfig } from '../../shared/hooks.js'
import { createLogger } from '../log.js'

const log = createLogger('http')

const VALID_IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** Validate an optional string-array field (e.g. `enabledMcpServers`,
 *  `enabledPlugins`). Returns an error string if present-but-malformed, or
 *  null if absent or a valid string[]. Guards against a string being passed
 *  where an array is expected — callers iterate the result, and a stray
 *  string would otherwise be split character-by-character. */
function validateStringArray(fieldName: string, value: unknown): string | null {
  if (value == null) return null
  if (!Array.isArray(value) || !value.every((s) => typeof s === 'string')) {
    return `${fieldName} must be an array of strings`
  }
  return null
}

/** Validate the optional `enabledMcpServers` field shared by the create and
 *  dynamic-MCP routes. See {@link validateStringArray}. */
function validateEnabledMcpServers(value: unknown): string | null {
  return validateStringArray('enabledMcpServers', value)
}

/** Validate the optional `enabledPlugins` field on POST /sessions. See
 *  {@link validateStringArray}. */
function validateEnabledPlugins(value: unknown): string | null {
  return validateStringArray('enabledPlugins', value)
}

/** Environment variable names that can alter process execution, inject code,
 *  or redirect I/O. Blocked from user-supplied `env` overrides to prevent
 *  privilege escalation in spawned child processes. */
const BLOCKED_ENV_VARS = new Set([
  'PATH', 'Path',                          // executable search path
  'LD_PRELOAD',                            // inject shared libraries (Linux)
  'LD_LIBRARY_PATH',                       // library search path (Linux)
  'DYLD_INSERT_LIBRARIES',                 // inject shared libraries (macOS)
  'DYLD_LIBRARY_PATH',                     // library search path (macOS)
  'NODE_OPTIONS',                          // inject arbitrary Node.js flags
  'NODE_PATH',                             // module resolution override
  'PYTHONPATH',                            // Python module search path
  'HOME', 'USERPROFILE',                   // redirect home dir / credential reads
  'COMSPEC', 'SystemRoot', 'windir',       // Windows system paths
])

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
    if (BLOCKED_ENV_VARS.has(key)) {
      return `env.${key} is not allowed — overriding this variable is blocked for security`
    }
  }
  return null
}

export function buildSessionRouter(sm: SessionManager, mpStore?: MpStore): Hono {
  const app = new Hono()

  // List sessions (snapshot only — for push-based updates the frontend
  // subscribes to the WebSocket channel in ws.ts).
  app.get('/sessions', (c) => c.json({ sessions: sm.list() }))

  // Create session
  app.post('/sessions', async (c) => {
    const body = await safeJson<Partial<Options> & { cwd?: string; provider?: string; enabledMcpServers?: string[]; enabledPlugins?: string[] }>(c.req)
    const { enabledMcpServers, enabledPlugins, mcpServers, env: customEnv, joinGroupOf, evictingSource, ...rest } = body as Record<string, unknown> & {
      enabledMcpServers?: string[]
      enabledPlugins?: string[]
      mcpServers?: Record<string, unknown>
      env?: Record<string, string>
    }
    const enabledErr = validateEnabledMcpServers(enabledMcpServers)
    if (enabledErr) return c.json({ error: enabledErr }, 400)
    const pluginsErr = validateEnabledPlugins(enabledPlugins)
    if (pluginsErr) return c.json({ error: pluginsErr }, 400)
    const envErr = validateEnv(customEnv)
    if (envErr) return c.json({ error: envErr }, 400)
    // `joinGroupOf` is set by the restart flow (Y joins X's group). Validate
    // it's a string so it can't leak into spawn as an unexpected type; absent
    // for every ordinary create.
    if (joinGroupOf != null && typeof joinGroupOf !== 'string') {
      return c.json({ error: 'joinGroupOf must be a string' }, 400)
    }
    // `evictingSource` is set by the restart flow (X is being evicted, so the
    // client bypasses its maxGroupSize cap when appending Y). Validate it's a
    // boolean so it can't leak into spawn as an unexpected type; absent for
    // every ordinary create / fork.
    if (evictingSource != null && typeof evictingSource !== 'boolean') {
      return c.json({ error: 'evictingSource must be a boolean' }, 400)
    }
    const evicting = evictingSource === true
    if (rest.permissionMode != null && !isUserSelectablePermissionMode(rest.permissionMode)) {
      return c.json({ error: `permissionMode must be one of ${permissionModeList()}` }, 400)
    }
    if (rest.settings && typeof rest.settings === 'object' && !Array.isArray(rest.settings) && 'hooks' in rest.settings) {
      const settings = rest.settings as Record<string, unknown>
      const parsedHooks = validateSessionHooksConfig(settings.hooks ?? {})
      if (!parsedHooks.ok) return c.json({ error: formatHooksValidationErrors(parsedHooks.errors), errors: parsedHooks.errors }, 400)
      rest.settings = { ...settings, hooks: toSdkHooksSettings(parsedHooks.value) }
    }
    const mergedMcp = await sm.mergeMcpServersAsync(enabledMcpServers, mcpServers)
    if (mergedMcp) rest.mcpServers = mergedMcp
    if (enabledPlugins !== undefined) (rest as { enabledPlugins?: string[] }).enabledPlugins = enabledPlugins
    const info = sm.create(rest as Options & { provider?: string }, customEnv as Record<string, string> | undefined, joinGroupOf as string | undefined, evicting)
    return c.json({ session: info }, 201)
  })

  // List sessions resumable from disk (the /resume picker). Scans
  // ~/.claude/projects/ via the SDK, including CLI-created sessions this
  // app never tracked. Registered BEFORE /sessions/:id so "resumable" is
  // not captured as an :id param. Optional ddir scopes to a project dir.
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
    const body = await safeJson<{ title: string }>(c.req)
    if (typeof body.title !== 'string') return c.json({ error: 'title is required' }, 400)
    const info = sm.rename(id, body.title)
    return c.json({ session: info })
  })

  // Resume a dormant session.
  app.post('/sessions/:id/resume', async (c) => {
    const info = await sm.resume(c.req.param('id'))
    return c.json({ session: info })
  })

  // Sleep a live, idle session: release the SDK subprocess + subscribers
  // (dormant), keeping on-disk metadata + transcript for later resume.
  // Reversible counterpart to DELETE. 409 if the session is working; a
  // not-live / already-dormant id 404s. The client only renders the button
  // for idle sessions, so both are guarded client-side too.
  app.post('/sessions/:id/sleep', async (c) => {
    const session = await sm.sleep(c.req.param('id'))
    return c.json({ session })
  })

  // Fork a session.
  app.post('/sessions/:id/fork', async (c) => {
    const info = await sm.fork(c.req.param('id'))
    return c.json({ session: info }, 201)
  })

  // Create a Side Chat — ephemeral fork with boundary prompt.
  app.post('/sessions/:id/side-chat', async (c) => {
    const info = await sm.createSideChat(c.req.param('id'))
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
      log.info(`POST /sessions/${id}/messages — content array with ${body.content.length} blocks`)
      const accepted = sm.sendContent(id, body.content as Array<{ type: string; [k: string]: unknown }>)
      return c.json({ ok: true, message: { uuid: accepted.uuid, receivedAt: accepted.receivedAt } })
    } else {
      const text = typeof body.text === 'string' ? body.text : ''
      if (!text.trim()) return c.json({ error: 'text is required' }, 400)
      log.info(`POST /sessions/${id}/messages — ${text.length} chars`)
      const accepted = sm.send(id, text)
      return c.json({ ok: true, message: { uuid: accepted.uuid, receivedAt: accepted.receivedAt } })
    }
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

  // Clear conversation context without rendering `/clear` as a user bubble.
  app.post('/sessions/:id/clear', async (c) => {
    const session = await sm.clear(c.req.param('id'))
    return c.json({ ok: true, session })
  })

  // `!` bash mode — run a shell command directly in the session's cwd.
  // Requires confirm:true (destructive-verb convention from git write
  // routes). The command runs unsandboxed in the user's shell; the confirm
  // gate is the guardrail. `share:true` (`!!cmd`) injects the result into
  // the SDK transcript so the model sees it (triggers a model turn); the
  // default `share:false` (`!cmd`) is local-only — zero model round-trips.
  app.post('/sessions/:id/exec', async (c) => {
    const body = await safeJson<{ command: string; confirm?: boolean; share?: boolean }>(c.req)
    if (typeof body.command !== 'string' || !body.command.trim()) {
      return c.json({ error: 'command is required' }, 400)
    }
    if (!body.confirm) return c.json({ error: 'confirm:true is required to run a shell command' }, 400)
    // Coerce share to a strict boolean — a truthy non-boolean (e.g. the
    // string "false") must not silently flip to share:true.
    const share = body.share === true
    const result = await sm.execInSession(c.req.param('id'), body.command, { share })
    return c.json(result)
  })

  // Force-stop the current in-flight `!`/`!!` command (SIGKILL the child), like
  // Ctrl+C in a terminal. No `confirm` gate — stopping is a safe operation, not
  // a destructive command execution. No-op when nothing is running.
  app.post('/sessions/:id/exec/abort', (c) => {
    sm.abortExec(c.req.param('id'))
    return c.json({ ok: true })
  })

  // Change model
  app.post('/sessions/:id/model', async (c) => {
    const body = await safeJson<{ model: string }>(c.req)
    const info = await sm.setModel(c.req.param('id'), body.model)
    return c.json({ session: info })
  })

  // Change permission mode
  app.post('/sessions/:id/permission-mode', async (c) => {
    const body = await safeJson<{ mode?: PermissionMode }>(c.req)
    if (!body.mode) return c.json({ error: 'mode is required' }, 400)
    if (!isUserSelectablePermissionMode(body.mode)) {
      return c.json({ error: `mode must be one of ${permissionModeList()}` }, 400)
    }
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
    const body = await safeJson<{ enabled: boolean }>(c.req)
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

  // Per-session UI prefs (pinned-header + auto-recap overrides). Pure UI
  // prefs — no SDK round-trip. Body keys are optional; a `null` value for a
  // key clears the override so the session re-inherits the global default,
  // while an explicit boolean pins it. Mirrors the /sessions/:id/model shape.
  app.post('/sessions/:id/prefs', async (c) => {
    const body = await safeJson<{
      showPinnedUserMessage?: boolean | null
      autoRecap?: boolean | null
    }>(c.req)
    const partial: { showPinnedUserMessage?: boolean | undefined; autoRecap?: boolean | undefined } = {}
    if (body && Object.prototype.hasOwnProperty.call(body, 'showPinnedUserMessage')) {
      const v = body.showPinnedUserMessage
      if (v !== null && typeof v !== 'boolean') {
        return c.json({ error: 'showPinnedUserMessage must be a boolean or null' }, 400)
      }
      partial.showPinnedUserMessage = v ?? undefined
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'autoRecap')) {
      const v = body.autoRecap
      if (v !== null && typeof v !== 'boolean') {
        return c.json({ error: 'autoRecap must be a boolean or null' }, 400)
      }
      partial.autoRecap = v ?? undefined
    }
    const info = await sm.setPrefs(c.req.param('id'), partial)
    return c.json({ session: info })
  })

  // Context usage
  app.get('/sessions/:id/context-usage', async (c) => {
    const usage = await sm.contextUsage(c.req.param('id'))
    return c.json({ usage })
  })

  // Supported models — the manager translates the SDK's camelCase ModelInfo
  // to the snake_case wire `ModelInfo` (shared/model-info.ts) and filters
  // entries with no identifier, so the route is a passthrough.
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
    const body = await safeJson<{ enabled: boolean }>(c.req)
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400)
    await sm.toggleMcpServer(c.req.param('id'), c.req.param('name'), body.enabled)
    return c.json({ ok: true })
  })

  // Reload plugins from disk
  app.post('/sessions/:id/plugins/reload', async (c) => {
    const result = await sm.reloadPlugins(c.req.param('id'))
    return c.json({ result })
  })

  // Toggle a plugin's enabled state.
  // The SDK's enabledPlugins expects the "plugin@marketplace" compound key
  // (see MpStore.keyOf). When an MpStore is available we resolve the bare
  // URL-segment name to that format so the control_request actually matches.
  app.post('/sessions/:id/plugins/:name/toggle', async (c) => {
    const body = await safeJson<{ enabled: boolean }>(c.req)
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400)
    const bare = c.req.param('name')
    const pluginKey = mpStore?.resolveCompoundKey(bare) ?? bare
    const info = await sm.togglePlugin(c.req.param('id'), pluginKey, body.enabled)
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
    const merged = await sm.mergeMcpServersAsync(body.enabledMcpServers, body.servers) ?? {}
    const result = await sm.setMcpServers(c.req.param('id'), merged)
    return c.json({ result })
  })

  return app
}
