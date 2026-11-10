// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../session-store/types'
import { resolveRevealItemIndex } from './reveal'

function item(id: string, msg: Record<string, unknown>): TranscriptItem {
  return { id, msg, plainText: null, isCompactSummary: false, hiddenByDefault: false } as unknown as TranscriptItem
}

const items = [
  item('a1', {
    type: 'assistant',
    uuid: 'a1',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  }),
  item('tu1', {
    type: 'assistant',
    uuid: 'tu1',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] },
  }),
  item('u3', {
    type: 'user',
    uuid: 'u3',
    parent_tool_use_id: 'toolu_1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'output' }] },
  }),
]

describe('resolveRevealItemIndex', () => {
  it('resolves a plain message by uuid', () => {
    expect(resolveRevealItemIndex(items, { messageUuid: 'a1' })).toBe(0)
  })

  it('resolves a tool_result hit to its owning tool_use row', () => {
    expect(resolveRevealItemIndex(items, { ownerToolUseId: 'toolu_1' })).toBe(1)
  })

  it('prefers the owner over the matched result uuid', () => {
    expect(resolveRevealItemIndex(items, { messageUuid: 'u3', ownerToolUseId: 'toolu_1' })).toBe(1)
  })

  it('returns -1 when the target is not loaded', () => {
    expect(resolveRevealItemIndex(items, { messageUuid: 'nope' })).toBe(-1)
  })
})