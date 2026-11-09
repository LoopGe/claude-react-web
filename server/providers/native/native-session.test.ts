// server/providers/native/native-session.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { NativeProvider } from './native-provider.js'
import { NativeSessionStorageError } from './session-log/errors.js'
import { NativeSessionLog, loadNativeSessionLogSync } from './session-log/log.js'
import { nativeSessionLogPath } from './session-log/paths.js'
import type { CanonicalEvent } from './canonical.js'
import type { Frame } from './frames.js'

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

/** A tool-calling response that leaves the tool unanswered when the caller
 *  refuses/crashes before the result is produced. */
function toolTurn(toolUseId: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'Read' } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: '{"file_path":"package.json"}' } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

const tempDirs: string[] = []

/** A fresh temp state dir per test — the provider's default state dir is the
 *  real `~/.claude-react-web`, which a test must never touch. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** Inject a scripted streamer through the provider's test seam. The seam is
 *  evaluated PER TURN, so reassigning it between turns swaps the script. */
function providerWithStreamer(scripts: CanonicalEvent[][], stateDir: string) {
  const provider = new NativeProvider({ stateDir })
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
    for (const ev of scripts.shift() ?? []) yield ev
  }
  return provider
}

function userMsg(text: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid: 'u1',
  }
}

/** The manager's primary send path (and `seedCompactSummary`) hand the
 *  provider `content: text` as a bare string, not a block array. */
function stringUserMsg(text: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: text },
    parent_tool_use_id: null,
    session_id: '',
    uuid: 'u1',
  }
}

interface LogEventLike {
  type: string
  reason?: string
  text?: string
  isCompactSummary?: boolean
  message?: { content?: Array<Record<string, unknown>> }
}

interface LogLike {
  header: { id: string; isSeeded: boolean; inheritedEventCount: number }
  events: LogEventLike[]
}

function logOf(session: unknown): LogLike {
  return (session as { log: LogLike }).log
}

/** Text blocks carried by persisted user events, in order. */
function userTexts(session: unknown): string[] {
  return logOf(session).events
    .filter((event) => event.type === 'user')
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
}

describe('NativeSession', () => {
  it('emits init, then a full turn of frames for a text-only response', async () => {
    const dir = await tempDir('native-session-')
    const provider = providerWithStreamer([textTurn('hello native')], dir)
    const session = provider.createSession({ id: 's1', cwd: process.cwd() })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
    // init + 5 stream events + assistant + result — NO user frame: the
    // context snapshot lives in history only, and user frames carry only
    // tool_result content (frame contract).
    expect(frames.map((f) => f.type)).toEqual([
      'system', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'assistant', 'result',
    ])
    expect(frames[0].subtype).toBe('init')
    const result = frames.at(-1) as Frame
    expect(result.subtype).toBe('success')
    expect(result.result).toBe('hello native')
    await session.destroy()
  })

  it('interrupt during a turn emits exactly one result frame and the session still works', async () => {
    const dir = await tempDir('native-session-')
    const provider = new NativeProvider({ stateDir: dir })
    // Streamer that hangs until its signal aborts — the seam the real
    // defaultStream honors too (fetch rejects on abort).
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      await new Promise<never>((_, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
      yield // unreachable
    }
    const session = provider.createSession({ id: 's3', cwd: process.cwd() })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('one') as never)
    // Give the turn a moment to start (no result may have landed yet).
    await new Promise((r) => setTimeout(r, 20))
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(0)
    await session.interrupt?.()
    await vi.waitFor(() => {
      const results = frames.filter((f) => f.type === 'result')
      expect(results).toHaveLength(1)
      expect(results[0].result).toBe('interrupted by user')
      expect(results[0].is_error).toBe(true)
    })
    // The session is NOT bricked: the next message completes normally. The
    // seam is re-evaluated per turn, so the swapped script takes effect.
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of textTurn('recovered')) yield ev
    }
    session.enqueueUserMessage(userMsg('two') as never)
    await vi.waitFor(() => {
      const results = frames.filter((f) => f.type === 'result')
      expect(results).toHaveLength(2)
      expect(results[1].result).toBe('recovered')
      expect(results[1].subtype).toBe('success')
    })
    await session.destroy()
  })

  it('getContextUsage reflects the last turn usage', async () => {
    const dir = await tempDir('native-session-')
    const provider = providerWithStreamer([textTurn('x')], dir)
    const session = provider.createSession({ id: 's2', cwd: process.cwd() })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => {
      expect(frames.some((f) => f.type === 'result')).toBe(true)
    })
    const usage = (await session.getContextUsage?.()) as { totalTokens: number; maxTokens: number; model: string }
    // Wire shape consumed by liteContextUsageFromSdkUsage (session-pump.ts):
    // { totalTokens, maxTokens, model } — the scripted turn has input 10 + output 5.
    expect(usage.totalTokens).toBe(15)
    expect(usage.maxTokens).toBe(200_000)
    expect(typeof usage.model).toBe('string')
    await session.destroy()
  })

  it('interrupt during tool processing does not park the turn: next tool skipped, exactly one interrupted result', async () => {
    const dir = await tempDir('native-session-')
    const provider = new NativeProvider({ stateDir: dir })
    // One response carrying TWO tool_use blocks — the abort lands while the
    // first tool is being processed, so the second must never execute.
    const twoToolScript: CanonicalEvent[] = [
      { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
      { kind: 'block_start', index: 0, block: { type: 'tool_use', id: 't1', name: 'Read' } },
      { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: '{"file_path":"package.json"}' } },
      { kind: 'block_end', index: 0 },
      { kind: 'block_start', index: 1, block: { type: 'tool_use', id: 't2', name: 'Read' } },
      { kind: 'block_delta', index: 1, delta: { type: 'tool_input', json: '{"file_path":"does-not-exist.txt"}' } },
      { kind: 'block_end', index: 1 },
      { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
    ]
    // The seam honors the signal like the real network streamer (fetch
    // rejects on abort): a post-abort stream call throws immediately.
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      if (req.signal.aborted) throw req.signal.reason ?? new Error('aborted')
      for (const ev of twoToolScript) yield ev
    }
    const canUseToolCalls: string[] = []
    let session: ReturnType<NativeProvider['createSession']> | null = null
    session = provider.createSession({
      id: 's4',
      cwd: process.cwd(),
      canUseTool: async (toolName: unknown) => {
        canUseToolCalls.push(toolName as string)
        // Abort the turn while the FIRST tool's permission resolves — the
        // second tool's permission must never be requested.
        void session?.interrupt?.()
        return { behavior: 'allow', updatedInput: { file_path: 'package.json' } }
      },
    })
    const frames: Frame[] = []
    void (async () => {
      for await (const f of session!.messages) frames.push(f as Frame)
    })()
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => {
      const results = frames.filter((f) => f.type === 'result')
      expect(results).toHaveLength(1)
      expect(results[0].result).toBe('interrupted by user')
      expect(results[0].is_error).toBe(true)
    })
    // Only the FIRST tool ever reached the permission handler.
    expect(canUseToolCalls).toEqual(['Read'])
    // Every tool_use is answered (t1 ran, t2 got the synthetic aborted
    // result) — the next turn's API request stays valid. tool_result frames
    // are one-per-result: collect them all in order.
    const toolResults = frames.filter((f) => f.type === 'user').map((f) => (f as Frame).message.content[0] as { tool_use_id: string })
    expect(toolResults.map((r) => r.tool_use_id)).toEqual(['t1', 't2'])
    await session.destroy()
  })

  it('capabilities declare interrupt and no MCP', async () => {
    const dir = await tempDir('native-session-')
    const provider = new NativeProvider({ stateDir: dir })
    expect(provider.name).toBe('native')
    expect(provider.capabilities.supportsInterrupt).toBe(true)
    expect(provider.capabilities.supportsMcp).toBe(false)
    expect(provider.capabilities.supportsFineGrainedPermissions).toBe(true)
  })

  it('persists a turn and resumes it with model history', async () => {
    const dir = await tempDir('native-persist-')
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () { for (const ev of textTurn('hello')) yield ev }
    const first = provider.createSession({ id: 's1', cwd: dir })
    void (async () => { for await (const _ of first.messages) { /* drain */ } })()
    first.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => {
      const log = logOf(first)
      expect(log.events.some((e) => e.type === 'turn/end')).toBe(true)
    })
    await first.destroy()

    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () { for (const ev of textTurn('again')) yield ev }
    const resumed = provider.createSession({ id: 's1', cwd: dir, resume: 's1' })
    const frames: Frame[] = []
    void (async () => { for await (const f of resumed.messages) frames.push(f as Frame) })()
    await vi.waitFor(() => expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' }))
    expect((resumed as unknown as { history: Array<{ role: string }> }).history[0].role).toBe('user')
    resumed.enqueueUserMessage(userMsg('next') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'again')).toBe(true))
    await resumed.destroy()
  })

  it('normalizes string-content user turns so resume works', async () => {
    const dir = await tempDir('native-string-')
    const provider = providerWithStreamer([textTurn('first'), textTurn('second')], dir)
    const session = provider.createSession({ id: 'string', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(stringUserMsg('hello string') as never)
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'result' && f.result === 'first')).toBe(true))
    await vi.waitFor(() => expect(logOf(session).events.some((e) => e.type === 'turn/end')).toBe(true))
    const persisted = logOf(session).events.find((e) => e.type === 'user')
    expect(persisted?.message?.content).toEqual([{ type: 'text', text: 'hello string' }])
    await session.destroy()

    // Before normalization this threw `corrupt` (the parser rejects a bare
    // string content); the reply turn proves the rebuilt history is valid.
    const resumed = provider.createSession({ id: 'string', cwd: dir, resume: 'string' })
    const resumedFrames: Frame[] = []
    void (async () => { for await (const f of resumed.messages) resumedFrames.push(f as Frame) })()
    resumed.enqueueUserMessage(userMsg('next') as never)
    await vi.waitFor(() => expect(resumedFrames.some((f) => f.type === 'result' && f.result === 'second')).toBe(true))
    await resumed.destroy()
  })

  it('survives a persistence flush failure without double-emitting', async () => {
    const dir = await tempDir('native-flush-')
    const provider = providerWithStreamer([textTurn('hello')], dir)
    const session = provider.createSession({ id: 'flush', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()

    const internals = session as unknown as {
      pumpLoop: () => Promise<void>
      log: { flush: () => Promise<void>; events: LogEventLike[] }
    }
    // `enqueueUserMessage` discards the pump promise; capture it so the test
    // can assert the pump resolves instead of rejecting on a write failure.
    const originalPump = internals.pumpLoop.bind(session)
    let pumpPromise: Promise<void> | null = null
    internals.pumpLoop = () => {
      pumpPromise = originalPump()
      return pumpPromise
    }
    // Fail the turn's pre-run user write exactly once.
    const sessionLog = internals.log
    const originalFlush = sessionLog.flush.bind(sessionLog)
    let rejectNext = true
    sessionLog.flush = () => {
      if (rejectNext) {
        rejectNext = false
        return Promise.reject(new Error('disk full'))
      }
      return originalFlush()
    }

    session.enqueueUserMessage(userMsg('hi') as never)
    await expect(pumpPromise!).resolves.toBeUndefined()
    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1))
    expect((frames.find((f) => f.type === 'result') as Frame).result).toBe('disk full')
    expect(internals.log.events.filter((e) => e.type === 'turn/end')).toHaveLength(1)
    await session.destroy()
  })

  it('does not persist a queued turn that is never consumed', async () => {
    const dir = await tempDir('native-queued-')
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      // Mirrors a real fetch: an already-aborted signal rejects immediately
      // (the interrupt can land while the consumed turn's write is in flight).
      if (req.signal.aborted) throw req.signal.reason ?? new Error('aborted')
      await new Promise<never>((_, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
      yield // unreachable
    }
    const session = provider.createSession({ id: 'queued', cwd: dir })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('first') as never)
    session.enqueueUserMessage(userMsg('second') as never)
    await vi.waitFor(() => expect(session.queueDepth).toBe(1))
    // The pump arms the per-turn abort controller before persisting the
    // consumed turn; wait until it is armed so interrupt() targets a live turn.
    await vi.waitFor(() => {
      expect((session as unknown as { turnAbort: unknown }).turnAbort).not.toBeNull()
    })
    await session.interrupt?.()
    await vi.waitFor(() => expect(logOf(session).events.some((e) => e.type === 'turn/end')).toBe(true))
    expect(userTexts(session)).toEqual(['first'])
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    await session.destroy()
  })

  it('repairs an interrupted tool turn on resume', async () => {
    const dir = await tempDir('native-repair-')
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of toolTurn('t1')) yield ev
    }
    const session = provider.createSession({
      id: 'repair',
      cwd: dir,
      canUseTool: async () => {
        // A broker crash AFTER the assistant frame was persisted and BEFORE
        // any tool_result — exactly the crash-shape repair exists for.
        throw new Error('permission broker crashed')
      },
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    session.enqueueUserMessage(userMsg('use a tool') as never)
    await vi.waitFor(() => {
      expect(logOf(session).events.some((e) => e.type === 'turn/end' && e.reason === 'error')).toBe(true)
    })
    await session.destroy()

    const resumed = provider.createSession({ id: 'repair', cwd: dir, resume: 'repair' })
    const synthetic = logOf(resumed).events.find((e) => JSON.stringify(e).includes('tool result missing'))
    expect(synthetic).toBeDefined()
    expect(JSON.stringify(synthetic)).toContain('t1')
    const history = (resumed as unknown as { history: unknown[] }).history
    expect(JSON.stringify(history)).toContain('tool result missing')
    await resumed.destroy()

    const snapshot = loadNativeSessionLogSync(dir, 'repair')!
    expect(snapshot.events.some((e) => JSON.stringify(e).includes('tool result missing'))).toBe(true)
  })

  it('forks from the source log and writes a seeded child log', async () => {
    const dir = await tempDir('native-fork-')
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of textTurn('source reply')) yield ev
    }
    const source = provider.createSession({ id: 'source', cwd: dir })
    const sourceFrames: Frame[] = []
    void (async () => { for await (const f of source.messages) sourceFrames.push(f as Frame) })()
    source.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => expect(sourceFrames.some((f) => f.type === 'result')).toBe(true))
    await vi.waitFor(() => expect(logOf(source).events.some((e) => e.type === 'turn/end')).toBe(true))
    await source.destroy()
    const sourceEvents = loadNativeSessionLogSync(dir, 'source')!.events

    const forked = provider.createSession({ id: 'child', cwd: dir, resume: 'source', forkSession: true })
    const log = logOf(forked)
    expect(log.header.isSeeded).toBe(true)
    expect(log.header.inheritedEventCount).toBe(sourceEvents.length)
    expect(log.events.some((e) => e.type === 'session/end-seed')).toBe(true)
    expect(log.events.some((e) => e.type === 'turn/end' && e.reason === 'forked')).toBe(true)
    expect(log.events.some((e) => e.type === 'session/context' && (e.text ?? '').includes(dir))).toBe(true)
    const history = (forked as unknown as { history: unknown[] }).history
    expect(history[0]).toMatchObject({ role: 'user' })
    expect(JSON.stringify(history)).toContain('source reply')
    await forked.destroy()

    const child = loadNativeSessionLogSync(dir, 'child')!
    expect(child.header.id).toBe('child')
    expect(child.header.isSeeded).toBe(true)
  })

  it('persists the compact control seed, normalizing string content', async () => {
    const dir = await tempDir('native-compact-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'compact', cwd: dir })
    // seedCompactSummary sends a string-content message.
    session.sendControlMessage(stringUserMsg('compact summary') as never)
    const compact = logOf(session).events.find((e) => JSON.stringify(e).includes('compact summary'))
    expect(compact).toMatchObject({ type: 'user', isCompactSummary: true })
    expect(compact?.message?.content).toEqual([{ type: 'text', text: 'compact summary' }])
    const history = (session as unknown as { history: unknown[] }).history
    expect(JSON.stringify(history)).toContain('compact summary')
    await session.destroy()

    const snapshot = loadNativeSessionLogSync(dir, 'compact')!
    const persisted = snapshot.events.find((e) => JSON.stringify(e).includes('compact summary'))
    expect(persisted).toMatchObject({ type: 'user', isCompactSummary: true })
    expect(persisted?.type === 'user' ? persisted.message.content : undefined).toEqual([
      { type: 'text', text: 'compact summary' },
    ])
  })

  it('exposes history, existence and deletion over the state dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-prov-'))
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () { for (const ev of textTurn('hello')) yield ev }
    const session = provider.createSession({ id: 'p1', cwd: dir })
    ;(async () => { for await (const _ of session.messages) { /* drain */ } })()
    session.enqueueUserMessage(userMsg('hi') as never)
    await vi.waitFor(() => {
      const log = (session as unknown as { log: { events: Array<{ type: string }> } }).log
      expect(log.events.some((e) => e.type === 'turn/end')).toBe(true)
    })
    await session.destroy() // flush + close before reading the file
    const meta = { id: 'p1', cwd: dir } as never
    expect(await provider.hasTranscript(meta)).toBe(true)
    const entries = await provider.readHistoryEntries!('p1', {})
    expect(entries.length).toBeGreaterThan(0)
    expect((await provider.readHistoryPage!('p1', { limit: 10 })).totalCount).toBe(entries.length)
    expect(await provider.deleteTranscript!('p1')).toBe(true)
    expect(await provider.hasTranscript(meta)).toBe(false)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('reports a corrupt log as existing, then fails loudly on read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-corrupt-'))
    const provider = new NativeProvider({ stateDir: dir })
    const log = NativeSessionLog.open({ stateDir: dir, id: 'p2', cwd: dir, resume: false })
    log.append({ type: 'session/context', text: 'ctx' })
    await log.flush(); await log.close()
    const path = nativeSessionLogPath(dir, 'p2')
    const raw = await readFile(path, 'utf8')
    await writeFile(path, raw.replace('"v":1', '"v":2'))
    expect(await provider.hasTranscript({ id: 'p2', cwd: dir } as never)).toBe(true)
    await expect(provider.readHistoryEntries!('p2', {})).rejects.toThrow(/unsupported|version/i)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('refuses to resume a corrupt log', async () => {
    const dir = await tempDir('native-corrupt-')
    const provider = new NativeProvider({ stateDir: dir })
    const session = provider.createSession({ id: 'corrupt', cwd: dir })
    await session.destroy()
    const path = nativeSessionLogPath(dir, 'corrupt')
    writeFileSync(path, readFileSync(path, 'utf8').replace('"v":1', '"v":2'))
    let caught: unknown
    try {
      provider.createSession({ id: 'corrupt', cwd: dir, resume: 'corrupt' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(NativeSessionStorageError)
    expect((caught as NativeSessionStorageError).kind).toBe('unsupported-version')
  })
})