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
})
