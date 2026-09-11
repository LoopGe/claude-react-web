// Shared tool-name constants used across multiple components and modules.
// Centralising these prevents silent drift when a tool name is added or
// renamed in one place but not the others.

/** Tools that spawn nested subagent sessions. */
export const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task', 'Explore'])

/** The multi-agent orchestration tool. Like SUBAGENT_TOOL_NAMES it spawns
 *  nested tool_use/tool_result frames (its child agents carry
 *  parent_tool_use_id = the Workflow's tool_use id), but it is handled by
 *  its OWN card/overlay pair (WorkflowCard / WorkflowOverlay) rather than
 *  SubagentCard/SubagentOverlay, because it additionally carries a
 *  declarative phase tree (input.meta.phases) that has no analogue in a
 *  plain Agent/Task/Explore call.
 *
 *  Kept a separate constant (not folded into SUBAGENT_TOOL_NAMES) so the
 *  SubagentOverlay / WorkingBubble chip paths stay unchanged — a Workflow
 *  gets a bespoke two-column overlay (phase tree + child messages), not the
 *  single-conversation subagent drawer. */
export const WORKFLOW_TOOL_NAME = 'Workflow'

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

/** Worktree entry/exit tools. EnterWorktree creates a new worktree (input.name)
 *  or switches to an existing one (input.path). ExitWorktree leaves the
 *  worktree (input.action = 'keep' | 'remove'). Both are lightweight signals,
 *  rendered as inline markers rather than full tool cards. */
export const ENTER_WORKTREE_TOOL_NAME = 'EnterWorktree'
export const EXIT_WORKTREE_TOOL_NAME = 'ExitWorktree'

/** The worktree pair as one set, so modules that need "is this a worktree
 *  signal?" (transcript grouping, status maps) pair them here instead of
 *  re-pairing the scalars locally. */
export const WORKTREE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])

/** Every tool that renders as a thin inline marker (tool-views/markers.tsx)
 *  instead of a full tool card: EnterPlanMode plus the worktree pair. The
 *  transcript's tool-group fold treats all of them as run boundaries — a
 *  collapsed group would hide the mode-transition cue the marker exists to
 *  show. */
export const MARKER_TOOL_NAMES: ReadonlySet<string> = new Set([
  ENTER_PLAN_MODE_TOOL_NAME,
  ...WORKTREE_TOOL_NAMES,
])

/** Structured code-review findings report. The agent calls this with
 *  `{ level, findings: [{ file, line, summary, failure_scenario, category,
 *  verdict?, outcome? }] }`. Rendered by a bespoke FindingsCard (severity /
 *  verdict chips + expandable failure scenarios) instead of the generic
 *  ToolCard / raw-JSON fallback. The tool itself is provided out-of-band
 *  (MCP / plugin / SDK custom tool) — this constant only owns the rendering
 *  routing, mirroring ExitPlanMode→PlanCard / Agent→SubagentCard. */
export const REPORT_FINDINGS_TOOL_NAME = 'ReportFindings'
