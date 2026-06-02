import { describe, it, expect } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  liteContextUsageFromResult,
  toolResultIds,
  userMessageHasToolResult,
} from './session-pump.js'

// ---------------------------------------------------------------------------
// Drop-filter discriminators
//
// Regression coverage for the "tool stuck on running" bug. In SDK 0.3.143 a
// MAIN-THREAD tool_result arrives as a `user` frame with
// `parent_tool_use_id: null` — indistinguishable from an echoed top-level
// user-input frame by parent alone. The pump must NOT drop tool_result
// frames (the UI needs them to flip the tool card off 'running'), so the
// drop decision keys on whether the message carries a tool_result block.
// ---------------------------------------------------------------------------

function userMsg(content: unknown): SDKMessage {
  return { type: 'user', message: { role: 'user', content } } as unknown as SDKMessage
}

describe('userMessageHasToolResult', () => {
  it('is true for a main-thread tool_result frame (parent_tool_use_id null)', () => {
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }])
    expect(userMessageHasToolResult(msg)).toBe(true)
  })

  it('is false for an echoed text-only user input', () => {
    expect(userMessageHasToolResult(userMsg('hello'))).toBe(false)
    expect(userMessageHasToolResult(userMsg([{ type: 'text', text: 'hi' }]))).toBe(false)
  })

  it('is false for an image-only user input (multimodal, no tool_result)', () => {
    const msg = userMsg([{ type: 'image', source: { type: 'base64', data: 'x', media_type: 'image/png' } }])
    expect(userMessageHasToolResult(msg)).toBe(false)
  })

  it('is true when a tool_result rides alongside other blocks', () => {
    const msg = userMsg([
      { type: 'text', text: 'see result' },
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'done' },
    ])
    expect(userMessageHasToolResult(msg)).toBe(true)
  })

  it('is defensive against odd shapes', () => {
    expect(userMessageHasToolResult({ type: 'user' } as unknown as SDKMessage)).toBe(false)
    expect(userMessageHasToolResult(userMsg(null))).toBe(false)
    expect(userMessageHasToolResult(userMsg([null, 42, 'x']))).toBe(false)
  })
})

describe('toolResultIds', () => {
  it('extracts tool_use_id from each tool_result block (not parent_tool_use_id)', () => {
    const msg = userMsg([
      { type: 'tool_result', tool_use_id: 'tu_a', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'tu_b', content: 'ok' },
    ])
    expect(toolResultIds(msg)).toEqual(['tu_a', 'tu_b'])
  })

  it('ignores non-tool_result blocks and non-string ids', () => {
    const msg = userMsg([
      { type: 'text', text: 'hi' },
      { type: 'tool_result', tool_use_id: 123, content: 'ok' },
      { type: 'tool_result', tool_use_id: 'tu_ok', content: 'ok' },
    ])
    expect(toolResultIds(msg)).toEqual(['tu_ok'])
  })

  it('returns empty for text-only / string content', () => {
    expect(toolResultIds(userMsg('hello'))).toEqual([])
    expect(toolResultIds(userMsg([{ type: 'text', text: 'x' }]))).toEqual([])
  })
})

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

  it('skips compaction iterations and picks the last message iteration', () => {
    // The compaction iteration's `input_tokens` is the size of the
    // SUMMARIZED SOURCE MATERIAL (millions of tokens of pre-compact
    // history) — not what was sent to the model in one shot. The bar
    // must reflect the user-facing message iteration, not the internal
    // compaction operation.
    const msg = makeResult({
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          { type: 'message', input_tokens: 12000, cache_creation_input_tokens: 0, cache_read_input_tokens: 30000, output_tokens: 500 },
          // Compaction reads everything to summarize. We must skip it.
          { type: 'compaction', input_tokens: 2300000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5000 },
        ],
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out!.totalTokens).toBe(42000) // 12000 + 30000 from the message iter
    expect(out!.maxTokens).toBe(200000)
  })

  it('skips advisor_message iterations as well', () => {
    const msg = makeResult({
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          { type: 'message', input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 },
          { type: 'advisor_message', input_tokens: 999999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 },
        ],
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)!.totalTokens).toBe(5000)
  })

  it('returns null when only compaction iterations exist (no message iteration)', () => {
    // No 'message' iteration in the turn — only compaction. Previously
    // this would clamp to contextWindow, producing a false 100% reading.
    // Now we return null so the bar shows the last known good value.
    const msg = makeResult({
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          { type: 'compaction', input_tokens: 2337000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5000 },
        ],
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('returns null when iterations have no type field', () => {
    // SDK may return iterations without a `type` field — all iterations
    // would fail the type === 'message' check. Return null to avoid
    // falling back to a potentially-cumulative value.
    const msg = makeResult({
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          { input_tokens: 50000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 },
        ],
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('returns null when raw total exceeds context window (unparseable SDK data)', () => {
    // The SDK reported more tokens than the context window can hold —
    // the data is unparseable. Return null rather than clamping to 100%.
    const msg = makeResult({
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          { type: 'message', input_tokens: 500000, cache_creation_input_tokens: 0, cache_read_input_tokens: 600000, output_tokens: 1000 },
        ],
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
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
