// Durable sidecar of a session's background-task records (`session.tasks`),
// one JSON array per session at <stateDir>/task-results/<sessionId>.json.
//
// Why a sidecar (same rationale as result-frame-store): `session.tasks` is
// in-memory and rebuilt empty on every session creation — nothing replays
// the history seed into it. Without this store a server restart wipes the
// TasksPanel, and (once the transcript filter lands) the completion output
// has no surviving surface at all.
//
// `session.tasks` is the runtime authority; this file is its durable
// mirror. Writes are full-replace snapshots of the Map (upsert-by-taskId is
// already applied by the caller), fire-and-forget on the task-event path.

import { join } from 'node:path'
import { PerSessionSidecar } from './per-session-sidecar.js'
import { MAX_TERMINAL_TASKS, isTerminalTaskStatus, type TaskRecordUi } from '../shared/tasks.js'

/** Keep every non-terminal record plus the newest `cap` terminals.
 *  Insertion order tracks start order, so terminal overflow evicts oldest. */
export function retainTerminalRecords(
  records: TaskRecordUi[],
  cap: number = MAX_TERMINAL_TASKS,
): TaskRecordUi[] {
  const terminals = records.filter((r) => isTerminalTaskStatus(r.status))
  const live = records.filter((r) => !isTerminalTaskStatus(r.status))
  return [...live, ...terminals.slice(-cap)]
}

export class TaskResultStore {
  private readonly sidecar: PerSessionSidecar<TaskRecordUi>

  constructor(stateDir: string | undefined) {
    this.sidecar = new PerSessionSidecar({
      dir: stateDir ? join(stateDir, 'task-results') : null,
      label: 'task-results',
    })
  }

  load(sessionId: string): Promise<TaskRecordUi[] | null> {
    return this.sidecar.load(sessionId)
  }

  /** Full-replace persist of the current `session.tasks` contents, capped.
   *  Fire-and-forget safe on the task-event path. */
  async save(sessionId: string, records: TaskRecordUi[]): Promise<void> {
    await this.sidecar.update(sessionId, () => retainTerminalRecords(records))
  }

  /** Delete the sidecar. Tombstones the id so a late save cannot recreate
   *  the file. */
  remove(sessionId: string): Promise<void> {
    return this.sidecar.remove(sessionId)
  }

  /** Clear the remove() tombstone for a new session reusing `sessionId`. */
  revive(sessionId: string): void {
    this.sidecar.revive(sessionId)
  }
}
