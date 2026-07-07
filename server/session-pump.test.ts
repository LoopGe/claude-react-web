import { describe, it, expect } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  fastModeStateOf,
  hookLifecycleMessage,
  isTaskNotificationUserMessage,
  liteContextUsageFromAssistant,
  liteContextUsageFromResult,
  toolResultIds,
  trimLargeToolResults,
  userMessageHasToolResult,
} from './session-pump.js'
import type { LiteContextUsage } from './session-pump.js'

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

describe('isTaskNotificationUserMessage', () => {
  // The pump's echo drop-filter must NOT drop a <task-notification> user
  // message: it isn't an echo of server-broadcast human input, it's the
  // harness's background-subagent result injection. Forwarding it lets the
  // client render it as a task-result card instead of silently losing it.

  const notification = (body = '<result>ok</result>') =>
    userMsg(`<task-notification>\n<task-id>t1</task-id>\n${body}\n</task-notification>`)

  it('is true for a top-level <task-notification> text user message', () => {
    expect(isTaskNotificationUserMessage(notification())).toBe(true)
  })

  it('is true for a string-content user message starting with <task-notification>', () => {
    expect(isTaskNotificationUserMessage(userMsg('  <task-notification>...'))).toBe(true)
  })

  it('is false for a genuine human text input (no injection marker)', () => {
    expect(isTaskNotificationUserMessage(userMsg('hello'))).toBe(false)
    expect(isTaskNotificationUserMessage(userMsg([{ type: 'text', text: 'hi there' }]))).toBe(false)
  })

  it('is false for a tool_result frame (even if its content text mentions task-notification)', () => {
    const msg = userMsg([
      { type: 'tool_result', tool_use_id: 'tu_1', content: '<task-notification>nested</task-notification>' },
    ])
    expect(isTaskNotificationUserMessage(msg)).toBe(false)
  })

  it('is false for a subagent-internal user frame (parent_tool_use_id set)', () => {
    const msg = {
      type: 'user',
      parent_tool_use_id: 'tu_agent',
      message: { role: 'user', content: '<task-notification>x</task-notification>' },
    } as unknown as SDKMessage
    expect(isTaskNotificationUserMessage(msg)).toBe(false)
  })

  it('only matches at the start of the leading text (not mid-body)', () => {
    expect(
      isTaskNotificationUserMessage(userMsg('see result below\n<task-notification>...</task-notification>')),
    ).toBe(false)
  })

  it('is defensive against odd shapes', () => {
    expect(isTaskNotificationUserMessage({ type: 'user' } as unknown as SDKMessage)).toBe(false)
    expect(isTaskNotificationUserMessage({ type: 'assistant' } as unknown as SDKMessage)).toBe(false)
    expect(isTaskNotificationUserMessage(userMsg(null))).toBe(false)
    expect(isTaskNotificationUserMessage(userMsg([null, 42]))).toBe(false)
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

// ---------------------------------------------------------------------------
// /clear is driven by SessionManager.clear() — it unloads the pre-clear
// session X (transcript preserved on disk so it stays resumable; meta removed
// from the store so X leaves the sidebar) and spawns a brand-new fresh
// session Y under a new id (no `resume:`). The
// pump no longer captures a `clearBoundaryUuid` (separate ids mean there is
// no boundary to anchor), and clear() no longer broadcasts `session-cleared`
// (Y has no pre-clear content to hide; that frame's only remaining producer
// is the SDK's own in-band `cleared` control event, forwarded in ws.ts).
// ---------------------------------------------------------------------------

function makeResult(overrides: {
  usage?: Record<string, unknown>
  modelUsage?: Record<string, { contextWindow?: number; maxOutputTokens?: number }>
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
    // Cache buckets are surfaced from the top-level usage (no iterations).
    expect(out!.cacheCreationTokens).toBe(200)
    expect(out!.cacheReadTokens).toBe(5000)
  })

  it('treats missing token buckets as zero', () => {
    const msg = makeResult({
      usage: { input_tokens: 500 }, // no cache fields
      modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000 } },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out!.totalTokens).toBe(500)
    // Missing cache buckets → keys omitted (not set to 0), so the UI can
    // distinguish "no cache reported" from "zero cache hit".
    expect(out!.cacheCreationTokens).toBeUndefined()
    expect(out!.cacheReadTokens).toBeUndefined()
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
    // Cache buckets come from the PICKED iteration (last 'message'), not
    // the cumulative top-level usage.
    expect(out!.cacheCreationTokens).toBe(100)
    expect(out!.cacheReadTokens).toBe(400000)
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

  it('surfaces outputTokens from the picked message iteration', () => {
    const msg = makeResult({
      usage: {
        input_tokens: 0,
        iterations: [
          { type: 'message', input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4321 },
        ],
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)!.outputTokens).toBe(4321)
  })

  it('computes autoCompactThreshold from contextWindow and maxOutputTokens', () => {
    // effectiveContextWindow = 200000 - min(32000, 20000) = 180000
    // threshold            = 180000 - 13000 = 167000
    const msg = makeResult({
      usage: { input_tokens: 1000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000, maxOutputTokens: 32000 } },
    })
    expect(liteContextUsageFromResult(msg)!.autoCompactThreshold).toBe(167000)
  })

  it('falls back to the 20000 output floor when maxOutputTokens is absent', () => {
    // effectiveContextWindow = 200000 - 20000 = 180000; threshold = 167000
    const msg = makeResult({
      usage: { input_tokens: 1000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)!.autoCompactThreshold).toBe(167000)
  })

  it('caps maxOutputTokens at the 20000 floor even when it is smaller', () => {
    // maxOutputTokens 8000 < 20000, so effective = 200000 - 8000 = 192000
    // threshold = 192000 - 13000 = 179000
    const msg = makeResult({
      usage: { input_tokens: 1000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000, maxOutputTokens: 8000 } },
    })
    expect(liteContextUsageFromResult(msg)!.autoCompactThreshold).toBe(179000)
  })
})

// ---------------------------------------------------------------------------
// liteContextUsageFromAssistant — mid-turn refresh from each `assistant`
// message, reusing the context window cached on the last `result` snapshot.
// ---------------------------------------------------------------------------

function makeAssistant(overrides: {
  usage?: Record<string, unknown>
  parent_tool_use_id?: string | null
} = {}): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: overrides.parent_tool_use_id ?? null,
    message: { role: 'assistant', content: [], usage: overrides.usage },
  } as unknown as SDKMessage
}

describe('liteContextUsageFromAssistant', () => {
  const cached: LiteContextUsage = {
    totalTokens: 1000,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: 0.5,
    model: 'claude-opus-4-7',
    autoCompactThreshold: 167000,
  }

  it('returns null for non-assistant messages', () => {
    expect(liteContextUsageFromAssistant({ type: 'result' } as unknown as SDKMessage, cached)).toBeNull()
  })

  it('returns null when no cached snapshot exists (first turn, pre-result)', () => {
    const msg = makeAssistant({ usage: { input_tokens: 1000 } })
    expect(liteContextUsageFromAssistant(msg, undefined)).toBeNull()
  })

  it('returns null when cached snapshot lacks a usable context window', () => {
    const msg = makeAssistant({ usage: { input_tokens: 1000 } })
    expect(liteContextUsageFromAssistant(msg, { ...cached, maxTokens: 0 })).toBeNull()
  })

  it('returns null when the assistant message lacks a usage payload', () => {
    const msg = { type: 'assistant', parent_tool_use_id: null, message: { content: [] } } as unknown as SDKMessage
    expect(liteContextUsageFromAssistant(msg, cached)).toBeNull()
  })

  it('skips subagent frames (parent_tool_use_id set)', () => {
    // A subagent has its own context window; updating the main-thread bar
    // from it would misrepresent the main conversation.
    const msg = makeAssistant({
      usage: { input_tokens: 500 },
      parent_tool_use_id: 'tu_subagent',
    })
    expect(liteContextUsageFromAssistant(msg, cached)).toBeNull()
  })

  it('sums all three input buckets and reuses the cached window/model/threshold', () => {
    const msg = makeAssistant({
      usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 5000,
        output_tokens: 4321,
      },
    })
    const out = liteContextUsageFromAssistant(msg, cached)
    expect(out).not.toBeNull()
    expect(out!.totalTokens).toBe(6200)
    expect(out!.maxTokens).toBe(200000)
    expect(out!.rawMaxTokens).toBe(200000)
    expect(out!.percentage).toBeCloseTo((6200 / 200000) * 100, 5)
    expect(out!.model).toBe('claude-opus-4-7')
    expect(out!.outputTokens).toBe(4321)
    expect(out!.autoCompactThreshold).toBe(167000)
    // Cache buckets forwarded from the assistant message's own usage.
    expect(out!.cacheCreationTokens).toBe(200)
    expect(out!.cacheReadTokens).toBe(5000)
  })

  it('omits cache/output keys when the assistant usage lacks them', () => {
    const msg = makeAssistant({ usage: { input_tokens: 500 } })
    const out = liteContextUsageFromAssistant(msg, cached)
    expect(out!.totalTokens).toBe(500)
    expect(out!.cacheCreationTokens).toBeUndefined()
    expect(out!.cacheReadTokens).toBeUndefined()
    expect(out!.outputTokens).toBeUndefined()
  })

  it('returns null when the prompt size exceeds the cached context window', () => {
    const msg = makeAssistant({
      usage: { input_tokens: 500000, cache_read_input_tokens: 600000 },
    })
    expect(liteContextUsageFromAssistant(msg, cached)).toBeNull()
  })
})


describe('fastModeStateOf', () => {
  it('extracts on/off/cooldown from a message', () => {
    expect(fastModeStateOf({ type: 'result', fast_mode_state: 'on' } as never)).toBe('on')
    expect(fastModeStateOf({ type: 'system', subtype: 'init', fast_mode_state: 'off' } as never)).toBe('off')
    expect(fastModeStateOf({ type: 'result', fast_mode_state: 'cooldown' } as never)).toBe('cooldown')
  })

  it('returns undefined when the field is absent or unrecognized', () => {
    expect(fastModeStateOf({ type: 'assistant' } as never)).toBeUndefined()
    expect(fastModeStateOf({ type: 'result', fast_mode_state: 'bogus' } as never)).toBeUndefined()
    expect(fastModeStateOf({ type: 'result' } as never)).toBeUndefined()
  })
})

describe('hookLifecycleMessage', () => {
  it('maps hook responses to completed runtime events', () => {
    const event = hookLifecycleMessage({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'h1',
      hook_name: 'audit',
      hook_event: 'Stop',
      outcome: 'error',
      output: 'failed',
      stdout: '',
      stderr: 'failed',
    } as unknown as SDKMessage)

    expect(event).toMatchObject({
      kind: 'completed',
      run: { id: 'h1', hookName: 'audit', event: 'Stop', status: 'error', output: 'failed' },
    })
  })

  it('trims very large hook outputs before retaining them', () => {
    const output = 'a'.repeat(30_000)
    const event = hookLifecycleMessage({
      type: 'system',
      subtype: 'hook_progress',
      hook_id: 'h1',
      hook_name: 'audit',
      hook_event: 'Stop',
      output,
      stdout: output,
      stderr: '',
    } as unknown as SDKMessage)

    expect(event?.run.output?.length).toBeLessThan(output.length)
    expect(event?.run.output).toContain('chars omitted')
  })
})

// ---------------------------------------------------------------------------
// trimLargeToolResults
// ---------------------------------------------------------------------------

describe('trimLargeToolResults', () => {
  it('trims a string tool_result content exceeding 50K chars', () => {
    const big = 'x'.repeat(80_000)
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_1', content: big }])
    trimLargeToolResults(msg)
    const block = (msg as { message: { content: Array<{ content: string }> } })
      .message.content[0]
    expect(block.content.length).toBeLessThan(big.length)
    expect(block.content).toContain('chars omitted')
  })

  it('trims a text block inside an array tool_result content', () => {
    const big = 'y'.repeat(80_000)
    const msg = userMsg([{
      type: 'tool_result',
      tool_use_id: 'tu_2',
      content: [{ type: 'text', text: big }],
    }])
    trimLargeToolResults(msg)
    const block = (msg as { message: { content: Array<{ content: Array<{ text: string }> }> } })
      .message.content[0]
    expect(block.content[0].text.length).toBeLessThan(big.length)
    expect(block.content[0].text).toContain('chars omitted')
  })

  it('leaves small tool_result content untouched', () => {
    const small = 'hello world'
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_3', content: small }])
    trimLargeToolResults(msg)
    const block = (msg as { message: { content: Array<{ content: string }> } })
      .message.content[0]
    expect(block.content).toBe(small)
  })

  it('ignores non-user messages entirely', () => {
    const msg = { type: 'assistant', message: { content: [] } } as unknown as SDKMessage
    // Should not throw
    trimLargeToolResults(msg)
  })

  it('ignores text-only user messages (no tool_result blocks)', () => {
    const msg = userMsg([{ type: 'text', text: 'a'.repeat(80_000) }])
    trimLargeToolResults(msg)
    const block = (msg as { message: { content: Array<{ text: string }> } })
      .message.content[0]
    expect(block.text).toBe('a'.repeat(80_000)) // untouched — not a tool_result
  })

  it('handles mixed content: only tool_result blocks are trimmed', () => {
    const big = 'z'.repeat(80_000)
    const msg = userMsg([
      { type: 'text', text: 'context' },
      { type: 'tool_result', tool_use_id: 'tu_4', content: big },
    ])
    trimLargeToolResults(msg)
    const content = (msg as { message: { content: Array<unknown> } }).message.content
    // Text block untouched
    expect((content[0] as { text: string }).text).toBe('context')
    // tool_result trimmed
    expect((content[1] as { content: string }).content.length).toBeLessThan(big.length)
    expect((content[1] as { content: string }).content).toContain('chars omitted')
  })

  it('preserves head and tail in trimmed output', () => {
    const head = 'START_MARKER_' + 'a'.repeat(30_000)
    const tail = 'b'.repeat(20_000) + '_END_MARKER'
    const big = head + tail
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_5', content: big }])
    trimLargeToolResults(msg)
    const result = (msg as { message: { content: Array<{ content: string }> } })
      .message.content[0].content
    expect(result).toContain('START_MARKER_')
    expect(result).toContain('_END_MARKER')
    expect(result).toContain('chars omitted')
  })

  // --- Boundary tests ---

  it('does not trim content at exactly the 50K limit', () => {
    const exact = 'a'.repeat(50_000)
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_b1', content: exact }])
    trimLargeToolResults(msg)
    const block = (msg as { message: { content: Array<{ content: string }> } })
      .message.content[0]
    expect(block.content).toBe(exact) // same reference, untouched
  })

  it('trims content one char over the limit', () => {
    const over = 'a'.repeat(50_001)
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_b2', content: over }])
    trimLargeToolResults(msg)
    const block = (msg as { message: { content: Array<{ content: string }> } })
      .message.content[0]
    expect(block.content.length).toBeLessThan(50_001)
    expect(block.content).toContain('chars omitted')
  })

  // --- Exact output size ---

  it('produces expected output size: head(30K) + marker + tail(15K)', () => {
    const big = 'x'.repeat(80_000)
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_s1', content: big }])
    trimLargeToolResults(msg)
    const result = (msg as { message: { content: Array<{ content: string }> } })
      .message.content[0].content
    // 30_000 (head) + "\n\n[... 35000 chars omitted ...]\n\n" (29 chars) + 15_000 (tail)
    const marker = '\n\n[... 35000 chars omitted ...]\n\n'
    expect(result.length).toBe(30_000 + marker.length + 15_000)
  })

  // --- Null / empty content ---

  it('handles tool_result with null content without throwing', () => {
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_n1', content: null }])
    expect(() => trimLargeToolResults(msg)).not.toThrow()
  })

  it('handles tool_result with undefined content without throwing', () => {
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_n2' }])
    expect(() => trimLargeToolResults(msg)).not.toThrow()
  })

  it('handles tool_result with empty array content without throwing', () => {
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_n3', content: [] }])
    expect(() => trimLargeToolResults(msg)).not.toThrow()
  })

  // --- Multiple tool_result blocks ---

  it('trims only the oversized block when multiple tool_results exist', () => {
    const small = 'small output'
    const big = 'z'.repeat(80_000)
    const msg = userMsg([
      { type: 'tool_result', tool_use_id: 'tu_m1', content: small },
      { type: 'tool_result', tool_use_id: 'tu_m2', content: big },
      { type: 'tool_result', tool_use_id: 'tu_m3', content: small },
    ])
    trimLargeToolResults(msg)
    const blocks = (msg as { message: { content: Array<{ content: string }> } })
      .message.content
    expect(blocks[0].content).toBe(small) // untouched
    expect(blocks[1].content.length).toBeLessThan(big.length) // trimmed
    expect(blocks[1].content).toContain('chars omitted')
    expect(blocks[2].content).toBe(small) // untouched
  })

  // --- Negative: assistant messages ---

  it('does not touch tool_result-like blocks inside assistant messages', () => {
    const big = 'a'.repeat(80_000)
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu', input: { data: big } }] },
    } as unknown as SDKMessage
    trimLargeToolResults(msg)
    // The big string inside input.data should be untouched — the function
    // only processes user messages.
    const content = (msg as { message: { content: unknown[] } }).message.content
    const block = content[0] as { input: { data: string } }
    expect(block.input.data).toBe(big)
  })
})
