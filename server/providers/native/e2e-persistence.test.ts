// server/providers/native/e2e-persistence.test.ts
//
// Integration proof for the native provider's persistence, driven through the
// exact SessionManager paths the HTTP route uses. Companion to e2e.test.ts
// (same temp-dir SessionStore + custom ProviderRegistry + `_testStream` shape):
//
//   - restart + resume: a SECOND SessionManager over the same stateDir restores
//     the persisted turn into the history page and into search;
//   - fork: a new id whose native log is seeded from the source's turn;
//   - side chat: the child's history PAGE hides the inherited parent prefix
//     while its own native log still carries it as model context;
//   - delete({ deleteTranscript }) removes the native log;
//   - /clear spawns a fresh id with its own log and leaves the source log.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import { hasNativeSessionLog } from './session-log/log.js'
import type { CanonicalEvent } from './canonical.js'

const PROMPT = 'persisted-prompt-marker'
const REPLY = 'persisted-reply-marker'

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

interface Fixture {
  provider: NativeProvider
  sm: SessionManager
}

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
  provider._testStream = async function* () {
    for (const ev of textTurn(REPLY)) yield ev
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { provider, sm }
}

/** Create a native session, run one scripted turn, and wait for the result. */
async function createAndSend(sm: SessionManager, cwd: string): Promise<string> {
  const info = await sm.create({ cwd, model: 'test-model', provider: 'native', title: 'e2e' })
  await sendTurn(sm, info.id)
  return info.id
}

async function sendTurn(sm: SessionManager, id: string): Promise<void> {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const f of sub.iterable) frames.push(f as Frame)
  })()
  try {
    await sm.send(id, PROMPT)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    }, { timeout: 5000 })
  } finally {
    sub.unsubscribe()
  }
}

/** Wait until the assistant reply is readable from the native log on disk —
 *  the durable half of the turn, not just the live frame. */
async function waitForPersistedTurn(provider: NativeProvider, id: string): Promise<void> {
  await vi.waitFor(async () => {
    const page = await provider.readHistoryPage(id, { limit: 20 })
    expect(JSON.stringify(page.messages)).toContain(REPLY)
  }, { timeout: 5000 })
}

function pageText(page: { messages: unknown[] }): string {
  return JSON.stringify(page.messages)
}

describe('native provider persistence through SessionManager', () => {
  it('restart + resume restores the turn into history and search', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-persist-'))
    dirs.push(dir)

    const first = await makeFixture(dir)
    const id = await createAndSend(first.sm, dir)
    await waitForPersistedTurn(first.provider, id)
    expect(await hasNativeSessionLog(dir, id)).toBe(true)
    await first.sm.shutdown()

    const second = await makeFixture(dir)
    const resumed = await second.sm.resume(id)
    expect(resumed.id).toBe(id)
    sessionIds.push({ sm: second.sm, id })

    const page = await second.sm.getHistoryPage(id, { limit: 10 })
    expect(pageText(page)).toContain(REPLY)
    expect(pageText(page)).toContain(PROMPT)

    const hits = await second.sm.searchMessages(REPLY, { sessionId: id })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.sessionId === id)).toBe(true)
  }, 20000)

  it('fork creates a child with its own seeded native log carrying the source turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-fork-'))
    dirs.push(dir)

    const { provider, sm } = await makeFixture(dir)
    const sourceId = await createAndSend(sm, dir)
    sessionIds.push({ sm, id: sourceId })
    await waitForPersistedTurn(provider, sourceId)

    const child = await sm.fork(sourceId)
    sessionIds.push({ sm, id: child.id })
    expect(child.id).not.toBe(sourceId)
    expect(await hasNativeSessionLog(dir, child.id)).toBe(true)

    const page = await sm.getHistoryPage(child.id, { limit: 10 })
    expect(pageText(page)).toContain(PROMPT)
    expect(pageText(page)).toContain(REPLY)
  }, 20000)

  it('side chat hides the inherited parent prefix from its history page but keeps it in its log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-side-'))
    dirs.push(dir)

    const { provider, sm } = await makeFixture(dir)
    const parentId = await createAndSend(sm, dir)
    sessionIds.push({ sm, id: parentId })
    await waitForPersistedTurn(provider, parentId)

    const child = await sm.createSideChat(parentId)
    sessionIds.push({ sm, id: child.id })
    expect(child.id).not.toBe(parentId)
    expect(await hasNativeSessionLog(dir, child.id)).toBe(true)

    // UI-facing page: the inherited prefix is reference-only model context.
    const page = await sm.getHistoryPage(child.id, { limit: 10 })
    expect(pageText(page)).not.toContain(PROMPT)
    expect(pageText(page)).not.toContain(REPLY)

    // The child's own native log still carries the inherited conversation.
    const entries = await provider.readHistoryEntries(child.id, {})
    expect(JSON.stringify(entries)).toContain(PROMPT)
    expect(JSON.stringify(entries)).toContain(REPLY)
  }, 20000)

  it('delete with deleteTranscript removes the native log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-delete-'))
    dirs.push(dir)

    const { provider, sm } = await makeFixture(dir)
    const id = await createAndSend(sm, dir)
    await waitForPersistedTurn(provider, id)
    expect(await hasNativeSessionLog(dir, id)).toBe(true)

    await sm.delete(id, { deleteTranscript: true })
    expect(await hasNativeSessionLog(dir, id)).toBe(false)
  }, 20000)

  it('clear spawns a fresh id with its own log and leaves the source log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-clear-'))
    dirs.push(dir)

    const { provider, sm } = await makeFixture(dir)
    const sourceId = await createAndSend(sm, dir)
    await waitForPersistedTurn(provider, sourceId)

    const cleared = await sm.clear(sourceId)
    sessionIds.push({ sm, id: cleared.id })
    expect(cleared.id).not.toBe(sourceId)
    expect(await hasNativeSessionLog(dir, cleared.id)).toBe(true)
    expect(await hasNativeSessionLog(dir, sourceId)).toBe(true)
  }, 20000)
})