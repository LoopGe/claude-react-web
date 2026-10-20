// The daemon only drives the PRODUCTION bundle: dist/daemon.mjs supervises
// its sibling dist/cli.mjs. Under tsx (dev) there is no dist to point at, so
// we refuse loudly instead of guessing a source-mode command.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DaemonEntryPaths {
  nodePath: string
  daemonEntry: string
  serverEntry: string
}

export const DEV_UNSUPPORTED =
  'The daemon drives the production bundle — run `npm run build` and use the built server (or the installed package) to manage auto-start; tsx dev mode cannot register or reach it.'

/** The dist directory when the calling module IS one of the two production
 *  entry bundles, else null. Both entries live side by side in dist/, so the
 *  directory — not this file's own name — is the identity: a module inlined
 *  into dist/cli.mjs must resolve the SAME dist as one inlined into
 *  dist/daemon.mjs. Anchor on the entry FILENAME so a repo checked out under
 *  a .../dist/... path never reads as bundled. */
export function distDirOf(moduleUrl: string): string | null {
  const p = moduleUrl.replaceAll('\\', '/')
  const m = /\/dist\/(cli|daemon)\.mjs$/.exec(p)
  return m ? p.slice(0, p.lastIndexOf('/')) : null
}

export function isBundledDaemon(): boolean {
  return distDirOf(fileURLToPath(import.meta.url)) != null
}

export function resolveDaemonEntryPaths(): DaemonEntryPaths {
  const distDir = distDirOf(fileURLToPath(import.meta.url))
  if (distDir == null) {
    throw new Error(DEV_UNSUPPORTED)
  }
  // ALWAYS the supervisor, even when called from the server bundle: enable
  // runs inside dist/cli.mjs, and registering the caller's own path would
  // autostart a bare unsupervised server.
  return { nodePath: process.execPath, daemonEntry: join(distDir, 'daemon.mjs'), serverEntry: join(distDir, 'cli.mjs') }
}

export function daemonLogPaths(stateDir: string): { daemonLog: string; serverLog: string } {
  const dir = join(stateDir, 'daemon')
  return { daemonLog: join(dir, 'daemon.log'), serverLog: join(dir, 'server.log') }
}
