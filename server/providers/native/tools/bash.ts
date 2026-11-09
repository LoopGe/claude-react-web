// server/providers/native/tools/bash.ts
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { decodeShellBytes } from '../../../shell-encoding.js'
import { ToolInputError, type ToolDef } from './types.js'
import { resolveBashShell } from './shell.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const HEAD_CHARS = 25_000
const TAIL_CHARS = 5_000
// Byte caps for the bounded accumulator. HEAD_BYTES decodes to at least
// HEAD_CHARS characters (UTF-8 encodes a character in at most 4 bytes), so
// cap() below still sees a full head window; the same holds for the tail.
const HEAD_BYTES = HEAD_CHARS * 4
const TAIL_BYTES = TAIL_CHARS * 4

let cachedShell: string | undefined

/** Resolved once per process; resolution failure throws a loud config error
 *  (the Bash tool is unusable without a shell). */
function shellPath(): string {
  return (cachedShell ??= resolveBashShell())
}

/** Kill the command AND its children. On Windows the spawned Git Bash is a
 *  launcher whose real shell and command run as descendants, so killing the
 *  direct child leaves `sleep 2; ...` running and the promise parked on the
 *  open stdio pipes until the command finishes on its own. */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  child.kill('SIGKILL')
}

/** Bounded head+tail byte buffer: keeps the first HEAD_BYTES and the last
 *  TAIL_BYTES, discarding the middle, so a `yes`-style flood cannot grow the
 *  heap. Bytes are decoded once at close, so a multi-byte UTF-8 character
 *  split across pipe chunks survives. */
class CappedOutput {
  private readonly head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer = Buffer.alloc(0)
  private dropped = false

  push(chunk: Buffer): void {
    if (this.headBytes < HEAD_BYTES) {
      const room = HEAD_BYTES - this.headBytes
      const take = chunk.subarray(0, Math.min(room, chunk.length))
      this.head.push(take)
      this.headBytes += take.length
      chunk = chunk.subarray(take.length)
    }
    if (chunk.length === 0) return
    const merged = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk])
    if (merged.length > TAIL_BYTES) {
      this.tail = merged.subarray(merged.length - TAIL_BYTES)
      this.dropped = true
    } else {
      this.tail = merged
    }
  }

  text(): string {
    const head = decodeShellBytes(Buffer.concat(this.head))
    const tail = this.tail.length === 0 ? '' : decodeShellBytes(this.tail)
    if (!this.dropped) return head + tail
    return `${head}\n...[truncated]...\n${tail}`
  }
}

function cap(text: string): string {
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
        killTree(child)
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
        settle({ text: `command timed out after ${timeoutMs}ms\n${cap(stdout.text() + stderr.text())}`, isError: true })
      }, timeoutMs)
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', (err) => {
        settle({ text: `failed to spawn: ${err.message}`, isError: true })
      })
      child.on('close', (code) => {
        if (timedOut) return
        const combined = cap((stdout.text() + (stderr.text() ? '\n' + stderr.text() : '')).trimEnd())
        settle({ text: `${combined}\n[exit code: ${code ?? -1}]` })
      })
    })
  },
}