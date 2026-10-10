import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { removeFromHistory, shouldBroadcastMessage, countQueuedUserTurns } from './history-utils.js'

/** Minimal ring entry — removeFromHistory only reads `uuid`. */
function msg(uuid?: string): { uuid?: string } {
  return uuid === undefined ? {} : { uuid }
}

describe('removeFromHistory', () => {
  it('removes every entry whose uuid is in the set, in place', () => {
    const history = [msg('a'), msg('b'), msg('c'), msg('d')]
    const removed = removeFromHistory(history, new Set(['b', 'd']))
    expect(removed).toBe(2)
    expect(history).toEqual([msg('a'), msg('c')])
    expect(history).toHaveLength(2)
  })

  it('ignores unknown uuids (CLI-internal commands the host never sent)', () => {
    const history = [msg('a'), msg('b')]
    const removed = removeFromHistory(history, new Set(['b', 'cli-internal']))
    expect(removed).toBe(1)
    expect(history).toEqual([msg('a')])
  })

  it('returns 0 without touching the ring when the set is empty or nothing matches', () => {
    const history = [msg('a'), msg('b')]
    expect(removeFromHistory(history, new Set())).toBe(0)
    expect(removeFromHistory(history, new Set(['nope']))).toBe(0)
    expect(history).toEqual([msg('a'), msg('b')])
  })

  it('does not dedupe against entries lacking a uuid', () => {
    const history = [msg(), msg('a'), msg()]
    const removed = removeFromHistory(history, new Set(['a']))
    expect(removed).toBe(1)
    expect(history).toEqual([msg(), msg()])
  })
})

describe('shouldBroadcastMessage', () => {
  it('broadcasts all non-system messages', () => {
    expect(shouldBroadcastMessage({ type: 'assistant' })).toBe(true)
    expect(shouldBroadcastMessage({ type: 'user' })).toBe(true)
  })

  it('broadcasts allowlisted system subtypes (plugin_install) and hides others', () => {
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'plugin_install' })).toBe(true)
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'error' })).toBe(true)
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'init' })).toBe(false)
    expect(shouldBroadcastMessage({ type: 'system', subtype: 'status' })).toBe(false)
  })
})

describe('countQueuedUserTurns', () => {
  // Minimal shape helpers — countQueuedUserTurns reads type /
  // parent_tool_use_id / receivedAt / consumedAt plus the message.content
  // shape (tool_result / <task-notification> sniffing), so these partials
  // are sufficient for the truth-table.  The `as unknown as SDKMessage[]`
  // cast sidesteps the full SDKMessage union (SDKUserMessage requires
  // message, uuid, session_id, …) which would bloat every test line.
  const topUser = (receivedAt?: number, consumedAt?: number): SDKMessage =>
    ({ type: 'user', parent_tool_use_id: null, receivedAt, consumedAt } as unknown as SDKMessage)
  const subUser = (receivedAt?: number): SDKMessage =>
    ({ type: 'user', parent_tool_use_id: 'tool-123', receivedAt } as unknown as SDKMessage)
  const assistant = (receivedAt?: number): SDKMessage =>
    ({ type: 'assistant', parent_tool_use_id: null, receivedAt } as unknown as SDKMessage)
  const system = (receivedAt?: number): SDKMessage =>
    ({ type: 'system', subtype: 'init', receivedAt } as unknown as SDKMessage)
  // SDK 0.3.143 delivers MAIN-THREAD tool_results as user frames with
  // parent_tool_use_id: null (verified against the SDK — see the pump's
  // drop-filter comment). They must not count as queued prompts.
  const toolResultUser = (receivedAt?: number): SDKMessage =>
    ({ type: 'user', parent_tool_use_id: null, receivedAt, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } } as unknown as SDKMessage)
  // Harness task-notification injections are null-parent TEXT-only user
  // frames — also never queued host input.
  const taskNotifUser = (receivedAt?: number): SDKMessage =>
    ({ type: 'user', parent_tool_use_id: null, receivedAt, message: { role: 'user', content: [{ type: 'text', text: '<task-notification><task-id>t1</task-id><status>completed</status></task-notification>' }] } } as unknown as SDKMessage)

  it('counts a top-level user frame with receivedAt only', () => {
    expect(countQueuedUserTurns([topUser(100)])).toBe(1)
  })

  it('does not count a top-level user frame that has consumedAt', () => {
    expect(countQueuedUserTurns([topUser(100, 200)])).toBe(0)
  })

  it('does not count a user frame with parent_tool_use_id set (subagent / tool result)', () => {
    expect(countQueuedUserTurns([subUser(100)])).toBe(0)
  })

  it('does NOT count a non-user frame (assistant) with receivedAt only', () => {
    expect(countQueuedUserTurns([assistant(100)])).toBe(0)
  })

  it('does not count a frame with no receivedAt', () => {
    expect(countQueuedUserTurns([topUser()])).toBe(0)
  })

  it('returns 0 for an empty history', () => {
    expect(countQueuedUserTurns([])).toBe(0)
  })

  it('does NOT count a main-thread tool_result frame even though parent_tool_use_id is null', () => {
    // Regression: the old predicate keyed on parent_tool_use_id alone, but
    // SDK 0.3.143 emits main-thread tool_results with a null parent — every
    // such frame in the ring was miscounted as a queued prompt (observed:
    // queuedInputs=90 where all 90 were tool_results).
    expect(countQueuedUserTurns([toolResultUser(100)])).toBe(0)
  })

  it('does NOT count a <task-notification> user-role injection frame', () => {
    expect(countQueuedUserTurns([taskNotifUser(100)])).toBe(0)
  })

  it('counts only real prompts in a ring full of tool_result and notification frames', () => {
    const history: SDKMessage[] = [
      toolResultUser(100),
      taskNotifUser(200),
      assistant(250),
      topUser(300),        // the only queued prompt
      toolResultUser(400),
      topUser(500, 600),   // consumed
      taskNotifUser(700),
    ]
    expect(countQueuedUserTurns(history)).toBe(1)
  })

  it('counts only top-level user frames in a mixed ring', () => {
    const history: SDKMessage[] = [
      topUser(100),            // queued
      assistant(200),          // non-user — must NOT count
      topUser(300, 400),       // consumed
      subUser(500),            // subagent user frame — must NOT count
      system(600),             // system — must NOT count
      topUser(700),            // queued
    ]
    expect(countQueuedUserTurns(history)).toBe(2)
  })
})
