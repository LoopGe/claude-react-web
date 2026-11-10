// server/providers/native/e2e-thinking-effort.test.ts
//
// End-to-end proof of P1.5 through SessionManager: extended thinking,
// reasoning effort / fast mode, and mid-run steering, each driven through the
// manager's real create → subscribe → send → pumped-frame path.
//
// Fixture shape copied from e2e.test.ts / e2e-persistence.test.ts (temp-dir
// SessionStore + custom ProviderRegistry + SessionManager). Two seams:
//
//   - Thinking / effort / fast-mode assertions need the BUILT request (the
//     wire `thinking` / `output_config` / `speed` fields and the beta
//     header), which the provider's `_testStream` seam can never see: that
//     seam replaces the streamer INSIDE the session, so it only receives
//     `{ model, system, tools, messages, signal }`. Those tests leave the
//     real streamer in place and stub `fetch`, so `buildRequestBody`, the
//     header builder and SSE translation all run for real.
//   - Steering needs a mid-turn pause, which the scripted `_testStream` seam
//     (an async generator blocking on a test gate) provides directly.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import { FAST_MODE_BETA } from './anthropic-stream.js'
import { formatSupplementInstruction } from '../steering-format.js'
import type { CanonicalEvent } from './canonical.js'

type Frame = Record<string, any>

type StreamRequest = {
  model: string
  system: string
  tools: unknown[]
  messages: Array<{ role: string; content: unknown }>
  signal: AbortSignal
}

interface Fixture {
  provider: NativeProvider
  sm: SessionManager
}

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already gone / manager shut down */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  await new Promise((r) => setTimeout(r, 80)) // let in-flight native-log writes land before rmdir
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor
  // probe (captureGitHead) still holding the temp dir as its cwd.
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
})

async function makeFixture(dir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir: dir })
  await store.load()
  const provider = new NativeProvider({ stateDir: dir })
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { provider, sm }
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

// ── frame collection ────────────────────────────────────────────────────

interface Collected {
  frames: Frame[]
  unsubscribe: () => void
}

function collect(sm: SessionManager, id: string): Collected {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const f of sub.iterable) frames.push(f as Frame)
  })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

function resultsOf(frames: Frame[]): Frame[] {
  return frames.filter((f) => f.type === 'result')
}

async function waitForResults(frames: Frame[], count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(resultsOf(frames)).toHaveLength(count)
  }, { timeout: 5000 })
}

/** Narrow read of the manager's live session map (private by design), the
 *  same escape hatch the sibling e2e tests use. */
function liveSession(sm: SessionManager, id: string): {
  history: Array<Record<string, unknown>>
  promptUuids?: Array<{ u: string; v?: string }>
  steeredInFlight: Map<string, unknown>
} {
  return (sm as unknown as {
    sessions: Map<string, {
      history: Array<Record<string, unknown>>
      promptUuids?: Array<{ u: string; v?: string }>
      steeredInFlight: Map<string, unknown>
    }>
  }).sessions.get(id)!
}

// ── wire harness (real streamer, stubbed fetch) ─────────────────────────

interface WireCall {
  url: string
  headers: Record<string, string>
  body: Record<string, any>
}

interface WireHarness {
  calls: WireCall[]
  /** Queue one scripted SSE body for the next API round. */
  respond(events: string[]): void
}

type FetchInit = { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }

function wireHarness(): WireHarness {
  const calls: WireCall[] = []
  const queue: string[][] = []
  vi.stubGlobal('fetch', async (url: string, init: FetchInit) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    const events = queue.shift()
    if (!events) throw new Error('unexpected fetch — no scripted response queued')
    return sseResponse(events)
  })
  return { calls, respond: (events) => queue.push(events) }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function sseResponse(events: string[]): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(e))
      c.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** One plain text round. */
function textResponse(text: string): string[] {
  return [
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    sse('message_stop', { type: 'message_stop' }),
  ]
}

/** A round whose thinking block carries a signature (the only shape the API
 *  accepts back on a follow-up request). */
function signedThinkingResponse(thinking: string, signature: string, text: string): string[] {
  return [
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    sse('message_stop', { type: 'message_stop' }),
  ]
}

function thinkingBlocks(messages: Array<{ role: string; content: unknown }>): unknown[] {
  const out: unknown[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === 'thinking') out.push(block)
    }
  }
  return out
}

// ── tests ───────────────────────────────────────────────────────────────

describe('native thinking through SessionManager', () => {
  it('sends the create-time budget, follows live switches, retains signed thinking, and re-applies on resume', async () => {
    const dir = await tempDir('sm-native-thinking-e2e-')
    const wire = wireHarness()
    const first = await makeFixture(dir)

    const info = await first.sm.create({
      cwd: dir,
      model: 'claude-opus-4-8',
      provider: 'native',
      title: 'thinking-e2e',
      thinking: { type: 'enabled', budgetTokens: 4096 },
    })
    const id = info.id
    const seen = collect(first.sm, id)

    // Create-time intent → the wire's snake_case enabled config.
    wire.respond(signedThinkingResponse('pondering', 'sig-abc', 'first answer'))
    await first.sm.send(id, 'first prompt')
    await waitForResults(seen.frames, 1)
    expect(wire.calls[0].body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })

    // Live switch: adaptive on the NEXT request.
    await first.sm.setThinking(id, { type: 'adaptive' })
    wire.respond(textResponse('second answer'))
    await first.sm.send(id, 'second prompt')
    await waitForResults(seen.frames, 2)
    expect(wire.calls[1].body.thinking).toEqual({ type: 'adaptive' })
    // The signed thinking block from turn 1 survives in the model history...
    expect(thinkingBlocks(wire.calls[1].body.messages)).toEqual([
      { type: 'thinking', thinking: 'pondering', signature: 'sig-abc' },
    ])

    // Live switch: disabled on the NEXT request (and persisted).
    await first.sm.setThinking(id, { type: 'disabled' })
    wire.respond(textResponse('third answer'))
    await first.sm.send(id, 'third prompt')
    await waitForResults(seen.frames, 3)
    expect(wire.calls[2].body.thinking).toEqual({ type: 'disabled' })

    // Restart + resume: the persisted thinking config is re-applied at spawn.
    seen.unsubscribe()
    await first.sm.shutdown()
    const second = await makeFixture(dir)
    await second.sm.resume(id)
    sessionIds.push({ sm: second.sm, id })
    const resumed = collect(second.sm, id)
    wire.respond(textResponse('resumed answer'))
    await second.sm.send(id, 'fourth prompt')
    await waitForResults(resumed.frames, 1)
    expect(wire.calls[3].body.thinking).toEqual({ type: 'disabled' })
    resumed.unsubscribe()
  }, 30000)
})

describe('native effort and fast mode through SessionManager', () => {
  it('sends effort + fast mode, follows live switches, and re-applies both on resume', async () => {
    const dir = await tempDir('sm-native-effort-e2e-')
    const wire = wireHarness()
    const first = await makeFixture(dir)

    const info = await first.sm.create({
      cwd: dir,
      model: 'claude-opus-4-8',
      provider: 'native',
      title: 'effort-e2e',
      effort: 'max',
    })
    const id = info.id
    // The init frame carries the intent-based state (the native provider has
    // no CLI to report a runtime one): it is folded into the session before
    // any turn runs, so the chip is truthful from birth.
    await vi.waitFor(() => expect(first.sm.get(id).fastModeState).toBe('off'))
    // Fast mode is a live flag (POST /sessions/:id/fast-mode), not a create
    // option: the route forwards it through setFastMode.
    await first.sm.setFastMode(id, true)

    const seen = collect(first.sm, id)
    wire.respond(textResponse('first answer'))
    await first.sm.send(id, 'first prompt')
    await waitForResults(seen.frames, 1)
    expect(wire.calls[0].body.output_config).toEqual({ effort: 'max' })
    expect(wire.calls[0].body.speed).toBe('fast')
    expect(wire.calls[0].headers['anthropic-beta']).toBe(FAST_MODE_BETA)
    // The result frame reports the live intent.
    expect(resultsOf(seen.frames)[0].fast_mode_state).toBe('on')

    // Both live switches land on the NEXT request; turning fast mode off also
    // drops the beta header (they are one decision point).
    await first.sm.setEffortLevel(id, 'high')
    await first.sm.setFastMode(id, false)
    wire.respond(textResponse('second answer'))
    await first.sm.send(id, 'second prompt')
    await waitForResults(seen.frames, 2)
    expect(wire.calls[1].body.output_config).toEqual({ effort: 'high' })
    expect(wire.calls[1].body.speed).toBeUndefined()
    expect(wire.calls[1].headers['anthropic-beta']).toBeUndefined()
    expect(resultsOf(seen.frames)[1].fast_mode_state).toBe('off')

    // Restart + resume: effort and fast-mode intent are persisted, re-applied
    // at spawn (init) and present on the first post-resume request.
    await first.sm.setFastMode(id, true)
    seen.unsubscribe()
    await first.sm.shutdown()
    const second = await makeFixture(dir)
    await second.sm.resume(id)
    sessionIds.push({ sm: second.sm, id })
    await vi.waitFor(() => expect(second.sm.get(id).fastModeState).toBe('on'))
    const resumed = collect(second.sm, id)
    wire.respond(textResponse('resumed answer'))
    await second.sm.send(id, 'third prompt')
    await waitForResults(resumed.frames, 1)
    expect(wire.calls[2].body.output_config).toEqual({ effort: 'high' })
    expect(wire.calls[2].body.speed).toBe('fast')
    expect(wire.calls[2].headers['anthropic-beta']).toBe(FAST_MODE_BETA)
    resumed.unsubscribe()
  }, 30000)
})

describe('native steering through SessionManager', () => {
  it('injects a mid-turn supplement into the next request and reports the injected transition', async () => {
    const dir = await tempDir('sm-native-steer-inject-')
    const { sm, provider } = await makeFixture(dir)

    const requests: Array<{ messages: StreamRequest['messages'] }> = []
    let streaming!: () => void
    const streamingStarted = new Promise<void>((resolve) => { streaming = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })

    /** Round 1 announces a tool call, then blocks until the test has sent the
     *  steer; the tool round forces a second API request inside the turn,
     *  which is where the supplement is injected. */
    async function* toolRound(): AsyncGenerator<CanonicalEvent> {
      yield { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } }
      yield { kind: 'block_start', index: 0, block: { type: 'text' } }
      yield { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'working' } }
      yield { kind: 'block_end', index: 0 }
      yield { kind: 'block_start', index: 1, block: { type: 'tool_use', id: 'read-1', name: 'Read' } }
      yield { kind: 'block_delta', index: 1, delta: { type: 'tool_input', json: '{"file_path":"nope.txt"}' } }
      yield { kind: 'block_end', index: 1 }
      streaming()
      await gate
      yield { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } }
    }

    function textRound(text: string): CanonicalEvent[] {
      return [
        { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
        { kind: 'block_start', index: 0, block: { type: 'text' } },
        { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
        { kind: 'block_end', index: 0 },
        { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
      ]
    }

    provider._testStream = (req: StreamRequest) => {
      requests.push({ messages: JSON.parse(JSON.stringify(req.messages)) as StreamRequest['messages'] })
      if (requests.length === 1) return toolRound()
      return (async function* () { for (const ev of textRound('steer acknowledged')) yield ev })()
    }

    // The tool round needs a decision: without a caller-supplied handler the
    // manager parks the request in its permission broker, which would hold the
    // turn open until the test's cleanup interrupt.
    const info = await sm.create({
      cwd: dir,
      model: 'test-model',
      provider: 'native',
      title: 'steer-inject',
      canUseTool: (async (_name: string, input: Record<string, unknown>) => ({
        behavior: 'allow', updatedInput: input,
      })) as never,
    })
    const id = info.id
    sessionIds.push({ sm, id })
    const seen = collect(sm, id)
    const status = sm.subscribeMessageStatus(id)!
    const statusFrames: Frame[] = []
    void (async () => {
      for await (const f of status.iterable) statusFrames.push(f as Frame)
    })()

    await sm.send(id, 'start the turn')
    await streamingStarted
    const steer = sm.send(id, 'pivot')
    // Admission is the steering path, not the next-turn queue: the bubble is
    // stamped steeredAt and never enters promptUuids (it starts no turn).
    expect(liveSession(sm, id).steeredInFlight.has(steer.uuid!)).toBe(true)
    release()
    await waitForResults(seen.frames, 1)

    // The NEXT request carries the WRAPPED guidance as a user message.
    expect(requests).toHaveLength(2)
    expect(requests[1].messages[requests[1].messages.length - 1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: formatSupplementInstruction('pivot') }],
    })
    // The live injected transition was observed (the client's MESSAGE_STEERED).
    expect(statusFrames).toContainEqual({
      kind: 'message-steered', sessionId: id, uuid: steer.uuid, state: 'injected',
    })
    // The ring entry is stamped for replay, and the steer is no longer in flight.
    const entry = liveSession(sm, id).history.find((m) => m.uuid === steer.uuid) as
      { steeredAt?: number; injectedAt?: number } | undefined
    expect(entry?.steeredAt).toEqual(expect.any(Number))
    expect(entry?.injectedAt).toEqual(expect.any(Number))
    expect(liveSession(sm, id).steeredInFlight.has(steer.uuid!)).toBe(false)
    // A steered turn is never paired as a prompt uuid (it never echoes).
    expect(liveSession(sm, id).promptUuids?.map((e) => e.u)).not.toContain(steer.uuid)

    status.unsubscribe()
    seen.unsubscribe()
  }, 20000)

  it('requeues a supplement that missed the last round and pairs its prompt uuid', async () => {
    const dir = await tempDir('sm-native-steer-requeue-')
    const { sm, provider } = await makeFixture(dir)

    const requests: Array<{ messages: StreamRequest['messages'] }> = []
    let streaming!: () => void
    const streamingStarted = new Promise<void>((resolve) => { streaming = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })

    /** The only round of the turn: the steer lands while it streams, so no
     *  API round is left to inject into. */
    async function* lastRound(): AsyncGenerator<CanonicalEvent> {
      yield { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } }
      yield { kind: 'block_start', index: 0, block: { type: 'text' } }
      yield { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'finishing' } }
      streaming()
      await gate
      yield { kind: 'block_end', index: 0 }
      yield { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } }
    }

    provider._testStream = (req: StreamRequest) => {
      requests.push({ messages: JSON.parse(JSON.stringify(req.messages)) as StreamRequest['messages'] })
      if (requests.length === 1) return lastRound()
      const events: CanonicalEvent[] = [
        { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
        { kind: 'block_start', index: 0, block: { type: 'text' } },
        { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'requeued answer' } },
        { kind: 'block_end', index: 0 },
        { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
      ]
      return (async function* () { for (const ev of events) yield ev })()
    }

    const info = await sm.create({ cwd: dir, model: 'test-model', provider: 'native', title: 'steer-requeue' })
    const id = info.id
    sessionIds.push({ sm, id })
    const seen = collect(sm, id)
    const status = sm.subscribeMessageStatus(id)!
    const statusFrames: Frame[] = []
    void (async () => {
      for await (const f of status.iterable) statusFrames.push(f as Frame)
    })()

    await sm.send(id, 'start the turn')
    await streamingStarted
    const steer = sm.send(id, 'late pivot')
    release()
    // The turn ends, the manager requeues the leftover, and the requeued
    // prompt runs as its own turn: two terminal frames, two API requests.
    await waitForResults(seen.frames, 2)
    expect(requests).toHaveLength(2)

    expect(statusFrames).toContainEqual({
      kind: 'message-steered', sessionId: id, uuid: steer.uuid, state: 'requeued',
    })
    const entry = liveSession(sm, id).history.find((m) => m.uuid === steer.uuid) as
      { requeuedAt?: number } | undefined
    expect(entry?.requeuedAt).toEqual(expect.any(Number))
    // The prompt uuid was recorded BEFORE the enqueue, so the native provider's
    // synchronous consume paired it (v is stamped in the same call).
    expect(liveSession(sm, id).promptUuids?.find((e) => e.u === steer.uuid)?.v).toBe(steer.uuid)
    // Requeued as a NORMAL prompt: the original text, never the wrapped form
    // (the wrapped guidance is only for mid-run injection).
    const serialized = JSON.stringify(requests)
    expect(JSON.stringify(requests[1].messages)).toContain('late pivot')
    expect(serialized).not.toContain('[ADDITIONAL GUIDANCE]')

    status.unsubscribe()
    seen.unsubscribe()
  }, 20000)
})