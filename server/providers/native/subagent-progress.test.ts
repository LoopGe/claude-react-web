// server/providers/native/subagent-progress.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SubagentProgress,
  normalizeProgressSummary,
  PROGRESS_INTERVAL_MS,
  PROGRESS_MAX_TOKENS,
  PROGRESS_SUMMARY_PROMPT,
  type SubagentProgressDeps,
} from './subagent-progress.js'
import { createAssistantMessage, createToolResultMessage, type RequestMessage } from './vocabulary/message.js'
import { brandString } from './vocabulary/brand.js'
import type { ContentBlock, TokenUsage, ToolCallBlock } from './vocabulary/types.js'
import type { CanonicalEvent } from './canonical.js'
import type { OperationalFrame } from './vocabulary/live-frame.js'
import type { ToolDef } from './tools/types.js'
import type { AgentToolDeps } from './subagent.js'
import { metrics } from '../../metrics.js'

// ── helpers ─────────────────────────────────────────────────────────────

type ProgressFrame = Extract<OperationalFrame, { type: 'task/progress' }>

/** The fork request the seam receives — the AgentToolDeps streamFor request
 *  contract, fork overrides included. */
type ForkReq = Parameters<AgentToolDeps['streamFor']>[0]

const toolCall = (id: string, name: string): ToolCallBlock => ({
  type: 'tool-call',
  id: brandString<'ToolCallId'>(id),
  name,
  arguments: '{}',
})

const assistantFrame = (content: ContentBlock[], usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }) => ({
  type: 'assistant-frame' as const,
  message: createAssistantMessage({ content, source: { provider: 'anthropic', model: 'claude-sonnet-4-5' } }),
  usage,
  stopReason: 'tool_use',
  model: 'claude-sonnet-4-5',
})

const toolDef = (name: string): ToolDef => ({
  name,
  description: `${name} tool`,
  guidance: '',
  promptOrder: 0,
  schema: { type: 'object', properties: {} },
  run: async () => ({ text: 'ok' }),
})

const textEvents = (text: string): CanonicalEvent[] => [
  { kind: 'message_start' },
  { kind: 'block_start', index: 0, block: { type: 'text' } },
  { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
  { kind: 'block_end', index: 0 },
  { kind: 'message_end', stopReason: 'end_turn' },
]

const streamOf = (events: CanonicalEvent[]): AsyncIterable<CanonicalEvent> => ({
  async *[Symbol.asyncIterator]() {
    for (const ev of events) yield ev
  },
})

/** A stream that stays in flight until released; rejects with the abort reason
 *  when its signal aborts (the real streamer's abort behavior). */
const blockedStream = (): { stream: (req: ForkReq) => AsyncIterable<CanonicalEvent>; release: () => void } => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return {
    release,
    stream: (req) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(req.signal.reason ?? new Error('aborted'))
          if (req.signal.aborted) {
            onAbort()
            return
          }
          req.signal.addEventListener('abort', onAbort, { once: true })
          void gate.then(() => {
            req.signal.removeEventListener('abort', onAbort)
            resolve()
          })
        })
        yield* textEvents('late summary')
      },
    }),
  }
}

interface Harness {
  tracker: SubagentProgress
  history: RequestMessage[]
  frames: ProgressFrame[]
  requests: ForkReq[]
  parent: AbortController
}

const makeHarness = (opts: {
  enabled?: boolean
  model?: string
  history?: RequestMessage[]
  stream?: (req: ForkReq) => AsyncIterable<CanonicalEvent>
} = {}): Harness => {
  const history = opts.history ?? []
  const frames: ProgressFrame[] = []
  const requests: ForkReq[] = []
  const parent = new AbortController()
  const defaultStream = () => streamOf(textEvents('  Reading the diff  \nsecond line'))
  const deps: SubagentProgressDeps = {
    taskId: 'task-1',
    toolUseId: 'tu-agent',
    description: 'review the diff',
    subagentType: 'reviewer',
    enabled: opts.enabled ?? true,
    history: () => history,
    model: opts.model ?? 'claude-sonnet-4-5',
    system: 'nested system',
    tools: [toolDef('Read'), toolDef('Bash')],
    streamFor: (req) => {
      requests.push(req)
      return (opts.stream ?? defaultStream)(req)
    },
    attachmentProjection: {},
    emit: (frame) => {
      expect(frame.type).toBe('task/progress')
      frames.push(frame as ProgressFrame)
    },
    parentToolUseId: 'tu-agent',
    signal: parent.signal,
  }
  return { tracker: new SubagentProgress(deps), history, frames, requests, parent }
}

const userMessage = (text: string): RequestMessage => ({ role: 'user', content: [{ type: 'text', text }] })

const counter = (outcome: string, reason?: string): number => {
  const key = reason === undefined
    ? `native_task_progress_total:outcome=${outcome}`
    : `native_task_progress_total:outcome=${outcome},reason=${reason}`
  return metrics.snapshot().counters[key] ?? 0
}

beforeEach(() => {
  vi.useFakeTimers()
  metrics.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── normalize ───────────────────────────────────────────────────────────

describe('normalizeProgressSummary', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeProgressSummary('  Analyzing authentication module  ')).toBe('Analyzing authentication module')
  })

  it('keeps only the first line', () => {
    expect(normalizeProgressSummary('first line\nsecond line')).toBe('first line')
  })

  it('rejects empty and whitespace-only input', () => {
    expect(normalizeProgressSummary('   ')).toBeNull()
    expect(normalizeProgressSummary('')).toBeNull()
    expect(normalizeProgressSummary('\n\n')).toBeNull()
  })

  it('caps a >100-char single line to <=100 chars', () => {
    const long = 'x'.repeat(150)
    const capped = normalizeProgressSummary(long)
    expect(capped).toBe('x'.repeat(100))
  })

  it('caps on a code-point boundary (no trailing partial surrogate)', () => {
    const long = '\u{1F600}'.repeat(120) // 120 astral code points, 240 UTF-16 units
    const capped = normalizeProgressSummary(long)
    expect(capped).toBe('\u{1F600}'.repeat(100))
    expect([...capped!].length).toBe(100)
  })

  it('trims the first line again after the split (CRLF included)', () => {
    expect(normalizeProgressSummary('  first line  \r\nsecond line')).toBe('first line')
  })
})

// ── fork-tail validity ──────────────────────────────────────────────────

describe('fork tail', () => {
  it('synthesizes tool_result blocks for trailing unmatched tool_use, then the prompt, in ONE user message', async () => {
    const h = makeHarness({
      history: [userMessage('do the task'), assistantFrame([toolCall('tuX', 'Read')]).message],
    })
    h.tracker.observe(assistantFrame([toolCall('tuX', 'Read')]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(1)
    const req = h.requests[0]
    // The fork reuses the subagent's own model/system and the IDENTICAL wire
    // tool projection (loop.ts:208) so the cache prefix matches.
    expect(req.model).toBe('claude-sonnet-4-5')
    expect(req.system).toBe('nested system')
    expect(req.tools).toEqual([
      { name: 'Read', description: 'Read tool', input_schema: { type: 'object', properties: {} } },
      { name: 'Bash', description: 'Bash tool', input_schema: { type: 'object', properties: {} } },
    ])
    expect(req.maxTokens).toBe(PROGRESS_MAX_TOKENS)
    expect(req.forkProfile).toBe(true)
    expect(req.thinking).toEqual({ type: 'disabled' })
    // The projected prefix is the snapshot's wire shape (tool-call → tool_use).
    expect(req.messages).toHaveLength(2)
    expect(req.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tuX', name: 'Read', input: {} }],
    })
    // ONE user tail message: synthetic results FIRST, then the summary prompt.
    expect(req.appendMessages).toEqual([{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tuX', content: '(tool still running)' },
        { type: 'text', text: PROGRESS_SUMMARY_PROMPT },
      ],
    }])
    h.tracker.stop()
  })

  it('a snapshot ending in a complete tool_result gets a plain prompt-only tail', async () => {
    const h = makeHarness({
      history: [
        userMessage('do the task'),
        assistantFrame([toolCall('tuX', 'Read')]).message,
        createToolResultMessage({
          callId: brandString<'ToolCallId'>('tuX'),
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
        }),
      ],
    })
    h.tracker.observe(assistantFrame([toolCall('tuX', 'Read')]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].appendMessages).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: PROGRESS_SUMMARY_PROMPT }],
    }])
    h.tracker.stop()
  })

  it('covers every trailing unmatched call (multiple calls, partial results)', async () => {
    const h = makeHarness({
      history: [
        userMessage('do the task'),
        assistantFrame([toolCall('tuA', 'Read'), toolCall('tuB', 'Bash')]).message,
        createToolResultMessage({
          callId: brandString<'ToolCallId'>('tuA'),
          content: [{ type: 'text', text: 'done' }],
          isError: false,
        }),
      ],
    })
    h.tracker.observe(assistantFrame([toolCall('tuA', 'Read'), toolCall('tuB', 'Bash')]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests[0].appendMessages).toEqual([{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tuB', content: '(tool still running)' },
        { type: 'text', text: PROGRESS_SUMMARY_PROMPT },
      ],
    }])
    h.tracker.stop()
  })

  it('omits thinking on a non-thinking model', async () => {
    const h = makeHarness({ model: 'claude-haiku-4-5', history: [userMessage('task')] })
    h.tracker.observe(assistantFrame([{ type: 'text', text: 'working' }]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].thinking).toBeUndefined()
    h.tracker.stop()
  })

  it('snapshots the history: concurrent appends never change the sent prefix, and the source is never mutated', async () => {
    const blocked = blockedStream()
    const original = [userMessage('task'), assistantFrame([toolCall('tuX', 'Read')]).message]
    const h = makeHarness({ history: original, stream: blocked.stream })
    const before = structuredClone(h.history)
    h.tracker.observe(assistantFrame([toolCall('tuX', 'Read')]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(1)
    const sentPrefix = structuredClone(h.requests[0].messages)
    // runTurn keeps appending while the fork is in flight.
    h.history.push(assistantFrame([{ type: 'text', text: 'new material' }]).message)
    blocked.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.requests[0].messages).toEqual(sentPrefix)
    expect(h.requests[0].messages).toHaveLength(2)
    // The fork completed against the stable prefix…
    expect(h.frames.some((f) => f.summary === 'late summary')).toBe(true)
    // …and the tracker itself never wrote into the nested history.
    expect(h.history.slice(0, 2)).toEqual(before)
    h.tracker.stop()
  })
})

// ── lifecycle + failure contract ────────────────────────────────────────

describe('lifecycle', () => {
  it('stop() aborts an in-flight fork and silences the cadence (no frames after, no failure metric)', async () => {
    const blocked = blockedStream()
    const h = makeHarness({ stream: blocked.stream, history: [userMessage('task')] })
    h.tracker.observe(assistantFrame([{ type: 'text', text: 'working' }]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(1)
    const forkSignal = h.requests[0].signal
    expect(forkSignal.aborted).toBe(false)
    h.tracker.stop()
    expect(forkSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 3)
    // Only the first tick's mechanical frame ever emitted; the aborted fork
    // stays silent (abort → silent, never the failed outcome).
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0].summary).toBeUndefined()
    expect(h.requests).toHaveLength(1)
    expect(counter('failed')).toBe(0)
  })

  it('the subagent signal abort cancels the fork and stops emission', async () => {
    const blocked = blockedStream()
    const h = makeHarness({ stream: blocked.stream, history: [userMessage('task')] })
    h.tracker.observe(assistantFrame([{ type: 'text', text: 'working' }]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    const forkSignal = h.requests[0].signal
    expect(forkSignal.aborted).toBe(false)
    h.parent.abort()
    expect(forkSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 3)
    expect(h.frames).toHaveLength(1)
    expect(h.requests).toHaveLength(1)
    expect(counter('failed')).toBe(0)
  })

  it('a throwing fork is silent: the mechanical frame stands, no summary, no throw, cadence survives', async () => {
    const h = makeHarness({
      history: [userMessage('task')],
      stream: () => ({
        // eslint-disable-next-line require-yield -- throwing streamer: simulates an API failure before any yield
        async *[Symbol.asyncIterator]() {
          throw new Error('boom')
        },
      }),
    })
    h.tracker.observe(assistantFrame([{ type: 'text', text: 'working' }]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0].summary).toBeUndefined()
    expect(counter('mechanical')).toBe(1)
    expect(counter('failed', 'error')).toBe(1)
    // The next tick still emits its mechanical frame (the failure did not
    // break the timer or throw into the caller).
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.frames).toHaveLength(2)
    h.tracker.stop()
  })

  it('always-on-thinking classifier model: a 400 fork rejection stays silent, mechanical stands', async () => {
    const h = makeHarness({
      model: 'claude-opus-5-5', // matches the opus/sonnet classifier…
      history: [userMessage('task')],
      stream: () => ({
        // eslint-disable-next-line require-yield -- throwing streamer: simulates the always-on-thinking 400 before any yield
        async *[Symbol.asyncIterator]() {
          // …yet rejects thinking:disabled (the inherited runSuggestion 400).
          throw Object.assign(new Error('thinking disabled is not supported'), { status: 400 })
        },
      }),
    })
    h.tracker.observe(assistantFrame([{ type: 'text', text: 'working' }]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests[0].thinking).toEqual({ type: 'disabled' })
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0].lastToolName).toBeUndefined()
    expect(h.frames[0].summary).toBeUndefined()
    expect(counter('mechanical')).toBe(1)
    expect(counter('failed', 'error')).toBe(1)
    h.tracker.stop()
  })

  it('a tick with no new material does not fork again; new material re-arms', async () => {
    const h = makeHarness({ history: [userMessage('task')] })
    h.tracker.observe(assistantFrame([{ type: 'text', text: 'working' }]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(1)
    expect(h.frames).toHaveLength(3) // mech + summary, then mech only
    expect(counter('suppressed', 'no_material')).toBe(1)
    h.tracker.observe(assistantFrame([toolCall('tu2', 'Bash')]))
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(2)
    h.tracker.stop()
  })

  it('at most one fork in flight: a busy tick suppresses, completion re-arms', async () => {
    const blocked = blockedStream()
    const h = makeHarness({ stream: blocked.stream, history: [userMessage('task')] })
    h.tracker.observe(assistantFrame([{ type: 'text', text: 'working' }]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(1)
    h.tracker.observe(assistantFrame([toolCall('tu2', 'Bash')]))
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(1)
    expect(counter('suppressed', 'in_flight')).toBe(1)
    blocked.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.frames.some((f) => f.summary === 'late summary')).toBe(true)
    h.tracker.observe(assistantFrame([toolCall('tu3', 'Edit')]))
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.requests).toHaveLength(2)
    h.tracker.stop()
  })

  it('an empty fork output suppresses the summary (mechanical frame only)', async () => {
    const h = makeHarness({ history: [userMessage('task')], stream: () => streamOf(textEvents('   ')) })
    h.tracker.observe(assistantFrame([{ type: 'text', text: 'working' }]))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0].summary).toBeUndefined()
    expect(counter('suppressed', 'empty')).toBe(1)
    expect(counter('generated')).toBe(0)
    h.tracker.stop()
  })
})

// ── observe + mechanical emission ───────────────────────────────────────

describe('mechanical emission', () => {
  it('emits usage + lastToolName each tick and a normalized summary when enabled', async () => {
    const h = makeHarness({ enabled: true })
    h.tracker.observe(assistantFrame([toolCall('tu1', 'Read')], { inputTokens: 100, outputTokens: 50 }))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    // Two frames per tick: the mechanical one, then the summary-bearing fork
    // result (the client folds latest-wins).
    expect(h.frames).toHaveLength(2)
    const mechanical = h.frames[0]
    expect(mechanical).toMatchObject({
      type: 'task/progress',
      taskId: 'task-1',
      toolUseId: 'tu-agent',
      description: 'review the diff',
      subagentType: 'reviewer',
      lastToolName: 'Read',
      usage: { toolUses: 1, totalTokens: 150 },
    })
    expect(mechanical.usage.durationMs).toBeGreaterThanOrEqual(30_000)
    expect(mechanical.summary).toBeUndefined()
    expect(typeof mechanical.time).toBe('number')
    const summaryFrame = h.frames[1]
    expect(summaryFrame.summary).toBe('Reading the diff')
    expect(summaryFrame.lastToolName).toBe('Read')
    expect(summaryFrame.usage).toEqual(mechanical.usage)
    expect(counter('mechanical')).toBe(1)
    expect(counter('generated')).toBe(1)
    h.tracker.stop()
  })

  it('enabled false: mechanical frame carries lastToolName, no summary, seam never called', async () => {
    const h = makeHarness({ enabled: false })
    h.tracker.observe(assistantFrame([toolCall('tu1', 'Read')], { inputTokens: 100, outputTokens: 50 }))
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0].lastToolName).toBe('Read')
    expect(h.frames[0].summary).toBeUndefined()
    expect(h.requests).toHaveLength(0)
    expect(counter('mechanical')).toBe(1)
    expect(counter('suppressed', 'disabled')).toBe(1)
    h.tracker.stop()
  })

  it('accumulates tool uses, tokens (cache buckets included) and the latest tool name', async () => {
    const h = makeHarness({ enabled: false })
    h.tracker.observe(assistantFrame(
      [toolCall('tu1', 'Read'), toolCall('tu2', 'Bash')],
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 200 },
    ))
    h.tracker.observe(assistantFrame([toolCall('tu3', 'Edit')], { inputTokens: 10, outputTokens: 5 }))
    // Non-assistant frames carry no material.
    h.tracker.observe({ type: 'raw-stream-event', event: { kind: 'message_start' } })
    h.tracker.start()
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0].usage).toMatchObject({ toolUses: 3, totalTokens: 1365 })
    expect(h.frames[0].lastToolName).toBe('Edit')
    h.tracker.stop()
  })
})