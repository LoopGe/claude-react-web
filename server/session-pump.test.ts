import { describe, it, expect, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  applyTaskEvent,
  backgroundSubagentLaunches,
  fastModeStateOf,
  hookLifecycleMessage,
  isTaskNotificationUserMessage,
  liteContextUsageFromAssistant,
  liteContextUsageFromResult,
  pump,
  toolResultIds,
  trimLargeToolResults,
  userMessageHasToolResult,
  type PumpDeps,
} from './session-pump.js'
import type { LiteContextUsage } from './session-pump.js'
import type { Session } from './session-types.js'
import type { TaskRecordUi } from '../shared/tasks.js'
import { isTranscriptMessage, shouldBroadcastMessage } from './history-utils.js'

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

// ---------------------------------------------------------------------------
// shouldBroadcastMessage — which system frames reach the client.
//
// The client reducer's async-subagent completion branch fires on a
// `system`/`task_notification` frame (the SDK's background-task completion
// signal). If that frame is filtered out of the broadcast the reducer never
// sees it, the subagent stays on `background` forever, and its chip never
// leaves the WorkingBubble. Regression coverage for that bug.
// ---------------------------------------------------------------------------
describe('shouldBroadcastMessage', () => {
  it('broadcasts system/task_notification so the reducer can flip a background subagent to done', () => {
    const frame = { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' } as unknown as {
      type?: string
      subtype?: string
    }
    expect(shouldBroadcastMessage(frame)).toBe(true)
  })

  it('still filters unrelated system frames (init, status, task_progress)', () => {
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'init' })).toBe(false)
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'status' })).toBe(false)
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'task_progress' })).toBe(false)
  })

  it('still broadcasts non-system messages and the kept error subtypes', () => {
    expect(shouldBroadcastMessage({ type: 'assistant' })).toBe(true)
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'error' })).toBe(true)
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'api_retry' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isTranscriptMessage — which SDK messages enter the durable history ring
// (and therefore the WS full-replay surface).
//
// Regression coverage for the "reload loses a just-sent user message" bug: the
// 500-cap ring used to store ephemeral `stream_event` deltas as if they were
// transcript messages, so a heavy streaming turn (~200 deltas/s) evicted
// durable content (a just-sent user message, assistant messages, tool results)
// from the replay surface within seconds. Deltas are still LIVE-streamed to
// subscribers; they just must never enter the ring.
// ---------------------------------------------------------------------------
describe('isTranscriptMessage', () => {
  it('excludes ephemeral stream_event deltas from the durable ring', () => {
    expect(isTranscriptMessage({ type: 'stream_event' })).toBe(false)
  })

  it('retains every durable message type (user / assistant / result / system)', () => {
    expect(isTranscriptMessage({ type: 'user' })).toBe(true)
    expect(isTranscriptMessage({ type: 'assistant' })).toBe(true)
    expect(isTranscriptMessage({ type: 'result' })).toBe(true)
    expect(isTranscriptMessage({ type: 'system' })).toBe(true)
  })

  it('is defensive when type is missing', () => {
    expect(isTranscriptMessage({})).toBe(true)
  })
})

describe('backgroundSubagentLaunches', () => {
  const ackContent =
    'Async agent launched successfully. (internal metadata.)\nagentId: ace1f1c484c82bcdf\nThe agent is working in the background.'

  it('detects an async launch ack tool_result and parses its agentId + tool_use_id', () => {
    const msg = userMsg([
      { type: 'tool_result', tool_use_id: 'tu_agent', content: ackContent },
    ]) as unknown as SDKMessage
    const launches = backgroundSubagentLaunches(msg)
    expect(launches).toEqual([{ toolUseId: 'tu_agent', agentId: 'ace1f1c484c82bcdf' }])
  })

  it('ignores a synchronous subagent real tool_result (no ack signature)', () => {
    const msg = userMsg([
      { type: 'tool_result', tool_use_id: 'tu_sync', content: 'I found that the async agent launched at 14:32.' },
    ]) as unknown as SDKMessage
    expect(backgroundSubagentLaunches(msg)).toEqual([])
  })

  it('ignores non-user messages and tool_results without an agentId', () => {
    expect(backgroundSubagentLaunches({ type: 'assistant' } as unknown as SDKMessage)).toEqual([])
    const msg = userMsg([
      { type: 'tool_result', tool_use_id: 'tu_x', content: 'Async agent launched successfully but no id here' },
    ]) as unknown as SDKMessage
    expect(backgroundSubagentLaunches(msg)).toEqual([])
  })

  it('handles array-content acks (text blocks)', () => {
    const msg = userMsg([
      { type: 'tool_result', tool_use_id: 'tu_arr', content: [{ type: 'text', text: ackContent }] },
    ]) as unknown as SDKMessage
    expect(backgroundSubagentLaunches(msg)).toEqual([{ toolUseId: 'tu_arr', agentId: 'ace1f1c484c82bcdf' }])
  })
})

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

  it('is true for a string-content user message that is a full <task-notification> block', () => {
    expect(isTaskNotificationUserMessage(userMsg('  <task-notification>\n<task-id>t1</task-id>\n</task-notification>'))).toBe(true)
  })

  it('is false for a string-content user message that merely starts with <task-notification> (no closing tag)', () => {
    // A human typing "<task-notification>..." (e.g. asking about the format)
    // must NOT be mistaken for a harness injection — the detector requires a
    // well-formed block with a closing tag.
    expect(isTaskNotificationUserMessage(userMsg('  <task-notification>...'))).toBe(false)
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

  it('returns null for a spawn/restart warm-up result with all-zero usage', () => {
    // The SDK emits a placeholder `result` at spawn/restart with iterations=[]
    // and every bucket zero. Broadcasting it would clobber the last good
    // snapshot with `0 / N · 0.0%` — keep the last good value instead.
    const msg = makeResult({
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [],
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('returns null (keeps last good) when a cumulative cache_read bucket exceeds the context window', () => {
    // Some proxies return a cumulative conversation counter in
    // cache_read_input_tokens (4M for a long chat) instead of a per-request
    // value. A single bucket can never exceed the window in a valid response,
    // so the payload is provably corrupt — and `input_tokens` alone is only
    // the NON-cached portion (Anthropic docs), so emitting it would under-
    // report a cached conversation by orders of magnitude. Return null → the
    // pump keeps the last good snapshot instead of collapsing the bar.
    const msg = makeResult({
      usage: { input_tokens: 50000, cache_read_input_tokens: 4000000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('returns null (keeps last good) when a cumulative cache_creation bucket exceeds the context window', () => {
    const msg = makeResult({
      usage: { input_tokens: 1000, cache_creation_input_tokens: 3000000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('returns null (keeps last good) when both cache buckets exceed the context window', () => {
    const msg = makeResult({
      usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 4000000,
        cache_read_input_tokens: 5000000,
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('returns null for the production corruption shape (small input + cache_read over window)', () => {
    // Regression: session 8481f67b flip-flopped between 67% (cache_read 0.67M
    // kept) and 0.04% (cache_read 1.3M dropped → input-only fallback of 400).
    // With Guard 1 now rejecting the whole snapshot, the tiny reading is
    // impossible — this shape keeps the last good value instead.
    const msg = makeResult({
      usage: { input_tokens: 400, cache_read_input_tokens: 1326080 },
      modelUsage: { 'deepseek/deepseek-v4-flash': { contextWindow: 1000000 } },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('returns null when input_tokens alone exceeds the context window', () => {
    // Guard 1 only drops cache buckets; a real input_tokens over the window
    // is still unparseable and must keep the last good value (never a false
    // 100% reading).
    const msg = makeResult({
      usage: { input_tokens: 300000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
  })

  it('keeps a cache bucket exactly at the context window (not dropped)', () => {
    // Guard 1 drops buckets strictly GREATER than the window (`>`), so a
    // bucket exactly equal to it is legitimate — prompt fully in cache at
    // exactly 100%. Pin the boundary so the `>` vs `>=` choice stays.
    const msg = makeResult({
      usage: { input_tokens: 0, cache_read_input_tokens: 200000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out).not.toBeNull()
    expect(out!.totalTokens).toBe(200000)
    expect(out!.percentage).toBe(100)
    expect(out!.cacheReadTokens).toBe(200000)
  })

  it('rejects a dropped cache bucket even when input is zero (Guard 1 short-circuit)', () => {
    // input=0 with a cache_read bucket over the window: Guard 1 rejects the
    // whole snapshot (dropped bucket → return null). This exercises the
    // drop-path independently of the zero-total Guard 2, which no longer gets
    // a chance to run for corrupt cache payloads.
    const msg = makeResult({
      usage: { input_tokens: 0, cache_read_input_tokens: 4000000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)).toBeNull()
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

  it('returns null for an all-zero usage payload (opening assistant frame)', () => {
    // Every turn's opening assistant message carries a usage object that is
    // present but all-zero. Broadcasting it would drop the bar to 0%.
    expect(liteContextUsageFromAssistant(makeAssistant({ usage: {} }), cached)).toBeNull()
  })

  it('returns null when input and output tokens are both zero', () => {
    const msg = makeAssistant({ usage: { input_tokens: 0, output_tokens: 0 } })
    expect(liteContextUsageFromAssistant(msg, cached)).toBeNull()
  })

  it('returns null (keeps last good) when a cumulative cache_read bucket exceeds the cached window', () => {
    const msg = makeAssistant({
      usage: { input_tokens: 1000, cache_read_input_tokens: 3000000 },
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

// ---------------------------------------------------------------------------
// applyTaskEvent — fold one SDK task_* system frame into `session.tasks`
// and push a full snapshot to the session's taskSubscribers.
//
// Upsert semantics are the core contract: task_updated / task_progress /
// task_notification may arrive WITHOUT a prior task_started (frame loss,
// late subscribe, CLI quirks), so a missing record must be created as a
// stub from whatever the frame carries — the TasksPanel shows partial
// state rather than a hole.
// ---------------------------------------------------------------------------

function makeTaskSession(): { session: Session; snapshots: TaskRecordUi[][] } {
  const snapshots: TaskRecordUi[][] = []
  const session = {
    tasks: new Map<string, TaskRecordUi>(),
    taskSubscribers: new Set([{ push: (t: TaskRecordUi[]) => snapshots.push(t) }]),
  } as unknown as Session
  return { session, snapshots }
}

function sysFrame(subtype: string, extra: Record<string, unknown> = {}): SDKMessage {
  return { type: 'system', subtype, ...extra } as unknown as SDKMessage
}

describe('applyTaskEvent', () => {
  it('task_started creates a running record with the frame fields narrowed', () => {
    const { session } = makeTaskSession()
    applyTaskEvent(session, sysFrame('task_started', {
      task_id: 't1',
      tool_use_id: 'tu1',
      description: 'run sleep 300',
      subagent_type: 'Explore',
      task_type: 'shell',
      workflow_name: 'wf',
      skip_transcript: true,
      receivedAt: 111,
    }))
    expect(session.tasks.get('t1')).toMatchObject({
      taskId: 't1',
      toolUseId: 'tu1',
      description: 'run sleep 300',
      subagentType: 'Explore',
      taskType: 'shell',
      workflowName: 'wf',
      status: 'running',
      skipTranscript: true,
      startedAt: 111,
      endedAt: undefined,
    })
  })

  it('ignores non-system frames, non-task subtypes, and frames without a task_id', () => {
    const { session } = makeTaskSession()
    applyTaskEvent(session, { type: 'assistant' } as unknown as SDKMessage)
    applyTaskEvent(session, sysFrame('init'))
    applyTaskEvent(session, sysFrame('task_started', { task_id: '' }))
    applyTaskEvent(session, sysFrame('task_progress', { task_id: 42 }))
    expect(session.tasks.size).toBe(0)
  })

  it('upserts a stub when task_updated arrives before task_started (frame loss)', () => {
    const { session } = makeTaskSession()
    applyTaskEvent(session, sysFrame('task_updated', {
      task_id: 't1',
      tool_use_id: 'tu9',
      patch: {
        status: 'completed',
        description: 'late description',
        is_backgrounded: true,
        end_time: 123,
      },
    }))
    expect(session.tasks.get('t1')).toMatchObject({
      taskId: 't1',
      toolUseId: 'tu9',
      description: 'late description',
      status: 'completed',
      isBackgrounded: true,
      endedAt: 123,
    })
  })

  it('upserts a stub when task_progress arrives first, carrying summary + last_tool_name', () => {
    const { session } = makeTaskSession()
    applyTaskEvent(session, sysFrame('task_progress', {
      task_id: 't1',
      tool_use_id: 'tu1',
      description: 'd',
      subagent_type: 'Explore',
      summary: 'reading files',
      last_tool_name: 'Read',
    }))
    expect(session.tasks.get('t1')).toMatchObject({
      taskId: 't1',
      toolUseId: 'tu1',
      description: 'd',
      subagentType: 'Explore',
      progressSummary: 'reading files',
      lastToolName: 'Read',
      status: 'running',
    })
  })

  it('task_updated merges the patch over an existing record; invalid status keeps the old one', () => {
    const { session } = makeTaskSession()
    applyTaskEvent(session, sysFrame('task_started', { task_id: 't1', description: 'orig' }))
    applyTaskEvent(session, sysFrame('task_updated', {
      task_id: 't1',
      patch: { is_backgrounded: true, status: 'bogus' },
    }))
    expect(session.tasks.get('t1')).toMatchObject({
      description: 'orig', // patch carried no description — preserved
      status: 'running', // invalid patch status ignored
      isBackgrounded: true,
    })
  })

  it('a late task_started preserves state earlier frames established (upsert, not replace)', () => {
    const { session } = makeTaskSession()
    // task_updated + task_progress land FIRST (upsert stubs — frame loss or
    // the watcher-seed path), then a task_started arrives for the same
    // task_id: it must not erase isBackgrounded / progressSummary /
    // lastToolName an earlier frame already established.
    applyTaskEvent(session, sysFrame('task_updated', {
      task_id: 't1',
      patch: { is_backgrounded: true },
    }))
    applyTaskEvent(session, sysFrame('task_progress', {
      task_id: 't1',
      summary: 'halfway',
      last_tool_name: 'Grep',
    }))
    applyTaskEvent(session, sysFrame('task_started', {
      task_id: 't1',
      description: 'sleep',
      receivedAt: 500,
    }))
    expect(session.tasks.get('t1')).toMatchObject({
      description: 'sleep',
      status: 'running',
      isBackgrounded: true,
      progressSummary: 'halfway',
      lastToolName: 'Grep',
    })
  })

  it('task_notification settles a terminal status and stamps endedAt from the frame receivedAt', () => {
    const { session } = makeTaskSession()
    applyTaskEvent(session, sysFrame('task_started', { task_id: 't1', receivedAt: 100 }))
    applyTaskEvent(session, sysFrame('task_notification', {
      task_id: 't1',
      status: 'failed',
      summary: 'boom',
      receivedAt: 999,
    }))
    expect(session.tasks.get('t1')).toMatchObject({
      status: 'failed',
      progressSummary: 'boom',
      endedAt: 999,
    })
  })

  it('task_notification with a non-terminal status keeps the record status', () => {
    const { session } = makeTaskSession()
    applyTaskEvent(session, sysFrame('task_started', { task_id: 't1' }))
    applyTaskEvent(session, sysFrame('task_notification', { task_id: 't1', status: 'running' }))
    expect(session.tasks.get('t1')?.status).toBe('running')
  })

  it('pushes a full snapshot to every taskSubscriber on each fold', () => {
    const { session, snapshots } = makeTaskSession()
    applyTaskEvent(session, sysFrame('task_started', { task_id: 't1' }))
    applyTaskEvent(session, sysFrame('task_progress', { task_id: 't1', summary: 's' }))
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toHaveLength(1)
    expect(snapshots[1][0]).toMatchObject({ taskId: 't1', progressSummary: 's' })
  })

  it('evicts the oldest terminal records beyond 50; active tasks are never evicted', () => {
    const { session } = makeTaskSession()
    for (let i = 0; i < 52; i++) {
      applyTaskEvent(session, sysFrame('task_started', { task_id: `t${i}` }))
      applyTaskEvent(session, sysFrame('task_updated', { task_id: `t${i}`, patch: { status: 'completed' } }))
    }
    applyTaskEvent(session, sysFrame('task_started', { task_id: 'active-1' }))
    // 52 terminals → capped at 50, oldest evicted; the active record survives.
    expect(session.tasks.size).toBe(51)
    expect(session.tasks.has('t0')).toBe(false)
    expect(session.tasks.has('t1')).toBe(false)
    expect(session.tasks.has('t2')).toBe(true)
    expect(session.tasks.has('t51')).toBe(true)
    expect(session.tasks.has('active-1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// pump: task lifecycle frames
//
// task_started / task_updated / task_progress are EPHEMERAL — they fold into
// session.tasks and ride the dedicated `tasks` snapshot channel, but must
// NEVER enter the history ring or the message broadcast (ring slots are for
// durable transcript content; task_progress fires ~every 30s per subagent).
// task_notification folds the SAME task state but keeps flowing through the
// ring + broadcast path (the client reducer's async-subagent completion
// branch matches on it) and notifies the manager so the subagent watcher
// can be cancelled (real frame beats the synthesized backstop).
// ---------------------------------------------------------------------------

function makePumpSession(msgs: SDKMessage[]): {
  session: Session
  broadcasts: SDKMessage[]
  taskSnapshots: TaskRecordUi[][]
} {
  let i = 0
  const messages = {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve(
          i < msgs.length
            ? { value: msgs[i++], done: false as const }
            : { value: undefined, done: true as const },
        ),
      }
    },
  }
  const broadcasts: SDKMessage[] = []
  const taskSnapshots: TaskRecordUi[][] = []
  const session = {
    id: 's-pump',
    handle: { messages, abortSignal: new AbortController().signal, queueDepth: 0 },
    subscribers: new Map([['c1', { push: (m: SDKMessage) => broadcasts.push(m) }]]),
    taskSubscribers: new Set([{ push: (t: TaskRecordUi[]) => taskSnapshots.push(t) }]),
    promptSuggestionSubscribers: new Set(),
    contextUsageSubscribers: new Set(),
    tasks: new Map(),
    history: [],
    subagentHistory: [],
    pending: new Map(),
    hookRuns: [],
    pendingTurns: 0,
    lastActivityAt: 0,
    lastPromptSuggestion: undefined,
    lastContextUsage: undefined,
    lastAssistantUuid: undefined,
    lastSafeResumeUuid: undefined,
    lastTurnAt: undefined,
    lastCrash: undefined,
    fastModeState: undefined,
    autoInterruptedAt: undefined,
    error: undefined,
    clearing: false,
    terminated: false,
    terminatedReason: undefined,
    running: true,
    exiting: false,
    recovering: false,
  } as unknown as Session
  return { session, broadcasts, taskSnapshots }
}

function makePumpDeps(overrides: Partial<PumpDeps> = {}): PumpDeps {
  return {
    historyCap: 100,
    subagentHistoryCap: 100,
    persist: () => {},
    denyPendingPermissions: () => {},
    isLive: () => true,
    broadcastCommandsChanged: () => {},
    ...overrides,
  }
}

describe('pump: task lifecycle frames', () => {
  it('early-continues task_started/updated/progress: folds state + snapshot, skips ring + broadcast', async () => {
    const { session, broadcasts, taskSnapshots } = makePumpSession([
      sysFrame('task_started', { task_id: 't1', tool_use_id: 'tu1', description: 'sleep', task_type: 'shell' }),
      sysFrame('task_progress', { task_id: 't1', summary: 'sleeping', last_tool_name: 'Bash' }),
      sysFrame('task_updated', { task_id: 't1', patch: { is_backgrounded: true } }),
      sysFrame('task_notification', { task_id: 't1', tool_use_id: 'tu1', status: 'completed' }),
      { type: 'result', subtype: 'success', uuid: 'r1' } as unknown as SDKMessage,
    ])
    const onTaskNotification = vi.fn()
    await pump(session, makePumpDeps({ onTaskNotification }))

    // Ephemeral frames never entered the ring; notification + result did.
    const ringSubtypes = session.history.map((m) => (m as { subtype?: string }).subtype)
    expect(ringSubtypes).toEqual(['task_notification', 'success'])
    // Only the notification + the result turn were broadcast on the message
    // channel (the three ephemeral frames never reached it).
    expect(broadcasts.map((m) => (m as { subtype?: string }).subtype)).toEqual(['task_notification', 'success'])
    // All four frames folded task state and each pushed a full snapshot.
    expect(taskSnapshots).toHaveLength(4)
    expect(session.tasks.get('t1')).toMatchObject({
      status: 'completed',
      isBackgrounded: true,
      progressSummary: 'sleeping',
      lastToolName: 'Bash',
      description: 'sleep',
      taskType: 'shell',
    })
    // The real notification reached the manager (cancels the subagent watcher).
    expect(onTaskNotification).toHaveBeenCalledTimes(1)
    expect(onTaskNotification).toHaveBeenCalledWith('s-pump', 'tu1')
  })

  it('skips the onTaskNotification dep when the notification carries no tool_use_id', async () => {
    const { session } = makePumpSession([
      sysFrame('task_notification', { task_id: 't1', status: 'completed' }),
    ])
    const onTaskNotification = vi.fn()
    await pump(session, makePumpDeps({ onTaskNotification }))
    expect(onTaskNotification).not.toHaveBeenCalled()
    // The frame itself still folded + broadcast as usual.
    expect(session.tasks.get('t1')?.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// pump: CLI notification frames (SDK system/notification)
//
// These are transient UI signals ("waiting for your input", idle nudges) —
// NOT transcript content. The pump narrows them, hands the payload to the
// manager (which mirrors it onto the global WS channel), and early-continues:
// no ring slot, no message-channel broadcast. Malformed frames (missing
// text/priority) are dropped with a warn rather than forwarded.
// ---------------------------------------------------------------------------

describe('pump: cli notification frames', () => {
  it('narrows a notification frame, fires the dep, and skips ring + broadcast', async () => {
    const { session, broadcasts } = makePumpSession([
      sysFrame('notification', {
        key: 'idle',
        text: 'Claude is waiting for your input',
        priority: 'medium',
        timeout_ms: 5000,
      }),
      { type: 'result', subtype: 'success', uuid: 'r1' } as unknown as SDKMessage,
    ])
    const onCliNotification = vi.fn()
    await pump(session, makePumpDeps({ onCliNotification }))

    expect(onCliNotification).toHaveBeenCalledTimes(1)
    expect(onCliNotification).toHaveBeenCalledWith('s-pump', {
      key: 'idle',
      text: 'Claude is waiting for your input',
      priority: 'medium',
      timeoutMs: 5000,
    })
    // Ephemeral: only the result entered the ring / message broadcast.
    const ringSubtypes = session.history.map((m) => (m as { subtype?: string }).subtype)
    expect(ringSubtypes).toEqual(['success'])
    expect(broadcasts.map((m) => (m as { subtype?: string }).subtype)).toEqual(['success'])
  })

  it('drops a malformed notification frame (no text) without firing the dep', async () => {
    const { session } = makePumpSession([
      sysFrame('notification', { priority: 'high' }),
    ])
    const onCliNotification = vi.fn()
    await pump(session, makePumpDeps({ onCliNotification }))
    expect(onCliNotification).not.toHaveBeenCalled()
    expect(session.history).toHaveLength(0)
  })

  it('drops a notification frame with an unknown priority', async () => {
    const { session } = makePumpSession([
      sysFrame('notification', { text: 'hi', priority: 'urgent' }),
    ])
    const onCliNotification = vi.fn()
    await pump(session, makePumpDeps({ onCliNotification }))
    expect(onCliNotification).not.toHaveBeenCalled()
    expect(session.history).toHaveLength(0)
  })
})
