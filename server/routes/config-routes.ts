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
import { maskToken } from '../profiles.js'

export function buildConfigRouter(sm: SessionManager, configDir?: string): Hono {
  const app = new Hono()

  // Config setup — write authToken/baseUrl/model fields to config.json and
  // hot-reload. Accepts optional modelList / recapModel / commitMessageModel
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

    if (Array.isArray(existing.profiles) && existing.profiles.length > 0) {
      // Post-migration: write setup fields into profiles[0]. The top-level
      // authToken/baseUrl/model* keys are derived from the active profile
      // on load, so writing them top-level would be silently ignored.
      const profilesArr = existing.profiles as unknown[]
      const p0 = { ...(profilesArr[0] as Record<string, unknown>) }
      if (body.authToken?.trim()) {
        p0.authToken = body.authToken.trim()
      } else if (!p0.authToken) {
        throw new HttpError(400, 'authToken is required')
      }
      if (body.baseUrl?.trim()) {
        p0.baseUrl = body.baseUrl.trim().replace(/\/+$/, '')
      }
      if (Array.isArray(body.modelList) && body.modelList.length > 0) {
        p0.modelList = body.modelList.filter((m) => typeof m === 'string' && m.trim())
      }
      if (typeof body.recapModel === 'string') {
        p0.recapModel = body.recapModel.trim() || undefined
      }
      if (typeof body.commitMessageModel === 'string') {
        p0.commitMessageModel = body.commitMessageModel.trim() || undefined
      }
      profilesArr[0] = p0
    } else {
      // Legacy: top-level writes (migration folds them into profiles[0] on load).
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
    }
    if (typeof body.updateCheckRegistry === 'string') {
      // Persist verbatim (trimmed) — empty string is a valid value meaning
      // "update checks disabled", so we write it rather than dropping it.
      existing.updateCheckRegistry = body.updateCheckRegistry.trim()
    }
    await writeAtomic(configDir, configPath, existing)
    await loadConfig(configDir)
    log.info('config/setup saved and reloaded')
    return c.json({ ok: true, configured: !!serverConfig.authToken })
  })

  // Test connection — verify a token + baseUrl can reach the API, WITHOUT
  // depending on the user having configured a valid model yet (the natural
  // flow is token/URL first, model second) and WITHOUT spending tokens.
  //
  // The trick: POST /v1/messages with a deliberately-invalid sentinel model.
  // Auth happens before the body's model is validated, and the bogus model is
  // rejected before any inference runs — so this round-trips for free.
  //
  // Classification (auth vs. wrong-base-url vs. success) lives in the shared
  // `testConnection` helper (server/config-test-connection.ts) so the new
  // POST /profiles/:id/test route reuses the exact same probe + outcome.
  app.post('/config/test-connection', async (c) => {
    const body = await safeJson<{ authToken?: string; baseUrl?: string }>(c.req)
    const token = body.authToken?.trim() || serverConfig.authToken
    if (!token) throw new HttpError(400, 'No auth token to test — enter one or save your config first')
    const baseUrl = (body.baseUrl?.trim() || serverConfig.baseUrl).replace(/\/+$/, '')
    const { testConnection } = await import('../config-test-connection.js')
    const result = await testConnection(token, baseUrl)
    return c.json(result.body, result.status)
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

  // Full config — returns every field the UI needs for the settings modal.
  app.get('/config/full', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const raw = await readConfigFile(configDir)
    const token = (raw.authToken as string) ?? serverConfig.authToken
    return c.json({
      configured: !!serverConfig.authToken,
      authTokenMasked: token ? '****' + token.slice(-4) : undefined,
      baseUrl: serverConfig.baseUrl,
      modelList: serverConfig.modelList as string[],
      modelGroups: serverConfig.modelGroups,
      recapModel: serverConfig.recapModel,
      commitMessageModel: serverConfig.commitMessageModel,
      profiles: serverConfig.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        authTokenMasked: maskToken(p.authToken),
        baseUrl: p.baseUrl,
        modelList: p.modelList,
        modelGroups: p.modelGroups,
        recapModel: p.recapModel,
        commitMessageModel: p.commitMessageModel,
        isActive: p.id === serverConfig.activeProfileId,
      })),
      activeProfileId: serverConfig.activeProfileId,
      maxUploadBytes: serverConfig.maxUploadBytes,
      historyCap: serverConfig.historyCap,
      maxOpenPanels: serverConfig.maxOpenPanels,
      workingStuckMs: serverConfig.workingStuckMs,
      updateCheckRegistry: serverConfig.updateCheckRegistry,
      skillLoadMode: serverConfig.skillLoadMode,
      enabledSkills: serverConfig.enabledSkills,
      showPinnedUserMessage: serverConfig.showPinnedUserMessage,
      autoRecap: serverConfig.autoRecap,
      allowSensitivePathEdits: serverConfig.allowSensitivePathEdits,
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
    // dimensions the caller actually touched.
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
    const body = await safeJson<{ enabled?: unknown }>(c.req)
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

  // Update config — merges partial updates into config.json and hot-reloads.
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
