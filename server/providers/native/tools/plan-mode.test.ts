// plan-mode.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createEnterPlanModeTool, createExitPlanModeTool, PLAN_MODE_GUIDANCE } from './plan-mode.js'

const ctx = { cwd: '/tmp', signal: new AbortController().signal }

describe('createEnterPlanModeTool', () => {
  it('is named EnterPlanMode with an empty object schema', () => {
    const tool = createEnterPlanModeTool({ enterPlanMode: async () => {} })
    expect(tool.name).toBe('EnterPlanMode')
    expect(tool.schema).toEqual({ type: 'object', properties: {} })
  })
  it('invokes the enterPlanMode callback on run', async () => {
    const enterPlanMode = vi.fn(async () => {})
    const tool = createEnterPlanModeTool({ enterPlanMode })
    const out = await tool.run({}, ctx)
    expect(enterPlanMode).toHaveBeenCalledOnce()
    expect(out.isError).toBeFalsy()
  })
})

describe('createExitPlanModeTool', () => {
  it('is named ExitPlanMode requiring a plan string', () => {
    const tool = createExitPlanModeTool()
    expect(tool.name).toBe('ExitPlanMode')
    expect(tool.schema.required).toEqual(['plan'])
  })
  it('accepts a plan starting with a # heading', async () => {
    const out = await createExitPlanModeTool().run({ plan: '# Title\n\n- step' }, ctx)
    expect(out.isError).toBeFalsy()
    expect(out.text).toContain('# Title')
  })
  it('rejects a plan without a leading # heading', async () => {
    const out = await createExitPlanModeTool().run({ plan: 'no heading here' }, ctx)
    expect(out.isError).toBe(true)
  })
})

it('exports non-empty plan guidance', () => {
  expect(PLAN_MODE_GUIDANCE.length).toBeGreaterThan(0)
})