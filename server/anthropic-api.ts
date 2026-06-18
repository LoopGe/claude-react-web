// Shared Anthropic Messages API caller for the small handful of server
// features that need an LLM round-trip (recap, commit-message). Both
// previously hand-rolled the same fetch + auth + 30s-timeout + response
// parsing — extracting it here keeps the contract (auth header shape,
// version pin, error format) in one place. Callers do their own
// post-processing (regex trims, fence stripping) since each prompt's
// quirks are unique enough not to be worth abstracting further.

import { config as serverConfig, requireAuthToken } from './config.js'
import { createLogger } from './log.js'

const log = createLogger('anthropic-api')

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
}

/** POST /v1/messages with a single-turn user message. Returns the raw
 *  text from the first content block. Throws on non-2xx, network errors,
 *  timeout, or empty content — callers wrap in try/catch when they want
 *  a graceful fallback path. */
export async function callAnthropicMessages(opts: CallOptions): Promise<string> {
  const token = requireAuthToken()
  const start = Date.now()
  log.debug(`request model=${opts.model} maxTokens=${opts.maxTokens}`)
  const res = await fetch(`${serverConfig.baseUrl}/v1/messages`, {
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
  const elapsed = Date.now() - start
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    log.error(`api error status=${res.status} elapsed=${elapsed}ms model=${opts.model} body=${body.slice(0, 200)}`)
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
  const text = data.content?.[0]?.text
  if (!text) {
    log.error(`empty response elapsed=${elapsed}ms model=${opts.model}`)
    throw new Error('Empty response from Anthropic API')
  }
  log.info(`success model=${opts.model} elapsed=${elapsed}ms textLen=${text.length}`)
  return text
}
