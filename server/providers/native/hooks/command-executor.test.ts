// server/providers/native/hooks/command-executor.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommandHook, type HookExecContext } from './command-executor.js'
import { resolveHookShell } from './shell.js'
import { getLogConfig, setLogConfig } from '../../../log.js'
import type { CommandHookConfig } from '../../../../shared/hooks.js'

const cmd = (command: string, extra: Partial<CommandHookConfig> = {}): CommandHookConfig =>
  ({ type: 'command', command, shell: 'bash', ...extra })

const ctx = (cwd: string, signal: AbortSignal = new AbortController().signal, extra: Partial<HookExecContext> = {}): HookExecContext =>
  ({ cwd, sessionId: 'test-session', signal, ...extra })

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'hook-exec-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('runCommandHook — stdin / exit contract (RS §2)', () => {
  it('delivers the event JSON on stdin (cat echoes it back)', async () => {
    const input = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }
    const r = await runCommandHook(cmd('cat'), input, ctx(dir))
    expect(r.outcome).toBe('success')
    expect(JSON.parse(r.stdout)).toEqual(input)
  })

  it('echo hi exit 0 → success', async () => {
    const r = await runCommandHook(cmd('echo hi'), {}, ctx(dir))
    expect(r.outcome).toBe('success')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hi')
    expect(r.decision).toBeUndefined()
  })

  it('exit 2 with stderr → blocked, stderr is the block message', async () => {
    const r = await runCommandHook(cmd('echo blocked-reason >&2; exit 2'), {}, ctx(dir))
    expect(r.outcome).toBe('blocked')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('blocked-reason')
  })

  it('exit 3 → non-blocking error', async () => {
    const r = await runCommandHook(cmd('exit 3'), {}, ctx(dir))
    expect(r.outcome).toBe('error')
    expect(r.exitCode).toBe(3)
  })

  it('exit-0 sync JSON decision is parsed', async () => {
    const r = await runCommandHook(cmd('echo \'{"decision":"block","reason":"nope"}\''), {}, ctx(dir))
    expect(r.outcome).toBe('success')
    expect(r.decision?.decision).toBe('block')
    expect(r.decision?.reason).toBe('nope')
  })

  it('exit-2 JSON block reason overrides stderr', async () => {
    const r = await runCommandHook(cmd('echo \'{"decision":"block","reason":"json-reason"}\'; echo stderr-reason >&2; exit 2'), {}, ctx(dir))
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toBe('json-reason')
  })

  it('runtime {"async":true} response is marked async', async () => {
    const r = await runCommandHook(cmd('echo \'{"async":true}\''), {}, ctx(dir))
    expect(r.outcome).toBe('success')
    expect(r.async).toBe(true)
  })
})

describe('runCommandHook — env surface (RS §4.7)', () => {
  const envCommand = 'echo "CC=$CLAUDECODE SID=$CLAUDE_CODE_SESSION_ID DIR=$CLAUDE_PROJECT_DIR TOOL=${CLAUDE_TOOL_NAME:-UNSET} EFFORT=${CLAUDE_EFFORT:-UNSET} EXTRA=${MY_HOOK_VAR:-UNSET}"'
  const expectedDir = () => (process.platform === 'win32' ? dir.replace(/\\/g, '/') : dir)

  // CLAUDE_EFFORT is controlled via ctx.env so the assertions do not depend on
  // the ambient process env (a host Claude Code environment already carries
  // CLAUDE_EFFORT, which the executor correctly inherits per RS §4.7).
  it('sets CLAUDECODE / CLAUDE_CODE_SESSION_ID / CLAUDE_PROJECT_DIR / CLAUDE_EFFORT, never CLAUDE_TOOL_NAME', async () => {
    const r = await runCommandHook(cmd(envCommand), {}, ctx(dir, undefined, {
      effortLevel: 'high', env: { MY_HOOK_VAR: 'xyz', CLAUDE_EFFORT: 'should-be-overridden' },
    }))
    expect(r.outcome).toBe('success')
    expect(r.stdout).toContain('CC=1')
    expect(r.stdout).toContain('SID=test-session')
    expect(r.stdout).toContain(`DIR=${expectedDir()}`)
    // effortLevel wins over both the inherited env and the ctx.env override.
    expect(r.stdout).toContain('EFFORT=high')
    expect(r.stdout).toContain('EXTRA=xyz')
    expect(r.stdout).toContain('TOOL=UNSET')
  })

  it('inherits CLAUDE_EFFORT when no effortLevel is given (does not inject)', async () => {
    const r = await runCommandHook(cmd(envCommand), {}, ctx(dir, undefined, { env: { CLAUDE_EFFORT: 'inherited-value' } }))
    expect(r.stdout).toContain('EFFORT=inherited-value')
    expect(r.stdout).toContain('TOOL=UNSET')
  })
})

describe('runCommandHook — timeout / abort (RS §4.5)', () => {
  it('timeout → cancelled, promise settles', async () => {
    const r = await runCommandHook(cmd('sleep 5', { timeout: 0.3 }), {}, ctx(dir))
    expect(r.outcome).toBe('cancelled')
    expect(r.stderr).toContain('timed out after 300ms')
  }, 10_000)

  it('abort signal → cancelled, promise settles', async () => {
    const ac = new AbortController()
    const p = runCommandHook(cmd('sleep 5'), {}, ctx(dir, ac.signal))
    setTimeout(() => ac.abort(), 100)
    const r = await p
    expect(r.outcome).toBe('cancelled')
  }, 10_000)

  it('pre-aborted signal → cancelled without spawning', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runCommandHook(cmd('echo hi'), {}, ctx(dir, ac.signal))
    expect(r.outcome).toBe('cancelled')
  })

  it('onFailure:block + timeout → blocked (timed out)', async () => {
    const r = await runCommandHook(cmd('sleep 5', { timeout: 0.3, onFailure: 'block' }), {}, ctx(dir))
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toContain('timed out; blocking because onFailure is "block"')
  }, 10_000)

  it('onFailure:block + exit 3 → blocked (failed)', async () => {
    const r = await runCommandHook(cmd('echo bad >&2; exit 3', { onFailure: 'block' }), {}, ctx(dir))
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toContain('failed; blocking because onFailure is "block"')
    expect(r.stderr).toContain('bad')
  })
})

describe('runCommandHook — spawn failure', () => {
  it('missing cwd → error result (failed to spawn)', async () => {
    const missing = join(tmpdir(), `hook-exec-missing-${Date.now()}`)
    const r = await runCommandHook(cmd('echo hi'), {}, ctx(missing))
    expect(r.outcome).toBe('error')
    expect(r.stderr).toContain('failed to spawn')
  })

  it('onFailure:block + spawn failure → blocked', async () => {
    const missing = join(tmpdir(), `hook-exec-missing-${Date.now()}`)
    const r = await runCommandHook(cmd('echo hi', { onFailure: 'block' }), {}, ctx(missing))
    expect(r.outcome).toBe('blocked')
  })
})

// Review Focus 1: a flooding command must be truncated, heap bounded, and the
// promise must settle. The bounded-length assertion is the observable proof the
// accumulator discarded the middle (a naive concat would return the full flood).
describe('runCommandHook — flood bounding (Review Focus 1)', () => {
  it('yes | head -c 200000 → truncated, bounded length, success', async () => {
    const r = await runCommandHook(cmd('yes | head -c 200000'), {}, ctx(dir))
    expect(r.outcome).toBe('success')
    expect(r.stdout).toContain('...[truncated]...')
    expect(r.stdout.length).toBeLessThan(31_000)
  }, 15_000)

  it('yes (infinite flood) + tiny timeout → cancelled, bounded, settles', async () => {
    const r = await runCommandHook(cmd('yes', { timeout: 0.5 }), {}, ctx(dir))
    expect(r.outcome).toBe('cancelled')
    expect(r.stdout.length).toBeLessThan(31_000)
  }, 10_000)
})

describe.runIf(process.platform === 'win32')('runCommandHook win32 tree kill', () => {
  async function expectGone(pid: number, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)) } catch { return }
    }
    throw new Error(`pid ${pid} still alive after ${ms}ms`)
  }

  it('timeout kills the sleeping descendant, not just the shell launcher', async () => {
    const sub = await mkdtemp(join(tmpdir(), 'hook-tree-'))
    let descendantPid = 0
    try {
      await writeFile(join(sub, 't.js'), 'console.log(process.pid); setInterval(() => {}, 1000)', 'utf8')
      const r = await runCommandHook(cmd('node t.js & wait', { timeout: 1.5 }), {}, ctx(sub))
      expect(r.outcome).toBe('cancelled')
      const pidLine = /^(\d+)\r?$/m.exec(r.stdout)
      expect(pidLine).not.toBeNull()
      descendantPid = Number(pidLine![1])
      await expectGone(descendantPid)
    } finally {
      if (descendantPid > 0) spawnSync('taskkill', ['/PID', String(descendantPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      await rm(sub, { recursive: true, force: true })
    }
  }, 20_000)
})

describe.runIf(process.platform === 'win32')('runCommandHook powershell (RS §4.8)', () => {
  const ps = (command: string, extra: Partial<CommandHookConfig> = {}): CommandHookConfig =>
    ({ type: 'command', command, shell: 'powershell', ...extra })

  it('Write-Output hello → success', async () => {
    const r = await runCommandHook(ps('Write-Output hello'), {}, ctx(dir))
    expect(r.outcome).toBe('success')
    expect(r.stdout).toContain('hello')
  })

  it('delivers stdin JSON via [Console]::In', async () => {
    const input = { session_id: 'ps1', hook_event_name: 'Stop' }
    const r = await runCommandHook(ps('$j = [Console]::In.ReadToEnd(); Write-Output $j'), input, ctx(dir))
    expect(r.outcome).toBe('success')
    expect(JSON.parse(r.stdout)).toEqual(input)
  })

  it('exit 2 with stderr → blocked', async () => {
    const r = await runCommandHook(ps('[Console]::Error.WriteLine("ps-blocked"); exit 2'), {}, ctx(dir))
    expect(r.outcome).toBe('blocked')
    expect(r.stderr).toContain('ps-blocked')
  })

  it('yEr transform: ${CLAUDE_PROJECT_DIR} reads the env value in PowerShell', async () => {
    const r = await runCommandHook(ps('Write-Output "${CLAUDE_PROJECT_DIR}"'), {}, ctx(dir))
    expect(r.outcome).toBe('success')
    // PowerShell kind keeps the native Windows path (no backslash normalization).
    expect(r.stdout.trim()).toBe(dir)
  })

  // hn exit propagation (binary-verified): PowerShell does not surface a native
  // command's exit code as its own. cmd.exe is native from PowerShell's view, so
  // its exit code lands in $LASTEXITCODE; without the wrapper powershell.exe exits
  // 0 and the exit-2 block silently fails on the win32 default PowerShell path.
  it('a NATIVE command exiting 2 propagates through the wrapper → blocked', async () => {
    const r = await runCommandHook(ps('cmd /c exit 2'), {}, ctx(dir))
    expect(r.outcome).toBe('blocked')
    expect(r.exitCode).toBe(2)
  })

  it('a NATIVE command exiting 3 propagates → non-blocking error', async () => {
    const r = await runCommandHook(ps('cmd /c exit 3'), {}, ctx(dir))
    expect(r.outcome).toBe('error')
    expect(r.exitCode).toBe(3)
  })

  it('a NATIVE command exiting 0 stays success through the wrapper', async () => {
    const r = await runCommandHook(ps('cmd /c exit 0'), {}, ctx(dir))
    expect(r.outcome).toBe('success')
    expect(r.exitCode).toBe(0)
  })

  it('a terminating PowerShell error is caught → exit 1 (non-blocking error)', async () => {
    const r = await runCommandHook(ps('throw "ps-terminating-boom"'), {}, ctx(dir))
    expect(r.outcome).toBe('error')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('ps-terminating-boom')
  })
})

describe('resolveHookShell (RS §4.8)', () => {
  it('POSIX default → bash', () => {
    expect(resolveHookShell(undefined, { platform: 'linux' })).toEqual({ path: '/bin/bash', kind: 'bash' })
  })

  it('explicit bash on POSIX → /bin/bash', () => {
    expect(resolveHookShell('bash', { platform: 'linux' })).toEqual({ path: '/bin/bash', kind: 'bash' })
  })

  it('win32 default without Git Bash → powershell (pwsh preferred)', () => {
    const r = resolveHookShell(undefined, {
      platform: 'win32', env: { PATH: 'C:\\ps' }, exists: (p) => p === 'C:\\ps\\pwsh.exe',
    })
    expect(r).toEqual({ path: 'C:\\ps\\pwsh.exe', kind: 'powershell' })
  })

  // The fallback warn is gated on the override being set: a broken
  // CLAUDE_CODE_GIT_BASH_PATH is a misconfiguration that must surface, while
  // the normal Git-Bash-absent default stays quiet (no per-resolution spam).
  // Log config is pinned and restored so ambient LOG_LEVEL/LOG_SCOPES cannot
  // mute or filter the line under test.
  it('broken CLAUDE_CODE_GIT_BASH_PATH override on win32 default → warns AND falls back', () => {
    const snapshot = getLogConfig()
    setLogConfig({ level: 'warn', scopes: null })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = resolveHookShell(undefined, {
        platform: 'win32',
        env: { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\missing\\bash.exe', PATH: 'C:\\ps' },
        exists: (p) => p === 'C:\\ps\\pwsh.exe',
      })
      expect(r).toEqual({ path: 'C:\\ps\\pwsh.exe', kind: 'powershell' })
      const warned = warnSpy.mock.calls.some(([tag, msg]) =>
        tag === '[native-hooks]' && String(msg).includes('CLAUDE_CODE_GIT_BASH_PATH'))
      expect(warned).toBe(true)
    } finally {
      warnSpy.mockRestore()
      setLogConfig({ level: snapshot.level, scopes: snapshot.scopes ?? null })
    }
  })

  it('normal Git-Bash-absent win32 default falls back silently (no warn)', () => {
    const snapshot = getLogConfig()
    setLogConfig({ level: 'warn', scopes: null })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = resolveHookShell(undefined, {
        platform: 'win32', env: { PATH: 'C:\\ps' }, exists: (p) => p === 'C:\\ps\\pwsh.exe',
      })
      expect(r).toEqual({ path: 'C:\\ps\\pwsh.exe', kind: 'powershell' })
      const warned = warnSpy.mock.calls.some(([tag]) => tag === '[native-hooks]')
      expect(warned).toBe(false)
    } finally {
      warnSpy.mockRestore()
      setLogConfig({ level: snapshot.level, scopes: snapshot.scopes ?? null })
    }
  })

  it('powershell probe falls back to powershell.exe when pwsh absent', () => {
    const r = resolveHookShell('powershell', {
      platform: 'win32', env: { PATH: 'C:\\ps' }, exists: (p) => p === 'C:\\ps\\powershell.exe',
    })
    expect(r).toEqual({ path: 'C:\\ps\\powershell.exe', kind: 'powershell' })
  })

  it('pwsh preferred over powershell when both on PATH', () => {
    const r = resolveHookShell('powershell', {
      platform: 'win32', env: { PATH: 'C:\\ps' }, exists: (p) => p === 'C:\\ps\\pwsh.exe' || p === 'C:\\ps\\powershell.exe',
    })
    expect(r.path).toBe('C:\\ps\\pwsh.exe')
  })

  it('powershell absent → throws loudly', () => {
    expect(() => resolveHookShell('powershell', { platform: 'win32', env: { PATH: '' }, exists: () => false }))
      .toThrow(/no PowerShell executable/)
  })

  it('explicit bash on win32 without Git Bash → throws (no silent fallback)', () => {
    expect(() => resolveHookShell('bash', { platform: 'win32', env: {}, exists: () => false }))
      .toThrow(/Git Bash not found/)
  })

  it('POSIX powershell probe finds pwsh on PATH', () => {
    const r = resolveHookShell('powershell', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: (p) => p === '/usr/bin/pwsh' })
    expect(r).toEqual({ path: '/usr/bin/pwsh', kind: 'powershell' })
  })
})
