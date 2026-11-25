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
import { summarizeForCompact } from '../../compact-summary.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'
import { nativeCoreOf } from '../native-host-frame-adapter.js'
import type { ProviderSessionHandle } from '../types.js'
import { hasNativeSessionLog, loadNativeSessionLogSync } from './session-log/log.js'
import { projectNeutralEventToLegacy } from './session-log/format.js'
import type { NativeLogEvent } from './session-log/format.js'
import type { NativeSessionEvent } from './vocabulary/session-event.js'
import type { CanonicalEvent } from './canonical.js'

// T6 read-side shrink: a v3 log exposes no live legacy read view. Reconstruct
// the legacy shape from the canonical neutral baseline via the pinned compat
// projection (a v1/v2 log keeps its canonical list); a null snapshot → [].
function legacyEventsOf(snapshot: { header: { id: string }; events: NativeLogEvent[]; neutralEvents?: NativeSessionEvent[] } | null | undefined): NativeLogEvent[] {
  if (!snapshot) return []
  return snapshot.neutralEvents
    ? snapshot.neutralEvents.map((event) => projectNeutralEventToLegacy(event, snapshot.header.id))
    : snapshot.events
}

// Auto-compact (P1.1 Task 4) summarizes through the shared LLM helper. The
// manager imports `./compact-summary.js`, which resolves to this same module —
// stub it so the test never calls a real endpoint.
vi.mock('../../compact-summary.js', () => ({
  summarizeForCompact: vi.fn(async () => 'MOCK SUMMARY'),
}))

const PROMPT = 'persisted-prompt-marker'
const REPLY = 'persisted-reply-marker'
const CHILD_PROMPT = 'child-prompt-marker'
const CHILD_REPLY = 'child-reply-marker'

/** A text turn with a scriptable prompt-token level: the auto-compact trigger
 *  compares provider-reported usage against the pin-derived threshold, so a
 *  forced-compaction test scripts the crossing turn's `input_tokens`. */
function highUsageTurn(text: string, inputTokens: number): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: inputTokens, output_tokens: 1 } },
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
  store: SessionStore
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

function armStream(provider: NativeProvider, text: string, inputTokens = 10): void {
  provider._testStream = async function* () {
    for (const ev of highUsageTurn(text, inputTokens)) yield ev
  }
}

async function makeFixture(dir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir: dir })
  await store.load()
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  armStream(provider, REPLY)
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { provider, sm, store }
}

/** Create a native session, run one scripted turn, and wait for the result. */
async function createAndSend(sm: SessionManager, cwd: string): Promise<string> {
  const info = await sm.create({ cwd, model: 'test-model', provider: 'native', title: 'e2e' })
  await sendTurn(sm, info.id)
  return info.id
}

async function sendTurn(sm: SessionManager, id: string, text = PROMPT): Promise<void> {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const f of sub.iterable) frames.push(f as Frame)
  })()
  try {
    await sm.send(id, text)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    }, { timeout: 5000 })
  } finally {
    sub.unsubscribe()
  }
}

/** Wait until the assistant reply is readable from the native log on disk —
 *  the durable half of the turn, not just the live frame. */
async function waitForPersistedTurn(
  provider: NativeProvider,
  id: string,
  marker = REPLY,
): Promise<void> {
  await vi.waitFor(async () => {
    const page = await provider.readHistoryPage(id, { limit: 20 })
    expect(JSON.stringify(page.messages)).toContain(marker)
  }, { timeout: 5000 })
}

function pageText(page: { messages: unknown[] }): string {
  return JSON.stringify(page.messages)
}

/** Wait until a durable `session/title` event with the given text is readable
 *  from the native log. The rename mirror is fire-and-forget (trackTitleWrite),
 *  so a test that forks/deletes right after a rename must gate on the durable
 *  event, not just the resolved rename() call. Reads the canonical neutral
 *  baseline directly: `session/title` is v3-only and has NO legacy projection
 *  (projectNeutralEventToLegacy throws on it), so legacyEventsOf cannot be used
 *  on a log that carries a title. */
async function waitForTitleEvent(dir: string, id: string, title: string): Promise<void> {
  await vi.waitFor(() => {
    const log = loadNativeSessionLogSync(dir, id)
    expect(log?.neutralEvents?.some((e) => e.type === 'session/title' && e.data.title === title)).toBe(true)
  }, { timeout: 5000 })
}

/** The durable `session/title` texts in file order (latest-wins folds the last). */
function titleEventsOf(dir: string, id: string): string[] {
  const log = loadNativeSessionLogSync(dir, id)
  return (log?.neutralEvents ?? []).flatMap((e) => (e.type === 'session/title' ? [e.data.title] : []))
}

/** Narrow read of the manager's live session map (private by design). */
function liveSession(sm: SessionManager, id: string): { history: Array<Record<string, unknown>> } {
  return (sm as unknown as { sessions: Map<string, { history: Array<Record<string, unknown>> }> })
    .sessions.get(id)!
}

function hasCompactBoundary(history: Array<Record<string, unknown>>): boolean {
  return history.some((m) => m.subtype === 'compact_boundary')
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

    // The dormant readers above only prove the disk log parses. The resumed
    // live handle's model history is what the next turn actually sends — it
    // must have been rebuilt from the persisted events by `historyFromEvents`.
    const live = (second.sm as unknown as {
      sessions: Map<string, { handle: { history: unknown[] } }>
    }).sessions.get(id)
    expect(live).toBeDefined()
    const modelHistory = JSON.stringify((nativeCoreOf(live!.handle as unknown as ProviderSessionHandle) as unknown as { history: unknown[] }).history)
    expect(modelHistory).toContain(PROMPT)
    expect(modelHistory).toContain(REPLY)
  }, 20000)

  it('pairs native prompt uuids at consumption so the list stays bounded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-uuids-'))
    dirs.push(dir)

    const { sm } = await makeFixture(dir)
    const id = await createAndSend(sm, dir)
    sessionIds.push({ sm, id })
    // A second turn (idle direct hand-off) exercises the same pairing path.
    await sendTurn(sm, id)

    const live = (sm as unknown as {
      sessions: Map<string, {
        promptUuids?: Array<{ u: string; v?: string }>
        turnActive?: boolean
      }>
    }).sessions.get(id)!
    // The native provider never emits a top-level user echo, so without
    // pairing-at-consumption every sent prompt would remain unpaired forever
    // and the array would grow without bound.
    expect(live.promptUuids).toHaveLength(2)
    expect(live.promptUuids!.every((e) => e.v != null)).toBe(true)
    // The result cleared the turn-active flag (it was set at consumption).
    expect(live.turnActive).toBe(false)
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
    // A page read before the child's first turn is empty, so the exclusion
    // assertions below would be vacuous. Run one child turn first — then the
    // page has positive content of its own to prove the boundary filters the
    // parent prefix rather than everything.
    armStream(provider, CHILD_REPLY)
    await sendTurn(sm, child.id, CHILD_PROMPT)
    // sendTurn only waits for the `result` frame; the assistant frame is
    // flushed fire-and-forget and the awaited turn/end flush lands after
    // runTurn emits it. Gate on the durable child turn before reading.
    await waitForPersistedTurn(provider, child.id, CHILD_REPLY)

    const page = await sm.getHistoryPage(child.id, { limit: 10 })
    expect(pageText(page)).toContain(CHILD_PROMPT)
    expect(pageText(page)).toContain(CHILD_REPLY)
    expect(pageText(page)).not.toContain(PROMPT)
    expect(pageText(page)).not.toContain(REPLY)

    // The child's own native log still carries the inherited conversation.
    const entries = await provider.readHistoryEntries(child.id, {})
    expect(JSON.stringify(entries)).toContain(PROMPT)
    expect(JSON.stringify(entries)).toContain(REPLY)
    expect(JSON.stringify(entries)).toContain(CHILD_REPLY)
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

    // Fresh conversation, not a copy: the cleared session's page has none of
    // the source's turn. clear() removes the SOURCE from the store
    // (removeFromStore) while keeping its native log, so the source side is
    // read through the provider's page reader directly.
    const clearedPage = await sm.getHistoryPage(cleared.id, { limit: 10 })
    expect(pageText(clearedPage)).not.toContain(PROMPT)
    expect(pageText(clearedPage)).not.toContain(REPLY)

    const sourcePage = await provider.readHistoryPage(sourceId, { limit: 10 })
    expect(pageText(sourcePage)).toContain(PROMPT)
    expect(pageText(sourcePage)).toContain(REPLY)
  }, 20000)

  it('auto-compacts an idle native session above the window and resets the transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-autocompact-'))
    dirs.push(dir)
    vi.mocked(summarizeForCompact).mockClear()

    const { sm } = await makeFixture(dir)
    const info = await sm.create({
      cwd: dir,
      model: 'test-model',
      provider: 'native',
      title: 'auto-compact',
      // `autoCompactWindow` rides Options.settings (the only spawn channel).
      // The provider derives the threshold from the pinned effective window:
      // min(floor(0.8 × 16385), 16385 − 16384) = 1 — the output-reserve arm
      // binds, so any post-turn usage ≥ 1 crosses it deterministically.
      settings: { autoCompactWindow: 16385 },
    } as unknown as Parameters<typeof sm.create>[0])
    sessionIds.push({ sm, id: info.id })
    await sendTurn(sm, info.id)

    // The trigger is fire-and-forget behind setImmediate + an async summary,
    // so wait for the ring divider rather than a fixed tick.
    await vi.waitFor(() => {
      expect(hasCompactBoundary(liveSession(sm, info.id).history)).toBe(true)
    }, { timeout: 5000 })

    expect(vi.mocked(summarizeForCompact)).toHaveBeenCalledTimes(1)
    // Fresh seq space (boundary + summary) under the NEXT generation: the
    // store was created at 0 and the reset must CONTINUE the counter (clients
    // arm a `generation + 1` floor on `session-cleared`), not restart it.
    expect(sm.transcriptHead(info.id)).toEqual({ generation: 1, headSeq: 2 })
    const s = liveSession(sm, info.id)
    expect(JSON.stringify(s.history)).toContain('MOCK SUMMARY')
    // The pre-compact turn is gone from the ring and from the disk page.
    expect(JSON.stringify(s.history)).not.toContain(PROMPT)
    expect(JSON.stringify(s.history)).not.toContain(REPLY)

    const log = loadNativeSessionLogSync(dir, info.id)!
    expect(legacyEventsOf(log).some((e) => e.type === 'session/compact')).toBe(true)
    const page = await sm.getHistoryPage(info.id, { limit: 10 })
    expect(JSON.stringify(page)).not.toContain(PROMPT)

    // An idle re-check (the same call the trigger makes) must not compact a
    // second time without a new turn.
    await (sm as unknown as { maybeAutoCompact(x: unknown): Promise<void> })
      .maybeAutoCompact(s as unknown)
    expect(vi.mocked(summarizeForCompact)).toHaveBeenCalledTimes(1)
    expect(s.history.filter((m) => m.subtype === 'compact_boundary')).toHaveLength(1)
  }, 20000)

  it('restart + resume rebuilds the conversation from the compact summary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-autocompact-resume-'))
    dirs.push(dir)

    const first = await makeFixture(dir)
    const info = await first.sm.create({
      cwd: dir,
      model: 'test-model',
      provider: 'native',
      title: 'auto-compact-resume',
      // Same spawn channel as the test above. The pin derives threshold
      // min(floor(0.8 × 66384), 66384 − 16384) = 50000: the first turn is
      // scripted at usage 100000 to cross it, while the resumed post-compact
      // turn (usage 10) stays below — no re-compaction floors the reply this
      // test asserts. The pin persists in SessionMeta and re-applies on resume.
      settings: { autoCompactWindow: 66384 },
    } as unknown as Parameters<typeof first.sm.create>[0])
    armStream(first.provider, REPLY, 100_000)
    await sendTurn(first.sm, info.id)
    // The pre-compact turn must be durable in the append-only log. The floored
    // page reader below can no longer see it once `session/compact` lands, so
    // gate on the raw events (which survive compaction) instead.
    await vi.waitFor(() => {
      const log = loadNativeSessionLogSync(dir, info.id)!
      expect(JSON.stringify(legacyEventsOf(log))).toContain(REPLY)
    }, { timeout: 5000 })

    await vi.waitFor(() => {
      expect(hasCompactBoundary(liveSession(first.sm, info.id).history)).toBe(true)
    }, { timeout: 5000 })

    // The durable surface is floored at the compact event: only the summary is
    // still readable, and search no longer reaches the pre-compact turn.
    const page = await first.provider.readHistoryPage(info.id, { limit: 20 })
    expect(pageText(page)).toContain('MOCK SUMMARY')
    expect(pageText(page)).not.toContain(PROMPT)
    expect(pageText(page)).not.toContain(REPLY)
    const hits = await first.sm.searchMessages(REPLY, { sessionId: info.id })
    expect(hits.length).toBe(0)

    await first.sm.shutdown()

    const second = await makeFixture(dir)
    armStream(second.provider, 'post-compact-reply')
    const resumed = await second.sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    sessionIds.push({ sm: second.sm, id: info.id })

    const resumedPage = await second.sm.getHistoryPage(info.id, { limit: 10 })
    expect(pageText(resumedPage)).toContain('MOCK SUMMARY')
    expect(pageText(resumedPage)).not.toContain(PROMPT)
    expect(pageText(resumedPage)).not.toContain(REPLY)

    // The resumed live handle's model history is what the next turn actually
    // sends. `historyFromEvents` must have restarted it at the last
    // `session/compact` event (context + summary), not replayed the old turn.
    const live = (second.sm as unknown as {
      sessions: Map<string, { handle: { history: unknown[] } }>
    }).sessions.get(info.id)
    expect(live).toBeDefined()
    const modelHistory = JSON.stringify((nativeCoreOf(live!.handle as unknown as ProviderSessionHandle) as unknown as { history: unknown[] }).history)
    expect(modelHistory).toContain('MOCK SUMMARY')
    expect(modelHistory).not.toContain(PROMPT)
    expect(modelHistory).not.toContain(REPLY)

    // A post-compact turn continues from that floor: its reply is readable and
    // the pre-compact content still never resurfaces.
    await sendTurn(second.sm, info.id, 'post-compact-prompt')
    await waitForPersistedTurn(second.provider, info.id, 'post-compact-reply')
    const afterPage = await second.sm.getHistoryPage(info.id, { limit: 10 })
    expect(pageText(afterPage)).toContain('post-compact-reply')
    expect(pageText(afterPage)).not.toContain(PROMPT)
    expect(pageText(afterPage)).not.toContain(REPLY)
  }, 30000)
})

// Acceptance proof for native resumable discovery (spec Acceptance 1–3, 2a, 6),
// driven through the REAL SessionManager paths the HTTP routes use:
// sm.listResumable / sm.rename / sm.autoGenerateTitle / sm.delete /
// sm.resume(id, { allowAdopt }). The provider methods (Tasks 2/3/5) are exercised
// end-to-end here, not stubbed — only the auxiliary LLM port is stubbed so the
// auto-title path never touches the network.
describe('native resumable discovery through SessionManager', () => {
  it('picker parity: a live native session lists known/running with the native provider badge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-picker-'))
    dirs.push(dir)

    const { provider, sm } = await makeFixture(dir)
    const id = await createAndSend(sm, dir)
    sessionIds.push({ sm, id })
    await waitForPersistedTurn(provider, id)

    const row = (await sm.listResumable()).find((s) => s.sessionId === id)
    expect(row).toBeDefined()
    // The row badges the native provider, not CLI (Acceptance 1; the unknown
    // known:false case is pinned by the rename-recovery test below).
    expect(row!.provider).toBe('native')
    expect(row!.known).toBe(true)
    expect(row!.running).toBe(true)
    expect(row!.terminated).toBe(false)
    // The app-known title annotates the row (createAndSend names it 'e2e').
    expect(row!.title).toBe('e2e')
    // Preview facts come from the listing scan, not the app metadata.
    expect(row!.firstPrompt).toBe(PROMPT)
    expect(row!.lastPrompt).toBe(PROMPT)

    // dir-scoped vs all-projects: the row's header.cwd is the session cwd.
    expect((await sm.listResumable({ dir })).some((s) => s.sessionId === id)).toBe(true)
    expect((await sm.listResumable({ dir: join(dir, 'elsewhere') })).some((s) => s.sessionId === id)).toBe(false)
  }, 20000)

  it('manual rename survives an ordinary delete and is recovered by allowAdopt resume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-rename-recover-'))
    dirs.push(dir)

    const { provider, sm, store } = await makeFixture(dir)
    const id = await createAndSend(sm, dir)
    sessionIds.push({ sm, id })
    await waitForPersistedTurn(provider, id)

    await sm.rename(id, 'Renamed')
    // The rename mirror is fire-and-forget; gate on the durable log event so
    // the delete below cannot race ahead of the title write (Acceptance 2).
    await waitForTitleEvent(dir, id, 'Renamed')

    // Ordinary delete removes the store entry but KEEPS the native log.
    await sm.delete(id)
    expect(store.get(id)).toBeUndefined()
    expect(await hasNativeSessionLog(dir, id)).toBe(true)

    // The picker row now comes purely from the listing scan: unknown, but
    // carrying the renamed title read from the log.
    const row = (await sm.listResumable()).find((s) => s.sessionId === id)
    expect(row).toBeDefined()
    expect(row!.known).toBe(false)
    expect(row!.running).toBe(false)
    expect(row!.provider).toBe('native')
    expect(row!.title).toBe('Renamed')

    // Explicit adoption recovers the session under the native provider with
    // the title restored into the store.
    const resumed = await sm.resume(id, { allowAdopt: true })
    expect(resumed.id).toBe(id)
    expect(resumed.running).toBe(true)
    expect(resumed.title).toBe('Renamed')
    expect(store.get(id)?.provider).toBe('native')
    expect(store.get(id)?.title).toBe('Renamed')
  }, 20000)

  it('auto-title survives an ordinary delete and is recovered by allowAdopt resume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-autotitle-recover-'))
    dirs.push(dir)

    const { provider, sm, store } = await makeFixture(dir)
    // UNTITLED create: autoGenerateTitle no-ops once a title is set, so the
    // recovery path must be driven from a session the user never named.
    const info = await sm.create({ cwd: dir, model: 'test-model', provider: 'native' })
    sessionIds.push({ sm, id: info.id })
    await sendTurn(sm, info.id)
    await waitForPersistedTurn(provider, info.id)
    expect(info.title).toBeUndefined()

    // Stub the auxiliary LLM port — makeNativePorts wires a REAL caller, and
    // the manager trims the resolved string. No network is touched.
    const aux = vi.spyOn(provider.ports.auxLlm, 'call').mockResolvedValue('Auto Title')
    try {
      const titled = await sm.autoGenerateTitle(info.id, 'describe the session')
      expect(titled.title).toBe('Auto Title')
      // generateTitle appends the durable title event BEFORE returning
      // (claude persist:true parity), so it is already on disk here.
      expect(titleEventsOf(dir, info.id)).toEqual(['Auto Title'])

      await sm.delete(info.id)
      expect(store.get(info.id)).toBeUndefined()

      const row = (await sm.listResumable()).find((s) => s.sessionId === info.id)
      expect(row).toBeDefined()
      expect(row!.known).toBe(false)
      expect(row!.title).toBe('Auto Title')

      const resumed = await sm.resume(info.id, { allowAdopt: true })
      expect(resumed.running).toBe(true)
      expect(resumed.title).toBe('Auto Title')
      expect(store.get(info.id)?.provider).toBe('native')
      expect(store.get(info.id)?.title).toBe('Auto Title')
    } finally {
      aux.mockRestore()
    }
  }, 20000)

  it('permanent delete removes the picker row and the native log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-perm-delete-'))
    dirs.push(dir)

    const { provider, sm } = await makeFixture(dir)
    const id = await createAndSend(sm, dir)
    await waitForPersistedTurn(provider, id)
    expect(await hasNativeSessionLog(dir, id)).toBe(true)

    await sm.delete(id, { deleteTranscript: true })
    expect(await hasNativeSessionLog(dir, id)).toBe(false)
    expect((await sm.listResumable()).some((s) => s.sessionId === id)).toBe(false)
  }, 20000)

  it('a deleted native log is adoptable only with explicit allowAdopt (automatic-path guard)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-adopt-guard-'))
    dirs.push(dir)

    const { provider, sm, store } = await makeFixture(dir)
    const id = await createAndSend(sm, dir)
    sessionIds.push({ sm, id })
    await waitForPersistedTurn(provider, id)

    // Ordinary delete IS the store-entry-loss path (Acceptance 3): the log
    // survives, the index entry is gone.
    await sm.delete(id)
    expect(store.get(id)).toBeUndefined()
    expect(await hasNativeSessionLog(dir, id)).toBe(true)

    // An automatic resume (WS subscribe auto-resume) must NOT resurrect the
    // deleted session from its surviving log.
    await expect(sm.resume(id)).rejects.toMatchObject({ status: 404 })
    expect(store.get(id)).toBeUndefined()

    // Explicit picker adoption recovers it under the native provider.
    const resumed = await sm.resume(id, { allowAdopt: true })
    expect(resumed.id).toBe(id)
    expect(resumed.running).toBe(true)
    expect(store.get(id)?.provider).toBe('native')
  }, 20000)

  it('fork inherits the seed title, fork rename is latest-wins, clear leaves the source title', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-fork-clear-title-'))
    dirs.push(dir)

    const { provider, sm } = await makeFixture(dir)
    const sourceId = await createAndSend(sm, dir)
    sessionIds.push({ sm, id: sourceId })
    await waitForPersistedTurn(provider, sourceId)

    await sm.rename(sourceId, 'Source Title')
    await waitForTitleEvent(dir, sourceId, 'Source Title')

    // Fork: the child's log seed copies the source's session/title event.
    const child = await sm.fork(sourceId)
    sessionIds.push({ sm, id: child.id })
    expect(child.id).not.toBe(sourceId)
    expect(titleEventsOf(dir, child.id)).toContain('Source Title')

    // Rename the fork: a LATER title event appends; latest-wins folds to it.
    await sm.rename(child.id, 'Fork Title')
    await waitForTitleEvent(dir, child.id, 'Fork Title')
    expect(titleEventsOf(dir, child.id)).toEqual(['Source Title', 'Fork Title'])
    // Read the RAW provider row (no manager live/meta annotation) so the
    // assertion isolates the scan's latest-wins, not the app-known title.
    const forkRow = (await provider.listResumable()).find((s) => s.sessionId === child.id)
    expect(forkRow?.title).toBe('Fork Title')

    // Clear: a fresh id with NO title event; the source log keeps its title.
    const cleared = await sm.clear(sourceId)
    sessionIds.push({ sm, id: cleared.id })
    expect(cleared.id).not.toBe(sourceId)
    expect(cleared.title).toBeUndefined()
    expect(titleEventsOf(dir, cleared.id)).toEqual([])
    expect(titleEventsOf(dir, sourceId)).toContain('Source Title')
  }, 20000)
})
