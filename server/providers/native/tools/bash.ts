// server/providers/native/tools/bash.ts
import { spawn } from 'node:child_process'
import { captureBirthTime } from '../../../win32-job.js'
import { ToolInputError, type ToolDef } from './types.js'
import { resolveBashShell } from './shell.js'
import { CappedOutput, killTree, HEAD_CHARS, TAIL_CHARS } from './process-output.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

let cachedShell: string | undefined

/** Resolved once per process; resolution failure throws a loud config error
 *  (the Bash tool is unusable without a shell). */
function shellPath(): string {
  return (cachedShell ??= resolveBashShell())
}

/** Head+tail truncation for command / tool output: keeps the first
 *  `HEAD_CHARS` and the last `TAIL_CHARS` characters. Shared with the MCP
 *  connection manager so an MCP tool result is bounded the same way. */
export function capToolText(text: string): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text
  return text.slice(0, HEAD_CHARS) + '\n...[truncated]...\n' + text.slice(-TAIL_CHARS)
}

export const bashTool: ToolDef<{ command: string; timeout_ms?: number }> = {
  name: 'Bash',
  description: 'Run a shell command and return its output.',
  guidance: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  promptOrder: 90,
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      timeout_ms: { type: 'number', description: `Kill the command after this many ms. Defaults to ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.` },
    },
    required: ['command'],
  },
  backgroundable: {
    taskType: 'shell',
    describe: (input) => input.command,
  },
  async run(input, ctx) {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      throw new ToolInputError('command is required')
    }
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(input.timeout_ms ?? DEFAULT_TIMEOUT_MS)))
    return new Promise((resolvePromise) => {
      const child = spawn(shellPath(), ['-c', input.command], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      // Spawn-time creation identity: the win32 tree kill refuses a PID whose
      // live creation time no longer matches (PID reuse fence).
      const birthTime = process.platform === 'win32' && child.pid !== undefined
        ? captureBirthTime(child.pid)
        : null
      const stdout = new CappedOutput()
      const stderr = new CappedOutput()
      let timedOut = false
      let settled = false
      const settle = (result: { text: string; isError?: boolean }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolvePromise(result)
      }
      const kill = () => {
        killTree(child, birthTime)
        // The killed tree's stdio pipes can outlive the processes by seconds;
        // our read ends must not keep the call (or the event loop) waiting.
        child.stdout?.destroy()
        child.stderr?.destroy()
      }
      const onAbort = () => {
        kill()
        settle({ text: 'command aborted', isError: true })
      }
      child.stdout.on('data', (d: Buffer) => stdout.push(d))
      child.stderr.on('data', (d: Buffer) => stderr.push(d))
      // Settle on the kill, not on 'close': at this point the command has
      // already been terminated, and waiting for the pipes to drain would let
      // a long-running child hold the tool call open past its timeout.
      const timer = setTimeout(() => {
        timedOut = true
        kill()
        settle({ text: `command timed out after ${timeoutMs}ms\n${capToolText(stdout.text() + stderr.text())}`, isError: true })
      }, timeoutMs)
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', (err) => {
        settle({ text: `failed to spawn: ${err.message}`, isError: true })
      })
      child.on('close', (code) => {
        if (timedOut) return
        const combined = capToolText((stdout.text() + (stderr.text() ? '\n' + stderr.text() : '')).trimEnd())
        settle({ text: `${combined}\n[exit code: ${code ?? -1}]` })
      })
    })
  },
}