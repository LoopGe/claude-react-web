import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { detectLanguage, generateRecap, invalidateRecapCache } from './recap.js'
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

  // ── extractHistory (tested via generateRecap) ─────────────────────
  //
  // We need a successful API call (mocked) for non-empty histories so
  // generateRecap returns a result instead of throwing. The point of
  // these tests is to exercise the extracted stats — the summary itself
  // is irrelevant.

  describe('history extraction', () => {
    it('counts user and assistant turns', async () => {
      mockFetchSuccess('summary')
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
      mockFetchSuccess('summary')
      const messages = [
        userMsg('read file', 'u1'),
        assistantWithTools('Reading file...', ['Read', 'Glob'], 'a1'),
      ]
      const r = await generateRecap(messages, 'ext-tools')
      expect(r.stats.toolsUsed).toEqual(['Glob', 'Read']) // sorted
    })

    it('skips tool_result-only user frames', async () => {
      mockFetchSuccess('summary')
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
      mockFetchSuccess('summary')
      // Need at least one user message — pure result-only history would
      // hit the empty-session shortcut and skip extraction.
      const messages = [
        userMsg('hi', 'u1'),
        assistantMsg('hi', 'a1'),
        resultMsg(0.01),
        resultMsg(0.05),
      ]
      const r = await generateRecap(messages, 'ext-cost')
      expect(r.stats.totalCostUsd).toBe(0.05)
    })

    it('accumulates duration_ms across result messages', async () => {
      mockFetchSuccess('summary')
      const messages = [
        userMsg('hi', 'u1'),
        assistantMsg('hi', 'a1'),
        resultMsg(0.01, 1000),
        resultMsg(0.02, 2000),
      ]
      const r = await generateRecap(messages, 'ext-duration')
      expect(r.stats.durationMs).toBe(3000)
    })

    it('returns "No messages yet." for an empty history without calling the API', async () => {
      const fetchMock = mockFetchSuccess('should-not-be-called')
      const r = await generateRecap([], 'ext-empty')
      expect(r.summary).toBe('No messages yet.')
      expect(r.cached).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns "No messages yet." even with no auth token (no LLM needed)', async () => {
      // Empty-session shortcut runs before the auth-token gate, so it
      // works even for misconfigured installations — there's literally
      // nothing to summarise.
      __setConfigForTest({ authToken: undefined })
      const r = await generateRecap([], 'ext-empty-noauth')
      expect(r.summary).toBe('No messages yet.')
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

    it('keeps the full payload (transcript + tail hint) under the 12k char budget', async () => {
      // Regression guard: tailHint used to be appended after truncation,
      // pushing the total ~50 chars over the documented budget. The fix
      // subtracts tailHint.length up front so the combined output fits.
      const fetchMock = mockFetchSuccess('summary')
      const messages: SDKMessage[] = []
      for (let i = 0; i < 50; i++) {
        messages.push(userMsg(`user message ${i} `.repeat(20), `u${i}`))
        messages.push(assistantMsg(`assistant reply ${i} `.repeat(20), `a${i}`))
      }
      await generateRecap(messages, 'transcript-budget-cap')

      const body = JSON.parse((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
      const userContent = body.messages[0].content as string
      expect(userContent.length).toBeLessThanOrEqual(12_000)
    })
  })

  // ── Caching ─────────────────────────────────────────────────────

  describe('caching', () => {
    it('returns cached result on a second call with the same conversation', async () => {
      const fetchMock = mockFetchSuccess('AI summary')
      const messages = [userMsg('test', 'u1'), assistantMsg('reply', 'a1')]

      const first = await generateRecap(messages, 'cache-hit')
      expect(first.cached).toBe(false)

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

    it('stays cached indefinitely when the conversation has not changed', async () => {
      // No wall-clock TTL: a summary is valid as long as the underlying
      // messages are unchanged. Invalidation is driven by send() / delete()
      // on the session manager (see invalidateRecapCache).
      const now = Date.now()
      vi.setSystemTime(now)

      const fetchMock = mockFetchSuccess('summary')
      const messages = [userMsg('a', 'u1'), assistantMsg('b', 'a1')]
      await generateRecap(messages, 'cache-no-ttl')

      // Jump 24 hours forward — same conversation, must still hit cache.
      vi.setSystemTime(now + 24 * 60 * 60 * 1000)
      const r = await generateRecap(messages, 'cache-no-ttl')
      expect(r.cached).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('still bypasses cache on fingerprint mismatch even after a long delay', async () => {
      // Ensures dropping the TTL did not also drop the fingerprint guard:
      // changing the message set should still force a fresh LLM call no
      // matter how recent (or stale) the cache entry is.
      const now = Date.now()
      vi.setSystemTime(now)

      const fetchMock = mockFetchSuccess('summary')
      const messages = [userMsg('a', 'u1'), assistantMsg('b', 'a1')]
      await generateRecap(messages, 'cache-fingerprint-late')

      vi.setSystemTime(now + 7 * 24 * 60 * 60 * 1000) // 1 week later
      const grown = [...messages, userMsg('c', 'u2'), assistantMsg('d', 'a2')]
      const r = await generateRecap(grown, 'cache-fingerprint-late')
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

  // ── Error propagation ────────────────────────────────────────────
  //
  // generateRecap throws on misconfiguration / API failure instead of
  // returning a local-fallback summary. The route layer catches the
  // throw and surfaces it as a state:'error' recap message — those
  // route-layer tests live alongside other route tests; here we just
  // verify the rejection reaches the caller with a useful message.

  describe('error propagation', () => {
    it('throws when no auth token is configured', async () => {
      __setConfigForTest({ authToken: undefined })

      const messages = [userMsg('Help me debug X', 'u1'), assistantMsg('Sure', 'a1')]
      await expect(generateRecap(messages, 'err-nokey')).rejects.toThrow(/authToken/)
    })

    it('throws when the Anthropic API returns a non-2xx response', async () => {
      mockFetchError(429, 'rate limited')

      const messages = [userMsg('fix bug', 'u1'), assistantMsg('done', 'a1')]
      await expect(generateRecap(messages, 'err-apierr')).rejects.toThrow()
    })

    it('throws when the Anthropic API returns empty content', async () => {
      mockFetchSuccess('')

      const messages = [userMsg('test', 'u1'), assistantMsg('reply', 'a1')]
      // Empty string is falsy, so callAnthropicMessages rejects with
      // "Empty response" — propagates straight back out.
      await expect(generateRecap(messages, 'err-empty-content')).rejects.toThrow()
    })

    it('does NOT cache failed runs — next call retries the API', async () => {
      // First call: API fails → throws.
      const errMock = mockFetchError(500, 'server error')
      const messages = [userMsg('test', 'u1'), assistantMsg('reply', 'a1')]
      await expect(generateRecap(messages, 'err-nocache')).rejects.toThrow()
      expect(errMock).toHaveBeenCalledTimes(1)

      // Second call with same inputs: API now works — should hit the
      // network again and return the real summary, not anything stale.
      const okMock = mockFetchSuccess('real summary')
      const second = await generateRecap(messages, 'err-nocache')
      expect(second.summary).toBe('real summary')
      expect(second.cached).toBe(false)
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

    it('uses temperature 0 (deterministic recap)', async () => {
      mockFetchSuccess('summary')
      const messages = [userMsg('hi', 'u1'), assistantMsg('hello', 'a1')]
      await generateRecap(messages, 'api-temp')

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
      expect(body.temperature).toBe(0)
    })
  })

  // ── Language detection ──────────────────────────────────────────

  describe('language detection', () => {
    it('detects Chinese from CJK characters', () => {
      expect(detectLanguage('帮我看看这个文件的逻辑')).toBe('Chinese (中文)')
    })

    it('detects Chinese even when mixed with English file paths', () => {
      expect(detectLanguage('帮我修一下 src/recap.ts 这个文件')).toBe('Chinese (中文)')
    })

    it('detects Chinese from CJK Extension B characters (rare/classical)', () => {
      // U+20083, U+20B9F, U+201A2, U+2070E — supplemental plane CJK
      // ideographs that the original BMP-only ranges silently dropped.
      // for…of iterates by code point so codePointAt(0) returns the
      // full SMP value (>0xFFFF) for each iteration.
      expect(detectLanguage('𠂃 𠯟 𠆢 𠜎 五个字')).toBe('Chinese (中文)')
    })

    it('detects Japanese when hiragana/katakana is present', () => {
      // Has both hiragana and CJK kanji — must classify as Japanese, not Chinese.
      expect(detectLanguage('このファイルを確認してください')).toBe('Japanese (日本語)')
    })

    it('detects Korean from Hangul', () => {
      expect(detectLanguage('이 파일을 확인해주세요')).toBe('Korean (한국어)')
    })

    it('detects Korean from Compatibility Jamo (U+3130-318F)', () => {
      // The BMP-only original range missed Compatibility Jamo, which
      // appears in keyboard input states and academic Korean transcription.
      expect(detectLanguage('ㄱㄴㄷㄹㅁ')).toBe('Korean (한국어)')
    })

    it('detects Russian from Cyrillic', () => {
      expect(detectLanguage('Проверь пожалуйста этот файл')).toBe('Russian (Русский)')
    })

    it('returns null for plain ASCII input (lets LLM infer between en/fr/es/etc.)', () => {
      // Latin-script — we can't tell English from French/German/Spanish
      // by script counts alone, so we delegate to the LLM.
      expect(detectLanguage('Please check this file for me')).toBeNull()
    })

    it('returns null for Latin-script European languages (would otherwise be forced to English)', () => {
      // Regression guard for the Latin-script-forced-to-English bug:
      // detectLanguage must NOT label these as English, because the
      // prompt would then explicitly tell the LLM to write English.
      expect(detectLanguage('Aide-moi à corriger ce fichier source')).toBeNull() // French
      expect(detectLanguage('Por favor, ayúdame con este archivo')).toBeNull() // Spanish
      expect(detectLanguage('Bitte hilf mir mit dieser Datei zu arbeiten')).toBeNull() // German
    })

    it('returns null for empty input', () => {
      expect(detectLanguage('')).toBeNull()
    })

    it('returns null when non-Latin chars are below threshold', () => {
      // A single stray symbol should NOT trigger non-English classification.
      expect(detectLanguage('Please check 中 this file')).toBeNull()
    })

    it('injects detected language into the system prompt and transcript tail', async () => {
      mockFetchSuccess('summary')
      const messages = [
        userMsg('帮我看看这个文件 src/recap.ts 的逻辑', 'u1'),
        assistantMsg('好的', 'a1'),
      ]
      await generateRecap(messages, 'lang-injection')

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
      expect(body.system).toContain('Chinese (中文)')
      // Tail hint should ride along on the user content for recency bias.
      expect(body.messages[0].content).toContain('Chinese (中文)')
    })

    it('detects language from user messages only (assistant text ignored)', async () => {
      // Assistant text in Chinese should NOT cause Chinese to be selected
      // when the user has only typed English. This matters because once a
      // recap is wrong, assistant turns may quote it back, polluting the signal.
      mockFetchSuccess('summary')
      const messages = [
        userMsg('please summarize', 'u1'),
        assistantMsg('好的，这是一个中文摘要的中文长文本', 'a1'),
      ]
      await generateRecap(messages, 'lang-user-only')

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
      // User wrote English (Latin script) so language is null → catch-all
      // prompt is used, NOT a "MUST write in <X>" directive that names a
      // specific non-English language.
      expect(body.system).not.toContain('Chinese (中文)')
      expect(body.system.toLowerCase()).toContain('same language')
    })

    it('does not force English on Latin-script users (French regression lock)', async () => {
      // Regression guard for the worst bug introduced by the first
      // language-detection patch: a French user writing only French
      // would get detectLanguage='English', which then forced the LLM
      // via "MUST write the entire summary in English". After the fix,
      // Latin-script input falls into the null-language branch with the
      // catch-all "same language as the user" directive, letting the
      // LLM correctly infer French.
      mockFetchSuccess('summary')
      const messages = [
        userMsg('Aide-moi à corriger ce fichier source', 'u1'),
        assistantMsg("D'accord", 'a1'),
      ]
      await generateRecap(messages, 'lang-french')

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
      // Must NOT contain the explicit "write in English" command.
      expect(body.system).not.toMatch(/write the entire summary in English/i)
      // Must contain the catch-all directive — the LLM is told to match
      // whatever language the user actually used.
      expect(body.system.toLowerCase()).toContain('same language')
      // Tail hint on user content should also use the catch-all.
      expect(body.messages[0].content.toLowerCase()).toContain('same language')
      expect(body.messages[0].content).not.toMatch(/recap summary in English/i)
    })
  })
})
