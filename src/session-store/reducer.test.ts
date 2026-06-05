import { describe, it, expect } from 'vitest'
import { reduceSessionState, splitReplayAgainstCache } from './reducer'
import { createInitialSessionState } from './types'
import { isTrimBoundary } from './normalize'
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
    const mid = state.activeSubagents.get('tu_agent')
    expect(mid?.status).toBe('done')
    expect(mid?.result?.content).toBe('worker output')

    // Turn ends. The record (and its result) MUST survive — otherwise
    // SubagentCard falls back to a bare placeholder and the orphan
    // tool_result bubble reappears below it (the bug this guards).
    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })
    const after = state.activeSubagents.get('tu_agent')
    expect(after?.status).toBe('done')
    expect(after?.result?.content).toBe('worker output')
  })

  it('flips a still-running subagent to interrupted at the result frame (no orphan)', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, { type: 'MESSAGE', message: agentToolUse })
    expect(state.activeSubagents.get('tu_agent')?.status).toBe('running')

    // Result frame arrives before the subagent's tool_result matched.
    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })
    const after = state.activeSubagents.get('tu_agent')
    expect(after).toBeDefined()
    expect(after?.status).toBe('interrupted')
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
    expect(state.items.map((i) => i.id)).toEqual(['old-1', 'old-2', 'live-1'])
    expect(state.messages.map((m) => m.uuid)).toEqual(['old-1', 'old-2', 'live-1'])
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
    expect(state.items.map((i) => i.id)).toEqual(['older', 'shared', 'live'])
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
    expect(state.toolStatus.get('tool-1')).toBe('success')
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
    const helloCount = state.items.filter(
      (i) => i.msg.type === 'user' && i.msg.message?.content === 'hello',
    ).length
    expect(helloCount).toBe(1)
    expect(state.items.map((i) => i.id)).toEqual(['older-asst', 'server-uuid', 'asst-1'])
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
    expect(state.items.map((i) => i.id)).toEqual(['srv-a', 'srv-b', 'asst'])
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
    expect(state.items.map((i) => i.id)).toEqual(['disk-old', 'srv-dup', 'asst'])
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
    expect(state.items.length).toBe(1200)
  })

  it('trims down to ~CAP once CAP + SLACK is exceeded', () => {
    let state = createInitialSessionState('s')
    // 700 turns = 1400 items; the append that crosses 1256 triggers a trim.
    state = pushTurns(state, 700)
    expect(state.items.length).toBeGreaterThanOrEqual(CAP)
    expect(state.items.length).toBeLessThanOrEqual(CAP + SLACK)
    expect(state.items.length).toBe(state.messages.length)
  })

  it('lands the new items[0] on a disk-persisted boundary (empty leading prompt run)', () => {
    let state = createInitialSessionState('s')
    state = pushTurns(state, 700)
    // The boundary alignment guarantees items[0] is never a plain top-level
    // prompt — so countPromptOverlap sees a zero-length leading run and can
    // never resurface a trimmed prompt as a duplicate on the next loadOlder.
    expect(isTrimBoundary(state.items[0].msg)).toBe(true)
  })

  it('prunes toolUseId-keyed maps to ids still referenced by retained items', () => {
    let state = createInitialSessionState('s')
    // An early tool pair that WILL be trimmed away.
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUseMsg('tu-old', 'tool-old') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolResultMsg('tr-old', 'tool-old') })
    expect(state.toolStatus.get('tool-old')).toBe('success')
    // The result payload was captured for inline rendering too.
    expect(state.toolResults.has('tool-old')).toBe(true)
    // Bury it under enough turns to force a trim past the early pair.
    state = pushTurns(state, 700)
    // A recent tool pair that must SURVIVE.
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolUseMsg('tu-new', 'tool-new') })
    state = reduceSessionState(state, { type: 'MESSAGE', message: toolResultMsg('tr-new', 'tool-new') })

    // The old tool's status was orphaned by the trim and pruned.
    expect(state.toolStatus.has('tool-old')).toBe(false)
    // The live tool's status survives.
    expect(state.toolStatus.get('tool-new')).toBe('success')
    // toolResults is pruned/retained in lockstep with toolStatus — the
    // trimmed tool's payload must not leak; the live tool's must survive.
    expect(state.toolResults.has('tool-old')).toBe(false)
    expect(state.toolResults.has('tool-new')).toBe(true)
  })

  it('preserves lastMessageUuid (points at the newest message)', () => {
    let state = createInitialSessionState('s')
    state = pushTurns(state, 700)
    expect(state.lastMessageUuid).toBe('a-699')
  })

  it('does not disturb a pending optimistic placeholder at the tail', () => {
    let state = createInitialSessionState('s')
    state = pushTurns(state, 700)
    // Optimistic insert lands at the END — front-trim must never touch it.
    const optimistic: SdkMessage = {
      type: 'user',
      uuid: 'optimistic:tail',
      message: { role: 'user', content: 'pending' },
    } as unknown as SdkMessage
    state = reduceSessionState(state, { type: 'OPTIMISTIC_USER_MESSAGE', message: optimistic })
    expect(state.pendingUserMessageIds.has('optimistic:tail')).toBe(true)
    expect(state.items[state.items.length - 1].id).toBe('optimistic:tail')
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

    const head = state.items[0].msg
    expect(isTrimBoundary(head)).toBe(true)
    // Specifically: never a non-persisted system frame.
    expect(head.type === 'system' && head.subtype === 'init').toBe(false)
    // And no init frame survives at the very front of the retained window.
    expect(state.items[0].msg.type).toBe('assistant')
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
    expect(state.items.length).toBe(1400)
    // A single real boundary at the tail re-enables trimming on next append.
    state = reduceSessionState(state, { type: 'MESSAGE', message: assistantMsg('a-real', 'reply') })
    expect(state.items.length).toBeLessThanOrEqual(CAP + SLACK)
    expect(isTrimBoundary(state.items[0].msg)).toBe(true)
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

const ids = (state: ReturnType<typeof createInitialSessionState>) => state.items.map((i) => i.id)

describe('splitReplayAgainstCache (pure)', () => {
  it('treats a non-overlapping payload as entirely newer (clean reconnect)', () => {
    const cache = seedCache([userMsg('u1', 'hi'), asstMsg('a1', 'hello')])
    const incoming = [asstMsg('a2', 'more'), resultMsg('r2')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.items)
    expect(older).toEqual([])
    expect(newer).toEqual(incoming)
  })

  it('drops the overlapping span and keeps only the newer tail', () => {
    const cache = seedCache([asstMsg('a1', 'one'), asstMsg('a2', 'two')])
    // Disk seed overlaps a1+a2 then adds a3.
    const incoming = [asstMsg('a1', 'one'), asstMsg('a2', 'two'), asstMsg('a3', 'three')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.items)
    expect(older).toEqual([])
    expect(newer.map((m) => m.uuid)).toEqual(['a3'])
  })

  it('splits older (below cache) and overlap correctly', () => {
    const cache = seedCache([asstMsg('a2', 'two'), asstMsg('a3', 'three')])
    // Payload reaches further back (a1) and overlaps a2,a3.
    const incoming = [asstMsg('a1', 'one'), asstMsg('a2', 'two'), asstMsg('a3', 'three')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.items)
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
    const { older, newer } = splitReplayAgainstCache(incoming, cache.items)
    expect(older).toEqual([])
    expect(newer).toEqual([])
  })
})

describe('reducer: REPLAY_REPLACE on top of a cache', () => {
  it('empty replay keeps the cache (no blank screen)', () => {
    const cache = seedCache([userMsg('u1', 'hi'), asstMsg('a1', 'hello')])
    const after = replay(cache, [])
    expect(ids(after)).toEqual(['u1', 'a1'])
    expect(after.replayReady).toBe(true)
  })

  it('does NOT double-append when the seed overlaps the cache (the regression)', () => {
    const cache = seedCache([userMsg('u1', 'hi'), asstMsg('a1', 'hello'), resultMsg('r1')])
    // Resume seed from disk: same transcript, but result frames are not on
    // disk, so the seed is u1 + a1 (overlap) — and the cache's lastMessageUuid
    // was r1, which is NOT in the seed → server fell back to FULL replay.
    const seed = [userMsg('u1-disk', 'hi'), asstMsg('a1', 'hello')]
    const after = replay(cache, seed)
    // u1 (prompt) dedups by content signature, a1 by uuid → no growth.
    expect(after.items.length).toBe(3)
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
    expect(after.items.length).toBe(4)
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
