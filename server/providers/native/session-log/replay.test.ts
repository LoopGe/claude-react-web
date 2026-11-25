import { describe, expect, it } from 'vitest'
import { contextSnapshot, historyFromEvents, repairInterruptedTurn, repairRenderableLines } from './replay.js'
import { projectNativeHistoryToWire } from '../wire/wire-projection.js'
import { brandString } from '../vocabulary/brand.js'
import type { ContentBlock } from '../vocabulary/types.js'
import type { NativeSessionEvent } from '../vocabulary/session-event.js'
import type { RequestMessage } from '../vocabulary/message.js'
import type { RawLine } from '../../../../shared/transcript-format.js'

const TS = '2026-11-09T00:00:00.000Z'
const TIME = Date.parse(TS)
const msgId = (id: string) => brandString<'MessageId'>(id)
const callId = (id: string) => brandString<'ToolCallId'>(id)

// ── neutral event-corpus helpers ───────────────────────────────────────────
const context = (seq: number, text: string): NativeSessionEvent => ({ type: 'session/context', seq, time: 0, data: { text } })
const user = (seq: number, text: string, uuid = `u${seq}`, parent: string | null = null): NativeSessionEvent => ({
  type: 'user/message', seq, time: TIME, parentToolUseId: parent,
  data: { role: 'user', id: msgId(uuid), content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const assistant = (seq: number, content: ContentBlock[], uuid = `a${seq}`, parent: string | null = null): NativeSessionEvent => ({
  type: 'assistant/message', seq, time: TIME, parentToolUseId: parent,
  data: { message: { role: 'assistant', id: msgId(uuid), content, source: { kind: 'model', provider: 'anthropic', model: 'm' } }, stream: [] },
})
const toolResult = (seq: number, id: string, text = 'ok', isError = false, uuid = `r${seq}`, parent: string | null = null): NativeSessionEvent => ({
  type: 'tool/result', seq, time: TIME, parentToolUseId: parent,
  data: { message: { role: 'tool', id: msgId(uuid), source: { kind: 'tool', callId: callId(id) }, toolCallId: callId(id), content: [{ type: 'text', text }], isError } },
})
const compact = (seq: number, text: string): NativeSessionEvent => ({ type: 'session/compact', seq, time: TIME, data: { text, context: 'CTX', uuid: `c${seq}`, timestamp: TS } })
const supplement = (seq: number, text: string, uuid = `sp${seq}`): NativeSessionEvent => ({ type: 'session/supplement', seq, time: TIME, data: { uuid, text, timestamp: TS } })
const skill = (seq: number, body: string, name = 'alpha'): NativeSessionEvent => ({ type: 'session/skill', seq, time: TIME, data: { name, body, timestamp: TS } })
const turnEnd = (seq: number): NativeSessionEvent => ({ type: 'turn/end', seq, time: 0, data: { reason: 'completed' } })
const title = (seq: number, text: string): NativeSessionEvent => ({ type: 'session/title', seq, time: TIME, data: { title: text } })
const agentSelection = (seq: number, name: string | null): NativeSessionEvent => ({
  type: 'session/agent', seq, time: TIME,
  data: {
    name,
    ...(name === null ? {} : { definition: { name, description: 'Reviews code', prompt: 'Review the change carefully.', enabled: true, createdAt: 1, updatedAt: 2 } }),
    base: { model: 'claude-sonnet-4-5', permissionMode: 'default' },
    timestamp: TS,
  },
} as unknown as NativeSessionEvent)
const descriptor = (seq: number, toolUseId: string): NativeSessionEvent => ({
  type: 'subagent/descriptor', seq, time: TIME,
  data: { toolUseId, parentToolUseId: null, kind: 'agent', toolName: 'Agent', label: 'delegate', depth: 1, profile: null, timestamp: TS },
})
const toolCall = (id: string, name = 'Read'): ContentBlock => ({ type: 'tool-call', id: callId(id), name, arguments: '{}' })
const text = (t: string): ContentBlock => ({ type: 'text', text: t })

const wire = (history: RequestMessage[]) => projectNativeHistoryToWire(history, {}, new AbortController().signal)
const roles = (history: RequestMessage[]) => history.map((m) => m.role)

describe('neutral replay', () => {
  it('rebuilds neutral history, strips unsigned thinking and keeps tool results FIRST-CLASS (ungrouped)', async () => {
    const events = [
      context(0, 'ctx'), user(1, 'hi'),
      assistant(2, [{ type: 'reasoning', text: 'hmm' }, text('calling'), toolCall('t1'), toolCall('t2')]),
      toolResult(3, 't1'), toolResult(4, 't2'),
      assistant(5, [text('done')]),
      turnEnd(6),
    ]
    const history = historyFromEvents(events)
    // ctx, user, assistant, tool(t1), tool(t2), assistant — UNGROUPED.
    expect(roles(history)).toEqual(['user', 'user', 'assistant', 'tool', 'tool', 'assistant'])
    expect((history[2] as { content: readonly ContentBlock[] }).content.some((b) => b.type === 'reasoning')).toBe(false)
    // The wire adapter owns grouping: consecutive tool results merge into ONE
    // user message there.
    const messages = (await wire(history)) as Array<{ role: string; content: unknown[] }>
    expect(messages).toHaveLength(5)
    expect(messages[3].content).toHaveLength(2)
  })

  it('ignores agent selections without changing user, assistant, supplement, or tool-result replay', async () => {
    const events = [
      user(0, 'go'),
      assistant(1, [toolCall('t1'), toolCall('t2')]),
      agentSelection(2, 'reviewer'),
      toolResult(3, 't1'),
      agentSelection(4, null),
      toolResult(5, 't2'),
      supplement(6, 'WRAPPED GUIDANCE'),
      assistant(7, [text('done')]),
    ]
    const history = historyFromEvents(events)
    expect(roles(history)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant'])
    const messages = (await wire(history)) as Array<{ role: string; content: Array<{ tool_use_id?: string; text?: string }> }>
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['t1', 't2'])
    expect(messages[3].content).toEqual([{ type: 'text', text: 'WRAPPED GUIDANCE' }])
  })

  it('ignores subagent descriptors without producing history or splitting tool results', async () => {
    const events = [
      user(0, 'go'),
      assistant(1, [toolCall('agent-1', 'Agent'), toolCall('agent-2', 'Agent')]),
      descriptor(2, 'agent-1'),
      toolResult(3, 'agent-1'),
      descriptor(4, 'agent-2'),
      toolResult(5, 'agent-2'),
    ]
    const history = historyFromEvents(events)
    expect(roles(history)).toEqual(['user', 'assistant', 'tool', 'tool'])
    const messages = (await wire(history)) as Array<{ content: Array<{ tool_use_id?: string }> }>
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['agent-1', 'agent-2'])
  })

  it('ignores session/title events without changing model history', () => {
    const events = [user(0, 'go'), assistant(1, [text('reply')]), turnEnd(2)]
    expect(historyFromEvents([...events, title(3, 'Renamed')])).toEqual(historyFromEvents(events))
  })

  it('replays the raw prompt and persisted skill body verbatim without catalog rendering', async () => {
    const persistedBody = 'Base directory for this skill: /snapshot\n\nPERSISTED INSTRUCTIONS'
    const events = [user(0, '/alpha arguments-stay-only-here'), skill(1, persistedBody), user(2, 'LEGACY EXPANDED USER BODY')]
    const messages = (await wire(historyFromEvents(events))) as Array<{ content: Array<{ text?: string }> }>
    expect(messages.map((m) => m.content[0]?.text)).toEqual(['/alpha arguments-stay-only-here', persistedBody, 'LEGACY EXPANDED USER BODY'])
  })

  it('a session/skill instruction separates tool-result groups on the wire', async () => {
    const events = [user(0, '/alpha'), assistant(1, [toolCall('t1'), toolCall('t2')]), toolResult(2, 't1'), skill(3, 'PERSISTED SKILL BODY'), toolResult(4, 't2')]
    const messages = (await wire(historyFromEvents(events))) as Array<{ content: Array<{ tool_use_id?: string; text?: string }> }>
    expect(messages).toHaveLength(5)
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['t1'])
    expect(messages[3].content).toEqual([{ type: 'text', text: 'PERSISTED SKILL BODY' }])
    expect(messages[4].content.map((b) => b.tool_use_id)).toEqual(['t2'])
  })

  it('applies the compact floor to both the raw prompt and its skill body', async () => {
    const events = [user(0, '/before'), skill(1, 'PRE-COMPACT SKILL BODY'), compact(2, 'SUMMARY'), user(3, '/after'), skill(4, 'POST-COMPACT SKILL BODY')]
    const messages = (await wire(historyFromEvents(events))) as Array<{ content: Array<{ text?: string }> }>
    expect(messages.map((m) => m.content[0]?.text)).toEqual(['CTX', 'SUMMARY', '/after', 'POST-COMPACT SKILL BODY'])
  })

  it('keeps a signed reasoning block in the rebuilt neutral history', () => {
    const events = [
      user(1, 'hi'),
      assistant(2, [{ type: 'reasoning', text: 'signed thought', signature: 'sig-1' }, text('a')]),
      user(3, 'again'),
      assistant(4, [{ type: 'reasoning', text: 'unsigned thought' }, text('b')]),
    ]
    const history = historyFromEvents(events)
    expect((history[1] as { content: readonly ContentBlock[] }).content[0]).toEqual({ type: 'reasoning', text: 'signed thought', signature: 'sig-1' })
    expect((history[3] as { content: readonly ContentBlock[] }).content).toEqual([text('b')])
  })

  it('keeps a redacted reasoning block that carries data', () => {
    const events = [user(1, 'hi'), assistant(2, [{ type: 'reasoning', text: '', redacted: true, data: 'ENCRYPTED' }, text('a')])]
    const history = historyFromEvents(events)
    expect((history[1] as { content: readonly ContentBlock[] }).content).toEqual([{ type: 'reasoning', text: '', redacted: true, data: 'ENCRYPTED' }, text('a')])
  })

  it('strips an empty signature and an empty redacted payload', () => {
    const events = [
      user(1, 'hi'),
      assistant(2, [{ type: 'reasoning', text: 'empty sig', signature: '' }, text('a')]),
      user(3, 'again'),
      assistant(4, [{ type: 'reasoning', text: '', redacted: true, data: '' }, text('b')]),
    ]
    const history = historyFromEvents(events)
    expect((history[1] as { content: readonly ContentBlock[] }).content).toEqual([text('a')])
    expect((history[3] as { content: readonly ContentBlock[] }).content).toEqual([text('b')])
  })

  it('starts model history at the last compact event (context + text seed)', async () => {
    const events = [user(0, 'old'), assistant(1, [text('old reply')]), compact(2, 'SUMMARY'), user(3, 'new')]
    const history = historyFromEvents(events)
    expect(history).toHaveLength(3)
    const json = JSON.stringify(history)
    expect(json).not.toContain('old reply')
    expect(json).toContain('SUMMARY')
    const messages = (await wire(history)) as Array<{ content: Array<{ text?: string }> }>
    expect(messages[0].content).toEqual([{ type: 'text', text: 'CTX' }])
    expect(messages[1].content).toEqual([{ type: 'text', text: 'SUMMARY' }])
  })

  it('uses the LAST compact when several exist', () => {
    const events = [user(0, 'old'), compact(1, 'FIRST SUMMARY'), user(2, 'middle'), compact(3, 'SECOND SUMMARY'), user(4, 'new')]
    const json = JSON.stringify(historyFromEvents(events))
    expect(json).toContain('SECOND SUMMARY')
    expect(json).not.toContain('FIRST SUMMARY')
    expect(json).not.toContain('middle')
  })

  it('excludes sidechain events from the main model history', async () => {
    const events = [
      user(0, 'go'),
      assistant(1, [toolCall('agent1', 'Agent')]),
      user(2, 'INNER PROMPT', 'su2', 'agent1'),
      assistant(3, [text('INNER REPLY')], 'sa3', 'agent1'),
      toolResult(4, 'inner-tool', 'inner ok', false, 'sr4', 'agent1'),
      toolResult(5, 'agent1'),
    ]
    const history = historyFromEvents(events)
    expect(roles(history)).toEqual(['user', 'assistant', 'tool'])
    expect(JSON.stringify(history)).not.toContain('INNER')
    const messages = (await wire(history)) as Array<{ content: unknown[] }>
    expect(messages[2].content).toHaveLength(1)
  })

  it('replays a supplement verbatim at its position, separating tool-result groups', async () => {
    const events = [user(1, 'go'), assistant(2, [toolCall('t1'), toolCall('t2')]), toolResult(3, 't1'), supplement(4, 'WRAPPED GUIDANCE'), toolResult(5, 't2')]
    const messages = (await wire(historyFromEvents(events))) as Array<{ content: Array<{ tool_use_id?: string; text?: string }> }>
    expect(messages).toHaveLength(5)
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['t1'])
    expect(messages[3].content).toEqual([{ type: 'text', text: 'WRAPPED GUIDANCE' }])
    expect(messages[4].content.map((b) => b.tool_use_id)).toEqual(['t2'])
  })

  it('drops a supplement whose uuid is requeued as an ordinary user prompt', () => {
    const events = [
      user(1, 'go'),
      assistant(2, [toolCall('t1')]),
      toolResult(3, 't1'),
      supplement(4, 'WRAPPED GUIDANCE', 'steer-1'),
      user(5, 'plain steer', 'steer-1'),
      assistant(6, [text('done')]),
    ]
    const history = historyFromEvents(events)
    expect(history).toHaveLength(5)
    const json = JSON.stringify(history)
    expect(json).not.toContain('WRAPPED GUIDANCE')
    expect(json).toContain('plain steer')
  })

  it('keeps a delivered supplement when a following user event has a different uuid', async () => {
    const events = [user(1, 'go'), supplement(2, 'WRAPPED GUIDANCE', 'steer-1'), user(3, 'later prompt', 'u3')]
    const messages = (await wire(historyFromEvents(events))) as Array<{ content: Array<{ text?: string }> }>
    expect(messages.map((m) => m.content[0]?.text)).toEqual(['go', 'WRAPPED GUIDANCE', 'later prompt'])
  })

  it('preserves the FULL file attachment (modelForm is per-occurrence) through replay', () => {
    const attachment = {
      id: 'upload-1', name: 'notes.txt', size: 123, digest: 'f'.repeat(64),
      path: '/registry/notes.txt', mediaType: 'text/plain', modelForm: 'handle' as const,
    }
    const events: NativeSessionEvent[] = [
      { type: 'user/message', seq: 0, time: TIME, parentToolUseId: null, data: { role: 'user', id: msgId('structured'), content: [text('before'), { type: 'file', attachment }, text('after')], source: { kind: 'user' } } },
      { type: 'session/attachments', seq: 1, time: TIME, data: { attachments: [attachment], timestamp: TS } },
    ]
    const history = historyFromEvents(events)
    expect(history).toHaveLength(1)
    // The catalog event is metadata; the occurrence keeps its full resolved
    // attachment verbatim (the catalog alone cannot recover modelForm/path).
    expect((history[0] as { content: readonly ContentBlock[] }).content[1]).toEqual({ type: 'file', attachment })
  })

  it('keeps canonical file blocks synchronous and ignores attachment catalogs without splitting tool results', async () => {
    const attachment = {
      id: 'upload-1', name: 'notes.txt', size: 123, digest: 'f'.repeat(64),
      path: '/registry/notes.txt', mediaType: 'text/plain', modelForm: 'handle' as const,
    }
    const events: NativeSessionEvent[] = [
      { type: 'user/message', seq: 0, time: TIME, parentToolUseId: null, data: { role: 'user', id: msgId('structured'), content: [text('before'), { type: 'file', attachment }, text('after')], source: { kind: 'user' } } },
      assistant(1, [toolCall('t1'), toolCall('t2')]),
      toolResult(2, 't1'),
      { type: 'session/attachments', seq: 3, time: TIME, data: { attachments: [attachment], timestamp: TS } },
      toolResult(4, 't2'),
    ]
    const history = historyFromEvents(events)
    expect(roles(history)).toEqual(['user', 'assistant', 'tool', 'tool'])
    const messages = (await wire(history)) as Array<{ content: Array<{ tool_use_id?: string }> }>
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['t1', 't2'])
  })
})

describe('repairInterruptedTurn (neutral)', () => {
  it('synthesizes a first-class neutral tool/result for every unanswered tool-call', () => {
    const events = [user(0, 'go'), assistant(1, [toolCall('t1'), toolCall('t2')])]
    const { synthetic } = repairInterruptedTurn(events)
    expect(synthetic.map((e) => e.data.message.toolCallId)).toEqual([callId('t1'), callId('t2')])
    for (const event of synthetic) {
      expect(event.type).toBe('tool/result')
      expect(event.parentToolUseId).toBeNull()
      expect(event.data.message.role).toBe('tool')
      expect(event.data.message.isError).toBe(true)
      expect(event.data.message.content).toEqual([{ type: 'text', text: 'tool result missing (session interrupted)' }])
      // The minted message id is the durable uuid the legacy projection stamps.
      expect(event.data.message.id).toBeTruthy()
    }
  })
  it('returns no synthetic events for a complete turn', () => {
    expect(repairInterruptedTurn([user(0, 'go'), assistant(1, [toolCall('t1')]), toolResult(2, 't1')]).synthetic).toEqual([])
  })
  it('does not synthesize a result for an unanswered sidechain tool-call', () => {
    const events = [
      user(0, 'go'),
      assistant(1, [toolCall('inner')], 'sa1', 'agent1'),
      assistant(2, [toolCall('outer')]),
    ]
    expect(repairInterruptedTurn(events).synthetic.map((e) => e.data.message.toolCallId)).toEqual([callId('outer')])
  })
  it('a sidechain tool/result does not answer a main-thread tool-call', () => {
    const events = [
      assistant(0, [toolCall('outer')]),
      toolResult(1, 'outer', 'inner ok', false, 'sr1', 'agent1'),
    ]
    expect(repairInterruptedTurn(events).synthetic.map((e) => e.data.message.toolCallId)).toEqual([callId('outer')])
  })
  it('ignores an unanswered tool-call before the last compact', () => {
    const events = [assistant(0, [toolCall('pre')]), compact(1, 'SUMMARY'), user(2, 'new')]
    expect(repairInterruptedTurn(events).synthetic).toEqual([])
  })
  it('honors the injected clock for the synthetic envelope time', () => {
    const now = () => new Date('2026-11-09T00:00:00.000Z')
    const { synthetic } = repairInterruptedTurn([assistant(0, [toolCall('t1')])], { now })
    expect(synthetic[0].time).toBe(Date.parse('2026-11-09T00:00:00.000Z'))
  })
})

describe('repairRenderableLines', () => {
  const line = (type: 'user' | 'assistant', content: unknown[]): RawLine => ({
    type,
    uuid: `${type}-line`,
    session_id: 's',
    message: { role: type, content },
  })
  const now = () => new Date('2026-11-09T00:00:00.000Z')

  it('adds a synthetic tool_result line for an unanswered tool_use', () => {
    const synthetic = repairRenderableLines([line('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }])], { now })
    expect(synthetic).toHaveLength(1)
    expect(synthetic[0]).toMatchObject({
      type: 'user',
      session_id: 's',
      parent_tool_use_id: null,
      timestamp: '2026-11-09T00:00:00.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          is_error: true,
          content: [{ type: 'text', text: 'tool result missing (session interrupted)' }],
        }],
      },
    })
    expect(synthetic[0].uuid).toBeTruthy()
  })

  it('skips sidechain lines both when collecting and when answering', () => {
    const synthetic = repairRenderableLines([
      {
        type: 'assistant', uuid: 'side', session_id: 's', parent_tool_use_id: 'agent1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'inner', name: 'Read', input: {} }] },
      },
      {
        // A sidechain result must not answer a main-thread tool_use.
        type: 'user', uuid: 'side-answer', session_id: 's', parent_tool_use_id: 'agent1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'outer', content: [], is_error: false }] },
      },
      {
        type: 'assistant', uuid: 'top', session_id: 's', parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'outer', name: 'Read', input: {} }] },
      },
    ], { now })
    expect(synthetic).toHaveLength(1)
    expect(synthetic[0]).toMatchObject({
      parent_tool_use_id: null,
      message: { content: [{ tool_use_id: 'outer' }] },
    })
  })

  it('returns no lines when every tool_use is answered', () => {
    const lines = [
      line('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      line('user', [{ type: 'tool_result', tool_use_id: 't1', content: [], is_error: false }]),
    ]
    expect(repairRenderableLines(lines, { now })).toEqual([])
  })
})

describe('contextSnapshot', () => {
  it('renders the working directory as a system reminder', () => {
    const snapshot = contextSnapshot('/repo')
    expect(snapshot).toContain('<system-reminder>Working directory: /repo\nCurrent time: ')
    expect(snapshot).toContain('</system-reminder>')
  })
})