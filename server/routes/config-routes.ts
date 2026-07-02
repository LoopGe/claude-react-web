// Config-related routes: setup, defaults, full config, update.

import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import { homedir } from 'node:os'
import { SessionManager } from '../session-manager.js'
import { HttpError } from '../errors.js'
import { createLogger } from '../log.js'
import { safeJson } from './index.js'

const log = createLogger('config')
import { config as serverConfig, loadConfig, readConfigFile, updateConfigFile } from '../config.js'
import {
  LOG_LEVELS, getLogConfig, setLogConfig, type LogLevel,
  enableFileLogging, disableFileLogging, isFileLoggingEnabled, getLogFilePath,
} from '../log.js'
import { writeAtomic } from '../json-file-store.js'
import { validateOutboundUrl } from '../ssrf.js'

export function buildConfigRouter(sm: SessionManager, configDir?: string): Hono {
  const app = new Hono()

  // Config setup dwrite authToken/baseUrl/model fields to config.json and
  // hot-reloa?. Accepts optional modelList / recapModel / commitMessageModel
  // so the setup page can configure everything in one shot.
  app.post('/config/setup', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<{
      authToken?: string
      baseUrl?: string
      modelList?: string[]
      recapModel?: string
      commitMessageModel?: string
      updateCheckRegistry?: string
    }>(c.req)
    const configPath = joinPath(configDir, 'config.json')
    let existing: Record<string, unknown> = {}
    try {
      existing = JSON.parse(await readFile(configPath, 'utf8'))
    } catch { /* file may not exist */ }
    if (body.authToken?.trim()) {
      existing.authToken = body.authToken.trim()
    } else if (!existing.authToken) {
      throw new HttpError(400, 'authToken is required')
    }
    if (body.baseUrl?.trim()) {
      existing.baseUrl = body.baseUrl.trim().replace(/\/+$/, '')
    }
    if (Array.isArray(body.modelList) && body.modelList.length > 0) {
      existing.modelList = body.modelList.filter((m) => typeof m === 'string' && m.trim())
    }
    if (typeof body.recapModel === 'string') {
      existing.recapModel = body.recapModel.trim() || undefined
    }
    if (typeof body.commitMessageModel === 'string') {
      existing.commitMessageModel = body.commitMessageModel.trim() || undefined
    }
    if (typeof body.updateCheckRegistry === 'string') {
      // Persist verbatim (trimmed) dempty string is a valid value meaning
      // "update checks disabled", so we write it rather than dropping it.
      existing.updateCheckRegistry = body.updateCheckRegistry.trim()
    }
    await writeAtomic(configDir, configPath, existing)
    await loadConfig(configDir)
    log.info('config/setup saved and reloaded')
    return c.json({ ok: true, configured: !!serverConfig.authToken })
  })

  // Test connection dverify a token + baseUrl can reach the API, WITHOUT
  // depending on the user having configured a valid model yet (the natural
  // flow is token/URL first, model second) and WITHOUT spending tokens.
  //
  // The trick: POST /v1/messages with a deliberately-invalid sentinel model.
  // Auth happens before the body's model is validated, and the bogus model is
  // rejected before any inference runs dso this round-trips for free.
  //
  // Classifying the response is the subtle part. The status code ALONE is not
  // enough: the official API returns 404 `not_found_error` for an invalid
  // model, while a mistyped Base URL ALSO returns 404 dbut from a gateway, as
  // HTML, not an Anthropic error envelope. So we key on the BODY shape:
  //   - network error / timeout            — baseUrl unreachable
  //   - auth rejection (401/403, or an
  //     Anthropic authentication/permission
  //     error type)                        — token is wrong
  //   - a structured API response (2xx, OR
  //     a JSON error envelope with an
  //     error.message dincl. our sentinel
  //     model bouncing as 400/404)         — we reached the API: token + URL OK
  //   - 404 with a non-API body (HTML,
  //     empty, plain text)                 — wrong Base URL / path
  //   - anything else                      — surface it verbatim (ambiguous)
  const SENTINEL_MODEL = '__claude_react_web_connection_test__'
  app.post('/config/test-connection', async (c) => {
    const body = await safeJson<{ authToken?: string; baseUrl?: string }>(c.req)
    const token = body.authToken?.trim() || serverConfig.authToken
    if (!token) throw new HttpError(400, 'No auth token to test denter one or save your config first')
    const baseUrl = (body.baseUrl?.trim() || serverConfig.baseUrl).replace(/\/+$/, '')

    // SSRF protection: reject private IPs, metadata endpoints, and
    // non-standard ports before making the outbound request.
    const ssrfCheck = await validateOutboundUrl(baseUrl)
    if (!ssrfCheck.ok) {
      return c.json({ ok: false, error: ssrfCheck.error }, 400)
    }

    log.info(`test-connection baseUrl=${baseUrl}`)
    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: SENTINEL_MODEL,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(15_000),
      })

      // Parse the body once. An Anthropic-compatible API (official or proxy)
      // answers errors as JSON `{ error: { type, message } }`; a misrouted
      // request hits a gateway that answers with HTML or plain text.
      const text = await res.text().catch(() => '')
      let envelope: { error: { type: string; message: string } } | null = null
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object') envelope = parsed
      } catch { /* non-JSON body (e.g. gateway HTML) */ }
      const errType = envelope?.error?.type
      const errMsg = envelope?.error?.message

      // Auth failure: trust the HTTP status (401/403) and the Anthropic error
      // type. These are decided before the model is looked at.
      if (res.status === 401 || res.status === 403
        || errType === 'authentication_error' || errType === 'permission_error') {
        return c.json({ ok: false, status: res.status, error: 'Invalid auth token', baseUrl })
      }

      // A 2xx, or any structured Anthropic-style error (has error.message),
      // means we authenticated and the API processed the request dwhich is
      // exactly what "is this token + URL usable" asks. The sentinel model
      // bouncing (400 on the proxy, 404 not_found on the official API) lands
      // here.
      if (res.ok || errMsg) {
        return c.json({ ok: true, baseUrl })
      }

      // No API envelope. A 404 here is a mistyped Base URL hitting a gateway.
      if (res.status === 404) {
        return c.json({ ok: false, status: 404, error: 'Endpoint not found dcheck the Base URL', baseUrl })
      }

      // Anything else (e.g. a 5xx HTML gateway error) is ambiguous dsurface
      // the status so the user can diagnose it.
      return c.json({ ok: false, status: res.status, error: `Unexpected response (HTTP ${res.status})`, baseUrl })
    } catch (e) {
      const err = e as Error
      const msg = err.name === 'TimeoutError' || err.name === 'AbortError'
        ? 'Request timed out after 15s'
        : `Could not reach ${baseUrl} (${err.message || 'network error'})`
      log.warn(`test-connection failed: ${msg}`)
      return c.json({ ok: false, error: msg, baseUrl })
    }
  })

  // Read defaults from ~/.claude/settings.json so the setup page can
  // pre-fill the token, base URL, and model list fields.
  app.get('/config/claude-defaults', async (c) => {
    const settingsPath = joinPath(homedir(), '.claude', 'settings.json')
    try {
      const raw = JSON.parse(await readFile(settingsPath, 'utf8'))
      const env = raw?.env ?? {}
      const key = typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : undefined

      // Claude Code stores concrete model ids under env.ANTHROPIC_DEFAULT_*_MODEL
      // and names the active one via the top-level `model` alias (opus/sonnet/
      // haiku). Surface those ids as the setup model list, ordered so the
      // alias name by `model` lands first (? becomes the session default).
      const aliasEnvVar: Record<string, unknown> = {
        opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      }
      const baseOrder = ['opus', 'sonnet', 'haiku']
      const topAlias = typeof raw.model === 'string' ? raw.model.toLowerCase() : undefined
      const order = topAlias && baseOrder.includes(topAlias)
        ? [topAlias, ...baseOrder.filter((a) => a !== topAlias)]
        : baseOrder
      const modelList = order
        .map((a) => aliasEnvVar[a])
        .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        .map((m) => m.trim())

      return c.json({
        hasKey: !!key,
        keySuffix: key ? key.slice(-4) : undefined,
        baseUrl: typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : undefined,
        modelList: modelList.length > 0 ? modelList : undefined,
      })
    } catch {
      log.debug('claude-defaults: settings.json not found or unreadable')
      return c.json({})
    }
  })

  // Full config dreturns every field the UI needs for the settings modal.
  app.get('/config/full', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const raw = await readConfigFile(configDir)
    const token = (raw.authToken as string) ?? serverConfig.authToken
    return c.json({
      configured: !!serverConfig.authToken,
      authTokenMasked: token ? '****' + token.slice(-4) : undefined,
      baseUrl: serverConfig.baseUrl,
      modelList: serverConfig.modelList as string[],
      recapModel: serverConfig.recapModel,
      commitMessageModel: serverConfig.commitMessageModel,
      maxUploadBytes: serverConfig.maxUploadBytes,
      historyCap: serverConfig.historyCap,
      maxOpenPanels: serverConfig.maxOpenPanels,
      workingStuckMs: serverConfig.workingStuckMs,
      updateCheckRegistry: serverConfig.updateCheckRegistry,
      skillLoadMode: serverConfig.skillLoadMode,
      enabledSkills: serverConfig.enabledSkills,
      showPinnedUserMessage: serverConfig.showPinnedUserMessage,
      autoRecap: serverConfig.autoRecap,
      defaults: {
        cwd: process.cwd(),
        model: serverConfig.defaultModel,
      },
    })
  })

  // 鈹€鈹€ Runtime log config 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // Applied to the in-memory logger immediately AND persisted to config.json
  // so the chosen level/scopes survive restarts. Boot-time precedence:
  // LOG_LEVEL / LOG_SCOPES env vars (per-launch override) > persisted
  // config.json value > built-in default ('info' / all scopes).
  app.get('/log', (c) => {
    return c.json({
      ...getLogConfig(),
      availableLevels: LOG_LEVELS,
    })
  })

  app.put('/log', async (c) => {
    const body = await safeJson<{ level?: string; scopes?: string[] | null }>(c.req)
    if (body && typeof body !== 'object') {
      throw new HttpError(400, 'Body must be a JSON object')
    }
    const update: { level?: LogLevel; scopes?: string[] | null } = {}
    if (body.level != null) {
      if (typeof body.level !== 'string' || !LOG_LEVELS.includes(body.level as LogLevel)) {
        throw new HttpError(400, `level must be one of: ${LOG_LEVELS.join(', ')}`)
      }
      update.level = body.level as LogLevel
    }
    if (body.scopes !== undefined) {
      if (body.scopes !== null && !Array.isArray(body.scopes)) {
        throw new HttpError(400, 'scopes must be an array of strings or null')
      }
      if (Array.isArray(body.scopes) && !body.scopes.every((s) => typeof s === 'string')) {
        throw new HttpError(400, 'scopes must contain only strings')
      }
      update.scopes = body.scopes
    }
    const next = setLogConfig(update)
    // Persist so the choice survives restarts. Mirror the in-memory keys
    // onto the config.json keys (logLevel / logScopes). Only write the
    // dimensions the caller actually touche?.
    if (configDir && (update.level !== undefined || update.scopes !== undefined)) {
      const persist: Record<string, unknown> = {}
      if (update.level !== undefined) persist.logLevel = next.level
      if (update.scopes !== undefined) persist.logScopes = next.scopes
      await updateConfigFile(configDir, persist)
    }
    return c.json({ ...next, availableLevels: LOG_LEVELS })
  })

  // 鈹€鈹€ File logging toggle 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // Persisted in config.json so it survives restarts.

  app.get('/log/file', (c) => {
    return c.json({
      enabled: isFileLoggingEnabled(),
      path: getLogFilePath(),
    })
  })

  app.put('/log/file', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<{ enabled: unknown }>(c.req)
    if (!body || typeof body !== 'object') {
      throw new HttpError(400, 'Body must be a JSON object')
    }
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled must be a boolean')
    }
    if (body.enabled) {
      enableFileLogging(configDir)
    } else {
      disableFileLogging()
    }
    // Persist to config.json
    await updateConfigFile(configDir, { logToFile: body.enabled })
    return c.json({ enabled: isFileLoggingEnabled(), path: getLogFilePath() })
  })

  // Update config dmerges partial updates into config.json and hot-reloads.
  app.put('/config', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<Record<string, unknown>>(c.req)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'Body must be a JSON object')
    }
    // Detect whether the global skill policy is changing BEFORE the write
    // so we can re-fan-out only when it actually mutates. Reading from the
    // frozen config singleton is cheap and avoids a second disk read.
    const skillKeysTouched = 'skillLoadMode' in body || 'enabledSkills' in body
    const prevMode = serverConfig.skillLoadMode
    const prevEnabled = serverConfig.enabledSkills.slice()
    await updateConfigFile(configDir, body)
    log.info(`config updated keys=${Object.keys(body).join(',')}`)
    if (skillKeysTouched) {
      const changed = serverConfig.skillLoadMode !== prevMode
        || serverConfig.enabledSkills.length !== prevEnabled.length
        || serverConfig.enabledSkills.some((name, i) => name !== prevEnabled[i])
      if (changed) {
        // Best-effort fan-out: failures are reported per-session in the
        // result and never block the config save (the file is already on
        // disk; the user can retry the per-session toggle from the panel).
        void sm.reapplyGlobalSkillsToInheritingSessions().catch((err) => {
          log.warn(`reapplyGlobalSkillsToInheritingSessions failed: ${(err as Error).message}`)
        })
      }
    }
    return c.json({ ok: true, configured: !!serverConfig.authToken })
  })

  return app
}
