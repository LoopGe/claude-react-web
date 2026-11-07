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
import { HoverHint } from './HoverHint'
import { formatElapsed } from '../utils/format'
import type { TaskRecordUi } from '../types'
import { isSubagentTask, isTerminalTaskStatus } from '../../shared/tasks.js'
import type { StreamingRenderMode } from '../../shared/streaming-render-mode.js'
import { SubagentTranscriptDialog } from './SubagentTranscriptDialog'
import { IconEye, IconFileText, IconLoader, IconX } from './icons/ToolIcons'
import { taskResource } from '../../shared/resource-address'
import { useOptionalOpenResource } from '../resources/context'
import { TaskResultBlock, TaskStatusIcon, TaskTypeIcon } from './task-parts'
import { formatError } from '../utils/format-error'

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

/** On-demand body for a task's completion output. Mounted only while the
 *  row's expand toggle is open — a background command can emit megabytes
 *  of stdout, and tasks-snapshot re-renders this row often. The toggle
 *  itself lives in the row-end control cluster beside .tasks-row-view
 *  (spec §3.8: the two are the row's "see more" affordances), so the
 *  expand state rides TaskRow and gates this block. */

export const TasksPanel = memo(function TasksPanel({
  sessionId,
  streamingMode,
  cwd,
  onClose,
}: {
  sessionId: string
  /** Global streaming-preview mode, forwarded to the disk-transcript dialog
   *  so it follows the same setting as the main transcript. */
  streamingMode?: StreamingRenderMode
  /** Session working directory — forwarded to the transcript dialog so its
   *  tool rows can resolve relative paths. */
  cwd?: string
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
        const msg = formatError(err)
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

  const active = tasks.filter((t) => !isTerminalTaskStatus(t.status))
  const finished = tasks.filter((t) => isTerminalTaskStatus(t.status))
  // The header count comes from the SHARED indicator selector, not from
  // `active.length`: the panel lists ambient housekeeping (the SDK says it may
  // appear in a tasks panel) but must not COUNT it, because the WorkingBubble
  // pill reads the same selector and the two numbers have to agree. The
  // ambient remainder is surfaced separately instead of being folded in.
  const { indicator: indicatorCount } = useSessionTaskCounts(sessionId)
  const ambientActive = active.length - indicatorCount
  const animatedActive = Math.round(useCountUp(indicatorCount, 300))

  return (
    <aside className="tasks-panel" role="region" aria-label="Tasks">
      <header className="tasks-panel-header">
        <span className="tasks-panel-title">Tasks</span>
        <span className="tasks-panel-count">
          {animatedActive > 0 ? `${animatedActive} running` : 'idle'}
          {ambientActive > 0 && (
            <HoverHint
              label="Housekeeping tasks the CLI runs itself — listed here, excluded from activity counts"
              side="top"
            >
              <span className="tasks-panel-count-ambient">
                {` +${ambientActive} ambient`}
              </span>
            </HoverHint>
          )}
        </span>
        <span className="tasks-panel-spacer" />
        <button className="tasks-panel-icon-btn" onClick={onClose} aria-label="Close">
          <IconX size={14} />
        </button>
      </header>
      {/* Scroll region is a CHILD of the card, mirroring GitPanel. The overlay
          scrollbar attaches its track to the scroller's PARENT, so a scroller
          that IS the card (even when the card is centered inside a much wider
          overlay backdrop) would leave the track pinned to the backdrop's
          right edge. Nesting it makes the parent the card, whose right edge is
          where the thumb belongs. */}
      <div className="tasks-panel-scroll" ref={setPanelOs}>
        <div className="tasks-panel-body">
          {tasks.length === 0 && (
            <div className="tasks-panel-empty">
              No tasks yet. Background commands and subagents the model launches appear here.
            </div>
          )}
          {active.length > 0 && (
            <section className="tasks-panel-section">
              {active.map((t) => (
                <TaskRow key={t.taskId} sessionId={sessionId} task={t} stopping={stopping.has(t.taskId)} onStop={stopTask} onViewTranscript={openTranscript} />
              ))}
            </section>
          )}
          {finished.length > 0 && (
            <section className="tasks-panel-section">
              <div className="tasks-panel-section-title">Finished</div>
              {finished.map((t) => (
                <TaskRow key={t.taskId} sessionId={sessionId} task={t} stopping={false} onStop={stopTask} onViewTranscript={openTranscript} />
              ))}
            </section>
          )}
        </div>
      </div>
      {transcript && (
        <SubagentTranscriptDialog
          sessionId={sessionId}
          agentId={transcript.agentId}
          label={transcript.label}
          streamingMode={streamingMode}
          cwd={cwd}
          onClose={() => setTranscript(null)}
        />
      )}
    </aside>
  )
})

const TaskRow = memo(function TaskRow({
  sessionId,
  task,
  stopping,
  onStop,
  onViewTranscript,
}: {
  sessionId: string
  task: TaskRecordUi
  stopping: boolean
  onStop: (taskId: string) => void
  onViewTranscript?: (task: TaskRecordUi) => void
}) {
  const openResource = useOptionalOpenResource()
  const terminal = isTerminalTaskStatus(task.status)
  // Only finished subagent rows can open the disk-transcript viewer: their
  // taskId is the Agent's agentId that keys subagents/agent-<id>.jsonl.
  const canViewTranscript = terminal && isSubagentTask(task)
  // Spec §3.8 gate, unchanged: the expand affordance (and its body) exists
  // only for a terminal task whose `result` is non-empty.
  const resultBody = terminal && task.result != null && task.result !== '' ? task.result : null
  // Expand state rides the row because the toggle lives in the row-end
  // control cluster while the body nests under the row content.
  const [resultOpen, setResultOpen] = useState(false)
  return (
    <div className={`tasks-row${terminal ? ' tasks-row-terminal' : ''}`}>
      <span className="tasks-row-icon">
        <TaskStatusIcon status={task.status} />
      </span>
      <HoverHint
        label={task.subagentType ?? task.workflowName ?? task.taskType}
        side="top"
        disabled={!(task.subagentType ?? task.workflowName ?? task.taskType)}
      >
        <span className="tasks-row-type">
          <TaskTypeIcon task={task} />
        </span>
      </HoverHint>
      <span className="tasks-row-main">
        <HoverHint label={task.description} side="top" disabled={!task.description}>
          <span className="tasks-row-desc">
            {task.description || task.taskId}
          </span>
        </HoverHint>
        {(task.subagentType || task.workflowName || task.taskType) && (
          <span className="tasks-row-meta">
            {[task.subagentType ?? task.workflowName ?? task.taskType, task.isBackgrounded ? 'background' : null, task.skipTranscript || task.ambient ? 'ambient' : null, task.reason === 'worker_restart' ? 'worker restarted' : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        {task.progressSummary && <span className="tasks-row-summary">{task.progressSummary}</span>}
        {task.resourceLinks && task.resourceLinks.length > 0 && (
          <HoverHint
            label={(
              <div className="hover-pop-stack">
                {task.resourceLinks.map((r) => <div key={r.uri}>{r.uri}</div>)}
              </div>
            )}
            side="top"
          >
            <span className="tasks-row-summary">
              {task.resourceLinks.map((r) => r.title ?? r.name).join(', ')}
            </span>
          </HoverHint>
        )}
        {resultBody !== null && resultOpen && <TaskResultBlock result={resultBody} />}
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
      {openResource && (
        <HoverHint label={`Open preview: ${task.description || task.taskId}`} side="top">
          <button
            type="button"
            className="tasks-row-open"
            aria-label="Open task preview"
            onClick={() => openResource(sessionId, taskResource(sessionId, task.taskId))}
          >
            <IconEye size={12} />
          </button>
        </HoverHint>
      )}
      {canViewTranscript && onViewTranscript && (
        <HoverHint label={`View on-disk transcript: ${task.description || task.taskId}`} side="top">
          <button
            type="button"
            className="tasks-row-view"
            aria-label="View subagent transcript"
            onClick={() => onViewTranscript(task)}
          >
            <IconFileText size={12} />
          </button>
        </HoverHint>
      )}
      {resultBody !== null && (
        <button
          type="button"
          className="tasks-row-result-toggle"
          aria-label={resultOpen ? 'Hide output' : 'Show output'}
          onClick={() => setResultOpen((v) => !v)}
        >
          {resultOpen ? 'Hide output' : 'Show output'}
        </button>
      )}
      {!terminal && (
        <HoverHint label={`Stop ${task.description || task.taskId}`} side="top">
          <button
            type="button"
            className="tasks-row-stop"
            disabled={stopping}
            onClick={() => onStop(task.taskId)}
          >
            {stopping ? <IconLoader size={12} className="tasks-row-spin" /> : <IconX size={12} />}
          </button>
        </HoverHint>
      )}
    </div>
  )
})
