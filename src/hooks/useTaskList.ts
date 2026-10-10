// Tasklist-snapshot sink — the client half of the server-derived TaskCreate/
// TaskUpdate fold. Mirrors useGitStatus: fetch once on mount for ground
// truth, then apply `tasklist-snapshot` WS frames directly (zero refetch).
// Consumers merge the payload UNDER their window fold via
// shared/task-list.ts#mergeTaskList; a null result (fetch failed / no
// session) degrades to today's window-only behavior.

import { useEffect, useState } from 'react'
import { api } from './useApi'
import { useWsHub } from './useWsHub'
import type { TasklistSnapshotPayload } from '../../shared/task-list'

export function useTaskList(sessionId: string | undefined): TasklistSnapshotPayload | null {
  const hub = useWsHub()
  const [data, setData] = useState<TasklistSnapshotPayload | null>(null)

  useEffect(() => {
    if (!sessionId) return
    const ctrl = new AbortController()
    api
      .get<TasklistSnapshotPayload>(`/sessions/${sessionId}/tasklist`, { signal: ctrl.signal })
      .then((res) => { if (!ctrl.signal.aborted) setData(res) })
      .catch(() => { /* degrade to window-only fold; the WS channel may still deliver */ })
    return () => ctrl.abort()
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    const offSub = hub.subscribe(sessionId)
    const offListener = hub.addSessionListener(sessionId, (frame) => {
      if (frame.kind !== 'tasklist-snapshot') return
      const f = frame as { kind: 'tasklist-snapshot'; rev: number; tasks: TasklistSnapshotPayload['tasks'] }
      setData((prev) => {
        if (prev && f.rev < prev.rev) return prev // stale frame — drop
        return { rev: f.rev, tasks: f.tasks }
      })
    })
    return () => { offSub(); offListener() }
  }, [sessionId, hub])

  return data
}
