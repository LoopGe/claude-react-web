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
    const usage = (await session.getContextUsage?.()) as { input_tokens: number }
    expect(usage.input_tokens).toBe(10)
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
