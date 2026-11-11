// Body for a `task` resource (Phase 3): the TaskRecordUi lifecycle record.
// Mirror-backed — no registry provider; the record is read from the session
// store's tasks snapshot. Subagent tasks render the shared disk-transcript
// body (plus their result/progress details); every other task renders
// metadata + completion output.

import { useMemo } from 'react'
import { parseTaskResource, subagentResource } from '../../shared/resource-address'
import { isSubagentTask } from '../../shared/tasks'
import { useSessionField } from '../session-store/selectors'
import type { TaskRecordUi } from '../types'
import { isSafeUrl } from '../components/tool-views/shared'
import { ElapsedTimer } from '../components/ElapsedTimer'
import { SubagentTranscriptBody } from '../components/SubagentTranscriptBody'
import { TaskResultBlock, TaskStatusIcon, TaskTypeIcon } from '../components/task-parts'
import { useOptionalOpenResource } from './context'

export function ResourceTaskBody({
  address,
  cwd,
}: {
  address: string
  /** Session working directory — relative paths in a subagent transcript
   *  resolve against it. */
  cwd?: string
}) {
  const parsed = useMemo(() => parseTaskResource(address), [address])
  if (!parsed) return <div className="hint">Nothing can open this address.</div>
  return <TaskBody sessionId={parsed.sessionId} taskId={parsed.taskId} cwd={cwd} />
}

function TaskBody({
  sessionId,
  taskId,
  cwd,
}: {
  sessionId: string
  taskId: string
  cwd?: string
}) {
  const tasks = useSessionField(sessionId, 'tasks')
  const ready = useSessionField(sessionId, 'replayReady')
  const openResource = useOptionalOpenResource()
  const record = tasks.find((task) => task.taskId === taskId)

  if (!record) {
    return (
      <div className="hint">
        {ready
          ? 'Task not found — finished tasks are capped at 50 and may have been evicted.'
          : 'Loading task…'}
      </div>
    )
  }

  const isSubagent = isSubagentTask(record)

  return (
    <div className="resource-task-body">
      <header className="resource-task-header">
        <span className="resource-task-status">
          <TaskStatusIcon status={record.status} />
        </span>
        <span className="resource-task-title" title={record.taskId}>
          {record.description || record.taskId}
        </span>
        <span className="resource-task-kind">
          <TaskTypeIcon task={record} /> {record.taskType ?? 'task'}
        </span>
        {record.isBackgrounded && <span className="resource-task-badge">background</span>}
        {record.startedAt != null && (
          <span className="resource-task-elapsed">
            <ElapsedTimer
              startedAt={record.startedAt}
              endedAt={record.endedAt}
              live={record.endedAt == null}
            />
          </span>
        )}
        <span className="resource-task-spacer" />
        {isSubagent && record.toolUseId && openResource && (
          <button
            type="button"
            className="btn"
            onClick={() => openResource(sessionId, subagentResource(sessionId, record.toolUseId!))}
          >
            Open agent
          </button>
        )}
      </header>
      {isSubagent ? (
        <>
          {hasDetails(record) && <TaskDetails record={record} compact />}
          <SubagentTranscriptBody
            sessionId={sessionId}
            agentId={record.taskId}
            suppressResult={Boolean(record.result)}
            variant="fill"
            cwd={cwd}
          />
        </>
      ) : (
        <TaskDetails record={record} showEmpty />
      )}
    </div>
  )
}

function hasDetails(record: TaskRecordUi): boolean {
  return Boolean(
    record.progressSummary ||
      record.lastToolName ||
      record.reason ||
      (record.resourceLinks && record.resourceLinks.length > 0) ||
      record.result,
  )
}

function TaskDetails({
  record,
  compact = false,
  showEmpty = false,
}: {
  record: TaskRecordUi
  compact?: boolean
  showEmpty?: boolean
}) {
  return (
    <div
      className={`resource-task-details${compact ? ' resource-task-details-compact' : ''}`}
    >
      {record.progressSummary && (
        <div className="resource-task-progress">{record.progressSummary}</div>
      )}
      {record.lastToolName && <div className="hint">Last tool: {record.lastToolName}</div>}
      {record.reason && <div className="hint">Reason: {record.reason}</div>}
      {record.resourceLinks && record.resourceLinks.length > 0 && (
        <ul className="resource-task-links">
          {record.resourceLinks.map((link) => (
            <li key={link.uri}>
              {/* Untrusted tool/MCP data: never turn an unsafe scheme into a
                  live navigation target. */}
              {isSafeUrl(link.uri) ? (
                <a href={link.uri} target="_blank" rel="noreferrer noopener">
                  {link.title ?? link.name}
                </a>
              ) : (
                <span>{link.title ?? link.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {record.result ? (
        <TaskResultBlock result={record.result} />
      ) : showEmpty ? (
        <div className="hint">No output recorded yet.</div>
      ) : null}
    </div>
  )
}