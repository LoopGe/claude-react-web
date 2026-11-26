// server/providers/native/hooks/command-executor.ts
// Runs a `type:'command'` hook: spawn the resolved shell, feed the event JSON on
// stdin, capture stdout/stderr/exit under a bounded accumulator, enforce the
// timeout / abort signal by killing the process tree, then hand the raw capture
// to the output contract (parseHookOutput + applyOnFailure). Shares the spawn /
// kill / bounded-output discipline of tools/bash.ts via tools/process-output.ts;
// the difference is stdin 'pipe' (bash uses 'ignore') so the event JSON can be
// written.
import { spawn } from 'node:child_process'
import { createLogger } from '../../../log.js'
import { captureBirthTime } from '../../../win32-job.js'
import { capToolText } from '../tools/bash.js'
import { CappedOutput, killTree } from '../tools/process-output.js'
import type { CommandHookConfig, HookShell } from '../../../../shared/hooks.js'
import { parseHookOutput, applyOnFailure, type HookExecResult } from './output.js'
import { resolveHookShell } from './shell.js'

const log = createLogger('native-hooks')

const DEFAULT_TIMEOUT_MS = 600_000
// setTimeout's 32-bit ceiling (RS §4.5, CLI `tc=2147483647`).
const MAX_TIMEOUT_MS = 2_147_483_647

export interface HookExecContext {
  cwd: string
  sessionId: string
  signal: AbortSignal
  effortLevel?: string
  env?: NodeJS.ProcessEnv
}

/** The CLI `yEr` PowerShell command transform (RS §4.8): `${CLAUDE_PROJECT_DIR}`
 *  / `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` are rewritten to
 *  `${env:NAME}` so PowerShell reads the environment value instead of an
 *  undefined variable. A function replacer avoids `$` replacement-pattern
 *  semantics, exactly as the CLI does. */
const PS_ENV_VARS = ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA'] as const
function toPowerShellCommand(command: string): string {
  let out = command
  for (const name of PS_ENV_VARS) out = out.replaceAll('${' + name + '}', () => '${env:' + name + '}')
  return out
}

/** The CLI `mX()` + `KVn()` PowerShell argv: -NoProfile -NonInteractive, then
 *  -ExecutionPolicy Bypass unless CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY
 *  is set, then -Command <command>. */
function powerShellArgs(command: string, env: NodeJS.ProcessEnv): string[] {
  const args = ['-NoProfile', '-NonInteractive']
  if (!env.CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY) args.push('-ExecutionPolicy', 'Bypass')
  args.push('-Command', command)
  return args
}

/** Inherited process env + caller overrides + the CLI env surface (RS §4.7).
 *  Tool facts are stdin-only — there is NO CLAUDE_TOOL_NAME / CLAUDE_TOOL_INPUT.
 *  CLAUDE_PROJECT_DIR is backslash-normalized for win32 bash (the CLI `Qt`), and
 *  left as the native path for PowerShell. */
function hookEnv(ctx: HookExecContext, kind: HookShell): NodeJS.ProcessEnv {
  const projectDir = process.platform === 'win32' && kind === 'bash' ? ctx.cwd.replace(/\\/g, '/') : ctx.cwd
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...ctx.env,
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: ctx.sessionId,
    CLAUDE_PROJECT_DIR: projectDir,
  }
  if (ctx.effortLevel !== undefined) env.CLAUDE_EFFORT = ctx.effortLevel
  return env
}

export async function runCommandHook(
  hook: CommandHookConfig,
  input: Record<string, unknown>,
  ctx: HookExecContext,
): Promise<HookExecResult> {
  // RS §4.5: per-hook timeout (seconds) clamped to the 32-bit ceiling, else the
  // 600s command default. The CLI uses truthiness (`ar.timeout ? ... : xf`).
  const timeoutMs = hook.timeout ? Math.min(hook.timeout * 1000, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS

  if (ctx.signal.aborted) {
    return applyOnFailure(hook, { outcome: 'cancelled', stdout: '', stderr: 'hook aborted' })
  }

  let shell
  try {
    shell = resolveHookShell(hook.shell)
  } catch (err) {
    // A start failure is a hook error (RS §2.4), not an engine crash; the
    // message surfaces through the result and onFailure:'block' can block on it.
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`command hook shell resolution failed: ${message}`)
    return applyOnFailure(hook, { outcome: 'error', stdout: '', stderr: `failed to resolve shell: ${message}` })
  }

  const env = hookEnv(ctx, shell.kind)
  const args = shell.kind === 'powershell'
    ? powerShellArgs(toPowerShellCommand(hook.command), env)
    : ['-c', hook.command]

  return new Promise((resolvePromise) => {
    const child = spawn(shell.path, args, {
      cwd: ctx.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // Spawn-time creation identity: the win32 tree kill refuses a PID whose live
    // creation time no longer matches (PID reuse fence).
    const birthTime = process.platform === 'win32' && child.pid !== undefined
      ? captureBirthTime(child.pid)
      : null
    const stdout = new CappedOutput()
    const stderr = new CappedOutput()
    let settled = false
    const settle = (result: HookExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      resolvePromise(applyOnFailure(hook, result))
    }
    const kill = () => {
      killTree(child, birthTime)
      // The killed tree's stdio pipes can outlive the processes by seconds; our
      // read ends must not keep the call (or the event loop) waiting.
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    const onAbort = () => {
      kill()
      settle({ outcome: 'cancelled', stdout: capToolText(stdout.text()), stderr: 'hook aborted' })
    }
    child.stdout.on('data', (d: Buffer) => stdout.push(d))
    child.stderr.on('data', (d: Buffer) => stderr.push(d))
    // EPIPE is expected when the command exits before reading its stdin (e.g.
    // `exit 2` immediately) — the exit code already carries the outcome. The CLI
    // logs and moves on; anything other than EPIPE is a real write failure.
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') log.warn(`command hook stdin write failed: ${err.message}`)
    })
    // Settle on the kill, not on 'close': waiting for the pipes to drain would
    // let a long-running child hold the hook open past its timeout.
    const timer = setTimeout(() => {
      kill()
      settle({ outcome: 'cancelled', stdout: capToolText(stdout.text()), stderr: `hook timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      settle({ outcome: 'error', stdout: '', stderr: `failed to spawn: ${err.message}` })
    })
    child.on('close', (code) => {
      settle(parseHookOutput(capToolText(stdout.text()), capToolText(stderr.text()), code ?? -1, hook))
    })
    child.stdin.end(JSON.stringify(input))
  })
}
