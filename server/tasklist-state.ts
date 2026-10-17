// Server-side derivation of the TaskCreate/TaskUpdate checklist state from
// the FULL transcript (the durable CLI JSONL via jsonl-cache). The client
// folds only its in-memory window, so creates beyond the ring/memory cap
// degrade to `Task #N` stubs — this module is the authoritative base layer
// the client merges under its window fold (shared/task-list.ts#mergeTaskList).
//
// No new persistence: the transcript IS the persistence. Every call re-folds
// the cached parsed lines (O(lines) over already-parsed JS objects — ms at
// multi-thousand-line scale), so state is always a pure function of the
// transcript: no write path, no crash-recovery divergence.

import { performance } from 'node:perf_hooks'
import { jsonlPageCache } from './jsonl-cache.js'
import { metrics } from './metrics.js'
import { createLogger } from './log.js'
import {
  buildTaskStateMap,
  countTaskEvents,
  isGenuineUserInputFrame,
  type TasklistSnapshotPayload,
  type TasklistSnapshotTask,
} from '../shared/task-list.js'

const log = createLogger('tasklist')

/** Pure fold over transcript lines. `boundary` is the line index of the
 *  last genuine human input; a resolved task last touched strictly before
 *  it is flagged stale (the "user has moved on" cleanup, computed with
 *  full-transcript coordinates the client window cannot see). */
export function deriveTaskListFromLines(lines: readonly unknown[]): TasklistSnapshotPayload {
  let boundary = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isGenuineUserInputFrame(lines[i] as Parameters<typeof isGenuineUserInputFrame>[0])) {
      boundary = i
      break
    }
  }
  const tasks = buildTaskStateMap(lines)
  const rev = countTaskEvents(lines)
  if (!tasks) return { rev: 0, tasks: [] }
  const out: TasklistSnapshotTask[] = []
  for (const t of tasks.values()) {
    // In-flight creates (result not yet on disk) never enter the snapshot —
    // the client's window fold owns them via its pending:<toolUseId> key.
    if (t.provisional) continue
    const resolved = t.status === 'completed' || t.status === 'cancelled'
    out.push({
      id: t.id,
      subject: t.subject,
      ...(t.description !== undefined ? { description: t.description } : {}),
      status: t.status,
      ...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
      stale: resolved && t.lastTouched < boundary,
    })
  }
  return { rev, tasks: out }
}

/** Derive the snapshot for one session. [] payload on any failure — the
 *  client degrades to its window fold (today's behavior). */
export async function deriveTaskListForSession(sessionId: string): Promise<TasklistSnapshotPayload> {
  const t0 = performance.now()
  let payload: TasklistSnapshotPayload
  try {
    payload = deriveTaskListFromLines(await jsonlPageCache.readAll(sessionId))
  } catch (err) {
    log.warn(`[${sessionId}] tasklist derive failed: ${err instanceof Error ? err.message : String(err)}`)
    return { rev: 0, tasks: [] }
  }
  metrics.observe('tasklist_derive_ms', performance.now() - t0)
  return payload
}
