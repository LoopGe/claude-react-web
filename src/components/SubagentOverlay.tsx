// Per-panel right-side overlay that holds a subagent's full internal
// conversation. Same overlay-inside-the-Chat-column pattern as
// SettingsPanel: absolute positioned, semi-transparent backdrop, only
// covers this column. ESC or backdrop click closes; the breadcrumb
// supports nested drill-down (a Task spawned inside an Agent etc.).

import { memo, useEffect } from 'react'
import { MessageList } from './MessageList'
import { formatElapsed } from '../utils/format'
import { IconX } from './icons/ToolIcons'
import type { ActiveSubagent, PlanStatus, ToolStatus, TranscriptItem } from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'

interface Props {
  /** Stack of toolUseIds: stack[0] is the outermost subagent the user
   *  drilled into, stack[length-1] is the one currently shown. */
  stack: string[]
  /** Full session transcript — we filter it to messages whose
   *  parent_tool_use_id matches the current frame. */
  items: TranscriptItem[]
  index: ReadonlyMap<string, ActiveSubagent>
  onClose: () => void
  onPop: () => void
  showSystemEvents?: boolean
  /** Tool/plan/question lifecycle maps. These MUST be forwarded to the
   *  nested MessageList — it builds its OWN status context providers, so
   *  without them every tool card inside a drilled-in subagent reads the
   *  empty-default provider and useToolStatus() falls back to 'running'
   *  forever (the "tool stuck running" bug). The reducer already seeds
   *  subagent-internal tool ids (it ignores parent_tool_use_id), so the
   *  data exists — it just has to reach this MessageList. */
  toolStatus?: ReadonlyMap<string, ToolStatus>
  planStatus?: ReadonlyMap<string, PlanStatus>
  planContent?: ReadonlyMap<string, string>
  questionAnswers?: ReadonlyMap<string, QuestionAnswerEntry[]>
}


export const SubagentOverlay = memo(function SubagentOverlay({
  stack,
  items,
  index,
  onClose,
  onPop,
  showSystemEvents,
  toolStatus,
  planStatus,
  planContent,
  questionAnswers,
}: Props) {
  const currentId = stack[stack.length - 1]
  const current = currentId ? index.get(currentId) : undefined

  // ESC closes (or pops one level if nested).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (stack.length > 1) onPop()
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stack.length, onClose, onPop])

  // If the referenced subagent vanishes from the index (session reset,
  // fork, etc.) the overlay would render null and the stack would be
  // stuck non-empty — close/back become silent no-ops. Drive a real
  // close so subsequent open() calls work.
  useEffect(() => {
    if (currentId && !current) onClose()
  }, [currentId, current, onClose])

  if (!currentId || !current) return null

  // Live elapsed for the current frame's header. Re-renders piggy-back
  // on the parent (Chat) re-rendering — good enough at second granularity.
  const startedAt = current.startedAt
  const endedAt = current.endedAt
  const elapsedMs = startedAt ? (endedAt ?? Date.now()) - startedAt : null

  const statusText =
    current.status === 'running' ? 'running'
    : current.status === 'done' ? 'done'
    : current.status === 'rejected' ? 'rejected'
    : 'interrupted'

  return (
    <div
      className="subagent-overlay"
      role="dialog"
      aria-modal="false"
      aria-label="Subagent details"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="subagent-overlay-panel">
        <div className="subagent-overlay-header">
          {stack.length > 1 ? (
            <button
              type="button"
              className="subagent-overlay-back"
              onClick={onPop}
              title="Back to outer subagent"
              aria-label="Back"
            >
              ⏴
            </button>
          ) : (
            // Reserve the back-button slot when there's nothing to go
            // back to, so drilling 1→2 (and back 2→1) does not jump
            // every label in the title row sideways by ~36px (button
            // width + gap). The placeholder is aria-hidden because it
            // carries no semantics — it only preserves layout.
            <span className="subagent-overlay-back-spacer" aria-hidden />
          )}
          <div className="subagent-overlay-title">
            {stack.length > 1 && (
              <span className="subagent-overlay-breadcrumb">
                {stack.slice(0, -1).map((id) => {
                  const r = index.get(id)
                  return (r?.label ?? 'subagent') + ' › '
                })}
              </span>
            )}
            <span className="subagent-overlay-current-label">{current.label}</span>
            <span className={`subagent-overlay-status status-${current.status}`}>
              {statusText}
              {elapsedMs != null && ` · ${formatElapsed(elapsedMs)}`}
            </span>
          </div>
          <button
            type="button"
            className="subagent-overlay-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <IconX size={14} />
          </button>
        </div>
        <div className="subagent-overlay-body">
          <MessageList
            items={items}
            parentToolUseIdFilter={currentId}
            showSystemEvents={showSystemEvents}
            toolStatus={toolStatus}
            planStatus={planStatus}
            planContent={planContent}
            questionAnswers={questionAnswers}
            replayReady
          />
        </div>
      </div>
    </div>
  )
})
