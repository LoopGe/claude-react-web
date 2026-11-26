// server/providers/native/hooks/transcript.test.ts
// T22: the transcript_path projection artifact + prompt/agent transcript context.
// The durable log stays neutral v3; hooks read a CLI-shaped JSONL projection
// (neutral events → SDK RawLines via the host history-read seam, injected as a
// projection function so the core never imports the host adapter). The prompt
// evaluator receives the conversation transcript prepended before its verdict
// question (RS §6.1, budget-truncated); the agent evaluator receives the
// artifact path in its system text (RS §6.2). Every hook stdin carries
// transcript_path (BaseHookInput, RS §3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TranscriptMaterializer,
  hookTranscriptMessages,
  sidechainTranscriptArtifactPath,
  transcriptArtifactPath,
} from './transcript.js'
import { projectNativeEventToSdkLine } from '../../native-host-frame-adapter.js'
import { brandString } from '../vocabulary/brand.js'
import type { ContentBlock, TokenUsage } from '../vocabulary/types.js'
import type { NativeSessionEvent } from '../vocabulary/session-event.js'
import type { RequestMessage } from '../vocabulary/message.js'
import type { RawLine } from '../../../../shared/transcript-format.js'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import type { CanonicalEvent } from '../canonical.js'
import type { SessionHooksConfig } from '../../../../shared/hooks.js'
import type { Frame } from '../../native-frames.js'

// A hook into the materializer's append IO so a test can land an event on the
// live array mid-write (the live-array race) or simulate a torn append. Every
// other fs/promises function stays the real implementation.
const appendHook = vi.hoisted(() => ({
  during: null as null | (() => void),
  torn: false,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs/promises')
  return {
    ...actual,
    appendFile: (async (path: string, data: string) => {
      appendHook.during?.()
      if (appendHook.torn) {
        // A partial write that corrupts the trailing line, then fails.
        await actual.appendFile(path, '{"torn":')
        throw new Error('disk full')
      }
      return actual.appendFile(path, data)
    }) as typeof actual.appendFile,
  }
})

const TS = '2026-11-26T00:00:00.000Z'
const TIME = Date.parse(TS)
const msgId = (id: string) => brandString<'MessageId'>(id)
const callId = (id: string) => brandString<'ToolCallId'>(id)
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const toolCall = (id: string, name = 'Read'): ContentBlock => ({ type: 'tool-call', id: callId(id), name, arguments: '{}' })

// ── neutral event-corpus helpers (same shapes as replay.test.ts) ───────────
const user = (seq: number, t: string, uuid = `u${seq}`, parent: string | null = null): NativeSessionEvent => ({
  type: 'user/message', seq, time: TIME, parentToolUseId: parent,
  data: { role: 'user', id: msgId(uuid), content: [text(t)], source: { kind: 'user' } },
})
const assistant = (seq: number, content: ContentBlock[], uuid = `a${seq}`, parent: string | null = null): NativeSessionEvent => ({
  type: 'assistant/message', seq, time: TIME, parentToolUseId: parent,
  data: { message: { role: 'assistant', id: msgId(uuid), content, source: { kind: 'model', provider: 'anthropic', model: 'm' } }, stream: [] },
})
const toolResult = (seq: number, id: string, t = 'ok', uuid = `r${seq}`, parent: string | null = null): NativeSessionEvent => ({
  type: 'tool/result', seq, time: TIME, parentToolUseId: parent,
  data: { message: { role: 'tool', id: msgId(uuid), source: { kind: 'tool', callId: callId(id) }, toolCallId: callId(id), content: [text(t)], isError: false } },
})
const contextEvent = (seq: number): NativeSessionEvent => ({ type: 'session/context', seq, time: TIME, data: { text: 'ctx' } })
const turnEnd = (seq: number): NativeSessionEvent => ({ type: 'turn/end', seq, time: TIME, data: { reason: 'completed' } })

const tempDirs: string[] = []
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
  return dir
}

/** Redirect user-scope skill discovery at a temp empty dir so the developer's
 *  real ~/.claude/skills can never leak in (pristine output). */
let skillsConfigDir: string
let previousConfigDir: string | undefined
beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-tx-config-'))
  await mkdir(join(skillsConfigDir, 'skills'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = skillsConfigDir
})
afterEach(async () => {
  appendHook.during = null
  appendHook.torn = false
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(skillsConfigDir, { recursive: true, force: true })
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function materializer(stateDir: string, sessionId: string, path = transcriptArtifactPath(stateDir, sessionId)): TranscriptMaterializer {
  return new TranscriptMaterializer({ path, sessionId, project: projectNativeEventToSdkLine })
}

async function readLines(path: string): Promise<RawLine[]> {
  const raw = await readFile(path, 'utf8')
  return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as RawLine)
}

describe('TranscriptMaterializer — CLI-JSONL projection artifact', () => {
  it('projects a turn to user/assistant/tool_result SDK-shaped JSONL lines', async () => {
    const dir = await tempDir('tx-mat-')
    const mat = materializer(dir, 's1')
    const events = [
      contextEvent(0),
      user(1, 'review the diff'),
      assistant(2, [toolCall('t1')]),
      toolResult(3, 't1', 'diff contents'),
      assistant(4, [text('looks good')]),
      turnEnd(5),
    ]
    const path = await mat.materialize(events)
    expect(path).toBe(transcriptArtifactPath(dir, 's1'))
    const lines = await readLines(path)
    // Operational events (context / turn-end) project to null — only the four
    // message events become CLI transcript lines.
    expect(lines).toHaveLength(4)
    expect(lines[0].type).toBe('user')
    expect(lines[0].message?.role).toBe('user')
    expect(lines[1].type).toBe('assistant')
    expect(lines[1].message?.role).toBe('assistant')
    // The tool result is a user-role line carrying a tool_result block (the
    // exact legacy SDK shape the host history path consumes).
    expect(lines[2].type).toBe('user')
    const trContent = lines[2].message?.content as Array<{ type: string; tool_use_id: string }>
    expect(trContent[0].type).toBe('tool_result')
    expect(trContent[0].tool_use_id).toBe('t1')
    expect(lines[3].type).toBe('assistant')
    // Every line carries the session identity.
    for (const line of lines) expect(line.session_id).toBe('s1')
  })

  it('returns a stable path across calls', async () => {
    const dir = await tempDir('tx-stable-')
    const mat = materializer(dir, 's1')
    const p1 = await mat.materialize([user(0, 'a')])
    const p2 = await mat.materialize([user(0, 'a'), assistant(1, [text('b')])])
    expect(p1).toBe(p2)
    expect(p1).toBe(transcriptArtifactPath(dir, 's1'))
  })

  it('reflects appended events on re-materialize (incremental, prefix intact)', async () => {
    const dir = await tempDir('tx-append-')
    const mat = materializer(dir, 's1')
    const u = user(0, 'first')
    await mat.materialize([u])
    expect(await readLines(transcriptArtifactPath(dir, 's1'))).toHaveLength(1)
    // Same leading event reference + a new tail → append, prefix unchanged.
    await mat.materialize([u, assistant(1, [text('second')])])
    const lines = await readLines(transcriptArtifactPath(dir, 's1'))
    expect(lines).toHaveLength(2)
    expect((lines[0].message?.content as Array<{ text: string }>)[0].text).toBe('first')
    expect(lines[1].type).toBe('assistant')
  })

  it('rebuilds when the event list shrinks (durable rollback)', async () => {
    const dir = await tempDir('tx-shrink-')
    const mat = materializer(dir, 's1')
    const u = user(0, 'keep')
    await mat.materialize([u, assistant(1, [text('drop')]), toolResult(2, 't1')])
    expect(await readLines(transcriptArtifactPath(dir, 's1'))).toHaveLength(3)
    await mat.materialize([u])
    const lines = await readLines(transcriptArtifactPath(dir, 's1'))
    expect(lines).toHaveLength(1)
    expect(lines[0].type).toBe('user')
  })

  it('rebuilds when the boundary event identity changes (same-length rewrite)', async () => {
    const dir = await tempDir('tx-rewrite-')
    const mat = materializer(dir, 's1')
    const u = user(0, 'q')
    await mat.materialize([u, assistant(1, [text('old')], 'a1')])
    // Same length, different trailing event reference → full rebuild.
    await mat.materialize([u, assistant(1, [text('new')], 'a2')])
    const lines = await readLines(transcriptArtifactPath(dir, 's1'))
    expect(lines).toHaveLength(2)
    expect((lines[1].message?.content as Array<{ text: string }>)[0].text).toBe('new')
  })

  it('projects a sidechain slice to a separate per-agent artifact', async () => {
    const dir = await tempDir('tx-side-')
    const agentId = 'toolu_agent1'
    const path = sidechainTranscriptArtifactPath(dir, 's1', agentId)
    const mat = materializer(dir, 's1', path)
    const events = [
      user(0, 'main prompt'),
      assistant(1, [toolCall(agentId, 'Agent')]),
      user(2, 'subagent prompt', 'su0', agentId),
      assistant(3, [text('subagent answer')], 'sa1', agentId),
    ]
    const sidechain = events.filter((e) => e.parentToolUseId === agentId)
    const returned = await mat.materialize(sidechain)
    expect(returned).toBe(path)
    expect(path).not.toBe(transcriptArtifactPath(dir, 's1'))
    const lines = await readLines(path)
    expect(lines).toHaveLength(2)
    expect(lines[0].type).toBe('user')
    expect(lines[1].type).toBe('assistant')
  })

  it('does not drop events appended to the live array while a write is in flight', async () => {
    const dir = await tempDir('tx-race-')
    const mat = materializer(dir, 's1')
    const events: NativeSessionEvent[] = [user(0, 'first')]
    await mat.materialize(events) // full rebuild, count = 1
    events.push(assistant(1, [text('second')]))
    // A third event lands on the LIVE array during the append IO. The end index
    // was captured before the await, so it must NOT be counted as written.
    appendHook.during = () => { events.push(assistant(2, [text('third')])) }
    await mat.materialize(events)
    appendHook.during = null
    // The next dispatch appends the in-flight event instead of dropping it.
    await mat.materialize(events)
    const lines = await readLines(transcriptArtifactPath(dir, 's1'))
    expect(lines).toHaveLength(3)
    expect(JSON.stringify(lines)).toContain('second')
    expect(JSON.stringify(lines)).toContain('third')
  })

  it('rebuilds atomically after a torn append (no corrupt trailing line)', async () => {
    const dir = await tempDir('tx-torn-')
    const mat = materializer(dir, 's1')
    const events: NativeSessionEvent[] = [user(0, 'first')]
    await mat.materialize(events)
    events.push(assistant(1, [text('second')]))
    // The append writes a partial corrupt line then fails.
    appendHook.torn = true
    await expect(mat.materialize(events)).rejects.toThrow('disk full')
    appendHook.torn = false
    // The next call must take the atomic rebuild path, not append after the
    // corrupt line — the artifact parses cleanly to the full current log.
    await mat.materialize(events)
    const raw = await readFile(transcriptArtifactPath(dir, 's1'), 'utf8')
    expect(raw).not.toContain('torn')
    const lines = await readLines(transcriptArtifactPath(dir, 's1'))
    expect(lines).toHaveLength(2)
    expect(JSON.stringify(lines)).toContain('first')
    expect(JSON.stringify(lines)).toContain('second')
  })
})

describe('hookTranscriptMessages — prompt evaluator transcript budget (RS §6.1 kTr)', () => {
  const big = (chars: number) => 'x'.repeat(chars)
  const usage = (total: number): TokenUsage => ({ inputTokens: total, outputTokens: 0 })

  it('keeps a small history unchanged via the last-usage fast path', () => {
    const history: RequestMessage[] = [
      { role: 'user', content: [text('question')] },
      { role: 'assistant', content: [text('answer')], source: { kind: 'model', provider: 'anthropic', model: 'm' }, id: msgId('a') } as RequestMessage,
    ]
    const out = hookTranscriptMessages(history, 'claude-haiku-4-5', usage(1000))
    expect(out).toEqual(history)
  })

  it('keeps a small history unchanged when the estimate fits (no usage)', () => {
    const history: RequestMessage[] = [{ role: 'user', content: [text('tiny')] }]
    const out = hookTranscriptMessages(history, 'claude-haiku-4-5', null)
    expect(out).toEqual(history)
  })

  it('truncates over-budget history to the tail and prepends the CLI marker', () => {
    // Budget = floor(200000 * 0.5) = 100000 tokens. Two ~75000-token assistant
    // rounds: the tail round fits, the next would exceed → keep only the tail.
    const history: RequestMessage[] = [
      { role: 'user', content: [text('early question')] },
      { role: 'assistant', content: [text(big(300_000))], source: { kind: 'model', provider: 'anthropic', model: 'm' }, id: msgId('a1') } as RequestMessage,
      { role: 'assistant', content: [text(big(300_000))], source: { kind: 'model', provider: 'anthropic', model: 'm' }, id: msgId('a2') } as RequestMessage,
    ]
    const out = hookTranscriptMessages(history, 'claude-haiku-4-5', null)
    // marker + the kept tail round; the user message and first round are dropped.
    expect(out).toHaveLength(2)
    const marker = out[0]
    expect(marker.role).toBe('user')
    const markerText = (marker.content[0] as { text: string }).text
    expect(markerText).toContain('Earlier conversation truncated to fit the hook evaluator')
    expect(markerText).toContain('2 earlier messages omitted')
    expect(markerText).toContain('insufficient evidence in transcript')
    expect((out[1].content[0] as { text: string }).text).toBe(big(300_000))
  })

  it('uses the 1M window for a [1m] model (no truncation of a 100K-token history)', () => {
    const history: RequestMessage[] = [
      { role: 'assistant', content: [text(big(300_000))], source: { kind: 'model', provider: 'anthropic', model: 'm' }, id: msgId('a1') } as RequestMessage,
    ]
    // 75000 tokens < floor(1000000 * 0.5) = 500000 → kept whole, no marker.
    const out = hookTranscriptMessages(history, 'claude-opus-4-8[1m]', null)
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('assistant')
  })
})

// ── Integration: real provider, hook stdin + prompt/agent transcript context ──

interface CapturedReq {
  model: string
  system: string
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
  outputFormat?: unknown
}

function textTurn(t: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text: t } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function verdictToolTurn(): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: 'so-1', name: 'StructuredOutput' } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify({ ok: true, reason: 'met' }) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

let userMsgSeq = 0
function userMsg(t: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text', text: t }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid: `u-${++userMsgSeq}`,
  }
}

/** Drive one text turn through the real provider with the given Stop hooks.
 *  The test stream scripts the main round, the prompt verdict round (no tools)
 *  and the agent verdict round (StructuredOutput tool), capturing every req. */
async function runStopHookTurn(hooks: SessionHooksConfig): Promise<{ dir: string; reqs: CapturedReq[]; frames: Frame[] }> {
  const dir = await tempDir('tx-int-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const reqs: CapturedReq[] = []
  provider._testStream = (req) => {
    reqs.push(req as unknown as CapturedReq)
    const isAgent = req.tools.some((t) => (t as { name: string }).name === 'StructuredOutput')
    const isPrompt = req.tools.length === 0
    const events = isAgent ? verdictToolTurn() : isPrompt ? textTurn('{"ok":true,"reason":"transcript evidence"}') : textTurn('answer')
    return (async function* () { for (const ev of events) yield ev })()
  }
  const session = provider.createSession({
    id: 'tx',
    cwd: dir,
    providerExtras: { sdkOptions: { settings: { hooks } } },
    canUseTool: async (_n: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
  })
  const frames: Frame[] = []
  void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
  try {
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    }, { timeout: 15_000 })
  } finally {
    await session.destroy()
  }
  return { dir, reqs, frames }
}

function stopHooks(command: string): SessionHooksConfig {
  return { Stop: [{ matcher: '', hooks: [{ type: 'command', command, shell: 'bash' }] }] }
}

describe('hook stdin transcript_path (BaseHookInput, RS §3)', () => {
  it('a Stop command hook receives transcript_path pointing at the CLI-JSONL artifact of the current turn', async () => {
    const { dir } = await runStopHookTurn(stopHooks('cat > stop-stdin.json'))
    const stdin = JSON.parse(await readFile(join(dir, 'stop-stdin.json'), 'utf8')) as Record<string, unknown>
    const path = transcriptArtifactPath(dir, 'tx')
    expect(stdin.transcript_path).toBe(path)
    expect(stdin.hook_event_name).toBe('Stop')
    // The artifact reflects the turn that just ran (user prompt + assistant answer).
    const lines = await readLines(path)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(lines)).toContain('go')
    expect(JSON.stringify(lines)).toContain('answer')
  }, 30_000)

  it('a UserPromptSubmit command hook also carries transcript_path', async () => {
    const dir = await tempDir('tx-ups-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    provider._testStream = () => (async function* () { for (const ev of textTurn('answer')) yield ev })()
    const hooks: SessionHooksConfig = { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'cat > ups-stdin.json', shell: 'bash' }] }] }
    const session = provider.createSession({
      id: 'tx', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks } } },
      canUseTool: async (_n: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('go') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1), { timeout: 15_000 })
    } finally {
      await session.destroy()
    }
    const stdin = JSON.parse(await readFile(join(dir, 'ups-stdin.json'), 'utf8')) as Record<string, unknown>
    expect(stdin.transcript_path).toBe(transcriptArtifactPath(dir, 'tx'))
  }, 30_000)
})

describe('prompt evaluator transcript context (RS §6.1)', () => {
  it('prepends the conversation transcript before the verdict question', async () => {
    const hooks: SessionHooksConfig = { Stop: [{ matcher: '', hooks: [{ type: 'prompt', prompt: 'the assistant answered' }] }] }
    const { reqs } = await runStopHookTurn(hooks)
    const promptReq = reqs.find((r) => r.tools.length === 0 && r.outputFormat !== undefined)
    expect(promptReq).toBeDefined()
    const msgs = promptReq!.messages
    // More than the lone question: the transcript precedes it.
    expect(msgs.length).toBeGreaterThan(1)
    const wire = JSON.stringify(msgs)
    expect(wire).toContain('answer') // the assistant turn from the transcript
    expect(wire).toContain('the assistant answered') // the condition
    // The question is the LAST message (transcript prepended, not appended).
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe('user')
    expect(JSON.stringify(last.content)).toContain('stopping condition')
  }, 30_000)
})

describe('agent evaluator transcript path (RS §6.2)', () => {
  it('carries the artifact path in the system text transcript clause', async () => {
    const hooks: SessionHooksConfig = { Stop: [{ matcher: '', hooks: [{ type: 'agent', prompt: 'the assistant answered' }] }] }
    const { dir, reqs } = await runStopHookTurn(hooks)
    const agentReq = reqs.find((r) => r.tools.some((t) => t.name === 'StructuredOutput'))
    expect(agentReq).toBeDefined()
    expect(agentReq!.system).toContain('The conversation transcript is available at:')
    expect(agentReq!.system).toContain(transcriptArtifactPath(dir, 'tx'))
  }, 30_000)
})

// ── SubagentStop: sidechain artifact + nested prompt transcript (T18 deferral) ──

const AGENT_TOOL_ID = 'agent-call-1'
function toolUseTurn(id: string, name: string, inputJson = '{}'): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: inputJson } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

describe('SubagentStop transcript projection (RS §3 agent_transcript_path)', () => {
  it('stamps the sidechain artifact path and feeds the nested transcript to the prompt evaluator', async () => {
    const dir = await tempDir('tx-sub-')
    const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
    const reqs: CapturedReq[] = []
    // Order-driven script queue: parent Agent round → nested report round →
    // SubagentStop prompt verdict round → parent closing round.
    const scripts: CanonicalEvent[][] = [
      toolUseTurn(AGENT_TOOL_ID, 'Agent', JSON.stringify({ description: 'd', prompt: 'nested-task' })),
      textTurn('nested-report'),
      textTurn('{"ok":true,"reason":"evidence"}'),
      textTurn('parent-done'),
    ]
    provider._testStream = (req) => {
      reqs.push(req as unknown as CapturedReq)
      const events = scripts.shift() ?? []
      return (async function* () { for (const ev of events) yield ev })()
    }
    const hooks: SessionHooksConfig = {
      SubagentStop: [
        { matcher: '', hooks: [
          { type: 'command', command: 'input=$(cat)\nprintf \'%s\\n\' "$input" >> sub-stop.jsonl', shell: 'bash' },
          { type: 'prompt', prompt: 'the subagent reported' },
        ] },
      ],
    }
    const session = provider.createSession({
      id: 'tx', cwd: dir,
      providerExtras: { sdkOptions: { settings: { hooks } } },
      canUseTool: async (_n: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
    })
    const frames: Frame[] = []
    void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
    try {
      session.enqueueUserMessage(userMsg('go') as never)
      await vi.waitFor(() => expect(frames.filter((f) => f.type === 'result')).toHaveLength(1), { timeout: 15_000 })
    } finally {
      await session.destroy()
    }
    // SubagentStop stdin carries BOTH the main transcript_path and the sidechain
    // agent_transcript_path keyed by the spawning tool_use id.
    const raw = await readFile(join(dir, 'sub-stop.jsonl'), 'utf8')
    const inputs = raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].hook_event_name).toBe('SubagentStop')
    expect(inputs[0].transcript_path).toBe(transcriptArtifactPath(dir, 'tx'))
    const agentPath = sidechainTranscriptArtifactPath(dir, 'tx', AGENT_TOOL_ID)
    expect(inputs[0].agent_transcript_path).toBe(agentPath)
    // The sidechain artifact holds ONLY the subagent's own conversation: every
    // line is attributed to the spawning tool_use id at dispatch time (a full-log
    // slice would also carry the main-thread lines whose parent is null).
    const sideLines = await readLines(agentPath)
    expect(sideLines.length).toBeGreaterThan(0)
    expect(JSON.stringify(sideLines)).toContain('nested-report')
    for (const line of sideLines) expect(line.parent_tool_use_id).toBe(AGENT_TOOL_ID)
    // The prompt evaluator received the NESTED transcript (not the main one).
    const promptReq = reqs.find((r) => r.tools.length === 0 && r.outputFormat !== undefined)
    expect(promptReq).toBeDefined()
    const wire = JSON.stringify(promptReq!.messages)
    expect(wire).toContain('nested-report')
    expect(wire).toContain('the subagent reported')
  }, 30_000)
})
