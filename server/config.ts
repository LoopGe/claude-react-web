// Server-side configuration defaults.
//
// Configuration is loaded from <stateDir>/config.json (default
// ~/.claude-react-web/config.json). CLI flags (--model) take priority
// over the config file; hardcoded defaults are the final fallback.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** Schema for config.json */
interface ConfigFile {
  /** Available models. The first entry is the default for new sessions. */
  modelList?: string[]
  /** Lightweight model used for session recap generation. */
  recapModel?: string
}

/** Available models for new sessions. The first entry is the default.
 *  Overridden by `modelList` in config.json. */
export let MODEL_LIST: string[] = [
  'anthropic/claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-haiku-3-5-20241022',
]

/** The first model in the list is the default. */
export let DEFAULT_MODEL = MODEL_LIST[0]

/** Model used for session recap generation (lightweight, fast).
 *  Overridden by `recapModel` in config.json. */
export let RECAP_MODEL = 'claude-haiku-3-5-20241022'

/** Maximum file upload size in bytes (default 25 MB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Session idle timeout in milliseconds (default 30 min). */
export const SESSION_IDLE_MS = 30 * 60 * 1000

/** History ring cap — max messages kept in memory per session. */
export const HISTORY_CAP = 500

/**
 * Load config from `<stateDir>/config.json`, updating the exported
 * variables in-place. If the file is missing or malformed, defaults
 * are used silently.
 */
export async function loadConfig(stateDir: string): Promise<void> {
  const file = join(stateDir, 'config.json')
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return // file doesn't exist — keep defaults
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

  const cfg = parsed as ConfigFile

  if (Array.isArray(cfg.modelList) && cfg.modelList.length > 0) {
    const models = cfg.modelList.filter((m) => typeof m === 'string' && m.trim())
    if (models.length > 0) {
      MODEL_LIST = models
      DEFAULT_MODEL = models[0]
      console.log(`[config] loaded ${models.length} model(s) from ${file}, default: ${DEFAULT_MODEL}`)
    }
  }

  if (typeof cfg.recapModel === 'string' && cfg.recapModel.trim()) {
    RECAP_MODEL = cfg.recapModel.trim()
  }
}
