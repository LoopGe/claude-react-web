import { describe, it, expect } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { liteContextUsageFromResult } from './session-pump.js'

function makeResult(overrides: {
  usage?: Record<string, unknown>
  modelUsage?: Record<string, { contextWindow?: number }>
} = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: overrides.usage,
    modelUsage: overrides.modelUsage,
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 's1',
  } as unknown as SDKMessage
}

describe('liteContextUsageFromResult', () => {
  it('returns null for non-result messages', () => {
    const msg = { type: 'assistant', message: { content: [] } } as unknown as SDKMessage
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('returns null when usage is missing', () => {
    const msg = makeResult({ modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } } })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('returns null when modelUsage is missing', () => {
    const msg = makeResult({ usage: { input_tokens: 1000 } })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('returns null when no model entry has a contextWindow', () => {
    const msg = makeResult({
      usage: { input_tokens: 1000 },
      modelUsage: { 'claude-opus-4-7': {} },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('sums all three input-token buckets', () => {
    const msg = makeResult({
      usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 5000,
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out).not.toBeNull()
    expect(out!.totalTokens).toBe(6200)
    expect(out!.maxTokens).toBe(200000)
    expect(out!.rawMaxTokens).toBe(200000)
    expect(out!.percentage).toBeCloseTo((6200 / 200000) * 100, 5)
    expect(out!.model).toBe('claude-opus-4-7')
  })

  it('treats missing token buckets as zero', () => {
    const msg = makeResult({
      usage: { input_tokens: 500 }, // no cache fields
      modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000 } },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out!.totalTokens).toBe(500)
  })

  it('uses the last iteration when usage.iterations is present', () => {
    // Multi-iteration turn (server-tool-use loop, subagent recursion).
    // Top-level usage sums across iterations and would massively
    // overstate context fill — we want only the last call's prompt.
    const msg = makeResult({
      usage: {
        // Cumulative — what we MUST NOT use.
        input_tokens: 1808000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          { type: 'message', input_tokens: 600000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 },
          { type: 'message', input_tokens: 700000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 },
          // Last iteration — the real context-window number.
          { type: 'message', input_tokens: 50000, cache_creation_input_tokens: 100, cache_read_input_tokens: 400000, output_tokens: 1000 },
        ],
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 1000000 } },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out!.totalTokens).toBe(450100)
    expect(out!.maxTokens).toBe(1000000)
    expect(out!.percentage).toBeCloseTo((450100 / 1000000) * 100, 5)
  })

  it('falls back to top-level usage when iterations is empty or null', () => {
    const msgEmpty = makeResult({
      usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 5000,
        iterations: [],
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msgEmpty)!.totalTokens).toBe(6200)

    const msgNull = makeResult({
      usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 5000,
        iterations: null,
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msgNull)!.totalTokens).toBe(6200)
  })

  it('handles iteration cache fields that are explicitly null', () => {
    // The Anthropic Beta types declare cache_*_input_tokens as `number | null`
    // on the top-level Usage; the iteration variants are `number` but defensive
    // coalescing matches the top-level path.
    const msg = makeResult({
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          { type: 'message', input_tokens: 1500, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 0 },
        ],
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)!.totalTokens).toBe(1500)
  })

  it('picks the first model entry with a positive contextWindow', () => {
    const msg = makeResult({
      usage: { input_tokens: 100 },
      modelUsage: {
        'fallback-model': { contextWindow: 0 },
        'real-model': { contextWindow: 100000 },
      },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out!.model).toBe('real-model')
    expect(out!.maxTokens).toBe(100000)
  })
})
