import { describe, expect, it } from 'vitest'
import { contextSnapshot, historyFromEvents, repairInterruptedTurn, repairRenderableLines } from './replay.js'
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
