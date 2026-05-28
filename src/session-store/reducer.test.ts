import { describe, it, expect } from 'vitest'
import { reduceSessionState } from './reducer'
import { createInitialSessionState } from './types'
import type { PermissionRequest, SdkMessage } from '../types'

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

// Note: the prior `reducer: recap dedup` block was deleted along with the
// synthetic-recap-message path. session.recap is now a top-level field on
// SessionInfo (broadcast via session-recap-update / session-update), not
// an entry in the items array — there's nothing for the reducer to dedup.

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

describe('reducer: PERMISSION_RESOLVED → questionAnswers (AskUserQuestion)', () => {
  // Regression: the inline QuestionCard used to remain stuck on 'pending'
  // even after the user submitted answers via QuestionDialog, because
  // updateIndexes() only flips questionAnswers when a parsable
  // tool_result arrives via MESSAGE — but the SDK does not always echo
  // a follow-up tool_result through the Query stream after canUseTool
  // deny+message short-circuits. Decoding the JSON in PERMISSION_RESOLVED
  // closes that gap.
  function seedQuestion(state: ReturnType<typeof createInitialSessionState>, toolUseId: string) {
    const msg: SdkMessage = {
      type: 'assistant',
      uuid: `a-${toolUseId}`,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'OK?', options: [{ label: 'Yes' }] }] },
          },
        ],
      },
    } as unknown as SdkMessage
    return reduceSessionState(state, { type: 'MESSAGE', message: msg })
  }

  function seedPendingPermission(
    state: ReturnType<typeof createInitialSessionState>,
    pid: string,
    toolUseId: string,
  ): ReturnType<typeof createInitialSessionState> {
    const request: PermissionRequest = {
      kind: 'question',
      id: pid,
      toolName: 'AskUserQuestion',
      questions: [{ question: 'OK?', options: [{ label: 'Yes' }] }],
      toolUseID: toolUseId,
      createdAt: 0,
    }
    return reduceSessionState(state, { type: 'PERMISSION_REQUEST', request })
  }

  it('parses the JSON answers payload from decision.message into questionAnswers', () => {
    let state = createInitialSessionState('s1')
    state = seedQuestion(state, 'tu_q')
    expect(state.questionAnswers.get('tu_q')).toEqual([])

    state = seedPendingPermission(state, 'pid-1', 'tu_q')

    state = reduceSessionState(state, {
      type: 'PERMISSION_RESOLVED',
      id: 'pid-1',
      decision: {
        behavior: 'deny',
        persisted: false,
        message: JSON.stringify({
          note: 'User answers from AskUserQuestion (...)',
          answers: [{ question: 'OK?', answer: 'Yes' }],
        }),
      },
    })
    expect(state.questionAnswers.get('tu_q')).toEqual([{ question: 'OK?', answer: 'Yes' }])
  })

  it('encodes a skipped question as answer: null and renders as skipped', () => {
    let state = createInitialSessionState('s1')
    state = seedQuestion(state, 'tu_q')
    state = seedPendingPermission(state, 'pid-1', 'tu_q')

    state = reduceSessionState(state, {
      type: 'PERMISSION_RESOLVED',
      id: 'pid-1',
      decision: {
        behavior: 'deny',
        persisted: false,
        message: JSON.stringify({
          answers: [{ question: 'OK?', answer: null }],
        }),
      },
    })
    const entries = state.questionAnswers.get('tu_q')
    expect(entries).toEqual([{ question: 'OK?', answer: null }])
  })

  it('leaves questionAnswers unchanged when the message is not parseable JSON', () => {
    // Plain-deny path (non-question tools): decision.message is a free-form
    // human-readable string, not JSON. Must not corrupt question state.
    let state = createInitialSessionState('s1')
    state = seedQuestion(state, 'tu_q')
    state = seedPendingPermission(state, 'pid-1', 'tu_q')
    const before = state.questionAnswers

    state = reduceSessionState(state, {
      type: 'PERMISSION_RESOLVED',
      id: 'pid-1',
      decision: {
        behavior: 'deny',
        persisted: false,
        message: 'aborted',
      },
    })
    expect(state.questionAnswers).toBe(before)
  })

  it('does not touch questionAnswers when the toolUseId was never seeded as a question', () => {
    // Plain Bash deny: pidToToolUseId points at tu_bash but
    // questionAnswers has no entry for it — the parsing branch must
    // be gated on existing entry, otherwise an unrelated tool deny
    // could spuriously create one.
    let state = createInitialSessionState('s1')
    const bashRequest: PermissionRequest = {
      kind: 'permission',
      id: 'pid-bash',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      toolUseID: 'tu_bash',
      createdAt: 0,
    }
    state = reduceSessionState(state, { type: 'PERMISSION_REQUEST', request: bashRequest })

    state = reduceSessionState(state, {
      type: 'PERMISSION_RESOLVED',
      id: 'pid-bash',
      decision: {
        behavior: 'deny',
        persisted: false,
        // Even if the message happened to look like JSON, we must not
        // touch questionAnswers — this is a regular tool deny.
        message: JSON.stringify({ answers: [{ question: 'X', answer: 'Y' }] }),
      },
    })
    expect(state.questionAnswers.has('tu_bash')).toBe(false)
  })
})
