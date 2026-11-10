import { createLogger } from '../../log.js'
import { effortLevelsForModel, supportsFastModeForModel, supportsThinkingForModel } from '../../effort-capability.js'
import type { ThinkingDisplay, ThinkingSetting } from '../../../shared/session-info.js'
import { parseSseStream, type SseEvent } from './sse.js'
import type { CanonicalEvent } from './canonical.js'

const log = createLogger('native-stream')

export const MAX_API_RETRIES = 10
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 60_000

/** Extended-thinking token config for one request. `RequestThinking` IS the
 *  shared `ThinkingSetting` (the same type `SessionMeta.thinking` carries);
 *  `buildRequestBody` maps it to the wire's snake_case form. The display mode
 *  is NOT read from here — it travels as `StreamRequest.thinkingDisplay`, so
 *  the live control can distinguish "keep" from "reset". */
export type RequestThinking = ThinkingSetting

/** The API's reasoning-effort ladder (same union as the SDK's EffortLevel). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Runtime membership list for the union above — the live-control path
 *  validates against it so an invalid level fails loudly instead of being
 *  silently omitted from the request. */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The beta gate fast mode rides on. */
export const FAST_MODE_BETA = 'fast-mode-2026-02-01'

export interface StreamRequest {
  baseUrl: string
  authToken: string
  model: string
  system: string
  tools: unknown[]
  messages: unknown[]
  maxTokens: number
  thinking?: RequestThinking
  /** The session's display mode, tracked apart from the token config:
   *  undefined = API default, 'highlights' is a CLI-only value the API does
   *  not accept. Forwarded only when it is 'summarized' | 'omitted'. */
  thinkingDisplay?: ThinkingDisplay
  /** Reasoning effort. Model-gated at build time: a level the model does not
   *  support is OMITTED, never sent (the API answers 400 for it). */
  effort?: EffortLevel
  /** Fast-mode intent. Model-gated at build time, like `effort`: the
   *  `speed` field AND the beta header are omitted together. */
  fastMode?: boolean
  signal: AbortSignal
}

/** One decision point for fast mode: both the `speed: 'fast'` body field and
 *  the `anthropic-beta` header follow this answer, so a model switch can never
 *  leave half a fast-mode request behind. The family classification is the
 *  same one the UI chip uses (`effort-capability.ts`). */
function fastModeEnabled(req: StreamRequest): boolean {
  return req.fastMode === true && supportsFastModeForModel(req.model) === true
}

export interface AnthropicApiError extends Error {
  status: number
  retryable: boolean
  retryDelayMs?: number
}

export function apiError(status: number, body: string, retryAfterHeader?: string | null): AnthropicApiError {
  const retryable = status === 408 || status === 429 || status >= 500
  const headerMs = retryAfterHeader !== undefined && retryAfterHeader !== null && retryAfterHeader !== ''
    ? Number(retryAfterHeader) * 1_000
    : NaN
  const err = new Error(`Anthropic API ${status}: ${body.slice(0, 500)}`) as AnthropicApiError
  err.status = status
  err.retryable = retryable
  if (Number.isFinite(headerMs)) err.retryDelayMs = headerMs
  return err
}

export type RetryCallback = (info: { attempt: number; maxRetries: number; delayMs: number }) => Promise<void>

const EPHEMERAL = { type: 'ephemeral' } as const

const THINKING_MIN_BUDGET = 1024

/** The wire form of one thinking config. Bare `{type:'enabled'}` (no budget)
 *  has no valid wire form and maps to adaptive. `display` comes from the
 *  separately tracked session display and forwards only the API-supported
 *  'summarized' | 'omitted' — 'highlights' is a CLI-only value.
 *  The enabled budget is clamped to `[1024, max_tokens - 1]`; when
 *  `max_tokens <= 1024` that range is empty, so the budget is left as-is
 *  (1024 wins only when the upper bound is above it). */
function thinkingBody(
  thinking: RequestThinking,
  maxTokens: number,
  display?: ThinkingDisplay,
): Record<string, unknown> {
  if (thinking.type === 'disabled') return { type: 'disabled' }
  const extra = display === 'summarized' || display === 'omitted' ? { display } : {}
  if (thinking.type === 'adaptive' || thinking.budgetTokens === undefined) {
    return { type: 'adaptive', ...extra }
  }
  const budget = maxTokens > THINKING_MIN_BUDGET
    ? Math.max(THINKING_MIN_BUDGET, Math.min(thinking.budgetTokens, maxTokens - 1))
    : thinking.budgetTokens
  return { type: 'enabled', budget_tokens: budget, ...extra }
}

/** Build the Anthropic Messages request body, adding prompt-cache breakpoints
 *  on the stable prefix: system prompt, the last tool, and the last content
 *  block. Never mutates the caller's `tools` / `messages` — the agent loop
 *  reuses its history across turns. */
export function buildRequestBody(req: StreamRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: true,
    system: req.system,
    tools: req.tools,
    messages: req.messages,
  }

  // Thinking is gated on the model like effort and fast mode: a session
  // switched to a non-thinking model must stop sending the config, not get a
  // 400 from the API. Classification is the same model-id family rule the
  // client uses for the chip (`supportsThinkingForModel`).
  if (req.thinking && supportsThinkingForModel(req.model) === true) {
    body.thinking = thinkingBody(req.thinking, req.maxTokens, req.thinkingDisplay)
  }

  // Effort is a Claude-family feature, classified from the model id (the SDK's
  // own report is untrustworthy behind gateways — see effort-capability.ts).
  // An unsupported level is omitted rather than sent as a 400, so pinning
  // 'xhigh' survives a switch to a model that only offers 'max'.
  if (req.effort !== undefined && effortLevelsForModel(req.model)?.includes(req.effort)) {
    body.output_config = { effort: req.effort }
  }

  if (fastModeEnabled(req)) body.speed = 'fast'

  if (req.system !== '') {
    body.system = [{ type: 'text', text: req.system, cache_control: EPHEMERAL }]
  }

  if (req.tools.length > 0) {
    body.tools = req.tools.map((tool, i) =>
      i === req.tools.length - 1
        ? { ...(tool as Record<string, unknown>), cache_control: EPHEMERAL }
        : { ...(tool as Record<string, unknown>) })
  }

  if (req.messages.length > 0) {
    const last = req.messages[req.messages.length - 1] as Record<string, unknown>
    const content = last.content
    let cachedContent: unknown
    if (typeof content === 'string') {
      cachedContent = [{ type: 'text', text: content, cache_control: EPHEMERAL }]
    } else if (Array.isArray(content) && content.length > 0) {
      const blocks = content.slice()
      blocks[blocks.length - 1] = { ...(blocks[blocks.length - 1] as Record<string, unknown>), cache_control: EPHEMERAL }
      cachedContent = blocks
    }
    if (cachedContent !== undefined) {
      body.messages = [...req.messages.slice(0, -1), { ...last, content: cachedContent }]
    }
  }

  return body
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')) }, { once: true })
  })

/** Translate one raw Anthropic SSE event into canonical events (0 or 1).
 *  message_stop is dropped — message_end already closes the message. */
function translate(ev: SseEvent): CanonicalEvent | null {
  const d = ev.data as Record<string, unknown>
  switch (d.type) {
    case 'message_start': {
      const usage = (d.message as { usage?: Record<string, number> } | undefined)?.usage
      return usage ? { kind: 'message_start', usage, raw: d } : { kind: 'message_start', raw: d }
    }
    case 'content_block_start': {
      const cb = d.content_block as { type: string; id?: string; name?: string; data?: string }
      const block = cb.type === 'tool_use'
        ? { type: 'tool_use' as const, id: cb.id!, name: cb.name! }
        : cb.type === 'thinking'
          ? { type: 'thinking' as const }
          : cb.type === 'redacted_thinking' ? { type: 'redacted_thinking' as const, data: cb.data! } : { type: 'text' as const }
      return { kind: 'block_start', index: d.index as number, block, raw: d }
    }
    case 'content_block_delta': {
      const delta = d.delta as { type: string; text?: string; thinking?: string; signature?: string; partial_json?: string }
      const cd = delta.type === 'text_delta'
        ? { type: 'text' as const, text: delta.text ?? '' }
        : delta.type === 'thinking_delta'
          ? { type: 'thinking' as const, thinking: delta.thinking ?? '' }
          : delta.type === 'signature_delta'
            ? { type: 'signature' as const, signature: delta.signature ?? '' }
            : { type: 'tool_input' as const, json: delta.partial_json ?? '' }
      return { kind: 'block_delta', index: d.index as number, delta: cd, raw: d }
    }
    case 'content_block_stop':
      return { kind: 'block_end', index: d.index as number, raw: d }
    case 'message_delta': {
      const usage = d.usage as Record<string, number> | undefined
      return {
        kind: 'message_end',
        stopReason: (d.delta as { stop_reason?: string } | undefined)?.stop_reason ?? null,
        ...(usage ? { usage } : {}),
        raw: d,
      }
    }
    default:
      return null // message_stop, ping, unknown events
  }
}

/** Stream one Anthropic Messages response as canonical events. Retries
 *  retryable failures (429/5xx/network) up to MAX_API_RETRIES with
 *  exponential backoff; `onRetry` fires before each backoff wait. */
export async function* streamAnthropicMessages(req: StreamRequest, onRetry: RetryCallback): AsyncIterable<CanonicalEvent> {
  let attempt = 0
  for (;;) {
    let res: Response
    try {
      res = await fetch(`${req.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          Authorization: `Bearer ${req.authToken}`,
          ...(fastModeEnabled(req) ? { 'anthropic-beta': FAST_MODE_BETA } : {}),
        },
        body: JSON.stringify(buildRequestBody(req)),
        signal: req.signal,
      })
    } catch (err) {
      if (req.signal.aborted) throw err
      if (attempt < MAX_API_RETRIES) {
        attempt++
        const delayMs = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
        log.warn(`network error, retry ${attempt}/${MAX_API_RETRIES} in ${delayMs}ms`)
        await onRetry({ attempt, maxRetries: MAX_API_RETRIES, delayMs })
        await sleep(delayMs, req.signal)
        continue
      }
      throw err
    }
    if (res.ok && res.body) {
      for await (const ev of parseSseStream(res.body)) {
        const canonical = translate(ev)
        if (canonical) yield canonical
      }
      return
    }
    const body = await res.text().catch(() => '')
    const err = apiError(res.status, body, res.headers.get('retry-after'))
    if (err.retryable && attempt < MAX_API_RETRIES) {
      attempt++
      const delayMs = Math.min(BACKOFF_CAP_MS, err.retryDelayMs ?? BACKOFF_BASE_MS * 2 ** (attempt - 1))
      log.warn(`api ${res.status}, retry ${attempt}/${MAX_API_RETRIES} in ${delayMs}ms`)
      await onRetry({ attempt, maxRetries: MAX_API_RETRIES, delayMs })
      await sleep(delayMs, req.signal)
      continue
    }
    throw err
  }
}
