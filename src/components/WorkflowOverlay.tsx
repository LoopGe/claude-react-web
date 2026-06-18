// Per-panel right-side overlay that holds a Workflow's full child conversation
// in a TWO-COLUMN layout: a phase-tree sidebar on the left, the message
// stream on the right. Same overlay-inside-the-Chat-column pattern as
// SubagentOverlay / SettingsPanel: absolute positioned, semi-transparent
// backdrop, only covers this column. ESC or backdrop click closes.
//
// The phase tree groups the Workflow's child agents (WorkflowChildAgent[])
// by the `phase` tag the script assigned. Each phase is a collapsible
// <details>; each child is a clickable row that FOCUSES that child's inner
// conversation in the right column (via parentToolUseIdFilter = the child's
// tool_use_id) — the same filtering mechanism SubagentOverlay uses, just
// driven by local focus state instead of a navigation stack.
//
// Why two columns instead of SubagentOverlay's single column:
//   A Workflow's value is the phase/progress STRUCTURE (which phase is
//   running, how many children per branch, which finished). A single flat
//   message stream buries that structure. The sidebar makes the structure
//   the primary view; the right column shows the work for whichever branch
//   the user selects (defaulting to the Workflow's own direct children).

import { memo, useEffect, useMemo, useState } from 'react'
import { MessageList } from './MessageList'
import { formatElapsed } from '../utils/format'
import { IconX, IconWorkflow, IconChevronRight } from './icons/ToolIcons'
import { AnimatedDetails } from './AnimatedCollapse'
import type {
  PlanStatus,
  ToolResultEntry,
  ToolStatus,
  WorkflowChildAgent,
  WorkflowPhaseMeta,
  WorkflowRecord,
  TranscriptItem,
} from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'

interface Props {
  /** The Workflow record this overlay is showing. */
  record: WorkflowRecord
  /** Full session transcript — the right column filters it to messages whose
   *  parent_tool_use_id matches the focused frame (the Workflow id, or a
   *  focused child's id). */
  items: TranscriptItem[]
  onClose: () => void
  isExiting?: boolean
  onExited?: () => void
  /** Tool/plan/question lifecycle maps — forwarded to the nested MessageList
   *  so subagent-internal tool cards read the right status (same reason
   *  SubagentOverlay forwards these — see its comment). */
  toolStatus?: ReadonlyMap<string, ToolStatus>
  toolResults?: ReadonlyMap<string, ToolResultEntry>
  planStatus?: ReadonlyMap<string, PlanStatus>
  planContent?: ReadonlyMap<string, string>
  questionAnswers?: ReadonlyMap<string, QuestionAnswerEntry[]>
}

const UNGROUPED = '(ungrouped)'

export const WorkflowOverlay = memo(function WorkflowOverlay({
  record,
  items,
  onClose,
  isExiting = false,
  onExited,
  toolStatus,
  toolResults,
  planStatus,
  planContent,
  questionAnswers,
}: Props) {
  // Focused child: null = show the Workflow's direct children (phase tree
  // level). A child's toolUseId = drill into THAT child's inner conversation.
  const [focusedChild, setFocusedChild] = useState<string | null>(null)

  // ESC closes (or unfocuses a drilled-in child first). Two-level only:
  // Workflow → child. Nested-drill beyond a child is out of scope here
  // (a child's own nested subagents surface as SubagentCards in the right
  // column and open the SubagentOverlay via the shared stack).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (isExiting) return
      if (focusedChild) setFocusedChild(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isExiting, focusedChild, onClose])

  const startedAt = record.startedAt
  const endedAt = record.endedAt
  const elapsedMs = startedAt ? (endedAt ?? Date.now()) - startedAt : null
  const statusText =
    record.status === 'running' ? 'running'
    : record.status === 'done' ? 'done'
    : record.status === 'rejected' ? 'rejected'
    : 'interrupted'

  // Group children by phase. Declared phases come first (in script order);
  // any child whose phase didn't match a declared phase, or has phase ===
  // null, lands in the synthetic UNGROUPED bucket. Children whose phase
  // matches a declared phase but the phase had no declared meta entry are
  // still grouped under their literal phase string.
  const phaseGroups = useMemo(() => {
    const groups = new Map<string, WorkflowChildAgent[]>()
    // Seed declared phases so they appear in order even before children
    // arrive (the tree shows the planned structure up front).
    for (const p of record.phases) groups.set(p.title, [])
    for (const child of record.childAgents) {
      const key = child.phase ?? UNGROUPED
      const arr = groups.get(key)
      if (arr) arr.push(child)
      else groups.set(key, [child])
    }
    // Move UNGROUPED to the end if it exists.
    if (groups.has(UNGROUPED)) {
      const arr = groups.get(UNGROUPED)!
      groups.delete(UNGROUPED)
      groups.set(UNGROUPED, arr)
    }
    return Array.from(groups.entries())
  }, [record.phases, record.childAgents])

  // The right column's filter: the Workflow id (direct children) when no
  // child is focused, otherwise the focused child's id (its inner convo).
  const filterId = focusedChild ?? record.toolUseId
  const focusedChildRecord = focusedChild
    ? record.childAgents.find((c) => c.toolUseId === focusedChild)
    : null

  return (
    <div
      className="workflow-overlay"
      role="dialog"
      aria-modal="false"
      aria-label="Workflow details"
      onMouseDown={(e) => {
        if (isExiting) return
        if (e.target === e.currentTarget) onClose()
      }}
      data-state={isExiting ? 'closing' : 'open'}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && isExiting && e.animationName === 'workflow-backdrop-out') {
          onExited?.()
        }
      }}
    >
      <div className="workflow-overlay-panel">
        <div className="workflow-overlay-header">
          <span className="workflow-overlay-icon" aria-hidden><IconWorkflow size={15} /></span>
          <div className="workflow-overlay-title">
            <span className="workflow-overlay-current-label">{record.label}</span>
            <span className={`workflow-overlay-status status-${record.status}`}>
              {statusText}
              {elapsedMs != null && ` · ${formatElapsed(elapsedMs)}`}
            </span>
          </div>
          <button
            type="button"
            className="workflow-overlay-close"
            onClick={onClose}
            disabled={isExiting}
            title="Close (Esc)"
            aria-label="Close"
          >
            <IconX size={14} />
          </button>
        </div>

        {/* Breadcrumb when drilled into a child. Clicking the crumb returns
            to the Workflow-level view (focus = null). */}
        {focusedChildRecord && (
          <div className="workflow-overlay-breadcrumb">
            <button
              type="button"
              className="workflow-overlay-crumb"
              onClick={() => setFocusedChild(null)}
            >
              {record.label}
            </button>
            <IconChevronRight size={12} aria-hidden />
            <span className="workflow-overlay-crumb workflow-overlay-crumb-current">
              {focusedChildRecord.label}
            </span>
          </div>
        )}

        <div className="workflow-overlay-body">
          {/* Left column: phase tree. */}
          <aside className="workflow-phase-tree">
            {phaseGroups.length === 0 ? (
              <div className="workflow-phase-empty">
                No phases declared yet.
              </div>
            ) : (
              phaseGroups.map(([phaseTitle, children]) => (
                <PhaseGroup
                  key={phaseTitle}
                  title={phaseTitle}
                  phaseMeta={record.phases.find((p) => p.title === phaseTitle)}
                  children_={children}
                  focusedChild={focusedChild}
                  onFocus={setFocusedChild}
                />
              ))
            )}
          </aside>

          {/* Right column: messages for the focused frame. */}
          <div className="workflow-message-column">
            <MessageList
              items={items}
              parentToolUseIdFilter={filterId}
              transcriptRevealKey={`workflow:${filterId}`}
              toolStatus={toolStatus}
              toolResults={toolResults}
              planStatus={planStatus}
              planContent={planContent}
              questionAnswers={questionAnswers}
              replayReady
            />
          </div>
        </div>
      </div>
    </div>
  )
})

/** One collapsible phase group in the tree. Renders the phase title + an
 *  aggregate progress chip, and a list of child-agent rows. Each row is a
 *  button that focuses that child's inner conversation in the right column. */
const PhaseGroup = memo(function PhaseGroup({
  title,
  phaseMeta,
  children_,
  focusedChild,
  onFocus,
}: {
  title: string
  phaseMeta?: WorkflowPhaseMeta
  children_: WorkflowChildAgent[]
  focusedChild: string | null
  onFocus: (toolUseId: string | null) => void
}) {
  const running = children_.filter((c) => c.status === 'running').length
  const done = children_.filter((c) => c.status === 'done').length
  const errored = children_.filter((c) => c.status === 'interrupted').length
  const total = children_.length

  const summary = (
    <span className="workflow-phase-summary">
      <span className="workflow-phase-title">{title}</span>
      <span className="workflow-phase-count">
        {done}/{total}{running > 0 ? ` · ${running} active` : ''}{errored > 0 ? ` · ${errored} failed` : ''}
      </span>
    </span>
  )

  return (
    <AnimatedDetails
      className="workflow-phase-group"
      defaultOpen
      summary={summary}
      summaryClassName="workflow-phase-group-summary"
      contentClassName="workflow-phase-group-content"
    >
      {children_.length === 0 ? (
        <div className="workflow-phase-no-children">No agents yet</div>
      ) : (
        <ul className="workflow-phase-children">
          {children_.map((child) => (
            <li key={child.toolUseId}>
              <button
                type="button"
                className={`workflow-child-row${focusedChild === child.toolUseId ? ' workflow-child-row-focused' : ''} workflow-child-row-${child.status}`}
                onClick={() => onFocus(focusedChild === child.toolUseId ? null : child.toolUseId)}
                title={`${child.toolName}: ${child.label}`}
              >
                <span className={`workflow-child-status workflow-child-status-${child.status}`} aria-hidden />
                <span className="workflow-child-toolname">{child.toolName}</span>
                <span className="workflow-child-label">{child.label}</span>
                {child.toolCount > 0 && (
                  <span className="workflow-child-tools">{child.toolCount}</span>
                )}
                <IconChevronRight size={11} className="workflow-child-chevron" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {phaseMeta?.detail && (
        <div className="workflow-phase-detail">{phaseMeta.detail}</div>
      )}
    </AnimatedDetails>
  )
})
