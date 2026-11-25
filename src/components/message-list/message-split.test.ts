// @vitest-environment node
// Pure row-split projection — no DOM (same opt-out as transcript-rows.test.ts).
import { describe, it, expect } from 'vitest'
import { splitMixedAssistantMessage, rowDraftAlias } from './message-split'
import { getBlocks } from '../../session-store/normalize'
import type { SdkMessage } from '../../types'

type BlockSpec =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'image' }

function assistant(uuid: string, blocks: BlockSpec[], extra: Record<string, unknown> = {}): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    session_id: 's1',
    message: { role: 'assistant', content: blocks },
    ...extra,
  } as unknown as SdkMessage
}

const text = (t: string): BlockSpec => ({ type: 'text', text: t })
const thinking = (t: string): BlockSpec => ({ type: 'thinking', thinking: t })
const tool = (id: string, name = 'Read'): BlockSpec => ({ type: 'tool_use', id, name, input: {} })

describe('splitMixedAssistantMessage', () => {
  it('returns null for a pure-text assistant message', () => {
    expect(splitMixedAssistantMessage(assistant('m', [text('hello')]))).toBeNull()
  })

  it('returns null for a pure tool_use assistant message', () => {
    expect(splitMixedAssistantMessage(assistant('m', [tool('t1'), tool('t2')]))).toBeNull()
  })

  it('returns null for a pure thinking message', () => {
    expect(splitMixedAssistantMessage(assistant('m', [thinking('hmm')]))).toBeNull()
  })

  it('returns null for non-assistant messages', () => {
    const user = {
      type: 'user',
      uuid: 'u',
      message: { role: 'user', content: [text('hi'), tool('t1')] },
    } as unknown as SdkMessage
    expect(splitMixedAssistantMessage(user)).toBeNull()
  })

  it('splits [text, tool] into a non-tool run then a tool run', () => {
    const msg = assistant('m', [text('intro'), tool('t1'), tool('t2')])
    const runs = splitMixedAssistantMessage(msg)
    expect(runs).not.toBeNull()
    expect(runs!.length).toBe(2)
    expect(getBlocks(runs![0]).map((b) => b.type)).toEqual(['text'])
    expect(getBlocks(runs![1]).map((b) => b.type)).toEqual(['tool_use', 'tool_use'])
  })

  it('splits [tool, text] preserving block order', () => {
    const runs = splitMixedAssistantMessage(assistant('m', [tool('t1'), text('after')]))
    expect(runs!.length).toBe(2)
    expect(getBlocks(runs![0]).map((b) => b.type)).toEqual(['tool_use'])
    expect(getBlocks(runs![1]).map((b) => b.type)).toEqual(['text'])
  })

  it('splits interleaved [text, tool, text] into three runs', () => {
    const runs = splitMixedAssistantMessage(assistant('m', [text('a'), tool('t1'), text('b')]))
    expect(runs!.length).toBe(3)
    expect(getBlocks(runs![0]).map((b) => b.type)).toEqual(['text'])
    expect(getBlocks(runs![1]).map((b) => b.type)).toEqual(['tool_use'])
    expect(getBlocks(runs![2]).map((b) => b.type)).toEqual(['text'])
  })

  it('keeps thinking with adjacent text in one non-tool run', () => {
    const runs = splitMixedAssistantMessage(assistant('m', [thinking('hmm'), text('intro'), tool('t1')]))
    expect(runs!.length).toBe(2)
    expect(getBlocks(runs![0]).map((b) => b.type)).toEqual(['thinking', 'text'])
    expect(getBlocks(runs![1]).map((b) => b.type)).toEqual(['tool_use'])
  })

  it('includes an empty-text run (pushRow drops it via willRenderEmpty; runIndex stays positional)', () => {
    const runs = splitMixedAssistantMessage(assistant('m', [tool('t1'), text('   ')]))
    expect(runs!.length).toBe(2)
    expect(getBlocks(runs![1]).map((b) => b.type)).toEqual(['text'])
  })

  it('preserves the envelope identity on every run', () => {
    const msg = assistant('m', [text('intro'), tool('t1')], { receivedAt: 123 })
    const runs = splitMixedAssistantMessage(msg)!
    for (const run of runs) {
      expect(run.uuid).toBe('m')
      expect(run.type).toBe('assistant')
      expect(run.parent_tool_use_id).toBeNull()
      expect(run.session_id).toBe('s1')
      expect(run.message?.role).toBe('assistant')
    }
  })

  it('splits sidechain messages too (no parent gate — folding eligibility is separate)', () => {
    const msg = assistant('m', [text('intro'), tool('t1')])
    ;(msg as { parent_tool_use_id?: unknown }).parent_tool_use_id = 'agent-1'
    const runs = splitMixedAssistantMessage(msg)
    expect(runs!.length).toBe(2)
    expect(runs![0].parent_tool_use_id).toBe('agent-1')
  })

  it.each([
    ['isDraft', { isDraft: true }],
    ['error', { error: 'boom' }],
    ['isApiErrorMessage', { isApiErrorMessage: true }],
    ['context_usage', { context_usage: {} }],
    ['usage_report', { usage_report: {} }],
  ])('returns null for a mixed frame carrying %s (fields would duplicate per run)', (_label, extra) => {
    expect(splitMixedAssistantMessage(assistant('m', [text('intro'), tool('t1')], extra))).toBeNull()
  })

  it('returns null when a block is null (defensive parity with isToolGroupEligible)', () => {
    const msg = assistant('m', [text('intro'), tool('t1')])
    ;(msg.message!.content as unknown[]).push(null)
    expect(splitMixedAssistantMessage(msg)).toBeNull()
  })

  it('is referentially stable across calls on the same message object', () => {
    const msg = assistant('m', [text('intro'), tool('t1')])
    const a = splitMixedAssistantMessage(msg)
    const b = splitMixedAssistantMessage(msg)
    expect(a).toBe(b)
    expect(a![0]).toBe(b![0])
  })

  it('does not mutate the original message content', () => {
    const msg = assistant('m', [text('intro'), tool('t1')])
    splitMixedAssistantMessage(msg)
    expect(getBlocks(msg).map((b) => b.type)).toEqual(['text', 'tool_use'])
  })
})

describe('rowDraftAlias', () => {
  const keys = { m: 'draft:3' }

  it('aliases an unsplit row (id === uuid) as today', () => {
    expect(rowDraftAlias({ id: 'm', msg: { uuid: 'm' } }, keys)).toBe('draft:3')
  })

  it('aliases the heir run of a split message', () => {
    expect(rowDraftAlias({ id: 'm:r1', draftHeir: true, msg: { uuid: 'm' } }, keys)).toBe('draft:3')
  })

  it('does NOT alias a non-heir split run (duplicate-key guard)', () => {
    expect(rowDraftAlias({ id: 'm:r0', msg: { uuid: 'm' } }, keys)).toBeUndefined()
  })

  it('returns undefined without a uuid or without aliases', () => {
    expect(rowDraftAlias({ id: 'draft:0', msg: {} }, keys)).toBeUndefined()
    expect(rowDraftAlias({ id: 'm', msg: { uuid: 'm' } }, undefined)).toBeUndefined()
    expect(rowDraftAlias({ id: 'm', msg: { uuid: 'other' } }, keys)).toBeUndefined()
  })
})
