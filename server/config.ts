// Server-side configuration defaults.
//
// Configuration is loaded from <stateDir>/config.json (default
// ~/.claude-react-web/config.json). CLI flags (--model) take priority
// over the config file; hardcoded defaults are the final fallback.
//
// After loadConfig() runs the config object is frozen — mutation attempts
// throw at runtime, making the "load once" invariant explicit.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** Schema for config.json */
interface ConfigFile {
  modelList?: string[]
  recapModel?: string
  maxUploadBytes?: number
  historyCap?: number
  maxOpenPanels?: number
  /** Milliseconds of SDK silence before the session is considered stuck
   *  and auto-interrupted. Set to 0 to disable. Default: 1 hour. */
  workingStuckMs?: number
  /** Bearer token sent as `Authorization: Bearer <token>` to the API
   *  (works for both the official endpoint and Anthropic-compatible proxies).
   *  Required — server refuses to start without it. */
  authToken?: string
  /** API endpoint. Defaults to the official one. Override to point at a
   *  proxy / relay. No trailing slash expected; trimmed during load. */
  baseUrl?: string
}

export interface ServerConfig {
  readonly modelList: readonly string[]
  readonly defaultModel: string
  readonly recapModel: string
  readonly maxUploadBytes: number
  readonly historyCap: number
  readonly permissionTimeoutMs: number
  readonly workingStuckMs: number
  readonly maxOpenPanels: number
  /** Undefined until config.json is loaded and `authToken` is populated.
   *  `requireAuthToken()` throws if accessed before that. */
  readonly authToken?: string
  readonly baseUrl: string
}

/** Current server config. Frozen after loadConfig() — reads are safe,
 *  writes throw at runtime. */
export let config: ServerConfig = Object.freeze<ServerConfig>({
  modelList: Object.freeze([
    'anthropic/claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-3-5-20241022',
  ]),
  defaultModel: 'anthropic/claude-sonnet-4-20250514',
  recapModel: 'claude-haiku-4-5-20251001',
  maxUploadBytes: 25 * 1024 * 1024,
  historyCap: 500,
  permissionTimeoutMs: 5 * 60 * 1000,
  workingStuckMs: 60 * 60 * 1000,
  maxOpenPanels: 3,
  authToken: undefined,
  baseUrl: 'https://api.anthropic.com',
})

/** Return the configured auth token or throw. Use at request time so a
 *  missing token surfaces as an HTTP 500 rather than a silent fallback. */
export function requireAuthToken(): string {
  const token = config.authToken
  if (!token) {
    throw new Error(
      'authToken is not configured. Set `authToken` in config.json (and optionally `baseUrl`).',
    )
  }
  return token
}

/** Test-only: merge overrides into the current frozen config and re-freeze.
 *  Production code loads config via loadConfig(); tests call this to set
 *  authToken/baseUrl without writing a temp file. */
export function __setConfigForTest(overrides: Partial<ServerConfig>): void {
  config = Object.freeze({ ...config, ...overrides })
}

/**
 * Load config from `<stateDir>/config.json`, replacing the config object
 * with a frozen merge of defaults + file values. If the file is missing a
 * starter config is scaffolded; if it is malformed, defaults are used
 * silently.
 */
export async function loadConfig(stateDir: string): Promise<void> {
  const file = join(stateDir, 'config.json')
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    // File doesn't exist — scaffold a starter config so the user has a
    // concrete file to edit (fill in authToken, adjust models, etc.).
    try {
      await fs.mkdir(stateDir, { recursive: true })
      const scaffold = JSON.stringify(
        {
          authToken: '',
          baseUrl: 'https://api.anthropic.com',
          modelList: config.modelList.slice(),
          recapModel: config.recapModel,
          maxUploadBytes: config.maxUploadBytes,
          historyCap: config.historyCap,
          maxOpenPanels: config.maxOpenPanels,
        },
        null,
        2,
      )
      await fs.writeFile(file, scaffold, 'utf8')
      console.log(`[config] created ${file} — fill in authToken to get started`)
    } catch (err) {
      console.warn(`[config] could not scaffold ${file}:`, (err as Error).message)
    }
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(`[config] ${file} is not valid JSON, using defaults:`, (err as Error).message)
    return
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn(`[config] ${file} must be a JSON object, using defaults`)
    return
  }

  const file_ = parsed as ConfigFile
  const merged: ServerConfig = { ...config }

  if (Array.isArray(file_.modelList) && file_.modelList.length > 0) {
    const models = file_.modelList.filter((m) => typeof m === 'string' && m.trim())
    if (models.length > 0) {
      ;(merged as { modelList: readonly string[] }).modelList = Object.freeze(models)
      ;(merged as { defaultModel: string }).defaultModel = models[0]
      console.log(`[config] loaded ${models.length} model(s) from ${file}, default: ${merged.defaultModel}`)
    }
  }

  if (typeof file_.recapModel === 'string' && file_.recapModel.trim()) {
    ;(merged as { recapModel: string }).recapModel = file_.recapModel.trim()
  }

  if (typeof file_.maxUploadBytes === 'number' && file_.maxUploadBytes > 0) {
    ;(merged as { maxUploadBytes: number }).maxUploadBytes = Math.round(file_.maxUploadBytes)
    console.log(`[config] maxUploadBytes: ${merged.maxUploadBytes}`)
  }

  if (typeof file_.historyCap === 'number' && file_.historyCap > 0) {
    ;(merged as { historyCap: number }).historyCap = Math.round(file_.historyCap)
    console.log(`[config] historyCap: ${merged.historyCap}`)
  }

  if (typeof file_.maxOpenPanels === 'number' && file_.maxOpenPanels !== 0) {
    ;(merged as { maxOpenPanels: number }).maxOpenPanels = Math.max(2, Math.min(5, Math.round(file_.maxOpenPanels)))
    console.log(`[config] maxOpenPanels: ${merged.maxOpenPanels}`)
  }

  if (typeof file_.workingStuckMs === 'number' && file_.workingStuckMs >= 0) {
    ;(merged as { workingStuckMs: number }).workingStuckMs = Math.round(file_.workingStuckMs)
    console.log(`[config] workingStuckMs: ${merged.workingStuckMs}`)
  }

  if (typeof file_.authToken === 'string' && file_.authToken.trim()) {
    ;(merged as { authToken?: string }).authToken = file_.authToken.trim()
    // Never log the token itself — just confirm it's present.
    console.log('[config] authToken: configured')
  }

  if (typeof file_.baseUrl === 'string' && file_.baseUrl.trim()) {
    // Strip trailing slash so callers can always do `${baseUrl}/v1/...`.
    const trimmed = file_.baseUrl.trim().replace(/\/+$/, '')
    ;(merged as { baseUrl: string }).baseUrl = trimmed
    console.log(`[config] baseUrl: ${trimmed}`)
  }

  config = Object.freeze(merged)
}

/** Mutable fields the client is allowed to update via PUT /api/config. */
export const WRITABLE_CONFIG_KEYS = [
  'authToken',
  'baseUrl',
  'modelList',
  'recapModel',
  'maxUploadBytes',
  'historyCap',
  'maxOpenPanels',
  'workingStuckMs',
] as const

/**
 * Read the raw config.json from disk and return it. Returns an empty object
 * if the file doesn't exist or is malformed.
 */
export async function readConfigFile(stateDir: string): Promise<Record<string, unknown>> {
  const file = join(stateDir, 'config.json')
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch { /* ignore */ }
  return {}
}

/**
 * Merge partial updates into config.json on disk, then hot-reload the
 * in-memory config via loadConfig(). Only fields listed in
 * WRITABLE_CONFIG_KEYS are accepted.
 */
export async function updateConfigFile(
  stateDir: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const existing = await readConfigFile(stateDir)
  for (const key of WRITABLE_CONFIG_KEYS) {
    if (key in updates) {
      const val = updates[key]
      // Treat null / empty-string as "remove the override" (revert to default).
      if (val === null || val === '') {
        delete existing[key]
      } else {
        existing[key] = val
      }
    }
  }
  const file = join(stateDir, 'config.json')
  await fs.writeFile(file, JSON.stringify(existing, null, 2), 'utf8')
  await loadConfig(stateDir)
}
