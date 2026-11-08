// server/providers/native/native-session.test.ts
import { describe, expect, it, vi } from 'vitest'
import { NativeProvider } from './native-provider.js'
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

/** Inject a scripted streamer through the provider's test seam. The seam is
 *  evaluated PER TURN, so reassigning it between turns swaps the script. */
function providerWithStreamer(scripts: CanonicalEvent[][]) {
  const provider = new NativeProvider()
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

describe('NativeSession', () => {
  it('emits init, then a full turn of frames for a text-only response', async () => {
    const provider = providerWithStreamer([textTurn('hello native')])
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
    const provider = new NativeProvider()
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
    const provider = providerWithStreamer([textTurn('x')])
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
    const provider = new NativeProvider()
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

  it('capabilities declare interrupt and no MCP', () => {
    const provider = new NativeProvider()
    expect(provider.name).toBe('native')
    expect(provider.capabilities.supportsInterrupt).toBe(true)
    expect(provider.capabilities.supportsMcp).toBe(false)
    expect(provider.capabilities.supportsFineGrainedPermissions).toBe(true)
  })
})
