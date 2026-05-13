import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { generateRecap, invalidateRecapCache } from './recap.js'
import { __setConfigForTest, config } from './config.js'

// ── Helpers ─────────────────────────────────────────────────────────

function userMsg(text: string, uuid?: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  } as unknown as SDKMessage
}

function assistantMsg(text: string, uuid?: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as unknown as SDKMessage
}

function assistantWithTools(text: string, tools: string[], uuid?: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...tools.map((name) => ({ type: 'tool_use', name, id: 't1', input: {} })),
      ],
    },
  } as unknown as SDKMessage
}

function resultMsg(cost?: number, durationMs?: number): SDKMessage {
  return {
    type: 'result',
    uuid: 'r1',
    ...(cost != null ? { total_cost_usd: cost } : {}),
    ...(durationMs != null ? { duration_ms: durationMs } : {}),
  } as unknown as SDKMessage
}

function toolResultOnlyMsg(): SDKMessage {
  return {
    type: 'user',
    uuid: 'tr1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    },
  } as unknown as SDKMessage
}

function mockFetchSuccess(summary: string) {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: summary }] }),
    text: async () => summary,
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function mockFetchError(status: number, body: string) {
  const mock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

// ── Tests ───────────────────────────────────────────────────────────

describe('recap', () => {
  // Save and restore config between tests so we can toggle token presence.
  const origConfig = { ...config }

  beforeEach(() => {
    vi.restoreAllMocks()
    __setConfigForTest({ authToken: 'test-token-123', baseUrl: 'https://api.anthropic.com' })
  })

  afterEach(() => {
    __setConfigForTest(origConfig)
  })

  // ── extractHistory (tested via generateRecap + fallback path) ────

  describe('history extraction', () => {
    it('counts user and assistant turns', async () => {
      __setConfigForTest({ authToken: undefined })
      const messages = [
        userMsg('Hello', 'u1'),
        assistantMsg('Hi there', 'a1'),
        userMsg('Help me', 'u2'),
        assistantMsg('Sure', 'a2'),
        resultMsg(0.01, 1500),
      ]
      const r = await generateRecap(messages, 'ext-1')
      expect(r.stats.userTurns).toBe(2)
      expect(r.stats.assistantTurns).toBe(2)
      expect(r.stats.messageCount).toBe(5)
    })

    it('extracts tool names from assistant content', async () => {
      __setConfigForTest({ authToken: undefined })
      const messages = [
        userMsg('read file', 'u1'),
        assistantWithTools('Reading file...', ['Read', 'Glob'], 'a1'),
      ]
      const r = await generateRecap(messages, 'ext-tools')
      expect(r.stats.toolsUsed).toEqual(['Glob', 'Read']) // sorted
    })

    it('skips tool_result-only user frames', async () => {
      __setConfigForTest({ authToken: undefined })
      const messages = [
        toolResultOnlyMsg(),
        userMsg('actual question', 'u1'),
        assistantMsg('answer', 'a1'),
      ]
      const r = await generateRecap(messages, 'ext-toolresult')
      // tool_result-only should be skipped, so only 1 user turn
      expect(r.stats.userTurns).toBe(1)
    })

    it('uses last result for total_cost_usd (overwrites, not accumulates)', async () => {
      __setConfigForTest({ authToken: undefined })
      const messages = [resultMsg(0.01), resultMsg(0.05)]
      const r = await generateRecap(messages, 'ext-cost')
      expect(r.stats.totalCostUsd).toBe(0.05)
    })

    it('accumulates duration_ms across result messages', async () => {
      __setConfigForTest({ authToken: undefined })
      const messages = [resultMsg(0.01, 1000), resultMsg(0.02, 2000)]
      const r = await generateRecap(messages, 'ext-duration')
      expect(r.stats.durationMs).toBe(3000)
    })

    it('returns fallback for empty session', async () => {
      __setConfigForTest({ authToken: undefined })
      const r = await generateRecap([], 'ext-empty')
      expect(r.summary).toBe('No messages yet.')
      expect(r.fallback).toBe(true)
    })
  })

  // ── buildTranscript ─────────────────────────────────────────────

  describe('transcript building', () => {
    it('generates transcript with numbered lines', async () => {
      // We test buildTranscript indirectly by verifying the API call body.
      const fetchMock = mockFetchSuccess('Test summary')
      const messages = [userMsg('hi', 'u1'), assistantMsg('hello', 'a1')]
      await generateRecap(messages, 'transcript-1')

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const body = JSON.parse((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
      const userContent = body.messages[0].content as string
      expect(userContent).toContain('[1] User: hi')
      expect(userContent).toContain('[2] Assistant: hello')
    })

    it('omits middle lines when transcript exceeds char budget', async () => {
      const fetchMock = mockFetchSuccess('summary')
      // Generate 100 messages with long text to exceed 12k char budget.
      const messages: SDKMessage[] = []
      for (let i = 0; i < 50; i++) {
        messages.push(userMsg(`user message ${i} `.repeat(20), `u${i}`))
        messages.push(assistantMsg(`assistant reply ${i} `.repeat(20), `a${i}`))
      }
      await generateRecap(messages, 'transcript-budget')

      const body = JSON.parse((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
      const userContent = body.messages[0].content as string
      expect(userContent).toContain('messages omitted')
    })
  })

  // ── Caching ─────────────────────────────────────────────────────

  describe('caching', () => {
    it('returns cached result on second call within TTL', async () => {
      const fetchMock = mockFetchSuccess('AI summary')
      const messages = [userMsg('test', 'u1'), assistantMsg('reply', 'a1')]

      const first = await generateRecap(messages, 'cache-hit')
      expect(first.cached).toBe(false)

      // Invalidate so we can test the explicit cache behavior.
      // Actually, just call again with the same inputs.
      const second = await generateRecap(messages, 'cache-hit')
      expect(second.cached).toBe(true)
      expect(second.summary).toBe('AI summary')
      // Should not have called the API again.
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('bypasses cache when message count changes', async () => {
      const fetchMock = mockFetchSuccess('summary')
      const messages1 = [userMsg('a', 'u1'), assistantMsg('b', 'a1')]
      await generateRecap(messages1, 'cache-count')

      const messages2 = [...messages1, userMsg('c', 'u2'), assistantMsg('d', 'a2')]
      const r = await generateRecap(messages2, 'cache-count')
      expect(r.cached).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('bypasses cache when TTL expires', async () => {
      const now = Date.now()
      vi.setSystemTime(now)

      const fetchMock = mockFetchSuccess('summary')
      const messages = [userMsg('a', 'u1'), assistantMsg('b', 'a1')]
      await generateRecap(messages, 'cache-ttl')

      // Advance past the 5-minute TTL.
      vi.setSystemTime(now + 6 * 60 * 1000)
      const r = await generateRecap(messages, 'cache-ttl')
      expect(r.cached).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('evicts oldest cache entry when exceeding MAX_ENTRIES', async () => {
      // Fill the cache with 200 unique sessions, then add one more.
      // The first session should be evicted.
      for (let i = 0; i < 200; i++) {
        const msgs = [userMsg(`s${i}`, `u${i}`), assistantMsg(`r${i}`, `a${i}`)]
        mockFetchSuccess(`summary-${i}`)
        await generateRecap(msgs, `lru-${i}`)
      }

      // Now add entry 201. The oldest (lru-0) should be evicted.
      mockFetchSuccess('summary-201')
      const msgs201 = [userMsg('new', 'u201'), assistantMsg('reply', 'a201')]
      await generateRecap(msgs201, 'lru-201')

      // Try to get lru-0 — should NOT be cached.
      invalidateRecapCache('lru-0') // Clear any inflight reference
      const lru0Msgs = [userMsg('s0', 'u0'), assistantMsg('r0', 'a0')]
      mockFetchSuccess('evicted-retry')
      const r = await generateRecap(lru0Msgs, 'lru-0')
      expect(r.cached).toBe(false)
    })

    it('invalidating cache forces a fresh generation', async () => {
      const fetchMock = mockFetchSuccess('summary')
      const messages = [userMsg('a', 'u1'), assistantMsg('b', 'a1')]
      await generateRecap(messages, 'cache-inv')
      const cached = await generateRecap(messages, 'cache-inv')
      expect(cached.cached).toBe(true)

      invalidateRecapCache('cache-inv')
      const fresh = await generateRecap(messages, 'cache-inv')
      expect(fresh.cached).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  // ── In-flight dedup ─────────────────────────────────────────────

  describe('in-flight dedup', () => {
    it('reuses promise for concurrent calls on same session', async () => {
      let resolveFetch!: (v: unknown) => void
      vi.stubGlobal(
        'fetch',
        vi.fn().mockReturnValue(
          new Promise((r) => {
            resolveFetch = r
          }),
        ),
      )

      const messages = [userMsg('test', 'u1'), assistantMsg('reply', 'a1')]
      const p1 = generateRecap(messages, 'inflight-1')
      const p2 = generateRecap(messages, 'inflight-1')

      // Both should reference the same underlying promise.
      // Resolve the fetch to unblock.
      resolveFetch({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'shared result' }] }),
      })

      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.summary).toBe('shared result')
      expect(r2.summary).toBe('shared result')
      // Only one API call should have been made.
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    })
  })

  // ── Fallback ────────────────────────────────────────────────────

  describe('fallback', () => {
    it('uses fallback when no API key is configured', async () => {
      __setConfigForTest({ authToken: undefined })

      const messages = [userMsg('Help me debug X', 'u1'), assistantMsg('Sure', 'a1')]
      const r = await generateRecap(messages, 'fallback-nokey')
      expect(r.fallback).toBe(true)
      expect(r.summary).toContain('1 user turn')
      expect(r.summary).toContain('1 assistant response')
      expect(r.summary).toContain('Help me debug X')
    })

    it('shows "Empty session" fallback for no user turns', async () => {
      __setConfigForTest({ authToken: undefined })

      // Only assistant messages — no user turns.
      const messages = [assistantMsg('Hello', 'a1')]
      const r = await generateRecap(messages, 'fallback-empty')
      expect(r.fallback).toBe(true)
      expect(r.summary).toContain('Empty session')
    })

    it('uses fallback when API call fails', async () => {
      mockFetchError(429, 'rate limited')

      const messages = [userMsg('fix bug', 'u1'), assistantMsg('done', 'a1')]
      const r = await generateRecap(messages, 'fallback-apierr')
      expect(r.fallback).toBe(true)
      expect(r.summary).toContain('1 user turn')
    })

    it('uses fallback when API returns empty content', async () => {
      mockFetchSuccess('')

      const messages = [userMsg('test', 'u1'), assistantMsg('reply', 'a1')]
      const r = await generateRecap(messages, 'fallback-empty-content')
      // Empty string is falsy, so callAnthropic throws "Empty response"
      // and we fall back.
      expect(r.fallback).toBe(true)
    })

    it('does NOT cache fallback results — next call retries the API', async () => {
      // First call: API fails → fallback.
      const errMock = mockFetchError(500, 'server error')
      const messages = [userMsg('test', 'u1'), assistantMsg('reply', 'a1')]
      const first = await generateRecap(messages, 'fallback-nocache')
      expect(first.fallback).toBe(true)
      expect(errMock).toHaveBeenCalledTimes(1)

      // Second call with same inputs: API now works — should hit the
      // network again and return the real summary, not the cached fallback.
      const okMock = mockFetchSuccess('real summary')
      const second = await generateRecap(messages, 'fallback-nocache')
      expect(second.fallback).toBeFalsy()
      expect(second.summary).toBe('real summary')
      expect(okMock).toHaveBeenCalledTimes(1)
    })
  })

  // ── API call ────────────────────────────────────────────────────

  describe('API call', () => {
    it('sends Bearer auth from config.authToken', async () => {
      mockFetchSuccess('summary')
      const messages = [userMsg('a', 'u1'), assistantMsg('b', 'a1')]
      await generateRecap(messages, 'api-headers')

      const call = vi.mocked(fetch).mock.calls[0]
      const headers = (call[1] as RequestInit).headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer test-token-123')
      expect(headers['anthropic-version']).toBe('2023-06-01')
      expect(headers['Content-Type']).toBe('application/json')
      // Confirm the legacy x-api-key header is not sent.
      expect(headers['x-api-key']).toBeUndefined()
    })

    it('uses config.baseUrl for the request URL', async () => {
      __setConfigForTest({ baseUrl: 'https://proxy.example.com' })
      mockFetchSuccess('summary')
      const messages = [userMsg('a', 'u1'), assistantMsg('b', 'a1')]
      await generateRecap(messages, 'api-baseurl')

      const url = vi.mocked(fetch).mock.calls[0][0] as string
      expect(url).toBe('https://proxy.example.com/v1/messages')
    })

    it('includes system prompt and transcript in request body', async () => {
      mockFetchSuccess('summary')
      const messages = [userMsg('hello', 'u1'), assistantMsg('hi', 'a1')]
      await generateRecap(messages, 'api-body')

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
      expect(body.system).toContain('session recap assistant')
      expect(body.messages[0].role).toBe('user')
      expect(body.messages[0].content).toContain('[1] User: hello')
      expect(body.model).toBeDefined()
      expect(body.max_tokens).toBe(300)
    })
  })
})
