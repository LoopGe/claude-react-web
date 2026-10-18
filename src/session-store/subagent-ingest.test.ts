import { describe, it, expect } from 'vitest'
import { SessionStore } from './store'
import type { SdkMessage } from '../types'

// 与 subagent-transcripts.test.ts 同源的 wire 帧形状(normalize 输出)。
const frame = (o: object): SdkMessage =>
  ({ restoredFromDisk: true, session_id: 's1', parent_tool_use_id: null, ...o }) as unknown as SdkMessage
const userFrame = (uuid: string, text: string) => frame({
  type: 'user', uuid, receivedAt: Date.parse('2026-10-18T00:00:01.000Z'),
  message: { role: 'user', content: text },
})
const assistantToolUse = (uuid: string, id: string) => frame({
  type: 'assistant', uuid, receivedAt: Date.parse('2026-10-18T00:00:02.000Z'),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'git diff' } }] },
})
const toolResult = (uuid: string, id: string) => frame({
  type: 'user', uuid, receivedAt: Date.parse('2026-10-18T00:00:03.000Z'),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'diff --git ...' }] },
})

describe('subagent transcript ingest via REPLAY_REPLACE', () => {
  it('produces transcript items AND populates toolStatus/toolResults', () => {
    const store = new SessionStore('s1')
    store.dispatch({
      type: 'REPLAY_REPLACE',
      permissions: [],
      messages: [
        userFrame('u1', 'go'),
        assistantToolUse('a1', 'tu1'),
        toolResult('u2', 'tu1'),
      ],
    })
    const snap = store.getSnapshot()
    expect(snap.replayReady).toBe(true)
    expect(snap.items.length).toBeGreaterThan(0)
    expect(snap.toolStatus.get('tu1')).toBeDefined()
    expect(snap.toolResults.get('tu1')).toBeDefined()
  })

  it('incremental MESSAGE frames append after the bootstrap replay', () => {
    const store = new SessionStore('s1')
    store.dispatch({ type: 'REPLAY_REPLACE', permissions: [], messages: [userFrame('u1', 'go')] })
    const before = store.getSnapshot().items.length
    store.dispatch({ type: 'MESSAGE', message: frame({ type: 'assistant', uuid: 'a1', receivedAt: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) })
    expect(store.getSnapshot().items.length).toBe(before + 1)
  })
})
