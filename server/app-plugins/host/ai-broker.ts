// AI broker — lets a plugin request a completion through the host's Anthropic
// credentials, WITHOUT ever exposing the auth token to the subprocess.
//
// Reuses server/anthropic-api.ts `callAnthropicMessages` (same auth header,
// version pin, timeout as recap + commit-message). The plugin supplies a
// `purpose` (audited), system prompt, and messages; the host sets the model
// (from server config) and caps max_tokens. The response returns only the
// generated text + the model used — never the token, never raw headers.

import { callAnthropicMessages } from '../../anthropic-api.js'
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
  model?: string
  maxTokens?: number
}

export interface AiRequestResult {
  content: string
  model: string
  usage?: { inputTokens: number; outputTokens: number }
}

export class AiBroker {
  constructor(private readonly perm: PermissionChecker) {}

  async request(opts: AiRequestOptions): Promise<AiRequestResult> {
    this.perm.assert('ai.request', undefined, opts.purpose)

    if (!Array.isArray(opts.messages) || opts.messages.length === 0) {
      throw new Error('ai.request requires at least one message')
    }
    if (opts.messages.length > MAX_MESSAGES) throw new Error(`too many messages (max ${MAX_MESSAGES})`)
    const messages = opts.messages.map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_MESSAGE_CHARS),
    }))
    const model = opts.model ?? serverConfig.defaultModel ?? 'claude-sonnet-5'
    const maxTokens = Math.min(opts.maxTokens ?? 1024, MAX_TOKENS_CAP)

    log.info(`ai.request purpose=${opts.purpose} model=${model} msgs=${messages.length}`)
    // callAnthropicMessages returns the first text block; usage isn't
    // surfaced by the shared caller, so it's omitted from the result.
    const content = await callAnthropicMessages({
      model,
      system: opts.system ?? '',
      messages,
      maxTokens,
      temperature: 0,
    })
    return { content, model }
  }
}
