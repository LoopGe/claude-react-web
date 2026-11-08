import { createLogger } from '../../log.js'
import { parseSseStream, type SseEvent } from './sse.js'
import type { CanonicalEvent } from './canonical.js'

const log = createLogger('native-stream')

export const MAX_API_RETRIES = 10
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 60_000

export interface StreamRequest {
  baseUrl: string
  authToken: string
  model: string
  system: string
  tools: unknown[]
  messages: unknown[]
  maxTokens: number
  signal: AbortSignal
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
      const cb = d.content_block as { type: string; id?: string; name?: string }
      const block = cb.type === 'tool_use'
        ? { type: 'tool_use' as const, id: cb.id!, name: cb.name! }
        : cb.type === 'thinking' ? { type: 'thinking' as const } : { type: 'text' as const }
      return { kind: 'block_start', index: d.index as number, block, raw: d }
    }
    case 'content_block_delta': {
      const delta = d.delta as { type: string; text?: string; thinking?: string; partial_json?: string }
      const cd = delta.type === 'text_delta'
        ? { type: 'text' as const, text: delta.text ?? '' }
        : delta.type === 'thinking_delta'
          ? { type: 'thinking' as const, thinking: delta.thinking ?? '' }
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
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          stream: true,
          system: req.system,
          tools: req.tools,
          messages: req.messages,
        }),
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
