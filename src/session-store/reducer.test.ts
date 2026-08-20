import { describe, it, expect } from 'vitest'
import { reduceSessionState, splitReplayAgainstCache, rebuildIndexesFromMessages, reapplyDismissed } from './reducer'
import { createInitialSessionState, type SessionState, type ServerMirror } from './types'
import { isTrimBoundary } from './normalize'
import type { PermissionRequest, SdkMessage } from '../types'

const hasId = (ids: ReadonlyMap<string, unknown>, id: string) => ids.has(id)
const isEmpty = (ids: ReadonlyMap<string, unknown>) => ids.size === 0

/** Mirror of SessionStore.buildSnapshot's render-time merge: optimistic
 *  placeholders live in `intent.pendingPlaceholders`, NOT in `mirror.items`,
 *  so the tests that previously read `state.mirror.items` (which used to contain
 *  both) now go through this helper to see the merged view. */
function renderedItems(s: SessionState) {
  return s.intent.pendingPlaceholders.size === 0
    ? s.mirror.items
    : [...s.mirror.items, ...s.intent.pendingPlaceholders.values()]
}

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

function applyAck(
  state: ReturnType<typeof createInitialSessionState>,
  pendingId = 'optimistic:abc',
  serverUuid = 'real-server-uuid',
): ReturnType<typeof createInitialSessionState> {
  return reduceSessionState(state, {
    type: 'ACK_USER_MESSAGE',
    pendingId,
    serverUuid,
    receivedAt: 123,
  })
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
    expect(renderedItems(state).length).toBe(1)
    expect(renderedItems(state)[0].sending).toBe(true) // ← drives the spinner UI
    expect(hasId(state.intent.pendingPlaceholders, 'optimistic:abc')).toBe(true)

    state = applyServerEcho(state, 'hello', 'real-xyz')
    expect(renderedItems(state).length).toBe(1)
    expect(renderedItems(state)[0].id).toBe('real-xyz')
    // After the broadcast lands the replaced item has no `sending`
    // — the indicator clears automatically.
    expect(renderedItems(state)[0].sending).toBeUndefined()
    expect(isEmpty(state.intent.pendingPlaceholders)).toBe(true)
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
    expect(renderedItems(state).length).toBe(1)

    state = applyServerEcho(state, arr, 'real-img-uuid')
    expect(renderedItems(state).length).toBe(1)
    expect(renderedItems(state)[0].id).toBe('real-img-uuid')
  })

  it('clears sending on REST ack before the WS echo arrives', () => {
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'hello', 'optimistic:abc')
    expect(renderedItems(state)[0].sending).toBe(true)

    state = applyAck(state, 'optimistic:abc', 'real-ack-uuid')
    expect(renderedItems(state)).toHaveLength(1)
    expect(renderedItems(state)[0].id).toBe('real-ack-uuid')
    expect(renderedItems(state)[0].sending).toBeUndefined()
    expect(renderedItems(state)[0].deliveryStatus).toBe('queued')
    expect(hasId(state.intent.pendingPlaceholders, 'optimistic:abc')).toBe(false)
    expect(hasId(state.intent.pendingPlaceholders, 'real-ack-uuid')).toBe(true)

    state = applyServerEcho(state, 'hello', 'real-ack-uuid')
    expect(renderedItems(state)).toHaveLength(1)
    expect(renderedItems(state)[0].id).toBe('real-ack-uuid')
    expect(isEmpty(state.intent.pendingPlaceholders)).toBe(true)
  })

  it('applies a consumed signal that arrives before the REST ack', () => {
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'hello', 'optimistic:abc')

    state = reduceSessionState(state, {
      type: 'MESSAGE_CONSUMED',
      uuid: 'real-ack-uuid',
      consumedAt: 456,
    })
    expect(renderedItems(state)[0].sending).toBe(true)

    state = applyAck(state, 'optimistic:abc', 'real-ack-uuid')
    expect(renderedItems(state)).toHaveLength(1)
    expect(renderedItems(state)[0].id).toBe('real-ack-uuid')
    expect(renderedItems(state)[0].deliveryStatus).toBe('consumed')
    expect(renderedItems(state)[0].msg.consumedAt).toBe(456)
    // Placeholder is re-keyed (not removed) — pending awaits the echo.
    expect(hasId(state.intent.pendingPlaceholders, 'optimistic:abc')).toBe(false)
    expect(hasId(state.intent.pendingPlaceholders, 'real-ack-uuid')).toBe(true)
    expect(state.mirror.pendingConsumedMessages.size).toBe(0)
  })

  it('applies a consumed signal that arrives before the user message broadcast', () => {
    let state = createInitialSessionState('s1')

    state = reduceSessionState(state, {
      type: 'MESSAGE_CONSUMED',
      uuid: 'real-1',
      consumedAt: 789,
    })
    expect(state.mirror.pendingConsumedMessages.get('real-1')).toBe(789)

    state = applyServerEcho(state, 'hello', 'real-1')
    expect(renderedItems(state)).toHaveLength(1)
    expect(renderedItems(state)[0].deliveryStatus).toBe('consumed')
    expect(renderedItems(state)[0].msg.consumedAt).toBe(789)
    expect(state.mirror.pendingConsumedMessages.size).toBe(0)
  })

  it('does not downgrade an acked consumed row when the user message broadcast arrives later', () => {
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'hello', 'optimistic:abc')
    state = applyAck(state, 'optimistic:abc', 'real-ack-uuid')
    state = reduceSessionState(state, {
      type: 'MESSAGE_CONSUMED',
      uuid: 'real-ack-uuid',
      consumedAt: 456,
    })
    expect(renderedItems(state)[0].deliveryStatus).toBe('consumed')

    state = applyServerEcho(state, 'hello', 'real-ack-uuid')
    expect(renderedItems(state)).toHaveLength(1)
    expect(renderedItems(state)[0].id).toBe('real-ack-uuid')
    expect(renderedItems(state)[0].deliveryStatus).toBe('consumed')
    expect(renderedItems(state)[0].msg.consumedAt).toBe(456)
    expect(state.mirror.pendingConsumedMessages.size).toBe(0)
  })

  it('appends normally when no optimistic is pending', () => {
    let state = createInitialSessionState('s1')
    state = applyServerEcho(state, 'hello', 'real-1')
    expect(renderedItems(state).length).toBe(1)
    expect(renderedItems(state)[0].id).toBe('real-1')
    expect(isEmpty(state.intent.pendingPlaceholders)).toBe(true)
  })

  it('does NOT match a subagent tool_result against a pending optimistic', () => {
    // Tool_result frames also arrive as type=user but with
    // parent_tool_use_id set. They must not clobber the optimistic
    // placeholder — without the parent_tool_use_id guard, the user
    // would see their type text replaced by a JSON tool result.
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'real user input', 'optimistic:abc')
    expect(hasId(state.intent.pendingPlaceholders, 'optimistic:abc')).toBe(true)

    // tool_result-shaped user message arrives BEFORE the actual echo
    state = applyServerEcho(state, [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }], 'tool-result-uuid', 'subagent-id')

    // Optimistic survives (still in intent) — the tool_result was appended
    // separately to mirror.items. Render-merged view: tool_result + placeholder.
    const rendered = renderedItems(state)
    expect(rendered.length).toBe(2)
    // The placeholder is rendered AT THE TAIL post-refactor (intent values
    // are appended after mirror.items by buildSnapshot).
    expect(rendered[rendered.length - 1].id).toBe('optimistic:abc')
    expect(hasId(state.intent.pendingPlaceholders, 'optimistic:abc')).toBe(true)
  })

  it('clears pendingUserMessageIds on result frame even if no echo arrived', () => {
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'hello', 'optimistic:abc')
    expect(hasId(state.intent.pendingPlaceholders, 'optimistic:abc')).toBe(true)

    const resultMsg: SdkMessage = {
      type: 'result',
      subtype: 'success',
      uuid: 'r-1',
    } as unknown as SdkMessage
    state = reduceSessionState(state, { type: 'MESSAGE', message: resultMsg })
    expect(isEmpty(state.intent.pendingPlaceholders)).toBe(true)
    // Result frame clears the placeholder entirely (clearSendingPlaceholders),
    // so the render-merged view contains only the result row — no leftover
    // optimistic placeholder.
    const rendered = renderedItems(state)
    expect(rendered.some((it) => it.id === 'optimistic:abc')).toBe(false)
    expect(rendered.every((it) => it.msg.type !== 'user')).toBe(true)
  })
})

describe('reducer: subagent records survive turn end (result frame)', () => {
  const agentToolUse: SdkMessage = {
    type: 'assistant',
    uuid: 'a-1',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { description: 'do work' } },
      ],
    },
  } as unknown as SdkMessage

  it('captures the full input.prompt on the subagent record', () => {
    // The SDK doesn't echo a subagent's input prompt back as a child user
    // frame, so the overlay (which filters by parent_tool_use_id) would
    // have no trace of what was asked. The record carries the full prompt
    // so the overlay can render it as a "you" bubble.
    const longPrompt = 'Investigate the message-list scroll structure. '.repeat(5)
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-prompt',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_prompt', name: 'Agent', input: { description: 'short', prompt: longPrompt } },
        ],
      },
    } as unknown as SdkMessage
    const state = reduceSessionState(createInitialSessionState('s1'), { type: 'MESSAGE', message: toolUse })
    const record = state.mirror.activeSubagents.get('tu_prompt')
    expect(record?.label).toBe('short') // description wins as the label
    expect(record?.prompt).toBe(longPrompt) // full prompt preserved, untruncated
  })

  const agentResult: SdkMessage = {
    type: 'user',
    uuid: 'u-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'worker output' }],
    },
  } as unknown as SdkMessage

  const resultFrame: SdkMessage = {
    type: 'result',
    subtype: 'success',
    uuid: 'r-1',
  } as unknown as SdkMessage

  it('keeps a completed subagent (with merged result) after the result frame', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentResult })

    // Before turn end: recorded as done, result captured for the merged card.
    const mid = state.mirror.activeSubagents.get('tu_agent')
    expect(mid?.status).toBe('done')
    expect(mid?.result?.content).toBe('worker output')

    // Turn ends. The record (and its result) MUST survive — otherwise
    // SubagentCard falls back to a bare placeholder and the orphan
    // tool_result bubble reappears below it (the bug this guards).
    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })
    const after = state.mirror.activeSubagents.get('tu_agent')
    expect(after?.status).toBe('done')
    expect(after?.result?.content).toBe('worker output')
  })

  it('flips a still-running subagent to interrupted at the result frame (no orphan)', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse })
    expect(state.mirror.activeSubagents.get('tu_agent')?.status).toBe('running')

    // Result frame arrives before the subagent's tool_result matched.
    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })
    const after = state.mirror.activeSubagents.get('tu_agent')
    expect(after).toBeDefined()
    expect(after?.status).toBe('interrupted')
  })

  it('flips an async-ack subagent to background (not done) and advances endedAt to the last child frame', () => {
    // Async/background subagent: the Agent tool_result is a launch ack that
    // arrives within ms of the tool_use, well before the subagent's real
    // output streams as child frames (parent_tool_use_id === subagent id).
    // The ack must NOT flip status to 'done' — it flips to 'background' so
    // the chip stays in the WorkingBubble row, with NO endedAt (the ack time
    // isn't the real run time). endedAt then tracks the last child frame.
    const ackAt = 1_000
    const childAt = 6_000 // 5s later — the subagent's real run time
    const childFrame: SdkMessage = {
      type: 'assistant',
      uuid: 'c-1',
      parent_tool_use_id: 'tu_agent',
      receivedAt: childAt,
      message: { role: 'assistant', content: [{ type: 'text', text: 'worker output' }] },
    } as unknown as SdkMessage
    const ackResult: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: ackAt,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ackResult })
    // Ack landed → 'background' (still working, chip stays visible). No
    // endedAt, no result — the ack is internal metadata, not completion.
    const afterAck = state.mirror.activeSubagents.get('tu_agent')
    expect(afterAck?.status).toBe('background')
    expect(afterAck?.endedAt).toBeUndefined()
    expect(afterAck?.result).toBeUndefined()

    // The subagent's real output arrives 5s later as a child frame.
    state = reduceSessionState(state, { type: 'MESSAGE', message: childFrame })
    const record = state.mirror.activeSubagents.get('tu_agent')
    expect(record?.endedAt).toBe(childAt)
    // Still 'background' — child frames don't complete an async subagent.
    expect(record?.status).toBe('background')
    // The child text frame is captured as the card's result — the ack is
    // internal metadata, the real output is the subagent's text.
    expect(record?.result?.content).toEqual([{ type: 'text', text: 'worker output' }])
    expect(record?.result?.isError).toBe(false)
  })

  it('flips a background subagent to done when the harness <task-notification> arrives', () => {
    // The real completion signal for an async subagent is a <task-notification>
    // user-role XML injection carrying the originating Agent tool_use_id.
    // It must flip 'background' → 'done', stamp endedAt to the notification's
    // receivedAt, and leave the already-captured child-text result in place
    // (don't clobber the streamed output with the repackaged notification).
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_async', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_async', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const child: SdkMessage = {
      type: 'assistant',
      uuid: 'c-1',
      parent_tool_use_id: 'tu_async',
      receivedAt: 5_000,
      message: { role: 'assistant', content: [{ type: 'text', text: 'real output' }] },
    } as unknown as SdkMessage
    const doneAt = 9_000
    const notification: SdkMessage = {
      type: 'user',
      uuid: 'u-done',
      parent_tool_use_id: null,
      receivedAt: doneAt,
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>t-1</task-id>\n<tool-use-id>tu_async</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n<result>repackaged</result>\n</task-notification>',
      },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    state = reduceSessionState(state, { type: 'MESSAGE', message: child })
    expect(state.mirror.activeSubagents.get('tu_async')?.status).toBe('background')

    state = reduceSessionState(state, { type: 'MESSAGE', message: notification })
    const record = state.mirror.activeSubagents.get('tu_async')
    expect(record?.status).toBe('done')
    expect(record?.endedAt).toBe(doneAt)
    // Child-text result is NOT clobbered by the notification's <result>.
    expect(record?.result?.content).toEqual([{ type: 'text', text: 'real output' }])
    expect(record?.result?.isError).toBe(false)
  })

  it('flips a background subagent to done via the SDK system/task_notification frame', () => {
    // The SDK's own completion path: a `system`/`task_notification` frame
    // with an optional tool_use_id. When present it must flip 'background'
    // → 'done'. Without child text, the result falls back to the summary.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_sys', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_sys', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const doneAt = 8_000
    const sysFrame: SdkMessage = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'sys-1',
      task_id: 't-1',
      tool_use_id: 'tu_sys',
      status: 'completed',
      summary: 'all done',
      output_file: '/tmp/x',
      receivedAt: doneAt,
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    expect(state.mirror.activeSubagents.get('tu_sys')?.status).toBe('background')

    state = reduceSessionState(state, { type: 'MESSAGE', message: sysFrame })
    const record = state.mirror.activeSubagents.get('tu_sys')
    expect(record?.status).toBe('done')
    expect(record?.endedAt).toBe(doneAt)
    // No child text → result falls back to the summary string.
    expect(record?.result?.content).toBe('all done')
    expect(record?.result?.isError).toBe(false)
  })

  it('recovers a lost ack: completion flips a still-running record to done', () => {
    // If the launch-ack tool_result frame is lost (WS gap / replay hole), the
    // record never flips to 'background' and stays 'running'. The completion
    // signal must still flip it to 'done' (the guard accepts 'running') and
    // stamp isAsync/result so the card doesn't degrade.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_lost', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    // NOTE: no ack frame — it was lost.
    const notification: SdkMessage = {
      type: 'user',
      uuid: 'u-done',
      parent_tool_use_id: null,
      receivedAt: 9_000,
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>t-1</task-id>\n<tool-use-id>tu_lost</tool-use-id>\n<status>completed</status>\n<summary>recovered</summary>\n</task-notification>',
      },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    expect(state.mirror.activeSubagents.get('tu_lost')?.status).toBe('running')

    state = reduceSessionState(state, { type: 'MESSAGE', message: notification })
    const record = state.mirror.activeSubagents.get('tu_lost')
    expect(record?.status).toBe('done')
    expect(record?.endedAt).toBe(9_000)
    expect(record?.isAsync).toBe(true)
    expect(record?.result?.content).toBe('recovered')
  })

  it('does not misfire the ack sniff on a sync result that merely mentions the phrase', () => {
    // The ack regex is anchored to the START of the content and the exact ack
    // phrase, so a synchronous subagent whose real tool_result text contains
    // "async agent launched" mid-sentence must NOT be mistaken for a launch
    // ack (which would strand it on 'background' forever with no result).
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_sync', name: 'Agent', input: { description: 'investigate' } }],
      },
    } as unknown as SdkMessage
    const realResult: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_sync', content: 'I found that the async agent launched at 14:32 and completed.' }],
      },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: realResult })
    const record = state.mirror.activeSubagents.get('tu_sync')
    // Not mistaken for an ack → real completion, done with the real result.
    expect(record?.status).toBe('done')
    expect(record?.result?.content).toBe('I found that the async agent launched at 14:32 and completed.')
  })

  it('sweeps a still-background subagent to pending at turn end (not interrupted)', () => {
    // The SDK's background-task completion signal (task_notification) is not
    // reliably emitted for Agent-launched background subagents in all
    // environments, and even when emitted it often arrives AFTER the parent
    // turn ended. A 'background' record that is still mid-flight at the
    // parent's result frame must leave the running set (so its WorkingBubble
    // chip doesn't reappear on every subsequent turn), but it must NOT be
    // marked 'interrupted' — that would conflate "turn ended, completion
    // pending" with "user interrupted" and the completion branch (which
    // excludes 'interrupted') would silently drop the real completion. It
    // flips to 'pending', which getRunningSubagents excludes (chip gone) but
    // the completion branch still accepts.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_bg', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_bg', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const result: SdkMessage = {
      type: 'result',
      subtype: 'success',
      uuid: 'r-1',
      receivedAt: 2_000,
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    expect(state.mirror.activeSubagents.get('tu_bg')?.status).toBe('background')
    state = reduceSessionState(state, { type: 'MESSAGE', message: result })
    // Swept to 'pending' (out of the running set, but NOT interrupted).
    expect(state.mirror.activeSubagents.get('tu_bg')?.status).toBe('pending')
  })

  it('a late task_notification flips a pending (swept) background subagent to done', () => {
    // The core race this fixes: an async subagent outlives the parent turn,
    // so the result frame sweeps background -> pending BEFORE the completion
    // signal arrives. The task_notification lands later (possibly turns
    // later) and must still flip pending -> done with the real output —
    // previously the sweep left the record 'interrupted' and the completion
    // branch dropped the signal, leaving a successfully-finished subagent
    // stuck on a wrong error state.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_late', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_late', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const result: SdkMessage = {
      type: 'result',
      subtype: 'success',
      uuid: 'r-1',
      receivedAt: 2_000,
    } as unknown as SdkMessage
    const lateNotification: SdkMessage = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'sys-late',
      task_id: 't-late',
      tool_use_id: 'tu_late',
      status: 'completed',
      summary: 'finished in the background',
      output_file: '/tmp/x',
      receivedAt: 30_000,
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    state = reduceSessionState(state, { type: 'MESSAGE', message: result })
    expect(state.mirror.activeSubagents.get('tu_late')?.status).toBe('pending')
    // The completion signal arrives well after the parent turn ended.
    state = reduceSessionState(state, { type: 'MESSAGE', message: lateNotification })
    const record = state.mirror.activeSubagents.get('tu_late')
    expect(record?.status).toBe('done')
    expect(record?.endedAt).toBe(30_000)
    expect(record?.isAsync).toBe(true)
    expect(record?.result?.content).toBe('finished in the background')
    expect(record?.result?.isError).toBe(false)
  })

  it('a late real completed overrides a synthesized stopped (interrupted) record', () => {
    // The server watcher's maxMs backstop can synthesize a 'stopped'
    // task_notification (status !== 'completed') that flips a still-running
    // background subagent to 'interrupted'. A later REAL completion must
    // override that false stop — otherwise the synthesized 'interrupted'
    // poisons the record permanently (the whole point of accepting
    // 'interrupted' in the completion branch). 'dismissed' stays excluded
    // (an explicit user dismiss is a deliberate terminal state).
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_ovr', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_ovr', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const synthesizedStop: SdkMessage = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'sys-stop',
      task_id: 't-ovr',
      tool_use_id: 'tu_ovr',
      status: 'stopped',
      summary: '',
      output_file: '',
      receivedAt: 20_000,
    } as unknown as SdkMessage
    const realCompletion: SdkMessage = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'sys-real',
      task_id: 't-ovr',
      tool_use_id: 'tu_ovr',
      status: 'completed',
      summary: 'actually finished',
      output_file: '',
      receivedAt: 30_000,
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    // The watcher's backstop synthesizes a stop while the subagent is still
    // running (background). The record flips to 'interrupted'.
    state = reduceSessionState(state, { type: 'MESSAGE', message: synthesizedStop })
    expect(state.mirror.activeSubagents.get('tu_ovr')?.status).toBe('interrupted')
    // The real completion arrives later — it MUST override the false stop.
    state = reduceSessionState(state, { type: 'MESSAGE', message: realCompletion })
    const record = state.mirror.activeSubagents.get('tu_ovr')
    expect(record?.status).toBe('done')
    expect(record?.endedAt).toBe(30_000)
    expect(record?.result?.content).toBe('actually finished')
    expect(record?.result?.isError).toBe(false)
  })

  it('a non-end_turn terminal completion (stop_sequence) flips background to done, NOT interrupted', () => {
    // Regression: the server watcher (subagent-watcher.ts) used to map any
    // non-end_turn terminal stop_reason to status:'stopped', which the
    // reducer treated as an error (interrupted → exclamation icon). A
    // subagent that finished via stop_sequence / max_turns / max_tokens is
    // a NORMAL completion (it returned output), so the watcher now maps
    // every terminal stop_reason to 'completed'. This test pins the
    // end-to-end wire shape: a task_notification carrying status:'completed'
    // (the watcher's new output for stop_sequence) must flip background →
    // done with the real output, never interrupted.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-seq',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_seq', name: 'Agent', input: { description: 'do work', run_in_background: true } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-seq',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_seq', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const completion: SdkMessage = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'sys-seq',
      task_id: 't-seq',
      tool_use_id: 'tu_seq',
      status: 'completed', // stop_sequence is now 'completed', not 'stopped'
      summary: 'here is my result',
      output_file: '',
      receivedAt: 5_000,
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    expect(state.mirror.activeSubagents.get('tu_seq')?.status).toBe('background')
    state = reduceSessionState(state, { type: 'MESSAGE', message: completion })
    const record = state.mirror.activeSubagents.get('tu_seq')
    expect(record?.status).toBe('done')
    expect(record?.result?.content).toBe('here is my result')
    expect(record?.result?.isError).toBe(false)
  })

  it('DISMISS_SUBAGENT flips a pending record to dismissed and ignores late completion', () => {
    // The Waiting bubble's dismiss affordance lets the user give up on
    // tracking a pending background subagent. It must flip pending ->
    // 'dismissed' (a distinct status, NOT 'interrupted', so the inline card
    // renders neutral instead of a false error) and a later task_notification
    // must NOT override it (the completion branch excludes 'dismissed') — the
    // user explicitly stopped tracking.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_dis', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_dis', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const result: SdkMessage = {
      type: 'result',
      subtype: 'success',
      uuid: 'r-1',
      receivedAt: 2_000,
    } as unknown as SdkMessage
    const lateNotification: SdkMessage = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'sys-late',
      task_id: 't-dis',
      tool_use_id: 'tu_dis',
      status: 'completed',
      summary: 'finished after dismiss',
      output_file: '/tmp/x',
      receivedAt: 30_000,
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    state = reduceSessionState(state, { type: 'MESSAGE', message: result })
    expect(state.mirror.activeSubagents.get('tu_dis')?.status).toBe('pending')
    // Dismiss -> 'dismissed' (a distinct status, NOT 'interrupted', so the
    // inline card renders neutral instead of a false error).
    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_dis' })
    expect(state.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
    // Late completion is ignored (dismissed is excluded from the completion
    // branch, like interrupted).
    state = reduceSessionState(state, { type: 'MESSAGE', message: lateNotification })
    expect(state.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
    // Dismissing a non-pending record is a no-op (identity-stable).
    const before = state
    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_dis' })
    expect(state).toBe(before)
    // Dismissing an unknown id is a no-op.
    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'nope' })
    expect(state).toBe(before)
  })

  it('DISMISS_SUBAGENT also works for running and background subagents', () => {
    // Dismiss is not limited to `pending` — sync (running) and async
    // (background) subagents can be dismissed from the overlay's × too.
    // For sync the tool_result merge later overwrites to done/interrupted;
    // for async the completion branch excludes dismissed (permanent).
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_sync', name: 'Agent', input: { description: 'sync work' } }],
      },
    } as unknown as SdkMessage
    const toolUse2: SdkMessage = {
      type: 'assistant',
      uuid: 'a-2',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_async', name: 'Agent', input: { description: 'async work', run_in_background: true } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_async', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    // Sync subagent: running (no tool_result yet).
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    expect(state.mirror.activeSubagents.get('tu_sync')?.status).toBe('running')
    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_sync' })
    expect(state.mirror.activeSubagents.get('tu_sync')?.status).toBe('dismissed')

    // Async subagent: background (ack landed).
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse2 })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    expect(state.mirror.activeSubagents.get('tu_async')?.status).toBe('background')
    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_async' })
    expect(state.mirror.activeSubagents.get('tu_async')?.status).toBe('dismissed')

    // Dismissing an already-settled (done) record is a no-op.
    const before = state
    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_sync' })
    expect(state).toBe(before)
  })

  it('DISMISS_SUBAGENT records the id on intent.dismissedSubagents', () => {
    const toolUse: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_i', name: 'Agent', input: { description: 'w' } }] },
    } as unknown as SdkMessage
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_i' })
    expect(state.mirror.activeSubagents.get('tu_i')?.status).toBe('dismissed')
    expect(state.intent.dismissedSubagents.has('tu_i')).toBe(true)
  })

  it('a dismissed async subagent stays dismissed after refresh-style rebuild + reapply', () => {
    const toolUse: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_dis', name: 'Agent', input: { description: 'do work' } }] },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user', uuid: 'u-1', parent_tool_use_id: null, receivedAt: 1_000,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_dis', content: 'Async agent launched successfully' }] },
    } as unknown as SdkMessage
    const result: SdkMessage = { type: 'result', subtype: 'success', uuid: 'r-1', receivedAt: 2_000 } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    for (const m of [toolUse, ack, result]) state = reduceSessionState(state, { type: 'MESSAGE', message: m })
    expect(state.mirror.activeSubagents.get('tu_dis')?.status).toBe('pending')

    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_dis' })
    expect(state.intent.dismissedSubagents.has('tu_dis')).toBe(true)

    // Refresh simulation (mirrors SessionStore constructor): fresh mirror,
    // seed the cached transcript, rebuild indexes, re-apply persisted dismiss.
    const fresh = createInitialSessionState('s1')
    const seededMirror: ServerMirror = {
      ...fresh.mirror,
      messages: state.mirror.messages,
      items: state.mirror.items,
      lastMessageUuid: state.mirror.lastMessageUuid,
      replayReady: true,
    }
    const seeded: SessionState = {
      sessionId: 's1',
      mirror: seededMirror,
      intent: { ...fresh.intent, dismissedSubagents: state.intent.dismissedSubagents },
    }
    const rebuilt = reapplyDismissed(rebuildIndexesFromMessages(seeded, seededMirror.messages))
    expect(rebuilt.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
  })

  it('reapplyDismissed prunes ids for absent records', () => {
    // Two dismissed in-flight records, then a /clear-style empty mirror: the
    // ids must be pruned from intent (nothing to dismiss against).
    const toolUseA: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_a', name: 'Agent', input: { description: 'a' } }] },
    } as unknown as SdkMessage
    const toolUseB: SdkMessage = {
      type: 'assistant', uuid: 'a-2', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_b', name: 'Agent', input: { description: 'b' } }] },
    } as unknown as SdkMessage
    let state = createInitialSessionState('s1')
    for (const m of [toolUseA, toolUseB]) state = reduceSessionState(state, { type: 'MESSAGE', message: m })
    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_a' })
    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_b' })
    expect(state.intent.dismissedSubagents.size).toBe(2)

    const cleared = createInitialSessionState('s1')
    const seeded: SessionState = {
      sessionId: 's1',
      mirror: cleared.mirror,
      intent: { ...cleared.intent, dismissedSubagents: state.intent.dismissedSubagents },
    }
    const reapplied = reapplyDismissed(seeded)
    expect(reapplied.intent.dismissedSubagents.size).toBe(0)
  })

  it('reapplyDismissed is idempotent', () => {
    const toolUse: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_dis', name: 'Agent', input: { description: 'w' } }] },
    } as unknown as SdkMessage
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'DISMISS_SUBAGENT', toolUseId: 'tu_dis' })

    const fresh = createInitialSessionState('s1')
    const seededMirror: ServerMirror = {
      ...fresh.mirror,
      messages: state.mirror.messages,
      items: state.mirror.items,
      lastMessageUuid: state.mirror.lastMessageUuid,
      replayReady: true,
    }
    const seeded: SessionState = {
      sessionId: 's1',
      mirror: seededMirror,
      intent: { ...fresh.intent, dismissedSubagents: state.intent.dismissedSubagents },
    }
    const once = reapplyDismissed(rebuildIndexesFromMessages(seeded, seededMirror.messages))
    expect(once.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
    const twice = reapplyDismissed(once)
    expect(twice).toBe(once)
  })

  it('REPLAY re-applies the turn-end sweep (background -> pending) on hydration', () => {
    // Regression: rebuildIndexesFromMessages (the replay/hydration path)
    // must apply the same turn-end sweep as the live path. Otherwise a WS
    // reconnect re-derives a swept-to-pending background subagent back as
    // 'background' (the result frame's sweep never re-ran), which breaks the
    // Waiting bubble across reconnects — waiting is derived from 'pending'.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_replay', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_replay', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const result: SdkMessage = {
      type: 'result',
      subtype: 'success',
      uuid: 'r-1',
      receivedAt: 2_000,
    } as unknown as SdkMessage

    // Hydrate straight from a replay of the full turn (no live applyMessage).
    const state = reduceSessionState(createInitialSessionState('s1'), {
      type: 'REPLAY_REPLACE',
      messages: [toolUse, ack, result],
      permissions: [],
    })
    // The result frame's sweep must have run during rebuild -> 'pending',
    // NOT 'background' (the old replay-gap bug).
    expect(state.mirror.activeSubagents.get('tu_replay')?.status).toBe('pending')
  })

  it('post-replay sweep flips background→pending even WITHOUT result frames (disk replay)', () => {
    // The CLI transcript has no `result` frames — the per-turn sweep in
    // applyMessage never fires during a disk-loaded replay. The post-replay
    // sweepAtTurnEnd call in replayReplace catches the unswept 'background'
    // record and flips it to 'pending', so the Waiting bubble shows correctly
    // after a server restart + client refresh.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      restoredFromDisk: true,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_nores', name: 'Agent', input: { description: 'do work', run_in_background: true } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      restoredFromDisk: true,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_nores', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    // NO result frame — simulates a disk-loaded replay.
    const state = reduceSessionState(createInitialSessionState('s1'), {
      type: 'REPLAY_REPLACE',
      messages: [toolUse, ack],
      permissions: [],
    })
    // Post-replay sweep must have flipped background → pending.
    expect(state.mirror.activeSubagents.get('tu_nores')?.status).toBe('pending')
  })

  it('does not sweep a live-memory replay while a sync subagent is still running', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: {
        type: 'assistant', uuid: 'cached', receivedAt: Date.now() - 1_000,
        message: { role: 'assistant', content: [{ type: 'text', text: 'cached' }] },
      } as unknown as SdkMessage,
    })
    const liveStart = {
      type: 'assistant', uuid: 'sync-live', receivedAt: Date.now(),
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 'tu_sync_live', name: 'Agent',
          input: { description: 'still running', run_in_background: false },
        }],
      },
    } as unknown as SdkMessage

    state = reduceSessionState(state, {
      type: 'REPLAY_REPLACE', messages: [liveStart], permissions: [],
    })

    expect(state.mirror.activeSubagents.get('tu_sync_live')?.status).toBe('running')
  })

  it('does not sweep a fresh live-memory replay while a sync subagent is still running', () => {
    const liveStart = {
      type: 'assistant', uuid: 'sync-live', receivedAt: Date.now(),
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 'tu_sync_live', name: 'Agent',
          input: { description: 'still running', run_in_background: false },
        }],
      },
    } as unknown as SdkMessage
    const state = reduceSessionState(createInitialSessionState('s1'), {
      type: 'REPLAY_REPLACE', messages: [liveStart], permissions: [],
    })
    expect(state.mirror.activeSubagents.get('tu_sync_live')?.status).toBe('running')
  })

  it('still sweeps an orphaned sync subagent restored from disk', () => {
    const diskStart = {
      type: 'assistant', uuid: 'sync-disk', restoredFromDisk: true,
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 'tu_sync_disk', name: 'Agent',
          input: { description: 'orphaned', run_in_background: false },
        }],
      },
    } as unknown as SdkMessage
    const state = reduceSessionState(createInitialSessionState('s1'), {
      type: 'REPLAY_REPLACE', messages: [diskStart], permissions: [],
    })
    expect(state.mirror.activeSubagents.get('tu_sync_disk')?.status).toBe('interrupted')
  })

  it('stale-pending safety net flips a stranded pending record to interrupted', () => {
    // If the server watcher that would synthesize a background subagent's
    // completion is lost (server restart cleared the in-memory watcher map,
    // the SDK's resume replay didn't re-include the launch ack, …) the record
    // strands at `pending` forever. The sweep's stale-pending safety net flips
    // such a record to `interrupted` once its last child-frame activity is
    // older than PENDING_TIMEOUT_MS (30 min), so the WorkingBubble chip clears.
    // A late real completion still overrides (the completion branch accepts
    // 'interrupted').
    const recent = Date.now()
    const stale = recent - 31 * 60 * 1000 // 31 min ago — just past the 30-min threshold
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: stale - 2_000,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_stale', name: 'Agent', input: { description: 'do work', run_in_background: true } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: stale - 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_stale', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const result: SdkMessage = {
      type: 'result',
      subtype: 'success',
      uuid: 'r-1',
      receivedAt: stale,
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    state = reduceSessionState(state, { type: 'MESSAGE', message: result })
    // After the result frame: background → pending (sweep). The record's
    // lastActivity (endedAt) is `stale` (31 min ago), so the safety net then
    // flips pending → interrupted on the SAME sweep.
    expect(state.mirror.activeSubagents.get('tu_stale')?.status).toBe('interrupted')

    // A fresh (recent) pending record is NOT false-stopped.
    const freshToolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-2',
      receivedAt: recent - 2_000,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_fresh', name: 'Agent', input: { description: 'do work', run_in_background: true } }],
      },
    } as unknown as SdkMessage
    const freshAck: SdkMessage = {
      type: 'user',
      uuid: 'u-2',
      parent_tool_use_id: null,
      receivedAt: recent - 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_fresh', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const freshResult: SdkMessage = {
      type: 'result',
      subtype: 'success',
      uuid: 'r-2',
      receivedAt: recent,
    } as unknown as SdkMessage
    state = reduceSessionState(state, { type: 'MESSAGE', message: freshToolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: freshAck })
    state = reduceSessionState(state, { type: 'MESSAGE', message: freshResult })
    expect(state.mirror.activeSubagents.get('tu_fresh')?.status).toBe('pending')
  })

  it('PREPEND_MESSAGES does NOT sweep live in-flight tools via historical result frames', () => {
    // Regression: the turn-end sweep must NOT run on the prepend/loadOlder
    // path. prependMessages starts from the LIVE mirror (which holds the
    // active turn's running tools) and calls rebuildIndexesFromMessages on the
    // prepended OLDER batch. If a swept result frame there iterated the live
    // maps, an active turn's running tool would flip to 'error' and a
    // background subagent to 'pending' mid-turn. The sweep lives in
    // applyMessage only (which prepend never calls).
    const liveToolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-live',
      receivedAt: 5_000,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_live', name: 'Bash', input: { command: 'echo hi' } }],
      },
    } as unknown as SdkMessage
    // An OLDER turn's result frame, prepended via loadOlder.
    const oldResult: SdkMessage = {
      type: 'result',
      subtype: 'success',
      uuid: 'r-old',
      receivedAt: 1_000,
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    // Live turn emits a tool_use (seeds toolStatus['tu_live'] = 'running').
    state = reduceSessionState(state, { type: 'MESSAGE', message: liveToolUse })
    expect(state.mirror.toolStatus.get('tu_live')).toBe('running')
    // User scrolls up: an older result frame is prepended.
    state = reduceSessionState(state, { type: 'PREPEND_MESSAGES', messages: [oldResult] })
    // The live tool must NOT have been swept to 'error' by the old result frame.
    expect(state.mirror.toolStatus.get('tu_live')).toBe('running')
  })

  it('does NOT sweep a background subagent that already completed via task_notification', () => {
    // If the completion signal DID arrive during the turn, the record is
    // already 'done' (with its result captured). The turn-end sweep must
    // not downgrade it to 'interrupted'.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-1',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_done', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_done', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const notification: SdkMessage = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'sys-1',
      task_id: 't-1',
      tool_use_id: 'tu_done',
      status: 'completed',
      summary: 'done',
      output_file: '/tmp/x',
      receivedAt: 1_500,
    } as unknown as SdkMessage
    const result: SdkMessage = {
      type: 'result',
      subtype: 'success',
      uuid: 'r-1',
      receivedAt: 2_000,
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    state = reduceSessionState(state, { type: 'MESSAGE', message: notification })
    expect(state.mirror.activeSubagents.get('tu_done')?.status).toBe('done')
    state = reduceSessionState(state, { type: 'MESSAGE', message: result })
    expect(state.mirror.activeSubagents.get('tu_done')?.status).toBe('done')
  })

  it('keeps the sync tool_result as result when it lands after child text', () => {
    // Synchronous subagent: child text frames stream first, then the Agent
    // tool_result (the canonical output) lands last. The merge branch must
    // re-override `result` so the child's intermediate text doesn't replace
    // the tool_result — guards the sync path against the async-ack override.
    const syncToolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-sync',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_sync', name: 'Agent', input: { description: 'do work', run_in_background: false } }],
      },
    } as unknown as SdkMessage
    const childFrame: SdkMessage = {
      type: 'assistant',
      uuid: 'c-1',
      parent_tool_use_id: 'tu_sync',
      receivedAt: 1_000,
      message: { role: 'assistant', content: [{ type: 'text', text: 'intermediate musing' }] },
    } as unknown as SdkMessage
    const agentResult: SdkMessage = {
      type: 'user',
      uuid: 'u-1',
      parent_tool_use_id: null,
      receivedAt: 2_000,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_sync', content: 'final summary' }],
      },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: syncToolUse })
    // Seeded false from the explicit run_in_background: false flag.
    expect(state.mirror.activeSubagents.get('tu_sync')?.isAsync).toBe(false)
    state = reduceSessionState(state, { type: 'MESSAGE', message: childFrame })
    // Child text captured mid-flight.
    expect(state.mirror.activeSubagents.get('tu_sync')?.result?.content)
      .toEqual([{ type: 'text', text: 'intermediate musing' }])

    // Tool_result lands last and wins.
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentResult })
    expect(state.mirror.activeSubagents.get('tu_sync')?.result?.content).toBe('final summary')
    expect(state.mirror.activeSubagents.get('tu_sync')?.status).toBe('done')
    // Sync: no child frame arrived after the tool_result, so isAsync stays
    // false (frame timing never flips it for a synchronous subagent).
    expect(state.mirror.activeSubagents.get('tu_sync')?.isAsync).toBe(false)
  })

  it('detects async via frame timing (child arrives after the ack result)', () => {
    // No run_in_background flag on the input — isAsync starts undefined.
    // The ack (tool_result) lands first, then a child frame arrives. A
    // child-after-result is the async signature, so isAsync flips to true.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-async',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_async', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user',
      uuid: 'u-async',
      parent_tool_use_id: null,
      receivedAt: 10,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_async', content: 'Async agent launched successfully' }],
      },
    } as unknown as SdkMessage
    const child: SdkMessage = {
      type: 'assistant',
      uuid: 'c-async',
      parent_tool_use_id: 'tu_async',
      receivedAt: 5_000,
      message: { role: 'assistant', content: [{ type: 'text', text: 'real output' }] },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    expect(state.mirror.activeSubagents.get('tu_async')?.isAsync).toBeUndefined()
    state = reduceSessionState(state, { type: 'MESSAGE', message: ack })
    // Ack landed but no child yet — still unknown.
    expect(state.mirror.activeSubagents.get('tu_async')?.isAsync).toBeUndefined()
    state = reduceSessionState(state, { type: 'MESSAGE', message: child })
    // Child after ack → async.
    expect(state.mirror.activeSubagents.get('tu_async')?.isAsync).toBe(true)
  })

  it('does not mislabel a sync subagent as async when child text sets result', () => {
    // Regression guard: the toolCount branch writes `result` from child
    // text (the #2 fix), so a naive `result != null` check for "ack
    // landed" would flip isAsync on the SECOND child of a sync subagent.
    // The detector uses `status === 'done'` instead (only the result-merge
    // branch sets done), so a sync subagent with multiple text-bearing
    // children stays sync throughout.
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-sync2',
      receivedAt: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_sync2', name: 'Agent', input: { description: 'do work' } }],
      },
    } as unknown as SdkMessage
    const childA: SdkMessage = {
      type: 'assistant',
      uuid: 'c-a',
      parent_tool_use_id: 'tu_sync2',
      receivedAt: 1_000,
      message: { role: 'assistant', content: [{ type: 'text', text: 'first musing' }] },
    } as unknown as SdkMessage
    const childB: SdkMessage = {
      type: 'assistant',
      uuid: 'c-b',
      parent_tool_use_id: 'tu_sync2',
      receivedAt: 2_000,
      message: { role: 'assistant', content: [{ type: 'text', text: 'second musing' }] },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: childA })
    // First child set `result` (text capture) but isAsync must NOT flip.
    expect(state.mirror.activeSubagents.get('tu_sync2')?.result?.content)
      .toEqual([{ type: 'text', text: 'first musing' }])
    expect(state.mirror.activeSubagents.get('tu_sync2')?.isAsync).toBeUndefined()
    state = reduceSessionState(state, { type: 'MESSAGE', message: childB })
    // Second child — still no ack, still not async. This is the regression
    // point: `result` is non-null from childA, but status is still running.
    expect(state.mirror.activeSubagents.get('tu_sync2')?.isAsync).toBeUndefined()
    expect(state.mirror.activeSubagents.get('tu_sync2')?.status).toBe('running')
  })
})

describe('reducer: Workflow indexing', () => {
  // A Workflow tool_use on the MAIN thread. Realistic input shape: the SDK
  // WorkflowInput has no `meta` field — meta lives INSIDE the `script`
  // string as `export const meta = {…}`. The reducer's getWorkflowStarts
  // parses the script to recover name + declared phases.
  const workflowToolUse: SdkMessage = {
    type: 'assistant',
    uuid: 'a-wf',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu_workflow',
          name: 'Workflow',
          input: {
            script:
              "export const meta = { name: 'find-flaky-tests', description: 'Find flaky tests', phases: [{ title: 'Scan', detail: 'grep CI logs' }, { title: 'Fix', detail: 'one agent per flaky test' }] }\n" +
              'phase("Scan")\nagent("hi")\n',
          },
        },
      ],
    },
  } as unknown as SdkMessage

  // A child agent spawned by the Workflow — an assistant frame INSIDE the
  // Workflow's sidechain, so parent_tool_use_id = the Workflow's tool_use id.
  // Its input carries the `phase` tag the script assigned.
  const childAgentStart: SdkMessage = {
    type: 'assistant',
    uuid: 'a-child',
    parent_tool_use_id: 'tu_workflow',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_child1', name: 'Agent', input: { description: 'scan logs', phase: 'Scan' } },
        { type: 'tool_use', id: 'tu_child2', name: 'Task', input: { description: 'fix test', phase: 'Fix' } },
      ],
    },
  } as unknown as SdkMessage

  // A child's tool_result — lands in the Workflow's sidechain (parent =
  // Workflow id), tool_use_id = the child's id. Should flip that child to done.
  const childResult: SdkMessage = {
    type: 'user',
    uuid: 'u-child',
    parent_tool_use_id: 'tu_workflow',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_child1', content: 'found 2 flaky' }],
    },
  } as unknown as SdkMessage

  // The Workflow's OWN tool_result — synthesized summary on the MAIN thread
  // (no parent_tool_use_id). Flips the Workflow record to done.
  const workflowResult: SdkMessage = {
    type: 'user',
    uuid: 'u-wf',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_workflow', content: 'workflow done' }],
    },
  } as unknown as SdkMessage

  const resultFrame: SdkMessage = {
    type: 'result',
    subtype: 'success',
    uuid: 'r-wf',
  } as unknown as SdkMessage

  it('seeds a Workflow record with parsed phases + label from meta', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowToolUse })

    const wf = state.mirror.activeWorkflows.get('tu_workflow')
    expect(wf).toBeDefined()
    expect(wf?.status).toBe('running')
    expect(wf?.label).toBe('find-flaky-tests')
    expect(wf?.phases.map((p) => p.title)).toEqual(['Scan', 'Fix'])
    expect(wf?.phases[0].detail).toBe('grep CI logs')
    expect(wf?.childAgents).toEqual([])
  })

  it('indexes child agents with their phase tag (grouped under the Workflow)', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowToolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: childAgentStart })

    const wf = state.mirror.activeWorkflows.get('tu_workflow')
    expect(wf?.childAgents.length).toBe(2)
    const scan = wf?.childAgents.find((c) => c.toolUseId === 'tu_child1')
    const fix = wf?.childAgents.find((c) => c.toolUseId === 'tu_child2')
    expect(scan?.phase).toBe('Scan')
    expect(scan?.toolName).toBe('Agent')
    expect(scan?.status).toBe('running')
    expect(fix?.phase).toBe('Fix')
    expect(fix?.toolName).toBe('Task')
  })

  it('flips a child to done when its tool_result lands, and captures the result', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowToolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: childAgentStart })
    state = reduceSessionState(state, { type: 'MESSAGE', message: childResult })

    const wf = state.mirror.activeWorkflows.get('tu_workflow')
    const child1 = wf?.childAgents.find((c) => c.toolUseId === 'tu_child1')
    const child2 = wf?.childAgents.find((c) => c.toolUseId === 'tu_child2')
    expect(child1?.status).toBe('done')
    expect(child1?.result?.content).toBe('found 2 flaky')
    expect(child2?.status).toBe('running') // other child untouched
  })

  it('flips the Workflow itself to done when its own tool_result lands (main thread)', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowToolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowResult })

    const wf = state.mirror.activeWorkflows.get('tu_workflow')
    expect(wf?.status).toBe('done')
    expect(wf?.result?.content).toBe('workflow done')
  })

  it('keeps the completed Workflow record (with result + children) after the result frame', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowToolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: childAgentStart })
    state = reduceSessionState(state, { type: 'MESSAGE', message: childResult })
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowResult })

    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })

    // The record MUST survive so WorkflowCard renders the merged result and
    // the overlay stays reopenable — mirrors the subagent keep-on-complete rule.
    const wf = state.mirror.activeWorkflows.get('tu_workflow')
    expect(wf?.status).toBe('done')
    expect(wf?.result?.content).toBe('workflow done')
    expect(wf?.childAgents.length).toBe(2)
    expect(wf?.childAgents.find((c) => c.toolUseId === 'tu_child1')?.status).toBe('done')
  })

  it('flips a still-running Workflow + its running children to interrupted at the result frame', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowToolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: childAgentStart })
    // No tool_results arrive — both the Workflow and child2 are still running.
    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })

    const wf = state.mirror.activeWorkflows.get('tu_workflow')
    expect(wf?.status).toBe('interrupted')
    // child1 had no result either -> interrupted; child2 likewise.
    expect(wf?.childAgents.every((c) => c.status === 'interrupted')).toBe(true)
  })

  it('does NOT seed a generic toolStatus badge for the Workflow tool (it owns its card)', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowToolUse })
    // The Workflow tool_use id must be excluded from the generic toolStatus
    // map — same exclusion as Plan/Subagent/Question (they own their status).
    expect(state.mirror.toolStatus.has('tu_workflow')).toBe(false)
  })

  it('parses a remote WorkflowOutput from the tool_result and marks the record remote', () => {
    // A remote workflow returns sessionUrl immediately; work runs in a CCR
    // cloud session so no local sidechain children arrive. The card should
    // surface the sessionUrl + runId + scriptPath + remote flag.
    const remoteResult: SdkMessage = {
      type: 'user',
      uuid: 'u-wf-remote',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_workflow',
            content: JSON.stringify({
              status: 'remote_launched',
              taskType: 'remote_agent',
              workflowName: 'spec',
              runId: 'wf_abc',
              scriptPath: '/tmp/wf/spec.mjs',
              sessionUrl: 'https://claude.ai/s/xyz',
            }),
          },
        ],
      },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowToolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: remoteResult })

    const wf = state.mirror.activeWorkflows.get('tu_workflow')
    expect(wf?.status).toBe('done')
    expect(wf?.remote).toBe(true)
    expect(wf?.taskType).toBe('remote_agent')
    expect(wf?.sessionUrl).toBe('https://claude.ai/s/xyz')
    expect(wf?.runId).toBe('wf_abc')
    expect(wf?.scriptPath).toBe('/tmp/wf/spec.mjs')
  })

  it('rescues a still-generic label with WorkflowOutput.workflowName at completion', () => {
    // A Workflow invoked by `name` (no inline script) seeds label as 'Workflow'
    // because there's no script to parse. At completion the WorkflowOutput
    // carries workflowName — the record should adopt it.
    const namedWorkflowUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-wf-named',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_named', name: 'Workflow', input: { name: 'spec' } },
        ],
      },
    } as unknown as SdkMessage
    const namedResult: SdkMessage = {
      type: 'user',
      uuid: 'u-wf-named',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_named',
            content: JSON.stringify({
              status: 'async_launched',
              taskType: 'local_workflow',
              workflowName: 'spec',
              runId: 'wf_1',
            }),
          },
        ],
      },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: namedWorkflowUse })
    // input.name is used as the fallback, so label is 'spec' BEFORE the result
    // — but if the model emitted neither script meta nor input.name, the
    // rescue path is what matters. Here input.name already gives 'spec'.
    expect(state.mirror.activeWorkflows.get('tu_named')?.label).toBe('spec')

    state = reduceSessionState(state, { type: 'MESSAGE', message: namedResult })
    const wf = state.mirror.activeWorkflows.get('tu_named')
    expect(wf?.status).toBe('done')
    expect(wf?.remote).toBe(false)
    expect(wf?.taskType).toBe('local_workflow')
    expect(wf?.runId).toBe('wf_1')
    // label stays 'spec' (not overwritten, since it wasn't generic).
    expect(wf?.label).toBe('spec')
  })

  it('rescues a generic "Workflow" label to workflowName when no script/name was provided', () => {
    // No input.script, no input.name, no input.description → label is 'Workflow'.
    // The result's workflowName should rescue it.
    const bareUse: SdkMessage = {
      type: 'assistant',
      uuid: 'a-wf-bare',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_bare', name: 'Workflow', input: {} }],
      },
    } as unknown as SdkMessage
    const bareResult: SdkMessage = {
      type: 'user',
      uuid: 'u-wf-bare',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_bare',
            content: JSON.stringify({
              status: 'async_launched',
              taskType: 'local_workflow',
              workflowName: 'find-bugs',
            }),
          },
        ],
      },
    } as unknown as SdkMessage

    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: bareUse })
    expect(state.mirror.activeWorkflows.get('tu_bare')?.label).toBe('Workflow')

    state = reduceSessionState(state, { type: 'MESSAGE', message: bareResult })
    expect(state.mirror.activeWorkflows.get('tu_bare')?.label).toBe('find-bugs')
  })

  it('leaves the record intact when the tool_result is a plain summary (not WorkflowOutput JSON)', () => {
    // Many local workflows return a plain text summary, not a WorkflowOutput
    // payload. The remote/runId/scriptPath fields must stay undefined and the
    // record must still flip to done.
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowToolUse })
    state = reduceSessionState(state, { type: 'MESSAGE', message: workflowResult })

    const wf = state.mirror.activeWorkflows.get('tu_workflow')
    expect(wf?.status).toBe('done')
    // remote is `false` (not undefined): the merge expression coerces to a
    // boolean false when parsedOut is null and there was no prior remote flag.
    expect(wf?.remote).toBe(false)
    expect(wf?.sessionUrl).toBeUndefined()
    expect(wf?.runId).toBeUndefined()
    // label stays the parsed script name (not rescued — nothing to rescue).
    expect(wf?.label).toBe('find-flaky-tests')
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
    expect(renderedItems(state).length).toBe(1)
    expect(state.intent.pendingPlaceholders.has('optimistic:abc')).toBe(true)

    state = reduceSessionState(state, {
      type: 'ROLLBACK_OPTIMISTIC_USER_MESSAGE',
      pendingId: 'optimistic:abc',
    })
    expect(renderedItems(state).length).toBe(0)
    expect(isEmpty(state.intent.pendingPlaceholders)).toBe(true)
  })

  it('is a no-op when the broadcast already cleared pendingUserMessageIds', () => {
    // Race: server broadcast arrives between the failed POST and the
    // catch block dispatching rollback. Rollback must not delete the
    // real message.
    let state = createInitialSessionState('s1')
    state = applyOptimistic(state, 'hello', 'optimistic:abc')
    state = applyServerEcho(state, 'hello', 'real-xyz')
    expect(isEmpty(state.intent.pendingPlaceholders)).toBe(true)
    expect(state.mirror.items[0].id).toBe('real-xyz')

    const before = state
    state = reduceSessionState(state, {
      type: 'ROLLBACK_OPTIMISTIC_USER_MESSAGE',
      pendingId: 'optimistic:abc',
    })
    expect(state).toBe(before)
    expect(state.mirror.items[0].id).toBe('real-xyz')
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
    expect(state.mirror.questionAnswers.get('tu_q')).toEqual([])

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
    expect(state.mirror.questionAnswers.get('tu_q')).toEqual([{ question: 'OK?', answer: 'Yes' }])
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
    const entries = state.mirror.questionAnswers.get('tu_q')
    expect(entries).toEqual([{ question: 'OK?', answer: null }])
  })

  it('stores an explicit clarified sentinel from the resolution marker', () => {
    let state = createInitialSessionState('s1')
    state = seedQuestion(state, 'tu_q')
    state = seedPendingPermission(state, 'pid-1', 'tu_q')
    state = reduceSessionState(state, {
      type: 'PERMISSION_RESOLVED',
      id: 'pid-1',
      decision: {
        behavior: 'deny', persisted: false,
        message: 'The user asked for more context.',
        questionResolution: 'clarified',
      },
    })
    expect(state.mirror.questionAnswers.get('tu_q')).toEqual([
      { question: '', answer: null, clarified: true },
    ])
  })

  it('leaves questionAnswers unchanged when the message is not parseable JSON', () => {
    // Plain-deny path (non-question tools): decision.message is a free-form
    // human-readable string, not JSON. Must not corrupt question state.
    let state = createInitialSessionState('s1')
    state = seedQuestion(state, 'tu_q')
    state = seedPendingPermission(state, 'pid-1', 'tu_q')
    const before = state.mirror.questionAnswers

    state = reduceSessionState(state, {
      type: 'PERMISSION_RESOLVED',
      id: 'pid-1',
      decision: {
        behavior: 'deny',
        persisted: false,
        message: 'aborted',
      },
    })
    expect(state.mirror.questionAnswers).toBe(before)
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
    expect(state.mirror.questionAnswers.has('tu_bash')).toBe(false)
  })
})

describe('PREPEND_MESSAGES', () => {
  function userMsg(uuid: string, content: string): SdkMessage {
    return { type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null } as unknown as SdkMessage
  }
  function assistantMsg(uuid: string, text: string): SdkMessage {
    return {
      type: 'assistant',
      uuid,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    } as unknown as SdkMessage
  }

  it('unshifts older messages ahead of the current transcript in order', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg('live-1', 'newest') })
    state = reduceSessionState(state, {
      type: 'PREPEND_MESSAGES',
      messages: [userMsg('old-1', 'a'), assistantMsg('old-2', 'b')],
    })
    expect(state.mirror.items.map((i) => i.id)).toEqual(['old-1', 'old-2', 'live-1'])
    expect(state.mirror.messages.map((m) => m.uuid)).toEqual(['old-1', 'old-2', 'live-1'])
  })

  it('dedupes by uuid against messages already present', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: assistantMsg('shared', 'x') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg('live', 'y') })
    // The page overlaps on 'shared' (the cursor anchor) plus a genuinely older one.
    state = reduceSessionState(state, {
      type: 'PREPEND_MESSAGES',
      messages: [userMsg('older', 'z'), assistantMsg('shared', 'x')],
    })
    // 'shared' must not be duplicated; 'older' is inserted at the front.
    expect(state.mirror.items.map((i) => i.id)).toEqual(['older', 'shared', 'live'])
  })

  it('is a no-op for an empty batch', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg('live', 'y') })
    const before = state
    state = reduceSessionState(state, { type: 'PREPEND_MESSAGES', messages: [] })
    expect(state).toBe(before)
  })

  it('rebuilds tool status for prepended tool_use/tool_result pairs', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg('live', 'y') })
    const toolUse: SdkMessage = {
      type: 'assistant',
      uuid: 'old-asst',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] },
      parent_tool_use_id: null,
    } as unknown as SdkMessage
    const toolResult: SdkMessage = {
      type: 'user',
      uuid: 'old-result',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
      parent_tool_use_id: 'tool-1',
    } as unknown as SdkMessage
    state = reduceSessionState(state, { type: 'PREPEND_MESSAGES', messages: [toolUse, toolResult] })
    expect(state.mirror.toolStatus.get('tool-1')).toBe('success')
  })

  // The in-memory prompt carries a server-minted uuid; the on-disk copy of
  // the SAME prompt carries the SDK's uuid (the pump drops the SDK's echo).
  // uuid dedup can't bridge that, so the leading prompt(s) above the paging
  // anchor must be deduped by content instead — otherwise they render twice.
  it('dedupes a leading prompt across the server/SDK uuid boundary by content', () => {
    let state = createInitialSessionState('s')
    // On screen: prompt (server uuid) → assistant reply (SDK uuid, the anchor).
    state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg('server-uuid', 'hello') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: assistantMsg('asst-1', 'hi') })
    // Disk page read strictly before the anchor: re-returns the prompt with
    // its DIFFERENT (SDK) uuid, plus a genuinely-older message.
    state = reduceSessionState(state, {
      type: 'PREPEND_MESSAGES',
      messages: [assistantMsg('older-asst', 'earlier'), userMsg('sdk-uuid', 'hello')],
    })
    // 'hello' must appear exactly once (not duplicated under two uuids).
    const helloCount = state.mirror.items.filter(
      (i) => i.msg.type === 'user' && i.msg.message?.content === 'hello',
    ).length
    expect(helloCount).toBe(1)
    expect(state.mirror.items.map((i) => i.id)).toEqual(['older-asst', 'server-uuid', 'asst-1'])
  })

  it('dedupes multiple consecutive leading prompts at the boundary', () => {
    let state = createInitialSessionState('s')
    // Two queued prompts, then the assistant reply (anchor).
    state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg('srv-a', 'first') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg('srv-b', 'second') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: assistantMsg('asst', 'reply') })
    // Disk re-returns both prompts (SDK uuids) at the page tail.
    state = reduceSessionState(state, {
      type: 'PREPEND_MESSAGES',
      messages: [userMsg('disk-a', 'first'), userMsg('disk-b', 'second')],
    })
    // Both deduped — order and count unchanged.
    expect(state.mirror.items.map((i) => i.id)).toEqual(['srv-a', 'srv-b', 'asst'])
  })

  it('preserves a genuinely-older prompt with identical text further back', () => {
    let state = createInitialSessionState('s')
    // On screen: one prompt above the anchor.
    state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg('srv-dup', 'repeat') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: assistantMsg('asst', 'reply') })
    // Disk page: an OLDER 'repeat' prompt (different turn) followed by the
    // boundary 'repeat'. Only the boundary one (page tail) overlaps; the
    // older one must survive.
    state = reduceSessionState(state, {
      type: 'PREPEND_MESSAGES',
      messages: [userMsg('disk-old', 'repeat'), userMsg('disk-boundary', 'repeat')],
    })
    // disk-old is prepended; disk-boundary is deduped against srv-dup.
    expect(state.mirror.items.map((i) => i.id)).toEqual(['disk-old', 'srv-dup', 'asst'])
  })
})

describe('reducer: front-trim memory bound', () => {
  // Mirror the reducer's constants (kept module-private there).
  const CAP = 1000
  const SLACK = 256

  function userMsg(uuid: string, content: string): SdkMessage {
    return { type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null } as unknown as SdkMessage
  }
  function assistantMsg(uuid: string, text: string): SdkMessage {
    return {
      type: 'assistant',
      uuid,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    } as unknown as SdkMessage
  }
  function toolUseMsg(uuid: string, toolUseId: string): SdkMessage {
    return {
      type: 'assistant',
      uuid,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: {} }] },
      parent_tool_use_id: null,
    } as unknown as SdkMessage
  }
  function toolResultMsg(uuid: string, toolUseId: string): SdkMessage {
    return {
      type: 'user',
      uuid,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
      parent_tool_use_id: toolUseId,
    } as unknown as SdkMessage
  }

  /** Push n message-pairs (prompt + assistant reply) so the transcript is a
   *  realistic mix with disk-stable boundaries interleaved. Returns state. */
  function pushTurns(state: ReturnType<typeof createInitialSessionState>, n: number) {
    for (let i = 0; i < n; i++) {
      state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg(`u-${i}`, `q${i}`) })
      state = reduceSessionState(state, { type: 'MESSAGE', message: assistantMsg(`a-${i}`, `r${i}`) })
    }
    return state
  }

  it('does not trim below CAP + SLACK', () => {
    let state = createInitialSessionState('s')
    // 600 turns = 1200 items, under the 1256 threshold.
    state = pushTurns(state, 600)
    expect(state.mirror.items.length).toBe(1200)
  })

  it('trims down to ~CAP once CAP + SLACK is exceeded', () => {
    let state = createInitialSessionState('s')
    // 700 turns = 1400 items; the append that crosses 1256 triggers a trim.
    state = pushTurns(state, 700)
    expect(state.mirror.items.length).toBeGreaterThanOrEqual(CAP)
    expect(state.mirror.items.length).toBeLessThanOrEqual(CAP + SLACK)
    expect(state.mirror.items.length).toBe(state.mirror.messages.length)
  })

  it('lands the new items[0] on a disk-persisted boundary (empty leading prompt run)', () => {
    let state = createInitialSessionState('s')
    state = pushTurns(state, 700)
    // The boundary alignment guarantees items[0] is never a plain top-level
    // prompt — so countPromptOverlap sees a zero-length leading run and can
    // never resurface a trimmed prompt as a duplicate on the next loadOlder.
    expect(isTrimBoundary(state.mirror.items[0].msg)).toBe(true)
  })

  it('prunes toolUseId-keyed maps to ids still referenced by retained items', () => {
    let state = createInitialSessionState('s')
    // An early tool pair that WILL be trimmed away.
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUseMsg('tu-old', 'tool-old') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolResultMsg('tr-old', 'tool-old') })
    expect(state.mirror.toolStatus.get('tool-old')).toBe('success')
    // The result payload was captured for inline rendering too.
    expect(state.mirror.toolResults.has('tool-old')).toBe(true)
    // Bury it under enough turns to force a trim past the early pair.
    state = pushTurns(state, 700)
    // A recent tool pair that must SURVIVE.
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUseMsg('tu-new', 'tool-new') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolResultMsg('tr-new', 'tool-new') })

    // The old tool's status was orphaned by the trim and pruned.
    expect(state.mirror.toolStatus.has('tool-old')).toBe(false)
    // The live tool's status survives.
    expect(state.mirror.toolStatus.get('tool-new')).toBe('success')
    // toolResults is pruned/retained in lockstep with toolStatus — the
    // trimmed tool's payload must not leak; the live tool's must survive.
    expect(state.mirror.toolResults.has('tool-old')).toBe(false)
    expect(state.mirror.toolResults.has('tool-new')).toBe(true)
  })

  it('preserves lastMessageUuid (points at the newest message)', () => {
    let state = createInitialSessionState('s')
    state = pushTurns(state, 700)
    expect(state.mirror.lastMessageUuid).toBe('a-699')
  })

  it('does not disturb a pending optimistic placeholder at the tail', () => {
    let state = createInitialSessionState('s')
    state = pushTurns(state, 700)
    // Optimistic insert lands at the END of the render-merged view — front-trim
    // must never touch it. Placeholders live in intent.pendingPlaceholders
    // post-refactor; buildSnapshot appends them after mirror.items, so the
    // rendered tail is the placeholder.
    const optimistic: SdkMessage = {
      type: 'user',
      uuid: 'optimistic:tail',
      message: { role: 'user', content: 'pending' },
    } as unknown as SdkMessage
    state = reduceSessionState(state, { type: 'OPTIMISTIC_USER_MESSAGE', message: optimistic })
    expect(state.intent.pendingPlaceholders.has('optimistic:tail')).toBe(true)
    const rendered = renderedItems(state)
    expect(rendered[rendered.length - 1].id).toBe('optimistic:tail')
  })

  // --- Regression: items[0] must be a DISK-PERSISTED frame ----------------
  // The server only writes assistant/user (non-sidechain) and system frames
  // with subtype error|compact_boundary|api_retry. A non-persisted frame
  // (system 'init', or a sidechain frame) at items[0] would anchor loadOlder's
  // beforeUuid on a uuid the server can't find → silent fallback to the newest
  // page → reverse-paging stalls. isTrimBoundary excludes those; the old
  // isDiskStableMsg (system→true, parent!=null user→true) did not.
  function systemInitMsg(uuid: string): SdkMessage {
    // subtype 'init' is broadcast live but NOT persisted to disk.
    return { type: 'system', subtype: 'init', uuid, message: {} } as unknown as SdkMessage
  }

  it('snaps PAST a non-persisted system run to the next real boundary', () => {
    let state = createInitialSessionState('s')
    // 100 turns (200 items), then a 200-frame system:init block (indices
    // 200..399), then enough turns to drive several trims. The first trim's
    // raw cut (length-1000) lands inside the init block; the old predicate
    // would have left an 'init' frame at items[0]. isTrimBoundary must skip
    // forward to the assistant that follows.
    state = pushTurns(state, 100)
    for (let i = 0; i < 200; i++) {
      state = reduceSessionState(state, { type: 'MESSAGE', message: systemInitMsg(`init-${i}`) })
    }
    state = pushTurns(state, 500)

    const head = state.mirror.items[0].msg
    expect(isTrimBoundary(head)).toBe(true)
    // Specifically: never a non-persisted system frame.
    expect(head.type === 'system' && head.subtype === 'init').toBe(false)
    // And no init frame survives at the very front of the retained window.
    expect(state.mirror.items[0].msg.type).toBe('assistant')
  })

  it('skips the trim entirely when the cut zone has no safe boundary', () => {
    // Pathological: a long unbroken run of non-persisted frames covering the
    // whole trim zone. Cutting anywhere in it would strand reverse-paging, so
    // trimFront must skip rather than cut unsafely — memory stays above CAP
    // until a real boundary later re-enables trimming.
    let state = createInitialSessionState('s')
    state = pushTurns(state, 100) // 200 items, oldest
    // 1200 init frames — the entire region the cut could target is unsafe.
    for (let i = 0; i < 1200; i++) {
      state = reduceSessionState(state, { type: 'MESSAGE', message: systemInitMsg(`init-${i}`) })
    }
    // 1400 items total, > CAP+SLACK, yet no trim happened (no safe boundary
    // at/after the cut index — everything from there on is an init frame).
    expect(state.mirror.items.length).toBe(1400)
    // A single real boundary at the tail re-enables trimming on next append.
    state = reduceSessionState(state, { type: 'MESSAGE', message: assistantMsg('a-real', 'reply') })
    expect(state.mirror.items.length).toBeLessThanOrEqual(CAP + SLACK)
    expect(isTrimBoundary(state.mirror.items[0].msg)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Replay-on-top-of-cache reconciliation (resume seed + reconnect overlap).
//
// Regression context: when a dormant session is resumed, the server now seeds
// the live history ring from the on-disk transcript tail, so the first replay
// is NON-EMPTY and OVERLAPS whatever the client cached in localStorage. The
// reducer's incremental-replay branch used to blind-append, rendering every
// overlapping message twice. splitReplayAgainstCache() (and the branch that
// uses it) must drop the overlap while preserving older/newer portions.
// ---------------------------------------------------------------------------

function userMsg(uuid: string, text: string): SdkMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  } as unknown as SdkMessage
}

function imageMsg(uuid: string, data: string, media_type = 'image/png'): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', data, media_type } }],
    },
  } as unknown as SdkMessage
}

function asstMsg(uuid: string, text: string): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SdkMessage
}

function resultMsg(uuid: string): SdkMessage {
  return { type: 'result', subtype: 'success', uuid } as unknown as SdkMessage
}

function apiRetryMsg(uuid: string, attempt = 1, retryDelayMs = 1000): SdkMessage {
  return {
    type: 'system',
    subtype: 'api_retry',
    uuid,
    attempt,
    max_retries: 3,
    retry_delay_ms: retryDelayMs,
    error_status: 429,
    error: 'rate_limit_error',
  } as unknown as SdkMessage
}

function streamEventMsg(uuid: string, text = 'delta'): SdkMessage {
  return {
    type: 'stream_event',
    uuid,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as SdkMessage
}

function seedCache(messages: SdkMessage[]): ReturnType<typeof createInitialSessionState> {
  // Build a cache exactly as a full replay would, then return state.
  let state = createInitialSessionState('s')
  state = reduceSessionState(state, {
    type: 'REPLAY_REPLACE',
    messages,
    permissions: [],
  })
  return state
}

function replay(
  state: ReturnType<typeof createInitialSessionState>,
  messages: SdkMessage[],
): ReturnType<typeof createInitialSessionState> {
  return reduceSessionState(state, { type: 'REPLAY_REPLACE', messages, permissions: [] })
}

const ids = (state: ReturnType<typeof createInitialSessionState>) => state.mirror.items.map((i) => i.id)

describe('splitReplayAgainstCache (pure)', () => {
  it('treats a non-overlapping payload as entirely newer (clean reconnect)', () => {
    const cache = seedCache([userMsg('u1', 'hi'), asstMsg('a1', 'hello')])
    const incoming = [asstMsg('a2', 'more'), resultMsg('r2')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(newer).toEqual(incoming)
  })

  it('drops the overlapping span and keeps only the newer tail', () => {
    const cache = seedCache([asstMsg('a1', 'one'), asstMsg('a2', 'two')])
    // Disk seed overlaps a1+a2 then adds a3.
    const incoming = [asstMsg('a1', 'one'), asstMsg('a2', 'two'), asstMsg('a3', 'three')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(newer.map((m) => m.uuid)).toEqual(['a3'])
  })

  it('splits older (below cache) and overlap correctly', () => {
    const cache = seedCache([asstMsg('a2', 'two'), asstMsg('a3', 'three')])
    // Payload reaches further back (a1) and overlaps a2,a3.
    const incoming = [asstMsg('a1', 'one'), asstMsg('a2', 'two'), asstMsg('a3', 'three')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older.map((m) => m.uuid)).toEqual(['a1'])
    expect(newer).toEqual([])
  })

  it('keeps a mid-payload frame absent from the cache (contiguous-bracket, not membership)', () => {
    // Cache trimmed out a2; payload is a1,a2,a3 and cache has a1,a3.
    // a2 sits between the first (a1) and last (a3) overlap, so it is dropped
    // as part of the overlap span — correct, because the cache already shows
    // the surrounding context and re-inserting a2 mid-stream is not supported
    // by an append/prepend split. (Documents the bracket semantics.)
    const cache = seedCache([asstMsg('a1', 'one'), asstMsg('a3', 'three')])
    const incoming = [asstMsg('a1', 'one'), asstMsg('a2', 'two'), asstMsg('a3', 'three')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(newer).toEqual([])
  })
})

describe('reducer: REPLAY_REPLACE on top of a cache', () => {
  it('empty replay keeps the cache (no blank screen)', () => {
    const cache = seedCache([userMsg('u1', 'hi'), asstMsg('a1', 'hello')])
    const after = replay(cache, [])
    expect(ids(after)).toEqual(['u1', 'a1'])
    expect(after.mirror.replayReady).toBe(true)
  })

  it('does NOT double-append when the seed overlaps the cache (the regression)', () => {
    const cache = seedCache([userMsg('u1', 'hi'), asstMsg('a1', 'hello'), resultMsg('r1')])
    // Resume seed from disk: same transcript, but result frames are not on
    // disk, so the seed is u1 + a1 (overlap) — and the cache's lastMessageUuid
    // was r1, which is NOT in the seed → server fell back to FULL replay.
    const seed = [userMsg('u1-disk', 'hi'), asstMsg('a1', 'hello')]
    const after = replay(cache, seed)
    // u1 (prompt) dedups by content signature, a1 by uuid → no growth.
    expect(after.mirror.items.length).toBe(3)
    expect(ids(after)).toEqual(['u1', 'a1', 'r1'])
  })

  it('appends genuinely newer messages from the replay tail', () => {
    const cache = seedCache([userMsg('u1', 'hi'), asstMsg('a1', 'hello')])
    const seed = [asstMsg('a1', 'hello'), userMsg('u2-disk', 'again'), asstMsg('a2', 'sure')]
    const after = replay(cache, seed)
    expect(ids(after)).toEqual(['u1', 'a1', 'u2-disk', 'a2'])
  })

  it('prepends older messages when the cache was trimmed below the seed', () => {
    const cache = seedCache([asstMsg('a2', 'two'), asstMsg('a3', 'three')])
    const seed = [asstMsg('a1', 'one'), asstMsg('a2', 'two'), asstMsg('a3', 'three')]
    const after = replay(cache, seed)
    expect(ids(after)).toEqual(['a1', 'a2', 'a3'])
  })

  it('does NOT drop a legitimate repeated prompt in the strictly-newer slice', () => {
    // Clean reconnect: cache ends after a turn whose prompt was "ok". The
    // server slices strictly-after and the NEXT turn happens to also start
    // with "ok". Keying overlap on prompt CONTENT (instead of disk-stable
    // uuid) would treat the second "ok" as an overlap and silently eat the
    // whole new turn. Anchoring only on uuid keeps it.
    const cache = seedCache([userMsg('u1', 'ok'), asstMsg('a1', 'done')])
    const slice = [userMsg('u2', 'ok'), asstMsg('a2', 'done again')]
    const after = replay(cache, slice)
    expect(after.mirror.items.length).toBe(4)
    expect(ids(after)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('handles older + overlap + newer in one payload (the common 200-cache / 500-seed case)', () => {
    // localStorage trims to 200 messages but the disk seed takes historyCap
    // (500), so a long session's full replay reaches BOTH further back than
    // the cache AND forward of it. Exercises prepend-then-append in one pass.
    const cache = seedCache([asstMsg('a2', 'two'), asstMsg('a3', 'three')])
    const seed = [
      asstMsg('a1', 'one'), // older
      asstMsg('a2', 'two'), asstMsg('a3', 'three'), // overlap (dropped)
      asstMsg('a4', 'four'), asstMsg('a5', 'five'), // newer
    ]
    const after = replay(cache, seed)
    expect(ids(after)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5'])
  })
})

// ---------------------------------------------------------------------------
// Prompt-only transcripts (no assistant/system/result frame at all — a turn
// that never produced any output, e.g. the model didn't respond before the
// server restarted). With no disk-stable anchor, splitReplayAgainstCache's
// uuid-anchor path finds no overlap, so a restart re-seed replay used to be
// treated as strictly-newer and appended — duplicating the user bubble on
// every reconnect (the "I see three copies of my message" bug).
// ---------------------------------------------------------------------------

describe('splitReplayAgainstCache: no-anchor prompt-only fallback', () => {
  it('drops a re-send of an already-cached prompt (different uuid, same text)', () => {
    // Cache holds the server-minted-uuid copy; the disk seed carries the SDK
    // uuid. Same logical message, no anchor to bridge them.
    const cache = seedCache([userMsg('srv-minted', 'hi')])
    const incoming = [userMsg('disk-sdk-uuid', 'hi')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(newer).toEqual([])
  })

  it('drops a full multi-prompt overlap (same sequence, different uuids)', () => {
    const cache = seedCache([userMsg('s1', 'one'), userMsg('s2', 'two')])
    const incoming = [userMsg('d1', 'one'), userMsg('d2', 'two')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(newer).toEqual([])
  })

  it('does NOT drop a different-text prompt (append it — could be a new turn)', () => {
    const cache = seedCache([userMsg('s1', 'hi')])
    const incoming = [userMsg('d1', 'totally different')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(newer).toEqual(incoming)
  })

  it('does NOT fire when a disk-stable anchor exists (leave it to the anchor path)', () => {
    // An assistant frame is present → the fallback must not signature-match
    // the prompt and swallow a legitimate new same-text turn.
    const cache = seedCache([userMsg('s1', 'ok'), asstMsg('a1', 'done')])
    const incoming = [userMsg('d2', 'ok'), asstMsg('a2', 'again')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    // a2 is not in the cache → no anchor overlap → whole payload is newer.
    expect(older).toEqual([])
    expect(newer).toEqual(incoming)
  })

  it('drops a re-send of an image-only prompt only when the image matches', () => {
    // Regression: plain-text signatures collapse every image-only prompt onto
    // '' and would drop a genuinely different image. The richer fingerprint
    // distinguishes different images, so a different image is appended (not
    // lost), while the same image is still deduped.
    const sameA = imageMsg('d-same', 'AAAA')
    const diffB = imageMsg('d-diff', 'BBBB')
    expect(splitReplayAgainstCache([sameA], seedCache([imageMsg('s', 'AAAA')]).mirror.items).newer).toEqual([])
    expect(splitReplayAgainstCache([diffB], seedCache([imageMsg('s', 'AAAA')]).mirror.items).newer).toEqual([diffB])
  })

  it('does NOT drop a same-text prompt with a different image attachment', () => {
    // text + image-A vs text + image-B: identical text, different image. The
    // fingerprint differs on the image digest, so the new message is appended.
    function textImage(uuid: string, text: string, data: string): SdkMessage {
      return {
        type: 'user',
        uuid,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image', source: { type: 'base64', data, media_type: 'image/png' } },
          ],
        },
      } as unknown as SdkMessage
    }
    const cache = seedCache([textImage('s1', 'look', 'AAAA')])
    const incoming = [textImage('d1', 'look', 'BBBB')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(newer).toEqual(incoming)
  })
})

describe('reducer: prompt-only replay does not stack duplicates', () => {
  it('original prompt + two restart replays stays at one bubble (the 3-copies bug)', () => {
    // 1) The original send broadcasts the prompt under a server-minted uuid.
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg('srv-minted', 'hi') })
    expect(ids(state)).toEqual(['srv-minted'])
    // 2) Server restart re-seeds the ring from disk (SDK uuid) and the client
    //    reconnects — twice (server auto-recover + client resume, the
    //    double-spawn seen in production logs). Each reconnect replays the
    //    same prompt under the disk uuid.
    state = replay(state, [userMsg('disk-sdk-uuid', 'hi')])
    state = replay(state, [userMsg('disk-sdk-uuid', 'hi')])
    expect(ids(state)).toEqual(['srv-minted'])
    expect(state.mirror.items.filter((it) => it.msg.type === 'user')).toHaveLength(1)
  })

  it('a full-overlap drop still advances lastMessageUuid to the replay uuid (no reconnect loop)', () => {
    // Regression: dropping the payload used to leave lastMessageUuid at the
    // stale server-minted uuid, so the next reconnect's sinceUuid missed the
    // post-restart ring and the server re-sent the same full replay forever.
    // The drop must advance the cursor to the replay's (disk) uuid.
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: userMsg('srv-minted', 'hi') })
    expect(state.mirror.lastMessageUuid).toBe('srv-minted')
    state = replay(state, [userMsg('disk-sdk-uuid', 'hi')])
    // Still one bubble (no dup) ...
    expect(ids(state)).toEqual(['srv-minted'])
    // ... but the cursor now points at the uuid the server's ring recognizes.
    expect(state.mirror.lastMessageUuid).toBe('disk-sdk-uuid')
  })
})

// ---------------------------------------------------------------------------
// uuid-bridged prompt overlap (#3): when the resume-seed rewrite makes the
// replay's prompt uuid match the cache's (server-minted) uuid, the anchor path
// detects the prompt overlap the same way it detects assistant overlap — no
// dup, and the missed assistant reply is appended. Un-bridged (mismatched
// uuid) sessions still rely on the signature fallback below.
// ---------------------------------------------------------------------------

describe('splitReplayAgainstCache: uuid-bridged prompt overlap (#3)', () => {
  it('drops a re-sent prompt and appends the missed assistant (matching uuid)', () => {
    // The #3 shape: cache holds the prompt (no assistant reply landed before a
    // restart); the resume-seed replay carries the SAME prompt uuid (bridged)
    // plus the assistant the client missed. The prompt overlaps → dropped; the
    // assistant is newer → appended. No duplicate prompt.
    const cache = seedCache([userMsg('U-shared', 'hi')])
    const incoming = [userMsg('U-shared', 'hi'), asstMsg('a1', 'reply')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(newer.map((m) => m.uuid)).toEqual(['a1'])
  })

  it('two same-text turns with different uuids are NOT collapsed (uuid disambiguates)', () => {
    // cache ends in an "ok" prompt; the replay's "ok" is a GENUINE new turn
    // (different uuid). Uuid matching (unlike signatures) keeps it.
    const cache = seedCache([userMsg('u1', 'ok')])
    const incoming = [userMsg('u2', 'ok'), asstMsg('a2', 'again')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    // u2 is a new turn (uuid not in cache) → no overlap → appended alongside a2.
    expect(newer.map((m) => m.uuid)).toEqual(['u2', 'a2'])
  })

  it('un-bridged (mismatched uuid) prompt-only still falls to the signature fallback', () => {
    // Old / desynced session: ring re-seeded from disk carries the SDK uuid
    // (V), cache holds the server-minted uuid (U). Uuid path can't match →
    // no disk-stable anchor on either side → signature fallback drops the dup.
    const cache = seedCache([userMsg('U-server', 'hi')])
    const incoming = [userMsg('V-disk', 'hi')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(newer).toEqual([])
  })
})

describe('reducer: CLEAR_TRANSCRIPT', () => {
  it('wipes both layers and marks the transcript ready (replayReady=true)', () => {
    // /clear resets the session to a fresh, live, empty state. Unlike RESET
    // (which leaves replayReady=false for the incoming replay), there is no
    // pending replay after a clear — the empty-state should show, not the
    // skeleton.
    let state = seedCache([userMsg('u1', 'hi'), asstMsg('a1', 'hello')])
    state = applyOptimistic(state, 'pending turn', 'optimistic:p1')
    expect(renderedItems(state).length).toBeGreaterThan(0)
    expect(state.mirror.permissionPending.size).toBe(0)
    expect(state.mirror.replayReady).toBe(true)

    const after = reduceSessionState(state, { type: 'CLEAR_TRANSCRIPT' })

    expect(after.mirror.items).toEqual([])
    expect(after.mirror.messages).toEqual([])
    expect(after.mirror.replayReady).toBe(true)
    expect(after.intent.pendingPlaceholders.size).toBe(0)
    expect(isEmpty(after.mirror.toolStatus)).toBe(true)
    expect(isEmpty(after.mirror.activeSubagents)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// api_retry is a TRANSIENT frame routed to `mirror.apiRetry`, NOT items /
// messages / IDB — keeping the transcript append-only (no in-place replace,
// no supersession tracking).
// ---------------------------------------------------------------------------

describe('reducer: api_retry transient slot', () => {
  it('routes api_retry to the slot, not items/messages, and does not advance lastMessageUuid', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: asstMsg('a1', 'hi') })
    expect(state.mirror.lastMessageUuid).toBe('a1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: apiRetryMsg('r1') })
    // Slot holds the frame; items/messages untouched; cursor stays at a1.
    expect(state.mirror.apiRetry?.uuid).toBe('r1')
    expect(ids(state)).toEqual(['a1'])
    expect(state.mirror.messages.map((m) => m.uuid)).toEqual(['a1'])
    expect(state.mirror.lastMessageUuid).toBe('a1')
  })

  it('overwrites the slot on consecutive api_retry (latest wins, no in-place replace)', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: apiRetryMsg('r1', 1, 1000) })
    state = reduceSessionState(state, { type: 'MESSAGE', message: apiRetryMsg('r2', 2, 2000) })
    expect(state.mirror.apiRetry?.uuid).toBe('r2')
    expect((state.mirror.apiRetry as { attempt?: number }).attempt).toBe(2)
    expect(ids(state)).toEqual([]) // neither retry entered items
  })

  it('clears the slot when a non-retry message lands (retry cycle ended)', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: apiRetryMsg('r1') })
    expect(state.mirror.apiRetry).not.toBeNull()
    state = reduceSessionState(state, { type: 'MESSAGE', message: asstMsg('a1', 'done') })
    expect(state.mirror.apiRetry).toBeNull()
    expect(ids(state)).toEqual(['a1']) // the assistant appended; no stale retry in items
  })

  it('replay: api_retry mid-payload sets then clears the slot; trailing api_retry keeps it', () => {
    // [api_retry, assistant] → slot set then cleared; items has only assistant.
    let state = replay(createInitialSessionState('s'), [apiRetryMsg('r1'), asstMsg('a1', 'ok')])
    expect(state.mirror.apiRetry).toBeNull()
    expect(ids(state)).toEqual(['a1'])
    // Replay ending in api_retry (turn in-progress) → slot stays set.
    state = replay(createInitialSessionState('s2'), [asstMsg('a2', 'x'), apiRetryMsg('r2')])
    expect(state.mirror.apiRetry?.uuid).toBe('r2')
    expect(ids(state)).toEqual(['a2'])
  })

  it('loadOlder (PREPEND) drops historical api_retry (never an item, never sets the slot)', () => {
    let state = seedCache([asstMsg('a1', 'anchor')])
    state = reduceSessionState(state, {
      type: 'PREPEND_MESSAGES',
      messages: [apiRetryMsg('old-r'), asstMsg('old-a', 'older')],
    })
    expect(ids(state)).toEqual(['old-a', 'a1']) // old-r dropped, no slot set
    expect(state.mirror.apiRetry).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// stream_event deltas must NOT advance lastMessageUuid — the uuid-anchored WS
// incremental replay (`sinceUuid`) relies on the cursor pointing at a durable
// message the server ring still holds. A stream_event uuid is ephemeral (never
// on the disk transcript, never in the ring), so a sinceUuid pointing at one
// misses the ring and forces a full replay on every reconnect.
// ---------------------------------------------------------------------------

describe('reducer: stream_event does not advance lastMessageUuid', () => {
  it('keeps the cursor on the last durable message when stream_event deltas land', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: asstMsg('a1', 'hi') })
    expect(state.mirror.lastMessageUuid).toBe('a1')

    state = reduceSessionState(state, { type: 'MESSAGE', message: streamEventMsg('se1', 'par') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: streamEventMsg('se2', 'tial') })

    // Cursor stays at the durable anchor; no transcript item was created.
    expect(state.mirror.lastMessageUuid).toBe('a1')
    expect(ids(state)).toEqual(['a1'])
    expect(state.mirror.messages.map((m) => m.uuid)).toEqual(['a1'])
  })

  it('advances again once a durable message lands after the deltas', () => {
    let state = createInitialSessionState('s')
    state = reduceSessionState(state, { type: 'MESSAGE', message: asstMsg('a1', 'hi') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: streamEventMsg('se1') })
    expect(state.mirror.lastMessageUuid).toBe('a1')

    state = reduceSessionState(state, { type: 'MESSAGE', message: asstMsg('a2', 'done') })
    expect(state.mirror.lastMessageUuid).toBe('a2')
    expect(ids(state)).toEqual(['a1', 'a2'])
  })
})

describe('reducer: a task_notification for ONE async agent leaves the OTHER background agent untouched', () => {
  const agentToolUse = (id: string, uuid: string): SdkMessage => ({
    type: 'assistant',
    uuid,
    receivedAt: 0,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'do work' } }] },
  }) as unknown as SdkMessage
  const agentAck = (toolUseId: string, uuid: string): SdkMessage => ({
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    receivedAt: 1_000,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Async agent launched successfully' }] },
  }) as unknown as SdkMessage
  const result = (uuid: string): SdkMessage => ({ type: 'result', subtype: 'success', uuid, receivedAt: 2_000 }) as unknown as SdkMessage
  const notif = (toolUseId: string, uuid: string): SdkMessage => ({
    type: 'system',
    subtype: 'task_notification',
    uuid,
    task_id: 't-1',
    tool_use_id: toolUseId,
    status: 'completed',
    summary: 'done',
    output_file: '',
    receivedAt: 3_000,
  }) as unknown as SdkMessage

  it('keeps the second agent pending after the first completes', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_a', 'a1') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentAck('tu_a', 'u1') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse('tu_b', 'a2') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentAck('tu_b', 'u2') })
    expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('background')
    expect(state.mirror.activeSubagents.get('tu_b')?.status).toBe('background')

    // Parent turn ends → both sweep to pending.
    state = reduceSessionState(state, { type: 'MESSAGE', message: result('r1') })
    expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('pending')
    expect(state.mirror.activeSubagents.get('tu_b')?.status).toBe('pending')

    // Agent A completes → its record flips to done; B must STAY pending.
    state = reduceSessionState(state, { type: 'MESSAGE', message: notif('tu_a', 'n1') })
    expect(state.mirror.activeSubagents.get('tu_a')?.status).toBe('done')
    expect(state.mirror.activeSubagents.get('tu_b')?.status).toBe('pending')

    // WorkingBubble waiting = any pending/background subagent still present.
    const stillRunning = Array.from(state.mirror.activeSubagents.values())
      .filter((s) => s.status === 'pending' || s.status === 'background')
    expect(stillRunning.map((s) => s.toolUseId)).toContain('tu_b')
  })
})
