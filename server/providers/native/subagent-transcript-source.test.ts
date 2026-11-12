import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '../../agent-message.js'
import type { SubagentTranscriptFrame, SubagentTranscriptSub } from '../../subagent-transcript-hub.js'
import { nativeHistoryCache } from './session-log/cache.js'
import type { NativeEventInput } from './session-log/format.js'
import { NativeSessionLog } from './session-log/log.js'
import { NativeSubagentTranscriptSource } from './subagent-transcript-source.js'

const SESSION = 'native-live-session'
const AGENT = 'agent-live'
const PROMPT_UUID = `native-subagent-prompt:${AGENT}`

type LiveEmit = (frame: AgentMessage) => void
type LiveTerminate = (error: Error) => void

interface LiveListener {
  emit: LiveEmit
  terminate?: LiveTerminate
}

interface Collector {
  frames: SubagentTranscriptFrame[]
  errors: Error[]
  done: Promise<void>
}

const sources = new Set<NativeSubagentTranscriptSource>()
const collectors: Collector[] = []
let stateDir: string
let log: NativeSessionLog
let listeners: Set<LiveListener>
let subscribeLive: ReturnType<typeof vi.fn<(
  sessionId: string,
  emit: LiveEmit,
  terminate?: LiveTerminate,
) => (() => void) | null>>

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'native-subagent-live-'))
  log = NativeSessionLog.open({ stateDir, id: SESSION, cwd: '/repo', resume: false })
  listeners = new Set()
  subscribeLive = vi.fn((_sessionId: string, emit: LiveEmit, terminate?: LiveTerminate) => {
    const listener = { emit, terminate }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const source of sources) source.close()
  sources.clear()
  await Promise.all(collectors.splice(0).map((collector) => collector.done))
  await log.close()
  nativeHistoryCache.invalidate(SESSION)
  await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function makeSource(
  subscribe: (
    sessionId: string,
    emit: LiveEmit,
    terminate?: LiveTerminate,
  ) => (() => void) | null = subscribeLive,
): NativeSubagentTranscriptSource {
  const source = new NativeSubagentTranscriptSource({ stateDir, subscribeLive: subscribe })
  sources.add(source)
  return source
}

function collect(sub: SubagentTranscriptSub): Collector {
  const frames: SubagentTranscriptFrame[] = []
  const errors: Error[] = []
  const done = (async () => {
    try {
      for await (const frame of sub.iterable) frames.push(frame)
    } catch (err) {
      errors.push(err as Error)
    }
  })()
  const collector = { frames, errors, done }
  collectors.push(collector)
  return collector
}

function publish(frame: unknown): void {
  for (const listener of [...listeners]) listener.emit(frame as AgentMessage)
}

function terminateLive(error: Error): void {
  for (const listener of [...listeners]) {
    if (!listener.terminate) throw new Error('live termination callback was not registered')
    listener.terminate(error)
  }
}

async function append(events: NativeEventInput[]): Promise<void> {
  for (const event of events) log.append(event)
  await log.flush()
}

function origin(prompt: unknown = 'inspect the live transcript'): NativeEventInput {
  return {
    type: 'assistant',
    uuid: 'origin-live',
    session_id: SESSION,
    parent_tool_use_id: null,
    timestamp: '2026-11-12T01:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: AGENT,
        name: 'Agent',
        input: { description: 'live agent', ...(typeof prompt === 'string' ? { prompt } : {}) },
      }],
    },
  }
}

function descriptor(): NativeEventInput {
  return {
    type: 'subagent/descriptor',
    toolUseId: AGENT,
    parentToolUseId: null,
    kind: 'agent',
    toolName: 'Agent',
    label: 'live agent',
    depth: 1,
    profile: null,
    timestamp: '2026-11-12T01:00:01.000Z',
  }
}

function assistant(uuid: string): NativeEventInput {
  return {
    type: 'assistant',
    uuid,
    session_id: SESSION,
    parent_tool_use_id: AGENT,
    timestamp: '2026-11-12T01:01:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: uuid }] },
  }
}

function streamEvent(): Record<string, unknown> {
  return {
    type: 'stream_event',
    uuid: 'stream-only',
    session_id: SESSION,
    parent_tool_use_id: null,
    event: { type: 'message_start' },
  }
}

function outerErrorResult(): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'outer-error',
    session_id: SESSION,
    parent_tool_use_id: null,
    timestamp: '2026-11-12T01:02:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: AGENT, content: 'failed', is_error: true }],
    },
  }
}

function uuids(frames: SubagentTranscriptFrame[]): unknown[] {
  return frames.flatMap((frame) => frame.frames).map((frame) => (frame as { uuid?: unknown }).uuid)
}

describe('NativeSubagentTranscriptSource', () => {
  it('subscribes before reading the snapshot and deduplicates snapshot/live uuids', async () => {
    await append([origin(), descriptor(), assistant('disk-1')])
    const events: string[] = []
    const realLoad = nativeHistoryCache.load
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    const loadSpy = vi.spyOn(nativeHistoryCache, 'load').mockImplementation(async (...args) => {
      events.push('snapshot')
      if (first) {
        first = false
        await gate
      }
      return realLoad(...args)
    })
    subscribeLive.mockImplementation(((_sessionId: string, emit: LiveEmit, terminate?: LiveTerminate) => {
      events.push('subscribe')
      const listener = { emit, terminate }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }) as typeof subscribeLive)

    const sub = makeSource().subscribeSubagentTranscript(SESSION, AGENT)
    const received = collect(sub)
    expect(events).toEqual(['subscribe', 'snapshot'])

    publish(assistant('disk-1'))
    release()
    await vi.waitFor(() => expect(received.frames.some((frame) => frame.reset)).toBe(true))
    publish(assistant('live-1'))
    await vi.waitFor(() => expect(uuids(received.frames)).toContain('live-1'))

    expect(uuids(received.frames)).toEqual([PROMPT_UUID, 'disk-1', 'live-1'])
    loadSpy.mockRestore()
  })

  it('re-reads the catalog for a non-rendered stream event and emits prompt before live output', async () => {
    const sub = makeSource().subscribeSubagentTranscript(SESSION, AGENT)
    const received = collect(sub)
    await vi.waitFor(() => expect(received.frames).toHaveLength(1))
    expect(received.frames[0]).toMatchObject({ reset: true, frames: [] })

    await append([origin(), descriptor(), assistant('nested-1')])
    publish(streamEvent())
    publish(assistant('nested-1'))

    await vi.waitFor(() => expect(uuids(received.frames)).toContain('nested-1'))
    expect(uuids(received.frames)).toEqual([PROMPT_UUID, 'nested-1'])
    expect(received.frames[1].reset).toBe(false)
  })

  it('emits a prompt-only increment when the only live evidence is an outer error result', async () => {
    const sub = makeSource().subscribeSubagentTranscript(SESSION, AGENT)
    const received = collect(sub)
    await vi.waitFor(() => expect(received.frames).toHaveLength(1))

    await append([origin(), descriptor()])
    publish(outerErrorResult())

    await vi.waitFor(() => expect(uuids(received.frames)).toContain(PROMPT_UUID))
    expect(uuids(received.frames)).toEqual([PROMPT_UUID])
    expect(received.frames[1]).toMatchObject({ reset: false })
  })

  it('stops catalog re-reads after confirming that no legal prompt exists', async () => {
    await append([origin('   '), descriptor(), assistant('disk-1')])
    const sub = makeSource().subscribeSubagentTranscript(SESSION, AGENT)
    const received = collect(sub)
    await vi.waitFor(() => expect(uuids(received.frames)).toEqual(['disk-1']))
    const loadSpy = vi.spyOn(nativeHistoryCache, 'load')

    publish(streamEvent())
    publish(assistant('live-1'))
    await vi.waitFor(() => expect(uuids(received.frames)).toContain('live-1'))
    publish(streamEvent())
    publish(assistant('live-2'))
    await vi.waitFor(() => expect(uuids(received.frames)).toContain('live-2'))

    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(uuids(received.frames)).toEqual(['disk-1', 'live-1', 'live-2'])
    loadSpy.mockRestore()
  })

  it('preserves a queued initial reset and drops later increments before a failure', async () => {
    await append([origin(), descriptor(), assistant('disk-reset')])
    const loadSpy = vi.spyOn(nativeHistoryCache, 'load')
    const sub = makeSource().subscribeSubagentTranscript(SESSION, AGENT)
    const iterator = sub.iterable[Symbol.asyncIterator]()
    await vi.waitFor(() => expect(loadSpy).toHaveBeenCalledTimes(1))
    await loadSpy.mock.results[0].value
    // Let the snapshot continuation push its reset before failure is injected.
    await new Promise<void>((resolve) => setImmediate(resolve))
    publish(assistant('stale-increment'))
    terminateLive(new Error('inner reset ordering'))

    const first = await iterator.next()
    expect(first.done).toBe(false)
    if (first.done) throw new Error('expected the queued reset')
    expect(first.value.reset).toBe(true)
    expect(first.value.frames.map((frame) => (frame as { uuid?: unknown }).uuid))
      .toEqual([PROMPT_UUID, 'disk-reset'])
    await expect(iterator.next()).rejects.toThrow('inner reset ordering')
  })

  it('fails the output and detaches live delivery when snapshot initialization rejects', async () => {
    vi.spyOn(nativeHistoryCache, 'load').mockRejectedValue(new Error('snapshot read exploded'))
    const sub = makeSource().subscribeSubagentTranscript(SESSION, AGENT)
    const received = collect(sub)

    await vi.waitFor(() => expect(received.errors.map((error) => error.message)).toEqual(['snapshot read exploded']))
    await received.done
    expect(listeners.size).toBe(0)
    publish(assistant('after-snapshot-failure'))
    expect(uuids(received.frames)).toEqual([])
  })

  it('fails the output instead of dropping a frame when a catalog re-read rejects', async () => {
    const sub = makeSource().subscribeSubagentTranscript(SESSION, AGENT)
    const received = collect(sub)
    await vi.waitFor(() => expect(received.frames).toHaveLength(1))
    vi.spyOn(nativeHistoryCache, 'load').mockRejectedValue(new Error('catalog read exploded'))

    publish(assistant('frame-a'))
    publish(assistant('frame-b'))

    await vi.waitFor(() => expect(received.errors.map((error) => error.message)).toEqual(['catalog read exploded']))
    await received.done
    expect(listeners.size).toBe(0)
    expect(uuids(received.frames)).toEqual([])
  })

  it('propagates unexpected inner termination as an output error and cleans up', async () => {
    const sub = makeSource().subscribeSubagentTranscript(SESSION, AGENT)
    const received = collect(sub)
    await vi.waitFor(() => expect(received.frames).toHaveLength(1))

    terminateLive(new Error('inner subscriber overflow'))

    await vi.waitFor(() => expect(received.errors.map((error) => error.message)).toEqual(['inner subscriber overflow']))
    await received.done
    expect(listeners.size).toBe(0)
    publish(assistant('after-inner-termination'))
    expect(uuids(received.frames)).toEqual([])
  })

  it('ignores a late inner termination after normal unsubscribe', async () => {
    const sub = makeSource().subscribeSubagentTranscript(SESSION, AGENT)
    const received = collect(sub)
    await vi.waitFor(() => expect(received.frames).toHaveLength(1))
    const terminate = [...listeners][0].terminate
    sub.unsubscribe()
    await received.done

    terminate?.(new Error('late termination'))
    expect(received.errors).toEqual([])
  })

  it('serves only a disk reset for a dormant session without resuming it', async () => {
    await append([origin(), descriptor(), assistant('disk-1')])
    const dormantSubscribe = vi.fn((_sessionId: string, _emit: LiveEmit, _terminate?: LiveTerminate) => null)
    const sub = makeSource(dormantSubscribe).subscribeSubagentTranscript(SESSION, AGENT)
    const received = collect(sub)

    await vi.waitFor(() => expect(received.frames).toHaveLength(1))
    expect(received.frames[0]).toMatchObject({ reset: true })
    expect(uuids(received.frames)).toEqual([PROMPT_UUID, 'disk-1'])
    expect(dormantSubscribe).toHaveBeenCalledWith(SESSION, expect.any(Function), expect.any(Function))
    sub.unsubscribe()
  })

  it('buffers a slow watcher independently without delaying another watcher', async () => {
    await append([origin(), descriptor()])
    const source = makeSource()
    const slow = source.subscribeSubagentTranscript(SESSION, AGENT)
    const fast = collect(source.subscribeSubagentTranscript(SESSION, AGENT))
    await vi.waitFor(() => expect(fast.frames).toHaveLength(1))

    for (let i = 0; i < 100; i++) publish(assistant(`live-${i}`))
    await vi.waitFor(() => expect(uuids(fast.frames)).toHaveLength(101))
    expect(uuids(fast.frames).slice(-3)).toEqual(['live-97', 'live-98', 'live-99'])
    slow.unsubscribe()
  })

  it('unsubscribe and close detach listeners and stop delivery', async () => {
    await append([origin(), descriptor()])
    const source = makeSource()
    const firstSub = source.subscribeSubagentTranscript(SESSION, AGENT)
    const secondSub = source.subscribeSubagentTranscript(SESSION, AGENT)
    const first = collect(firstSub)
    const second = collect(secondSub)
    await vi.waitFor(() => expect(first.frames.length === 1 && second.frames.length === 1).toBe(true))
    expect(listeners.size).toBe(2)

    firstSub.unsubscribe()
    expect(listeners.size).toBe(1)
    publish(assistant('after-unsubscribe'))
    await vi.waitFor(() => expect(uuids(second.frames)).toContain('after-unsubscribe'))
    expect(uuids(first.frames)).not.toContain('after-unsubscribe')

    source.close()
    expect(listeners.size).toBe(0)
    await Promise.all([first.done, second.done])
    publish(assistant('after-close'))
    expect(uuids(second.frames)).not.toContain('after-close')
  })
})
