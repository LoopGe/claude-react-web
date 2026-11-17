import { useCallback, useEffect, useRef, useState } from 'react'
import {
  TASK_RESULT_PAGE_MAX_CHARS,
  type TaskResultPage,
  type TaskResultUnavailable,
} from '../../shared/tasks'
import { api } from './useApi'

interface TaskResultQuery {
  sessionId: string
  taskId: string
  runId?: string
  updatedAt: number
  resultVersion?: number
  totalChars: number
  enabled: boolean
}

interface ResultRequestEntry {
  promise: Promise<TaskResultPage | TaskResultUnavailable>
  controller: AbortController
  consumers: Set<AbortController>
}

const resultRequests = new Map<string, ResultRequestEntry>()

function requestTaskResult(path: string, consumer: AbortController): Promise<TaskResultPage | TaskResultUnavailable> {
  let entry = resultRequests.get(path)
  if (!entry) {
    const controller = new AbortController()
    entry = {
      controller,
      consumers: new Set(),
      promise: api.get<TaskResultPage | TaskResultUnavailable>(path, { signal: controller.signal }),
    }
    resultRequests.set(path, entry)
    void entry.promise.then(
      () => { if (resultRequests.get(path) === entry) resultRequests.delete(path) },
      () => { if (resultRequests.get(path) === entry) resultRequests.delete(path) },
    )
  }
  entry.consumers.add(consumer)
  const release = () => {
    entry.consumers.delete(consumer)
    if (entry.consumers.size === 0) {
      entry.controller.abort()
      if (resultRequests.get(path) === entry) resultRequests.delete(path)
    }
  }
  if (consumer.signal.aborted) release()
  else consumer.signal.addEventListener('abort', release, { once: true })
  return entry.promise
}

/** Load one terminal-result page at a time. Pages are deliberately not
 *  accumulated: an expanded row never rebuilds a multi-megabyte roster body
 *  in renderer state. */
export function useTaskResult(query: TaskResultQuery) {
  const [page, setPage] = useState<TaskResultPage>()
  const [pageSessionId, setPageSessionId] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [errorState, setErrorState] = useState<{ key: string | number; message: string }>()
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const lastAttempt = useRef({ offset: 0, limit: TASK_RESULT_PAGE_MAX_CHARS })

  const resultIdentity = query.resultVersion ?? query.updatedAt
  const errorIdentity = `${query.sessionId}\0${query.taskId}\0${query.runId ?? ''}\0${resultIdentity}`

  const loadPage = useCallback(async (offset: number, limit = TASK_RESULT_PAGE_MAX_CHARS) => {
    lastAttempt.current = { offset, limit }
    const ticket = ++generation.current
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setLoading(true)
    setErrorState(undefined)
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (query.runId !== undefined) params.set('runId', query.runId)
    if (query.resultVersion !== undefined) params.set('resultVersion', String(query.resultVersion))
    try {
      const response = await requestTaskResult(
        `/sessions/${encodeURIComponent(query.sessionId)}/tasks/${encodeURIComponent(query.taskId)}/result?${params}`,
        abort,
      )
      if (ticket !== generation.current) return
      if (!response.available) {
        setPage(undefined)
        setErrorState({ key: errorIdentity, message: 'No result is available for this task.' })
        return
      }
      const responseIdentity = response.resultVersion ?? response.updatedAt
      if (response.runId !== query.runId || responseIdentity !== resultIdentity) {
        setPage(undefined)
        setErrorState({ key: errorIdentity, message: 'Result changed; reload the current task.' })
        return
      }
      setPageSessionId(query.sessionId)
      setPage(response)
    } catch (err) {
      if (ticket !== generation.current || abort.signal.aborted) return
      setErrorState({ key: errorIdentity, message: err instanceof Error ? err.message : String(err) })
    } finally {
      if (ticket === generation.current) setLoading(false)
    }
  }, [query.sessionId, query.taskId, query.runId, query.resultVersion, resultIdentity, errorIdentity])

  useEffect(() => {
    if (!query.enabled) {
      generation.current += 1
      controller.current?.abort()
      void Promise.resolve().then(() => setLoading(false))
      return
    }
    const cleanup = () => {
      generation.current += 1
      controller.current?.abort()
    }
    if (page && pageSessionId === query.sessionId && page.taskId === query.taskId && page.runId === query.runId &&
      (page.resultVersion ?? page.updatedAt) === resultIdentity) {
      return cleanup
    }
    const ticket = ++generation.current
    void Promise.resolve().then(() => {
      if (ticket === generation.current) {
        void loadPage(Math.max(0, query.totalChars - TASK_RESULT_PAGE_MAX_CHARS))
      }
    })
    return cleanup
  }, [query.enabled, query.totalChars, loadPage, page, pageSessionId, query.runId, query.taskId, query.sessionId, resultIdentity])

  const currentPage = query.enabled && pageSessionId === query.sessionId && page?.taskId === query.taskId && page.runId === query.runId &&
    (page.resultVersion !== undefined && query.resultVersion !== undefined
      ? page.resultVersion === query.resultVersion
      : page.updatedAt === query.updatedAt)
    ? page
    : undefined

  const loadPrevious = useCallback(() => {
    if (!currentPage || currentPage.offset === 0) return
    const offset = currentPage.previousOffset ?? Math.max(0, currentPage.offset - TASK_RESULT_PAGE_MAX_CHARS)
    void loadPage(offset, currentPage.offset - offset)
  }, [loadPage, currentPage])

  const loadNext = useCallback(() => {
    if (!currentPage?.hasMore) return
    void loadPage(currentPage.nextOffset)
  }, [loadPage, currentPage])

  const retry = useCallback(() => {
    void loadPage(lastAttempt.current.offset, lastAttempt.current.limit)
  }, [loadPage])

  const error = errorState?.key === errorIdentity ? errorState.message : undefined
  return { page: currentPage, loading: query.enabled && loading, error, loadPrevious, loadNext, retry }
}
