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

describe('reducer: recap dedup', () => {
  // Regression: switching to an idle session would re-fire the recap
  // fetch; the server's broadcast of the new recap was appended on top
  // of the prior recap restored from localStorage, so each session
  // switch stacked another duplicate card.
  function applyRecap(
    state: ReturnType<typeof createInitialSessionState>,
    uuid: string,
    summary: string,
    state_: 'ready' | 'loading' | 'error' = 'ready',
  ): ReturnType<typeof createInitialSessionState> {
    const message = {
      type: 'recap',
      uuid,
      session_id: 's1',
      state: state_,
      recap: { summary, stats: {} },
    } as unknown as SdkMessage
    return reduceSessionState(state, { type: 'MESSAGE', message })
  }

  it('replaces an existing recap card when a new recap message arrives', () => {
    let state = createInitialSessionState('s1')
    state = applyRecap(state, 'recap:s1:111', 'old summary')
    expect(state.items.length).toBe(1)

    state = applyRecap(state, 'recap:s1:222', 'new summary')
    // Still one card — the old one is gone, the new one took its place.
    expect(state.items.length).toBe(1)
    expect(state.items[0].id).toBe('recap:s1:222')
    expect(state.messages.length).toBe(1)
    expect((state.messages[0] as { uuid: string }).uuid).toBe('recap:s1:222')
  })

  it('preserves non-recap messages when replacing the recap', () => {
    let state = createInitialSessionState('s1')
    // user → assistant → recap → another user turn
    state = applyServerEcho(state, 'hi', 'u-1')
    state = applyRecap(state, 'recap:s1:111', 'old')
    state = applyServerEcho(state, 'follow up', 'u-2')
    expect(state.items.length).toBe(3)

    state = applyRecap(state, 'recap:s1:222', 'new')
    // recap card replaced, the two user turns survive, recap moves to tail
    expect(state.items.length).toBe(3)
    const ids = state.items.map((i) => i.id)
    expect(ids).toContain('u-1')
    expect(ids).toContain('u-2')
    expect(ids).toContain('recap:s1:222')
    expect(ids).not.toContain('recap:s1:111')
  })

  it('self-heals legacy duplicate recaps (multiple stale recaps in cached items)', () => {
    // Simulates localStorage cache from before the fix: three stale recap
    // cards already in items. A single new recap broadcast must collapse
    // all of them to one.
    let state = createInitialSessionState('s1')
    state = applyRecap(state, 'recap:s1:1', 's1')
    state = applyRecap(state, 'recap:s1:2', 's2')
    // Bypass the dedup to seed a third stale recap manually — mimic what
    // a buggy persisted state could look like on hydrate.
    state = {
      ...state,
      items: [
        ...state.items,
        {
          id: 'recap:s1:3',
          msg: {
            type: 'recap',
            uuid: 'recap:s1:3',
            session_id: 's1',
            state: 'ready',
            recap: { summary: 's3', stats: {} },
          } as unknown as SdkMessage,
          plainText: null,
          isCompactSummary: false,
          hiddenByDefault: false,
        },
      ],
      messages: [
        ...state.messages,
        {
          type: 'recap',
          uuid: 'recap:s1:3',
        } as unknown as SdkMessage,
      ],
    }
    expect(state.items.filter((i) => (i.msg as { type?: string }).type === 'recap').length).toBe(2)

    state = applyRecap(state, 'recap:s1:fresh', 'fresh')
    const recapItems = state.items.filter((i) => (i.msg as { type?: string }).type === 'recap')
    expect(recapItems.length).toBe(1)
    expect(recapItems[0].id).toBe('recap:s1:fresh')
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
