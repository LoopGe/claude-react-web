// Shared tool-name constants used across multiple components and modules.
// Centralising these prevents silent drift when a tool name is added or
// renamed in one place but not the others.

/** Tools that spawn nested subagent sessions. */
export const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task', 'Explore'])

/** Plan-mode PROPOSAL tool — the model submits a finished plan and asks to
 *  exit plan mode and start executing. Carries the plan body / allowedPrompts.
 *  This is the only name that should drive PlanCard / plan-review rendering.
 *
 *  NOTE: `EnterPlanMode` is deliberately NOT here. Despite the similar name it
 *  is a SEPARATE, semantically-opposite current SDK tool (`EnterPlanModeInput`
 *  is empty — it signals "I'm about to start planning", with no plan to review).
 *  Treating the two as aliases produced an empty "Plan proposal" card and a
 *  bogus approval prompt every time the model entered plan mode. EnterPlanMode
 *  is handled separately (see ENTER_PLAN_MODE_TOOL_NAME). */
export const PLAN_TOOL_NAMES = new Set(['ExitPlanMode'])

/** The plan-mode ENTRY signal — the model is about to start planning. Has an
 *  empty input and no plan content, so it is auto-allowed server-side and
 *  rendered as a lightweight inline marker (NOT a PlanCard). */
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'
