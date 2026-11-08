import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiError, MAX_API_RETRIES, streamAnthropicMessages, type StreamRequest } from './anthropic-stream.js'

const baseReq: StreamRequest = {
  baseUrl: 'https://api.example.com',
  authToken: 'tok',
  model: 'claude-sonnet-4-5',
  system: 'sys',
  tools: [],
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 1024,
  signal: new AbortController().signal,
}

function sseResponse(events: string[]): Response {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder()
      for (const e of events) c.enqueue(enc.encode(e))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('streamAnthropicMessages translation', () => {
  it('translates raw Anthropic SSE into canonical events, carrying raw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    ))
    const out = []
    for await (const ev of streamAnthropicMessages(baseReq, async () => {})) out.push(ev)
    expect(out).toEqual([
      { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 }, raw: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
      { kind: 'block_start', index: 0, block: { type: 'text' }, raw: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'hi' }, raw: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
      { kind: 'block_end', index: 0, raw: { type: 'content_block_stop', index: 0 } },
      { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 }, raw: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
      // message_stop maps to nothing — message_end already closed the message
    ])
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.example.com/v1/messages')
  })

  it('translates tool_use blocks with input_json_delta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      ]),
    ))
    const out = []
    for await (const ev of streamAnthropicMessages(baseReq, async () => {})) out.push(ev)
    expect(out).toEqual([
      { kind: 'block_start', index: 1, block: { type: 'tool_use', id: 't1', name: 'Bash' }, raw: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } } },
      { kind: 'block_delta', index: 1, delta: { type: 'tool_input', json: '{"command":' }, raw: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } } },
      { kind: 'block_end', index: 1, raw: { type: 'content_block_stop', index: 1 } },
    ])
  })
})

describe('streamAnthropicMessages retry', () => {
  it('retries a 429 honoring retry-after, then succeeds', async () => {
    const waits: number[] = []
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      if (call === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } })
      }
      return sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n'])
    }))
    const onRetry = vi.fn(async (info: { delayMs: number }) => { waits.push(info.delayMs) })
    const out = []
    for await (const ev of streamAnthropicMessages(baseReq, onRetry)) out.push(ev)
    expect(out).toHaveLength(0) // message_stop alone maps to no canonical event
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(waits[0]).toBe(2000)
  })

  it('throws after exhausting retries', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })))
      const iter = streamAnthropicMessages(baseReq, async () => {})[Symbol.asyncIterator]()
      const expectation = expect(iter.next()).rejects.toThrow(`Anthropic API 500`)
      // flush the retry backoff without really waiting
      for (let i = 0; i < MAX_API_RETRIES; i++) await vi.advanceTimersByTimeAsync(60_000)
      await expectation
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(MAX_API_RETRIES + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })))
    await expect(async () => {
      for await (const _ of streamAnthropicMessages(baseReq, async () => {})) { /* drain */ }
    }).rejects.toThrow('Anthropic API 400')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('apiError marks 5xx retryable and 4xx not', () => {
    expect(apiError(500, 'x').retryable).toBe(true)
    expect(apiError(401, 'x').retryable).toBe(false)
    expect(apiError(429, 'x').retryable).toBe(true)
  })
})
