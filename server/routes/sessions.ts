// Session routes: CRUD, messaging, control, MCP/plugin per-session, queries.

import { Hono } from 'hono'
import { isAbsolute } from 'node:path'
import type { Options, PermissionMode, Settings } from '@anthropic-ai/claude-agent-sdk'
import { SessionManager } from '../session-manager.js'
import { safeJson } from './index.js'
import type { MpStore } from '../mp-store.js'
import type { AgentDefinitionStore } from '../agent-definition-store.js'
import { isUserSelectablePermissionMode, permissionModeList } from '../permission-modes.js'
import { formatHooksValidationErrors, toSdkHooksSettings, validateSessionHooksConfig } from '../../shared/hooks.js'
import { coerceThinkingSetting } from '../../shared/session-info.js'
import { validateSandboxSetting } from '../../shared/sandbox.js'
import { coerceToolProfile } from '../../shared/tool-profile.js'
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

/** Effort levels accepted by POST /sessions and POST /sessions/:id/effort-level.
 *  The SDK forwards these through applyFlagSettings; unsupported levels are
 *  silently downgraded, so the route keeps the same 5-value surface the
 *  in-app effort picker exposes. */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** Validate the shape-sensitive fields that flow from POST /sessions into the
 *  SDK spawn (server/providers/claude/claude-provider.ts createSession copies
 *  them into sdkOptions, which the SDK forwards to the CLI subprocess). The
 *  manager historically accepted the whole body via a blind `as Options` cast,
 *  so a malformed value (e.g. `maxTurns: "abc"`) leaked into the subprocess and
 *  surfaced as a confusing spawn/runtime error. This narrows the known fields
 *  to the SDK's documented shapes; unknown fields pass through untouched for
 *  forward compatibility with newer SDK Options. */
function narrowCreateBody(rest: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const stringFields = ['cwd', 'model', 'title', 'pathToClaudeCodeExecutable', 'modelGroupId', 'profileId']
  for (const name of stringFields) {
    const v = rest[name]
    if (v !== undefined && typeof v !== 'string') {
      return { ok: false, error: `${name} must be a string` }
    }
  }
  // `systemPrompt` accepts the SDK's three documented shapes: a plain string,
  // a string[] (dynamic-boundary form), or the `{ type: 'preset', ... }`
  // object form. Reject numbers/booleans/null that would otherwise reach the
  // subprocess, but don't refuse valid documented options.
  const sp = rest.systemPrompt
  if (sp !== undefined && sp !== null
    && typeof sp !== 'string'
    && !(Array.isArray(sp) && sp.every((s) => typeof s === 'string'))
    && !(typeof sp === 'object' && !Array.isArray(sp))) {
    return { ok: false, error: 'systemPrompt must be a string, a string[], or a preset object' }
  }
  for (const name of ['betas', 'additionalDirectories']) {
    const err = validateStringArray(name, rest[name])
    if (err) return { ok: false, error: err }
  }
  for (const name of ['includePartialMessages', 'includeHookEvents', 'enableFileCheckpointing']) {
    const v = rest[name]
    if (v !== undefined && typeof v !== 'boolean') {
      return { ok: false, error: `${name} must be a boolean` }
    }
  }
  // Tool-surface fields are spawn-time SDK Options. Validate shape so a
  // malformed value (e.g. tools: "Bash") is a 400 instead of leaking into the
  // CLI arg builder. `tools` is special-cased because the SDK accepts BOTH a
  // string[] and a `{ type: 'preset', preset: 'claude_code' }` object — the
  // per-session coerce only knows the string[] form, which would wrongly
  // reject the valid preset object.
  const toolFields = ['tools', 'allowedTools', 'disallowedTools', 'toolAliases', 'toolConfig'] as const
  if (toolFields.some((k) => rest[k] !== undefined)) {
    const tools = rest.tools
    if (tools !== undefined) {
      const t = tools as { type?: unknown; preset?: unknown }
      // Only the single documented preset value is accepted; anything else
      // shaped like {type:'preset'} (omitted/unknown preset) is rejected here
      // rather than forwarding a spawn-time failure to the SDK.
      const isPreset = typeof tools === 'object' && tools !== null
        && t.type === 'preset' && t.preset === 'claude_code'
      if (!isPreset && (!Array.isArray(tools) || tools.some((x) => typeof x !== 'string'))) {
        return { ok: false, error: 'tools must be a string[] or { type: "preset", preset: "claude_code" }' }
      }
    }
    // The remaining fields ride the same strict coerce as the per-session
    // /tool-profile route (string[] vars + plain-object maps)
    const profile = coerceToolProfile({
      allowedTools: rest.allowedTools,
      disallowedTools: rest.disallowedTools,
      toolAliases: rest.toolAliases,
      toolConfig: rest.toolConfig,
    })
    if (profile === null) {
      return {
        ok: false,
        error: 'allowedTools/disallowedTools must be string[]; toolAliases/toolConfig must be plain objects',
      }
    }
  }
  const maxTurns = rest.maxTurns
  if (maxTurns !== undefined && (typeof maxTurns !== 'number' || !Number.isFinite(maxTurns))) {
    return { ok: false, error: 'maxTurns must be a finite number' }
  }
  const effort = rest.effortLevel
  if (effort !== undefined && (typeof effort !== 'string' || !EFFORT_LEVELS.has(effort))) {
    return { ok: false, error: 'effortLevel must be one of low, medium, high, xhigh, max' }
  }
  // App-level `thinking` field (SDK ThinkingConfig shape, forwarded verbatim
  // to Options.thinking at spawn). coerceThinkingSetting accepts the three
  // documented variants; anything else is a 400 instead of reaching the CLI.
  if (rest.thinking !== undefined && rest.thinking !== null && coerceThinkingSetting(rest.thinking) === undefined) {
    return { ok: false, error: "thinking must be {type:'adaptive'} | {type:'disabled'} | {type:'enabled', budgetTokens?: number}" }
  }
  // App-level `memory` field (auto-memory intent — NOT an SDK Options key;
  // snapshotMeta captures it onto the session and the provider re-applies it
  // via applyFlagSettings). Strict validation: this is our own surface, so
  // unknown keys are rejected rather than ignored.
  if (rest.memory !== undefined && rest.memory !== null) {
    const m = rest.memory as Record<string, unknown>
    if (typeof m !== 'object' || Array.isArray(m)) {
      return { ok: false, error: 'memory must be { autoMemoryEnabled?: boolean, autoMemoryDirectory?: string, autoDreamEnabled?: boolean }' }
    }
    const known = new Set(['autoMemoryEnabled', 'autoMemoryDirectory', 'autoDreamEnabled'])
    for (const key of Object.keys(m)) {
      if (!known.has(key)) {
        return { ok: false, error: `memory.${key} is not a recognized memory setting` }
      }
    }
    for (const key of ['autoMemoryEnabled', 'autoDreamEnabled']) {
      if (m[key] !== undefined && typeof m[key] !== 'boolean') {
        return { ok: false, error: `memory.${key} must be a boolean` }
      }
    }
    if (m.autoMemoryDirectory !== undefined && (typeof m.autoMemoryDirectory !== 'string' || !m.autoMemoryDirectory.trim())) {
      return { ok: false, error: 'memory.autoMemoryDirectory must be a non-empty string' }
    }
  }
  // App-level `sandbox` field (per-session sandbox intent — an SDK
  // Settings.sandbox key applied post-spawn via applyFlagSettings, NOT an
  // Options key). Strict validation reusing the shared validator so a typo'd
  // body (or one reaching for SDK fields we don't expose, e.g. denyRead) is a
  // 400 before it ever reaches the subprocess.
  if (rest.sandbox !== undefined && rest.sandbox !== null) {
    const v = validateSandboxSetting(rest.sandbox)
    if (!v.ok) return { ok: false, error: v.error }
    rest.sandbox = v.value
  }
  // App-level `firstPartyTools` map (per-first-party-server enable/disable
  // chosen at create time — NOT an SDK Options key; snapshotMeta ignores it
  // and the claude provider whitelists what reaches the subprocess). Values
  // must be booleans; unknown server names are tolerated and stored verbatim
  // (injection looks up overrides by registry name — the same lenient
  // pattern as the per-session toggle route).
  if (rest.firstPartyTools !== undefined && rest.firstPartyTools !== null) {
    const fpt = rest.firstPartyTools
    if (typeof fpt !== 'object' || Array.isArray(fpt)) {
      return { ok: false, error: 'firstPartyTools must be an object of booleans' }
    }
    for (const [name, value] of Object.entries(fpt)) {
      if (typeof value !== 'boolean') {
        return { ok: false, error: `firstPartyTools.${name} must be a boolean` }
      }
    }
  }
  return { ok: true, value: rest }
}

export function buildSessionRouter(sm: SessionManager, mpStore?: MpStore, agentDefinitionStore?: AgentDefinitionStore): Hono {
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
    // Start-as custom agent (`agent` = an AgentDefinitionStore name). It must be
    // a string AND refer to an enabled definition — an unknown or disabled name
    // (or any non-null agent when no store is mounted) is a 400 here: we won't
    // spin the session up under a persona we can't honour.
    const rawAgent = rest.agent
    if (rawAgent != null) {
      if (typeof rawAgent !== 'string') {
        return c.json({ error: 'agent must be a string' }, 400)
      }
      const def = agentDefinitionStore?.get(rawAgent)
      if (!def?.enabled) {
        const why = agentDefinitionStore?.has(rawAgent) ? 'is disabled' : 'is not defined'
        return c.json({ error: `agent "${rawAgent}" ${why}` }, 400)
      }
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
    const narrowed = narrowCreateBody(rest)
    if (!narrowed.ok) return c.json({ error: narrowed.error }, 400)
    const info = sm.create(narrowed.value as Options & { provider?: string }, customEnv as Record<string, string> | undefined, joinGroupOf as string | undefined, evicting)
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

  // Auto-generate a session title (first user message as description). The
  // manager no-ops when the session already has a title, so this never
  // overwrites a user-chosen name. `description` is optional and truncated.
  // `force: true` renames an already-titled session (click-to-regenerate) —
  // the manager skips its overwrite guard only when explicitly asked to.
  app.post('/sessions/:id/title', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson<{ description?: string; force?: boolean }>(c.req)
    const description = typeof body?.description === 'string' ? body.description.slice(0, 600) : ''
    const force = body?.force === true
    const info = await sm.autoGenerateTitle(id, description, { force })
    return c.json({ session: info })
  })

  // Resume a dormant session. The optional `permissionMode` is used when the
  // session has no persisted mode (CLI sessions adopted from disk) — it lets
  // the caller pass "the mode I'm currently in" so resume doesn't drop the
  // user back to default.
  app.post('/sessions/:id/resume', async (c) => {
    const body = await safeJson<{ permissionMode?: string }>(c.req).catch(() => ({ permissionMode: undefined }))
    const mode = typeof body.permissionMode === 'string' && isUserSelectablePermissionMode(body.permissionMode)
      ? body.permissionMode as PermissionMode
      : undefined
    const info = await sm.resume(c.req.param('id'), { permissionMode: mode })
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

  // Fork a session. Optional body:
  //   - resumeSessionAt?: branch from a specific assistant uuid
  //   - forkFromLastSafe?: resolve the newest completed turn as the branch
  //     point (the crash-recovery "Fork from last completed turn" button)
  //   - replacesSource?: broadcast the created frame with replacesSource so
  //     the client REPLACES the dead source's sidebar slot instead of appending
  app.post('/sessions/:id/fork', async (c) => {
    const body = await safeJson<{ resumeSessionAt?: unknown; forkFromLastSafe?: unknown; replacesSource?: unknown }>(c.req)
      .catch(() => ({ resumeSessionAt: undefined, forkFromLastSafe: undefined, replacesSource: undefined }))
    const info = await sm.fork(c.req.param('id'), {
      ...(typeof body.resumeSessionAt === 'string' && body.resumeSessionAt ? { resumeSessionAt: body.resumeSessionAt } : {}),
      ...(body.forkFromLastSafe === true ? { forkFromLastSafe: true } : {}),
      ...(body.replacesSource === true ? { replacesSource: true } : {}),
    })
    return c.json({ session: info }, 201)
  })

  // Create a Side Chat — ephemeral fork with boundary prompt.
  app.post('/sessions/:id/side-chat', async (c) => {
    const info = await sm.createSideChat(c.req.param('id'))
    return c.json({ session: info }, 201)
  })

  // List the legal "discard from here" cut points — each
  // successfully-completed turn's last assistant message with a preview.
  // Drives the client's right-click menu legality check (prefetched when a
  // panel opens a session that has completed turns).
  app.get('/sessions/:id/discard-anchors', async (c) => {
    const result = await sm.listDiscardAnchors(c.req.param('id'))
    return c.json(result)
  })

  // Discard every message AFTER a given assistant message. Forks from the
  // anchor (inclusive — the anchor's turn is kept), then swaps the source X
  // out of the sidebar (clear-style X→Y). `deleteOriginal` also unlinks X's
  // on-disk transcript (irreversible). The anchor must be a turn anchor
  // (see GET /discard-anchors); any other uuid → 400.
  app.post('/sessions/:id/discard', async (c) => {
    const body = await safeJson<{ fromAssistantUuid?: string; deleteOriginal?: boolean }>(c.req)
    if (typeof body.fromAssistantUuid !== 'string' || !body.fromAssistantUuid) {
      return c.json({ error: 'fromAssistantUuid is required' }, 400)
    }
    const info = await sm.discard(c.req.param('id'), body.fromAssistantUuid, {
      deleteOriginal: body.deleteOriginal === true,
    })
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

  // Interrupt. Optional body { cancelQueued: true } — "stop means stop
  // everything": abort the in-flight turn AND withdraw every queued user
  // message (host input queue drain + SDK interrupt_cancel_queued_v1),
  // removing them from the transcript. Absent body = plain interrupt;
  // queued messages survive and start the next turn. The body is parsed
  // tolerantly (any parse failure → absent) because a BODYLESS POST is a
  // first-class wire shape here: App's Esc fallback, curl one-liners, and
  // stale client bundles all post without a body and must keep interrupting.
  app.post('/sessions/:id/interrupt', async (c) => {
    const body = await c.req.json<{ cancelQueued?: unknown }>().catch(() => ({} as { cancelQueued?: unknown }))
    const cancelQueued = body?.cancelQueued === true
    const cancelled = await sm.interrupt(c.req.param('id'), { cancelQueued })
    return c.json({ ok: true, cancelled })
  })

  // Background in-flight foreground tasks (the CLI's Ctrl+B semantics).
  // Optional `toolUseId` restricts the call to that single task; without it
  // every foreground task (Bash commands and subagents) is backgrounded.
  //
  // A per-task call can report `backgrounded: false` for two very different
  // reasons, and the fallback below must only cover one of them. Proxy
  // backends hand the CLI `call_...` tool_use ids it can't match against its
  // own task registry, so per-task returns false even while the task is
  // genuinely running — the per-card "background" button would otherwise be a
  // no-op on those sessions. We fall back to the whole-turn (Ctrl+B) form,
  // which detaches whatever is foreground: equivalent in the common
  // single-task case, and backgrounds all foreground tasks on a multi-task
  // turn. But a native `toolu_...` id that returns false means the targeted
  // task genuinely isn't running (a stale or just-completed card) — falling
  // back there would detach *unrelated* foreground work the user never asked
  // to background, so only proxy-shaped ids escalate. An error from the
  // per-task call still propagates (never swallowed by the fallback).
  app.post('/sessions/:id/tasks/background', async (c) => {
    const body = await safeJson<{ toolUseId?: string }>(c.req)
    const toolUseId = typeof body.toolUseId === 'string' && body.toolUseId ? body.toolUseId : undefined
    let backgrounded = await sm.backgroundTasks(c.req.param('id'), toolUseId)
    if (toolUseId && !toolUseId.startsWith('toolu_') && !backgrounded) {
      backgrounded = await sm.backgroundTasks(c.req.param('id'))
    }
    return c.json({ ok: true, backgrounded })
  })

  // Stop a running task by id. The SDK emits a task_notification with status
  // 'stopped' afterwards, which folds the task to its terminal state.
  app.post('/sessions/:id/tasks/:taskId/stop', async (c) => {
    await sm.stopTask(c.req.param('id'), c.req.param('taskId'))
    return c.json({ ok: true })
  })

  // Clear conversation context without rendering `/clear` as a user bubble.
  app.post('/sessions/:id/clear', async (c) => {
    const session = await sm.clear(c.req.param('id'))
    return c.json({ ok: true, session })
  })

  // Compact `/compact` — summarize the conversation, then continue in a fresh
  // session seeded with the hand-off summary (CLI /compact semantics). Same
  // continuation-session shape as /clear (compact() is clear-with-seed
  // server-side), so the client swaps the panel X → Y exactly like /clear.
  // Phase guards (working→409 / unknown→404 / terminated→410 / dormant→412)
  // are thrown by sm.compact and translated by the app's onError handler.
  app.post('/sessions/:id/compact', async (c) => {
    const session = await sm.compact(c.req.param('id'))
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
    const body = await safeJson<{ model?: string }>(c.req)
    const info = await sm.setModel(c.req.param('id'), body.model)
    return c.json({ session: info })
  })

  // Point the session at a ModelGroup. Unknown groups are a 400 (explicit op
  // rejects rather than silently falling back).
  app.post('/sessions/:id/model-group', async (c) => {
    const body = await safeJson<{ groupId?: string }>(c.req)
    if (!body.groupId || typeof body.groupId !== 'string') {
      return c.json({ error: 'groupId is required' }, 400)
    }
    const info = await sm.setModelGroup(c.req.param('id'), body.groupId)
    return c.json({ session: info })
  })

  // Pin a session to a provider profile. `apply: 'now'` restarts the Query so
  // new credentials apply immediately; `deferred` applies on the next respawn.
  app.post('/sessions/:id/profile', async (c) => {
    const body = await safeJson<{ profileId?: unknown; apply?: unknown }>(c.req)
    if (typeof body.profileId !== 'string' || !body.profileId) {
      return c.json({ error: 'profileId is required' }, 400)
    }
    if (body.apply !== undefined && body.apply !== 'now' && body.apply !== 'deferred') {
      return c.json({ error: "apply must be 'now' or 'deferred'" }, 400)
    }
    const info = await sm.setProfile(c.req.param('id'), body.profileId, body.apply ?? 'now')
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

  // Read the session's RAM tool-surface profile (tools / allowedTools /
  // disallowedTools / toolAliases / toolConfig). Undefined = inherit defaults.
  app.get('/sessions/:id/tool-profile', async (c) => {
    const toolProfile = sm.getToolProfile(c.req.param('id'))
    return c.json({ toolProfile })
  })

  // Set (or clear, with an empty body) the session's tool-surface profile.
  // Tool surface is spawn-time-only, so it takes effect on the next /clear or
  // fork respawn (both carry the profile) — NOT mid-turn.
  app.put('/sessions/:id/tool-profile', async (c) => {
    const body = await safeJson<{ toolProfile?: unknown }>(c.req)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'body must be a JSON object' }, 400)
    }
    const profile = coerceToolProfile(body.toolProfile)
    // Only a malformed known field is a 400. An empty/absent payload (coerce
    // returns undefined) CLEARS the profile back to defaults — distinct from
    // null, which means an invalid value was supplied, not "nothing".
    if (profile === null) {
      return c.json(
        { error: 'toolProfile must be a subset of { tools, allowedTools, disallowedTools, toolAliases, toolConfig } with well-formed values' },
        400,
      )
    }
    if (profile === undefined) {
      const cleared = await sm.setToolProfile(c.req.param('id'), undefined)
      return c.json({ session: cleared, toolProfile: undefined })
    }
    const info = await sm.setToolProfile(c.req.param('id'), profile)
    return c.json({ session: info, toolProfile: profile })
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

  // Set the auto-compact window (absolute tokens). Body `{ window?: number |
  // null }`: a positive finite number pins the window (and enables
  // auto-compact); `null` clears back to "auto" (the CLI derives the
  // threshold from the model's context window). Forwarded to the SDK via
  // applyFlagSettings and persisted so it survives resume / fork / restart.
  app.post('/sessions/:id/auto-compact-window', async (c) => {
    const body = await safeJson<{ window?: unknown }>(c.req)
    const w = body.window
    if (w !== null && w !== undefined) {
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
        return c.json({ error: 'window must be a positive finite number or null' }, 400)
      }
    }
    const info = await sm.setAutoCompactWindow(c.req.param('id'), w == null ? null : w)
    return c.json({ session: info })
  })

  // Set extended-thinking config ({type:'adaptive'} | {type:'disabled'} |
  // {type:'enabled', budgetTokens}). Forwarded to the SDK via the
  // setMaxThinkingTokens control request (thinking has no Settings key);
  // persisted so it survives resume / fork / clear / restart via
  // Options.thinking. `clearDisplay: true` is the explicit "reset the
  // reasoning display mode to the API default" switch — an absent display
  // means "keep the current mode" instead.
  app.post('/sessions/:id/thinking', async (c) => {
    const body = await safeJson<{ thinking?: unknown; clearDisplay?: unknown }>(c.req)
    const setting = coerceThinkingSetting(body.thinking)
    if (!setting) {
      return c.json({ error: "thinking must be {type:'adaptive'} | {type:'disabled'} | {type:'enabled', budgetTokens?: number, display?: 'summarized'|'omitted'}" }, 400)
    }
    const info = await sm.setThinking(c.req.param('id'), setting, { clearDisplay: body.clearDisplay === true })
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

  // Per-session override for the first-party `apptools` git MCP server.
  // `enabled: null` clears the override so the session re-inherits the
  // global default. Immediate on live sessions (re-injects); legacy route
  // forwarding to the generalized first-party toggle below.
  app.post('/sessions/:id/app-tools', async (c) => {
    const body = await safeJson<{ enabled?: unknown }>(c.req)
    const v = body && Object.prototype.hasOwnProperty.call(body, 'enabled') ? body.enabled : null
    if (v !== null && typeof v !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean or null' }, 400)
    }
    const info = await sm.setAppTools(c.req.param('id'), v as boolean | null)
    return c.json({ session: info })
  })

  // Generalized first-party tool server toggle — per-session override for any
  // registered first-party server. Immediate on live sessions (re-injects via
  // setMcpServers); `enabled: null` clears the override to inherit global.
  app.post('/sessions/:id/tools/:name/toggle', async (c) => {
    const body = await safeJson<{ enabled?: unknown }>(c.req)
    const v = body && Object.prototype.hasOwnProperty.call(body, 'enabled') ? body.enabled : null
    if (v !== null && typeof v !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean or null' }, 400)
    }
    const name = c.req.param('name')
    if (!name) return c.json({ error: 'name is required' }, 400)
    const info = await sm.setFirstPartyTool(c.req.param('id'), name, v as boolean | null)
    return c.json({ session: info })
  })

  // First-party tool server status (independent of SDK mcpServerStatus, which
  // is unreliable for in-process servers). Reports enabled/injected/error per
  // registered server so the client can render the first-party section.
  app.get('/sessions/:id/tools', async (c) => {
    const tools = sm.toolServerStatus(c.req.param('id'))
    return c.json({ tools })
  })

  // Context usage
  app.get('/sessions/:id/context-usage', async (c) => {
    const usage = await sm.contextUsage(c.req.param('id'))
    return c.json({ usage })
  })

  // Set per-session auto-memory options (enable / directory / auto-dream).
  // Body keys are optional; a `null` value clears a key back to its
  // project/SDK default (forwards as null to applyFlagSettings). Persisted
  // on the session so it survives resume / fork / clear / restart. No
  // filesystem validation of autoMemoryDirectory: `~/`-prefixed paths can't
  // be probed meaningfully from the server, the dir is created on demand,
  // and the SDK silently ignores it when projectSettings pins one.
  app.post('/sessions/:id/memory', async (c) => {
    const body = await safeJson<{
      autoMemoryEnabled?: boolean | null
      autoMemoryDirectory?: string | null
      autoDreamEnabled?: boolean | null
    }>(c.req)
    const partial: Parameters<SessionManager['setMemorySettings']>[1] = {}
    for (const key of ['autoMemoryEnabled', 'autoDreamEnabled'] as const) {
      if (body && Object.prototype.hasOwnProperty.call(body, key)) {
        const v = body[key]
        if (v !== null && typeof v !== 'boolean') {
          return c.json({ error: `${key} must be a boolean or null` }, 400)
        }
        partial[key] = v
      }
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'autoMemoryDirectory')) {
      const v = body.autoMemoryDirectory
      if (v !== null && typeof v !== 'string') {
        return c.json({ error: 'autoMemoryDirectory must be a string or null' }, 400)
      }
      if (typeof v === 'string' && /[\0\n\r]/.test(v)) {
        return c.json({ error: 'autoMemoryDirectory contains invalid characters' }, 400)
      }
      partial.autoMemoryDirectory = v
    }
    const info = await sm.setMemorySettings(c.req.param('id'), partial)
    return c.json({ session: info })
  })

  // Set the per-session sandbox config (SDK Settings.sandbox, applied via
  // applyFlagSettings). Body is a full validated SandboxSetting (sandbox ON)
  // or `null` to clear it back to off (project/SDK default). Persisted so it
  // survives resume / fork / clear / restart.
  app.post('/sessions/:id/sandbox', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson<unknown>(c.req)
    if (body === null) {
      return c.json({ session: await sm.setSandbox(id, null) })
    }
    const v = validateSandboxSetting(body)
    if (!v.ok) return c.json({ error: v.error }, 400)
    return c.json({ session: await sm.setSandbox(id, v.value) })
  })

  // Session usage — cost/token totals + claude.ai plan rate-limit windows
  // (the structured data behind the CLI's /usage command).
  app.get('/sessions/:id/usage', async (c) => {
    const usage = await sm.usage(c.req.param('id'))
    return c.json({ usage })
  })

  // Authenticated-account info (email / organization / subscription type /
  // auth backend) via the SDK's accountInfo control request. Live sessions
  // only; `{ account: null }` when the SDK reports nothing.
  app.get('/sessions/:id/account', async (c) => {
    const account = await sm.accountInfo(c.req.param('id'))
    return c.json({ account: account ?? null })
  })

  // Restore tracked files to their state at a user message (SDK
  // rewindFiles; requires enableFileCheckpointing, on by default).
  // `messageId` is the app-level user-message uuid (the server maps it to
  // the SDK's on-disk uuid). `dryRun: true` previews the diff without
  // modifying files — used by the client's confirm dialog.
  app.post('/sessions/:id/rewind-files', async (c) => {
    const body = await safeJson<{ messageId?: unknown; dryRun?: unknown }>(c.req)
    if (typeof body.messageId !== 'string' || !body.messageId) {
      return c.json({ error: 'messageId is required' }, 400)
    }
    const rewind = await sm.rewindFiles(c.req.param('id'), body.messageId, {
      dryRun: body.dryRun === true,
    })
    return c.json({ rewind })
  })

  // Read a file's current content via the session (SDK readFile): gated by
  // the session's Read-permission rules inside the SDK. `path` is absolute
  // (resolved against cwd by the SDK); absent/non-absolute → 400. Response is
  // the shared FileReadResult ({ available:false } when denied/missing).
  app.get('/sessions/:id/read-file', async (c) => {
    const id = c.req.param('id')
    const path = c.req.query('path') ?? ''
    if (!path || !isAbsolute(path)) {
      return c.json({ error: 'path is required and must be absolute' }, 400)
    }
    const opts: { maxBytes?: number; encoding?: 'utf-8' | 'base64' } = {}
    const maxBytes = Number(c.req.query('maxBytes') ?? '')
    if (c.req.query('maxBytes') !== undefined) {
      if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        return c.json({ error: 'maxBytes must be a positive number' }, 400)
      }
      opts.maxBytes = maxBytes
    }
    const encoding = c.req.query('encoding')
    if (encoding !== undefined && encoding !== 'utf-8' && encoding !== 'base64') {
      return c.json({ error: "encoding must be 'utf-8' or 'base64'" }, 400)
    }
    if (encoding === 'base64') opts.encoding = 'base64'
    const result = await sm.readFile(id, path, opts)
    return c.json(result)
  })

  // List subagent ids persisted under this session's transcript dir (reads
  // disk via the SDK — no live subprocess round-trip).
  app.get('/sessions/:id/subagents', async (c) => {
    const subagents = await sm.listSubagents(c.req.param('id'))
    return c.json({ subagents })
  })

  // Read one subagent's full transcript from its own on-disk JSONL. Returns
  // SessionMessage[] ({ type: user|assistant|system, uuid, parent_tool_use_id,
  // parent_agent_id, message }). Authoritative for background/async subagents
  // whose frames never reached the main stream.
  app.get('/sessions/:id/subagents/:agentId', async (c) => {
    const limitQ = c.req.query('limit')
    const offsetQ = c.req.query('offset')
    const limit = limitQ !== undefined ? Number(limitQ) : undefined
    const offset = offsetQ !== undefined ? Number(offsetQ) : undefined
    if ((limit !== undefined && (!Number.isFinite(limit) || limit < 0)) ||
        (offset !== undefined && (!Number.isFinite(offset) || offset < 0))) {
      return c.json({ error: 'limit/offset must be non-negative integers' }, 400)
    }
    const messages = await sm.getSubagentMessages(c.req.param('id'), c.req.param('agentId'), { limit, offset })
    return c.json({ messages })
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

  // Supported agents: the SDK's built-in list UNIONed with the enabled custom
  // AgentDefinitionStore defs. De-duped by name with a built-in winning — a
  // colliding custom def (same name as an SDK agent) is not added twice.
  app.get('/sessions/:id/agents', async (c) => {
    const id = c.req.param('id')
    const builtins = (await sm.supportedAgents(id)) as Array<{ name: string; description?: string }> | undefined
    const agents = Array.isArray(builtins) ? [...builtins] : []
    const custom = agentDefinitionStore?.getEnabledDefinitions() ?? {}
    const seen = new Set(agents.map((a) => a.name))
    for (const name of Object.keys(custom)) {
      if (seen.has(name)) continue
      seen.add(name)
      agents.push({ name, ...custom[name] })
    }
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

  // Pin (or clear, mode:null) a per-MCP-server permission-mode override
  // (tighten-only: 'default' | 'auto' | null). Server-only for now — no client
  // UI surfaces the pinned value, and the SDK doesn't report it back.
  app.post('/sessions/:id/mcp/:name/permission-mode', async (c) => {
    const body = await safeJson<{ mode?: unknown }>(c.req)
    const mode = body.mode
    if (mode !== 'default' && mode !== 'auto' && mode !== null) {
      return c.json({ error: "mode must be 'default' | 'auto' | null" }, 400)
    }
    const result = await sm.setMcpPermissionModeOverride(c.req.param('id'), c.req.param('name'), mode)
    return c.json({ ok: true, ...(result?.warning ? { warning: result.warning } : {}) })
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
    const body = await safeJson<{ enabled?: boolean }>(c.req)
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
