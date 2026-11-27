// server/providers/native/native-provider.test.ts
//
// T14 provider-composition pins: NativeProvider.createSession composes the
// neutral NativeSession core + the wrapNativeCore host adapter for BOTH the
// attachment-fidelity and the handle-only (pre-fidelity) paths. The obsolete
// LegacyNativeSession subclass is gone — its file→handle-text input projection
// and copyConsumedAt bridging now ride the adapter's projectInput hook and lease
// callbacks. These tests drive the provider seam DIRECTLY (no SessionManager)
// so they isolate the composition the provider owns:
//
//   - both paths return the SDK-shaped wrapper around the neutral core;
//   - the handle's messages yield SDK frames (init / stream_event / assistant /
//     result), not neutral vocabulary;
//   - handle-only projects structured files to handle text BEFORE the core and
//     bridges the consumption stamp back onto the original host message;
//   - fidelity keeps the structured file ref in the neutral core;
//   - readHistoryPage / Entries / ForReconcile return SDK-shaped history through
//     the adapter's history-read projection (T13 seam);
//   - resume migrates a v1/v2 log to v3 eagerly at open; a fork seeds the child
//     from the source and a later resume upgrades it (T12 eager-at-open).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeProvider } from './native-provider.js'
import { NativeSession } from './native-session.js'
import { makeNativePorts } from '../native-host-adapters.js'
import { nativeCoreOf } from '../native-host-frame-adapter.js'
import { loadNativeSessionLogSync, NativeSessionLog, type NativeNeutralEventInput } from './session-log/log.js'
import { projectNeutralEventToLegacy, serializeEvent, serializeHeader } from './session-log/format.js'
import type { NativeLogEvent, NativeSessionHeader } from './session-log/format.js'
import type { NativeSessionEvent } from './vocabulary/session-event.js'
import { createUserMessage } from './vocabulary/message.js'
import { TODO_WRITE_GUIDANCE } from './tools/todo-write.js'
import { TASK_CREATE_GUIDANCE } from './tools/task-create.js'
import { TASK_UPDATE_GUIDANCE } from './tools/task-update.js'
import { TASK_GET_GUIDANCE } from './tools/task-get.js'
import { TASK_LIST_GUIDANCE } from './tools/task-list.js'

// T6 read-side shrink: a v3 log exposes no live legacy read view. Reconstruct
// the legacy shape from the canonical neutral baseline via the pinned compat
// projection (a v1/v2 log keeps its canonical list); a null snapshot → [].
function legacyEventsOf(snapshot: { header: { id: string }; events: NativeLogEvent[]; neutralEvents?: NativeSessionEvent[] } | null | undefined): NativeLogEvent[] {
  if (!snapshot) return []
  return snapshot.neutralEvents
    ? snapshot.neutralEvents.map((event) => projectNeutralEventToLegacy(event, snapshot.header.id))
    : snapshot.events
}
import { nativeSessionDir, nativeSessionLogPath } from './session-log/paths.js'
import { fileHandleText } from '../../../shared/upload-handle.js'
import { __setConfigForTest, config } from '../../config.js'
import type { CanonicalEvent } from './canonical.js'
import type { ProviderSessionHandle } from '../types.js'

type Frame = Record<string, any>

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function toolUseTurn(id: string, name: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

const dirs: string[] = []
const handles: ProviderSessionHandle[] = []
let skillsConfigDir: string
let previousConfigDir: string | undefined
let previousConfig: typeof config

beforeEach(async () => {
  previousConfig = { ...config }
  // Redirect user-scope skill discovery at a temp empty dir so the developer's
  // real ~/.claude/skills can never leak into a session (same guard as
  // native-session.test.ts).
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-provider-skills-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = skillsConfigDir
})

afterEach(async () => {
  __setConfigForTest(previousConfig)
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  for (const handle of handles.splice(0)) {
    try { await handle.destroy('test teardown') } catch { /* already gone */ }
  }
  await rm(skillsConfigDir, { recursive: true, force: true })
  // Let in-flight native-log writes land before rmdir; maxRetries absorbs the
  // Windows EBUSY from a fire-and-forget git anchor probe holding the cwd.
  await new Promise((resolve) => setTimeout(resolve, 80))
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function track(handle: ProviderSessionHandle): ProviderSessionHandle {
  handles.push(handle)
  return handle
}

/** Arm the provider's per-turn test streamer, optionally capturing each round's
 *  API request messages so a test can assert what the model actually saw. */
function armStream(
  provider: NativeProvider,
  scripts: CanonicalEvent[][],
  requests?: Array<{ messages: unknown[] }>,
): void {
  provider._testStream = async function* (req: { messages: unknown[] }) {
    requests?.push(structuredClone(req))
    for (const ev of scripts.shift() ?? []) yield ev
  }
}

function makeProvider(stateDir: string): NativeProvider {
  return new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
}

/** Start draining the handle's live SDK frames into an array (non-blocking). */
function pumpFrames(handle: ProviderSessionHandle): Frame[] {
  const frames: Frame[] = []
  void (async () => { for await (const frame of handle.messages) frames.push(frame as Frame) })()
  return frames
}

function waitForResult(frames: Frame[], result?: string): Promise<void> {
  return vi.waitFor(() => {
    expect(frames.some((f) => f.type === 'result' && (result === undefined || f.result === result))).toBe(true)
  }, { timeout: 5000 })
}

let userSeq = 0
function userMsg(text: string, uuid = `u-${++userSeq}`) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid,
  }
}

/** A resolved file attachment (the provider-seam form). The registry path need
 *  not exist on disk: the handle-only path projects it to text before the core,
 *  and the fidelity path persists the ref without reading it (no AttachmentRead
 *  call in these tests). */
function fileAttachment(dir: string) {
  return {
    id: 'upload-t14',
    name: 'notes.txt',
    size: 123,
    digest: 'e'.repeat(64),
    path: join(dir, 'registry', 'notes.txt'),
    mediaType: 'text/plain',
  }
}

function fileUserMsg(dir: string, uuid: string, text = 'read the file') {
  return {
    ...userMsg(text, uuid),
    message: {
      role: 'user' as const,
      content: [{ type: 'file', attachment: fileAttachment(dir) }, { type: 'text', text }],
    },
  }
}

/** The durable user events a session logged (the core's post-projection input). */
function loggedUserEvents(stateDir: string, id: string): Array<{ uuid: string; message: { content: any[] } }> {
  const log = loadNativeSessionLogSync(stateDir, id)!
  return legacyEventsOf(log).filter((event) => event.type === 'user') as any[]
}

/** Write a minimal real-shaped v2 log: context + one completed text turn. */
async function writeV2Log(stateDir: string, id: string, prompt: string, reply: string): Promise<NativeLogEvent[]> {
  const ts = '2026-11-21T10:00:00.000Z'
  const events: NativeLogEvent[] = [
    { seq: 0, type: 'session/context', text: '<system-reminder>Working directory: /repo</system-reminder>' },
    {
      seq: 1, type: 'user', uuid: `${id}-u1`, session_id: id, parent_tool_use_id: null, timestamp: ts,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    },
    {
      seq: 2, type: 'assistant', uuid: `${id}-a1`, session_id: id, parent_tool_use_id: null, timestamp: ts,
      message: {
        type: 'assistant', role: 'assistant', id: `msg_${id}`, model: 'claude-x', stop_reason: 'end_turn',
        content: [{ type: 'text', text: reply }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    } as NativeLogEvent,
    { seq: 3, type: 'turn/end', reason: 'completed', usage: { input_tokens: 10, output_tokens: 5 } },
  ]
  const header: NativeSessionHeader = {
    type: 'session/header', v: 2, id, cwd: '/repo', createdAt: Date.now(), isSeeded: false, inheritedEventCount: 0,
  }
  const body = serializeHeader(header) + '\n' + events.map((event) => serializeEvent(event) + '\n').join('')
  await mkdir(nativeSessionDir(stateDir, id), { recursive: true })
  await writeFile(nativeSessionLogPath(stateDir, id), body, 'utf8')
  return events
}

describe('NativeProvider core + adapter composition (T14)', () => {
  it.each([true, false])('createSession wraps the neutral core in the SDK handle (fidelity=%s)', async (fidelity) => {
    __setConfigForTest({ nativeAttachmentFidelity: fidelity })
    const dir = await tempDir('native-provider-compose-')
    const provider = makeProvider(dir)
    const handle = track(provider.createSession({ id: 'compose', cwd: dir, model: 'test-model' }))

    expect(handle.provider).toBe('native')
    expect(handle.echoesUserPrompts).toBe(false)
    // The handle is the adapter's plain wrapper, NOT a NativeSession subclass
    // (LegacyNativeSession is removed); the neutral core is reached via the seam.
    expect(handle).not.toBeInstanceOf(NativeSession)
    const core = nativeCoreOf(handle)
    expect(core).toBeInstanceOf(NativeSession)
    expect(typeof handle.messages[Symbol.asyncIterator]).toBe('function')
  })

  it('the handle messages yield SDK frames, not neutral vocabulary', async () => {
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const dir = await tempDir('native-provider-sdk-frames-')
    const provider = makeProvider(dir)
    armStream(provider, [textTurn('hello sdk')])
    const handle = track(provider.createSession({ id: 'sdk-frames', cwd: dir, model: 'test-model' }))

    const frames = pumpFrames(handle)
    handle.enqueueUserMessage(userMsg('hi', 'sdk-u1') as never)
    await waitForResult(frames)

    const init = frames.find((f) => f.type === 'system' && f.subtype === 'init')
    expect(init?.session_id).toBe('sdk-frames')
    // Raw Anthropic events travel verbatim as stream_event frames.
    expect(frames.some((f) => f.type === 'stream_event' && typeof f.event === 'object')).toBe(true)

    const assistant = frames.find((f) => f.type === 'assistant')
    expect(assistant?.session_id).toBe('sdk-frames')
    expect(assistant?.parent_tool_use_id).toBeNull()
    expect(assistant?.message?.id).toMatch(/^msg_/)
    expect(assistant?.message?.content?.[0]).toMatchObject({ type: 'text', text: 'hello sdk' })
    expect(assistant?.message?.usage?.input_tokens).toEqual(expect.any(Number))
    expect(assistant?.message?.usage?.output_tokens).toEqual(expect.any(Number))

    const result = frames.find((f) => f.type === 'result')
    expect(result?.subtype).toBe('success')
    expect(result?.runtime).toBe('native')
    expect(result?.result).toBe('hello sdk')
  })

  it('renders the Task* guidance sections in both the parent and subagent prompts', async () => {
    const dir = await tempDir('native-task-guidance-')
    const provider = makeProvider(dir)
    const requests: Array<{ messages: unknown[]; system: string; tools: Array<{ name: string }> }> = []
    armStream(provider, [
      toolUseTurn('agent-1', 'Agent', { description: 'd', prompt: 'p' }),
      textTurn('NESTED-DONE'),
      textTurn('PARENT-DONE'),
    ], requests)
    const handle = track(provider.createSession({
      id: 'task-guidance',
      cwd: dir,
      model: 'test-model',
      canUseTool: async (_name: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    }))
    const frames = pumpFrames(handle)
    handle.enqueueUserMessage(userMsg('delegate', 'tg-u1') as never)
    await waitForResult(frames, 'PARENT-DONE')

    // The parent request and the nested (Agent-less) request each render the
    // full Task* family beside TodoWrite — the sections ride the unconditional
    // registration block, so a subagent sees the same guidance.
    const nested = requests.find((r) => !r.tools.some((t) => t.name === 'Agent'))
    expect(nested).toBeDefined()
    for (const system of [requests[0].system, nested!.system]) {
      expect(system).toContain(TASK_CREATE_GUIDANCE)
      expect(system).toContain(TASK_UPDATE_GUIDANCE)
      expect(system).toContain(TASK_GET_GUIDANCE)
      expect(system).toContain(TASK_LIST_GUIDANCE)
      expect(system).toContain(TODO_WRITE_GUIDANCE)
    }
  })

  it('handle-only path projects structured files to handle text before the neutral core', async () => {
    __setConfigForTest({ nativeAttachmentFidelity: false })
    const dir = await tempDir('native-provider-handle-only-')
    const provider = makeProvider(dir)
    const requests: Array<{ messages: unknown[] }> = []
    armStream(provider, [textTurn('handled')], requests)
    const handle = track(provider.createSession({ id: 'handle-only', cwd: dir, model: 'test-model' }))

    const frames = pumpFrames(handle)
    handle.enqueueUserMessage(fileUserMsg(dir, 'ho-u1') as never)
    await waitForResult(frames)

    // The core received TEXT-ONLY input: the structured file became handle text
    // at the adapter boundary (the old LegacyNativeSession.enqueueUserMessage
    // projection), so the durable log carries no file block.
    const [user] = loggedUserEvents(dir, 'handle-only')
    expect(user.uuid).toBe('ho-u1')
    expect(user.message.content.some((block) => block.type === 'file')).toBe(false)
    const attachment = fileAttachment(dir)
    const handleText = fileHandleText(attachment, attachment.path)
    expect(user.message.content).toContainEqual({ type: 'text', text: handleText })
    // The model saw the same handle text (no structured file in the request).
    expect(JSON.stringify(requests[0].messages)).toContain('upload:upload-t14')
    expect(JSON.stringify(requests[0].messages)).not.toContain('"type":"file"')
  })

  it('handle-only path bridges copyConsumedAt onto the original host message', async () => {
    __setConfigForTest({ nativeAttachmentFidelity: false })
    const dir = await tempDir('native-provider-consumed-')
    const provider = makeProvider(dir)
    armStream(provider, [textTurn('consumed')])
    const consumed: Array<{ uuid?: string; consumedAt?: number }> = []
    const handle = track(provider.createSession({
      id: 'consumed', cwd: dir, model: 'test-model',
      // Mimic the manager: stamp consumedAt on the projected outcome it receives.
      onUserMessageConsumed: (message) => {
        ;(message as { consumedAt?: number }).consumedAt = Date.now()
        consumed.push(message as { uuid?: string; consumedAt?: number })
      },
    }))

    const original = fileUserMsg(dir, 'consumed-u1')
    const frames = pumpFrames(handle)
    handle.enqueueUserMessage(original as never)
    await waitForResult(frames)

    // The adapter paired the ORIGINAL host object and bridged the consumption
    // stamp from the projected outcome back onto it (copyConsumedAt).
    expect(consumed).toHaveLength(1)
    expect(consumed[0].uuid).toBe('consumed-u1')
    expect((original as { consumedAt?: number }).consumedAt).toEqual(expect.any(Number))
    // The callback received the projection clone, not the original object.
    expect(consumed[0]).not.toBe(original)
  })

  it('fidelity path keeps the structured file ref in the neutral core', async () => {
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const dir = await tempDir('native-provider-fidelity-')
    const provider = makeProvider(dir)
    armStream(provider, [textTurn('fidelity')])
    const handle = track(provider.createSession({ id: 'fidelity', cwd: dir, model: 'test-model' }))

    const frames = pumpFrames(handle)
    handle.enqueueUserMessage(fileUserMsg(dir, 'fid-u1') as never)
    await waitForResult(frames)

    // The fidelity input retains the structured FileBlock ref (the wire adapter
    // projects it to handle text / PDF per request); the core's durable log
    // stores the resolved attachment, unlike the handle-only text projection.
    const [user] = loggedUserEvents(dir, 'fidelity')
    expect(user.uuid).toBe('fid-u1')
    const fileBlock = user.message.content.find((block) => block.type === 'file')
    expect(fileBlock).toBeDefined()
    expect(fileBlock.attachment.id).toBe('upload-t14')
    expect(fileBlock.attachment.path).toBe(fileAttachment(dir).path)
  })

  it('readHistoryPage / Entries / ForReconcile return SDK-shaped history via the adapter projection', async () => {
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const dir = await tempDir('native-provider-history-')
    const provider = makeProvider(dir)
    armStream(provider, [textTurn('history-reply')])
    const handle = track(provider.createSession({ id: 'history', cwd: dir, model: 'test-model' }))
    const frames = pumpFrames(handle)
    handle.enqueueUserMessage(userMsg('history-prompt', 'hist-u1') as never)
    await waitForResult(frames)
    // Gate on the durable turn before reading (the assistant flush is async).
    await vi.waitFor(async () => {
      const page = await provider.readHistoryPage('history', { limit: 20 })
      expect(JSON.stringify(page.messages)).toContain('history-reply')
    }, { timeout: 5000 })

    const page = await provider.readHistoryPage('history', { limit: 20 })
    expect(page.messages.length).toBeGreaterThan(0)
    for (const message of page.messages as Frame[]) {
      expect(['user', 'assistant']).toContain(message.type)
      expect(message.uuid).toEqual(expect.any(String))
      expect(message.message?.role).toEqual(message.type)
    }
    expect(JSON.stringify(page.messages)).toContain('history-prompt')
    expect(JSON.stringify(page.messages)).toContain('history-reply')

    const entries = await provider.readHistoryEntries('history', {})
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.index).toEqual(expect.any(Number))
      expect(entry.sourceOrdinal).toEqual(entry.index)
      expect((entry.message as Frame).message?.role).toEqual((entry.message as Frame).type)
    }

    const reconcile = await provider.readHistoryForReconcile('history', {})
    expect(reconcile.status).toBe('ok')
    expect(reconcile.entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(reconcile.entries)).toContain('history-reply')
  })

  it('resume migrates a v2 log to v3 eagerly at open and replays the turn', async () => {
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const dir = await tempDir('native-provider-resume-migrate-')
    const sourceEvents = await writeV2Log(dir, 'resume-migrate', 'source-prompt', 'source-reply')
    expect(loadNativeSessionLogSync(dir, 'resume-migrate')!.header.v).toBe(2)

    const provider = makeProvider(dir)
    armStream(provider, [textTurn('after-resume')])
    const handle = track(provider.createSession({ id: 'resume-migrate', cwd: dir, model: 'test-model', resume: 'resume-migrate' }))

    // Eager-at-open: the disk upgrades to v3 WITHOUT any explicit migrate call
    // or first append — open() itself triggered it (R7).
    await vi.waitFor(() => {
      expect(loadNativeSessionLogSync(dir, 'resume-migrate')!.header.v).toBe(3)
    }, { timeout: 5000 })
    // Parsed-line round-trip: the compat projection of the neutral baseline is
    // unchanged by migration (T6: no live legacy read view).
    expect(legacyEventsOf(loadNativeSessionLogSync(dir, 'resume-migrate'))).toEqual(sourceEvents)

    // The resumed handle replays the source turn into model history and works.
    const core = nativeCoreOf(handle) as unknown as { history: unknown[] }
    expect(JSON.stringify(core.history)).toContain('source-prompt')
    expect(JSON.stringify(core.history)).toContain('source-reply')
    const frames = pumpFrames(handle)
    handle.enqueueUserMessage(userMsg('next', 'resume-u2') as never)
    await waitForResult(frames, 'after-resume')
  })

  it('fork seeds the child from the source as neutral v3; a later resume keeps it v3', async () => {
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const dir = await tempDir('native-provider-fork-migrate-')
    await writeV2Log(dir, 'fork-source', 'fork-prompt', 'fork-reply')

    const provider = makeProvider(dir)
    const child = track(provider.createSession({
      id: 'fork-child', cwd: dir, model: 'test-model', forkSession: true, resume: 'fork-source',
    }))
    expect(child.provider).toBe('native')
    expect(nativeCoreOf(child)).toBeInstanceOf(NativeSession)

    // The child log carries the inherited source turn (readable through the
    // adapter history projection).
    await vi.waitFor(async () => {
      const page = await provider.readHistoryPage('fork-child', { limit: 20 })
      expect(JSON.stringify(page.messages)).toContain('fork-reply')
    }, { timeout: 5000 })
    // T5: a fork seed is always neutral v3 — buildForkSeed migrates a legacy
    // source in memory, so the child never inherits the source's v2 version.
    expect(loadNativeSessionLogSync(dir, 'fork-child')!.header.v).toBe(3)
    await child.destroy('fork phase done')

    // Resuming the child keeps the neutral v3 baseline (no upgrade needed).
    armStream(provider, [textTurn('child-after-resume')])
    const resumed = track(provider.createSession({ id: 'fork-child', cwd: dir, model: 'test-model', resume: 'fork-child' }))
    await vi.waitFor(() => {
      expect(loadNativeSessionLogSync(dir, 'fork-child')!.header.v).toBe(3)
    }, { timeout: 5000 })
    const core = nativeCoreOf(resumed) as unknown as { history: unknown[] }
    expect(JSON.stringify(core.history)).toContain('fork-prompt')
    expect(JSON.stringify(core.history)).toContain('fork-reply')
  })

  it('renameSession appends a durable session/title to a dormant log', async () => {
    const dir = await tempDir('native-provider-rename-')
    await writeV2Log(dir, 'rename-dormant', 'prompt', 'reply')
    const provider = makeProvider(dir)

    await provider.renameSession('rename-dormant', 'T')

    const snap = loadNativeSessionLogSync(dir, 'rename-dormant')!
    expect(snap.header.v).toBe(3)
    expect(snap.neutralEvents!.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
    expect(snap.neutralEvents![4]).toMatchObject({ type: 'session/title', data: { title: 'T' } })
  })
})

// --- Task 5: resumable discovery (listResumable / getSessionInfo) ---
// Fixtures go through the REAL writer (NativeSessionLog) with neutral event
// inputs, mirroring native-resumable-listing.test.ts, so the provider's row
// mapping is pinned against actual on-disk serialization rather than a
// hand-rolled log shape.

function discoveryUser(text: string, time = Date.now()): NativeNeutralEventInput {
  return {
    type: 'user/message',
    time,
    parentToolUseId: null,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }
}

function discoveryTitle(title: string): NativeNeutralEventInput {
  return { type: 'session/title', time: Date.now(), data: { title } }
}

async function writeDiscoveryLog(
  stateDir: string,
  id: string,
  cwd: string,
  events: NativeNeutralEventInput[],
): Promise<void> {
  const log = NativeSessionLog.open({ stateDir, id, cwd, resume: false })
  for (const event of events) log.append(event)
  await log.flush()
  await log.close()
}

describe('NativeProvider resumable discovery (Task 5)', () => {
  it('listResumable maps scan rows: log title as title (not customTitle), previews, false flags, no provider', async () => {
    const dir = await tempDir('native-provider-list-')
    const provider = makeProvider(dir)
    await writeDiscoveryLog(dir, 'list-a', '/repo-a', [
      discoveryUser('first question'),
      discoveryTitle('Alpha title'),
      discoveryUser('second question'),
    ])
    await writeDiscoveryLog(dir, 'list-b', '/repo-b', [discoveryUser('only question')])

    const rows = await provider.listResumable()
    expect(rows).toHaveLength(2)
    const byId = new Map(rows.map((row) => [row.sessionId, row]))

    const a = byId.get('list-a')!
    expect(a).toBeDefined()
    expect(a.sessionId).toBe('list-a')
    expect(a.cwd).toBe('/repo-a')
    expect(a.createdAt).toBe(loadNativeSessionLogSync(dir, 'list-a')!.header.createdAt)
    expect(a.lastModified).toBe((await stat(nativeSessionLogPath(dir, 'list-a'))).mtimeMs)
    expect(a.firstPrompt).toBe('first question')
    expect(a.lastPrompt).toBe('second question')
    expect(a.title).toBe('Alpha title')
    expect(a.customTitle).toBeUndefined()
    expect(a.known).toBe(false)
    expect(a.running).toBe(false)
    expect(a.terminated).toBe(false)
    expect(a.provider).toBeUndefined()

    const b = byId.get('list-b')!
    expect(b).toBeDefined()
    expect(b.cwd).toBe('/repo-b')
    expect(b.firstPrompt).toBe('only question')
    expect(b.lastPrompt).toBe('only question')
    expect(b.title).toBeUndefined()
    expect(b.customTitle).toBeUndefined()
    expect(b.known).toBe(false)
    expect(b.running).toBe(false)
    expect(b.terminated).toBe(false)
    expect(b.provider).toBeUndefined()
  })

  it('listResumable({ dir }) scopes to exact cwd matches', async () => {
    const dir = await tempDir('native-provider-list-scope-')
    const provider = makeProvider(dir)
    await writeDiscoveryLog(dir, 'scope-a', '/repo-a', [discoveryUser('a')])
    await writeDiscoveryLog(dir, 'scope-b', '/repo-b', [discoveryUser('b')])

    const scoped = await provider.listResumable({ dir: '/repo-a' })
    expect(scoped.map((row) => row.sessionId)).toEqual(['scope-a'])
    expect(await provider.listResumable({ dir: '/nowhere' })).toEqual([])
  })

  it('getSessionInfo returns a mapped row for an existing log', async () => {
    const dir = await tempDir('native-provider-info-')
    const provider = makeProvider(dir)
    await writeDiscoveryLog(dir, 'info-exists', '/repo', [
      discoveryUser('info prompt'),
      discoveryTitle('Info title'),
    ])

    const info = await provider.getSessionInfo('info-exists')
    expect(info).toBeDefined()
    expect(info!.sessionId).toBe('info-exists')
    expect(info!.cwd).toBe('/repo')
    expect(info!.firstPrompt).toBe('info prompt')
    expect(info!.lastPrompt).toBe('info prompt')
    expect(info!.title).toBe('Info title')
    expect(info!.customTitle).toBeUndefined()
    expect(info!.known).toBe(false)
    expect(info!.running).toBe(false)
    expect(info!.terminated).toBe(false)
    expect(info!.provider).toBeUndefined()
  })

  it('getSessionInfo returns undefined for a missing log', async () => {
    const dir = await tempDir('native-provider-info-missing-')
    const provider = makeProvider(dir)
    expect(await provider.getSessionInfo('no-such-session')).toBeUndefined()
  })

  it('getSessionInfo rejects for a corrupt log', async () => {
    const dir = await tempDir('native-provider-info-corrupt-')
    const provider = makeProvider(dir)
    await mkdir(nativeSessionDir(dir, 'corrupt'), { recursive: true })
    await writeFile(nativeSessionLogPath(dir, 'corrupt'), 'not a valid header line\n', 'utf8')
    await expect(provider.getSessionInfo('corrupt')).rejects.toThrow()
  })

  it('deleteTranscript invalidates the row cache so a re-created log is re-read', async () => {
    const dir = await tempDir('native-provider-recreate-')
    const provider = makeProvider(dir)
    const id = 'recreate'
    const path = nativeSessionLogPath(dir, id)
    // Pin both writes to the same mtime and use same-length prompts so the
    // (size, mtimeMs) stat key collides deterministically: only an explicit
    // row-cache invalidation in deleteTranscript can force the re-read.
    const pinned = new Date('2026-11-25T00:00:00.000Z')
    const fixedTime = 1764000000000

    await writeDiscoveryLog(dir, id, '/repo', [discoveryUser('old prompt', fixedTime)])
    await utimes(path, pinned, pinned)
    const sizeBefore = (await stat(path)).size
    const first = await provider.getSessionInfo(id)
    expect(first?.firstPrompt).toBe('old prompt') // primes the row cache

    await provider.deleteTranscript(id)
    await writeDiscoveryLog(dir, id, '/repo', [discoveryUser('new prompt', fixedTime)])
    await utimes(path, pinned, pinned)
    expect((await stat(path)).size).toBe(sizeBefore) // same-size premise

    const second = await provider.getSessionInfo(id)
    expect(second?.firstPrompt).toBe('new prompt')
  })
})