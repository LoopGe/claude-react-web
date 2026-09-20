// Shared Anthropic Messages API caller for the small handful of server
// features that need an LLM round-trip (recap, commit-message). Both
// previously hand-rolled the same fetch + auth + 30s-timeout + response
// parsing — extracting it here keeps the contract (auth header shape,
// version pin, error format) in one place. Callers do their own
// post-processing (regex trims, fence stripping) since each prompt's
// quirks are unique enough not to be worth abstracting further.

import { config as serverConfig, requireAuthToken } from './config.js'
import { HttpError } from './errors.js'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'

const log = createLogger('anthropic-api')

/** Endpoint + credential + model for ONE auxiliary LLM call, resolved per
 *  session.
 *
 *  These calls must follow the SESSION's profile, not the globally active
 *  one: a session pinned to a non-active profile runs its CLI subprocess on
 *  that profile's subscription (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
 *  come from `effectiveProfileFor(session.profileId)`), so sending its recap
 *  through the active profile's endpoint would put one profile's model id on
 *  another profile's URL — a 401/404 for every gateway. Callers with no
 *  session context omit `target` and get the global config; the only such
 *  caller is the app-plugin AI broker, and only for a plugin request that
 *  carries no `sessionId` (see server/app-plugins/host/ai-broker.ts). */
export interface AuxLlmTarget {
  /** Fully resolved model. For recap / commit message it is the session
   *  profile's own override, else the session's model group haiku tier, else
   *  the session's model; for the classifier, the global autoClassifierModel
   *  (only on the active profile) → the same tier chain. */
  model?: string
  baseUrl: string
  authToken: string
}

interface CallOptions {
  model: string
  system: string
  /** Single-turn user message. Required unless `messages` is provided. */
  userContent?: string
  maxTokens: number
  temperature: number
  /** Optional caller signal. If omitted, a 30s timeout signal is used. */
  signal?: AbortSignal
  /** Multi-turn messages. When provided, takes precedence over userContent.
   *  Used by the auto-mode classifier which needs conversation context. */
  messages?: Array<{ role: string; content: string }>
  /** Metrics label for the observability histogram — which server feature
   *  is calling. Finite enum: 'recap' | 'commit-message' | 'auto-classifier'
   *  | 'compact-summary' | 'app-plugin-ai' | 'unknown'. */
  caller?: string
  /** Per-session endpoint + credential. See AuxLlmTarget. */
  target?: AuxLlmTarget
}

/** POST /v1/messages with a single-turn user message. Returns the raw
 *  text from the first content block. Throws on non-2xx, network errors,
 *  timeout, or empty content — callers wrap in try/catch when they want
 *  a graceful fallback path. */
export async function callAnthropicMessages(opts: CallOptions): Promise<string> {
  // Guard, not a fallback: every caller resolves its model from a config
  // setting that is EMPTY by default ('' = "use the session's model"), so a
  // missed fallback would otherwise post `model: ''` and surface as an
  // opaque 400 from whatever the baseUrl points at. All four callers either
  // resolve a model before calling or catch the throw, so failing here is
  // strictly better than round-tripping a request that cannot succeed.
  if (!opts.model) throw new Error(`no model resolved for the ${opts.caller ?? 'unknown'} call`)
  const baseUrl = opts.target?.baseUrl ?? serverConfig.baseUrl
  // A session-scoped call authenticates with ITS profile's token; only a
  // caller with no session falls back to the global `authToken`.
  let token: string
  if (opts.target) {
    token = opts.target.authToken
    if (!token) {
      throw new HttpError(
        401,
        `no authToken for the ${opts.caller ?? 'unknown'} call — the session's profile has none configured`,
      )
    }
  } else {
    token = requireAuthToken()
  }
  const start = Date.now()
  log.debug(`request model=${opts.model} baseUrl=${baseUrl} maxTokens=${opts.maxTokens}`)
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        system: opts.system,
        messages: opts.messages ?? [{ role: 'user', content: opts.userContent }],
      }),
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log.error(`api error status=${res.status} elapsed=${Date.now() - start}ms model=${opts.model} baseUrl=${baseUrl} body=${body.slice(0, 200)}`)
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
    const text = data.content?.[0]?.text
    if (!text) {
      log.error(`empty response elapsed=${Date.now() - start}ms model=${opts.model} baseUrl=${baseUrl}`)
      throw new Error('Empty response from Anthropic API')
    }
    log.info(`success model=${opts.model} baseUrl=${baseUrl} elapsed=${Date.now() - start}ms textLen=${text.length}`)
    return text
  } finally {
    // Records ALL outcomes — success, HTTP error, empty response, AND a
    // thrown fetch (network failure / 30s timeout), which never reaches the
    // branches above.
    metrics.observe('anthropic_api_ms', Date.now() - start, { caller: opts.caller ?? 'unknown' })
  }
}
