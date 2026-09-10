// Background tasks — canonical shared shape for the SDK's background-task
// surface (`task_started` / `task_updated` / `task_progress` /
// `task_notification` system frames, `Query.backgroundTasks()` /
// `Query.stopTask()` control requests).
//
// Mirrors shared/user-dialog.ts in style: browser-safe (no Node or SDK
// imports) so the server (pump state cache, WS snapshot frames) and the
// client (TasksPanel, subagent chips) instantiate these directly.
//
// The SDK exposes NO task-list query API — the only way to know which tasks
// are running is to fold the event stream. The server keeps a per-session
// Map of these records (updated by applyTaskEvent in session-pump.ts) and
// pushes full snapshots over the dedicated `tasks` WS channel; a tab that
// subscribes late gets the current snapshot without replay.

/** Lifecycle of a task, folded from task_started / task_updated /
 *  task_notification frames. `pending`/`running`/`paused` come from
 *  task_updated patches; `completed`/`failed`/`stopped` from
 *  task_notification; `killed` from task_updated. */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'stopped'
  | 'paused'

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'completed',
  'failed',
  'killed',
  'stopped',
]

export function isTerminalTaskStatus(status: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status)
}

/** The CLI names a task's kind twice, differently: the `task_*` frames and
 *  `background_tasks_changed` carry the internal discriminant (`local_bash`,
 *  `local_agent`, `local_workflow`), while `BackgroundTaskSummary.type` (the
 *  Stop-hook payload) carries the friendly label (`shell`, `subagent`,
 *  `monitor`, `workflow`). The UI is written against the friendly label —
 *  TasksPanel's TypeIcon matches 'shell' / 'subagent' / 'workflow' — so a
 *  record created from a frame used to fall through to the generic icon while
 *  an otherwise identical record created by the watcher seed (which writes
 *  'subagent') got the right one. Same task, different meta text, depending on
 *  which writer happened to create it first.
 *
 *  This is the single place that fold: every writer into `session.tasks` runs
 *  `task_type` through it, so `TaskRecordUi.taskType` is always the friendly
 *  vocabulary. Unknown values pass through unchanged, mirroring the SDK's own
 *  documented behaviour for `BackgroundTaskSummary.type` ("falls back to the
 *  raw discriminant for unknown types") — add a mapping here when a new
 *  discriminant shows up rather than teaching the UI a second vocabulary. */
const TASK_TYPE_ALIASES: Record<string, string> = {
  local_bash: 'shell',
  local_agent: 'subagent',
  local_workflow: 'workflow',
}

export function normalizeTaskType(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  return TASK_TYPE_ALIASES[raw] ?? raw
}

/** A task as tracked by the server and rendered by the client (TasksPanel,
 *  subagent chip enrichment). All optional fields are read defensively from
 *  the SDK frames — the wire shape can evolve without a protocol bump. */
export interface TaskRecordUi {
  taskId: string
  /** The originating tool_use when the task backs a tool call (Agent / Bash /
   *  Monitor). Joins the record to the client's activeSubagents map. */
  toolUseId?: string
  description: string
  subagentType?: string
  /** 'shell' | 'subagent' | 'monitor' | 'workflow' — the friendly label, always
   *  normalized on write (see normalizeTaskType) even though the `task_*`
   *  frames spell it `local_bash` / `local_agent` / `local_workflow`. An
   *  unrecognised discriminant passes through as-is. */
  taskType?: string
  workflowName?: string
  status: TaskStatus
  /** Set when the task was backgrounded mid-flight (Ctrl+B semantics). */
  isBackgrounded?: boolean
  /** Ambient/housekeeping tasks the SDK flags as not belonging in the inline
   *  transcript — rendered ONLY in the TasksPanel. */
  skipTranscript?: boolean
  /** SDK 0.3.247 housekeeping flag — a SUPERSET of skipTranscript: every
   *  skip_transcript task plus auto-started live-update watchers the CLI runs
   *  internally. Must be excluded from activity indicators (the WorkingBubble
   *  Waiting count) but still listed in the TasksPanel. */
  ambient?: boolean
  /** Present-tense progress summary (task_progress.summary — the output of
   *  the SDK's agentProgressSummaries option). Refreshed ~every 30s. */
  progressSummary?: string
  /** Last tool the task's agent invoked (task_progress.last_tool_name). */
  lastToolName?: string
  /** Server receive time of the task_started frame (stampReceivedAt). */
  startedAt?: number
  endedAt?: number
  updatedAt: number
}
