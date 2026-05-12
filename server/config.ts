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
  /** Maximum file upload size in bytes (default 25 MB). */
  maxUploadBytes?: number
  /** Session idle timeout in milliseconds (default 30 min). */
  sessionIdleMs?: number
  /** History ring cap — max messages kept in memory per session. */
  historyCap?: number
  /** Context-window size presets shown in the new-session dialog.
   *  Each entry is { value: number, label: string, beta?: string }. */
  contextSteps?: Array<{ value: number; label: string; beta?: string }>
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

/** Maximum file upload size in bytes (default 25 MB).
 *  Overridden by `maxUploadBytes` in config.json. */
export let MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Session idle timeout in milliseconds (default 30 min).
 *  Overridden by `sessionIdleMs` in config.json. */
export let SESSION_IDLE_MS = 30 * 60 * 1000

/** History ring cap — max messages kept in memory per session.
 *  Overridden by `historyCap` in config.json. */
export let HISTORY_CAP = 500

/** Context-window size presets for the new-session dialog.
 *  Overridden by `contextSteps` in config.json. */
export interface ContextStep {
  value: number
  label: string
  beta?: string
}
export let CONTEXT_STEPS: ContextStep[] = [
  { value: 100_000,   label: '100k' },
  { value: 200_000,   label: '200k' },
  { value: 256_000,   label: '256k' },
  { value: 512_000,   label: '512k' },
  { value: 1_000_000, label: '1M', beta: 'context-1m-2025-08-07' },
]

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

  if (typeof cfg.maxUploadBytes === 'number' && cfg.maxUploadBytes > 0) {
    MAX_UPLOAD_BYTES = Math.round(cfg.maxUploadBytes)
    console.log(`[config] maxUploadBytes: ${MAX_UPLOAD_BYTES}`)
  }

  if (typeof cfg.sessionIdleMs === 'number' && cfg.sessionIdleMs > 0) {
    SESSION_IDLE_MS = Math.round(cfg.sessionIdleMs)
    console.log(`[config] sessionIdleMs: ${SESSION_IDLE_MS}`)
  }

  if (typeof cfg.historyCap === 'number' && cfg.historyCap > 0) {
    HISTORY_CAP = Math.round(cfg.historyCap)
    console.log(`[config] historyCap: ${HISTORY_CAP}`)
  }

  if (Array.isArray(cfg.contextSteps) && cfg.contextSteps.length > 0) {
    const valid = cfg.contextSteps.filter(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        typeof s.value === 'number' &&
        s.value > 0 &&
        typeof s.label === 'string' &&
        s.label.trim(),
    )
    if (valid.length > 0) {
      CONTEXT_STEPS = valid.map((s) => ({
        value: Math.round(s.value),
        label: s.label.trim(),
        beta: typeof s.beta === 'string' && s.beta.trim() ? s.beta.trim() : undefined,
      }))
      console.log(`[config] loaded ${CONTEXT_STEPS.length} context step(s) from ${file}`)
    }
  }
}
