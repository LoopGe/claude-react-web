// Per-session Tasks overlay — live view of every background task the
// session owns: backgrounded Bash commands, subagents (including
// skip_transcript "ambient" ones that never appear in the transcript),
// and workflows. Mirrors the GitPanel overlay pattern: mounted inside
// the Chat panel behind a `.tasks-overlay` backdrop whose click-outside
// / Escape handling is the shared <Overlay> component.
//
// Data source is the dedicated `tasks` WS channel — the server folds
// task_started / task_updated / task_progress / task_notification frames
// into TaskRecordUi state and pushes whole-array snapshots. The panel
// reads the mirrored list straight from the session store (useSessionField),
// so it re-renders only when the task list actually changes.
//
// Actions:
//   - Stop a running task (POST /sessions/:id/tasks/:taskId/stop) — the
//     SDK emits a terminal task_notification which flips the row via the
//     normal snapshot path; no optimistic state here.

import { memo, useCallback, useState } from 'react'
import { useSessionField, useSessionTaskCounts } from '../session-store/selectors'
import { api } from '../hooks/useApi'
import { useToast } from '../hooks/useToast'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useCountUp } from '../hooks/useCountUp'
import { ElapsedTimer } from './ElapsedTimer'
import { formatElapsed } from '../utils/format'
import type { TaskRecordUi } from '../types'
import { SubagentTranscriptDialog } from './SubagentTranscriptDialog'
import { IconX, IconCheck, IconAlertCircle, IconClock, IconLoader, IconTerminal, IconBot, IconListTodo, IconWorkflow, IconFileText } from './icons/ToolIcons'

/** Terminal statuses — shared/tasks.ts keeps the canonical list, but
 *  re-declaring the check locally avoids importing server-typed helpers
 *  into the bundle for one boolean. Keep in sync. */
function isTerminal(status: TaskRecordUi['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed' || status === 'stopped'
}

function StatusIcon({ status }: { status: TaskRecordUi['status'] }) {
  if (status === 'running' || status === 'pending') {
    return <IconLoader size={14} className="tasks-row-spin" aria-hidden />
  }
  if (status === 'completed') return <IconCheck size={14} className="tasks-icon-ok" aria-hidden />
  if (status === 'paused') return <IconClock size={14} className="tasks-icon-muted" aria-hidden />
  return <IconAlertCircle size={14} className="tasks-icon-err" aria-hidden />
}

/** Icon for a task's kind. Matches the FRIENDLY vocabulary ('shell' /
 *  'subagent' / 'monitor' / 'workflow'), which is the canonical one: the CLI's
 *  frames spell it `local_bash` / `local_agent` / `local_workflow` and every
 *  writer into `session.tasks` folds that on the way in (see normalizeTaskType
 *  in shared/tasks.ts). Add a mapping there, not a branch here, when a new
 *  discriminant appears. */
function TypeIcon({ task }: { task: TaskRecordUi }) {
  if (task.taskType === 'workflow') return <IconWorkflow size={13} aria-hidden />
  if (task.taskType === 'subagent' || task.subagentType) return <IconBot size={13} aria-hidden />
  if (task.taskType === 'shell') return <IconTerminal size={13} aria-hidden />
  return <IconListTodo size={13} aria-hidden />
}

/** Elapsed span for one task row. A row with no `endedAt` is still running and
 *  ticks; a terminal row freezes at its recorded delta. The shared
 *  <ElapsedTimer> owns the isolation (only its own text node re-renders). */
const RowTimer = memo(function RowTimer({ startedAt, endedAt }: { startedAt?: number; endedAt?: number }) {
  return (
    <ElapsedTimer
      startedAt={startedAt}
      endedAt={endedAt}
      live={endedAt == null}
      className="tasks-row-timer"
    />
  )
})

export const TasksPanel = memo(function TasksPanel({
  sessionId,
  onClose,
}: {
  sessionId: string
  onClose: () => void
}) {
  const tasks = useSessionField(sessionId, 'tasks')
  const setPanelOs = useOverlayScrollbar({ autoHide: 'leave' })
  const toast = useToast()
  const [stopping, setStopping] = useState<Set<string>>(new Set())
  const [transcript, setTranscript] = useState<{ agentId: string; label: string } | null>(null)

  // A terminal SUBAGENT task's taskId is the Agent's agentId (the watcher /
  // task_started seed it from the SDK), which keys the on-disk
  // subagents/agent-<id>.jsonl transcript. Only those rows offer the
  // disk-transcript viewer — shell tasks and ambient housekeeping have none.
  const openTranscript = useCallback(
    (task: TaskRecordUi) => setTranscript({ agentId: task.taskId, label: task.description || task.taskId }),
    [],
  )

  const stopTask = useCallback(
    async (taskId: string) => {
      setStopping((prev) => new Set(prev).add(taskId))
      try {
        await api.post(`/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/stop`, {})
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(`Stop task: ${msg}`)
        setStopping((prev) => {
          const next = new Set(prev)
          next.delete(taskId)
          return next
        })
      }
      // On success the terminal task_notification flips the row via the
      // tasks-snapshot path; leave the stop button disabled (spinner)
      // until then. A wedged notification is recovered by closing the panel.
    },
    [sessionId, toast],
  )

  const active = tasks.filter((t) => !isTerminal(t.status))
  const finished = tasks.filter((t) => isTerminal(t.status))
  // The header count comes from the SHARED indicator selector, not from
  // `active.length`: the panel lists ambient housekeeping (the SDK says it may
  // appear in a tasks panel) but must not COUNT it, because the WorkingBubble
  // pill reads the same selector and the two numbers have to agree. The
  // ambient remainder is surfaced separately instead of being folded in.
  const { indicator: indicatorCount } = useSessionTaskCounts(sessionId)
  const ambientActive = active.length - indicatorCount
  const animatedActive = Math.round(useCountUp(indicatorCount, 300))

  return (
    <aside className="tasks-panel" role="region" aria-label="Tasks" ref={setPanelOs}>
      <header className="tasks-panel-header">
        <span className="tasks-panel-title">Tasks</span>
        <span className="tasks-panel-count">
          {animatedActive > 0 ? `${animatedActive} running` : 'idle'}
          {ambientActive > 0 && (
            <span
              className="tasks-panel-count-ambient"
              title="Housekeeping tasks the CLI runs itself — listed here, excluded from activity counts"
            >
              {` +${ambientActive} ambient`}
            </span>
          )}
        </span>
        <span className="tasks-panel-spacer" />
        <button className="tasks-panel-icon-btn" onClick={onClose} aria-label="Close">
          <IconX size={14} />
        </button>
      </header>
      <div className="tasks-panel-body">
        {tasks.length === 0 && (
          <div className="tasks-panel-empty">
            No tasks yet. Background commands and subagents the model launches appear here.
          </div>
        )}
        {active.length > 0 && (
          <section className="tasks-panel-section">
            {active.map((t) => (
              <TaskRow key={t.taskId} task={t} stopping={stopping.has(t.taskId)} onStop={stopTask} onViewTranscript={openTranscript} />
            ))}
          </section>
        )}
        {finished.length > 0 && (
          <section className="tasks-panel-section">
            <div className="tasks-panel-section-title">Finished</div>
            {finished.map((t) => (
              <TaskRow key={t.taskId} task={t} stopping={false} onStop={stopTask} onViewTranscript={openTranscript} />
            ))}
          </section>
        )}
      </div>
      {transcript && (
        <SubagentTranscriptDialog
          sessionId={sessionId}
          agentId={transcript.agentId}
          label={transcript.label}
          onClose={() => setTranscript(null)}
        />
      )}
    </aside>
  )
})

const TaskRow = memo(function TaskRow({
  task,
  stopping,
  onStop,
  onViewTranscript,
}: {
  task: TaskRecordUi
  stopping: boolean
  onStop: (taskId: string) => void
  onViewTranscript?: (task: TaskRecordUi) => void
}) {
  const terminal = isTerminal(task.status)
  // Only finished subagent rows can open the disk-transcript viewer: their
  // taskId is the Agent's agentId that keys subagents/agent-<id>.jsonl.
  const canViewTranscript = terminal && (task.taskType === 'subagent' || Boolean(task.subagentType))
  return (
    <div className={`tasks-row${terminal ? ' tasks-row-terminal' : ''}${task.status === 'failed' || task.status === 'killed' ? ' tasks-row-error' : ''}`}>
      <span className="tasks-row-icon">
        <StatusIcon status={task.status} />
      </span>
      <span className="tasks-row-type" title={task.subagentType ?? task.workflowName ?? task.taskType}>
        <TypeIcon task={task} />
      </span>
      <span className="tasks-row-main">
        <span className="tasks-row-desc" title={task.description}>
          {task.description || task.taskId}
        </span>
        {(task.subagentType || task.workflowName || task.taskType) && (
          <span className="tasks-row-meta">
            {[task.subagentType ?? task.workflowName ?? task.taskType, task.isBackgrounded ? 'background' : null, task.skipTranscript || task.ambient ? 'ambient' : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        {task.progressSummary && <span className="tasks-row-summary">{task.progressSummary}</span>}
      </span>
      {!terminal && (
        <span className="tasks-row-timer-wrap">
          <RowTimer startedAt={task.startedAt} />
        </span>
      )}
      {terminal && task.endedAt != null && task.startedAt != null && (
        <span className="tasks-row-timer tasks-row-timer-final">
          {formatElapsed(Math.max(0, task.endedAt - task.startedAt))}
        </span>
      )}
      {canViewTranscript && onViewTranscript && (
        <button
          type="button"
          className="tasks-row-view"
          title={`View on-disk transcript: ${task.description || task.taskId}`}
          aria-label="View subagent transcript"
          onClick={() => onViewTranscript(task)}
        >
          <IconFileText size={12} />
        </button>
      )}
      {!terminal && (
        <button
          type="button"
          className="tasks-row-stop"
          disabled={stopping}
          title={`Stop ${task.description || task.taskId}`}
          onClick={() => onStop(task.taskId)}
        >
          {stopping ? <IconLoader size={12} className="tasks-row-spin" /> : <IconX size={12} />}
        </button>
      )}
    </div>
  )
})
