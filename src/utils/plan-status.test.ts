import { describe, it, expect } from 'vitest'
import { computePlanStatus } from './plan-status'
import type { SdkMessage } from '../types'

function asstWithToolUse(name: string, id: string, plan = 'do stuff'): SdkMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name, tool_use_id: id, input: { plan } },
      ],
    },
  }
}

function userToolResult(id: string, text: string): SdkMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content: text },
      ],
    },
  }
}

describe('computePlanStatus', () => {
  it('returns empty map when no plan tool_use exists', () => {
    const out = computePlanStatus([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ])
    expect(out.size).toBe(0)
  })

  it('marks ExitPlanMode without a tool_result as pending', () => {
    const out = computePlanStatus([asstWithToolUse('ExitPlanMode', 'tu_1')])
    expect(out.get('tu_1')).toBe('pending')
  })

  it('marks plan as rejected when the result contains "keep planning"', () => {
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', 'User chose to keep planning. They said: needs more detail.'),
    ])
    expect(out.get('tu_1')).toBe('rejected')
  })

  it('marks plan as rejected for the "Send feedback" deny message', () => {
    // The plan dialog constructs: "Plan denied by user. Feedback: <text>"
    // — must contain the `denied by user` needle so it classifies as rejected
    // (Claude is revising, not approved).
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', 'Plan denied by user. Feedback: add more tests'),
    ])
    expect(out.get('tu_1')).toBe('rejected')
  })

  it('marks plan as rejected for the "Stop & take over" deny message', () => {
    // The plan dialog's stop action (and Esc) construct:
    // "Plan denied by user — stopping the turn." — must classify as rejected.
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', 'Plan denied by user — stopping the turn.'),
    ])
    expect(out.get('tu_1')).toBe('rejected')
  })

  it('marks plan as approved on a generic non-rejection tool_result', () => {
    // The SDK echoes the plan back in tool_result on approval.
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1', '## Plan\n- step 1'),
      userToolResult('tu_1', '## Plan\n- step 1'),
    ])
    expect(out.get('tu_1')).toBe('approved')
  })

  it('ignores rejection words inside an explicitly approved plan body', () => {
    const raw =
      'User has approved your plan. You can now start coding.\n\n' +
      '## Approved Plan:\n# Plan Card refactor\n' +
      '- Keep rejected as an internal status.\n' +
      '- Preserve "denied by user" in denial messages.'
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', raw),
    ])
    expect(out.get('tu_1')).toBe('approved')
  })

  it('keeps rejection when denial feedback quotes an Approved Plan section', () => {
    const raw =
      'Plan denied by user. Feedback: revise this draft\n\n' +
      '## Approved Plan:\n# Old draft\n- rejected step'
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', raw),
    ])
    expect(out.get('tu_1')).toBe('rejected')
  })

  it('ignores rejection words in approval metadata paths', () => {
    const raw =
      'User has approved your plan.\n\n' +
      'Your plan has been saved to: /tmp/rejected/plan.md\n\n' +
      '## Approved Plan:\n# Title'
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', raw),
    ])
    expect(out.get('tu_1')).toBe('approved')
  })

  it('approves a generic plan with an introduction and rejection words in its body', () => {
    const raw = 'Here is the plan:\n\n## Steps\n- Remove rejected states'
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', raw),
    ])
    expect(out.get('tu_1')).toBe('approved')
  })

  it('approves a generic plan when its introduction mentions rejected states', () => {
    const raw = 'Here is the plan for rejected states:\n\n## Steps\n- implement'
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', raw),
    ])
    expect(out.get('tu_1')).toBe('approved')
  })

  it('recognizes a denial after leading blank lines', () => {
    const raw = '\nPlan denied by user. Feedback: revise\n\n## Approved Plan:\n# Old'
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', raw),
    ])
    expect(out.get('tu_1')).toBe('rejected')
  })

  it('recognizes the harness rejection envelope', () => {
    const raw =
      "The user doesn't want to proceed with this tool use. The tool use was rejected " +
      '(eg. if it was a file edit, the new_string was NOT written to the file).'
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', raw),
    ])
    expect(out.get('tu_1')).toBe('rejected')
  })

  it('recognizes a direct Denied by user result', () => {
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', 'Denied by user'),
    ])
    expect(out.get('tu_1')).toBe('rejected')
  })

  it('approves a plan whose title starts with Rejected', () => {
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', 'Rejected states\n\n- Remove legacy rejected labels'),
    ])
    expect(out.get('tu_1')).toBe('approved')
  })

  it('matches case-insensitively against rejection needles', () => {
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', 'PERMISSION DENIED — try again'),
    ])
    expect(out.get('tu_1')).toBe('rejected')
  })

  it('handles content as an array of blocks', () => {
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: [
              { type: 'text', text: 'rejected by user' },
            ] },
          ],
        },
      },
    ])
    expect(out.get('tu_1')).toBe('rejected')
  })

  it('does NOT treat EnterPlanMode as a plan proposal', () => {
    // EnterPlanMode is the plan-mode ENTRY signal (empty input, nothing to
    // review) — semantically opposite to ExitPlanMode. It must not appear in
    // the plan-status map, so its tool_use stays out of PlanCard rendering.
    const out = computePlanStatus([asstWithToolUse('EnterPlanMode', 'tu_1')])
    expect(out.has('tu_1')).toBe(false)
  })

  it('tracks multiple plans in one transcript independently', () => {
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1'),
      userToolResult('tu_1', 'User chose to keep planning'),
      asstWithToolUse('ExitPlanMode', 'tu_2'),
      userToolResult('tu_2', '## Revised plan'),
      asstWithToolUse('ExitPlanMode', 'tu_3'),
      // tu_3 still pending — no result yet.
    ])
    expect(out.get('tu_1')).toBe('rejected')
    expect(out.get('tu_2')).toBe('approved')
    expect(out.get('tu_3')).toBe('pending')
  })

  it('ignores non-plan tool_use blocks', () => {
    const out = computePlanStatus([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', tool_use_id: 'tu_1', input: { command: 'ls' } },
          ],
        },
      },
    ])
    expect(out.size).toBe(0)
  })
})
