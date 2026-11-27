// server/providers/native/tools/plan-mode.ts
//
// The two plan-mode tools. EnterPlanMode is the ENTRY signal: its body drives
// the session's mode setter through an injected callback (the host owns the
// permission-mode field, so the tool stays neutral). ExitPlanMode presents the
// finished plan for review; the broker's existing ExitPlanMode branch raises
// the plan card before this body runs, and the heading check here rejects a
// malformed plan so the model retries with a proper one.
import type { ToolDef } from './types.js'

/** The plan-mode policy prompt section, appended per API round while the live
 *  permission mode is `plan` (not a static tool section). Exported so the
 *  session's guidance append and this module cannot drift. */
export const PLAN_MODE_GUIDANCE =
  'You are in plan mode. Explore and design read-only; present the complete plan by calling ExitPlanMode. Do not execute changes.'

export interface EnterPlanModeDeps {
  enterPlanMode(): Promise<void>
}

export function createEnterPlanModeTool(deps: EnterPlanModeDeps): ToolDef {
  return {
    name: 'EnterPlanMode',
    description:
      'Enter plan mode to explore read-only and design a plan before making changes.',
    guidance:
      'Use EnterPlanMode to switch into plan mode when a task needs a reviewed plan before execution.',
    promptOrder: 200,
    schema: {
      type: 'object',
      properties: {},
    },
    async run() {
      await deps.enterPlanMode()
      return { text: 'Entered plan mode.' }
    },
  }
}

export function createExitPlanModeTool(): ToolDef {
  return {
    name: 'ExitPlanMode',
    description:
      'Present the completed plan for user review and exit plan mode.',
    guidance:
      'Use ExitPlanMode to submit the finished plan for approval once planning is complete.',
    promptOrder: 205,
    schema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'The complete plan in markdown; it must start with a "#" heading.',
        },
      },
      required: ['plan'],
    },
    async run(input) {
      const plan = input.plan
      if (typeof plan !== 'string' || !/^#/.test(plan.trim())) {
        return {
          text: 'ExitPlanMode requires a markdown plan that starts with a "#" heading.',
          isError: true,
        }
      }
      return { text: plan }
    },
  }
}