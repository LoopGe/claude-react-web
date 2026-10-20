// The daemon only drives the PRODUCTION bundle: dist/daemon.mjs spawns its
// sibling dist/cli.mjs. Under tsx (dev) there is no dist to point at, so we
// refuse loudly instead of guessing a source-mode command.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DaemonEntryPaths {
  nodePath: string
  daemonEntry: string
  serverEntry: string
}

export function isBundledDaemon(): boolean {
  return fileURLToPath(import.meta.url).replaceAll('\\', '/').includes('/dist/')
}

export function resolveDaemonEntryPaths(): DaemonEntryPaths {
  if (!isBundledDaemon()) {
    throw new Error(
      'The daemon only runs the production bundle — run `npm run build` first '
      + "(or install the package); dev mode (tsx) is not supported here.",
    )
  }
  const daemonEntry = fileURLToPath(import.meta.url)
  return { nodePath: process.execPath, daemonEntry, serverEntry: join(dirname(daemonEntry), 'cli.mjs') }
}

export function daemonLogPaths(stateDir: string): { daemonLog: string; serverLog: string } {
  const dir = join(stateDir, 'daemon')
  return { daemonLog: join(dir, 'daemon.log'), serverLog: join(dir, 'server.log') }
}
