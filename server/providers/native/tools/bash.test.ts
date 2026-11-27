// server/providers/native/tools/bash.test.ts
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeTaskManager, type TaskNotificationFacts } from '../task-manager.js'
import type { OperationalFrame } from '../vocabulary/live-frame.js'
import { runTurn, type LoopDeps } from '../loop.js'
import { defaultFrameContext } from '../../native-frames.js'
import type { CanonicalEvent } from '../canonical.js'
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

  it('rejects a missing or non-string command', async () => {
    await expect(bashTool.run({} as never, ctx(process.cwd()))).rejects.toThrow(ToolInputError)
    await expect(bashTool.run({ command: 42 } as never, ctx(process.cwd()))).rejects.toThrow(ToolInputError)
  })

  it('rejects a non-number or non-finite timeout_ms', async () => {
    await expect(bashTool.run({ command: 'echo hi', timeout_ms: 'fast' as never }, ctx(process.cwd()))).rejects.toThrow(ToolInputError)
    await expect(bashTool.run({ command: 'echo hi', timeout_ms: NaN }, ctx(process.cwd()))).rejects.toThrow(ToolInputError)
    await expect(bashTool.run({ command: 'echo hi', timeout_ms: Infinity }, ctx(process.cwd()))).rejects.toThrow(ToolInputError)
  })

  it('exposes a total validate hook the loop calls before registration', () => {
    expect(() => bashTool.validate!({} as never)).toThrow(ToolInputError)
    expect(() => bashTool.validate!({ command: 42 } as never)).toThrow(ToolInputError)
    expect(() => bashTool.validate!({ command: '   ' })).toThrow(ToolInputError)
    expect(() => bashTool.validate!({ command: 'echo hi', timeout_ms: NaN })).toThrow(ToolInputError)
    expect(() => bashTool.validate!({ command: 'echo hi', timeout_ms: 'fast' as never })).toThrow(ToolInputError)
    expect(() => bashTool.validate!({ command: 'echo hi' })).not.toThrow()
    expect(() => bashTool.validate!({ command: 'echo hi', timeout_ms: 500, run_in_background: true })).not.toThrow()
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

describe('Bash input validation through the real loop', () => {
  it('a backgrounded call with a missing command is a clean error tool result — no background record, no injection', async () => {
    const injected: TaskNotificationFacts[] = []
    const managerFrames: OperationalFrame[] = []
    const manager = new NativeTaskManager((f) => managerFrames.push(f), (n) => injected.push(n))

    const start: CanonicalEvent = { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } }
    const scripts: CanonicalEvent[][] = [
      [
        start,
        { kind: 'block_start', index: 0, block: { type: 'tool_use', id: 'bash-1', name: 'Bash' } },
        { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify({ run_in_background: true }) } },
        { kind: 'block_end', index: 0 },
        { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
      ],
      [
        start,
        { kind: 'block_start', index: 0, block: { type: 'text' } },
        { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'recovered' } },
        { kind: 'block_end', index: 0 },
        { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
      ],
    ]
    let call = 0
    const requests: unknown[] = []
    const deps: LoopDeps = {
      stream: async function* (req) {
        requests.push(structuredClone(req.messages))
        for (const ev of scripts[call++] ?? []) yield ev
      },
      tools: [bashTool],
      cwd: '/work',
      tasks: manager,
      requestPermission: async (_t, input) => ({ allowed: true, input }),
      emit: () => {},
      persistToolResult: () => {},
      attachmentProjection: {},
      system: 'SYS',
    }

    const res = await runTurn(
      deps, defaultFrameContext('sess'), [],
      { role: 'user', content: [{ type: 'text', text: 'go' }] }, 'm1', new AbortController().signal,
    )

    // The turn recovers via an error tool result, not an errored wake turn.
    expect(res.isError).toBe(false)
    expect(res.finalText).toBe('recovered')
    // The wire carries a clean ToolInputError tool result for the Bash call —
    // not the TaskOutput launch acknowledgement of a doomed background record.
    const lastMsg = (requests[1] as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: Array<{ text: string }> }> }>).at(-1)!
    const tr = lastMsg.content.find((b) => b.type === 'tool_result')!
    expect(tr.tool_use_id).toBe('bash-1')
    expect(tr.is_error).toBe(true)
    expect(tr.content![0].text).toContain('command is required')
    // Nothing was registered or injected: no lost failure notification, no
    // undefined-description wake (taskNotificationXml would throw on it).
    expect(managerFrames.some((f) => f.type === 'task/started')).toBe(false)
    expect(injected).toHaveLength(0)
    await expect(manager.output('bash-1', {}, new AbortController().signal))
      .resolves.toMatchObject({ text: expect.stringContaining('Unknown'), isError: true })
  })
})
