// server/providers/native/e2e-slash.test.ts
//
// End-to-end proof of the native builtin/custom slash surface through
// SessionManager: a leading `/commandname` (builtin or custom) is intercepted
// BEFORE skill matching and expanded host-side through the shared substitution
// contract, the raw turn + hidden instruction ride the same dual-event model
// as skill invocation, and `supportedCommands` / the `commands-changed`
// broadcast carry builtin + custom + skill rows (deduped by name, command
// wins). An unknown `/name` passes through to the model as ordinary text.
//
// Fixture shape copied from e2e-skills.test.ts (temp-dir SessionStore + custom
// ProviderRegistry + scripted `_testStream`). CLAUDE_CONFIG_DIR is redirected
// at a temp dir so the developer's real user-scope commands and skills never
// leak into an assertion.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import type { CanonicalEvent } from './canonical.js'
import { BUILTIN_COMMANDS } from './commands.js'
import { loadNativeSessionLogSync } from './session-log/log.js'
import { neutralEventsOf } from './session-log/neutral-read.js'
import type { NativeSessionEvent } from './vocabulary/session-event.js'

// The /compact integration tests drive the manager's REAL in-place compaction
// flow; only the auxiliary summarizer LLM round-trip is faked (the same mock
// shape as e2e-context-window.test.ts).
vi.mock('../../compact-summary.js', () => ({
  summarizeForCompact: vi.fn(async () => 'MOCK SUMMARY'),
}))

type Frame = Record<string, any>

/** The builtin catalog rows exactly as the surface must answer them: the
 *  authored metadata plus `builtin: true`, no prompt body. */
const BUILTIN_ROWS = BUILTIN_COMMANDS.map(({ name, description, argumentHint }) => ({
  name, description, argumentHint, builtin: true,
}))

const INIT_BODY = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'init')!.body!

const SKILL_DESCRIPTION = 'Demo skill used by the native slash e2e.'
const SKILL_MD = [
  '---',
  'name: demo',
  'description: ' + SKILL_DESCRIPTION,
  "argument-hint: '[what to do]'",
  '---',
  '',
  '# Demo skill',
  '',
  'Follow the demo instructions.',
  '',
].join('\n')

const DEMO_COMMAND = {
  name: 'demo',
  description: SKILL_DESCRIPTION,
  argumentHint: '[what to do]',
}

function canonicalDemoBody(project: string): string {
  return `Base directory for this skill: ${join(project, '.claude', 'skills', 'demo')}\n\n# Demo skill\n\nFollow the demo instructions.\n`
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

interface StreamRequest {
  system: string
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
}

type CreateOptions = Parameters<SessionManager['create']>[0]
type ToolPermission = NonNullable<CreateOptions['canUseTool']>

function allowingCanUseTool(): ToolPermission {
  const handler = async (
    _name: string,
    input: Record<string, unknown>,
  ) => ({ behavior: 'allow' as const, updatedInput: input })
  return handler as unknown as ToolPermission
}

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []

let root: string
let configDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sm-native-slash-e2e-'))
  configDir = join(root, 'config')
  // Empty user-scope roots: discovery must see only what a test plants.
  await mkdir(join(configDir, 'skills'), { recursive: true })
  await mkdir(join(configDir, 'commands'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already gone */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  vi.mocked(summarizeForCompact).mockClear()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await new Promise((r) => setTimeout(r, 80)) // let in-flight sidecar writes land before rmdir
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor
  // probe (captureGitHead) still holding a temp dir as its cwd.
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
})

interface Fixture {
  sm: SessionManager
  provider: NativeProvider
  requests: StreamRequest[]
  scripts: CanonicalEvent[][]
}

/** The project dir and a SEPARATE state dir; files are planted per test. */
async function makeEnv(): Promise<{ project: string; stateDir: string }> {
  const project = join(root, 'project')
  const stateDir = join(root, 'state')
  await mkdir(project, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  dirs.push(root)
  return { project, stateDir }
}

/** Plant a flat project-scope command document (frontmatter optional). */
async function writeCommand(project: string, name: string, content: string): Promise<void> {
  const dir = join(project, '.claude', 'commands')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.md`), content, 'utf8')
}

/** Plant a user-scope command document under the redirected config dir. */
async function writeUserCommand(name: string, content: string): Promise<void> {
  await writeFile(join(configDir, 'commands', `${name}.md`), content, 'utf8')
}

async function writeDemoSkill(project: string): Promise<void> {
  const dir = join(project, '.claude', 'skills', 'demo')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), SKILL_MD, 'utf8')
}

async function makeFixture(stateDir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
  const requests: StreamRequest[] = []
  const scripts: CanonicalEvent[][] = []
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: StreamRequest) {
    // Snapshot the request: `req.messages` is the session's live history array,
    // mutated by later rounds, so a captured reference would show the FINAL
    // transcript instead of what this request actually sent.
    requests.push({ system: req.system, tools: req.tools, messages: structuredClone(req.messages) })
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { sm, provider, requests, scripts }
}

async function createSession(
  fx: Fixture,
  cwd: string,
  extra: Partial<CreateOptions> = {},
): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title: 'slash-e2e',
    canUseTool: allowingCanUseTool(),
    ...extra,
  })
  sessionIds.push({ sm: fx.sm, id: info.id })
  return info.id
}

function collectFrames(sm: SessionManager, id: string): { frames: Frame[]; unsubscribe: () => void } {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const f of sub.iterable) frames.push(f as Frame)
  })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

/** Send one turn and wait for its (and only its) result frame. */
async function sendAndWait(
  fx: Fixture,
  id: string,
  frames: Frame[],
  text: string,
  expectedResults: number,
): Promise<void> {
  await fx.sm.send(id, text)
  await vi.waitFor(() => {
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(expectedResults)
  }, { timeout: 5000 })
}

/** The manager's ring entry (the UI-facing copy) for one typed prompt. */
function ringUserFrame(fx: Fixture, id: string, content: string): Frame | undefined {
  const s = (fx.sm as unknown as { sessions: Map<string, { history: Frame[] }> }).sessions.get(id)!
  return s.history.find((f) => f.type === 'user' && f.message?.content === content)
}

/** The durable hidden-instruction events of a session log, in order. */
function instructionEvents(stateDir: string, id: string): Array<{ name: string; body: string }> {
  const snapshot = loadNativeSessionLogSync(stateDir, id)
  if (!snapshot) return []
  return neutralEventsOf(snapshot)
    .filter((event): event is NativeSessionEvent & { type: 'session/skill' } => event.type === 'session/skill')
    .map((event) => ({ name: event.data.name, body: event.data.body }))
}

/** The neutral user-message events (the raw typed turns), in order. */
function rawUserEvents(stateDir: string, id: string): Array<{ uuid: string; text: string }> {
  const snapshot = loadNativeSessionLogSync(stateDir, id)
  if (!snapshot) return []
  const out: Array<{ uuid: string; text: string }> = []
  for (const event of neutralEventsOf(snapshot)) {
    if (event.type !== 'user/message' || event.parentToolUseId !== null) continue
    const block = event.data.content.find((candidate) => candidate.type === 'text')
    if (block && block.type === 'text') out.push({ uuid: event.data.id, text: block.text })
  }
  return out
}

function userTextMessage(text: string): { role: string; content: unknown } {
  return { role: 'user', content: [{ type: 'text', text }] }
}

describe('native slash surface end to end through SessionManager', () => {
  it('supportedCommands lists builtin + custom + skill rows', async () => {
    const { project, stateDir } = await makeEnv()
    await writeCommand(project, 'foo', [
      '---',
      'description: Foo command',
      "argument-hint: '[what]'",
      '---',
      '',
      'Do $ARGUMENTS',
    ].join('\n'))
    // A plain markdown file with NO frontmatter is a valid command row.
    await writeCommand(project, 'bare', 'Just do it.')
    await writeDemoSkill(project)
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)

    expect(await fx.sm.supportedCommands(id)).toEqual([
      ...BUILTIN_ROWS,
      { name: 'bare', description: '', argumentHint: '' },
      { name: 'foo', description: 'Foo command', argumentHint: '[what]' },
      DEMO_COMMAND,
    ])
  })

  it('/init expands the builtin template; the ring keeps the typed text', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(textTurn('initialized'))
    await sendAndWait(fx, id, frames, '/init', 1)

    // The model sees the raw invocation followed by the template body — no
    // ARGUMENTS fallback (no args were typed and the template has no
    // placeholder).
    expect(fx.requests[0].messages.slice(-2)).toEqual([
      userTextMessage('/init'),
      userTextMessage(INIT_BODY),
    ])
    expect(ringUserFrame(fx, id, '/init')).toBeDefined()
    expect(instructionEvents(stateDir, id)).toEqual([{ name: 'init', body: INIT_BODY }])
    unsubscribe()
  })

  it('/foo args substitutes $ARGUMENTS; a $N-only body appends the ARGUMENTS fallback', async () => {
    const { project, stateDir } = await makeEnv()
    await writeCommand(project, 'foo', 'Do $ARGUMENTS')
    await writeCommand(project, 'bar', 'First: $0')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(textTurn('foo done'))
    await sendAndWait(fx, id, frames, '/foo X', 1)
    expect(fx.requests[0].messages.slice(-2)).toEqual([
      userTextMessage('/foo X'),
      userTextMessage('Do X'),
    ])

    // $N-only body: the shared contract appends the whole-args fallback.
    fx.scripts.push(textTurn('bar done'))
    await sendAndWait(fx, id, frames, '/bar a b', 2)
    expect(fx.requests[1].messages.slice(-2)).toEqual([
      userTextMessage('/bar a b'),
      userTextMessage('First: a\n\nARGUMENTS: a b'),
    ])

    // Compaction pairing treats a command expansion exactly like a skill one.
    const core = nativeCoreOf(
      (fx.sm as unknown as { sessions: Map<string, { handle: ProviderSessionHandle }> }).sessions.get(id)!.handle,
    ) as unknown as { getSkillCompactionEntries(): Array<{ afterUserUuid: string; body: string }> }
    const raw = rawUserEvents(stateDir, id)
    expect(core.getSkillCompactionEntries()).toEqual([
      { afterUserUuid: raw[0].uuid, body: 'Do X' },
      { afterUserUuid: raw[1].uuid, body: 'First: a\n\nARGUMENTS: a b' },
    ])
    unsubscribe()
  })

  it('/skillname still expands as before (no regression)', async () => {
    const { project, stateDir } = await makeEnv()
    await writeDemoSkill(project)
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(textTurn('expanded'))
    await sendAndWait(fx, id, frames, '/demo do X', 1)
    expect(fx.requests[0].messages.slice(-2)).toEqual([
      userTextMessage('/demo do X'),
      userTextMessage(canonicalDemoBody(project) + '\n\nARGUMENTS: do X'),
    ])
    expect(ringUserFrame(fx, id, '/demo do X')).toBeDefined()
    expect(instructionEvents(stateDir, id)).toEqual([
      { name: 'demo', body: canonicalDemoBody(project) + '\n\nARGUMENTS: do X' },
    ])
    unsubscribe()
  })

  it('/nonexistent passes through to the model as ordinary text', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(textTurn('passthrough'))
    await sendAndWait(fx, id, frames, '/nonexistent hello', 1)
    expect(fx.requests[0].messages.at(-1)).toEqual(userTextMessage('/nonexistent hello'))
    expect(instructionEvents(stateDir, id)).toEqual([])
    const result = frames.find((f) => f.type === 'result') as Frame
    expect(result.is_error).not.toBe(true)
    unsubscribe()
  })

  it('a command wins over a same-name skill, in expansion and in the catalog', async () => {
    const { project, stateDir } = await makeEnv()
    await writeDemoSkill(project)
    // A custom command named `demo` collides with the demo skill.
    await writeCommand(project, 'demo', '---\ndescription: Command demo\n---\n\nCOMMAND BODY')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    const catalog = await fx.sm.supportedCommands(id) as Array<{ name: string; description: string }>
    expect(catalog.filter((row) => row.name === 'demo')).toEqual([
      { name: 'demo', description: 'Command demo', argumentHint: '' },
    ])

    fx.scripts.push(textTurn('command won'))
    await sendAndWait(fx, id, frames, '/demo go', 1)
    expect(fx.requests[0].messages.slice(-2)).toEqual([
      userTextMessage('/demo go'),
      userTextMessage('COMMAND BODY\n\nARGUMENTS: go'),
    ])
    unsubscribe()
  })

  it('a builtin wins over a same-name custom file', async () => {
    const { project, stateDir } = await makeEnv()
    await writeCommand(project, 'init', 'HIJACKED INIT')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    const catalog = await fx.sm.supportedCommands(id) as Array<{ name: string; builtin?: boolean }>
    expect(catalog.filter((row) => row.name === 'init')).toEqual([
      { name: 'init', description: BUILTIN_ROWS[0].description, argumentHint: '', builtin: true },
    ])
    fx.scripts.push(textTurn('builtin won'))
    await sendAndWait(fx, id, frames, '/init', 1)
    expect(fx.requests[0].messages.at(-1)).toEqual(userTextMessage(INIT_BODY))
    unsubscribe()
  })

  it('matches command names case-insensitively and keeps authored display names', async () => {
    const { project, stateDir } = await makeEnv()
    await writeCommand(project, 'foo', 'Do $ARGUMENTS')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(textTurn('upper done'))
    await sendAndWait(fx, id, frames, '/FOO X', 1)
    expect(fx.requests[0].messages.slice(-2)).toEqual([
      userTextMessage('/FOO X'),
      userTextMessage('Do X'),
    ])

    fx.scripts.push(textTurn('mixed done'))
    await sendAndWait(fx, id, frames, '/Init', 2)
    expect(fx.requests[1].messages.at(-1)).toEqual(userTextMessage(INIT_BODY))

    // The durable instruction names stay the authored catalog names, and the
    // catalog rows keep their authored casing.
    expect(instructionEvents(stateDir, id)).toEqual([
      { name: 'foo', body: 'Do X' },
      { name: 'init', body: INIT_BODY },
    ])
    const names = (await fx.sm.supportedCommands(id) as Array<{ name: string }>).map((row) => row.name)
    expect(names).toContain('foo')
    expect(names).not.toContain('FOO')
    unsubscribe()
  })

  it('discovers user-root commands and lets the project win a same-name collision', async () => {
    const { project, stateDir } = await makeEnv()
    await writeUserCommand('uz', 'USER UZ')
    await writeUserCommand('foo', 'USER FOO')
    await writeCommand(project, 'foo', 'PROJECT FOO')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    const names = (await fx.sm.supportedCommands(id) as Array<{ name: string }>).map((row) => row.name)
    expect(names).toContain('uz')
    expect(names).toContain('foo')

    fx.scripts.push(textTurn('project won'))
    await sendAndWait(fx, id, frames, '/foo', 1)
    expect(fx.requests[0].messages.at(-1)).toEqual(userTextMessage('PROJECT FOO'))
    unsubscribe()
  })

  it('reload re-discovers commands and broadcasts the full catalog', async () => {
    const { project, stateDir } = await makeEnv()
    await writeCommand(project, 'foo', 'Do $ARGUMENTS')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    // Settle the construction-time discovery before mutating the commands dir.
    expect((await fx.sm.supportedCommands(id) as Array<{ name: string }>).map((row) => row.name))
      .toEqual(['init', 'review', 'compact', 'foo'])
    const sub = fx.sm.subscribeCommandChanges(id)!
    const seen: Array<Record<string, unknown>> = []
    void (async () => {
      for await (const f of sub.iterable) seen.push(f as Record<string, unknown>)
    })()

    await writeCommand(project, 'baz', 'BAZ BODY')
    const reloaded = await fx.sm.reloadSkills(id) as { skills: Array<{ name: string }> }
    expect(reloaded.skills.map((row) => row.name)).toEqual(['init', 'review', 'compact', 'baz', 'foo'])
    await vi.waitFor(() => {
      expect(seen).toContainEqual({ commands: reloaded.skills })
    }, { timeout: 5000 })

    // A deleted command disappears on the next reload; builtins remain.
    await rm(join(project, '.claude', 'commands', 'foo.md'), { force: true })
    const afterDelete = await fx.sm.reloadSkills(id) as { skills: Array<{ name: string }> }
    expect(afterDelete.skills.map((row) => row.name)).toEqual(['init', 'review', 'compact', 'baz'])
    await vi.waitFor(() => {
      expect(seen).toContainEqual({ commands: afterDelete.skills })
    }, { timeout: 5000 })
    sub.unsubscribe()
  })

  it('resume rebuilds the raw + instruction pair; a case-insensitive raw fork cut keeps it', async () => {
    const { project, stateDir } = await makeEnv()
    await writeCommand(project, 'foo', 'Do $ARGUMENTS')
    const first = await makeFixture(stateDir)
    const id = await createSession(first, project)
    const { frames, unsubscribe } = collectFrames(first.sm, id)

    first.scripts.push(textTurn('expanded'))
    await sendAndWait(first, id, frames, '/FOO X', 1)
    unsubscribe()

    // Gate on the durable half before the restart reads it.
    await vi.waitFor(async () => {
      const page = await first.sm.getHistoryPage(id, { limit: 50 })
      expect(JSON.stringify(page.messages)).toContain('/FOO X')
    }, { timeout: 5000 })
    const rawUuid = rawUserEvents(stateDir, id)[0].uuid

    // A fork cutting at the raw `/FOO X` turn must include its hidden
    // instruction even though the typed casing differs from the catalog name.
    const fork = await first.sm.fork(id, { resumeSessionAt: rawUuid })
    sessionIds.push({ sm: first.sm, id: fork.id })
    expect(instructionEvents(stateDir, fork.id)).toEqual([{ name: 'foo', body: 'Do X' }])
    const forkSeen = collectFrames(first.sm, fork.id)
    first.scripts.push(textTurn('fork next'))
    await sendAndWait(first, fork.id, forkSeen.frames, 'fork next', 1)
    // The fork's inherited prefix is exactly the source's first request (raw
    // invocation + hidden instruction); a failed case-insensitive pairing
    // would drop the instruction from the seed.
    expect(first.requests[1].messages.slice(0, first.requests[0].messages.length))
      .toEqual(first.requests[0].messages)
    expect(first.requests[1].messages.at(-1)).toEqual(userTextMessage('fork next'))
    forkSeen.unsubscribe()

    // --- restart + resume over the same state dir -------------------------
    await first.sm.shutdown()
    const second = await makeFixture(stateDir)
    const resumed = await second.sm.resume(id)
    expect(resumed.id).toBe(id)
    sessionIds.push({ sm: second.sm, id })
    const live = (second.sm as unknown as {
      sessions: Map<string, { handle: ProviderSessionHandle }>
    }).sessions.get(id)
    const modelHistory = (nativeCoreOf(live!.handle) as unknown as {
      history: Array<{ role: string; content: unknown }>
    }).history
    const shape = (ms: Array<{ role: string; content: unknown }>) =>
      ms.map(({ role, content }) => ({ role, content }))
    expect(shape(modelHistory.slice(1))).toEqual([
      userTextMessage('/FOO X'),
      userTextMessage('Do X'),
      { role: 'assistant', content: [{ type: 'text', text: 'expanded' }] },
    ])
  }, 20000)
})

/** One provider-level user turn (the manager's send path is not involved). */
function providerUserMsg(text: string, uuid: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid,
  }
}

/** Replace the fixture's streamer with one that parks its FIRST request on a
 *  caller-owned gate (later requests run freely), so a test can queue input
 *  against a deterministically in-flight turn. Requests still land in
 *  `fx.requests` for the no-model-turn assertions. */
function installGatedStreamer(fx: Fixture, gate: Promise<void>): void {
  let first = true
  ;(fx.provider as unknown as { _testStream: unknown })._testStream = async function* (req: StreamRequest) {
    fx.requests.push({ system: req.system, tools: req.tools, messages: structuredClone(req.messages) })
    if (first) {
      first = false
      await gate
    }
    for (const ev of fx.scripts.shift() ?? []) yield ev
  }
}

describe('native /compact control action', () => {
  it('/compact invokes the host compaction callback, not a model turn', async () => {
    const { project, stateDir } = await makeEnv()
    // A custom compact.md must NOT hijack the builtin control action.
    await writeCommand(project, 'compact', 'HIJACKED COMPACT')
    const provider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
    const requests: StreamRequest[] = []
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: StreamRequest) {
      requests.push({ system: req.system, tools: req.tools, messages: structuredClone(req.messages) })
      yield* [] // the control turn must never reach the streamer
    }
    const requestCompact = vi.fn(async () => {})
    const session = provider.createSession({ id: 'compact-cb', cwd: project, requestCompact })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      session.enqueueUserMessage(providerUserMsg('/compact', 'u-compact-1') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
      }, { timeout: 5000 })
      expect(requestCompact).toHaveBeenCalledOnce()
      expect(requests).toHaveLength(0)
      const result = frames.find((f) => f.type === 'result')!
      expect(result.subtype).toBe('success')
      expect(result.is_error).not.toBe(true)
      expect(result.num_turns).toBe(0)
      // The raw typed turn is durable; no hidden instruction was expanded.
      expect(rawUserEvents(stateDir, 'compact-cb').map((e) => e.text)).toEqual(['/compact'])
      expect(instructionEvents(stateDir, 'compact-cb')).toEqual([])

      // Case-insensitive name match rides the same control path.
      session.enqueueUserMessage(providerUserMsg('/COMPACT', 'u-compact-2') as never)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result')).toHaveLength(2)
      }, { timeout: 5000 })
      expect(requestCompact).toHaveBeenCalledTimes(2)
      expect(requests).toHaveLength(0)
    } finally {
      await session.destroy()
    }
  })

  it('/compact appears in supportedCommands as a builtin row', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const rows = (await fx.sm.supportedCommands(id)) as Array<{
      name: string; description: string; argumentHint: string; builtin?: boolean
    }>
    const compact = rows.filter((row) => row.name === 'compact')
    expect(compact).toHaveLength(1)
    expect(compact[0].builtin).toBe(true)
    expect(compact[0].description.length).toBeGreaterThan(0)
  })

  it('manager binding compacts IN PLACE: same id, manual boundary + summary, history retained', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(textTurn('first reply'))
    await sendAndWait(fx, id, frames, 'hello', 1)

    fx.scripts.push(textTurn('unused')) // the control turn must not stream
    await sendAndWait(fx, id, frames, '/compact', 2)
    // No model request carried the literal invocation (or ran for it at all).
    expect(fx.requests).toHaveLength(1)
    expect(JSON.stringify(fx.requests[0].messages)).not.toContain('/compact')

    // The manager's in-place flow owns the client-facing divider + summary.
    await vi.waitFor(() => {
      expect(frames.some((f) => f.type === 'system' && f.subtype === 'compact_boundary')).toBe(true)
    }, { timeout: 5000 })
    const boundary = frames.find((f) => f.subtype === 'compact_boundary')!
    expect(boundary.compact_metadata.trigger).toBe('manual')
    expect(summarizeForCompact).toHaveBeenCalledTimes(1)

    // SAME session id — no handoff replacement. Compact is an APPEND
    // (retain-history design): the ring keeps the pre-compact conversation
    // and the manual divider + summary append AFTER it, in that order.
    const live = (fx.sm as unknown as { sessions: Map<string, { history: Frame[] }> }).sessions
    expect(live.has(id)).toBe(true)
    const ring = live.get(id)!.history
    const helloIdx = ring.findIndex((f) => f.type === 'user' && f.message?.content === 'hello')
    const boundaryIdx = ring.findIndex((f) => f.type === 'system' && f.subtype === 'compact_boundary')
    const summaryIdx = ring.findIndex((f) => f.type === 'user' && f.isCompactSummary === true && f.message?.content === 'MOCK SUMMARY')
    expect(helloIdx).toBeGreaterThanOrEqual(0)
    expect(boundaryIdx).toBeGreaterThan(helloIdx)
    expect(summaryIdx).toBeGreaterThan(boundaryIdx)

    // Durable half: the append-only session/compact boundary plus the raw
    // typed turns (the /compact prompt itself stays in the log).
    await vi.waitFor(() => {
      const snapshot = loadNativeSessionLogSync(stateDir, id)
      expect(snapshot).not.toBeNull()
      expect(neutralEventsOf(snapshot!).some((e) => e.type === 'session/compact' && e.data.text === 'MOCK SUMMARY')).toBe(true)
    }, { timeout: 5000 })
    expect(rawUserEvents(stateDir, id).map((e) => e.text)).toEqual(['hello', '/compact'])
    // D8: one summary identity for both halves — the live summary frame and
    // the durable compact event share summaryUuid; the boundary frame keeps
    // the event uuid (distinct from the summary). The retain marker fences
    // the reader's render floor off this compact.
    const compact = neutralEventsOf(loadNativeSessionLogSync(stateDir, id)!)
      .find((e): e is Extract<NativeSessionEvent, { type: 'session/compact' }> => e.type === 'session/compact')!
    expect(compact.data.retainHistory).toBe(true)
    expect(ring[summaryIdx].uuid).toBe(compact.data.summaryUuid)
    expect(ring[boundaryIdx].uuid).toBe(compact.data.uuid)
    expect(ring[summaryIdx].uuid).not.toBe(ring[boundaryIdx].uuid)

    // The next turn runs against the floored MODEL history: the old
    // conversation is gone from the request, the summary is present — while
    // the transcript above still shows the retained pre-compact turns.
    fx.scripts.push(textTurn('after compact'))
    await sendAndWait(fx, id, frames, 'continue', 3)
    const last = fx.requests.at(-1)!
    expect(JSON.stringify(last.messages)).not.toContain('first reply')
    expect(JSON.stringify(last.messages)).toContain('MOCK SUMMARY')
    expect(last.messages.at(-1)).toEqual(userTextMessage('continue'))
    unsubscribe()
  }, 20000)

  it('/compact queued behind a live turn compacts once the session settles idle', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    installGatedStreamer(fx, gate)

    fx.scripts.push(textTurn('first reply'))
    await fx.sm.send(id, 'hello') // parked on the gate — turn in flight
    await fx.sm.send(id, '/compact') // queued behind it
    release()

    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(2)
    }, { timeout: 5000 })
    await vi.waitFor(() => {
      expect(frames.some((f) => f.type === 'system' && f.subtype === 'compact_boundary')).toBe(true)
    }, { timeout: 5000 })
    expect(summarizeForCompact).toHaveBeenCalledTimes(1)
    expect(fx.requests).toHaveLength(1) // only 'hello' streamed
    unsubscribe()
  }, 20000)

  it('input queued BEHIND /compact keeps the session working: compaction skips (auto-path gating)', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    installGatedStreamer(fx, gate)

    fx.scripts.push(textTurn('first reply'), textTurn('next reply'))
    await fx.sm.send(id, 'hello') // parked on the gate — turn in flight
    await fx.sm.send(id, '/compact') // queued, then…
    await fx.sm.send(id, 'next') // …queued BEHIND the control turn
    release()

    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(3)
    }, { timeout: 5000 })
    // The idle gate refused the compact (queued input) — exactly the
    // auto-compact behavior; the next turn ran against uncompacted history.
    expect(summarizeForCompact).not.toHaveBeenCalled()
    expect(frames.some((f) => f.subtype === 'compact_boundary')).toBe(false)
    expect(fx.requests).toHaveLength(2)
    expect(JSON.stringify(fx.requests[1].messages)).toContain('first reply')
    unsubscribe()
  }, 20000)
})