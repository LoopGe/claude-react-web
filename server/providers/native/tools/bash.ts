// server/providers/native/tools/bash.ts
import { spawn } from 'node:child_process'
import { ToolInputError, type ToolDef } from './types.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const HEAD_CHARS = 25_000
const TAIL_CHARS = 5_000

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
      const child = spawn('/bin/bash', ['-c', input.command], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let timer: NodeJS.Timeout | undefined
      let timedOut = false
      const kill = () => child.kill('SIGKILL')
      child.stdout.on('data', (d) => { stdout += String(d) })
      child.stderr.on('data', (d) => { stderr += String(d) })
      timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
      ctx.signal.addEventListener('abort', kill, { once: true })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolvePromise({ text: `failed to spawn: ${err.message}`, isError: true })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (timedOut) {
          resolvePromise({ text: `command timed out after ${timeoutMs}ms\n${cap(stdout + stderr)}`, isError: true })
          return
        }
        const combined = cap((stdout + (stderr ? '\n' + stderr : '')).trimEnd())
        resolvePromise({ text: `${combined}\n[exit code: ${code ?? -1}]` })
      })
    })
  },
}
