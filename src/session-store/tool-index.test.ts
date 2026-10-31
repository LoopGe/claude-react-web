// Tool index — the generic tool / plan / question / permission folds extracted
// from the reducer's `updateIndexesMirror` and `PERMISSION_*` cases.
//
// The tests below cover the behaviors the brief names:
//   - generic tool running/success/error and payload capture
//   - plan approval/rejection/content
//   - question pending/answered/clarified
//   - pid cleanup (PERMISSION_REQUEST seeds the map; PERMISSION_RESOLVED prunes)
//   - no-map permission resolution is an identity-stable no-op
//   - sidechain-owned tool IDs (Agent / Task / Explore / ExitPlanMode /
//     AskUserQuestion) remain EXCLUDED from the generic toolStatus map so
//     their bespoke cards own the lifecycle.
//
// `pendingResults` is intentionally NOT exercised here — it stays with the
// reducer's `updateIndexesMirror` coordinator until Task 5.

import { describe, it, expect } from 'vitest'
import {
  updateToolIndexMirror,
  applyPermissionRequest,
  applyPermissionResolved,
} from './tool-index'
import {
  createInitialServerMirror,
  createInitialSessionState,
  type ServerMirror,
  type SessionState,
} from './types'
import type { PermissionRequest, SdkMessage } from '../types'

// ── Message builders ────────────────────────────────────────────────────────
// Mirror the shapes reducer.test.ts / sidechain-index.test.ts use. Each
// builder stamps `receivedAt` so the fold's wall-clock stamp path is
// exercised where it matters.

function assistant(
  blocks: unknown[],
  uuid = 'a-1',
  parentToolUseId: string | null = null,
  receivedAt = 1_000,
): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentToolUseId,
    receivedAt,
    message: { role: 'assistant', content: blocks },
  } as unknown as SdkMessage
}

function user(
  blocks: unknown[],
  uuid = 'u-1',
  parentToolUseId: string | null = null,
  receivedAt = 2_000,
): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: parentToolUseId,
    receivedAt,
    message: { role: 'user', content: blocks },
  } as unknown as SdkMessage
}

function toolUse(name: string, id: string, input: Record<string, unknown> = {}): unknown {
  return { type: 'tool_use', id, name, input }
}

function toolResult(toolUseId: string, opts: { isError?: boolean; content?: unknown } = {}): unknown {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: opts.content ?? 'ok',
    ...(opts.isError ? { is_error: true } : {}),
  }
}

const fresh = (): ServerMirror => createInitialServerMirror()
const freshState = (): SessionState => createInitialSessionState('s1')

// ---------------------------------------------------------------------------
// updateToolIndexMirror: generic tool status + payload capture
// ---------------------------------------------------------------------------

describe('updateToolIndexMirror: generic tool running/success/error + payload', () => {
  it('seeds running for generic tool_use blocks (Bash/Read)', () => {
    const m = updateToolIndexMirror(
      fresh(),
      assistant([toolUse('Bash', 'tu_bash'), toolUse('Read', 'tu_read')]),
    )
    expect(m.toolStatus.get('tu_bash')).toBe('running')
    expect(m.toolStatus.get('tu_read')).toBe('running')
  })

  it('flips to success when the matching tool_result lands', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, assistant([toolUse('Bash', 'tu_bash')]))
    m = updateToolIndexMirror(m, user([toolResult('tu_bash')], 'u-1'))
    expect(m.toolStatus.get('tu_bash')).toBe('success')
  })

  it('flips to error when the result carries is_error: true', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, assistant([toolUse('Read', 'tu_read')]))
    m = updateToolIndexMirror(
      m,
      user([toolResult('tu_read', { isError: true, content: 'ENOENT' })], 'u-1'),
    )
    expect(m.toolStatus.get('tu_read')).toBe('error')
  })

  it('captures the result payload for a seeded generic tool in toolResults', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, assistant([toolUse('Bash', 'tu_bash')]))
    expect(m.toolResults.has('tu_bash')).toBe(false)
    m = updateToolIndexMirror(
      m,
      user([toolResult('tu_bash', { content: 'stdout here' })], 'u-1'),
    )
    expect(m.toolResults.get('tu_bash')).toEqual({ content: 'stdout here', isError: false })
  })

  it('tags isError on the captured payload when the result fails', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, assistant([toolUse('Read', 'tu_read')]))
    m = updateToolIndexMirror(
      m,
      user([toolResult('tu_read', { isError: true, content: 'ENOENT' })], 'u-1'),
    )
    expect(m.toolResults.get('tu_read')).toEqual({ content: 'ENOENT', isError: true })
  })

  it('does NOT capture toolResults for an unseeded (orphan) tool_use_id', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, assistant([toolUse('Bash', 'tu_bash')]))
    m = updateToolIndexMirror(
      m,
      user([toolResult('tu_unknown', { content: 'orphan' })], 'u-x'),
    )
    expect(m.toolResults.has('tu_unknown')).toBe(false)
    expect(m.toolStatus.has('tu_unknown')).toBe(false)
  })

  it('does not regress a terminal status when a duplicate tool_use lands', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, assistant([toolUse('Bash', 'tu_bash')]))
    m = updateToolIndexMirror(m, user([toolResult('tu_bash')], 'u-1'))
    expect(m.toolStatus.get('tu_bash')).toBe('success')
    // Re-encounter the same tool_use — terminal status must NOT regress.
    m = updateToolIndexMirror(m, assistant([toolUse('Bash', 'tu_bash')], 'a-2'))
    expect(m.toolStatus.get('tu_bash')).toBe('success')
  })

  it('keeps toolStatus identity-stable when the message carries no tool_use or matching result', () => {
    const m0 = updateToolIndexMirror(fresh(), assistant([toolUse('Bash', 'tu_bash')]))
    const before = m0.toolStatus
    const m1 = updateToolIndexMirror(m0, user([toolResult('tu_unknown')], 'u-x'))
    expect(m1.toolStatus).toBe(before)
    expect(m1.toolResults).toBe(m0.toolResults)
  })
})

// ---------------------------------------------------------------------------
// updateToolIndexMirror: sidechain-owned tool IDs stay EXCLUDED
// ---------------------------------------------------------------------------

describe('updateToolIndexMirror: sidechain-owned tool IDs excluded from generic toolStatus', () => {
  it('does NOT seed toolStatus for Agent / Task / Explore / ExitPlanMode / AskUserQuestion', () => {
    const m = updateToolIndexMirror(
      fresh(),
      assistant([
        toolUse('Agent', 'tu_agent'),
        toolUse('Task', 'tu_task'),
        toolUse('Explore', 'tu_explore'),
        toolUse('ExitPlanMode', 'tu_plan'),
        toolUse('AskUserQuestion', 'tu_q'),
        toolUse('Bash', 'tu_bash'),
      ]),
    )
    expect(m.toolStatus.has('tu_agent')).toBe(false)
    expect(m.toolStatus.has('tu_task')).toBe(false)
    expect(m.toolStatus.has('tu_explore')).toBe(false)
    expect(m.toolStatus.has('tu_plan')).toBe(false)
    expect(m.toolStatus.has('tu_q')).toBe(false)
    // The generic Bash tool is still seeded.
    expect(m.toolStatus.get('tu_bash')).toBe('running')
  })

  it('does NOT capture toolResults for sidechain-owned ids even when their result lands', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, assistant([toolUse('Agent', 'tu_agent'), toolUse('Bash', 'tu_bash')]))
    m = updateToolIndexMirror(
      m,
      user([
        toolResult('tu_agent', { content: 'agent output' }),
        toolResult('tu_bash', { content: 'ok' }),
      ], 'u-1'),
    )
    // The sidechain owner owns the Agent result; the generic map never sees it.
    expect(m.toolResults.has('tu_agent')).toBe(false)
    expect(m.toolResults.get('tu_bash')).toEqual({ content: 'ok', isError: false })
  })
})

// ---------------------------------------------------------------------------
// updateToolIndexMirror: plan status / content
// ---------------------------------------------------------------------------

describe('updateToolIndexMirror: plan approval/rejection/content', () => {
  const planStart = (id: string) =>
    assistant([toolUse('ExitPlanMode', id, { plan: '# Title\n- step' })], 'a-plan')

  it('seeds planStatus pending from an ExitPlanMode tool_use', () => {
    const m = updateToolIndexMirror(fresh(), planStart('tu_plan'))
    expect(m.planStatus.get('tu_plan')).toBe('pending')
  })

  it('flips planStatus to approved when the tool_result approves', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, planStart('tu_plan'))
    m = updateToolIndexMirror(
      m,
      user([toolResult('tu_plan', { content: 'User has approved exiting plan mode.' })], 'u-1'),
    )
    expect(m.planStatus.get('tu_plan')).toBe('approved')
  })

  it('flips planStatus to rejected when the tool_result denies', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, planStart('tu_plan'))
    m = updateToolIndexMirror(
      m,
      user([toolResult('tu_plan', { content: 'User chose to keep planning.' })], 'u-1'),
    )
    expect(m.planStatus.get('tu_plan')).toBe('rejected')
  })

  it('captures plan content from the "## Approved Plan:" section of an approving result', () => {
    const raw =
      'User has approved your plan.\n\n' +
      '## Approved Plan:\n# Title\n- step 1\n- step 2'
    let m = fresh()
    m = updateToolIndexMirror(m, planStart('tu_plan'))
    m = updateToolIndexMirror(m, user([toolResult('tu_plan', { content: raw })], 'u-1'))
    expect(m.planContent.get('tu_plan')).toBe('# Title\n- step 1\n- step 2')
  })

  it('captures nothing into planContent from a rejection result', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, planStart('tu_plan'))
    m = updateToolIndexMirror(
      m,
      user([toolResult('tu_plan', { content: 'User denied the tool request.' })], 'u-1'),
    )
    expect(m.planContent.has('tu_plan')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// updateToolIndexMirror: question pending/answered
// ---------------------------------------------------------------------------

describe('updateToolIndexMirror: question pending/answered', () => {
  const questionStart = (id: string) =>
    assistant([
      toolUse('AskUserQuestion', id, {
        questions: [{ question: 'OK?', options: [{ label: 'Yes' }] }],
      }),
    ], 'a-q')

  it('seeds an empty answers array (pending) for an AskUserQuestion tool_use', () => {
    const m = updateToolIndexMirror(fresh(), questionStart('tu_q'))
    expect(m.questionAnswers.get('tu_q')).toEqual([])
  })

  it('parses the JSON answers payload from the matching tool_result', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, questionStart('tu_q'))
    m = updateToolIndexMirror(
      m,
      user([
        toolResult('tu_q', {
          content: JSON.stringify({
            note: 'User answers from AskUserQuestion',
            answers: [{ question: 'OK?', answer: 'Yes' }],
          }),
        }),
      ], 'u-1'),
    )
    expect(m.questionAnswers.get('tu_q')).toEqual([{ question: 'OK?', answer: 'Yes' }])
  })

  it('encodes a skipped question as answer: null', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, questionStart('tu_q'))
    m = updateToolIndexMirror(
      m,
      user([
        toolResult('tu_q', {
          content: JSON.stringify({ answers: [{ question: 'OK?', answer: null }] }),
        }),
      ], 'u-1'),
    )
    expect(m.questionAnswers.get('tu_q')).toEqual([{ question: 'OK?', answer: null }])
  })

  it('leaves questionAnswers unchanged when the result payload is not parseable JSON', () => {
    let m = fresh()
    m = updateToolIndexMirror(m, questionStart('tu_q'))
    const before = m.questionAnswers
    m = updateToolIndexMirror(
      m,
      user([toolResult('tu_q', { content: 'aborted' })], 'u-1'),
    )
    expect(m.questionAnswers).toBe(before)
    // Pending entry survives.
    expect(m.questionAnswers.get('tu_q')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// applyPermissionRequest: pid → toolUseId mapping
// ---------------------------------------------------------------------------

describe('applyPermissionRequest: pidToToolUseId mapping', () => {
  it('seeds pidToToolUseId from a permission request with a toolUseID', () => {
    const request: PermissionRequest = {
      kind: 'permission',
      id: 'pid-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      toolUseID: 'tu_bash',
      createdAt: 0,
    }
    const state = applyPermissionRequest(freshState(), request)
    expect(state.mirror.pidToToolUseId.get('pid-1')).toBe('tu_bash')
  })

  it('seeds pidToToolUseId from a question (AskUserQuestion) request', () => {
    const request: PermissionRequest = {
      kind: 'question',
      id: 'pid-q',
      toolName: 'AskUserQuestion',
      questions: [{ question: 'OK?', options: [{ label: 'Yes' }] }],
      toolUseID: 'tu_q',
      createdAt: 0,
    }
    const state = applyPermissionRequest(freshState(), request)
    expect(state.mirror.pidToToolUseId.get('pid-q')).toBe('tu_q')
  })

  it('is identity-stable when the request carries no toolUseID', () => {
    // A bare permission request without a toolUseID is a no-op — the map
    // gains nothing and the state reference is preserved.
    const before = freshState()
    const request = {
      kind: 'permission',
      id: 'pid-bare',
      toolName: 'Bash',
      input: {},
      createdAt: 0,
    } as unknown as PermissionRequest
    const after = applyPermissionRequest(before, request)
    expect(after).toBe(before)
    expect(after.mirror.pidToToolUseId.has('pid-bare')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// applyPermissionResolved: pid cleanup, plan/question side effects, no-op
// ---------------------------------------------------------------------------

describe('applyPermissionResolved: pid cleanup + plan/question side effects', () => {
  function seedPlan(state: SessionState, toolUseId: string): SessionState {
    const msg: SdkMessage = {
      type: 'assistant',
      uuid: `a-${toolUseId}`,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'ExitPlanMode', input: {} }],
      },
    } as unknown as SdkMessage
    // Use the tool-index fold directly so we don't pull in the full reducer.
    return {
      sessionId: state.sessionId,
      mirror: updateToolIndexMirror(state.mirror, msg),
      intent: state.intent,
    }
  }

  function seedQuestion(state: SessionState, toolUseId: string): SessionState {
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
    return {
      sessionId: state.sessionId,
      mirror: updateToolIndexMirror(state.mirror, msg),
      intent: state.intent,
    }
  }

  function seedPid(state: SessionState, pid: string, toolUseId: string): SessionState {
    const request: PermissionRequest = {
      kind: 'permission',
      id: pid,
      toolName: 'ExitPlanMode',
      input: {},
      toolUseID: toolUseId,
      createdAt: 0,
    }
    return applyPermissionRequest(state, request)
  }

  it('removes the matching pidToToolUseId entry on resolution', () => {
    let state = seedPlan(freshState(), 'plan-1')
    state = seedPid(state, 'pid-1', 'plan-1')
    expect(state.mirror.pidToToolUseId.has('pid-1')).toBe(true)
    state = applyPermissionResolved(state, 'pid-1', { behavior: 'allow', persisted: false })
    expect(state.mirror.pidToToolUseId.has('pid-1')).toBe(false)
  })

  it('flips an existing plan to approved on an allow decision', () => {
    let state = seedPlan(freshState(), 'plan-1')
    state = seedPid(state, 'pid-1', 'plan-1')
    state = applyPermissionResolved(state, 'pid-1', { behavior: 'allow', persisted: false })
    expect(state.mirror.planStatus.get('plan-1')).toBe('approved')
  })

  it('flips an existing plan to rejected on a deny decision', () => {
    let state = seedPlan(freshState(), 'plan-1')
    state = seedPid(state, 'pid-1', 'plan-1')
    state = applyPermissionResolved(state, 'pid-1', { behavior: 'deny', persisted: false })
    expect(state.mirror.planStatus.get('plan-1')).toBe('rejected')
  })

  it('parses the JSON answers payload from decision.message into questionAnswers', () => {
    let state = seedQuestion(freshState(), 'tu_q')
    state = seedPid(state, 'pid-1', 'tu_q')
    state = applyPermissionResolved(state, 'pid-1', {
      behavior: 'deny',
      persisted: false,
      message: JSON.stringify({
        note: 'User answers from AskUserQuestion',
        answers: [{ question: 'OK?', answer: 'Yes' }],
      }),
    })
    expect(state.mirror.questionAnswers.get('tu_q')).toEqual([{ question: 'OK?', answer: 'Yes' }])
  })

  it('stores a clarified sentinel when questionResolution === "clarified"', () => {
    let state = seedQuestion(freshState(), 'tu_q')
    state = seedPid(state, 'pid-1', 'tu_q')
    state = applyPermissionResolved(state, 'pid-1', {
      behavior: 'deny',
      persisted: false,
      message: 'The user asked for more context.',
      questionResolution: 'clarified',
    })
    expect(state.mirror.questionAnswers.get('tu_q')).toEqual([
      { question: '', answer: null, clarified: true },
    ])
  })

  it('does not touch questionAnswers when the toolUseId was never seeded as a question', () => {
    // A plain Bash deny must not spuriously create a questionAnswers entry
    // even if decision.message happens to look like JSON.
    let state = freshState()
    const bashRequest: PermissionRequest = {
      kind: 'permission',
      id: 'pid-bash',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      toolUseID: 'tu_bash',
      createdAt: 0,
    }
    state = applyPermissionRequest(state, bashRequest)
    state = applyPermissionResolved(state, 'pid-bash', {
      behavior: 'deny',
      persisted: false,
      message: JSON.stringify({ answers: [{ question: 'X', answer: 'Y' }] }),
    })
    expect(state.mirror.questionAnswers.has('tu_bash')).toBe(false)
  })

  it('leaves questionAnswers unchanged when decision.message is not parseable JSON', () => {
    let state = seedQuestion(freshState(), 'tu_q')
    state = seedPid(state, 'pid-1', 'tu_q')
    const before = state.mirror.questionAnswers
    state = applyPermissionResolved(state, 'pid-1', {
      behavior: 'deny',
      persisted: false,
      message: 'aborted',
    })
    expect(state.mirror.questionAnswers).toBe(before)
  })

  it('is identity-stable when the pid maps to nothing (no plan/question entry, no pid)', () => {
    // A resolution for an unknown pid leaves ALL observable mirror fields
    // unchanged — the state reference is preserved.
    const before = seedPlan(freshState(), 'plan-1') // seed some state to prove it survives
    const after = applyPermissionResolved(before, 'unknown-pid', {
      behavior: 'allow',
      persisted: false,
    })
    expect(after).toBe(before)
  })

  it('preserves planStatus and questionAnswers references when no mapped pid touches them', () => {
    // Two pids are seeded; resolving the one whose toolUseId has NO plan /
    // question entry must not allocate fresh plan/question maps.
    let state = seedPlan(freshState(), 'plan-1')
    state = seedPid(state, 'pid-plan', 'plan-1')
    state = seedPid(state, 'pid-bare', 'tu_bare')
    const planBefore = state.mirror.planStatus
    const qBefore = state.mirror.questionAnswers
    state = applyPermissionResolved(state, 'pid-bare', { behavior: 'allow', persisted: false })
    expect(state.mirror.planStatus).toBe(planBefore)
    expect(state.mirror.questionAnswers).toBe(qBefore)
    // The pid map lost its entry though.
    expect(state.mirror.pidToToolUseId.has('pid-bare')).toBe(false)
    expect(state.mirror.pidToToolUseId.has('pid-plan')).toBe(true)
  })
})
