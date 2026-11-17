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
import { TaskResultView, type TaskResultState } from '../components/TaskResultView'
import { useTaskResult } from '../hooks/useTaskResult'
import { canonicalResultText, hasRicherCanonicalResult as hasRicherResult } from '../utils/task-result'
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
  const subagentIndex = useSessionField(sessionId, 'subagentIndex')
  const ready = useSessionField(sessionId, 'replayReady')
  const openResource = useOptionalOpenResource()
  const record = tasks.find((task) => task.taskId === taskId)
  const indexed = Array.from(subagentIndex.values()).find((candidate) =>
    candidate.taskId === taskId && candidate.toolUseId === record?.toolUseId,
  )
  const indexedText = useMemo(
    () => canonicalResultText(indexed?.result?.content),
    [indexed?.result],
  )
  const hasRicherCanonicalResult = hasRicherResult(record, indexed)
  const resultState = useTaskResult({
    sessionId,
    taskId,
    runId: record?.runId,
    updatedAt: record?.updatedAt ?? 0,
    resultVersion: record?.resultRef?.resultVersion,
    totalChars: record?.resultRef?.totalChars ?? 0,
    enabled: record?.resultRef?.projection === 'partial' && !hasRicherCanonicalResult,
  })

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
  const displayResult = hasRicherCanonicalResult
    ? indexedText
    : resultState.page?.result ?? record.result

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
          {hasDetails(record, displayResult) && <TaskDetails sessionId={sessionId} record={record} resultState={resultState} resultOverride={hasRicherCanonicalResult ? indexedText : undefined} compact />}
          <SubagentTranscriptBody
            sessionId={sessionId}
            agentId={record.taskId}
            resultState={resultState}
            resultPreview={displayResult}
            suppressResult={Boolean(displayResult || record.resultRef?.totalChars || record.result)}
            variant="fill"
            cwd={cwd}
          />
        </>
      ) : (
        <TaskDetails sessionId={sessionId} record={record} resultState={resultState} resultOverride={hasRicherCanonicalResult ? indexedText : undefined} showEmpty />
      )}
    </div>
  )
}

function hasDetails(record: TaskRecordUi, displayResult?: string): boolean {
  return Boolean(
    displayResult ||
    record.progressSummary ||
      record.lastToolName ||
      record.reason ||
      (record.resourceLinks && record.resourceLinks.length > 0) ||
      (record.resultRef?.totalChars ?? record.result?.length ?? 0) > 0,
  )
}

function TaskDetails({
  sessionId,
  record,
  resultState,
  resultOverride,
  compact = false,
  showEmpty = false,
}: {
  sessionId: string
  record: TaskRecordUi
  resultState: TaskResultState
  resultOverride?: string
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
      {resultOverride ? (
        <TaskResultBlock result={resultOverride} />
      ) : (record.resultRef?.totalChars ?? record.result?.length ?? 0) > 0 ? (
        <TaskResultView sessionId={sessionId} task={record} enabled state={resultState} />
      ) : showEmpty ? (
        <div className="hint">No output recorded yet.</div>
      ) : null}
    </div>
  )
}