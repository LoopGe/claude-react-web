// server/providers/native/tools/monitor.ts
//
// Monitor watches a shell command's stdout lines (or a WebSocket's text frames)
// and delivers each occurrence as a <task-notification> event injection. It is
// a BACKGROUND task (taskType 'monitor'): the loop detaches the call immediately
// via `backgroundable.shouldBackground`, so the tool_result is the launch
// acknowledgement and the watch keeps running on the task's own controller past
// the call. TaskStop aborts that controller (killing the spawn / socket); the
// deadline and natural exit end the watch too.
//
// Two delivery paths, deliberately distinct:
//   • EVENT batches (this tool's `inject` dep) carry `events` and NO toolUseId,
//     so the host classifies them as non-foldable neutral cards — they never
//     settle the task record while the watch is still running.
//   • The FINAL status notification is the manager's backgrounded-settle inject
//     (Task 7), which carries the toolUseId and folds the record to terminal.
//     The tool only resolves its run with the end outcome; it does not inject a
//     second status notification (that would double the manager's).
//
// The spawn port is a neutral abstraction (Node child_process / ws behind one
// interface) so unit tests drive a stub with controlled stdout chunks / frames.
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { createLogger } from '../../../log.js'
import { captureBirthTime } from '../../../win32-job.js'
import type { TaskNotificationFacts } from '../task-manager.js'
import { killTree } from './process-output.js'
import { resolveBashShell } from './shell.js'
import { ToolInputError, type ToolDef, type ToolOutcome } from './types.js'

const log = createLogger('native-monitor')

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 1_800_000
/** Events arriving within this window ride ONE notification (one model wake),
 *  not one turn per line. */
export const MONITOR_BATCH_MS = 200
/** Per-event character cap (the repo's bounded-buffer discipline: 64KiB terminal
 *  input, 128Ki task-result pages). Bounds BOTH the partial-line buffer (a
 *  no-newline flood cannot grow it without bound across batch windows) and each
 *  emitted event (a single minified/multi-MB line is truncated, not injected
 *  verbatim). Excess is dropped with a truncation marker. */
export const MAX_EVENT_CHARS = 64 * 1024
const TRUNCATION_MARKER = '...[line truncated]'

/** Cap one event line, marking it when content was dropped — either the line
 *  itself exceeds the cap, or its partial buffer was already truncated. */
function capEvent(line: string, truncated: boolean): string {
  return truncated || line.length > MAX_EVENT_CHARS
    ? line.slice(0, MAX_EVENT_CHARS) + TRUNCATION_MARKER
    : line
}

export const MONITOR_GUIDANCE =
  'Filter at the source (grep/awk in the command, a filtered WS feed) so only lines you would act on become events — every event batch wakes the model. ' +
  'Cover failure signatures, not just the happy path: a monitor matching only success markers stays silent through a crashloop, hang, or unexpected exit, and silence looks identical to still-running. ' +
  'Stop the watch with TaskStop when it is no longer needed; it expires at timeout_ms.'

export type MonitorInput = {
  description: string
  timeout_ms?: number
  /** Watch until TaskStop or the watch ends; ignores timeout_ms (CLI parity:
   *  the deadline is 0 when persistent). */
  persistent?: boolean
  command?: string
  ws?: { url: string; protocols?: string[] }
}

/** What to watch: a shell command (stdout lines) XOR a WebSocket (text frames). */
export type MonitorTarget =
  | { kind: 'command'; command: string; cwd: string }
  | { kind: 'ws'; url: string; protocols?: string[] }

/** Transport events handed back to the tool. `onEvent` delivers a stdout chunk
 *  (command) or a WS frame — a text frame as string, a binary frame as bytes.
 *  `onEnd` fires once on process exit / socket close / spawn-connect error / the
 *  kill completing; `code` is the exit status (null for a socket or a kill). */
export interface MonitorStreamEvents {
  onEvent(event: string | Uint8Array): void
  onEnd(end: { code: number | null; error?: string }): void
}

export interface MonitorSpawnHandle {
  kill(): void
}

export type MonitorSpawnPort = (target: MonitorTarget, events: MonitorStreamEvents) => MonitorSpawnHandle

export interface MonitorToolDeps {
  /** The event-batch sink (the session's idle-injection queue). */
  inject: (notification: TaskNotificationFacts) => void
  spawn: MonitorSpawnPort
}

/** Total input validation, shared by the loop's pre-registration `validate`
 *  hook and `run` (direct calls). Throws ToolInputError on malformed input so a
 *  bad call never registers a background record (the loop validates before
 *  describe()/runForeground). */
function validateMonitorInput(input: MonitorInput): void {
  if (typeof input.description !== 'string' || input.description.trim() === '') {
    throw new ToolInputError('description is required')
  }
  const hasCommand = input.command !== undefined
  const hasWs = input.ws !== undefined
  if (hasCommand === hasWs) {
    throw new ToolInputError('provide exactly one of command or ws')
  }
  if (input.persistent !== undefined && typeof input.persistent !== 'boolean') {
    throw new ToolInputError('persistent must be a boolean')
  }
  if (hasCommand) {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      throw new ToolInputError('command must be a non-empty string')
    }
  } else {
    const ws = input.ws!
    if (typeof ws.url !== 'string' || ws.url.trim() === '') {
      throw new ToolInputError('ws.url must be a non-empty string')
    }
    if (ws.protocols !== undefined && (!Array.isArray(ws.protocols) || ws.protocols.some((p) => typeof p !== 'string'))) {
      throw new ToolInputError('ws.protocols must be an array of strings')
    }
  }
  if (input.timeout_ms !== undefined && (typeof input.timeout_ms !== 'number' || !Number.isFinite(input.timeout_ms))) {
    throw new ToolInputError('timeout_ms must be a finite number')
  }
}

export function createMonitorTool(deps: MonitorToolDeps): ToolDef<MonitorInput> {
  return {
    name: 'Monitor',
    description:
      'Watch a shell command\'s stdout lines or a WebSocket\'s text frames and deliver each as a task-notification event. ' +
      'Runs as a background task: the call returns immediately with a task id, events arrive as notifications while you continue, ' +
      'and the watch ends on process exit / socket close, timeout_ms expiry, or TaskStop. Provide exactly one of command or ws. ' +
      'Binary WS frames arrive as a [binary frame, N bytes] placeholder.',
    guidance: MONITOR_GUIDANCE,
    promptOrder: 84,
    schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short human-readable description of what is being watched (shown in the task list).' },
        timeout_ms: { type: 'number', description: `End the watch after this many ms. Defaults to ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}. Ignored when persistent.` },
        persistent: { type: 'boolean', description: 'Keep watching until TaskStop or the watch ends (process exit / socket close); the timeout is ignored.' },
        command: { type: 'string', description: 'Shell command whose stdout lines become events. Filter at the source and cover failure signatures. Mutually exclusive with ws.' },
        ws: {
          type: 'object',
          description: 'WebSocket whose text frames become events. Mutually exclusive with command.',
          properties: {
            url: { type: 'string', description: 'The wss:// (or ws://) URL to subscribe to.' },
            protocols: { type: 'array', items: { type: 'string' }, description: 'Optional WebSocket subprotocols.' },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
      required: ['description'],
      additionalProperties: false,
    },
    backgroundable: {
      taskType: 'monitor',
      describe: (input) => input.description,
      // Every Monitor call backgrounds immediately: the watch outlives the call.
      shouldBackground: () => true,
    },
    validate: validateMonitorInput,
    async run(input, ctx) {
      validateMonitorInput(input)
      const target: MonitorTarget = input.command !== undefined
        ? { kind: 'command', command: input.command, cwd: ctx.cwd }
        : { kind: 'ws', url: input.ws!.url, ...(input.ws!.protocols !== undefined ? { protocols: input.ws!.protocols } : {}) }
      const persistent = input.persistent === true
      const timeoutMs = persistent
        ? 0
        : Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(input.timeout_ms ?? DEFAULT_TIMEOUT_MS)))
      // The loop always anchors a backgroundable call to its tool_use id; the
      // task record (and the event deliveries' task-id) key on it.
      const taskId = ctx.toolUseId!
      const description = input.description
      if (ctx.signal.aborted) return { text: 'Monitor stopped.', isError: true }

      return new Promise<ToolOutcome>((resolve) => {
        let settled = false
        let timedOut = false
        let buffer = ''
        let bufferTruncated = false
        let pending: string[] = []
        let batchTimer: ReturnType<typeof setTimeout> | null = null

        const flushBatch = () => {
          batchTimer = null
          if (pending.length === 0) return
          const events = pending
          pending = []
          // Non-foldable event delivery: no task-id, no status, no toolUseId,
          // no result — the host renders the <event> lines as a neutral card
          // and no status-shaped consumer can mistake a live watch for a
          // settled task (the client MonitorBar settles on a matching
          // <task-id>, which is why batches carry none).
          deps.inject({ description, events })
        }
        const pushEvent = (line: string) => {
          if (line.trim() === '') return
          pending.push(line)
          if (batchTimer === null) batchTimer = setTimeout(flushBatch, MONITOR_BATCH_MS)
        }
        const settle = (outcome: ToolOutcome) => {
          if (settled) return
          settled = true
          if (timer !== null) clearTimeout(timer)
          if (batchTimer !== null) {
            clearTimeout(batchTimer)
            batchTimer = null
          }
          // Deliver any buffered events BEFORE the manager's settle injects the
          // final status notification, so the wake order is events-then-status.
          flushBatch()
          ctx.signal.removeEventListener('abort', onAbort)
          log.debug(`[${taskId}] watch ended: ${outcome.text}`)
          resolve(outcome)
        }

        const handle = deps.spawn(target, {
          onEvent: (event) => {
            if (target.kind === 'command') {
              buffer += event as string
              // Extract complete lines FIRST (so a newline is never lost to the
              // remainder cap), then bound the partial remainder: a no-newline
              // flood cannot grow the buffer past the cap across batch windows.
              let nl = buffer.indexOf('\n')
              while (nl >= 0) {
                const line = buffer.slice(0, nl).replace(/\r$/, '')
                pushEvent(capEvent(line, bufferTruncated))
                bufferTruncated = false
                buffer = buffer.slice(nl + 1)
                nl = buffer.indexOf('\n')
              }
              if (buffer.length > MAX_EVENT_CHARS) {
                buffer = buffer.slice(0, MAX_EVENT_CHARS)
                bufferTruncated = true
              }
            } else if (typeof event === 'string') {
              pushEvent(capEvent(event, false))
            } else {
              pushEvent(`[binary frame, ${event.byteLength} bytes]`)
            }
          },
          onEnd: (end) => {
            if (timedOut || settled) return
            if (target.kind === 'command' && buffer !== '') {
              pushEvent(capEvent(buffer.replace(/\r$/, ''), bufferTruncated))
              buffer = ''
            }
            if (end.error !== undefined) {
              settle({ text: `Monitor failed: ${end.error}`, isError: true })
            } else if (end.code !== null && end.code !== 0) {
              settle({ text: `Monitor command exited with exit code ${end.code}.`, isError: true })
            } else {
              settle({ text: end.code !== null ? 'Monitor command exited (exit code 0).' : 'Monitor watch ended.', isError: false })
            }
          },
        })
        const onAbort = () => {
          handle.kill()
          settle({ text: 'Monitor stopped.', isError: true })
        }
        // A persistent watch has no deadline: it ends only on TaskStop (the
        // abort listener), a natural exit, or an error.
        const timer = persistent
          ? null
          : setTimeout(() => {
            timedOut = true
            handle.kill()
            // Expiry is the designed end of a watch, not a failure.
            settle({ text: `Monitor expired after ${timeoutMs}ms.`, isError: false })
          }, timeoutMs)
        ctx.signal.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

/** The real Node spawn port: Git Bash / /bin/bash for commands (the Bash tool's
 *  resolution), the `ws` client for sockets. Kill reuses the Bash tree-kill
 *  discipline (win32 PID-reuse fence + process-group kill). */
export function createNodeMonitorSpawn(): MonitorSpawnPort {
  return (target, events) => {
    if (target.kind === 'command') {
      const child = spawn(resolveBashShell(), ['-c', target.command], {
        cwd: target.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      const birthTime = process.platform === 'win32' && child.pid !== undefined
        ? captureBirthTime(child.pid)
        : null
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => events.onEvent(chunk))
      child.on('error', (err) => events.onEnd({ code: null, error: err.message }))
      child.on('close', (code) => events.onEnd({ code }))
      return {
        kill() {
          killTree(child, birthTime)
          child.stdout.destroy()
        },
      }
    }
    const socket = new WebSocket(target.url, target.protocols)
    socket.on('message', (data, isBinary) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data) ? data : Buffer.from(data)
      events.onEvent(isBinary ? new Uint8Array(buf) : buf.toString('utf8'))
    })
    socket.on('error', (err) => events.onEnd({ code: null, error: err.message }))
    socket.on('close', () => events.onEnd({ code: null }))
    return {
      kill() {
        socket.terminate()
      },
    }
  }
}
