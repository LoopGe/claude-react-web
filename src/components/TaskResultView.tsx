import type { TaskRecordUi } from '../../shared/tasks'
import { useTaskResult } from '../hooks/useTaskResult'
import { TaskResultBlock } from './task-parts'

export type TaskResultState = ReturnType<typeof useTaskResult>

/** Shared terminal-result renderer. Full small results never issue a request;
 *  partial snapshots load only the currently visible page. */
export function TaskResultView({
  sessionId,
  task,
  enabled,
  state,
}: {
  sessionId: string
  task: TaskRecordUi
  enabled: boolean
  state?: TaskResultState
}) {
  const partial = task.resultRef?.projection === 'partial'
  const internal = useTaskResult({
    sessionId,
    taskId: task.taskId,
    runId: task.runId,
    updatedAt: task.updatedAt,
    resultVersion: task.resultRef?.resultVersion,
    totalChars: task.resultRef?.totalChars ?? 0,
    enabled: enabled && partial && state === undefined,
  })
  if (!partial) return <TaskResultBlock result={task.result ?? ''} />
  return <TaskResultPages task={task} state={state ?? internal} />
}

function TaskResultPages({ task, state }: { task: TaskRecordUi; state: TaskResultState }) {
  const { page, loading, error, loadPrevious, loadNext, retry } = state
  return (
    <span className="tasks-row-result-paged">
      <TaskResultBlock result={page?.result ?? task.result ?? ''} />
      {loading && <span className="hint">Loading result…</span>}
      {error && (
        <span className="hint">
          {error} <button type="button" className="btn" onClick={retry}>Retry</button>
        </span>
      )}
      {page && (
        <span className="tasks-row-result-pagination">
          <button type="button" className="btn" disabled={page.offset === 0 || loading} onClick={loadPrevious}>
            Previous
          </button>
          <span className="hint">{`${page.offset}–${page.nextOffset} / ${page.totalChars} characters`}</span>
          <button type="button" className="btn" disabled={!page.hasMore || loading} onClick={loadNext}>
            Next
          </button>
        </span>
      )}
    </span>
  )
}
