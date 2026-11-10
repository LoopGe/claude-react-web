import { describe, expect, it } from 'vitest'
import { createInitialClientIntent, createInitialServerMirror, type SessionState } from './types'
import { reduceSessionState } from './reducer'
import type { SdkMessage } from '../types'

function message(type: 'user' | 'assistant', uuid: string, text: string): SdkMessage {
  return {
    type,
    uuid,
    parent_tool_use_id: null,
    message: { role: type, content: [{ type: 'text', text }] },
  } as unknown as SdkMessage
}

function stateWithTranscript(): SessionState {
  return {
    sessionId: 's1',
    mirror: {
      ...createInitialServerMirror(),
      tasks: [{ taskId: 'task-1' } as never],
      contextUsage: { used: 1 } as never,
      promptSuggestion: 'next question?',
      sessionState: 'idle',
    },
    intent: {
      ...createInitialClientIntent(),
      error: 'keep me',
    },
  }
}

describe('ANCHOR_RESET', () => {
  it('clears transcript items, indexes, and window but preserves intent and non-transcript state', () => {
    const before = stateWithTranscript()
    const after = reduceSessionState(before, {
      type: 'ANCHOR_RESET',
      generation: 1,
      headSeq: 10,
      viewSeq: 5,
    })

    expect(after.mirror.items).toEqual([])
    expect(after.mirror.messages).toEqual([])
    expect(after.mirror.window.oldestSeq).toBeNull()
    expect(after.mirror.window.generation).toBe(1)
    expect(after.mirror.window.headSeq).toBe(10)
    expect(after.mirror.anchored).toBe(true)
    expect(after.mirror.anchorSeq).toBe(5)

    expect(after.mirror.tasks).toBe(before.mirror.tasks)
    expect(after.mirror.contextUsage).toBe(before.mirror.contextUsage)
    expect(after.mirror.promptSuggestion).toBe('next question?')
    expect(after.mirror.sessionState).toBe('idle')
    expect(after.intent).toBe(before.intent)
  })

  it('lets a following WINDOW_PAGE at tail adopt the empty window', () => {
    const reset = reduceSessionState(stateWithTranscript(), {
      type: 'ANCHOR_RESET',
      generation: 1,
      headSeq: 10,
      viewSeq: 5,
    })
    const after = reduceSessionState(reset, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 1,
      headSeq: 10,
      messages: [
        { seq: 5, msg: message('assistant', 'm5', 'hello') },
        { seq: 6, msg: message('assistant', 'm6', 'world') },
      ],
      hasMore: true,
      tombstones: [],
    })

    expect(after.mirror.items.map((item) => item.msg.uuid)).toEqual(['m5', 'm6'])
    expect(after.mirror.window.oldestSeq).toBe(5)
    expect(after.mirror.window.hasOlder).toBe(true)
    expect(after.mirror.anchored).toBe(true)
  })
})