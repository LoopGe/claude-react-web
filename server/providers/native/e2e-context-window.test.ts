// Native model-window compaction through the real provider and SessionManager.
// Both model discovery and model streams are fakes: this suite never performs
// a network request.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { summarizeForCompact } from '../../compact-summary.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import { NativeModelContextResolver } from './model-context.js'
import { loadNativeSessionLogSync } from './session-log/log.js'
import type { CanonicalEvent } from './canonical.js'

const { order } = vi.hoisted(() => ({ order: [] as string[] }))

vi.mock('../../compact-summary.js', () => ({
  summarizeForCompact: vi.fn(async () => {
    order.push('summary')
    return 'MOCK SUMMARY'
  }),
}))

function textTurn(text: string, inputTokens: number): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: inputTokens, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

type Frame = Record<string, any>

const managers: SessionManager[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  await new Promise((resolve) => setTimeout(resolve, 80))
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
  order.length = 0
  vi.mocked(summarizeForCompact).mockClear()
})

describe('native model-window compaction', () => {
  it('compacts old history against the smaller window before the next model stream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-window-'))
    dirs.push(dir)
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    const retrieve = vi.fn(async (route: { model: string }) =>
      route.model === 'large' ? 1_000_000 : 200_000)
    const provider = new NativeProvider({
      stateDir: dir,
      modelContext: new NativeModelContextResolver({ discovery: { retrieve } }),
    })
    let streamCount = 0
    provider._testStream = async function* () {
      streamCount++
      const current = streamCount
      order.push(`stream:${current}`)
      const events = current === 1
        ? textTurn('large reply', 300_000)
        : textTurn('small reply', 10)
      for (const event of events) yield event
    }
    const registry = new ProviderRegistry()
    registry.register(provider)
    const sm = new SessionManager({ store, providers: registry })
    managers.push(sm)

    const info = await sm.create({ cwd: dir, model: 'large', provider: 'native', title: 'window-switch' })
    const sub = sm.subscribe(info.id)
    const frames: Frame[] = []
    void (async () => {
      for await (const frame of sub.iterable) frames.push(frame as Frame)
    })()
    try {
      await sm.send(info.id, 'large prompt')
      await vi.waitFor(() => {
        expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(1)
      }, { timeout: 5000 })
      expect(order).toEqual(['stream:1'])
      expect(summarizeForCompact).not.toHaveBeenCalled()

      const live = (sm as unknown as {
        sessions: Map<string, {
          history: Frame[]
          handle: {
            compactInPlace: (summary: string, opts: { uuid: string; timestamp: string }) => Promise<void>
          }
        }>
      }).sessions.get(info.id)!
      const compactInPlace = live.handle.compactInPlace.bind(live.handle)
      live.handle.compactInPlace = vi.fn(async (summary, opts) => {
        order.push('compact')
        await compactInPlace(summary, opts)
      })

      await sm.setModel(info.id, 'small')
      await sm.send(info.id, 'small prompt')
      await vi.waitFor(() => {
        expect(frames.filter((frame) => frame.type === 'result')).toHaveLength(2)
      }, { timeout: 5000 })

      expect(order).toEqual(['stream:1', 'summary', 'compact', 'stream:2'])
      expect(summarizeForCompact).toHaveBeenCalledTimes(1)
      const replacement = JSON.stringify(live.history)
      expect(live.history.some((frame) => frame.subtype === 'compact_boundary')).toBe(true)
      expect(replacement).toContain('MOCK SUMMARY')
      expect(replacement).toContain('small prompt')
      expect(replacement).toContain('small reply')
      expect(replacement).not.toContain('large prompt')
      expect(replacement).not.toContain('large reply')

      await vi.waitFor(() => {
        const events = loadNativeSessionLogSync(dir, info.id)!.events
        expect(events.some((event) =>
          event.type === 'session/compact' && event.text === 'MOCK SUMMARY')).toBe(true)
        expect(JSON.stringify(events)).toContain('small reply')
      }, { timeout: 5000 })
      const events = loadNativeSessionLogSync(dir, info.id)!.events
      expect(events.some((event) => /capacity|model-context|context-window/i.test(event.type))).toBe(false)
    } finally {
      sub.unsubscribe()
    }
  }, 20000)
})
