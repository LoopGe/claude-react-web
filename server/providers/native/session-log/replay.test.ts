import { describe, expect, it } from 'vitest'
import { contextSnapshot, historyFromEvents, repairInterruptedTurn, repairRenderableLines } from './replay.js'
import { parseEventLine } from './format.js'
import type { NativeLogEvent } from './format.js'
import type { RawLine } from '../../../history-reader.js'

const lost = { seq: 0, type: 'session/context', text: 'ctx' } as const
const user = (seq: number, text: string): NativeLogEvent => ({ seq, type: 'user', uuid: `u${seq}`, session_id: 's', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text }] } })
const assistant = (seq: number, content: unknown[]): NativeLogEvent => ({ seq, type: 'assistant', uuid: `a${seq}`, session_id: 's', parent_tool_use_id: null, timestamp: 't', message: { role: 'assistant', content } })
const compact = (seq: number, text: string): NativeLogEvent => ({ seq, type: 'session/compact', text, context: 'CTX', uuid: `c${seq}`, timestamp: 't' })
const result = (seq: number, id: string): NativeLogEvent => ({ seq, type: 'user', uuid: `r${seq}`, session_id: 's', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }], is_error: false }] } })
const sideAssistant = (seq: number, content: unknown[]): NativeLogEvent => ({ seq, type: 'assistant', uuid: `sa${seq}`, session_id: 's', parent_tool_use_id: 'agent1', timestamp: 't', message: { role: 'assistant', content } })
const sideResult = (seq: number, id: string): NativeLogEvent => ({ seq, type: 'user', uuid: `sr${seq}`, session_id: 's', parent_tool_use_id: 'agent1', timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'inner ok' }], is_error: false }] } })
const sideUser = (seq: number, text: string): NativeLogEvent => ({ seq, type: 'user', uuid: `su${seq}`, session_id: 's', parent_tool_use_id: 'agent1', timestamp: 't', message: { role: 'user', content: [{ type: 'text', text }] } })

const supplement = (seq: number, text: string, uuid = `sp${seq}`): NativeLogEvent => ({ seq, type: 'session/supplement', uuid, text, timestamp: 't' })
const skillInvocation = (seq: number, body: string, name = 'alpha'): NativeLogEvent => parseEventLine({
  seq,
  type: 'session/skill',
  name,
  body,
  timestamp: 't',
}, seq, 's', 'p')
const userWithUuid = (seq: number, text: string, uuid: string): NativeLogEvent => ({
  seq, type: 'user', uuid, session_id: 's', parent_tool_use_id: null, timestamp: 't',
  message: { role: 'user', content: [{ type: 'text', text }] },
})

const agentSelection = (seq: number, name: string | null): NativeLogEvent => parseEventLine({
  seq,
  type: 'session/agent',
  name,
  ...(name === null ? {} : {
    definition: {
      name,
      description: 'Reviews code',
      prompt: 'Review the change carefully.',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
    },
  }),
  base: { model: 'claude-sonnet-4-5', permissionMode: 'default' },
  timestamp: 't',
}, seq, 's', 'p')

const subagentDescriptor = (seq: number, toolUseId: string): NativeLogEvent => parseEventLine({
  seq,
  type: 'subagent/descriptor',
  toolUseId,
  parentToolUseId: null,
  kind: 'agent',
  toolName: 'Agent',
  label: 'delegate',
  depth: 1,
  profile: null,
  timestamp: 't',
}, seq, 's', 'p')

describe('replay', () => {
  it('rebuilds history, strips unsigned thinking and merges consecutive tool results', () => {
    const events = [
      lost, user(1, 'hi'),
      assistant(2, [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'calling' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
      result(3, 't1'), result(4, 't2'),
      assistant(5, [{ type: 'text', text: 'done' }]),
      { seq: 6, type: 'turn/end', reason: 'completed' } as const,
    ]
    const messages = historyFromEvents(events) as Array<{ role: string; content: unknown[] }>
    expect(messages).toHaveLength(5) // ctx, user, assistant, merged tool results, assistant
    expect(messages[2].content.some((b) => (b as { type: string }).type === 'thinking')).toBe(false)
    expect(messages[3].content).toHaveLength(2)
  })
  it('ignores agent selections without changing user, assistant, supplement, or tool-result replay', () => {
    const events = [
      user(0, 'go'),
      assistant(1, [
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'tool_use', id: 't2', name: 'Read', input: {} },
      ]),
      agentSelection(2, 'reviewer'),
      result(3, 't1'),
      agentSelection(4, null),
      result(5, 't2'),
      supplement(6, 'WRAPPED GUIDANCE'),
      assistant(7, [{ type: 'text', text: 'done' }]),
    ]

    expect(historyFromEvents(events)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], is_error: false },
          { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'ok' }], is_error: false },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'WRAPPED GUIDANCE' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ])
  })
  it('ignores subagent descriptors without producing history or splitting tool results', () => {
    const events = [
      user(0, 'go'),
      assistant(1, [
        { type: 'tool_use', id: 'agent-1', name: 'Agent', input: {} },
        { type: 'tool_use', id: 'agent-2', name: 'Agent', input: {} },
      ]),
      subagentDescriptor(2, 'agent-1'),
      result(3, 'agent-1'),
      subagentDescriptor(4, 'agent-2'),
      result(5, 'agent-2'),
    ]

    expect(historyFromEvents(events)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'agent-1', name: 'Agent', input: {} },
          { type: 'tool_use', id: 'agent-2', name: 'Agent', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'agent-1', content: [{ type: 'text', text: 'ok' }], is_error: false },
          { type: 'tool_result', tool_use_id: 'agent-2', content: [{ type: 'text', text: 'ok' }], is_error: false },
        ],
      },
    ])
  })
  it('replays the raw prompt and persisted skill body verbatim without catalog rendering', () => {
    const persistedBody = 'Base directory for this skill: /snapshot\n\nPERSISTED INSTRUCTIONS'
    const events = [
      user(0, '/alpha arguments-stay-only-here'),
      skillInvocation(1, persistedBody),
      user(2, 'LEGACY EXPANDED USER BODY'),
    ]

    expect(historyFromEvents(events)).toEqual([
      { role: 'user', content: [{ type: 'text', text: '/alpha arguments-stay-only-here' }] },
      { role: 'user', content: [{ type: 'text', text: persistedBody }] },
      { role: 'user', content: [{ type: 'text', text: 'LEGACY EXPANDED USER BODY' }] },
    ])
  })
  it('closes an open tool-result group at a session/skill instruction', () => {
    const events = [
      user(0, '/alpha'),
      assistant(1, [
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'tool_use', id: 't2', name: 'Read', input: {} },
      ]),
      result(2, 't1'),
      skillInvocation(3, 'PERSISTED SKILL BODY'),
      result(4, 't2'),
    ]

    const messages = historyFromEvents(events) as Array<{
      role: string
      content: Array<{ type?: string; text?: string; tool_use_id?: string }>
    }>
    expect(messages).toHaveLength(5)
    expect(messages[2].content.map((block) => block.tool_use_id)).toEqual(['t1'])
    expect(messages[3]).toEqual({ role: 'user', content: [{ type: 'text', text: 'PERSISTED SKILL BODY' }] })
    expect(messages[4].content.map((block) => block.tool_use_id)).toEqual(['t2'])
  })
  it('applies the compact floor to both the raw prompt and its skill body', () => {
    const events = [
      user(0, '/before'),
      skillInvocation(1, 'PRE-COMPACT SKILL BODY'),
      compact(2, 'SUMMARY'),
      user(3, '/after'),
      skillInvocation(4, 'POST-COMPACT SKILL BODY'),
    ]

    expect(historyFromEvents(events)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'CTX' }] },
      { role: 'user', content: [{ type: 'text', text: 'SUMMARY' }] },
      { role: 'user', content: [{ type: 'text', text: '/after' }] },
      { role: 'user', content: [{ type: 'text', text: 'POST-COMPACT SKILL BODY' }] },
    ])
  })
  it('keeps a signed thinking block in the rebuilt history', () => {
    const events = [
      user(1, 'hi'),
      assistant(2, [{ type: 'thinking', thinking: 'signed thought', signature: 'sig-1' }, { type: 'text', text: 'a' }]),
      user(3, 'again'),
      assistant(4, [{ type: 'thinking', thinking: 'unsigned thought' }, { type: 'text', text: 'b' }]),
    ]
    const messages = historyFromEvents(events) as Array<{ role: string; content: unknown[] }>
    expect(messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'signed thought', signature: 'sig-1' })
    expect(messages[3].content).toEqual([{ type: 'text', text: 'b' }])
  })
  it('keeps a redacted_thinking block that carries data', () => {
    const events = [
      user(1, 'hi'),
      assistant(2, [{ type: 'redacted_thinking', data: 'ENCRYPTED' }, { type: 'text', text: 'a' }]),
    ]
    const messages = historyFromEvents(events) as Array<{ role: string; content: unknown[] }>
    expect(messages[1].content).toEqual([{ type: 'redacted_thinking', data: 'ENCRYPTED' }, { type: 'text', text: 'a' }])
  })
  it('strips an empty signature and an empty redacted payload', () => {
    const events = [
      user(1, 'hi'),
      assistant(2, [{ type: 'thinking', thinking: 'empty sig', signature: '' }, { type: 'text', text: 'a' }]),
      user(3, 'again'),
      assistant(4, [{ type: 'redacted_thinking', data: '' }, { type: 'text', text: 'b' }]),
    ]
    const messages = historyFromEvents(events) as Array<{ role: string; content: unknown[] }>
    expect(messages[1].content).toEqual([{ type: 'text', text: 'a' }])
    expect(messages[3].content).toEqual([{ type: 'text', text: 'b' }])
  })
  it('starts model history at the last compact event', () => {
    const events = [
      user(0, 'old'),
      assistant(1, [{ type: 'text', text: 'old reply' }]),
      { seq: 2, type: 'session/compact', text: 'SUMMARY', context: 'CTX', uuid: 'c1', timestamp: 't' } as const,
      user(3, 'new'),
    ]
    const messages = historyFromEvents(events) as Array<{ role: string; content: unknown[] }>
    expect(messages).toHaveLength(3) // context, summary, new user
    expect(JSON.stringify(messages)).not.toContain('old reply')
    expect(JSON.stringify(messages)).toContain('SUMMARY')
  })
  it('uses the LAST compact when several exist', () => {
    const events = [
      user(0, 'old'),
      compact(1, 'FIRST SUMMARY'),
      user(2, 'middle'),
      compact(3, 'SECOND SUMMARY'),
      user(4, 'new'),
    ]
    const json = JSON.stringify(historyFromEvents(events))
    expect(json).toContain('SECOND SUMMARY')
    expect(json).not.toContain('FIRST SUMMARY')
    expect(json).not.toContain('middle')
  })
  it('excludes sidechain events from the main model history', () => {
    const events = [
      user(0, 'go'),
      // The parent turn: the assistant calls a tool, then a nested runner's
      // wraps run, and only the parent's result belongs to the main history.
      assistant(1, [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: {} }]),
      sideUser(2, 'INNER PROMPT'),
      sideAssistant(3, [{ type: 'text', text: 'INNER REPLY' }]),
      sideResult(4, 'inner-tool'),
      result(5, 'agent1'),
    ]
    const messages = historyFromEvents(events) as Array<{ role: string; content: unknown[] }>
    expect(messages).toHaveLength(3) // user, assistant(tool_use), merged tool result
    expect(JSON.stringify(messages)).not.toContain('INNER')
    expect(messages[2].content).toHaveLength(1)
  })
  it('replays a supplement verbatim at its position and closes the tool-result group', () => {
    // result(5) follows the supplement: without closing the group it would
    // merge into result(3)'s message, placing it BEFORE the supplement.
    const events = [
      user(1, 'go'),
      assistant(2, [
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'tool_use', id: 't2', name: 'Read', input: {} },
      ]),
      result(3, 't1'),
      supplement(4, 'WRAPPED GUIDANCE'),
      result(5, 't2'),
    ]
    const messages = historyFromEvents(events) as Array<{
      role: string
      content: Array<{ type?: string; text?: string; tool_use_id?: string }>
    }>
    expect(messages).toHaveLength(5)
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['t1'])
    // Stored text is already the wrapped guidance — replayed exactly, no re-wrap.
    expect(messages[3]).toEqual({ role: 'user', content: [{ type: 'text', text: 'WRAPPED GUIDANCE' }] })
    expect(messages[4].content.map((b) => b.tool_use_id)).toEqual(['t2'])
  })
  it('drops a supplement whose uuid is requeued as an ordinary user prompt', () => {
    // The appended-but-not-delivered shape: the supplement event is durable
    // but the model never saw it, and the manager requeued the message as a
    // plain prompt under the SAME uuid. Replaying both would duplicate the
    // guidance — only the plain prompt survives.
    const events = [
      user(1, 'go'),
      assistant(2, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      result(3, 't1'),
      supplement(4, 'WRAPPED GUIDANCE', 'steer-1'),
      userWithUuid(5, 'plain steer', 'steer-1'),
      assistant(6, [{ type: 'text', text: 'done' }]),
    ]
    const messages = historyFromEvents(events) as Array<{ role: string; content: Array<{ text?: string }> }>
    expect(messages).toHaveLength(5) // supplement skipped: tool_result group closed by the plain prompt
    expect(JSON.stringify(messages)).not.toContain('WRAPPED GUIDANCE')
    expect(JSON.stringify(messages)).toContain('plain steer')
  })
  it('keeps a delivered supplement when a following user event has a different uuid', () => {
    const events = [
      user(1, 'go'),
      supplement(2, 'WRAPPED GUIDANCE', 'steer-1'),
      userWithUuid(3, 'later prompt', 'u3'),
    ]
    const messages = historyFromEvents(events) as Array<{ role: string; content: Array<{ text?: string }> }>
    expect(messages.map((m) => m.content[0]?.text)).toEqual(['go', 'WRAPPED GUIDANCE', 'later prompt'])
  })
  it('synthesizes a result for every unanswered tool_use', () => {
    const events = [user(0, 'go'), assistant(1, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }])]
    const { synthetic } = repairInterruptedTurn(events)
    expect(synthetic.map((e) => (e as { message: { content: Array<{ tool_use_id: string }> } }).message.content[0].tool_use_id)).toEqual(['t1', 't2'])
  })
  it('returns no synthetic events for a complete turn', () => {
    expect(repairInterruptedTurn([user(0, 'go'), assistant(1, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]), result(2, 't1')]).synthetic).toEqual([])
  })
  it('does not synthesize a result for an unanswered sidechain tool_use', () => {
    const events = [
      user(0, 'go'),
      sideAssistant(1, [{ type: 'tool_use', id: 'inner', name: 'Read', input: {} }]),
      assistant(2, [{ type: 'tool_use', id: 'outer', name: 'Read', input: {} }]),
    ]
    const { synthetic } = repairInterruptedTurn(events)
    expect(
      synthetic.map((e) => (e as { message: { content: Array<{ tool_use_id: string }> } }).message.content[0].tool_use_id),
    ).toEqual(['outer'])
  })
  it('ignores an unanswered tool_use before the last compact', () => {
    // The replay floor supersedes the pre-compact conversation, so repairing
    // an open tool_use there would inject an orphan tool_result into the
    // compacted history (the API rejects it).
    const events = [
      assistant(0, [{ type: 'tool_use', id: 'pre', name: 'Read', input: {} }]),
      compact(1, 'SUMMARY'),
      user(2, 'new'),
    ]
    expect(repairInterruptedTurn(events).synthetic).toEqual([])
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
