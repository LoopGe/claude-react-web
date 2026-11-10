import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiError, buildRequestBody, FAST_MODE_BETA, MAX_API_RETRIES, streamAnthropicMessages, type RequestThinking, type StreamRequest } from './anthropic-stream.js'

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

  it('translates thinking text and its signature_delta as separate canonical events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      ]),
    ))
    const out = []
    for await (const ev of streamAnthropicMessages(baseReq, async () => {})) out.push(ev)
    expect(out).toEqual([
      { kind: 'block_start', index: 0, block: { type: 'thinking' }, raw: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { kind: 'block_delta', index: 0, delta: { type: 'thinking', thinking: 'hmm' }, raw: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
      { kind: 'block_delta', index: 0, delta: { type: 'signature', signature: 'sig-1' }, raw: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } } },
      { kind: 'block_end', index: 0, raw: { type: 'content_block_stop', index: 0 } },
    ])
  })

  it('carries redacted_thinking data at block start', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"ENCRYPTED"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      ]),
    ))
    const out = []
    for await (const ev of streamAnthropicMessages(baseReq, async () => {})) out.push(ev)
    expect(out).toEqual([
      { kind: 'block_start', index: 1, block: { type: 'redacted_thinking', data: 'ENCRYPTED' }, raw: { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' } } },
      { kind: 'block_end', index: 1, raw: { type: 'content_block_stop', index: 1 } },
    ])
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

describe('buildRequestBody', () => {
  it('adds cache_control breakpoints without mutating the caller objects', async () => {
    const tools = [{ name: 'Read', description: 'r', input_schema: {} }, { name: 'Bash', description: 'b', input_schema: {} }]
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]
    const req = { ...baseReq, system: 'SYS', tools, messages }
    const body = buildRequestBody(req) as {
      system: Array<{ type: string; text: string; cache_control?: unknown }>
      tools: Array<{ name: string; cache_control?: unknown }>
      messages: Array<{ content: Array<{ type: string; cache_control?: unknown }> }>
    }
    expect(body.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }])
    expect(body.tools[0].cache_control).toBeUndefined()
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' })
    // The loop's objects are untouched.
    expect(tools[1]).not.toHaveProperty('cache_control')
    expect(messages[1].content[0]).not.toHaveProperty('cache_control')
  })

  it('converts a string-content last message into a cached text block', () => {
    const body = buildRequestBody({ ...baseReq, system: '', messages: [{ role: 'user', content: 'hello' }] }) as {
      system: unknown
      messages: Array<{ content: Array<{ type: string; text: string; cache_control?: unknown }> }>
    }
    expect(body.system).toBe('')
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }])
  })
})

describe('buildRequestBody thinking', () => {
  const bodyWithThinking = (
    thinking: RequestThinking,
    opts: { maxTokens?: number; display?: 'summarized' | 'omitted' | 'highlights' } = {},
  ): { thinking?: unknown } =>
    buildRequestBody({ ...baseReq, maxTokens: opts.maxTokens ?? 16384, thinking, thinkingDisplay: opts.display })

  it('emits the snake_case adaptive / enabled / disabled wire forms', () => {
    expect(bodyWithThinking({ type: 'adaptive' }).thinking).toEqual({ type: 'adaptive' })
    expect(bodyWithThinking({ type: 'disabled' }).thinking).toEqual({ type: 'disabled' })
    expect(bodyWithThinking({ type: 'enabled', budgetTokens: 4096 }).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
    })
  })

  it('omits the field when no thinking config is present', () => {
    const body = buildRequestBody({ ...baseReq, maxTokens: 16384 })
    expect(body).not.toHaveProperty('thinking')
  })

  it('maps bare enabled (no budget) to adaptive — there is no bare-enabled wire form', () => {
    expect(bodyWithThinking({ type: 'enabled' }).thinking).toEqual({ type: 'adaptive' })
  })

  it('clamps budget_tokens to [1024, max_tokens - 1]', () => {
    expect(bodyWithThinking({ type: 'enabled', budgetTokens: 100 }).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 1024,
    })
    expect(bodyWithThinking({ type: 'enabled', budgetTokens: 99_999 }).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 16_383,
    })
  })

  it('clamps against a non-default max_tokens', () => {
    expect(bodyWithThinking({ type: 'enabled', budgetTokens: 99_999 }, { maxTokens: 4096 }).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4095,
    })
  })

  it('leaves the budget as-is when max_tokens <= 1024 (empty clamp range)', () => {
    expect(bodyWithThinking({ type: 'enabled', budgetTokens: 500 }, { maxTokens: 1024 }).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 500,
    })
    expect(bodyWithThinking({ type: 'enabled', budgetTokens: 5000 }, { maxTokens: 1024 }).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 5000,
    })
  })

  it("forwards the tracked display only for 'summarized' | 'omitted', never 'highlights'", () => {
    expect(bodyWithThinking({ type: 'adaptive' }, { display: 'summarized' }).thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    })
    expect(bodyWithThinking({ type: 'enabled', budgetTokens: 4096 }, { display: 'omitted' }).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
      display: 'omitted',
    })
    expect(bodyWithThinking({ type: 'adaptive' }, { display: 'highlights' }).thinking).toEqual({ type: 'adaptive' })
  })
})

describe('buildRequestBody effort and fast mode', () => {
  const wire = (overrides: Partial<StreamRequest>) =>
    buildRequestBody({ ...baseReq, model: 'claude-opus-4-8', ...overrides }) as {
      output_config?: unknown
      speed?: unknown
    }

  it('emits output_config.effort for a level the model supports', () => {
    expect(wire({ effort: 'high' }).output_config).toEqual({ effort: 'high' })
    // The classifier's sonnet rule grants every sonnet id [low, medium, high,
    // max] (only 'xhigh' is opus-only), so 'max' is emitted for any sonnet id.
    expect(wire({ model: 'claude-sonnet-4-5', effort: 'max' }).output_config).toEqual({ effort: 'max' })
  })

  it('omits effort when the model does not support the level', () => {
    expect(wire({ model: 'claude-sonnet-4-5', effort: 'xhigh' })).not.toHaveProperty('output_config')
    expect(wire({ model: 'claude-haiku-3-5', effort: 'high' })).not.toHaveProperty('output_config')
  })

  it('omits both fields when no intent is configured', () => {
    const body = wire({})
    expect(body).not.toHaveProperty('output_config')
    expect(body).not.toHaveProperty('speed')
  })

  it('emits speed: fast only for a fast-mode-capable model', () => {
    expect(wire({ fastMode: true }).speed).toBe('fast')
    expect(wire({ fastMode: false })).not.toHaveProperty('speed')
    expect(wire({ model: 'claude-sonnet-4-5', fastMode: true })).not.toHaveProperty('speed')
  })
})

describe('streamAnthropicMessages fast mode header', () => {
  it('adds the fast-mode beta header only when the model can serve fast mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']),
    ))
    const sent = async (overrides: Partial<StreamRequest>): Promise<{ headers: Record<string, string>; body: string }> => {
      vi.mocked(fetch).mockClear()
      for await (const _ of streamAnthropicMessages({ ...baseReq, model: 'claude-opus-4-8', ...overrides }, async () => {})) {
        /* drain */
      }
      return vi.mocked(fetch).mock.calls[0][1] as { headers: Record<string, string>; body: string }
    }

    // Enabled on a capable model: header + speed.
    const fast = await sent({ fastMode: true })
    expect(fast.headers['anthropic-beta']).toBe(FAST_MODE_BETA)
    expect(JSON.parse(fast.body)).toMatchObject({ speed: 'fast' })

    // Explicitly disabled and absent intent: neither the header nor speed.
    for (const fastMode of [false, undefined]) {
      const off = await sent({ fastMode })
      expect(off.headers['anthropic-beta']).toBeUndefined()
      expect(JSON.parse(off.body)).not.toHaveProperty('speed')
    }

    // Intent on, incapable model: both are omitted together.
    const unsupported = await sent({ model: 'claude-sonnet-4-5', fastMode: true })
    expect(unsupported.headers['anthropic-beta']).toBeUndefined()
    expect(JSON.parse(unsupported.body)).not.toHaveProperty('speed')
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
