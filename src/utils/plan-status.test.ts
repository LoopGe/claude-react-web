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

  it('marks plan as approved on a generic non-rejection tool_result', () => {
    // The SDK echoes the plan back in tool_result on approval.
    const out = computePlanStatus([
      asstWithToolUse('ExitPlanMode', 'tu_1', '## Plan\n- step 1'),
      userToolResult('tu_1', '## Plan\n- step 1'),
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

  it('also matches the legacy EnterPlanMode tool name', () => {
    const out = computePlanStatus([asstWithToolUse('EnterPlanMode', 'tu_1')])
    expect(out.get('tu_1')).toBe('pending')
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
