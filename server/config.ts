// Server-side configuration defaults.
//
// All values can be overridden via environment variables. This file
// centralises hardcoded strings so they're easy to find and change.

/** Available models for new sessions. The first entry is the default.
 *  Override: `DEFAULT_MODELS` env var (comma-separated).
 *  Example: DEFAULT_MODELS="claude-opus-4-20250514,claude-sonnet-4-20250514" */
export const MODEL_LIST: string[] = (() => {
  const env = process.env.DEFAULT_MODELS
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean)
  return [
    'anthropic/claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-3-5-20241022',
  ]
})()

/** The first model in the list is the default. */
export const DEFAULT_MODEL = MODEL_LIST[0]

/** Model used for session recap generation (lightweight, fast).
 *  Override: `RECAP_MODEL` env var. */
export const RECAP_MODEL = process.env.RECAP_MODEL ?? 'claude-haiku-3-5-20241022'

/** Maximum file upload size in bytes (default 25 MB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Session idle timeout in milliseconds (default 30 min). */
export const SESSION_IDLE_MS = 30 * 60 * 1000

/** History ring cap — max messages kept in memory per session. */
export const HISTORY_CAP = 500
