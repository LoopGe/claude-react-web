// Shared Anthropic Messages API caller for the small handful of server
// features that need an LLM round-trip (recap, commit-message, compact). Text-
// only calls retain the original JSON response path. Native image/document
// input uses streaming Messages with a 60-second no-data timeout so a large
// upload does not inherit the auxiliary caller's 30-second total wait.

import { config as serverConfig, requireAuthToken } from './config.js'
import { HttpError } from './errors.js'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'
import { LOG_PREVIEW_CAP } from './constants.js'

const log = createLogger('anthropic-api')
const STREAM_IDLE_TIMEOUT_MS = 60_000

/** Endpoint + credential + model for ONE auxiliary LLM call, resolved per
 *  session. See the session-manager's auxTargetFor for the profile/model chain. */
export interface AuxLlmTarget {
  model?: string
  baseUrl: string
  authToken: string
}

type AuxContent = string | unknown[]

interface CallOptions {
  model: string
  system: string
  /** Single-turn user message. Required unless `messages` is provided. */
  userContent?: AuxContent
  maxTokens: number
  temperature: number
  /** Optional caller signal. Text-only calls keep their 30s default. */
  signal?: AbortSignal
  /** Multi-turn messages. When provided, takes precedence over userContent. */
  messages?: Array<{ role: string; content: AuxContent }>
  /** Finite metrics label supplied by the feature caller. */
  caller?: string
  /** Per-session endpoint + credential. See AuxLlmTarget. */
  target?: AuxLlmTarget
}

function carriesNativeMedia(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesNativeMedia)
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { type?: unknown; content?: unknown }
  if (candidate.type === 'image' || candidate.type === 'document') return true
  return candidate.content !== undefined && carriesNativeMedia(candidate.content)
}

/** Resettable deadline for each network read, not for the whole response.
 * Aborting the fetch also reaches real Response readers; the rejection race
 * keeps the deadline authoritative for gateways/test readers that ignore it. */
class StreamIdleDeadline {
  readonly controller = new AbortController()
  private readonly onExternalAbort = () => this.controller.abort(this.external?.reason)

  constructor(private readonly external?: AbortSignal) {
    if (external?.aborted) this.onExternalAbort()
    else external?.addEventListener('abort', this.onExternalAbort, { once: true })
  }

  async run<T>(operation: Promise<T>): Promise<T> {
    if (this.controller.signal.aborted) throw this.controller.signal.reason
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Anthropic streaming response had no data for 60 seconds')
        this.controller.abort(error)
        reject(error)
      }, STREAM_IDLE_TIMEOUT_MS)
      timer.unref?.()
      const onAbort = () => reject(this.controller.signal.reason)
      this.controller.signal.addEventListener('abort', onAbort, { once: true })
      const cleanup = () => {
        clearTimeout(timer)
        this.controller.signal.removeEventListener('abort', onAbort)
      }
      operation.then(
        (value) => { cleanup(); resolve(value) },
        (err) => { cleanup(); reject(err) },
      )
    })
  }

  close(): void {
    this.external?.removeEventListener('abort', this.onExternalAbort)
  }
}

function firstTextBlock(content: Array<{ type?: string; text?: string }> | undefined): string | undefined {
  return (content ?? []).find((block) => typeof block?.text === 'string' && block.text)?.text
}

/** Incremental SSE parser. Text is grouped by content-block index so the first
 * non-empty text block wins, matching the JSON caller's reasoning-block rule. */
class AnthropicSseText {
  private buffer = ''
  private readonly textByIndex = new Map<number, string>()

  feed(chunk: string): void {
    this.buffer += chunk
    this.drain(false)
  }

  finish(): string {
    this.drain(true)
    for (const text of this.textByIndex.values()) {
      if (text) return text
    }
    throw new Error('Empty response from Anthropic API')
  }

  private drain(final: boolean): void {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (!match) break
      const event = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.consumeEvent(event)
    }
    if (final && this.buffer.trim()) {
      this.consumeEvent(this.buffer)
      this.buffer = ''
    }
  }

  private consumeEvent(event: string): void {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return
    const parsed = JSON.parse(data) as {
      type?: string
      index?: number
      delta?: { type?: string; text?: string }
      content_block?: { type?: string; text?: string }
      error?: { message?: string }
    }
    if (parsed.type === 'error') {
      throw new Error(`Anthropic API stream error: ${parsed.error?.message ?? 'unknown error'}`)
    }
    if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'text'
      && typeof parsed.content_block.text === 'string' && typeof parsed.index === 'number') {
      this.append(parsed.index, parsed.content_block.text)
    }
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta'
      && typeof parsed.delta.text === 'string' && typeof parsed.index === 'number') {
      this.append(parsed.index, parsed.delta.text)
    }
  }

  private append(index: number, text: string): void {
    this.textByIndex.set(index, (this.textByIndex.get(index) ?? '') + text)
  }
}

async function readStreamingText(res: Response, idle: StreamIdleDeadline): Promise<string> {
  if (!res.body) throw new Error('Empty streaming response from Anthropic API')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = new AnthropicSseText()
  for (;;) {
    const next = await idle.run(reader.read())
    if (next.done) break
    parser.feed(decoder.decode(next.value, { stream: true }))
  }
  parser.feed(decoder.decode())
  return parser.finish()
}

/** POST /v1/messages. Returns the first non-empty text block, skipping
 * reasoning blocks on Anthropic-compatible gateways. */
export async function callAnthropicMessages(opts: CallOptions): Promise<string> {
  if (!opts.model) throw new Error(`no model resolved for the ${opts.caller ?? 'unknown'} call`)
  const baseUrl = opts.target?.baseUrl ?? serverConfig.baseUrl
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
  const messages = opts.messages ?? [{ role: 'user', content: opts.userContent }]
  const streaming = messages.some((message) => carriesNativeMedia(message.content))
  const start = Date.now()
  log.debug(`request model=${opts.model} baseUrl=${baseUrl} maxTokens=${opts.maxTokens} streaming=${streaming}`)
  const idle = streaming ? new StreamIdleDeadline(opts.signal) : undefined
  try {
    const request = fetch(`${baseUrl}/v1/messages`, {
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
        messages,
        ...(streaming ? { stream: true } : {}),
      }),
      signal: idle?.controller.signal ?? opts.signal ?? AbortSignal.timeout(30_000),
    })
    const res = idle ? await idle.run(request) : await request
    if (!res.ok) {
      const body = idle ? await idle.run(res.text()) : await res.text().catch(() => '')
      log.error(`api error status=${res.status} elapsed=${Date.now() - start}ms model=${opts.model} baseUrl=${baseUrl} body=${body.slice(0, LOG_PREVIEW_CAP)}`)
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, LOG_PREVIEW_CAP)}`)
    }
    const text = idle
      ? await readStreamingText(res, idle)
      : firstTextBlock(((await res.json()) as { content?: Array<{ type?: string; text?: string }> }).content)
    if (!text) {
      log.error(`empty response elapsed=${Date.now() - start}ms model=${opts.model} baseUrl=${baseUrl}`)
      throw new Error('Empty response from Anthropic API')
    }
    log.info(`success model=${opts.model} baseUrl=${baseUrl} elapsed=${Date.now() - start}ms textLen=${text.length}`)
    return text
  } finally {
    idle?.close()
    metrics.observe('anthropic_api_ms', Date.now() - start, { caller: opts.caller ?? 'unknown' })
  }
}
