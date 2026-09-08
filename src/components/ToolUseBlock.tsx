// Structured rendering for tool_use blocks.
//
// Dispatches by tool name to provide rich views for Edit/Write/Bash/Read
// /etc., falling back to raw JSON for unknown tools.  Every concrete view
// is wrapped in <ToolCard> (see ToolCard.tsx) so they share the same
// chrome — icon, title, chip row, status badge, copy button — and the UI
// stays consistent across the dispatch table.
//
// Three tools have their *own* card wrappers because they carry their own
// lifecycle that doesn't map onto the generic running/success/error model
// (PlanCard's pending/approved/rejected, QuestionCard's pending/answered
// /skipped, SubagentCard's child-conversation drill-in):
//
//   - ExitPlanMode                 → PlanCard (plan proposal, review lifecycle)
//   - AskUserQuestion              → QuestionCard
//   - Agent / Task / Explore       → SubagentCard
//
// EnterPlanMode is NOT a bespoke-card tool despite the similar name — it is the
// plan-mode ENTRY signal (empty input, nothing to review) and renders as a
// lightweight inline marker (EnterPlanModeMarker), distinct from ExitPlanMode.
//
// Everything else routes through TOOL_VIEWS below.
//
// `toolUseId` is threaded through to every view so ToolCard can flip the
// status badge from running → success/error when the matching tool_result
// lands. Without it, the badge would be permanently stuck on "running".
//
// The concrete per-tool views live under ./tool-views/ (grouped by family:
// shared infra, mode-transition markers, PlanCard, QuestionCard, the shared
// diff-rendering engine, Edit/Write/NotebookEdit, Bash/PowerShell, the
// lightweight search-family views, and the agent/task-ecosystem views).
// New tools: add the view under ./tool-views/, then add an entry to
// TOOL_VIEWS below.

import { memo, type ComponentType } from 'react'
import { SubagentCard } from './SubagentCard'
import { WorkflowCard } from './WorkflowCard'
import { FindingsCard } from './FindingsCard'
import { ToolCard } from './ToolCard'
import { IconShield } from './icons/ToolIcons'
import { formatJson } from '../utils/format'
import { SUBAGENT_TOOL_NAMES, PLAN_TOOL_NAMES, ENTER_PLAN_MODE_TOOL_NAME, ENTER_WORKTREE_TOOL_NAME, EXIT_WORKTREE_TOOL_NAME, WORKFLOW_TOOL_NAME, REPORT_FINDINGS_TOOL_NAME } from '../constants/toolNames'
import { QUESTION_TOOL_NAME } from '../utils/question-answers'
import { truncate } from '../utils/text'
import { extractToolUseId } from '../session-store/normalize'
import type { Block } from '../types'

import type { ToolViewProps } from './tool-views/shared'
import { EnterPlanModeMarker, WorktreeMarker } from './tool-views/markers'
import { PlanCard } from './tool-views/PlanCard'
import { QuestionCard } from './tool-views/QuestionCard'
import { EditToolView, WriteToolView, NotebookEditToolView } from './tool-views/EditWriteViews'
import { BashToolView } from './tool-views/BashToolView'
import { ReadToolView, GrepToolView, GlobToolView, WebFetchToolView, WebSearchToolView } from './tool-views/SearchToolViews'
import { SkillToolView, SendMessageToolView, TaskOutputToolView, TaskMutationView, TodoWriteView } from './tool-views/AgentToolViews'

type ToolInputView = ComponentType<ToolViewProps>

// Dispatch table for per-tool inline views.
//
// Bash and PowerShell share BashToolView — both have the same input shape
// (command, description, run_in_background, timeout) and the same visual
// "shell command + chips + description" layout. The view branches on
// `toolName` to swap the prompt glyph ($ vs >).
const TOOL_VIEWS: Record<string, ToolInputView> = {
  Edit: EditToolView,
  MultiEdit: EditToolView,
  Write: WriteToolView,
  TodoWrite: TodoWriteView,
  Bash: BashToolView,
  PowerShell: BashToolView,
  Read: ReadToolView,
  Grep: GrepToolView,
  Glob: GlobToolView,
  WebFetch: WebFetchToolView,
  WebSearch: WebSearchToolView,
  Skill: SkillToolView,
  SendMessage: SendMessageToolView,
  TaskOutput: TaskOutputToolView,
  NotebookEdit: NotebookEditToolView,
  TaskCreate: TaskMutationView,
  TaskUpdate: TaskMutationView,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export const ToolUseBlock = memo(function ToolUseBlock({ block, searchQuery, activeMatchIdx, diffActiveMatchIdx }: { block: Block; searchQuery?: string; activeMatchIdx?: number; diffActiveMatchIdx?: number }) {
  const name = block.name
  const input = block.input as Record<string, unknown> | undefined
  const id = extractToolUseId(block)

  // EnterPlanMode → lightweight inline marker. It only signals "the model is
  // about to start planning" (empty input, no plan to show) — NOT a plan
  // proposal, so it must NOT render a PlanCard. Check before PLAN_TOOL_NAMES.
  if (name === ENTER_PLAN_MODE_TOOL_NAME) {
    return <EnterPlanModeMarker />
  }

  // EnterWorktree / ExitWorktree → lightweight inline markers (no card, no
  // status badge). Like EnterPlanMode these are mode-transition signals, not
  // actionable tool calls with rich input to display.
  if (name === ENTER_WORKTREE_TOOL_NAME) {
    return <WorktreeMarker input={input} action="enter" />
  }
  if (name === EXIT_WORKTREE_TOOL_NAME) {
    return <WorktreeMarker input={input} action="exit" />
  }

  // ExitPlanMode → bespoke PlanCard (own pending/approved/rejected lifecycle).
  if (name && PLAN_TOOL_NAMES.has(name)) {
    return <PlanCard input={input} toolUseId={id} />
  }

  // AskUserQuestion → bespoke QuestionCard (own lifecycle).
  if (name === QUESTION_TOOL_NAME) {
    return <QuestionCard input={input} toolUseId={id} />
  }

  // Agent / Task / Explore → SubagentCard (drill-in to child conversation).
  if (name && SUBAGENT_TOOL_NAMES.has(name)) {
    if (id) {
      const fallback =
        (typeof input?.description === 'string' && input.description) ||
        (typeof input?.prompt === 'string' && truncate(input.prompt as string, 80)) ||
        undefined
      return <SubagentCard toolUseId={id} fallbackLabel={fallback} />
    }
  }

  // Workflow → WorkflowCard (drill-in to the two-column phase-tree overlay).
  // Like SubagentCard it spawns nested tool_use/tool_result frames (its child
  // agents carry parent_tool_use_id = its own tool_use id), but it gets its
  // own card/overlay pair because it additionally carries a declarative phase
  // tree (input.meta.phases) that has no analogue in a plain Agent/Task/Explore
  // call. Falls through to the raw-JSON branch only when we somehow lack an id.
  if (name === WORKFLOW_TOOL_NAME && id) {
    const fallback =
      (typeof input?.description === 'string' && input.description) ||
      (typeof input?.prompt === 'string' && truncate(input.prompt as string, 80)) ||
      undefined
    return <WorkflowCard toolUseId={id} fallbackLabel={fallback} />
  }

  // ReportFindings → bespoke FindingsCard (structured code-review report with
  // verdict chips + expandable failure scenarios). Must intercept BEFORE the
  // generic TOOL_VIEWS / raw-JSON fallback so the findings payload isn't
  // rendered as a dump of JSON. The ack tool_result is auto-suppressed via the
  // generic toolResults map (FindingsCard renders the tool_use input, not the
  // result), so no orphan bubble leaks through.
  if (name === REPORT_FINDINGS_TOOL_NAME) {
    return <FindingsCard input={input} />
  }

  const View = name ? TOOL_VIEWS[name] : undefined
  if (View) {
    return <View input={input} toolName={name} toolUseId={id} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} diffActiveMatchIdx={diffActiveMatchIdx} />
  }
  // Unknown tool — fall back to raw JSON inside a generic ToolCard so the
  // status badge is still visible and the row aligns with the rest of the
  // transcript. Title is the tool name itself; nothing better to show.
  return (
    <ToolCard
      icon={<IconShield />}
      title={name ? <code className="tool-card-title-code">{name}</code> : 'tool'}
      toolUseId={id}
      copyValue={() => formatJson(input)}
      copyLabel="Copy raw input"
      className="tool-card-unknown"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      <pre className="tool-input">{formatJson(input)}</pre>
    </ToolCard>
  )
})
