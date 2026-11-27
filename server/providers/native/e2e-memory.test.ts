// Full-chain auto-memory e2e: learn → remember → recall, claude read-compat +
// write isolation, per-cwd dream consolidation + failure posture, restart
// survival, and override rejection — all through the REAL SessionManager,
// permission broker, host auto-memory port and Write/Read tools. Only the
// network edge is mocked: the Anthropic stream (`_testStream` scripted canonical
// rounds) and the aux LLM port (recall selector / session title).
//
// Harness shape follows e2e.test.ts / e2e-read-file.test.ts (temp-dir SessionStore
// + custom ProviderRegistry + scripted stream). The claude config dir is a temp
// fixture exported through CLAUDE_CONFIG_DIR so the broker's lexical root
// resolution and the port's realpath guard agree on the same compat root.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setConfigForTest, config } from '../../config.js'
import { HttpError } from '../../errors.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'
import { createAutoMemoryPort, claudeProjectSlug } from '../native-host-auto-memory.js'
import { nativeCoreOf } from '../native-host-frame-adapter.js'
import { nativeSessionLogPath } from './session-log/paths.js'
import { neutralEventsOf } from './session-log/neutral-read.js'
import type { NativeAuxLlmPort } from './ports.js'
import type { CanonicalEvent } from './canonical.js'
import type { ProviderSessionHandle } from '../types.js'

const TEST_PROFILE = {
  id: 'memory-e2e',
  name: 'Memory E2E',
  authToken: 'test-token',
  baseUrl: 'https://api.example.test',
  modelList: ['test-model'],
  recapModel: '',
  commitMessageModel: '',
}

type Frame = Record<string, any>
type CreateOptions = Parameters<SessionManager['create']>[0]
type Core = {
  history: Array<{ role: string; content: unknown }>
  log: { neutralEvents?: unknown[] | null; events: unknown[] }
}

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function toolTurn(id: string, name: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** Recursive file-content snapshot of a directory (POSIX-relative keys). The
 *  write-isolation assertion compares two of these for deep equality. */
async function dirSnapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(cur: string, rel: string): Promise<void> {
    let entries
    try { entries = await readdir(cur, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(cur, entry.name)
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(full, r)
      else out[r] = await readFile(full, 'utf8')
    }
  }
  await walk(dir, '')
  return out
}

interface Fixture {
  sm: SessionManager
  provider: NativeProvider
  project: string
  stateDir: string
  configDir: string
  ownDir: string
  claudeDir: string
  scripts: CanonicalEvent[][]
  dreamScripts: CanonicalEvent[][]
  dreamFailures: number
  recallSelection: string[]
  requests: Array<{ system: string; messages: Array<{ role: string; content: unknown }> }>
}

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []
let previousConfigDir: string | undefined
const originalConfig = { ...config }

beforeEach(() => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  __setConfigForTest({
    profiles: [TEST_PROFILE],
    activeProfileId: TEST_PROFILE.id,
    authToken: TEST_PROFILE.authToken,
    baseUrl: TEST_PROFILE.baseUrl,
  })
})

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already gone */ }
  }
  sessionIds.length = 0
  for (const sm of managers.splice(0)) await sm.shutdown()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  __setConfigForTest(originalConfig)
  await new Promise((r) => setTimeout(r, 80)) // let in-flight sidecar writes land before rmdir
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor probe
  // still holding a temp dir as its cwd (the e2e.test.ts teardown precedent).
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'sm-native-memory-e2e-'))
  dirs.push(root)
  const project = join(root, 'project')
  const stateDir = join(root, 'state')
  const configDir = join(root, 'claude-config')
  await mkdir(project, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await mkdir(configDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = configDir

  const ownDir = join(stateDir, 'native-memory', claudeProjectSlug(project))
  const claudeDir = join(configDir, 'projects', claudeProjectSlug(project), 'memory')

  // REAL host port (fs, slug, resolve guard, enumeration, bounded reads, dream
  // state + lease + touched scan). configDir seam matches the exported env.
  const autoMemory = createAutoMemoryPort({ stateDir, configDir })
  const fx: Fixture = {
    sm: null as unknown as SessionManager,
    provider: null as unknown as NativeProvider,
    project, stateDir, configDir, ownDir, claudeDir,
    scripts: [], dreamScripts: [], dreamFailures: 0, recallSelection: [],
    requests: [],
  }
  // Only the network edge is mocked. The recall selector returns the test's
  // chosen filenames; session-title returns a plain title; anything else is a
  // loud failure (no other aux caller runs in this harness).
  const auxLlm: NativeAuxLlmPort = {
    call: async (req) => {
      if (req.caller === 'memory_recall_select') {
        return JSON.stringify({ selected_memories: fx.recallSelection })
      }
      if (req.caller === 'session-title') return 'Memory E2E Title'
      throw new Error(`unexpected aux caller in memory e2e: ${req.caller}`)
    },
  }
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir, ports: { ...makeNativePorts({ stateDir, autoMemory }), auxLlm } })
  provider._testStream = async function* (req: { system: string; messages: unknown[] }) {
    fx.requests.push({ system: req.system, messages: structuredClone(req.messages) as Array<{ role: string; content: unknown }> })
    // Dream rounds are the nested consolidation run: their first message is the
    // DREAM_PROMPT (the main system never carries that phrase).
    if (JSON.stringify(req.messages).includes('memory consolidation agent')) {
      if (fx.dreamFailures > 0) {
        fx.dreamFailures--
        throw new Error('injected dream stream failure')
      }
      const script = fx.dreamScripts.shift()
      if (!script) throw new Error('unexpected dream round: no scripted dream turn queued')
      for (const ev of script) yield ev
      return
    }
    const script = fx.scripts.shift()
    if (!script) throw new Error('unexpected main round: no scripted turn queued')
    for (const ev of script) yield ev
  } as unknown as NativeProvider['_testStream']
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  fx.sm = sm
  fx.provider = provider
  return fx
}

async function createSession(
  fx: Fixture,
  extra: Partial<CreateOptions> & { memory?: { autoMemoryEnabled?: boolean; autoMemoryDirectory?: string; autoDreamEnabled?: boolean } } = {},
): Promise<string> {
  const info = await fx.sm.create({
    cwd: fx.project,
    model: 'test-model',
    provider: 'native',
    title: 'memory-e2e',
    // No canUseTool → the REAL PermissionBroker is installed (the memory-root
    // exemption is what allows ownDir writes without a prompt). Suggestions off
    // so a fork never consumes a scripted round. `memory` is the app-level create
    // intent (coerced by the manager), not an SDK Options key — hence the cast.
    promptSuggestions: false,
    ...extra,
  } as CreateOptions)
  sessionIds.push({ sm: fx.sm, id: info.id })
  return info.id
}

function channel(sm: SessionManager, id: string): { frames: Frame[]; unsubscribe: () => void } {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => { for await (const f of sub.iterable) frames.push(f as Frame) })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

async function sendTurn(fx: Fixture, id: string, frames: Frame[], text = 'run the scripted turn'): Promise<Frame[]> {
  const resultCount = frames.filter((f) => f.type === 'result').length
  const start = frames.length
  await fx.sm.send(id, text)
  await vi.waitFor(() => {
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(resultCount + 1)
  }, { timeout: 8000 })
  return frames.slice(start)
}

function coreOf(sm: SessionManager, id: string): Core {
  const handle = (sm as unknown as { sessions: Map<string, { handle: ProviderSessionHandle }> }).sessions.get(id)!.handle
  return nativeCoreOf(handle) as unknown as Core
}

function supplementTexts(core: Core): string[] {
  return neutralEventsOf(core.log as Parameters<typeof neutralEventsOf>[0])
    .filter((e) => e.type === 'session/supplement')
    .map((e) => (e as { data: { text: string } }).data.text)
}

function historyHasRecall(core: Core): boolean {
  return JSON.stringify(core.history).includes('[RECALLED MEMORY]')
}

function toolResult(frames: Frame[], toolUseId: string): Frame | undefined {
  for (const frame of frames) {
    if (frame.type !== 'user' || !Array.isArray(frame.message?.content)) continue
    const block = frame.message.content.find((c: Frame) => c.type === 'tool_result' && c.tool_use_id === toolUseId)
    if (block) return block
  }
  return undefined
}

async function sidecarRecallRow(stateDir: string, id: string): Promise<Frame> {
  const path = join(stateDir, 'transcripts', `${id}.ndjson`)
  let row: Frame | undefined
  await vi.waitFor(async () => {
    const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Frame)
    row = rows.find((r) => r.type === 'system' && r.subtype === 'memory_recall')
    expect(row).toBeDefined()
  })
  return row!
}

const FACT_BODY = 'The user prefers tabs over spaces for indentation.'
const factContent = `---\nname: indent-preference\ndescription: user indentation preference\nmetadata:\n  type: user\n---\n\n${FACT_BODY}\n`

describe('native auto-memory full chain', () => {
  it('learn → remember → recall: real Write stores a memory, a fresh session recalls it (supplement + card + replay)', async () => {
    const fx = await makeFixture()
    // Default dream thresholds (24h / 5) → no dream fires in this two-session
    // chain; the test isolates the learn/recall path.

    // Session A learns: the model writes a topic file + the MEMORY.md index via
    // the REAL Write tool. The broker's memory-root exemption auto-allows both
    // (default mode, no canUseTool) — no permission prompt parks.
    const a = await createSession(fx)
    const ca = channel(fx.sm, a)
    fx.scripts.push(
      toolTurn('write-fact', 'Write', { file_path: join(fx.ownDir, 'fact.md'), content: factContent }),
      toolTurn('write-index', 'Write', { file_path: join(fx.ownDir, 'MEMORY.md'), content: '- [Indent preference](fact.md) — user prefers tabs\n' }),
      textTurn('saved the preference'),
    )
    const aFrames = await sendTurn(fx, a, ca.frames, 'remember my indentation preference')
    expect(toolResult(aFrames, 'write-fact')?.is_error).not.toBe(true)
    expect(toolResult(aFrames, 'write-index')?.is_error).not.toBe(true)
    expect(fx.sm.listPending(a)).toEqual([]) // exemption allowed both writes silently
    expect(await readFile(join(fx.ownDir, 'fact.md'), 'utf8')).toBe(factContent)
    expect(await readFile(join(fx.ownDir, 'MEMORY.md'), 'utf8')).toContain('fact.md')
    ca.unsubscribe()

    // Session B (same cwd, fresh) recalls: the aux selector picks fact.md.
    fx.recallSelection = ['fact.md']
    const b = await createSession(fx)
    const cb = channel(fx.sm, b)
    fx.scripts.push(textTurn('using your remembered preference'))
    const bFrames = await sendTurn(fx, b, cb.frames, 'how should I indent?')

    // Live card rode the broadcast channel (memory_recall ∈ allowlist).
    const recall = bFrames.find((f) => f.type === 'system' && f.subtype === 'memory_recall')
    expect(recall).toBeDefined()
    expect(recall!.mode).toBe('select')
    expect(recall!.memories).toEqual([{ path: join(fx.ownDir, 'fact.md'), scope: 'personal' }])
    expect(recall!.uuid).toEqual(expect.any(String))

    // Model-visible track: a session/supplement event carries the WRAPPED recall
    // text, and the live model history contains it.
    const supplements = supplementTexts(coreOf(fx.sm, b))
    expect(supplements.some((t) => t.startsWith('[RECALLED MEMORY]') && t.includes('## fact.md') && t.includes(FACT_BODY))).toBe(true)
    expect(historyHasRecall(coreOf(fx.sm, b))).toBe(true)
    // Injected BEFORE the first model round: the round's request already carries it.
    expect(JSON.stringify(fx.requests.at(-1)!.messages)).toContain('[RECALLED MEMORY]')

    // Durable card track: the seq sidecar carries an app-only memory_recall row
    // sharing the live frame's uuid.
    const row = await sidecarRecallRow(fx.stateDir, b)
    expect(row.msg.memories).toEqual([{ path: join(fx.ownDir, 'fact.md'), scope: 'personal' }])
    expect(row.msg.uuid).toBe(recall!.uuid)
    cb.unsubscribe()

    // Replay: sleep + resume rebuilds the model history from the disk log; the
    // supplement replays into it (historyFromEvents), so the recall text survives.
    await fx.sm.sleep(b)
    const resumed = await fx.sm.resume(b)
    expect(resumed.id).toBe(b)
    expect(historyHasRecall(coreOf(fx.sm, b))).toBe(true)
  }, 30000)

  it('claude compat: recalls a claude-store memory read-only; no write ever lands in the claude dir (turn + dream)', async () => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeDreamAfterMs: 0, nativeDreamSessionCount: 1 })
    // Fixture claude compat store with a valid frontmatter memory.
    await mkdir(fx.claudeDir, { recursive: true })
    const claudeBody = 'Always run the full test suite before committing.'
    await writeFile(join(fx.claudeDir, 'claude-fact.md'), `---\ndescription: commit discipline\n---\n\n${claudeBody}\n`, 'utf8')
    const before = await dirSnapshot(fx.claudeDir)

    // Session A learns into the OWN dir (proves own writes work alongside the
    // compat root). A's dream is gated off so its fire-and-forget turn-end
    // trigger cannot race B's creation and consolidate early; only B dreams.
    const a = await createSession(fx, { memory: { autoDreamEnabled: false } })
    const ca = channel(fx.sm, a)
    fx.scripts.push(
      toolTurn('write-own', 'Write', { file_path: join(fx.ownDir, 'own-fact.md'), content: '---\ndescription: own fact\n---\n\nOWN BODY\n' }),
      textTurn('saved own fact'),
    )
    await sendTurn(fx, a, ca.frames, 'remember an own fact')
    ca.unsubscribe()

    // Session B recalls the CLAUDE file (cross-root enumeration). Its turn also
    // attempts a Write INTO the claude dir — the broker never exempts that, so it
    // parks; we deny it and the file must not appear.
    fx.recallSelection = ['claude-fact.md']
    const b = await createSession(fx)
    const cb = channel(fx.sm, b)
    fx.scripts.push(
      toolTurn('write-claude', 'Write', { file_path: join(fx.claudeDir, 'evil.md'), content: 'should never land' }),
      textTurn('done'),
    )
    // B's turn-end fires a dream (touched = [A]); it consolidates the OWN dir.
    // Queued BEFORE the send: the dream is fire-and-forget at turn-end, so its
    // script must be ready when the nested round arrives.
    fx.dreamScripts.push(
      toolTurn('dream-write', 'Write', { file_path: join(fx.ownDir, 'consolidated.md'), content: '---\ndescription: consolidated\n---\n\nCONSOLIDATED\n' }),
      textTurn('consolidated'),
    )
    const resultCount = cb.frames.filter((f) => f.type === 'result').length
    await fx.sm.send(b, 'recall the claude memory then try to write it')
    // The claude-dir Write parks on a real permission prompt (no exemption).
    await vi.waitFor(() => expect(fx.sm.listPending(b)).toHaveLength(1))
    const pending = fx.sm.listPending(b)[0]
    await fx.sm.decide(b, pending.id, { behavior: 'deny' })
    await vi.waitFor(() => {
      expect(cb.frames.filter((f) => f.type === 'result')).toHaveLength(resultCount + 1)
    }, { timeout: 8000 })
    const bFrames = cb.frames
    expect(toolResult(bFrames, 'write-claude')?.is_error).toBe(true)

    // The recall card points at the CLAUDE dir (read compat), not the own dir.
    const recall = bFrames.find((f) => f.type === 'system' && f.subtype === 'memory_recall')
    expect(recall).toBeDefined()
    expect(recall!.memories).toEqual([{ path: join(fx.claudeDir, 'claude-fact.md'), scope: 'personal' }])
    expect(supplementTexts(coreOf(fx.sm, b)).some((t) => t.includes(claudeBody))).toBe(true)

    await vi.waitFor(async () => {
      expect(await readFile(join(fx.ownDir, 'consolidated.md'), 'utf8')).toContain('CONSOLIDATED')
    }, { timeout: 8000 })
    cb.unsubscribe()

    // WRITE ISOLATION: the claude compat dir is byte-for-byte unchanged after a
    // full recall turn, a denied claude-dir write, and a dream consolidation.
    expect(await dirSnapshot(fx.claudeDir)).toEqual(before)
  }, 30000)

  it('dream: low thresholds fire a per-cwd consolidation that reads session logs and writes only the own dir', async () => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeDreamAfterMs: 0, nativeDreamSessionCount: 1 })
    await mkdir(fx.claudeDir, { recursive: true })
    await writeFile(join(fx.claudeDir, 'claude-fact.md'), '---\ndescription: c\n---\n\nC\n', 'utf8')
    const before = await dirSnapshot(fx.claudeDir)

    // A is the touched consolidation source; its dream is gated off so its
    // fire-and-forget turn-end trigger cannot race B's creation. Only B dreams.
    const a = await createSession(fx, { memory: { autoDreamEnabled: false } })
    const ca = channel(fx.sm, a)
    fx.scripts.push(textTurn('first session'))
    await sendTurn(fx, a, ca.frames, 'hello from a')
    ca.unsubscribe()

    const b = await createSession(fx)
    const cb = channel(fx.sm, b)
    fx.scripts.push(textTurn('second session'))
    // The dream reads A's session log (read root = native-sessions tree) and
    // writes a consolidated memory into the OWN dir (write root + broker exemption).
    fx.dreamScripts.push(
      toolTurn('dream-read', 'Read', { file_path: nativeSessionLogPath(fx.stateDir, a) }),
      toolTurn('dream-write', 'Write', { file_path: join(fx.ownDir, 'consolidated.md'), content: '---\ndescription: consolidated\n---\n\nCONSOLIDATED\n' }),
      textTurn('consolidated'),
    )
    await sendTurn(fx, b, cb.frames, 'hello from b')

    // The dream fired: a dream- descriptor is durable in B's log, the consolidated
    // file landed in the own dir, and the per-cwd completion timestamp persisted.
    await vi.waitFor(async () => {
      expect(await readFile(join(fx.ownDir, 'consolidated.md'), 'utf8')).toContain('CONSOLIDATED')
    }, { timeout: 8000 })
    const descriptors = neutralEventsOf(coreOf(fx.sm, b).log as Parameters<typeof neutralEventsOf>[0])
      .filter((e) => e.type === 'subagent/descriptor' && (e as { data: { toolUseId: string } }).data.toolUseId.startsWith('dream-'))
    expect(descriptors).toHaveLength(1)
    const dreamState = JSON.parse(await readFile(join(fx.stateDir, 'native-memory', 'dream-state.json'), 'utf8'))
    expect(dreamState[fx.project]?.lastDreamAt).toEqual(expect.any(Number))
    // The dream's Read of the session log succeeded (read root wired).
    expect(toolResult(cb.frames, 'dream-read')?.is_error).not.toBe(true)
    cb.unsubscribe()

    expect(await dirSnapshot(fx.claudeDir)).toEqual(before)
  }, 30000)

  it('dream failure releases the per-cwd lease: the next trigger window retries without surfacing an error', async () => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeDreamAfterMs: 0, nativeDreamSessionCount: 1 })

    // A is the touched source; its dream is gated off so its fire-and-forget
    // turn-end trigger cannot race B's creation. Only B dreams (fail, then retry).
    const a = await createSession(fx, { memory: { autoDreamEnabled: false } })
    const ca = channel(fx.sm, a)
    // The first dream attempt fails mid-flight; a later attempt succeeds. The
    // retry needs a session touched SINCE the failed dream stamped lastDreamAt
    // (the scan counts only fresh activity), so A runs a second turn before B's
    // retry turn — A's refreshed log mtime then meets the count gate. Sessions
    // are created sequentially so each turn-end sees exactly the intended
    // touched set (creating both up front would fire A's turn-end dream early).
    fx.dreamFailures = 1
    fx.dreamScripts.push(
      toolTurn('dream-write', 'Write', { file_path: join(fx.ownDir, 'consolidated.md'), content: 'CONSOLIDATED\n' }),
      textTurn('consolidated'),
    )
    fx.scripts.push(textTurn('a one'), textTurn('b one'), textTurn('a two'), textTurn('b two'))

    await sendTurn(fx, a, ca.frames, 'a first turn')
    const b = await createSession(fx)
    const cb = channel(fx.sm, b)
    const turn1 = await sendTurn(fx, b, cb.frames, 'b first turn')
    // The failed dream still released the lease and stamped completion.
    await vi.waitFor(async () => {
      const state = JSON.parse(await readFile(join(fx.stateDir, 'native-memory', 'dream-state.json'), 'utf8'))
      expect(state[fx.project]?.lastDreamAt).toEqual(expect.any(Number))
    }, { timeout: 8000 })
    // Nothing surfaced in the user turn.
    expect(turn1.filter((f) => f.type === 'result').every((f) => !f.is_error)).toBe(true)

    // Refresh A's log mtime past lastDreamAt, then B's turn-end retries: the
    // lease was freed, the count gate is met again, and the retry consolidates.
    await sendTurn(fx, a, ca.frames, 'a second turn')
    const turn2 = await sendTurn(fx, b, cb.frames, 'b second turn')
    await vi.waitFor(async () => {
      expect(await readFile(join(fx.ownDir, 'consolidated.md'), 'utf8')).toContain('CONSOLIDATED')
    }, { timeout: 8000 })
    expect(turn2.filter((f) => f.type === 'result').every((f) => !f.is_error)).toBe(true)
    // Two dreams ran in B (the failure did not wedge the lease): two descriptors.
    const descriptors = neutralEventsOf(coreOf(fx.sm, b).log as Parameters<typeof neutralEventsOf>[0])
      .filter((e) => e.type === 'subagent/descriptor' && (e as { data: { toolUseId: string } }).data.toolUseId.startsWith('dream-'))
    expect(descriptors).toHaveLength(2)
    ca.unsubscribe()
    cb.unsubscribe()
  }, 30000)

  it('restart survival: a second SessionManager cold-reads the recall card and replays the recall into model history', async () => {
    const fx = await makeFixture()
    // Learn in A, recall in B (default thresholds → no dream).
    const a = await createSession(fx)
    const ca = channel(fx.sm, a)
    fx.scripts.push(
      toolTurn('write-fact', 'Write', { file_path: join(fx.ownDir, 'fact.md'), content: factContent }),
      textTurn('saved'),
    )
    await sendTurn(fx, a, ca.frames, 'remember this')
    ca.unsubscribe()

    fx.recallSelection = ['fact.md']
    const b = await createSession(fx)
    const cb = channel(fx.sm, b)
    fx.scripts.push(textTurn('recalled'))
    await sendTurn(fx, b, cb.frames, 'recall it')
    const row = await sidecarRecallRow(fx.stateDir, b)
    const recallSeq = row.seq as number
    cb.unsubscribe()

    // Shut the first manager down; build a SECOND on the same stateDir.
    await fx.sm.shutdown()
    const store2 = new SessionStore({ stateDir: fx.stateDir })
    await store2.load()
    const provider2 = new NativeProvider({ stateDir: fx.stateDir, ports: makeNativePorts({ stateDir: fx.stateDir, autoMemory: createAutoMemoryPort({ stateDir: fx.stateDir, configDir: fx.configDir }) }) })
    provider2._testStream = (async function* () { for (const ev of textTurn('cold')) yield ev }) as unknown as NativeProvider['_testStream']
    const registry2 = new ProviderRegistry()
    registry2.register(provider2)
    const sm2 = new SessionManager({ store: store2, providers: registry2 })
    managers.push(sm2)
    sessionIds.push({ sm: sm2, id: b })

    // Cold transcript window hydrates the app-only recall card at the SAME seq.
    const win = await sm2.getTranscriptWindow(b)
    expect(win.degraded).toBe(false)
    const cold = win.messages.find((m) => m.seq === recallSeq)
    expect(cold).toBeDefined()
    expect((cold!.msg as Frame).subtype).toBe('memory_recall')
    expect((cold!.msg as Frame).memories).toEqual([{ path: join(fx.ownDir, 'fact.md'), scope: 'personal' }])
    expect(cold!.msg).toEqual(row.msg)

    // Cold model-history replay: resuming B rebuilds history from the disk log,
    // and the supplement track replays the recall text into it.
    const resumed = await sm2.resume(b)
    expect(resumed.id).toBe(b)
    expect(historyHasRecall(coreOf(sm2, b))).toBe(true)
  }, 30000)

  it('override rejection: a claude-dir autoMemoryDirectory is refused 400 and leaves session.memory unchanged', async () => {
    const fx = await makeFixture()
    const id = await createSession(fx)
    expect(fx.sm.list().find((s) => s.id === id)?.memory).toBeUndefined()

    // Direct path into the claude compat store → the port's realpath guard throws
    // HttpError 400 through applyFlagSettings; the manager never mutates memory.
    await expect(fx.sm.setMemorySettings(id, { autoMemoryDirectory: fx.claudeDir }))
      .rejects.toMatchObject({ status: 400 })
    expect(fx.sm.list().find((s) => s.id === id)?.memory).toBeUndefined()

    // A nested path under the claude config dir is refused too.
    await expect(fx.sm.setMemorySettings(id, { autoMemoryDirectory: join(fx.configDir, 'projects', 'anything', 'memory') }))
      .rejects.toBeInstanceOf(HttpError)
    expect(fx.sm.list().find((s) => s.id === id)?.memory).toBeUndefined()

    // Contrast: a VALID override outside the config dir is accepted and recorded.
    const validDir = join(fx.project, 'my-memory')
    const info = await fx.sm.setMemorySettings(id, { autoMemoryDirectory: validDir })
    expect(info.memory?.autoMemoryDirectory).toBe(validDir)
    expect(fx.sm.list().find((s) => s.id === id)?.memory?.autoMemoryDirectory).toBe(validDir)
  }, 30000)
})