// Config-related routes: setup, defaults, full config, update.

import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import { homedir } from 'node:os'
import { SessionManager } from '../session-manager.js'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import { config as serverConfig, loadConfig, readConfigFile, updateConfigFile } from '../config.js'
import {
  LOG_LEVELS, getLogConfig, setLogConfig, type LogLevel,
  enableFileLogging, disableFileLogging, isFileLoggingEnabled, getLogFilePath,
} from '../log.js'
import { writeAtomic } from '../json-file-store.js'

export function buildConfigRouter(_sm: SessionManager, configDir?: string): Hono {
  const app = new Hono()

  // Config setup — write authToken/baseUrl to config.json and hot-reload.
  app.post('/config/setup', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<{ authToken?: string; baseUrl?: string }>(c.req)
    if (!body.authToken?.trim()) throw new HttpError(400, 'authToken is required')
    const configPath = joinPath(configDir, 'config.json')
    let existing: Record<string, unknown> = {}
    try {
      existing = JSON.parse(await readFile(configPath, 'utf8'))
    } catch { /* file may not exist */ }
    existing.authToken = body.authToken.trim()
    if (body.baseUrl?.trim()) {
      existing.baseUrl = body.baseUrl.trim().replace(/\/+$/, '')
    }
    await writeAtomic(configDir, configPath, existing)
    await loadConfig(configDir)
    return c.json({ ok: true, configured: !!serverConfig.authToken })
  })

  // Read defaults from ~/.claude/settings.json so the setup page can
  // pre-fill the token and base URL fields.
  app.get('/config/claude-defaults', async (c) => {
    const settingsPath = joinPath(homedir(), '.claude', 'settings.json')
    try {
      const raw = JSON.parse(await readFile(settingsPath, 'utf8'))
      const env = raw?.env ?? {}
      const key = typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : undefined
      return c.json({
        authToken: key ? '****' + key.slice(-4) : undefined,
        baseUrl: typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : undefined,
      })
    } catch {
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
      recapModel: serverConfig.recapModel,
      maxUploadBytes: serverConfig.maxUploadBytes,
      historyCap: serverConfig.historyCap,
      maxOpenPanels: serverConfig.maxOpenPanels,
      workingStuckMs: serverConfig.workingStuckMs,
      defaults: {
        cwd: process.cwd(),
        model: serverConfig.defaultModel,
      },
    })
  })

  // ── Runtime log config ─────────────────────────────────────────────
  // In-memory only — does NOT persist across restarts. Boot-time defaults
  // come from LOG_LEVEL / LOG_SCOPES env vars. The UI exposes this so a
  // user can flip levels mid-debug without restarting the server.
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
    return c.json({ ...next, availableLevels: LOG_LEVELS })
  })

  // ── File logging toggle ──────────────────────────────────────────
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
    await updateConfigFile(configDir, body)
    return c.json({ ok: true, configured: !!serverConfig.authToken })
  })

  return app
}
