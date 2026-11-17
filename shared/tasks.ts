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

/** Cap on terminal (completed/failed/killed/stopped) task records kept in
 *  `session.tasks` and its sidecar. Terminal records linger so the
 *  TasksPanel can show recent completions; oldest are evicted beyond this. */
export const MAX_TERMINAL_TASKS = 50

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

/** Whether a task is an Agent/subagent conversation. Single owner of the
 *  predicate shared by the Tasks panel's transcript button and the resource
 *  preview's body choice. */
export function isSubagentTask(
  task: Pick<TaskRecordUi, 'taskType' | 'subagentType'>,
): boolean {
  return task.taskType === 'subagent' || Boolean(task.subagentType)
}

/** A file a backgrounded MCP task returned by reference (SDK
 *  `SDKMcpResourceLink`), flattened to the fields the UI renders. */
export interface TaskResourceLink {
  uri: string
  name: string
  title?: string
  mimeType?: string
}

export interface TaskResultRef {
  totalChars: number
  /** True only for non-whitespace output, matching stopped-with-output lifecycle semantics. */
  hasResult: boolean
  isError: boolean
  projection: 'full' | 'partial'
  /** Content generation, stable across Date.now()-equal replacements. */
  resultVersion: number
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
  /** Machine-readable stop cause (SDK 0.3.273 `task_notification.reason`),
   *  set only when the task did not end through an ordinary completion /
   *  failure / stop. Currently only 'worker_restart'. */
  reason?: 'worker_restart'
  /** The completion's output body. Sources: harness `<task-notification>`
   *  `<result>`, native inline results, a foreground shell's tool_result, or
   *  a background task's output_file (read by the pump before the task fold). */
  result?: string
  /** Wire-only result identity and bounded-preview metadata. Canonical live
   *  records and the sidecar keep the full string without this field. */
  resultRef?: TaskResultRef
  /** Files a backgrounded MCP task returned by reference (SDK 0.3.257
   *  `task_notification.resource_links`). */
  resourceLinks?: TaskResourceLink[]
  /** Id of the run the record currently reflects (SDK 0.3.295 `run_id`):
   *  equal on every task_* event / background_tasks_changed entry of that
   *  run; a resumed task keeps its task_id and opens a new run. Run ids of
   *  one task sort, by plain string comparison, in the order the runs
   *  opened — applyTaskEvent drops frames naming a run that sorts BEFORE the
   *  record's runId (late events from a superseded run). Absent on records
   *  written from frames without the field (older CLIs, the watcher's
   *  synthesized notifications). */
  runId?: string
  /** Server receive time of the task_started frame (stampReceivedAt). */
  startedAt?: number
  endedAt?: number
  updatedAt: number
}

export const TASK_RESULT_INLINE_CHARS = 16 * 1024
export const TASK_SNAPSHOT_RESULT_BUDGET_CHARS = 128 * 1024
export const TASK_SNAPSHOT_MAX_CHARS = 256 * 1024
export const TASK_RESULT_PAGE_MAX_CHARS = 128 * 1024

export interface TaskResultPage {
  available: true
  taskId: string
  runId?: string
  updatedAt: number
  resultVersion?: number
  offset: number
  totalChars: number
  result: string
  nextOffset: number
  previousOffset: number
  hasMore: boolean
}

export interface TaskResultUnavailable {
  available: false
  taskId: string
  runId?: string
  updatedAt: number
  resultVersion?: number
}

/** Non-cryptographic content generation used only to detect same-tick result
 *  replacement; it is not an integrity or security digest. */
export function taskResultVersion(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2_654_435_761)
    h2 = Math.imul(h2 ^ code, 1_597_334_677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_519)
  h1 = Math.imul(h1 ^ (h1 >>> 13), 3_266_489_917)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_519)
  h2 = Math.imul(h2 ^ (h2 >>> 13), 3_266_489_917)
  return (h1 >>> 0) * 2_097_152 + (h2 & 0x1f_ffff)
}

const TASK_RESULT_VERSION_CACHE = new Map<string, number>()
const TASK_RESULT_HAS_RESULT_CACHE = new Map<string, boolean>()
const LARGE_RESULT_VERSION_CACHE = new Map<string, {
  version: number
  hasResult: boolean
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
}>()
const LARGE_RESULT_VERSION_TTL_MS = 60_000
const LARGE_RESULT_VERSION_MAX_ENTRIES = 2

function evictLargeResultVersion(result: string): void {
  const entry = LARGE_RESULT_VERSION_CACHE.get(result)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  LARGE_RESULT_VERSION_CACHE.delete(result)
}

function cacheLargeResultVersion(result: string, version: number): void {
  const entry: { version: number; hasResult: boolean; expiresAt: number; timer?: ReturnType<typeof setTimeout> } = {
    version, hasResult: /\S/.test(result), expiresAt: Date.now() + LARGE_RESULT_VERSION_TTL_MS,
  }
  LARGE_RESULT_VERSION_CACHE.set(result, entry)
  // Each entry has its own fixed lifetime. Activity on other results must not
  // keep an evicted multi-megabyte string alive by resetting a shared timer.
  entry.timer = setTimeout(() => {
    if (LARGE_RESULT_VERSION_CACHE.get(result) === entry) evictLargeResultVersion(result)
  }, LARGE_RESULT_VERSION_TTL_MS)
  ;(entry.timer as { unref?: () => void }).unref?.()
}
const TASK_RESULT_VERSION_CACHE_CAP = 100
const TASK_RESULT_VERSION_CACHE_MAX_CHARS = 64_000_000
let taskResultVersionCacheChars = 0
let taskResultVersionTimer: ReturnType<typeof setTimeout> | undefined

function scheduleTaskResultVersionCleanup(): void {
  if (taskResultVersionTimer) return
  taskResultVersionTimer = setTimeout(() => {
    TASK_RESULT_VERSION_CACHE.clear()
    TASK_RESULT_HAS_RESULT_CACHE.clear()
    taskResultVersionCacheChars = 0
    taskResultVersionTimer = undefined
  }, LARGE_RESULT_VERSION_TTL_MS)
  ;(taskResultVersionTimer as { unref?: () => void }).unref?.()
}

/** Cache content generation by value so metadata-only record clones and
 *  sequential pages do not rescan an unchanged multi-megabyte string. */
export function taskResultVersionForRecord(task: TaskRecordUi): number | undefined {
  if (task.result === undefined) return undefined
  const cached = TASK_RESULT_VERSION_CACHE.get(task.result)
  if (cached !== undefined) return cached
  if (task.result.length > TASK_RESULT_VERSION_CACHE_MAX_CHARS) {
    const cachedLarge = LARGE_RESULT_VERSION_CACHE.get(task.result)
    if (cachedLarge && cachedLarge.expiresAt > Date.now()) return cachedLarge.version
    if (cachedLarge) evictLargeResultVersion(task.result)
    // A bounded pair of oversized values covers adjacent large task outputs
    // without evicting and rehashing the same two strings on every projection.
    while (LARGE_RESULT_VERSION_CACHE.size >= LARGE_RESULT_VERSION_MAX_ENTRIES) {
      const oldest = LARGE_RESULT_VERSION_CACHE.keys().next().value
      if (oldest === undefined) break
      evictLargeResultVersion(oldest)
    }
    const version = taskResultVersion(task.result)
    cacheLargeResultVersion(task.result, version)
    return version
  }
  const version = taskResultVersion(task.result)
  if (task.result.length <= TASK_RESULT_VERSION_CACHE_MAX_CHARS) {
    while (TASK_RESULT_VERSION_CACHE.size > 0 &&
      (TASK_RESULT_VERSION_CACHE.size >= TASK_RESULT_VERSION_CACHE_CAP ||
        taskResultVersionCacheChars + task.result.length > TASK_RESULT_VERSION_CACHE_MAX_CHARS)) {
      const oldest = TASK_RESULT_VERSION_CACHE.keys().next().value
      if (oldest === undefined) break
      TASK_RESULT_VERSION_CACHE.delete(oldest)
      TASK_RESULT_HAS_RESULT_CACHE.delete(oldest)
      taskResultVersionCacheChars -= oldest.length
    }
    TASK_RESULT_VERSION_CACHE.set(task.result, version)
    taskResultVersionCacheChars += task.result.length
    scheduleTaskResultVersionCleanup()
  }
  return version
}

/** Return the cached non-whitespace flag alongside the content generation. */
export function taskResultHasResultForRecord(task: TaskRecordUi): boolean {
  if (task.result === undefined) return false
  taskResultVersionForRecord(task)
  if (task.result.length > TASK_RESULT_VERSION_CACHE_MAX_CHARS) {
    return LARGE_RESULT_VERSION_CACHE.get(task.result)!.hasResult
  }
  const cached = TASK_RESULT_HAS_RESULT_CACHE.get(task.result)
  if (cached !== undefined) return cached
  const hasResult = /\S/.test(task.result)
  TASK_RESULT_HAS_RESULT_CACHE.set(task.result, hasResult)
  return hasResult
}

/** Hash a canonical text projection without retaining it in the server's
 *  content cache. Browser precedence checks use this lifecycle-free variant. */
export function taskResultVersionForText(text: string): number {
  return taskResultVersion(text)
}

/** Slice the stored UTF-16 string without splitting a surrogate pair. The
 *  returned nextOffset is the only continuation clients should use. */
export function pageTaskResult(
  text: string,
  requestedOffset: number,
  requestedLimit: number,
): { offset: number; totalChars: number; result: string; nextOffset: number; previousOffset: number; hasMore: boolean } {
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > text.length) {
    throw new RangeError('offset must be a non-negative safe integer no greater than totalChars')
  }
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new RangeError('limit must be a positive safe integer')
  }
  const offset = isLowSurrogate(text.charCodeAt(requestedOffset)) && isHighSurrogate(text.charCodeAt(requestedOffset - 1))
    ? requestedOffset + 1
    : requestedOffset
  const limit = Math.min(requestedLimit, TASK_RESULT_PAGE_MAX_CHARS)
  let nextOffset = Math.min(text.length, Math.max(offset + 1, requestedOffset + limit))
  if (nextOffset < text.length && isHighSurrogate(text.charCodeAt(nextOffset - 1)) && isLowSurrogate(text.charCodeAt(nextOffset))) {
    nextOffset -= 1
    if (nextOffset === offset) {
      // The requested window contains only part of one code point. Include
      // the pair rather than returning an empty page or splitting it.
      nextOffset += 2
    }
  }
  let previousOffset = Math.max(0, offset - TASK_RESULT_PAGE_MAX_CHARS)
  if (isLowSurrogate(text.charCodeAt(previousOffset)) && isHighSurrogate(text.charCodeAt(previousOffset - 1))) {
    previousOffset -= 1
  }
  return {
    offset,
    totalChars: text.length,
    result: text.slice(offset, nextOffset),
    nextOffset,
    previousOffset,
    hasMore: nextOffset < text.length,
  }
}

const taskProjectionCache = new WeakMap<TaskRecordUi, Partial<Record<'empty' | 'full' | 'partial', TaskRecordUi>>>()

/** Project canonical task records onto the bounded WS roster. Result bodies
 *  stay in the live map/sidecar; only this transport copy is clipped. Partial
 *  results omit `result` entirely so an older client cannot mistake a tail for
 *  canonical output; new clients use resultRef for lifecycle and paged reads. */
export function projectTasksSnapshot(tasks: readonly TaskRecordUi[]): TaskRecordUi[] {
  let remaining = TASK_SNAPSHOT_RESULT_BUDGET_CHARS
  return tasks.map((task) => {
    const result = task.result
    const full = result !== undefined && result.length <= TASK_RESULT_INLINE_CHARS && result.length <= remaining
    const mode = result === undefined ? 'empty' : full ? 'full' : 'partial'
    const cached = taskProjectionCache.get(task)?.[mode]
    if (cached) {
      if (full) remaining -= result!.length
      return cached
    }
    if (full) remaining -= result!.length
    const projectedTask: TaskRecordUi = {
      ...task,
      description: clipSnapshotText(task.description, 2_048),
      ...(task.subagentType !== undefined ? { subagentType: clipSnapshotText(task.subagentType, 256) } : {}),
      ...(task.workflowName !== undefined ? { workflowName: clipSnapshotText(task.workflowName, 256) } : {}),
      ...(task.progressSummary !== undefined ? { progressSummary: clipSnapshotText(task.progressSummary, 4_096) } : {}),
      ...(task.lastToolName !== undefined ? { lastToolName: clipSnapshotText(task.lastToolName, 256) } : {}),
      ...(task.resourceLinks !== undefined
        ? {
            resourceLinks: task.resourceLinks.map((link) => ({
              ...link,
              name: clipSnapshotText(link.name, 256),
              ...(link.title !== undefined ? { title: clipSnapshotText(link.title, 512) } : {}),
              ...(link.mimeType !== undefined ? { mimeType: clipSnapshotText(link.mimeType, 256) } : {}),
            })),
          }
        : {}),
    }
    let projected = projectedTask
    if (result !== undefined) {
      projected = {
        ...projectedTask,
        result: full ? result : undefined,
        resultRef: {
          totalChars: result.length,
          hasResult: taskResultHasResultForRecord(task),
          isError: task.status !== 'completed' && task.status !== 'stopped',
          projection: full ? ('full' as const) : ('partial' as const),
          resultVersion: taskResultVersionForRecord(task)!,
        },
      }
    }
    const modes = taskProjectionCache.get(task) ?? {}
    modes[mode] = projected
    taskProjectionCache.set(task, modes)
    return projected
  })
}

function clipSnapshotText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let end = maxChars
  if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1
  return text.slice(0, end)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
