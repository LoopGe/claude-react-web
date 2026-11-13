import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setConfigForTest, config } from './config.js'
import { callAnthropicMessages } from './anthropic-api.js'

// GLM / reasoning-style gateways (e.g. Volcengine Ark) return a `thinking`
// block BEFORE the text block in `content`. The extraction must skip
// non-text blocks instead of reading `content[0].text` — see the
// thinking-first fixture below, modeled on a real captured response.

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('callAnthropicMessages', () => {
  const origConfig = { ...config }

  beforeEach(() => {
    __setConfigForTest({
      authToken: 'test-token',
      baseUrl: 'https://api.anthropic.com',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    __setConfigForTest(origConfig)
  })

  const call = () =>
    callAnthropicMessages({
      model: 'test-model',
      system: 'sys',
      userContent: 'hi',
      maxTokens: 100,
      temperature: 0,
      caller: 'recap',
    })

  it('extracts text when a thinking block precedes the text block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          content: [
            { type: 'thinking', thinking: 'reasoning here' },
            { type: 'text', text: 'Hello!' },
          ],
          stop_reason: 'end_turn',
        }),
      ),
    )
    await expect(call()).resolves.toBe('Hello!')
  })

  it('returns only the FIRST text block (caller post-processing contract)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          content: [
            { type: 'text', text: 'part one' },
            { type: 'text', text: 'part two' },
          ],
        }),
      ),
    )
    await expect(call()).resolves.toBe('part one')
  })

  it('accepts a text block missing the type field (loose gateway)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ content: [{ text: 'no type field' }] })),
    )
    await expect(call()).resolves.toBe('no type field')
  })

  it('skips an empty text block and takes the first one with content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          content: [
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'text', text: '' },
            { type: 'text', text: 'real answer' },
          ],
        }),
      ),
    )
    await expect(call()).resolves.toBe('real answer')
  })

  it('still throws on truly empty content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: [] })))
    await expect(call()).rejects.toThrow(/Empty response/)
  })

  it('still throws when content has no text blocks at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ content: [{ type: 'thinking', thinking: 'only reasoning' }] }),
      ),
    )
    await expect(call()).rejects.toThrow(/Empty response/)
  })

  it.each(['image', 'document'] as const)('uses streaming Messages for %s content and collects text deltas', async (kind) => {
    const encoder = new TextEncoder()
    const events = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"summary"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event))
        controller.close()
      },
    })
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ({ ok: true, status: 200, body }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const media = kind === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'aGVsbG8=' } }
    const result = await callAnthropicMessages({
      model: 'effective-model', system: 'sys',
      userContent: [{ type: 'text', text: 'compact this' }, media],
      maxTokens: 2048, temperature: 0, caller: 'compact-summary',
    })

    expect(result).toBe('streamed summary')
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(request.stream).toBe(true)
    expect(request.model).toBe('effective-model')
  })

  it('keeps the existing non-streaming request shape for text-only auxiliary calls', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => jsonResponse({ content: [{ type: 'text', text: 'plain' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(call()).resolves.toBe('plain')
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(request.stream).toBeUndefined()
  })

  it('times out a streaming response after exactly 60 seconds without data', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({ start() {} }),
      }) as unknown as Response))
      let settled = false
      const pending = callAnthropicMessages({
        model: 'effective-model', system: 'sys',
        userContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }],
        maxTokens: 100, temperature: 0, caller: 'compact-summary',
      })
      void pending.catch(() => { settled = true })

      await vi.advanceTimersByTimeAsync(59_999)
      expect(settled).toBe(false)
      const rejection = expect(pending).rejects.toThrow(/60 seconds/i)
      await vi.advanceTimersByTimeAsync(1)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })
})
