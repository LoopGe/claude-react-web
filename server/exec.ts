// Shell command runner for `!` bash mode.
//
// Executes an arbitrary user-typed command in the session's cwd using the
// system shell (SHELL on unix, ComSpec on Windows), so pipes / redirects /
// globs work. This is the same trust posture as Claude Code's `!` mode:
// the user typed it, it runs unsandboxed. The confirm gate in the route is
// the guardrail, not path validation (a `cd /` inside the command is
// intentional shell behavior we must preserve).
//
// Unlike git.ts's runGit (execFile, fixed argv, no shell), here we
// deliberately pass the raw command to the shell's `-c` / `/c` — that IS the
// feature. We never use `shell: true` with an unescaped argv; we hand the
// command to the shell binary explicitly so the shell's own parser is the
// authority.

import { spawn } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { createLogger } from './log.js'
import { decodeShellBytes } from './shell-encoding.js'
import { COMMAND_PREVIEW_CAP } from './constants.js'

const log = createLogger('exec')

/** Hard cap on captured output. Matches the spirit of git.ts's MAX_DIFF_LINES:
 *  we keep the full output bounded so it can't blow the SDK's context window
 *  when injected as a <bash-stdout> message. Over the cap → head + tail trim
 *  with an elision marker. */
const MAX_OUTPUT_BYTES = 1_000_000
const HEAD_BYTES = 400_000
const TAIL_BYTES = 400_000

export interface ExecOptions {
  /** Optional abort signal (e.g. tied to the user-driven /exec/abort stop
   *  button). SIGKILLs the child when fired. */
  signal?: AbortSignal
  /** Streamed line callback for live progress UI. Receives each new line of
   *  combined stdout+stderr as it lands. */
  onProgress?: (line: string) => void
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  interrupted: boolean
  truncated: boolean
}

/** Resolve the shell binary + flag for `-c` invocation. Mirrors the
 *  claude-provider env passthrough (SHELL / ComSpec). Falls back to sh on
 *  unix and cmd on Windows. */
function resolveShell(): { binary: string; flag: string } {
  if (process.platform === 'win32') {
    return { binary: process.env.ComSpec ?? 'cmd.exe', flag: '/c' }
  }
  return { binary: process.env.SHELL ?? '/bin/sh', flag: '-c' }
}

/** Trim a buffer/string to head+tail with an elision marker when it exceeds
 *  MAX_OUTPUT_BYTES. Returns { text, truncated }. */
function capOutput(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= MAX_OUTPUT_BYTES) return { text: raw, truncated: false }
  const head = raw.slice(0, HEAD_BYTES)
  const tail = raw.slice(-TAIL_BYTES)
  const omitted = raw.length - HEAD_BYTES - TAIL_BYTES
  return {
    text: `${head}\n\n… [${omitted.toLocaleString()} bytes omitted] …\n\n${tail}`,
    truncated: true,
  }
}

/** Execute `command` in `cwd` via the system shell. Never rejects — failures
 *  (non-zero exit, interrupt) are reported via the result fields so the caller
 *  can inject a uniform <bash-*> message regardless of outcome.
 *
 *  No wall-clock timeout: a long-running command runs until it exits or the
 *  user stops it via the abort signal (the stop button on the bash card,
 *  wired through /exec/abort). Session unload/delete aborts too, so an
 *  in-flight child never outlives its session. */
export function execCommand(cwd: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const { binary, flag } = resolveShell()
    // Raw bytes are accumulated per stream and decoded once at the end by
    // decodeShellBytes (strict UTF-8 first, shell codepage fallback). The
    // encoding choice needs the whole buffer — a UTF-8 sequence split across
    // chunks must not be judged mid-character — so we cannot decode
    // incrementally for the authoritative result. onProgress still gets live
    // lines via a best-effort UTF-8 streaming decoder below (progress is
    // ephemeral UI; the bash card's body is the decoded result).
    const raw: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }
    let lineBuf = ''
    let settled = false

    // Best-effort UTF-8 for live progress lines only. stream:true keeps
    // multibyte sequences split across chunks intact. UTF-8 because that is
    // what modern tools emit; a GBK line may show mojibake here transiently
    // but is correct in the final result. One decoder per stream so an
    // interleaved stdout/stderr chunk pair can't splice their partial
    // multibyte sequences together. (lineBuf below is still shared across
    // both streams — pre-existing, and progress lines are best-effort.)
    const progressDecoders: Readonly<Record<'stdout' | 'stderr', TextDecoder>> = {
      stdout: new TextDecoder('utf-8', { fatal: false }),
      stderr: new TextDecoder('utf-8', { fatal: false }),
    }

    const finish = (partial: Partial<ExecResult>) => {
      if (settled) return
      settled = true
      const stdout = decodeShellBytes(Buffer.concat(raw.stdout))
      const stderr = decodeShellBytes(Buffer.concat(raw.stderr))
      const cappedOut = capOutput(stdout)
      const cappedErr = capOutput(stderr)
      resolve({
        stdout: cappedOut.text,
        stderr: cappedErr.text,
        exitCode: partial.exitCode ?? null,
        interrupted: partial.interrupted ?? false,
        truncated: cappedOut.truncated || cappedErr.truncated,
      })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, [flag, command], {
        cwd,
        env: { ...process.env, CLAUDECODE: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      log.error(`spawn failed for "${command.slice(0, COMMAND_PREVIEW_CAP)}":`, err)
      finish({ exitCode: -1 })
      return
    }

    const onChunk = (stream: NodeJS.ReadableStream, bucket: 'stdout' | 'stderr') => {
      stream.on('data', (chunk: Buffer) => {
        raw[bucket].push(chunk)
        // Line-buffer for progress: emit complete lines as they arrive.
        lineBuf += progressDecoders[bucket].decode(chunk, { stream: true })
        let nl: number
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl)
          lineBuf = lineBuf.slice(nl + 1)
          opts.onProgress?.(line)
        }
      })
    }
    if (child.stdout) onChunk(child.stdout, 'stdout')
    if (child.stderr) onChunk(child.stderr, 'stderr')

    const onAbort = () => {
      log.info(`command aborted: "${command.slice(0, COMMAND_PREVIEW_CAP)}"`)
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ interrupted: true })
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (err) => {
      log.error(`child error for "${command.slice(0, COMMAND_PREVIEW_CAP)}":`, err)
      finish({ exitCode: -1 })
    })
    child.on('close', (code) => {
      // Flush any trailing partial line to progress.
      if (lineBuf.length > 0) opts.onProgress?.(lineBuf)
      finish({ exitCode: code ?? 0 })
    })
  })
}

/** XML-escape a string for safe embedding in <bash-stdout> / <bash-stderr>
 *  tags. The renderer extracts these tags by name and displays the content
 *  verbatim, so we only need to neutralize the tag delimiters themselves. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
