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
// Directory launches go through execFile with fixed argv — never a shell (same
// rule as server/git.ts) — and carry a timeout so a wedged `open` can't hold the
// request open. Browser launches also use fixed argv without a shell, but run
// detached: the request settles when the launcher reports `spawn`, not when the
// browser eventually exits.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, constants, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
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
  let unset = false
  const expanded = template.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
    if (env[name] === undefined) unset = true
    return env[name] ?? ''
  })
  return unset ? null : expanded
}

/** PATH-separator per platform (win32 uses ';'). */
function pathDelimiter(platformName: string): string {
  return platformName === 'win32' ? ';' : ':'
}

/**
 * One launchable row for a brand-app target. The command/args pair is the
 * launch argv (the directory is appended by the caller); `probe` is the
 * availability fact the /apps route evaluates — the SAME row serves both, so
 * the menu only offers what `openCommandsFor` would actually try to launch.
 * `probe` kinds: `mac-app` (bundle dir under /Applications or ~/Applications),
 * `file` (env-expanded executable path), `path` (name resolvable on PATH).
 */
interface AppCandidate {
  readonly command: string
  readonly args: readonly string[]
  readonly probe:
    | { readonly kind: 'mac-app'; readonly name: string }
    | { readonly kind: 'file'; readonly path: string }
    | { readonly kind: 'path'; readonly name: string }
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
  return { command: 'open', args: ['-a', name], probe: { kind: 'mac-app', name }, fallThroughOnExit: true }
}

/** Env-expanded executable probe+command, one row per install location. */
function exe(template: string): AppCandidate {
  return { command: template, args: [], probe: { kind: 'file', path: template } }
}

/** PATH-name probe+command (CLI shims, Windows execution aliases). */
function onPath(name: string): AppCandidate {
  return { command: name, args: [], probe: { kind: 'path', name } }
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
  zed: {
    darwin: [macOpen('Zed'), macOpen('Zed Preview')],
    win32: [exe('${LOCALAPPDATA}/Programs/Zed/Zed.exe')],
    linux: [onPath('zed')],
  },
  iterm2: {
    darwin: [macOpen('iTerm')],
  },
  windowsterminal: {
    win32: [{ command: 'wt', args: ['-d'], probe: { kind: 'path', name: 'wt' } }],
  },
}

/** Fixed argv per platform — resolved here so every branch is unit-testable
 *  and the route body stays free of OS conditionals. Returns a CANDIDATE
 *  LIST: the linux terminal entry tries Debian's `x-terminal-emulator`
 *  alternative first, then falls back to the common DE terminals (the first
 *  binary that exists wins — most non-Debian distros ship none of the
 *  alternatives symlink). Brand targets resolve through APP_CATALOG rows,
 *  with the directory appended to the launch argv. */
export function openCommandsFor(
  platformName: string,
  target: OpenPathTarget,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ file: string; args: string[]; fallThroughOnExit?: boolean }> {
  if (target === 'browser') {
    const url = pathToFileURL(path).href
    if (platformName === 'darwin') return [{ file: 'open', args: [url] }]
    if (platformName === 'win32') {
      return [{ file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }]
    }
    return [{ file: 'xdg-open', args: [url] }]
  }
  if (platformName === 'darwin') {
    if (target === 'finder') return [{ file: 'open', args: ['-R', path] }]
    if (target === 'terminal') return [{ file: 'open', args: ['-a', 'Terminal', path] }]
  } else if (platformName === 'win32') {
    if (target === 'finder') return [{ file: 'explorer', args: [path] }]
    if (target === 'terminal') return [{ file: 'wt', args: ['-d', path] }]
  } else {
    if (target === 'finder') return [{ file: 'xdg-open', args: [path] }]
    if (target === 'terminal') {
      return [
        { file: 'x-terminal-emulator', args: [`--working-directory=${path}`] },
        { file: 'gnome-terminal', args: [`--working-directory=${path}`] },
        { file: 'konsole', args: ['--workdir', path] },
      ]
    }
  }
  const rows = APP_CATALOG[target]?.[platformName as NodeJS.Platform]
  if (!rows) return []
  const candidates: Array<{ file: string; args: string[]; fallThroughOnExit?: boolean }> = []
  for (const row of rows) {
    const file = expandTemplate(row.command, env)
    if (file === null) continue
    candidates.push({
      file,
      args: [...row.args, path],
      ...(row.fallThroughOnExit ? { fallThroughOnExit: true } : {}),
    })
  }
  return candidates
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
}

async function probeCandidate(
  candidate: AppCandidate,
  platformName: string,
  env: NodeJS.ProcessEnv,
  home: string,
  deps: AvailabilityDeps,
): Promise<boolean> {
  switch (candidate.probe.kind) {
    case 'mac-app':
      for (const root of ['/Applications', join(home, 'Applications')]) {
        if (await deps.dirExists(join(root, `${candidate.probe.name}.app`))) return true
      }
      return false
    case 'file': {
      const path = expandTemplate(candidate.probe.path, env)
      return path !== null && deps.fileExists(path)
    }
    case 'path': {
      const paths = (env.PATH ?? '').split(pathDelimiter(platformName)).filter((p) => p !== '')
      for (const dir of paths) {
        const exeName = platformName === 'win32' ? `${candidate.probe.name}.exe` : candidate.probe.name
        if (await deps.executableExists(join(dir, exeName))) return true
      }
      return false
    }
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
  const apps: OpenPathTarget[] = []
  for (const target of OPEN_PATH_APP_TARGETS) {
    // The generic `terminal` target already launches `wt -d` on win32, so a
    // `windowsterminal` brand row would render two identical menu entries —
    // the id stays POST-valid but /apps never advertises it.
    if (target === 'windowsterminal' && platformName === 'win32') continue
    const rows = APP_CATALOG[target]?.[platformName as NodeJS.Platform]
    if (!rows) continue
    for (const row of rows) {
      if (await probeCandidate(row, platformName, env, home, deps)) {
        apps.push(target)
        break
      }
    }
  }
  return apps
}

function launchBrowser(file: string, args: string[]): Promise<void> {
  const child = spawn(file, args, { stdio: 'ignore', detached: true })
  return new Promise((resolve, reject) => {
    let spawned = false
    child.on('error', (error) => {
      if (!spawned) reject(error)
      else log.warn(`browser launcher error after spawn: ${error.message}`)
    })
    child.once('spawn', () => {
      spawned = true
      child.unref()
      resolve()
    })
  })
}

export function buildOpenPathRouter(): Hono {
  const app = new Hono()
  // Per-instance icon cache — keyed by target (the platform is fixed for the
  // process), one extraction attempt per target per instance lifetime.
  const iconCache = new Map<string, Promise<ExtractedIcon | null>>()

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
      fileExists: async (p) => {
        try {
          return (await stat(p)).isFile()
        } catch {
          return false
        }
      },
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
      const [{ file, args }] = openCommandsFor(platform(), target, path)
      log.info(`open target=browser file=${file} path=${path}`)
      try {
        await launchBrowser(file, args)
        return c.json({ ok: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new HttpError(500, `failed to open ${path}: ${message}`)
      }
    }

    const candidates = openCommandsFor(platform(), target, path)
    if (candidates.length === 0) {
      // A brand target with no launch rows on this platform: the menu should
      // never have offered it (GET /apps gates that), so this is abuse or a
      // stale client — refuse without spawning.
      throw new HttpError(404, `target not available on this platform: ${target}`)
    }
    let lastErr: unknown
    for (const { file, args, fallThroughOnExit } of candidates) {
      log.info(`open target=${target} file=${file} path=${path}`)
      try {
        await execFileAsync(file, args, { timeout: 10_000 })
        return c.json({ ok: true })
      } catch (err) {
        lastErr = err
        // ENOENT means this candidate binary doesn't exist — try the next.
        // (win32 `explorer` is special: it exits 1 even on SUCCESS — the
        // documented explorer.exe quirk — so for it a code of 1 is a win.)
        const code = (err as { code?: unknown })?.code
        if (platform() === 'win32' && target === 'finder' && code === 1) {
          return c.json({ ok: true })
        }
        // `open -a MissingApp` reports a missing app as a nonzero EXIT:
        // fall through to the next candidate (CLI shim etc.). A signal kill
        // (null exit code) is a real failure, not a fall-through.
        if (code === 'ENOENT' || (fallThroughOnExit === true && typeof code === 'number' && code !== 0)) continue
        break
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr)
    throw new HttpError(500, `failed to open ${path}: ${message}`)
  })

  return app
}
