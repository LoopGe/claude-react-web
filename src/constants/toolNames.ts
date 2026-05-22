// Shared tool-name constants used across multiple components and modules.
// Centralising these prevents silent drift when a tool name is added or
// renamed in one place but not the others.

/** Tools that spawn nested subagent sessions. */
export const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task', 'Explore'])

/** Plan-mode tool names (ExitPlanMode is current; EnterPlanMode is legacy). */
export const PLAN_TOOL_NAMES = new Set(['ExitPlanMode', 'EnterPlanMode'])
