// server/providers/native/e2e.test.ts
//
// End-to-end smoke: NativeProvider reached through the exact SessionManager
// path the HTTP route uses (create → subscribe → send → pumped frames).
// Fixture shape copied from server/session-manager-steering.test.ts (SessionStore
// on a tmp stateDir + custom ProviderRegistry); the streamer is scripted via
// the provider's `_testStream` seam (see native-session.test.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import type { CanonicalEvent } from './canonical.js'

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

type Frame = Record<string, any>

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already gone */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  await new Promise((r) => setTimeout(r, 80)) // let in-flight sidecar writes land before rmdir
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor
  // probe (captureGitHead) still holding the temp dir as its cwd; the child
  // exits within ~150 ms.
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
})

describe('native provider through SessionManager', () => {
  it('create + send produces an assistant frame and settles the turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-e2e-'))
    dirs.push(dir)
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    const provider = new NativeProvider({ stateDir: dir })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of textTurn('hello native')) yield ev
    }
    const registry = new ProviderRegistry()
    registry.register(provider)
    const sm = new SessionManager({ store, providers: registry })
    managers.push(sm)

    const info = await sm.create({ cwd: dir, model: 'test-model', provider: 'native', title: 'e2e' })
    sessionIds.push({ sm, id: info.id })

    // Subscribe BEFORE the send so replay + live frames both land here.
    const sub = sm.subscribe(info.id)
    const frames: Frame[] = []
    void (async () => {
      for await (const f of sub.iterable) frames.push(f as Frame)
    })()

    await sm.send(info.id, 'hi')

    // The turn settles: exactly one result frame.
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
    sub.unsubscribe()

    // The pump consumed the provider's `system/init` as a lifecycle signal
    // (initAtMs stamp); init frames never enter the transcript ring — the
    // manager drops durable system frames outside BROADCAST_SYSTEM_SUBTYPES,
    // exactly as it does for claude sessions.
    const s = (sm as unknown as { sessions: Map<string, { history: Frame[]; initAtMs?: number }> }).sessions.get(info.id)!
    expect(s.initAtMs).toEqual(expect.any(Number))

    // The prompt itself produces NO user frame (the manager broadcasts it);
    // the assistant finalize frame carries the reply text.
    const assistant = frames.find((f) => f.type === 'assistant')
    expect(assistant?.message?.content?.[0]).toMatchObject({ type: 'text', text: 'hello native' })

    const result = frames.find((f) => f.type === 'result')
    expect(result?.subtype).toBe('success')
    expect(result?.result).toBe('hello native')

    // The queued prompt was consumed by the session (consumedAt stamped via
    // onUserMessageConsumed), so it never replays as permanently 'queued'.
    const user = s.history.find((m) => m.type === 'user') as { consumedAt?: number } | undefined
    expect(user?.consumedAt).toEqual(expect.any(Number))
  })
})
