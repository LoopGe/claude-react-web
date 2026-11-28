// server/providers/native/task-manager.ts
import { MAX_TERMINAL_TASKS } from '../../../shared/tasks.js'
import type { OperationalFrame } from './vocabulary/live-frame.js'
import type { ToolOutcome } from './tools/types.js'

export interface NativeTaskMetadata {
  toolUseId: string
  taskType: 'shell' | 'subagent' | 'monitor'
  description: string
  subagentType?: string
  /** App-initiated runs (the auto-memory dream) set this: their settle still
   *  emits the operational task/notification frame (the TasksPanel roster +
   *  result), but does NOT inject a model-facing <task-notification> turn. The
   *  model never dispatched the task, so waking it with a completion it did not
   *  ask for is an unsolicited turn — the dream is silent fire-and-forget
   *  consolidation. Model-dispatched background tasks (Bash / Agent) leave this
   *  unset and keep the CLI-parity completion wake. */
  silentCompletion?: boolean
}

/** The neutral live-frame task discriminant for each metadata task type. The
 *  host adapter projects these to the SDK `task_started` shape; the friendly
 *  client labels (shell / subagent / monitor) come from shared/tasks.ts. */
const TASK_TYPE_FRAME = {
  shell: 'local_bash',
  subagent: 'local_agent',
  monitor: 'local_monitor',
} as const

/** The model-facing completion facts of a backgrounded task settle — the
 *  neutral input to the `<task-notification>` user injection (the CLI's
 *  background-completion wake). `description` is the task's own description
 *  (the XML `<summary>`); `events` carries monitor event lines (Monitor
 *  tasks) — a plain completion carries only `result`. */
export interface TaskNotificationFacts {
  taskId: string
  toolUseId?: string
  description: string
  status: 'completed' | 'failed' | 'stopped'
  result: string
  events?: string[]
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Build the harness `<task-notification>` injection body. The grammar is the
 *  inverse of shared/user-frames.ts's parser (the host classifies the
 *  injection BY CONTENT): task-id / tool-use-id / status / summary / result,
 *  then one `<event>` line per monitor event. Text fields are entity-escaped
 *  so a result carrying markup survives the round trip. */
export function taskNotificationXml(facts: TaskNotificationFacts): string {
  const parts = [
    `<task-id>${escapeXmlText(facts.taskId)}</task-id>`,
    ...(facts.toolUseId !== undefined ? [`<tool-use-id>${escapeXmlText(facts.toolUseId)}</tool-use-id>`] : []),
    `<status>${facts.status}</status>`,
    `<summary>${escapeXmlText(facts.description)}</summary>`,
    `<result>${escapeXmlText(facts.result)}</result>`,
    ...(facts.events ?? []).map((event) => `<event>${escapeXmlText(event)}</event>`),
  ]
  return `<task-notification>${parts.join('')}</task-notification>`
}

type TerminalStatus = 'completed' | 'failed' | 'stopped'

interface TaskRecord {
  metadata: NativeTaskMetadata
  parentTaskId?: string
  controller: AbortController
  startedAt: number
  state: 'foreground' | 'background' | 'terminal'
  stopRequested: boolean
  outcome?: ToolOutcome
  status?: TerminalStatus
  outputWaiters: Set<(outcome: ToolOutcome) => void>
  removeParentListener(): void
  resolveLoop(outcome: ToolOutcome): void
  settled: Promise<void>
}

function errorOutcome(error: unknown): ToolOutcome {
  return { text: error instanceof Error ? error.message : String(error), isError: true }
}

function unknownTaskOutcome(taskId: string): ToolOutcome {
  return { text: `Unknown or expired task ${taskId}`, isError: true }
}

function runningTaskOutcome(taskId: string): ToolOutcome {
  return { text: `Task ${taskId} is still running.`, isError: false }
}

const DEFAULT_OUTPUT_TIMEOUT = 30_000
const MAX_OUTPUT_TIMEOUT = 600_000

export class NativeTaskManager {
  private readonly records = new Map<string, TaskRecord>()

  // Emits NEUTRAL live-only operational task frames (R6): task/started on a
  // foreground-subagent launch (isBackgrounded:false) and on detach of either
  // type (isBackgrounded:true); task/notification when a backgrounded task
  // settles (either type) or a foreground subagent settles. Foreground shells
  // emit nothing — claude parity. The host adapter owns the SDK projection
  // (task_started / task_notification); the core never constructs SDK shapes.
  // These frames are live-only — never persisted.
  //
  // `inject` is the MODEL-facing half of a backgrounded settle: the session
  // wires it to its idle-injection queue, which delivers the facts as a
  // <task-notification> user turn (CLI parity — the operational frame alone
  // only feeds the TasksPanel). A foreground settle never injects: the parent
  // already holds the result via its tool_result. An app-initiated
  // silent-completion run (metadata.silentCompletion, the dream) also skips the
  // inject: the model never dispatched it, so its settle is TasksPanel-only.
  constructor(
    private readonly emit: (frame: OperationalFrame) => void,
    private readonly inject?: (notification: TaskNotificationFacts) => void,
  ) {}

  runForeground(
    metadata: NativeTaskMetadata,
    execute: (signal: AbortSignal) => Promise<ToolOutcome>,
    parentSignal: AbortSignal,
    parentTaskId?: string,
  ): Promise<ToolOutcome> {
    const controller = new AbortController()
    const onParentAbort = () => controller.abort()
    if (parentSignal.aborted) onParentAbort()
    else parentSignal.addEventListener('abort', onParentAbort, { once: true })

    let resolveLoop!: (outcome: ToolOutcome) => void
    const loop = new Promise<ToolOutcome>((resolve) => { resolveLoop = resolve })
    const record: TaskRecord = {
      metadata,
      parentTaskId,
      controller,
      startedAt: Date.now(),
      state: 'foreground',
      stopRequested: false,
      outputWaiters: new Set(),
      removeParentListener: () => parentSignal.removeEventListener('abort', onParentAbort),
      resolveLoop,
      settled: Promise.resolve(),
    }
    this.records.set(metadata.toolUseId, record)

    // Claude parity: a foreground subagent announces its launch immediately
    // (isBackgrounded:false); a foreground shell stays silent.
    if (metadata.taskType === 'subagent') {
      this.emit({
        type: 'task/started',
        taskId: metadata.toolUseId,
        toolUseId: metadata.toolUseId,
        taskType: 'local_agent',
        description: metadata.description,
        ...(metadata.subagentType !== undefined ? { subagentType: metadata.subagentType } : {}),
        isBackgrounded: false,
        time: record.startedAt,
      })
    }

    let execution: Promise<ToolOutcome>
    try {
      execution = Promise.resolve(execute(controller.signal))
    } catch (error) {
      execution = Promise.resolve(errorOutcome(error))
    }
    const observed = execution.then(
      (outcome) => outcome,
      (error: unknown) => errorOutcome(error),
    )
    record.settled = observed.then((outcome) => {
      record.removeParentListener()
      record.outcome = outcome
      record.status = record.stopRequested ? 'stopped' : outcome.isError ? 'failed' : 'completed'
      const wasForeground = record.state === 'foreground'
      record.state = 'terminal'
      this.resolveOutputWaiters(record, this.terminalOutcome(record))
      if (wasForeground) {
        record.resolveLoop(outcome)
        // A foreground subagent reports its settle too (claude parity); a
        // foreground shell resolves the loop only. A subagent backgrounded
        // mid-flight has wasForeground === false and takes the branch below,
        // so it notifies exactly once.
        if (metadata.taskType === 'subagent') {
          this.emit({
            type: 'task/notification',
            taskId: record.metadata.toolUseId,
            toolUseId: record.metadata.toolUseId,
            description: record.metadata.description,
            status: record.status,
            result: outcome.text,
            time: Date.now(),
          })
        }
      } else {
        this.emit({
          type: 'task/notification',
          taskId: record.metadata.toolUseId,
          toolUseId: record.metadata.toolUseId,
          description: record.metadata.description,
          status: record.status,
          result: outcome.text,
          time: Date.now(),
        })
        // The operational frame above always feeds the TasksPanel. The model-
        // facing wake is only for tasks the model dispatched; an app-initiated
        // silent-completion run (the dream) settles without waking the model.
        if (!record.metadata.silentCompletion) {
          this.inject?.({
            taskId: record.metadata.toolUseId,
            toolUseId: record.metadata.toolUseId,
            description: record.metadata.description,
            status: record.status,
            result: outcome.text,
          })
        }
      }
      this.pruneTerminalRecords()
    })
    return loop
  }

  background(toolUseId?: string): boolean {
    if (toolUseId !== undefined) return this.detach(this.records.get(toolUseId))
    let detached = false
    for (const record of this.records.values()) {
      if (record.state === 'foreground') detached = this.detach(record) || detached
    }
    return detached
  }

  output(
    taskId: string,
    options: { block?: boolean; timeout?: number },
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const record = this.records.get(taskId)
    if (!record) return Promise.resolve(unknownTaskOutcome(taskId))
    if (record.state === 'terminal') return Promise.resolve(this.terminalOutcome(record))
    if (options.block !== true) return Promise.resolve(runningTaskOutcome(taskId))
    if (signal.aborted) return Promise.resolve({ text: 'TaskOutput aborted', isError: true })

    return new Promise((resolve) => {
      let finished = false
      const finish = (outcome: ToolOutcome) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        record.outputWaiters.delete(finish)
        resolve(outcome)
      }
      const onAbort = () => finish({ text: 'TaskOutput aborted', isError: true })
      record.outputWaiters.add(finish)
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(
        () => finish(runningTaskOutcome(taskId)),
        Math.min(options.timeout ?? DEFAULT_OUTPUT_TIMEOUT, MAX_OUTPUT_TIMEOUT),
      )
    })
  }

  async stop(taskId: string): Promise<void> {
    const record = this.records.get(taskId)
    if (!record) throw new Error(`Unknown task ${taskId}`)
    if (record.state !== 'background') throw new Error(`Task ${taskId} is not backgrounded`)
    record.stopRequested = true
    record.controller.abort()
    await record.settled
  }

  async destroy(): Promise<void> {
    const active = [...this.records.values()].filter((record) => record.state !== 'terminal')
    for (const record of active) {
      record.stopRequested = true
      record.controller.abort()
    }
    await Promise.all(active.map((record) => record.settled))
  }

  private terminalOutcome(record: TaskRecord): ToolOutcome {
    return {
      text: `Task ${record.metadata.toolUseId} ${record.status!}.\n${record.outcome!.text}`,
      isError: record.status === 'failed',
    }
  }

  private resolveOutputWaiters(record: TaskRecord, outcome: ToolOutcome): void {
    for (const waiter of [...record.outputWaiters]) waiter(outcome)
  }

  private detach(record: TaskRecord | undefined): boolean {
    if (!record || record.state !== 'foreground') return false
    record.state = 'background'
    record.removeParentListener()
    this.emit({
      type: 'task/started',
      taskId: record.metadata.toolUseId,
      toolUseId: record.metadata.toolUseId,
      taskType: TASK_TYPE_FRAME[record.metadata.taskType],
      description: record.metadata.description,
      ...(record.metadata.subagentType !== undefined ? { subagentType: record.metadata.subagentType } : {}),
      isBackgrounded: true,
      time: record.startedAt,
    })
    record.resolveLoop({
      text: `Task ${record.metadata.toolUseId} is running in the background.\nUse TaskOutput with task_id="${record.metadata.toolUseId}" to retrieve its final output.`,
      isError: false,
    })
    return true
  }

  private pruneTerminalRecords(): void {
    let terminals = 0
    for (const record of this.records.values()) {
      if (record.state === 'terminal') terminals++
    }
    if (terminals <= MAX_TERMINAL_TASKS) return
    for (const [taskId, record] of this.records) {
      if (terminals <= MAX_TERMINAL_TASKS) break
      if (record.state === 'terminal') {
        this.resolveOutputWaiters(record, unknownTaskOutcome(taskId))
        this.records.delete(taskId)
        terminals--
      }
    }
  }
}
