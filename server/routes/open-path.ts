// Open-path routes: reveal a directory in the SERVER machine's file manager,
// open it in a terminal, or open an HTML file in its default browser. The path
// semantics follow the session cwd — the files live wherever this process runs,
// so these actions mean on this machine (exactly what a localhost user wants;
// for a LAN client the action is meaningless, which is why the routes are
// loopback-gated).
//
// Gate design: per-request, from the TCP peer address (`c.env.incoming` —
// the same source auth.ts rate-limiting reads). Nothing from headers is
// trusted. A missing address means in-process or unix-socket transport,
// both definitionally local (the desktop host fetches app.fetch directly).
//
// Launches use fixed argv — never a shell (same rule as server/git.ts) —
// with two settle contracts, declared PER CANDIDATE by what the launcher IS
// (the same argv can appear under two targets with one contract — wt):
//   • Exit-by-contract openers (open / open -a / explorer / xdg-open /
//     gnome-terminal / konsole) EXIT after handing off, so the request waits
//     for their exit under a timeout; a wedged opener is killed and surfaces
//     as a failure.
//   • Everything that may live as long as its window (first-instance
//     editors, wt, unknown terminal alternatives like xterm) and the browser
//     spawn DETACHED and settle at spawn-failure, an early exit, or a short
//     watch window anchored at the spawn event (the browser: at `spawn`
//     itself) — never at the app's eventual exit, and the child is never
//     killed. A first-instance editor IS the Electron main process: waiting
//     for its exit under a timeout terminated VS Code ~10s after it opened
//     (the recorded defect).

import { Hono } from 'hono'
import type { Context } from 'hono'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, constants, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { joinForPlatform } from '../platform-path.js'
import { pathToFileURL } from 'node:url'
import { homedir, platform } from 'node:os'
import { createLogger } from '../log.js'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import {
  isHtmlFilePath,
  isOpenPathTarget,
  OPEN_PATH_APP_TARGETS,
  OPEN_PATH_TARGETS,
  type OpenPathAppsPayload,
  type OpenPathTarget,
} from '../../shared/open-path.js'
import { extractTargetIcon, hostIconDeps, type ExtractedIcon, type OpenPathGlyphTarget } from '../open-path-icons.js'
import { readAppPathsTarget, hostAppPathsRun, hostAppPathsFileExists } from '../app-paths.js'
import { expandEnvReferences } from '../env-expand.js'

const log = createLogger('open-path')

const execFileAsync = promisify(execFile)

const LOOPBACK = new Set(['127.0.0.1', '::1'])

/** Loopback test over the raw socket address. IPv4-mapped IPv6
 *  (`::ffff:127.0.0.1`) normalizes to its v4 form first; a missing address
 *  means in-process / unix-socket transport — local by definition. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return true
  const normalized = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  return LOOPBACK.has(normalized)
}

function peerAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  return env?.incoming?.socket?.remoteAddress
}

// Host-header allowlist, as the second half of the local gate. The socket
// peer address cannot distinguish a genuine localhost tab from a DNS-rebinded
// page (both arrive over a loopback connection), but a rebinded page sends
// its own domain in `Host` — the browser only writes localhost/127.0.0.1/::1
// when the tab was actually opened on a loopback origin. A missing Host (the
// in-process desktop host) falls through to the socket check.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

function hostHeaderIsLoopback(c: Context): boolean {
  const host = c.req.header('host')
  if (!host) return true
  let hostname: string
  if (host.startsWith('[')) {
    hostname = host.slice(0, host.indexOf(']') + 1)
  } else {
    const i = host.lastIndexOf(':')
    hostname = i > -1 ? host.slice(0, i) : host
  }
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
}

function assertLocal(c: Context): void {
  if (isLoopbackAddress(peerAddress(c)) && hostHeaderIsLoopback(c)) return
  throw new HttpError(
    403,
    'This action opens a window on the machine running the server; it is only available from a local browser.',
    { reason: 'non_local' },
  )
}

/** Expand `${VAR}` against the given environment; null when a referenced
 *  variable is unset (the candidate is then unusable, not defaulted). */
function expandTemplate(template: string, env: NodeJS.ProcessEnv): string | null {
  return expandEnvReferences(template, env, /\$\{([^}]+)\}/g)
}

/** PATH-separator per platform (win32 uses ';'). */
function pathDelimiter(platformName: string): string {
  return platformName === 'win32' ? ';' : ':'
}

/**
 * Where one catalog row finds its launcher — the SINGLE descriptor serving
 * both the /apps availability probe and the launch-command resolution, so
 * the menu only offers what `openCommandsFor` would actually try to launch.
 * Kinds: `mac-app` (bundle dir under /Applications or ~/Applications,
 * launched via `open -a`), `file` (env-expanded executable path), `path`
 * (name resolvable on PATH), `app-paths` (Windows registry App Paths key —
 * the launcher is the registry-resolved exe, so a custom-directory install
 * is discoverable; see server/app-paths.ts).
 */
type AppLocator =
  | { readonly kind: 'mac-app'; readonly name: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'path'; readonly name: string }
  | { readonly kind: 'app-paths'; readonly exe: string }

/** One launchable row for a brand-app target: its locator plus the launch
 *  argv prefix (the directory is appended by the caller). */
interface AppCandidate {
  readonly args: readonly string[]
  readonly locator: AppLocator
  /** The launcher exits by contract (OS shell openers: `open`, `open -a`),
   *  so the request may wait for its exit under a timeout. Absent = the
   *  launcher may live as long as its window (editors, wt, unknown terminal
   *  alternatives) → detached watch, never killed. Declared per ROW because
   *  the same argv can appear under two targets (wt) with one contract. */
  readonly exitsByContract?: boolean
  /**
   * macOS `open -a` reports a missing application as a NONZERO EXIT, not a
   * spawn ENOENT — and a missing app is indistinguishable from any other
   * failed launch through `open`'s exit status. So these rows treat ANY
   * nonzero numeric exit as "try the next candidate" (best-effort chain:
   * bundle, then CLI shim; the last error surfaces if all fail). A kill by
   * signal (null exit code) is a real failure, not a fall-through.
   */
  readonly fallThroughOnExit?: boolean
}

function macOpen(name: string): AppCandidate {
  return { args: ['-a', name], locator: { kind: 'mac-app', name }, fallThroughOnExit: true, exitsByContract: true }
}

/** Env-expanded executable locator, one row per install location. */
function exe(template: string): AppCandidate {
  return { args: [], locator: { kind: 'file', path: template } }
}

/** PATH-name locator (CLI shims, Windows execution aliases). */
function onPath(name: string): AppCandidate {
  return { args: [], locator: { kind: 'path', name } }
}

/** Windows App Paths registry locator — proves installs in ANY directory. */
function appPaths(exeName: string): AppCandidate {
  return { args: [], locator: { kind: 'app-paths', exe: exeName } }
}

/**
 * Brand-app launch table. Only these three platforms are probed; a target
 * with no rows on the running platform yields no candidates (the POST
 * refuses with 404 and /apps never offers it).
 */
const APP_CATALOG: Readonly<
  Record<string, Partial<Record<NodeJS.Platform, readonly AppCandidate[]>>>
> = {
  vscode: {
    darwin: [macOpen('Visual Studio Code'), onPath('code')],
    win32: [
      // Registry first: the installer's App Paths key proves the install in
      // ANY directory (the two fixed paths below only cover the installer
      // defaults). When the registry proves nothing its row drops out and
      // the fixed paths carry the chain; behind a resolved exe they remain
      // only for the ENOENT race, since the reader already verified the
      // resolved file exists.
      appPaths('Code.exe'),
      exe('${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe'),
      exe('${ProgramFiles}/Microsoft VS Code/Code.exe'),
    ],
    linux: [onPath('code')],
  },
  cursor: {
    darwin: [macOpen('Cursor')],
    win32: [exe('${LOCALAPPDATA}/Programs/cursor/Cursor.exe')],
    linux: [onPath('cursor')],
  },
  kiro: {
    darwin: [macOpen('Kiro')],
    win32: [
      // Same registry-first chain as vscode: Kiro's installer registers
      // App Paths\Kiro.exe, proving custom-directory installs too.
      appPaths('Kiro.exe'),
      exe('${LOCALAPPDATA}/Programs/Kiro/Kiro.exe'),
    ],
    linux: [onPath('kiro')],
  },
  zed: {
    darwin: [macOpen('Zed'), macOpen('Zed Preview')],
    win32: [exe('${LOCALAPPDATA}/Programs/Zed/Zed.exe')],
    linux: [onPath('zed')],
  },
  iterm2: {
    darwin: [macOpen('iTerm')],
  },
  windowsterminal: {
    win32: [{ args: ['-d'], locator: { kind: 'path', name: 'wt' } }],
  },
}

/** Fixed argv per platform — resolved here so every branch is unit-testable
 *  and the route body stays free of OS conditionals. Returns a CANDIDATE
 *  LIST: the linux terminal entry tries Debian's `x-terminal-emulator`
 *  alternative first, then falls back to the common DE terminals (the first
 *  binary that exists wins — most non-Debian distros ship none of the
 *  alternatives symlink). Brand targets resolve through APP_CATALOG rows,
 *  with the directory appended to the launch argv. Async because an
 *  `app-paths` row's launch file is the registry-resolved exe (a row whose
 *  registry lookup proves nothing drops out of the chain). */
export async function openCommandsFor(
  platformName: string,
  target: OpenPathTarget,
  path: string,
  env: NodeJS.ProcessEnv,
  appPathsTarget: AvailabilityDeps['appPathsTarget'],
): Promise<Array<{ file: string; args: string[]; fallThroughOnExit?: boolean; exitsByContract?: boolean }>> {
  if (target === 'browser') {
    const url = pathToFileURL(path).href
    if (platformName === 'darwin') return [{ file: 'open', args: [url] }]
    if (platformName === 'win32') {
      return [{ file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }]
    }
    return [{ file: 'xdg-open', args: [url] }]
  }
  if (platformName === 'darwin') {
    if (target === 'finder') return [{ file: 'open', args: ['-R', path], exitsByContract: true }]
    if (target === 'terminal') return [{ file: 'open', args: ['-a', 'Terminal', path], exitsByContract: true }]
  } else if (platformName === 'win32') {
    if (target === 'finder') return [{ file: 'explorer', args: [path], exitsByContract: true }]
    // A first-instance wt.exe IS the terminal window process — not an
    // exit-by-contract opener, despite being the generic terminal launcher.
    if (target === 'terminal') return [{ file: 'wt', args: ['-d', path] }]
  } else {
    if (target === 'finder') return [{ file: 'xdg-open', args: [path], exitsByContract: true }]
    if (target === 'terminal') {
      return [
        // The Debian alternative can be ANY terminal (xterm is the window
        // process and never exits) — contract unknown, so detached watch.
        { file: 'x-terminal-emulator', args: [`--working-directory=${path}`] },
        { file: 'gnome-terminal', args: [`--working-directory=${path}`], exitsByContract: true },
        { file: 'konsole', args: ['--workdir', path], exitsByContract: true },
      ]
    }
  }
  const rows = APP_CATALOG[target]?.[platformName as NodeJS.Platform]
  if (!rows) return []
  const candidates: Array<{ file: string; args: string[]; fallThroughOnExit?: boolean; exitsByContract?: boolean }> = []
  for (const row of rows) {
    const file = await launchFileFor(row.locator, env, appPathsTarget)
    if (file === null) continue
    candidates.push({
      file,
      args: [...row.args, path],
      ...(row.fallThroughOnExit ? { fallThroughOnExit: true } : {}),
      ...(row.exitsByContract ? { exitsByContract: true } : {}),
    })
  }
  return candidates
}

/** The launch file one locator resolves to, or null when it proves nothing
 *  usable here (unset template variable, registry key absent/stale). The
 *  OS-generic `open` launcher and PATH names need no existence proof — the
 *  launch chain's ENOENT fall-through handles a missing binary. */
async function launchFileFor(
  locator: AppLocator,
  env: NodeJS.ProcessEnv,
  appPathsTarget: AvailabilityDeps['appPathsTarget'],
): Promise<string | null> {
  switch (locator.kind) {
    case 'mac-app':
      return 'open'
    case 'file':
      return expandTemplate(locator.path, env)
    case 'path':
      return locator.name
    case 'app-paths':
      return appPathsTarget(locator.exe)
  }
}

/** Async existence/executability probes injectable for deterministic tests. */
export interface AvailabilityDeps {
  readonly fileExists: (path: string) => Promise<boolean>
  readonly dirExists: (path: string) => Promise<boolean>
  /** Executable-or-not for PATH probes — on POSIX access(X_OK); on win32 a
   *  plain existence check (X_OK is meaningless there, and AppExecutionAlias
   *  reparse points are not stat()-isFile anyway, which is exactly why this
   *  dep exists: `wt.exe` resolves only through access()). */
  readonly executableExists: (path: string) => Promise<boolean>
  /** Registry-proven executable path for an App Paths locator (verified on
   *  disk by the reader), or null when no root proves a launcher. */
  readonly appPathsTarget: (exeName: string) => Promise<string | null>
}

async function probeCandidate(
  locator: AppLocator,
  platformName: string,
  env: NodeJS.ProcessEnv,
  home: string,
  deps: AvailabilityDeps,
): Promise<boolean> {
  switch (locator.kind) {
    case 'mac-app':
      for (const root of ['/Applications', joinForPlatform('darwin', home, 'Applications')]) {
        if (await deps.dirExists(joinForPlatform('darwin', root, `${locator.name}.app`))) return true
      }
      return false
    case 'file': {
      const path = expandTemplate(locator.path, env)
      return path !== null && deps.fileExists(path)
    }
    case 'path': {
      const paths = (env.PATH ?? '').split(pathDelimiter(platformName)).filter((p) => p !== '')
      for (const dir of paths) {
        const exeName = platformName === 'win32' ? `${locator.name}.exe` : locator.name
        if (await deps.executableExists(joinForPlatform(platformName, dir, exeName))) return true
      }
      return false
    }
    case 'app-paths':
      return (await deps.appPathsTarget(locator.exe)) !== null
  }
}

/**
 * Which brand targets are launchable on this machine? One probe per catalog
 * row, first passing row wins; catalog order is preserved. Pure over the
 * injected facts — the route supplies the real fs, tests supply fixtures.
 */
export async function availableAppsFor(
  platformName: string,
  env: NodeJS.ProcessEnv,
  home: string,
  deps: AvailabilityDeps,
): Promise<OpenPathTarget[]> {
  // Targets probe CONCURRENTLY — the probes are independent facts, and
  // registry-backed brands each pay a query subprocess cold start, so
  // overlapping them keeps /apps at roughly one cold start instead of one
  // per brand. Within a target the rows stay sequential (first proof wins),
  // and the map order preserves catalog order in the answer.
  const probed = await Promise.all(
    OPEN_PATH_APP_TARGETS.map(async (target): Promise<OpenPathTarget | null> => {
      // The generic `terminal` target already launches `wt -d` on win32, so a
      // `windowsterminal` brand row would render two identical menu entries —
      // the id stays POST-valid but /apps never advertises it.
      if (target === 'windowsterminal' && platformName === 'win32') return null
      const rows = APP_CATALOG[target]?.[platformName as NodeJS.Platform]
      if (!rows) return null
      for (const row of rows) {
        if (await probeCandidate(row.locator, platformName, env, home, deps)) return target
      }
      return null
    }),
  )
  return probed.filter((target): target is OpenPathTarget => target !== null)
}

/** Deadline for OS shell openers, which exit by contract; a wedged opener
 *  is killed at the deadline and surfaces as a failure. */
const OPENER_TIMEOUT_MS = 10_000

/** Early-failure watch window for app launchers: CLI shims exit within
 *  milliseconds; a launcher still running when it closes is a long-lived
 *  app (a first-instance editor's main process) and counts as launched. */
const LAUNCH_WATCH_MS = 1_500

type LaunchOutcome =
  | { kind: 'launched' }
  | { kind: 'spawn-error'; code: string | number | undefined; message: string }
  | { kind: 'exited'; code: number | null; message: string }

/** Wait for an OS shell opener's exit (it exits by contract), bounded by a
 *  timeout that kills a wedged opener. A timeout kill is a FAILURE outcome:
 *  on Windows TerminateProcess surfaces as exit code 1, which must not be
 *  mistaken for the explorer exit-1 success quirk. */
async function launchAndWait(file: string, args: string[]): Promise<LaunchOutcome> {
  try {
    await execFileAsync(file, args, { timeout: OPENER_TIMEOUT_MS })
    return { kind: 'launched' }
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { killed?: boolean }
    // execFile also kills on maxBuffer overflow (older Node: ENOBUFS with
    // killed=true) — an output-size failure, NOT a timeout (same guard as
    // server/git.ts).
    if (error.code === 'ENOBUFS' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { kind: 'spawn-error', code: error.code, message: 'launcher output exceeded maxBuffer' }
    }
    if (error.killed === true) {
      return { kind: 'spawn-error', code: 'ETIMEDOUT', message: `launcher timed out after ${OPENER_TIMEOUT_MS}ms` }
    }
    if (typeof error.code === 'number') {
      return { kind: 'exited', code: error.code, message: `launcher exited with code ${error.code}` }
    }
    return { kind: 'spawn-error', code: error.code, message: error.message }
  }
}

/** Launch one app candidate detached from this process: the request settles
 *  at a spawn failure, an exit inside the watch window, or the window
 *  closing with the child still running — never at the app's eventual exit,
 *  and the child is never killed or held by a timeout. `watchMs` 0 settles
 *  at the `spawn` event itself (the browser case: its eventual exit is none
 *  of the request's business). stdio is ignored on purpose: holding a
 *  stderr pipe past the window would either block a chatty long-lived child
 *  when the buffer fills or EPIPE it when the pipe is destroyed — the cost
 *  is that a genuine early failure surfaces as an exit code, not OS stderr. */
function launchDetached(file: string, args: string[], watchMs: number): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { detached: true, stdio: 'ignore' })
    } catch (err) {
      // spawn throws SYNCHRONOUSLY on invalid argv (e.g. an embedded NUL) —
      // fold it into the same outcome shape so the candidate chain sees it.
      const error = err as NodeJS.ErrnoException
      resolve({ kind: 'spawn-error', code: error.code, message: error.message })
      return
    }
    let settled = false
    let watch: ReturnType<typeof setTimeout> | undefined
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(
        code === 0
          ? { kind: 'launched' }
          : {
              kind: 'exited',
              code,
              message: signal !== null ? `launcher killed by signal ${signal}` : `launcher exited with code ${code}`,
            },
      )
    }
    const settle = (outcome: LaunchOutcome): void => {
      if (settled) return
      settled = true
      if (watch !== undefined) clearTimeout(watch)
      // Only the error listener must persist (an unlistened 'error' throws);
      // release the exit listener and its closure for the child's lifetime.
      child.removeListener('exit', onExit)
      child.unref()
      resolve(outcome)
    }
    // The watch window starts at the SPAWN event, not the spawn() call: a
    // slow spawn (AV scan, network path) must not run the window out before
    // the process exists and be counted launched.
    child.once('spawn', () => {
      if (watchMs === 0) settle({ kind: 'launched' })
      else watch = setTimeout(() => settle({ kind: 'launched' }), watchMs)
    })
    // PERSISTENT error listener: a long-lived detached child can emit more
    // than one 'error' over its lifetime; an unlistened 'error' event throws
    // as an uncaught exception and would take the server down.
    child.on('error', (error) => {
      if (settled) {
        // A late failure of a launcher already counted launched — the
        // request has answered; surface it in the log, not the response.
        log.warn(`launcher error after settle: ${error.message}`)
        return
      }
      settle({ kind: 'spawn-error', code: (error as NodeJS.ErrnoException).code, message: error.message })
    })
    child.once('exit', onExit)
  })
}

export function buildOpenPathRouter(): Hono {
  const app = new Hono()
  // Per-instance icon cache — keyed by target (the platform is fixed for the
  // process), one extraction attempt per target per instance lifetime.
  const iconCache = new Map<string, Promise<ExtractedIcon | null>>()

  // The App Paths registry fact shared by the /apps probe and the POST launch
  // resolution — one reader, so both surfaces agree on what is installed.
  const appPathsTarget: AvailabilityDeps['appPathsTarget'] = (exeName) =>
    readAppPathsTarget(exeName, { run: hostAppPathsRun, fileExists: hostAppPathsFileExists, env: process.env })

  // Capability probe for the client UI: show the Reveal/Open buttons only
  // when THIS request comes from the server machine. Same gate as the POST.
  app.get('/open-path/capability', (c) => {
    return c.json({ local: isLoopbackAddress(peerAddress(c)) && hostHeaderIsLoopback(c) })
  })

  app.get('/open-path/apps', async (c) => {
    // Same gate as the POST: the answer is a software inventory of this
    // machine, so a remote (authenticated) client gets 403 — it hides the
    // group anyway via the capability probe, but must not be able to
    // enumerate installed editors either.
    assertLocal(c)
    const apps = await availableAppsFor(platform(), process.env, homedir(), {
      fileExists: hostAppPathsFileExists,
      dirExists: async (p) => {
        try {
          return (await stat(p)).isDirectory()
        } catch {
          return false
        }
      },
      executableExists: async (p) => {
        try {
          await access(p, constants.X_OK)
          return true
        } catch {
          return false
        }
      },
      appPathsTarget,
    })
    const payload: OpenPathAppsPayload = { apps }
    return c.json(payload)
  })

  app.get('/open-path/icons/:target', async (c) => {
    // Same gate as the POST: the answer is a fact about this machine.
    assertLocal(c)
    const target = c.req.param('target') as OpenPathGlyphTarget
    // Brand targets are static client-side SVGs — extraction exists only for
    // the two OS glyphs.
    if (target !== 'finder' && target !== 'terminal') {
      return c.json({ code: 'not-found', message: `no extractable icon for ${target}` }, 404)
    }
    // One extraction per target per router instance (a router instance is one
    // process): the OS icon cannot change without a restart.
    let pending = iconCache.get(target)
    if (pending === undefined) {
      pending = extractTargetIcon(target, platform(), { ...hostIconDeps, env: process.env, home: homedir() })
      iconCache.set(target, pending)
    }
    const icon: ExtractedIcon | null = await pending
    if (icon === null) {
      // The protocol's "genuinely does not exist here" — no-store so a later
      // restart (new install) gets a fresh attempt.
      return c.json({ code: 'not-found', message: `no icon for ${target} on ${platform()}` }, 404, {
        'cache-control': 'no-store',
      })
    }
    return new Response(new Uint8Array(icon.bytes), {
      headers: { 'content-type': icon.contentType, 'cache-control': 'public, max-age=3600' },
    })
  })

  app.post('/open-path', async (c) => {
    assertLocal(c)

    const body = await safeJson<{ path?: unknown; target?: unknown }>(c.req)
    const path = body.path
    const target = body.target
    if (typeof path !== 'string' || path.length === 0) {
      throw new HttpError(400, "body.path must be a non-empty string")
    }
    if (path.includes('\0')) {
      throw new HttpError(400, 'body.path must not contain NUL bytes')
    }
    if (!isOpenPathTarget(target)) {
      throw new HttpError(400, `body.target must be one of: ${OPEN_PATH_TARGETS.join(', ')}`)
    }
    if (!isAbsolute(path)) {
      throw new HttpError(400, 'body.path must be an absolute path')
    }

    const st = await stat(path).catch(() => null)
    if (target === 'browser') {
      if (!st?.isFile() || !isHtmlFilePath(path)) {
        throw new HttpError(400, `not an HTML file: ${path}`)
      }
    } else if (!st || !st.isDirectory()) {
      throw new HttpError(400, `not a directory: ${path}`)
    }

    if (target === 'browser') {
      const [{ file, args }] = await openCommandsFor(platform(), target, path, process.env, appPathsTarget)
      log.info(`open target=browser file=${file} path=${path}`)
      const outcome = await launchDetached(file, args, 0)
      if (outcome.kind !== 'launched') throw new HttpError(500, `failed to open ${path}: ${outcome.message}`)
      return c.json({ ok: true })
    }

    const candidates = await openCommandsFor(platform(), target, path, process.env, appPathsTarget)
    if (candidates.length === 0) {
      // A brand target with no launch rows on this platform: the menu should
      // never have offered it (GET /apps gates that), so this is abuse or a
      // stale client — refuse without spawning.
      throw new HttpError(404, `target not available on this platform: ${target}`)
    }
    // The settle contract is per CANDIDATE (what the launcher is), not per
    // target: exit-by-contract openers wait for exit; anything that may live
    // as long as its window gets the detached watch. One outcome chain
    // serves both.
    let lastMessage = ''
    for (const { file, args, fallThroughOnExit, exitsByContract } of candidates) {
      log.info(`open target=${target} file=${file} path=${path}`)
      const outcome = exitsByContract
        ? await launchAndWait(file, args)
        : await launchDetached(file, args, LAUNCH_WATCH_MS)
      if (outcome.kind === 'launched') return c.json({ ok: true })
      lastMessage = outcome.message
      if (outcome.kind === 'spawn-error') {
        // ENOENT means this candidate binary doesn't exist — try the next.
        if (outcome.code === 'ENOENT') continue
        break
      }
      // win32 `explorer` is special: it exits 1 even on SUCCESS — the
      // documented explorer.exe quirk — so for it a code of 1 is a win.
      if (platform() === 'win32' && target === 'finder' && outcome.code === 1) {
        return c.json({ ok: true })
      }
      // `open -a MissingApp` reports a missing app as a nonzero EXIT:
      // fall through to the next candidate (CLI shim etc.). A signal kill
      // (null exit code) is a real failure, not a fall-through.
      if (fallThroughOnExit === true && typeof outcome.code === 'number' && outcome.code !== 0) continue
      break
    }
    throw new HttpError(500, `failed to open ${path}: ${lastMessage}`)
  })

  return app
}
