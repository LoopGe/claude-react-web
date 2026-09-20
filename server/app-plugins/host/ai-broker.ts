// AI broker — lets a plugin request a completion through the host's Anthropic
// credentials, WITHOUT ever exposing the auth token to the subprocess.
//
// Reuses server/anthropic-api.ts `callAnthropicMessages` (same auth header,
// version pin, timeout as recap + commit-message). The plugin supplies a
// `purpose` (audited), system prompt, and messages; the host sets the model and
// caps max_tokens. The response returns only the generated text + the model
// used — never the token, never raw headers.
//
// WHEN THE PLUGIN PASSES A `sessionId` the call is scoped to that session
// (SessionManager.auxTargetFor): its own profile's endpoint + token, and the
// session's aux model — a plugin invoked from a session pinned to a
// non-active profile must not spend the active one, nor send a model id that
// profile cannot route. Without a sessionId the call uses the host config
// (the active profile), which is all a background service with no session
// context can do.

import { callAnthropicMessages, type AuxLlmTarget } from '../../anthropic-api.js'
import { config as serverConfig } from '../../config.js'
import { createLogger } from '../../log.js'
import type { PermissionChecker } from '../permission-manager.js'

const log = createLogger('app-plugins:ai')

const MAX_TOKENS_CAP = 4096
const MAX_MESSAGES = 50
const MAX_MESSAGE_CHARS = 20_000

export interface AiRequestOptions {
  purpose: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Explicit model. Wins over the session's aux model — but the endpoint and
   *  token still come from the session, so the id must be one its provider
   *  serves. */
  model?: string
  maxTokens?: number
  /** The session whose profile should pay for this call, when the plugin has
   *  one in its command context (e.g. `context.sessionId`). */
  sessionId?: string
}

export interface AiRequestResult {
  content: string
  model: string
  usage?: { inputTokens: number; outputTokens: number }
}

export class AiBroker {
  constructor(
    private readonly perm: PermissionChecker,
    /** Session → endpoint + credential + aux model (see AuxLlmTarget).
     *  Required: a broker built without it would silently fall back to the
     *  global config for every session-scoped call. */
    private readonly auxTargetFor: (sessionId: string) => AuxLlmTarget | undefined,
  ) {}

  async request(opts: AiRequestOptions): Promise<AiRequestResult> {
    this.perm.assert('ai.request', undefined, opts.purpose)

    if (!Array.isArray(opts.messages) || opts.messages.length === 0) {
      throw new Error('ai.request requires at least one message')
    }
    if (opts.messages.length > MAX_MESSAGES) throw new Error(`too many messages (max ${MAX_MESSAGES})`)
    // Validate the payload shape here rather than letting a malformed plugin
    // body surface as an opaque INTERNAL_ERROR from `content.slice`, or as a
    // 400 from the API for a bogus role.
    const messages = opts.messages.map((m, i) => {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
        throw new Error(`messages[${i}].role must be 'user' or 'assistant'`)
      }
      if (typeof m.content !== 'string') throw new Error(`messages[${i}].content must be a string`)
      return { role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }
    })

    let target: AuxLlmTarget | undefined
    if (opts.sessionId) {
      if (typeof opts.sessionId !== 'string') throw new Error('sessionId must be a string')
      target = this.auxTargetFor(opts.sessionId)
      // Fail loudly: silently spending the ACTIVE profile because the session
      // id was stale is the exact mismatch this scoping removes.
      if (!target) throw new Error(`session not found: ${opts.sessionId}`)
    }
    // The session's model is authoritative once a session is in play: pairing
    // ITS endpoint + token with the ACTIVE profile's default model is the
    // cross-profile misroute this scoping exists to prevent (the other aux
    // call sites throw here too). Only a session-less call uses the host
    // config's default model.
    const model = opts.model ?? target?.model ?? (target ? '' : serverConfig.defaultModel ?? 'claude-sonnet-5')
    if (!model) throw new Error(`no model resolved for session ${opts.sessionId} — it has none and its profile serves none`)
    const maxTokens = Math.min(opts.maxTokens ?? 1024, MAX_TOKENS_CAP)

    log.info(`ai.request purpose=${opts.purpose} model=${model} msgs=${messages.length}`)
    // callAnthropicMessages returns the first text block; usage isn't
    // surfaced by the shared caller, so it's omitted from the result.
    const content = await callAnthropicMessages({
      model,
      target,
      system: opts.system ?? '',
      messages,
      maxTokens,
      temperature: 0,
      caller: 'app-plugin-ai',
    })
    return { content, model }
  }
}
