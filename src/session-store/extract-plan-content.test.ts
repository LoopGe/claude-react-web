import { describe, it, expect } from 'vitest'
import { extractPlanContent } from './normalize'
import type { SdkMessage } from '../types'

const KNOWN = new Set(['tu_1'])

function userResult(id: string, content: unknown): SdkMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  } as SdkMessage
}

describe('extractPlanContent', () => {
  it('captures NOTHING from the short boilerplate approval message', () => {
    // Regression: the old fallback stored this sentence as the plan body,
    // so the PlanCard rendered "User has approved exiting plan mode…"
    // instead of the actual plan.
    const out = extractPlanContent(
      userResult('tu_1', 'User has approved exiting plan mode. You can now proceed.'),
      KNOWN,
    )
    expect(out).toEqual([])
  })

  it('extracts the plan body from the "## Approved Plan:" section', () => {
    const raw =
      'User has approved your plan. You can now start coding.\n\n' +
      'Your plan has been saved to: /tmp/plan.md\n\n' +
      '## Approved Plan:\n# Title\n- step 1\n- step 2'
    const out = extractPlanContent(userResult('tu_1', raw), KNOWN)
    expect(out).toEqual([{ toolUseId: 'tu_1', plan: '# Title\n- step 1\n- step 2' }])
  })

  it('extracts from the "## Approved Plan (edited by user):" variant', () => {
    const raw =
      'User has approved your plan.\n\n' +
      '## Approved Plan (edited by user):\n# Edited\n- a'
    const out = extractPlanContent(userResult('tu_1', raw), KNOWN)
    expect(out[0]?.plan).toBe('# Edited\n- a')
  })

  it('extracts the .plan field from a legacy JSON result', () => {
    const raw = JSON.stringify({ plan: '# JSON plan\n- x', isAgent: false })
    const out = extractPlanContent(userResult('tu_1', raw), KNOWN)
    expect(out[0]?.plan).toBe('# JSON plan\n- x')
  })

  it('captures nothing from a rejection / denial message', () => {
    const out = extractPlanContent(
      userResult('tu_1', 'User denied the tool request.'),
      KNOWN,
    )
    expect(out).toEqual([])
  })

  it('ignores tool_results whose id is not a known plan id', () => {
    const raw = '## Approved Plan:\n# Title'
    const out = extractPlanContent(userResult('tu_other', raw), KNOWN)
    expect(out).toEqual([])
  })

  it('reads plan from array-of-blocks content', () => {
    const msg: SdkMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'text', text: '## Approved Plan:\n# Title\n- y' }],
          },
        ],
      },
    } as SdkMessage
    const out = extractPlanContent(msg, KNOWN)
    expect(out[0]?.plan).toBe('# Title\n- y')
  })
})
