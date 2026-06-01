import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from './store'
import type { SdkMessage } from '../types'

// Mirrors the literal in store.ts. Kept in sync manually — if this
// breaks, update both. (The constant isn't exported because real code
// has no reason to read or write a foreign session's localStorage key.)
const STORAGE_PREFIX = 'claude-web-session:'

function assistantToolUse(name: string, id: string, uuid: string): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: {} }],
    },
  } as unknown as SdkMessage
}

function userToolResult(toolUseId: string, uuid: string, isError = false): SdkMessage {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: isError ? 'failed' : 'ok',
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  } as unknown as SdkMessage
}

describe('SessionStore hydration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('rebuilds toolStatus from cached messages on hydration', () => {
    // Regression: older Read/Grep/Bash cards were stuck on the running
    // spinner after a page reload because the SessionStore constructor
    // restored items+messages from localStorage but didn't rebuild the
    // toolStatus map. useToolStatus then defaulted to 'running' for
    // every cached tool_use card forever.
    const sessionId = 'session-hydration-test'
    const messages = [
      assistantToolUse('Bash', 'tu_bash', 'a-1'),
      userToolResult('tu_bash', 'r-1'),
      assistantToolUse('Read', 'tu_read', 'a-2'),
      userToolResult('tu_read', 'r-2', true), // is_error → 'error'
      assistantToolUse('Grep', 'tu_grep', 'a-3'),
      // tu_grep has no result — still genuinely running.
    ]
    const items = messages.map((msg, i) => ({
      id: typeof msg.uuid === 'string' ? msg.uuid : `i-${i}`,
      msg,
      isCompactSummary: false,
      hiddenByDefault: false,
    }))
    localStorage.setItem(
      STORAGE_PREFIX + sessionId,
      JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        messages,
        items,
        lastMessageUuid: 'a-3',
      }),
    )

    const store = new SessionStore(sessionId)
    const snap = store.getSnapshot()
    expect(snap.toolStatus.get('tu_bash')).toBe('success')
    expect(snap.toolStatus.get('tu_read')).toBe('error')
    expect(snap.toolStatus.get('tu_grep')).toBe('running')
    expect(snap.replayReady).toBe(true)
    expect(snap.items).toHaveLength(messages.length)
  })

  it('starts with an empty toolStatus when no cache exists', () => {
    const store = new SessionStore('session-no-cache')
    expect(store.getSnapshot().toolStatus.size).toBe(0)
    expect(store.getSnapshot().replayReady).toBe(false)
  })
})
