import { useMemo } from 'react'
import type { ActiveSubagent } from '../session-store/types'
import { hasRicherCanonicalResult } from '../utils/task-result'
import { useSessionField } from '../session-store/selectors'
import { useTaskResult } from './useTaskResult'

/** Shared paged-result precedence for mirror-backed conversation hosts. */
export function useSubagentTaskResult(sessionId: string, current: ActiveSubagent | undefined, visible = true) {
  const tasks = useSessionField(sessionId, 'tasks')
  const currentTask = current?.taskId
    ? tasks.find((task) => task.taskId === current.taskId && task.toolUseId === current.toolUseId)
    : undefined
  const needsPagedResult = useMemo(
    () => currentTask?.resultRef?.projection === 'partial' && !hasRicherCanonicalResult(currentTask, current),
    [currentTask, current],
  )
  const resultState = useTaskResult({
    sessionId,
    taskId: currentTask?.taskId ?? '',
    runId: currentTask?.runId,
    updatedAt: currentTask?.updatedAt ?? 0,
    resultVersion: currentTask?.resultRef?.resultVersion,
    totalChars: currentTask?.resultRef?.totalChars ?? 0,
    enabled: Boolean(needsPagedResult && visible),
  })
  const displayCurrent = useMemo(() => needsPagedResult
    ? (() => {
        const content = current?.result?.content
        const supplemental = Array.isArray(content) ? content.filter((block) => block?.type !== 'text') : []
        return {
          ...current!,
          result: supplemental.length > 0 && current?.result
            ? {
                ...current.result,
                content: supplemental,
                isError: currentTask?.resultRef?.isError ?? current.result.isError,
              }
            : undefined,
          resultOrigin: supplemental.length > 0 ? current?.resultOrigin : undefined,
        }
      })()
    : current, [needsPagedResult, current, currentTask?.resultRef?.isError])
  return { currentTask, needsPagedResult, resultState, displayCurrent }
}
