// server/providers/native/frames.test.ts
import { describe, expect, it } from 'vitest'
import {
  apiRetryFrame, assistantFrame, defaultFrameContext, resultFrame,
  streamEventFrame, toolResultFrame, type FrameContext,
} from './frames.js'

const ctx: FrameContext = defaultFrameContext('sess-1')
const usage = { input_tokens: 10, output_tokens: 5 }

describe('frames', () => {
  it('assistant frame carries session_id, uuid and SDK block shape', () => {
    const f = assistantFrame(ctx, {
      model: 'm', stopReason: 'tool_use', usage,
      content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
    })
    expect(f.type).toBe('assistant')
    expect(f.session_id).toBe('sess-1')
    expect(typeof f.uuid).toBe('string')
    expect(f.parent_tool_use_id).toBeNull()
    expect(f.message.role).toBe('assistant')
    expect(f.message.content).toHaveLength(2)
    expect(f.message.usage).toEqual(usage)
  })

  it('tool_result frame wraps content and never echoes prompts', () => {
    const f = toolResultFrame(ctx, 't1', 'out', false)
    expect(f.type).toBe('user')
    expect(f.parent_tool_use_id).toBeNull()
    const block = f.message.content[0]
    expect(block.type).toBe('tool_result')
    expect(block.tool_use_id).toBe('t1')
    expect(block.is_error).toBe(false)
  })

  it('api_retry frame uses the client contract field names', () => {
    const f = apiRetryFrame(ctx, { attempt: 3, maxRetries: 10, delayMs: 26_000 })
    expect(f.subtype).toBe('api_retry')
    expect(f.attempt).toBe(3)
    expect(f.max_retries).toBe(10)
    expect(f.retry_delay_ms).toBe(26_000)
  })

  it('result frame maps isError to subtype', () => {
    expect(resultFrame(ctx, { result: 'done', usage, numTurns: 1, durationMs: 100, isError: false }).subtype).toBe('success')
    expect(resultFrame(ctx, { result: 'bad', usage, numTurns: 1, durationMs: 100, isError: true }).subtype).toBe('error_during_execution')
  })

  it('stream_event frame wraps the raw event', () => {
    const f = streamEventFrame(ctx, { type: 'message_start' })
    expect(f.type).toBe('stream_event')
    expect(f.event.type).toBe('message_start')
  })

  it('every factory carries the frame context parent (sidechain runner)', () => {
    const side = defaultFrameContext('sess-1', 'tu1')
    const frames = [
      assistantFrame(side, { model: 'm', content: [], stopReason: null, usage }),
      toolResultFrame(side, 't1', 'out', false),
      apiRetryFrame(side, { attempt: 1, maxRetries: 2, delayMs: 1 }),
      resultFrame(side, { result: '', usage, numTurns: 1, durationMs: 0, isError: false }),
      streamEventFrame(side, { type: 'message_start' }),
    ]
    for (const f of frames) expect(f.parent_tool_use_id).toBe('tu1')
  })

  it('defaults the parent to null for a main-thread context', () => {
    const f = assistantFrame(defaultFrameContext('sess-1'), {
      model: 'm', content: [], stopReason: null, usage,
    })
    expect(f.parent_tool_use_id).toBeNull()
    expect(defaultFrameContext('sess-1').parentToolUseId).toBeNull()
  })
})
