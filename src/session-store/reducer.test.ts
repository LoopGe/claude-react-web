import { describe, it, expect } from 'vitest'
import { reduceSessionState } from './reducer'
import { createInitialSessionState } from './types'
import type { SdkMessage } from '../types'

const hasId = (ids: ReadonlySet<string>, id: string) => ids.has(id)
const isEmpty = (ids: ReadonlySet<string>) => ids.size === 0

function applyOptimistic(state: ReturnType<typeof createInitialSessionState>, content: unknown, pendingId = 'optimistic:test'): ReturnType<typeof createInitialSessionState> {
  const message: SdkMessage = {
    type: 'user',
    uuid: pendingId,
    message: { role: 'user', content },
  } as unknown as SdkMessage
  return reduceSessionState(state, { type: 'OPTIMISTIC_USER_MESSAGE', message })
}

function applyServerEcho(
  state: ReturnType<typeof createInitialSessionState>,
  content: unknown,
  uuid = 'real-server-uuid',
  parentToolUseId: string | null = null,
): ReturnType<typeof createInitialSessionState> {
  const message: SdkMessage = {
    type: 'user',
    uuid,
    message: { role: 'user', content },
    parent_tool_use_id: parentToolUseId,
  } as unknown as SdkMessage
  return reduceSessionState(state, { type: 'MESSAGE', message })
}

describe('reducer: optimistic user message + server echo', () => {
  it('replaces the optimistic placeholder in-place (does NOT append a duplicate)', () => {
    // Regression: when insertUserMessage runs BEFORE the POST awaits, the
    // server's manual broadcast arrives while pendingUserMessageIds is
    // still set. The reducer used to replace the optimistic AND then
    // fall through to updateTranscript which unconditionally appends —
    // every user message ended up rendered twice.
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'hello', 'optimistic:abc')
    expect(state.items.length).toBe(1)
    expect(state.items[0].sending).toBe(true) // ← drives the spinner UI
    expect(hasId(state.pendingUserMessageIds, 'optimistic:abc')).toBe(true)

    state = applyServerEcho(state, 'hello', 'real-xyz')
    expect(state.items.length).toBe(1)
    expect(state.items[0].id).toBe('real-xyz')
    // After the broadcast lands the replaced item has no `sending`
    // — the indicator clears automatically.
    expect(state.items[0].sending).toBeUndefined()
    expect(isEmpty(state.pendingUserMessageIds)).toBe(true)
  })

  it('replaces correctly for multimodal (array) content — match is by id, not content', () => {
    // Old `content === content` dedup failed for arrays (always !==).
    // The id-based match makes this work for multimodal too.
    const arr = [
      { type: 'text', text: 'caption' },
      { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } },
    ]
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, arr, 'optimistic:img')
    expect(state.items.length).toBe(1)

    state = applyServerEcho(state, arr, 'real-img-uuid')
    expect(state.items.length).toBe(1)
    expect(state.items[0].id).toBe('real-img-uuid')
  })

  it('appends normally when no optimistic is pending', () => {
    let state = createInitialSessionState('s1')
    state = applyServerEcho(state, 'hello', 'real-1')
    expect(state.items.length).toBe(1)
    expect(state.items[0].id).toBe('real-1')
    expect(isEmpty(state.pendingUserMessageIds)).toBe(true)
  })

  it('does NOT match a subagent tool_result against a pending optimistic', () => {
    // Tool_result frames also arrive as type=user but with
    // parent_tool_use_id set. They must not clobber the optimistic
    // placeholder — without the parent_tool_use_id guard, the user
    // would see their typed text replaced by a JSON tool result.
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'real user input', 'optimistic:abc')
    expect(hasId(state.pendingUserMessageIds, 'optimistic:abc')).toBe(true)

    // tool_result-shaped user message arrives BEFORE the actual echo
    state = applyServerEcho(state, [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }], 'tool-result-uuid', 'subagent-id')

    // Optimistic survives — the tool_result was appended separately
    expect(state.items.length).toBe(2)
    expect(state.items[0].id).toBe('optimistic:abc')
    expect(hasId(state.pendingUserMessageIds, 'optimistic:abc')).toBe(true)
  })

  it('clears pendingUserMessageIds on result frame even if no echo arrived', () => {
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'hello', 'optimistic:abc')
    expect(hasId(state.pendingUserMessageIds, 'optimistic:abc')).toBe(true)

    const resultMsg: SdkMessage = {
      type: 'result',
      subtype: 'success',
      uuid: 'r-1',
    } as unknown as SdkMessage
    state = reduceSessionState(state, { type: 'MESSAGE', message: resultMsg })
    expect(isEmpty(state.pendingUserMessageIds)).toBe(true)
  })
})

describe('reducer: ROLLBACK_OPTIMISTIC_USER_MESSAGE', () => {
  it('removes the optimistic placeholder when POST fails', () => {
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'hello', 'optimistic:abc')
    expect(state.items.length).toBe(1)

    state = reduceSessionState(state, {
      type: 'ROLLBACK_OPTIMISTIC_USER_MESSAGE',
      pendingId: 'optimistic:abc',
    })
    expect(state.items.length).toBe(0)
    expect(isEmpty(state.pendingUserMessageIds)).toBe(true)
  })

  it('is a no-op when the broadcast already cleared pendingUserMessageIds', () => {
    // Race: server broadcast arrives between the failed POST and the
    // catch block dispatching rollback. Rollback must not delete the
    // real message.
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'hello', 'optimistic:abc')
    state = applyServerEcho(state, 'hello', 'real-xyz')
    expect(isEmpty(state.pendingUserMessageIds)).toBe(true)
    expect(state.items[0].id).toBe('real-xyz')

    const before = state
    state = reduceSessionState(state, {
      type: 'ROLLBACK_OPTIMISTIC_USER_MESSAGE',
      pendingId: 'optimistic:abc',
    })
    expect(state).toBe(before)
    expect(state.items[0].id).toBe('real-xyz')
  })
})
