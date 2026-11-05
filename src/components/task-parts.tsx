// Presentational pieces shared by the Tasks panel and the task resource
// preview. Extracted so the resource body does not statically import the lazy
// TasksPanel chunk.

import {
  IconAlertCircle,
  IconBot,
  IconCheck,
  IconCircle,
  IconClock,
  IconListTodo,
  IconLoader,
  IconTerminal,
  IconWorkflow,
} from './icons/ToolIcons'
import type { TaskRecordUi } from '../types'

export function TaskStatusIcon({ status }: { status: TaskRecordUi['status'] }) {
  if (status === 'running' || status === 'pending') {
    return <IconLoader size={14} className="tasks-row-spin" aria-hidden />
  }
  if (status === 'completed') return <IconCheck size={14} className="tasks-icon-ok" aria-hidden />
  if (status === 'paused') return <IconClock size={14} className="tasks-icon-muted" aria-hidden />
  // `stopped` renders NEUTRAL: it means "ended, and no completion evidence was
  // found" — never an assertion of failure. Only failed/killed — where the CLI
  // DID report a failure — take the error styling.
  if (status === 'stopped') return <IconCircle size={14} className="tasks-icon-muted" aria-hidden />
  return <IconAlertCircle size={14} className="tasks-icon-err" aria-hidden />
}

/** Icon for a task's kind, matching the friendly vocabulary ('shell' /
 *  'subagent' / 'monitor' / 'workflow'). */
export function TaskTypeIcon({ task }: { task: TaskRecordUi }) {
  if (task.taskType === 'workflow') return <IconWorkflow size={13} aria-hidden />
  if (task.taskType === 'subagent' || task.subagentType) return <IconBot size={13} aria-hidden />
  if (task.taskType === 'shell') return <IconTerminal size={13} aria-hidden />
  return <IconListTodo size={13} aria-hidden />
}

/** On-demand body for a task's completion output. */
export function TaskResultBlock({ result }: { result: string }) {
  return (
    <span className="tasks-row-result">
      <pre className="tasks-row-result-body">{result}</pre>
    </span>
  )
}