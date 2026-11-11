// server/providers/native/task-manager.ts
import type { AgentMessage } from '../../agent-message.js'
import { MAX_TERMINAL_TASKS } from '../../../shared/tasks.js'
import { taskNotificationFrame, taskStartedFrame } from './frames.js'
import type { ToolOutcome } from './tools/types.js'

export interface NativeTaskMetadata {
  toolUseId: string
  taskType: 'shell' | 'subagent'
  description: string
  subagentType?: string
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

  constructor(private readonly emit: (frame: AgentMessage) => void) {}

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
      } else {
        this.emit(taskNotificationFrame({
          taskId: record.metadata.toolUseId,
          toolUseId: record.metadata.toolUseId,
          description: record.metadata.description,
          status: record.status,
          result: outcome.text,
          receivedAt: Date.now(),
        }))
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
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (outcome: ToolOutcome) => {
        if (finished) return
        finished = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        record.outputWaiters.delete(finish)
        resolve(outcome)
      }
      const onAbort = () => finish({ text: 'TaskOutput aborted', isError: true })
      record.outputWaiters.add(finish)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
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
    this.emit(taskStartedFrame({
      taskId: record.metadata.toolUseId,
      toolUseId: record.metadata.toolUseId,
      taskType: record.metadata.taskType === 'shell' ? 'local_bash' : 'local_agent',
      description: record.metadata.description,
      subagentType: record.metadata.subagentType,
      receivedAt: record.startedAt,
    }))
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
