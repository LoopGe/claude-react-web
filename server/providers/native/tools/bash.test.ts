// server/providers/native/tools/bash.test.ts
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bashTool } from './bash.js'
import { ToolInputError } from './types.js'

const ctx = (cwd: string, signal = new AbortController().signal) => ({ cwd, signal })

describe('bashTool', () => {
  it('declares shell background metadata using the command as its description', () => {
    expect(bashTool.backgroundable?.taskType).toBe('shell')
    expect(bashTool.backgroundable?.describe({ command: 'sleep 10' })).toBe('sleep 10')
    // Opt-in only: absent/false keeps the foreground wait-for-output contract.
    expect(bashTool.backgroundable?.shouldBackground?.({ command: 'sleep 10', run_in_background: true })).toBe(true)
    expect(bashTool.backgroundable?.shouldBackground?.({ command: 'sleep 10', run_in_background: false })).toBe(false)
    expect(bashTool.backgroundable?.shouldBackground?.({ command: 'sleep 10' })).toBe(false)
  })

  it('description states execution semantics', () => {
    expect(bashTool.description).toBe('Run a shell command and return its output. Every call starts in the session working directory; a `cd` does not carry over to the next call, and shell state (env vars, functions) does not persist.')
  })

  it('guidance keeps exit-code rule and adds the absolute-path strategy', () => {
    expect(bashTool.guidance).toContain('[exit code: N]')
    expect(bashTool.guidance).toContain('absolute paths')
    expect(bashTool.guidance).toContain('Never prepend `cd <working-directory>`')
    expect(bashTool.guidance).not.toContain('permission prompt')
  })

  it('runs a command and appends the exit marker', async () => {
    const res = await bashTool.run({ command: 'echo hello' }, ctx(process.cwd()))
    expect(res.text).toContain('hello')
    expect(res.text.endsWith('[exit code: 0]')).toBe(true)
    expect(res.isError).toBeFalsy()
  })

  it('reports non-zero exit without is_error', async () => {
    const res = await bashTool.run({ command: 'exit 3' }, ctx(process.cwd()))
    expect(res.text.endsWith('[exit code: 3]')).toBe(true)
    expect(res.isError).toBeFalsy()
  })

  it('captures stderr', async () => {
    const res = await bashTool.run({ command: 'echo oops >&2' }, ctx(process.cwd()))
    expect(res.text).toContain('oops')
  })

  it('times out and kills the command', async () => {
    const res = await bashTool.run({ command: 'sleep 5', timeout_ms: 200 }, ctx(process.cwd()))
    expect(res.isError).toBe(true)
    expect(res.text).toContain('timed out after 200ms')
  }, 10_000)

  it('rejects an empty command', async () => {
    await expect(bashTool.run({ command: '' }, ctx(process.cwd()))).rejects.toThrow(ToolInputError)
  })

  it('truncates oversized output', async () => {
    const res = await bashTool.run({ command: 'seq 1 20000' }, ctx(process.cwd()))
    expect(res.text).toContain('...[truncated]...')
    expect(res.text.length).toBeLessThan(31_000)
  }, 15_000)
})

/** Poll until `process.kill(pid, 0)` throws — the process is gone. */
async function expectGone(pid: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise((r) => setTimeout(r, 20))
    } catch {
      return
    }
  }
  throw new Error(`pid ${pid} still alive after ${ms}ms`)
}

describe.runIf(process.platform === 'win32')('bashTool win32 tree kill', () => {
  // Git Bash's bash.exe is a launcher: the real shell and the command run as
  // descendants, so the kill must take the whole tree — a direct-child kill
  // would leave the sleeping node process behind. The timeout trigger is used
  // because its result carries the captured stdout (the descendant's pid
  // line); the abort result discards output. Both triggers call the same
  // killTree. The script-file shape keeps quoting out of the shell's parser
  // (same convention as exec.test.ts).
  it('timeout kills the sleeping descendant, not just the shell launcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bash-tree-'))
    let descendantPid = 0
    try {
      await writeFile(join(dir, 't.js'), 'console.log(process.pid); setInterval(() => {}, 1000)', 'utf8')
      const res = await bashTool.run({ command: 'node t.js & wait', timeout_ms: 1500 }, ctx(dir))
      expect(res.isError).toBe(true)
      expect(res.text).toContain('timed out after 1500ms')
      const pidLine = /^(\d+)\r?$/m.exec(res.text)
      expect(pidLine).not.toBeNull()
      descendantPid = Number(pidLine![1])
      await expectGone(descendantPid)
    } finally {
      // Backstop: a failed assertion must not leak the sleeper.
      if (descendantPid > 0) {
        spawnSync('taskkill', ['/PID', String(descendantPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      }
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
