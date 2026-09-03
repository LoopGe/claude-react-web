import { describe, it, expect, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  applyBackgroundTasksChanged,
  applyTaskEvent,
  backgroundSubagentLaunches,
  compactingOf,
  fastModeStateOf,
  hookLifecycleMessage,
  isTaskNotificationUserMessage,
  liteContextUsageFromAssistant,
  liteContextUsageFromResult,
  pump,
  reapplyAutoCompactWindow,
  toolResultIds,
  userMessageHasToolResult,
  type PumpDeps,
} from './session-pump.js'
import type { LiteContextUsage } from './session-pump.js'
import type { Session } from './session-types.js'
import type { TaskRecordUi } from '../shared/tasks.js'
import { isTranscriptMessage, shouldBroadcastMessage, trimLargeToolResults } from './history-utils.js'

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

  it('broadcasts permission_denied / informational / model_refusal_fallback (render + eviction signals)', () => {
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'permission_denied' })).toBe(true)
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'informational' })).toBe(true)
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'model_refusal_fallback' })).toBe(true)
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

  it('surfaces the model maxOutputTokens on the lite snapshot', () => {
    const msg = makeResult({
      usage: { input_tokens: 50000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000, maxOutputTokens: 32000 } },
    })
    expect(liteContextUsageFromResult(msg)!.maxOutputTokens).toBe(32000)
  })

  it('omits maxOutputTokens when the model does not report it', () => {
    const msg = makeResult({
      usage: { input_tokens: 50000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    expect(liteContextUsageFromResult(msg)!.maxOutputTokens).toBeUndefined()
  })

  it('derives autoCompactThreshold from windowOverride instead of the model contextWindow', () => {
    // A 1M model (contextWindow 1000000) pinned to a 200K window via
    // windowOverride. effective = 200000 - min(20000, 20000) = 180000;
    // threshold = 180000 - 13000 = 167000 — NOT the model-derived value.
    const msg = makeResult({
      usage: { input_tokens: 1000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 1000000 } },
    })
    expect(liteContextUsageFromResult(msg, 200000)!.autoCompactThreshold).toBe(167000)
  })

  it('windowOverride respects the maxOutputTokens floor like the model window does', () => {
    // maxOutputTokens 8000 < 20000 floor → effective = 200000 - 8000 = 192000
    // threshold = 192000 - 13000 = 179000
    const msg = makeResult({
      usage: { input_tokens: 1000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 1000000, maxOutputTokens: 8000 } },
    })
    expect(liteContextUsageFromResult(msg, 200000)!.autoCompactThreshold).toBe(179000)
  })

  it('ignores a non-positive windowOverride (falls back to the model window)', () => {
    // windowOverride 0 / undefined / negative must not produce a bogus
    // threshold — the existing tests above already cover the undefined case.
    const msg = makeResult({
      usage: { input_tokens: 1000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000, maxOutputTokens: 32000 } },
    })
    expect(liteContextUsageFromResult(msg, 0)!.autoCompactThreshold).toBe(167000)
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

  it('drops a corrupt cache_read bucket and reports the non-cached input total', () => {
    // Some proxies return a garbage conversation counter in
    // cache_read_input_tokens (4M for a long chat) instead of a per-request
    // value. A single bucket can never exceed the window in a valid response,
    // so the payload is provably corrupt — drop the bucket and report the
    // surviving non-cached input_tokens. `input_tokens` alone under-reports a
    // genuinely cached conversation, but a bucket over the window is *by
    // definition* not a legitimate cache hit (the full prompt must fit in the
    // window), so this is the best non-blocking estimate for a corrupt turn.
    const msg = makeResult({
      usage: { input_tokens: 50000, cache_read_input_tokens: 4000000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out).not.toBeNull()
    expect(out!.totalTokens).toBe(50000)
    expect(out!.percentage).toBe(25)
    expect(out!.cacheReadTokens).toBeUndefined()
    expect(out!.degraded).toBe(true)
  })

  it('drops a corrupt cache_creation bucket and reports the non-cached input total', () => {
    const msg = makeResult({
      usage: { input_tokens: 1000, cache_creation_input_tokens: 3000000 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out).not.toBeNull()
    expect(out!.totalTokens).toBe(1000)
    expect(out!.cacheCreationTokens).toBeUndefined()
    expect(out!.degraded).toBe(true)
  })

  it('drops both corrupt cache buckets and reports the non-cached input total', () => {
    const msg = makeResult({
      usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 4000000,
        cache_read_input_tokens: 5000000,
      },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out).not.toBeNull()
    expect(out!.totalTokens).toBe(1000)
    expect(out!.cacheCreationTokens).toBeUndefined()
    expect(out!.cacheReadTokens).toBeUndefined()
    expect(out!.degraded).toBe(true)
  })

  it('reports the input-only fallback for the production corruption shape (small input + cache_read over window)', () => {
    // Regression: session 8481f67b flip-flopped between 67% (cache_read 0.67M
    // kept) and 0.04% (cache_read 1.3M dropped → input-only fallback of 400).
    // The tiny reading is the best non-blocking estimate for a corrupt turn —
    // the authoritative breakdown comes from the on-demand SettingsPanel REST
    // endpoint. Rejecting the whole snapshot instead froze the bar empty on a
    // proxy that returns a corrupt bucket on EVERY turn (no last-good to keep).
    const msg = makeResult({
      usage: { input_tokens: 400, cache_read_input_tokens: 1326080 },
      modelUsage: { 'deepseek/deepseek-v4-flash': { contextWindow: 1000000 } },
    })
    const out = liteContextUsageFromResult(msg)
    expect(out).not.toBeNull()
    expect(out!.totalTokens).toBe(400)
    expect(out!.percentage).toBeCloseTo(0.04, 10)
    expect(out!.cacheReadTokens).toBeUndefined()
    expect(out!.degraded).toBe(true)
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
    // Bucket at the window is legitimate, not degraded.
    expect(out!.degraded).toBeUndefined()
  })

  it('rejects a corrupt bucket whose survivors total zero (Guard 2 zero-total)', () => {
    // input=0 with a cache_read bucket over the window: Guard 1 drops the
    // bucket, the recomputed total is 0, and Guard 2 (zero-total) returns
    // null — so a dropped corrupt bucket can never broadcast a false 0%.
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
    maxOutputTokens: 32000,
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
    expect(out!.maxOutputTokens).toBe(32000)
    // Cache buckets forwarded from the assistant message's own usage.
    expect(out!.cacheCreationTokens).toBe(200)
    expect(out!.cacheReadTokens).toBe(5000)
    // All buckets fit in the window — a healthy snapshot, not degraded.
    expect(out!.degraded).toBeUndefined()
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

  it('drops a corrupt cache_read bucket and reports the non-cached input total', () => {
    const msg = makeAssistant({
      usage: { input_tokens: 1000, cache_read_input_tokens: 3000000 },
    })
    const out = liteContextUsageFromAssistant(msg, cached)
    expect(out).not.toBeNull()
    expect(out!.totalTokens).toBe(1000)
    expect(out!.cacheReadTokens).toBeUndefined()
    expect(out!.degraded).toBe(true)
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

describe('compactingOf', () => {
  it('extracts true/false from system/status frames', () => {
    expect(compactingOf(sysFrame('status', { status: 'compacting' }))).toBe(true)
    expect(compactingOf(sysFrame('status', { status: null }))).toBe(false)
    expect(compactingOf(sysFrame('status', { status: 'requesting' }))).toBe(false)
  })

  it('returns undefined for anything that is not a system/status frame', () => {
    expect(compactingOf({ type: 'system', subtype: 'init' } as never)).toBeUndefined()
    expect(compactingOf({ type: 'assistant' } as never)).toBeUndefined()
    expect(compactingOf({ type: 'result', subtype: 'success' } as never)).toBeUndefined()
  })

  it('treats a status frame with an absent/unrecognized status as not compacting', () => {
    // `status` is required on SDK status frames, but defensively an absent or
    // unknown value means "not compacting" (same as `null` / `requesting`).
    expect(compactingOf({ type: 'system', subtype: 'status' } as never)).toBe(false)
    expect(compactingOf(sysFrame('status', { status: 'bogus' }))).toBe(false)
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

  // --- Top-level `tool_use_result` ---
  //
  // The SDK ALSO writes the full tool output at the TOP LEVEL of a user
  // frame (`tool_use_result`, snake_case on the live Query stream — the CLI's
  // on-disk JSONL spells it `toolUseResult`), separate from the
  // `message.content` tool_result block. trimLargeToolResultBlock above only
  // shrinks the in-content block; without this drop a multi-MB tool output
  // (e.g. a WebFetch page) rides into the history ring and WS replay in full,
  // blowing past MAX_QUEUE_CHARS on every subscribe → 1011 force-close → the
  // "Stream reconnecting…" loop. The field is read nowhere in the app.

  it('drops a large top-level tool_use_result on a user message', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_tr1', content: 'small' }] },
      tool_use_result: [{ type: 'text', text: 'x'.repeat(2_000_000) }],
    } as unknown as SDKMessage
    trimLargeToolResults(msg)
    expect((msg as { tool_use_result?: unknown }).tool_use_result).toBeUndefined()
    // The in-content tool_result block is untouched when small.
    const block = (msg as { message: { content: Array<{ content: string }> } }).message.content[0]
    expect(block.content).toBe('small')
  })

  it('drops tool_use_result even when the content block is also trimmed', () => {
    const big = 'z'.repeat(80_000)
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_tr2', content: big }] },
      tool_use_result: [{ type: 'text', text: big }],
    } as unknown as SDKMessage
    trimLargeToolResults(msg)
    expect((msg as { tool_use_result?: unknown }).tool_use_result).toBeUndefined()
    const block = (msg as { message: { content: Array<{ content: string }> } }).message.content[0]
    expect(block.content).toContain('chars omitted')
  })

  it('only drops tool_use_result on user messages (non-user frames untouched)', () => {
    const msg = {
      type: 'assistant',
      message: { content: [] },
      tool_use_result: [{ type: 'text', text: 'stays' }],
    } as unknown as SDKMessage
    trimLargeToolResults(msg)
    expect((msg as { tool_use_result?: unknown }).tool_use_result).toBeDefined()
  })

  // --- Oversized base64 `image` blocks inside tool_result content ---
  //
  // A screenshot / MCP image result puts a base64 `image` block in the
  // tool_result content array (the client RENDERS these as real <img>s — see
  // ToolResultDetails), so unlike the persist path we must NOT drop all
  // images. But an un-capped multi-MB image is the same 8M WS-frame poison as
  // the top-level tool_use_result above. Oversized images are REPLACED with a
  // text marker (truncating base64 would decode-fail and render as a broken
  // <img>); small images pass through untouched so screenshots keep working.

  it('replaces an oversized base64 image block inside array tool_result content with a text marker', () => {
    const msg = userMsg([{
      type: 'tool_result',
      tool_use_id: 'tu_img1',
      content: [
        { type: 'text', text: 'screenshot:' },
        { type: 'image', source: { type: 'base64', data: 'x'.repeat(2_500_000), media_type: 'image/png' } },
      ],
    }])
    trimLargeToolResults(msg)
    const content = (msg as { message: { content: Array<{ content: Array<{ type: string; text?: string }> }> } })
      .message.content[0].content
    expect(content[0].text).toBe('screenshot:') // text neighbor untouched
    expect(content[1].type).toBe('text')
    expect(content[1].text).toContain('image omitted')
    // The multi-MB base64 must not survive anywhere in the message.
    expect(JSON.stringify(msg)).not.toContain('x'.repeat(100))
  })

  it('replaces an oversized image-only tool_result (single object content) with a text marker', () => {
    const msg = userMsg([{
      type: 'tool_result',
      tool_use_id: 'tu_img2',
      content: { type: 'image', source: { type: 'base64', data: 'x'.repeat(2_500_000), media_type: 'image/png' } },
    }])
    trimLargeToolResults(msg)
    const block = (msg as { message: { content: Array<{ content: unknown }> } }).message.content[0]
    expect(block.content).toEqual({ type: 'text', text: '[image omitted — too large to sync]' })
  })

  it('head+tail truncates a bare single-object text tool_result content', () => {
    const big = 'z'.repeat(80_000)
    const msg = userMsg([{
      type: 'tool_result',
      tool_use_id: 'tu_singletxt',
      content: { type: 'text', text: big },
    }])
    trimLargeToolResults(msg)
    const block = (msg as { message: { content: Array<{ content: { type: string; text: string } }> } })
      .message.content[0]
    // Single-object shape preserved, text head+tail truncated in place.
    expect(block.content.type).toBe('text')
    expect(block.content.text.length).toBeLessThan(big.length)
    expect(block.content.text).toContain('chars omitted')
  })

  it('keeps small base64 image blocks untouched (screenshot tools keep rendering)', () => {
    const img = { type: 'image', source: { type: 'base64', data: 'small-img', media_type: 'image/png' } }
    const msg = userMsg([{ type: 'tool_result', tool_use_id: 'tu_img3', content: [img] }])
    trimLargeToolResults(msg)
    const content = (msg as { message: { content: Array<{ content: Array<unknown> }> } })
      .message.content[0].content
    expect(content[0]).toBe(img) // same reference — untouched
  })

  it('keeps an image at exactly the 2M cap and replaces one char over', () => {
    const atLimit = 'a'.repeat(2_000_000)
    const over = 'b'.repeat(2_000_001)
    const msg = userMsg([
      { type: 'tool_result', tool_use_id: 'tu_img4', content: [
        { type: 'image', source: { type: 'base64', data: atLimit, media_type: 'image/png' } },
      ] },
      { type: 'tool_result', tool_use_id: 'tu_img5', content: [
        { type: 'image', source: { type: 'base64', data: over, media_type: 'image/png' } },
      ] },
    ])
    trimLargeToolResults(msg)
    const blocks = (msg as { message: { content: Array<{ content: Array<{ type: string }> }> } })
      .message.content
    expect(blocks[0].content[0].type).toBe('image') // at limit → kept
    expect(blocks[1].content[0].type).toBe('text') // one over → replaced
  })

  it('does not cap url-source image blocks', () => {
    const msg = userMsg([{
      type: 'tool_result',
      tool_use_id: 'tu_img6',
      content: [{ type: 'image', source: { type: 'url', url: 'http://x' } }],
    }])
    trimLargeToolResults(msg)
    const content = (msg as { message: { content: Array<{ content: Array<{ type: string }> }> } })
      .message.content[0].content
    expect(content[0].type).toBe('image')
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
      ambient: true,
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
      ambient: true,
      startedAt: 111,
      endedAt: undefined,
    })
  })

  it('task_started keeps ambient undefined when the frame omits it (older CLIs)', () => {
    const { session } = makeTaskSession()
    applyTaskEvent(session, sysFrame('task_started', {
      task_id: 't2', description: 'plain task', receivedAt: 5,
    }))
    const rec = session.tasks.get('t2')!
    expect(rec.ambient).toBeUndefined()
    expect(rec.skipTranscript).toBeUndefined()
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
// applyBackgroundTasksChanged — REPLACE-semantics live-set snapshot.
// ---------------------------------------------------------------------------

describe('applyBackgroundTasksChanged', () => {
  it('seeds missing records as running + backgrounded and pushes a snapshot', () => {
    const { session, snapshots } = makeTaskSession()
    applyBackgroundTasksChanged(session, sysFrame('background_tasks_changed', {
      tasks: [
        { task_id: 'a1', task_type: 'subagent', description: 'research', ambient: false },
        { task_id: 'a2', task_type: 'shell', description: 'build', ambient: true },
      ],
    }))
    expect(session.tasks.get('a1')).toMatchObject({
      taskId: 'a1', taskType: 'subagent', description: 'research',
      status: 'running', isBackgrounded: true, ambient: false,
    })
    expect(session.tasks.get('a2')?.ambient).toBe(true)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toHaveLength(2)
  })

  it('never demotes or deletes existing records (forward-only reconcile)', () => {
    const { session } = makeTaskSession()
    // A completed foreground task and a running background task both predate the snapshot.
    session.tasks.set('done-1', { taskId: 'done-1', description: 'done', status: 'completed', updatedAt: 1 })
    session.tasks.set('bg-1', {
      taskId: 'bg-1', description: 'keep', status: 'running', isBackgrounded: true,
      progressSummary: 'keep me', updatedAt: 1,
    })
    // Snapshot lists only bg-1 (still live) and a NEW bg-2.
    applyBackgroundTasksChanged(session, sysFrame('background_tasks_changed', {
      tasks: [
        { task_id: 'bg-1', task_type: 'shell', description: 'keep' },
        { task_id: 'bg-2', task_type: 'subagent', description: 'new' },
      ],
    }))
    // done-1 absent from the live set is NOT deleted.
    expect(session.tasks.get('done-1')?.status).toBe('completed')
    // bg-1 keeps its progressSummary + status; description already present is untouched.
    expect(session.tasks.get('bg-1')).toMatchObject({ status: 'running', progressSummary: 'keep me', description: 'keep' })
    // bg-2 is seeded running.
    expect(session.tasks.get('bg-2')).toMatchObject({ taskId: 'bg-2', status: 'running', isBackgrounded: true })
  })

  it('back-fills only missing fields on an existing record', () => {
    const { session } = makeTaskSession()
    session.tasks.set('x', { taskId: 'x', description: '', status: 'running', updatedAt: 1 })
    applyBackgroundTasksChanged(session, sysFrame('background_tasks_changed', {
      tasks: [{ task_id: 'x', task_type: 'shell', description: 'late desc' }],
    }))
    expect(session.tasks.get('x')).toMatchObject({ description: 'late desc', taskType: 'shell', status: 'running' })
  })

  it('ignores non-system frames, other subtypes, and malformed tasks arrays', () => {
    const { session } = makeTaskSession()
    applyBackgroundTasksChanged(session, { type: 'assistant' } as unknown as SDKMessage)
    applyBackgroundTasksChanged(session, sysFrame('task_started', { task_id: 't1' }))
    applyBackgroundTasksChanged(session, { type: 'system', subtype: 'background_tasks_changed', tasks: 'nope' } as unknown as SDKMessage)
    applyBackgroundTasksChanged(session, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: '' }] } as unknown as SDKMessage)
    expect(session.tasks.size).toBe(0)
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

describe('pump: compacting state tracking', () => {
  it('sets session.compacting on a status frame and broadcasts a session-update', async () => {
    const { session } = makePumpSession([
      sysFrame('status', { status: 'compacting' }),
      { type: 'result', subtype: 'success', uuid: 'r1' } as unknown as SDKMessage,
    ])
    const broadcastInfo = vi.fn()
    await pump(session, makePumpDeps({ broadcastInfo }))

    // Transition in (compacting) + lifecycle clear on result.
    expect(broadcastInfo).toHaveBeenCalledTimes(2)
    expect(broadcastInfo).toHaveBeenCalledWith(session)
    // The result cleared the flag — compaction is a mid-turn phenomenon.
    expect(session.compacting).toBeUndefined()
  })

  it('clears compacting when a later status frame reports not-compacting', async () => {
    const { session } = makePumpSession([
      sysFrame('status', { status: 'compacting' }),
      sysFrame('status', { status: null }),
      { type: 'result', subtype: 'success', uuid: 'r1' } as unknown as SDKMessage,
    ])
    const broadcastInfo = vi.fn()
    await pump(session, makePumpDeps({ broadcastInfo }))

    // Two transitions: set (compacting) then clear (null) — the result had
    // nothing left to clear, so no third broadcast.
    expect(broadcastInfo).toHaveBeenCalledTimes(2)
    expect(session.compacting).toBe(false)
  })

  it('treats a duplicate compacting frame as a no-op and does not re-broadcast', async () => {
    const { session } = makePumpSession([
      sysFrame('status', { status: 'compacting' }),
      sysFrame('status', { status: 'compacting' }),
      { type: 'result', subtype: 'success', uuid: 'r1' } as unknown as SDKMessage,
    ])
    const broadcastInfo = vi.fn()
    await pump(session, makePumpDeps({ broadcastInfo }))

    // One transition from the set; the duplicate frame is a no-op; the
    // result clears it.
    expect(broadcastInfo).toHaveBeenCalledTimes(2)
    expect(session.compacting).toBeUndefined()
  })

  it('leaves compacting untouched when no status frame is seen', async () => {
    const { session } = makePumpSession([
      sysFrame('init'),
      { type: 'result', subtype: 'success', uuid: 'r1' } as unknown as SDKMessage,
    ])
    const broadcastInfo = vi.fn()
    await pump(session, makePumpDeps({ broadcastInfo }))

    expect(broadcastInfo).not.toHaveBeenCalled()
    expect(session.compacting).toBeUndefined()
  })
})

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
// pump: context-usage degraded-snapshot guard
//
// Guard 1 (assembleLiteUsage) DROPS a corrupt cache bucket that exceeds the
// context window and reports the surviving input-only total, flagging the
// snapshot `degraded`. applyContextUsage refuses to let a degraded snapshot
// overwrite a healthy last-good value — otherwise an intermittently corrupt
// proxy flip-flops the ContextBar between the true fill level and the near-0%
// fallback on every turn. The regression is the 8481f67b shape: 67% one turn
// (bogus 0.67M cache_read under the window), 0.04% the next (1.3M cache_read
// dropped → input-only 400).
// ---------------------------------------------------------------------------

function addContextSubscriber(
  session: Session,
  pushes: LiteContextUsage[],
): void {
  ;(session.contextUsageSubscribers as Set<{ push: (u: LiteContextUsage) => void }>).add({
    push: (u: LiteContextUsage) => pushes.push(u),
  })
}

describe('pump: context-usage degraded-snapshot guard', () => {
  it('keeps the last healthy snapshot when a corrupt result arrives (flip-flop guard)', async () => {
    const { session } = makePumpSession([
      // Healthy turn: cache_read 0.67M is under the 1M window → 804k/1M ≈ 80%.
      makeResult({
        usage: { input_tokens: 134000, cache_read_input_tokens: 670000 },
        modelUsage: { 'deepseek/deepseek-v4-flash': { contextWindow: 1000000 } },
      }),
      // Corrupt turn: cache_read 1.33M exceeds the window → dropped, leaving
      // the degraded input-only fallback of 400. Must NOT clobber the 80%.
      makeResult({
        usage: { input_tokens: 400, cache_read_input_tokens: 1326080 },
        modelUsage: { 'deepseek/deepseek-v4-flash': { contextWindow: 1000000 } },
      }),
    ])
    const contextPushes: LiteContextUsage[] = []
    addContextSubscriber(session, contextPushes)
    await pump(session, makePumpDeps())

    expect(session.lastContextUsage).not.toBeUndefined()
    expect(session.lastContextUsage!.totalTokens).toBe(804000)
    expect(session.lastContextUsage!.degraded).toBeUndefined()
    // Subscribers saw only the healthy snapshot — the degraded 0.04% blip
    // never reached the ContextBar.
    expect(contextPushes).toHaveLength(1)
    expect(contextPushes[0].totalTokens).toBe(804000)
    expect(contextPushes[0].degraded).toBeUndefined()
  })

  it('applies a degraded snapshot when no healthy last-good exists (always-corrupt proxy)', async () => {
    const { session } = makePumpSession([
      makeResult({
        usage: { input_tokens: 400, cache_read_input_tokens: 1326080 },
        modelUsage: { 'deepseek/deepseek-v4-flash': { contextWindow: 1000000 } },
      }),
    ])
    const contextPushes: LiteContextUsage[] = []
    addContextSubscriber(session, contextPushes)
    await pump(session, makePumpDeps())

    // No prior healthy value to protect → the input-only estimate lands so
    // the bar shows *something* instead of freezing empty (the 1dd57aa fix).
    expect(session.lastContextUsage!.totalTokens).toBe(400)
    expect(session.lastContextUsage!.degraded).toBe(true)
    expect(contextPushes).toHaveLength(1)
    expect(contextPushes[0].degraded).toBe(true)
  })

  it('lets a healthy snapshot replace a prior degraded one (recovery)', async () => {
    const { session } = makePumpSession([
      // Corrupt first turn → degraded lands (no last-good to protect).
      makeResult({
        usage: { input_tokens: 400, cache_read_input_tokens: 1326080 },
        modelUsage: { 'deepseek/deepseek-v4-flash': { contextWindow: 1000000 } },
      }),
      // Healthy next turn → replaces the degraded fallback with the real fill.
      makeResult({
        usage: { input_tokens: 134000, cache_read_input_tokens: 670000 },
        modelUsage: { 'deepseek/deepseek-v4-flash': { contextWindow: 1000000 } },
      }),
    ])
    const contextPushes: LiteContextUsage[] = []
    addContextSubscriber(session, contextPushes)
    await pump(session, makePumpDeps())

    expect(contextPushes).toHaveLength(2)
    expect(contextPushes[0].degraded).toBe(true)
    expect(contextPushes[1].degraded).toBeUndefined()
    expect(session.lastContextUsage!.totalTokens).toBe(804000)
    expect(session.lastContextUsage!.degraded).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// reapplyAutoCompactWindow — immediate threshold refresh after a pin/clear.
//
// The auto-compact threshold only ever derives from a turn's `result` payload,
// so a successful setAutoCompactWindow used to leave every live ContextBar on
// the STALE threshold (the auto position, e.g. 83.5% on a 200k model) until
// the next completed turn — which reads as "the drag did nothing / it snapped
// back to 84%" (and the pinned "Compact at X%" label stuck with the wrong
// number). The helper re-derives the threshold from the cached snapshot under
// the new windowOverride and re-broadcasts without waiting for a turn.
// ---------------------------------------------------------------------------

describe('reapplyAutoCompactWindow', () => {
  /** Snapshot shape mirrored from a real deepseek turn on a 200k window:
   *  auto threshold = 200000 − min(32000, 20000) − 13000 = 167000. */
  const baseSnapshot = (): LiteContextUsage => ({
    totalTokens: 38626,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: 19.3,
    model: 'deepseek/deepseek-v4-flash',
    cacheReadTokens: 17152,
    outputTokens: 42,
    autoCompactThreshold: 167000,
    maxOutputTokens: 32000,
  })

  it('recomputes and broadcasts the threshold immediately on pin', () => {
    const { session } = makePumpSession([])
    session.lastContextUsage = baseSnapshot()
    const pushes: LiteContextUsage[] = []
    addContextSubscriber(session, pushes)

    reapplyAutoCompactWindow(session, 113000)

    // 113000 − 20000 − 13000 = 80000 → marker lands at the dragged 40%.
    expect(session.lastContextUsage!.autoCompactThreshold).toBe(80000)
    expect(pushes).toHaveLength(1)
    expect(pushes[0].autoCompactThreshold).toBe(80000)
    // Everything else in the snapshot is carried through untouched.
    expect(pushes[0].totalTokens).toBe(38626)
    expect(pushes[0].maxTokens).toBe(200000)
  })

  it('clearing the pin restores the auto threshold from the model window', () => {
    const { session } = makePumpSession([])
    session.lastContextUsage = { ...baseSnapshot(), autoCompactThreshold: 80000 }
    const pushes: LiteContextUsage[] = []
    addContextSubscriber(session, pushes)

    reapplyAutoCompactWindow(session, undefined)

    expect(session.lastContextUsage!.autoCompactThreshold).toBe(167000)
    expect(pushes).toHaveLength(1)
  })

  it('is a no-op (no broadcast) when the recomputed threshold is unchanged', () => {
    const { session } = makePumpSession([])
    session.lastContextUsage = baseSnapshot()
    const pushes: LiteContextUsage[] = []
    addContextSubscriber(session, pushes)

    reapplyAutoCompactWindow(session, 200000) // threshold stays 167000

    expect(session.lastContextUsage!.autoCompactThreshold).toBe(167000)
    expect(pushes).toHaveLength(0)
  })

  it('is a no-op when no snapshot is cached yet (fresh session)', () => {
    const { session } = makePumpSession([])
    const pushes: LiteContextUsage[] = []
    addContextSubscriber(session, pushes)

    expect(() => reapplyAutoCompactWindow(session, 113000)).not.toThrow()
    expect(session.lastContextUsage).toBeUndefined()
    expect(pushes).toHaveLength(0)
  })

  it('adds a threshold to a snapshot that lacked one, and drops it when undefined', () => {
    const { session } = makePumpSession([])
    const withoutThreshold = baseSnapshot()
    delete withoutThreshold.autoCompactThreshold
    session.lastContextUsage = withoutThreshold

    reapplyAutoCompactWindow(session, 113000)
    expect(session.lastContextUsage!.autoCompactThreshold).toBe(80000)

    // A zero window can't yield a threshold (computeAutoCompactThreshold →
    // undefined) — the key must be REMOVED, not set to undefined, mirroring
    // assembleLiteUsage's "absent stays distinguishable" convention.
    session.lastContextUsage = { ...baseSnapshot(), maxTokens: 0, rawMaxTokens: 0 }
    reapplyAutoCompactWindow(session, undefined)
    expect(session.lastContextUsage!.autoCompactThreshold).toBeUndefined()
    expect('autoCompactThreshold' in session.lastContextUsage!).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// pump: thinking_tokens / tool_progress / refusal-fallback system frames
//
// thinking_tokens is a transient live-only progress signal (thinking-block
// token estimate): forwarded to live subscribers, never stored in the ring
// (a long thinking phase emits one frame per delta — ring slots are for
// durable content) and never replayed. tool_progress is a per-tool liveness
// ping nothing renders — dropped entirely. permission_denied /
// informational / model_refusal_fallback are DURABLE: ring + broadcast, so
// they render and (for the fallback) drive client-side eviction of the
// refused leg's retracted uuids.
// ---------------------------------------------------------------------------

describe('pump: thinking_tokens + tool_progress + refusal frames', () => {
  it('forwards thinking_tokens live-only: broadcast but never ring', async () => {
    const { session, broadcasts } = makePumpSession([
      sysFrame('thinking_tokens', { estimated_tokens: 4200, estimated_tokens_delta: 120 }),
      { type: 'result', subtype: 'success', uuid: 'r1' } as unknown as SDKMessage,
    ])
    await pump(session, makePumpDeps())
    expect(broadcasts.map((m) => (m as { subtype?: string }).subtype)).toEqual([
      'thinking_tokens',
      'success',
    ])
    // Live-only: the ring holds just the result.
    expect(session.history.map((m) => (m as { subtype?: string }).subtype)).toEqual(['success'])
  })

  it('drops tool_progress entirely: no broadcast, no ring slot', async () => {
    const { session, broadcasts } = makePumpSession([
      { type: 'tool_progress', tool_use_id: 'tu1', tool_name: 'Bash', elapsed_time_seconds: 3 } as unknown as SDKMessage,
      { type: 'result', subtype: 'success', uuid: 'r1' } as unknown as SDKMessage,
    ])
    await pump(session, makePumpDeps())
    expect(broadcasts.map((m) => (m as { subtype?: string }).subtype)).toEqual(['success'])
    expect(session.history).toHaveLength(1)
  })

  it('rings + broadcasts tool_use_summary (compact recap line)', async () => {
    const { session, broadcasts } = makePumpSession([
      { type: 'tool_use_summary', summary: 'ran 3 searches', preceding_tool_use_ids: ['a', 'b'] } as unknown as SDKMessage,
    ])
    await pump(session, makePumpDeps())
    expect(broadcasts.map((m) => (m as { type?: string }).type)).toEqual(['tool_use_summary'])
    expect(session.history).toHaveLength(1)
  })

  it('rings + broadcasts permission_denied / informational / model_refusal_fallback with top-level payloads intact', async () => {
    const frames: SDKMessage[] = [
      sysFrame('permission_denied', {
        tool_name: 'Bash', tool_use_id: 'tu1', decision_reason_type: 'rule',
        decision_reason: 'denied by settings', message: 'Bash is not allowed',
      }),
      sysFrame('informational', { content: 'hook blocked the prompt', level: 'warning' }),
      sysFrame('model_refusal_fallback', {
        trigger: 'refusal', direction: 'retry',
        original_model: 'claude-opus-5', fallback_model: 'claude-sonnet-5',
        retracted_message_uuids: ['u1', 'u2'], content: 'refused; retrying',
      }),
    ]
    const { session, broadcasts } = makePumpSession(frames)
    await pump(session, makePumpDeps())
    // All three broadcast in order...
    expect(broadcasts.map((m) => (m as { subtype?: string }).subtype)).toEqual([
      'permission_denied',
      'informational',
      'model_refusal_fallback',
    ])
    // ...and all three are durable ring content (replay + disk parity).
    expect(session.history.map((m) => (m as { subtype?: string }).subtype)).toEqual([
      'permission_denied',
      'informational',
      'model_refusal_fallback',
    ])
    // The frames pass through UNMUTATED — the top-level payloads the client
    // renders/evicts on ride along verbatim.
    expect(session.history[2]).toMatchObject({
      retracted_message_uuids: ['u1', 'u2'],
      original_model: 'claude-opus-5',
      fallback_model: 'claude-sonnet-5',
    })
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
