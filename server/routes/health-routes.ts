// Health probes for backing executables. Currently just `claude` itself —
// the CLI subprocess is the single most common reason a session fails to
// start, and the failure mode (ENOENT during spawn) only surfaces deep
// inside the SDK with a misleading "process exited code=null" wrapper.
//
// The setup wizard's Step 0 calls GET /health/claude on mount so it can
// pre-empt that confusing failure with a clear "install claude" message.
//
// Caching: only SUCCESSFUL probes are held in module-level state. We
// deliberately do NOT cache failures — a transient hiccup (the binary
// took 3.1s to print --version once because the host was under load,
// or a wrapper script briefly returned non-zero) would otherwise stick
// forever and tell every page-load "CLI not detected" until the user
// clicked Recheck. The cost of re-probing on each failed page-load is
// one execFile call, dwarfed by the cost of a confused user.
//
// Invalidation is also explicit — `invalidateClaudeHealth()` is
// exported so session-manager can clear the cache when ProcessMonitor
// reports a spawn ENOENT/EACCES (the user may have moved or replaced
// the binary between our last probe and a session attempt, and a
// previously-cached "ok" snapshot would now be stale).

import { Hono } from 'hono'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type HealthReason = 'not_found' | 'spawn_failed' | 'exec_failed' | 'unknown'

export interface ClaudeHealth {
  ok: boolean
  binary?: string
  version?: string
  error?: string
  reason?: HealthReason
}

let cached: ClaudeHealth | undefined

/** Clear the cached probe result. Called from SessionManager when a
 *  spawn fails with ENOENT — the binary may have been installed since
 *  our last probe, so the next /health/claude request should re-probe
 *  rather than serve a stale "ok: true" snapshot. */
export function invalidateClaudeHealth(): void {
  cached = undefined
}

/** Probe `<binary> --version`. Returns a structured result describing
 *  what went wrong; the caller decides how to surface it. The probe
 *  uses execFile (no shell) with a fixed timeout so a hung CLI can't
 *  block the request. */
async function probeClaude(binary: string | undefined): Promise<ClaudeHealth> {
  if (!binary) {
    return {
      ok: false,
      reason: 'not_found',
      error:
        'claude CLI binary was not found on this server. ' +
        'Install it (npm i -g @anthropic-ai/claude-code) or set CLAUDE_CODE_BINARY.',
    }
  }
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], {
      timeout: 3000,
      // Default `killSignal` is SIGTERM; a wrapper script that traps
      // SIGTERM (for graceful shutdown) survives the timeout, the
      // request returns exec_failed, and the orphaned process keeps
      // running. SIGKILL is uncatchable — guarantees the timed-out
      // probe doesn't leak across repeated Recheck clicks.
      killSignal: 'SIGKILL',
      windowsHide: true,
    })
    const version = stdout.trim().split(/\r?\n/)[0] || 'unknown'
    return { ok: true, binary, version }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      return {
        ok: false,
        binary,
        reason: 'spawn_failed',
        error: `claude binary at ${binary} could not be spawned (ENOENT)`,
      }
    }
    if (e.code === 'EACCES') {
      return {
        ok: false,
        binary,
        reason: 'spawn_failed',
        error: `claude binary at ${binary} is not executable (EACCES)`,
      }
    }
    return {
      ok: false,
      binary,
      reason: 'exec_failed',
      error: e.message || 'claude --version failed',
    }
  }
}

/** Probe `claude --version` with the same module-level cache used by
 *  GET /health/claude. Exported so other routes (notably the About tab's
 *  `/update-info`) can surface the CLI version without round-tripping
 *  through the dedicated health endpoint and without spawning a fresh
 *  execFile per request. Cache semantics match the route: only OK
 *  results stick; failures always re-probe on the next call. */
export async function getClaudeHealth(
  claudeBinary: string | undefined,
  force = false,
): Promise<ClaudeHealth> {
  if (!force && cached) return cached
  const result = await probeClaude(claudeBinary)
  if (result.ok) cached = result
  return result
}

export function buildHealthRouter(claudeBinary: string | undefined): Hono {
  const app = new Hono()

  // Probe with caching. `?force=1` bypasses the cache (used by Step 0's
  // Recheck button — without it, a user installing the CLI mid-wizard
  // would see the same "not found" result forever).
  //
  // Only OK results enter the cache. A failure path always re-probes on
  // the next request so a transient timeout / spurious EACCES doesn't
  // stick across the entire session. This keeps "all good" cheap (one
  // probe per process lifetime) without the staleness risk on the
  // failure path.
  app.get('/health/claude', async (c) => {
    const force = c.req.query('force') === '1'
    return c.json(await getClaudeHealth(claudeBinary, force))
  })

  return app
}
