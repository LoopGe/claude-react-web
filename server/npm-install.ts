// Runs `npm install -g <pkg>@latest [--registry <url>]` for the in-app
// "Update" button (only when detectInstallMethod() === 'global').
//
// Two rules, mirroring git.ts:
//
//   1. NEVER spawn through a shell. We invoke npm by running its cli.js with
//      the current node binary (`process.execPath`). This sidesteps two
//      Windows pitfalls at once:
//        - bare execFile('npm', …) throws ENOENT (npm is `npm.cmd`);
//        - spawning a `.cmd` via execFile hits Node ≥20's CVE-2024-27980
//          guard, which demands shell:true — which we refuse.
//   2. argv tokens are never string-concatenated. The package name comes
//      from our own package.json and the registry from server config, so
//      there's no request-body input on the command line regardless.
//
// A module-level in-flight guard rejects concurrent installs: two parallel
// `npm i -g` runs can corrupt the global prefix tree.

import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HttpError } from './errors.js'
import { createLogger } from './log.js'
import { MAX_BUFFER_BYTES } from './constants.js'

const log = createLogger('npm-install')
const execFileAsync = promisify(execFile)

/** npm install is slow (resolve + download + extract + global link). Git's
 *  10s ceiling is far too tight; allow two minutes. */
const INSTALL_TIMEOUT_MS = 120_000

export interface NpmInstallResult {
  stdout: string
  stderr: string
}

/** A resolved way to invoke npm without a shell. Either node + npm-cli.js
 *  (preferred), or — as a last resort — an absolute path to the npm
 *  executable / .cmd shim that we hand to execFile directly. */
interface NpmInvocation {
  /** Executable to run. */
  cmd: string
  /** Leading args (the npm-cli.js path when going through node). */
  prefix: string[]
}

let resolvedInvocation: NpmInvocation | null | undefined
let installInFlight: Promise<NpmInstallResult> | null = null

/** Locate npm's cli.js relative to the resolved npm executable. npm's layout
 *  places `bin/npm-cli.js` next to the shim:
 *    Windows global: %APPDATA%/npm/node_modules/npm/bin/npm-cli.js
 *    Unix global:    <prefix>/lib/node_modules/npm/bin/npm-cli.js
 *  We walk up from the shim path probing both the sibling-node_modules and
 *  lib/node_modules layouts. */
function findNpmCliJs(npmExecPath: string): string | null {
  const base = dirname(npmExecPath)
  const candidates = [
    join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(base, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Parse an npm cmd-shim .cmd file to extract the real script path. Mirrors
 *  resolveCmdShim() in cli.ts. */
function resolveCmdShim(cmdPath: string): string | null {
  try {
    const content = readFileSync(cmdPath, 'utf8')
    const cmdDir = dirname(cmdPath)
    const match =
      content.match(/%dp0%\\([^"]+\.js)"?\s*[%*]/) ?? content.match(/"%dp0%\\([^"]+)"/)
    if (match) {
      const resolved = join(cmdDir, match[1])
      if (existsSync(resolved)) return resolved
    }
  } catch {
    /* unreadable .cmd — fall through */
  }
  return null
}

/** Resolve how to invoke npm, once. Returns null if npm can't be located. */
function resolveNpm(): NpmInvocation | null {
  if (resolvedInvocation !== undefined) return resolvedInvocation

  const isWin = process.platform === 'win32'
  let npmExec: string | undefined

  // PATH lookup — same approach as resolveClaudeBinary() in cli.ts.
  try {
    const out = execSync(isWin ? 'where npm' : 'which npm', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out) {
      const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      // Prefer the .cmd line on Windows (that's the shim `where` reports).
      npmExec = (isWin && candidates.find((p) => p.endsWith('.cmd'))) || candidates[0]
    }
  } catch {
    /* npm not on PATH — fall through to APPDATA probe */
  }

  // Windows fallback: the global npm shim location.
  if (!npmExec && isWin && process.env.APPDATA) {
    const guess = join(process.env.APPDATA, 'npm', 'npm.cmd')
    if (existsSync(guess)) npmExec = guess
  }

  if (npmExec && existsSync(npmExec)) {
    // Preferred: run npm-cli.js with the current node — no shell, no .cmd.
    const cliJs = findNpmCliJs(npmExec)
    if (cliJs) {
      resolvedInvocation = { cmd: process.execPath, prefix: [cliJs] }
      return resolvedInvocation
    }
    // Windows shim fallback: resolve the .cmd to its underlying .js.
    if (isWin && npmExec.endsWith('.cmd')) {
      const viaShim = resolveCmdShim(npmExec)
      if (viaShim) {
        resolvedInvocation = { cmd: process.execPath, prefix: [viaShim] }
        return resolvedInvocation
      }
    }
  }

  resolvedInvocation = null
  return null
}

async function doInstall(pkg: string, registry?: string): Promise<NpmInstallResult> {
  const npm = resolveNpm()
  if (!npm) {
    throw new HttpError(503, 'npm executable not found in PATH')
  }

  // Each token is a separate argv element — never concatenated.
  const args = [...npm.prefix, 'install', '-g', `${pkg}@latest`]
  if (registry) args.push('--registry', registry)

  log.info(`running: ${npm.cmd} ${args.join(' ')}`)
  try {
    const { stdout, stderr } = await execFileAsync(npm.cmd, args, {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: 'utf8',
      windowsHide: true,
    })
    return { stdout, stderr }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: string | number
      stdout?: string
      stderr?: string
      killed?: boolean
    }
    if (typeof e.code === 'number') {
      const msg = (e.stderr || e.message || '').trim()
      throw new HttpError(500, `npm exited ${e.code}: ${msg.slice(0, 500)}`)
    }
    if (e.code === 'ENOENT') {
      // Re-probe next time in case the toolchain location changed.
      resolvedInvocation = undefined
      throw new HttpError(503, 'npm executable not found in PATH')
    }
    if (e.killed) {
      throw new HttpError(504, 'npm install timed out')
    }
    throw new HttpError(500, `npm install failed: ${e.message}`)
  }
}

/** Install `<pkg>@latest` globally from the optional registry. Concurrent
 *  calls are rejected with 409 — two parallel global installs can corrupt
 *  the npm prefix tree. */
export function runNpmInstall(pkg: string, registry?: string): Promise<NpmInstallResult> {
  if (installInFlight) {
    throw new HttpError(409, 'an update is already in progress')
  }
  const probe = doInstall(pkg, registry).finally(() => {
    installInFlight = null
  })
  installInFlight = probe
  return probe
}

/** Test hook — clears memoized npm resolution and the in-flight guard. */
export function __resetNpmInstallForTests(): void {
  resolvedInvocation = undefined
  installInFlight = null
}
