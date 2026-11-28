// server/providers/native/e2e.test.ts
//
// End-to-end smoke: NativeProvider reached through the exact SessionManager
// path the HTTP route uses (create → subscribe → send → pumped frames).
// Fixture shape copied from server/session-manager-steering.test.ts (SessionStore
// on a tmp stateDir + custom ProviderRegistry); the streamer is scripted via
// the provider's `_testStream` seam (see native-session.test.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { config as defaultConfig, __setConfigForTest } from '../../config.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'
import { createAutoMemoryPort } from '../native-host-auto-memory.js'
import type { NativeAuxLlmPort } from './ports.js'
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
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
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

  it('memory recall: live frame + durable sidecar row + restart survival', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-recall-e2e-'))
    dirs.push(dir)
    const stateDir = join(dir, 'state')
    const configDir = join(dir, 'claude-config')
    const ownDir = join(dir, 'mem')
    await mkdir(stateDir, { recursive: true })
    await mkdir(configDir, { recursive: true })
    await mkdir(ownDir, { recursive: true })
    // A topic file the aux selector will pick (frontmatter description rides
    // the candidate list; the body is what the recall supplement injects).
    await writeFile(join(ownDir, 'a.md'), '---\ndescription: a desc\n---\n\nBODY-A\n', 'utf8')

    // A configured profile so the recall selector's credentials() target
    // resolves (the aux port itself is stubbed — no network). Restored after.
    const before = { profiles: defaultConfig.profiles, activeProfileId: defaultConfig.activeProfileId }
    __setConfigForTest({
      profiles: [{
        id: 'rp', name: 'Recall', authToken: 'tok', baseUrl: 'https://api.example.test',
        modelList: [], recapModel: '', commitMessageModel: '',
      }],
      activeProfileId: 'rp',
    })

    const autoMemory = createAutoMemoryPort({ stateDir, configDir })
    const auxLlm: NativeAuxLlmPort = { call: async () => JSON.stringify({ selected_memories: ['a.md'] }) }
    const store = new SessionStore({ stateDir })
    await store.load()
    const provider = new NativeProvider({ stateDir, ports: { ...makeNativePorts({ stateDir, autoMemory }), auxLlm } })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of textTurn('hello recall')) yield ev
    }
    const registry = new ProviderRegistry()
    registry.register(provider)
    const sm = new SessionManager({ store, providers: registry })
    managers.push(sm)

    try {
      const info = await sm.create({
        cwd: dir, model: 'test-model', provider: 'native', title: 'recall-e2e',
        memory: { autoMemoryDirectory: ownDir },
      } as unknown as Parameters<typeof sm.create>[0])
      const sub = sm.subscribe(info.id)
      const frames: Frame[] = []
      void (async () => {
        for await (const f of sub.iterable) frames.push(f as Frame)
      })()

      await sm.send(info.id, 'hi')
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
      })
      sub.unsubscribe()

      // Live half: the recall card rode the broadcast channel (memory_recall ∈
      // BROADCAST_SYSTEM_SUBTYPES). File-backed entry carries NO content.
      const recall = frames.find((f) => f.type === 'system' && f.subtype === 'memory_recall')
      expect(recall).toBeDefined()
      expect(recall!.mode).toBe('select')
      expect(recall!.memories).toEqual([{ path: join(ownDir, 'a.md'), scope: 'personal' }])
      expect(recall!.parent_tool_use_id).toBeNull()
      expect(recall!.uuid).toEqual(expect.any(String))

      // Durable half: the seq sidecar ndjson carries an app-only memory_recall
      // row (the frame is live-only — never a durable SessionEvent — so the
      // sidecar is its sole persistence). Poll until the fire-and-forget append
      // lands.
      const sidecarPath = join(stateDir, 'transcripts', `${info.id}.ndjson`)
      let recallRow: Frame | undefined
      await vi.waitFor(async () => {
        const rows = (await readFile(sidecarPath, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Frame)
        recallRow = rows.find((r) => r.type === 'system' && r.subtype === 'memory_recall')
        expect(recallRow).toBeDefined()
      })
      expect(recallRow!.msg.memories).toEqual([{ path: join(ownDir, 'a.md'), scope: 'personal' }])
      expect(recallRow!.msg.uuid).toBe(recall!.uuid)
      const recallSeq = recallRow!.seq as number

      // RESTART SURVIVAL: shut the first manager down, build a SECOND one on the
      // same stateDir, and cold-read the transcript window. The recall frame
      // hydrates from the sidecar at the SAME seq with the SAME shape (the
      // provider log never carried it — append-only reconcile keeps the app row).
      await sm.shutdown()
      const store2 = new SessionStore({ stateDir })
      await store2.load()
      const provider2 = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
      const registry2 = new ProviderRegistry()
      registry2.register(provider2)
      const sm2 = new SessionManager({ store: store2, providers: registry2 })
      managers.push(sm2)
      sessionIds.push({ sm: sm2, id: info.id })

      const win = await sm2.getTranscriptWindow(info.id)
      expect(win.degraded).toBe(false)
      const cold = win.messages.find((m) => m.seq === recallSeq)
      expect(cold).toBeDefined()
      expect((cold!.msg as Frame).subtype).toBe('memory_recall')
      expect((cold!.msg as Frame).mode).toBe('select')
      expect((cold!.msg as Frame).memories).toEqual([{ path: join(ownDir, 'a.md'), scope: 'personal' }])
      expect(cold!.msg).toEqual(recallRow!.msg)
    } finally {
      __setConfigForTest({ ...before })
    }
  })
})
