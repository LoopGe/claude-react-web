// dist/daemon.mjs entry. Registered at OS login as:
//   node <abs>/daemon.mjs --state-dir <abs>
// It supervises the sibling dist/cli.mjs via the file protocol in control.ts.
// The server itself loads its own config.json; the daemon only owns the
// process lifecycle and the heartbeat/marker files.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readStatusFile, HEARTBEAT_FRESH_MS } from './control.js'
import { startSupervisor } from './supervisor.js'
import { resolveDaemonEntryPaths } from './paths.js'

export interface DaemonStatusLike { daemonPid: number; state: string; updatedAt: number }

export function parseDaemonArgv(argv: string[]): { stateDir: string } {
  let stateDir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === '--state-dir') {
      stateDir = argv[++i]
      if (stateDir == null) throw new Error('option --state-dir requires a value')
      continue
    }
    if (raw.startsWith('--state-dir=')) { stateDir = raw.slice('--state-dir='.length); continue }
    if (raw.startsWith('--')) throw new Error(`unknown option: ${raw}`)
    throw new Error(`unexpected argument: ${raw}`)
  }
  return { stateDir: stateDir ?? join(homedir(), '.claude-react-web') }
}

export function isSingletonBlocked(status: DaemonStatusLike | null, isAlive: (pid: number) => boolean): boolean {
  if (status == null) return false
  if (Date.now() - status.updatedAt >= HEARTBEAT_FRESH_MS) return false
  return isAlive(status.daemonPid)
}

async function main(): Promise<void> {
  const { stateDir } = parseDaemonArgv(process.argv.slice(2))
  const existing = await readStatusFile(stateDir)
  const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
  if (isSingletonBlocked(existing, pidAlive)) {
    // Another daemon is alive — exit quietly (natural idempotency when the
    // scheduled task fires twice or the user starts one manually).
    process.exit(0)
  }
  const { serverEntry } = resolveDaemonEntryPaths()

  startSupervisor({
    stateDir,
    spawnChild: () => {
      const child = spawn(process.execPath, [serverEntry, '--state-dir', stateDir, '--no-open'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CRW_DAEMON_CHILD: '1' },
        windowsHide: true,
      })
      // The supervised server's stdout/stderr → <stateDir>/daemon/server.log,
      // so the daemon's platform redirection (daemon.log) stays daemon-only.
      const out = createWriteStream(join(stateDir, 'daemon', 'server.log'), { flags: 'a' })
      child.stdout?.pipe(out)
      child.stderr?.pipe(out)
      return {
        pid: child.pid!,
        on: (event, cb) => { if (event === 'exit') child.on('exit', (code, signal) => cb(code, signal)) },
      }
    },
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms)
      t.unref()
      return () => clearTimeout(t)
    },
  })

  const shutdown = (): void => { process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
