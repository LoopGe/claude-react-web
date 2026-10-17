// Open-path routes: reveal a directory in the SERVER machine's file manager
// or open it in a terminal. The path semantics follow the session cwd — the
// files live wherever this process runs, so "open in Finder" means on this
// machine (exactly what a localhost user wants; for a LAN client the action
// is meaningless, which is why the routes are loopback-gated).
//
// Gate design: per-request, from the TCP peer address (`c.env.incoming` —
// the same source auth.ts rate-limiting reads). Nothing from headers is
// trusted. A missing address means in-process or unix-socket transport,
// both definitionally local (the desktop host fetches app.fetch directly).
//
// Spawns go through execFile with fixed argv — never a shell (same rule as
// server/git.ts) — and carry a timeout so a wedged `open` can't hold the
// request open.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { platform } from 'node:os'
import { createLogger } from '../log.js'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import { isOpenPathTarget, type OpenPathTarget } from '../../shared/open-path.js'

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

/** Fixed argv per platform — resolved here so every branch is unit-testable
 *  and the route body stays free of OS conditionals. Returns a CANDIDATE
 *  LIST: the linux terminal entry tries Debian's `x-terminal-emulator`
 *  alternative first, then falls back to the common DE terminals (the first
 *  binary that exists wins — most non-Debian distros ship none of the
 *  alternatives symlink). */
export function openCommandsFor(
  platformName: string,
  target: OpenPathTarget,
  dir: string,
): Array<{ file: string; args: string[] }> {
  if (platformName === 'darwin') {
    return [
      target === 'finder'
        ? { file: 'open', args: ['-R', dir] }
        : { file: 'open', args: ['-a', 'Terminal', dir] },
    ]
  }
  if (platformName === 'win32') {
    return [
      target === 'finder'
        ? { file: 'explorer', args: [dir] }
        : { file: 'wt', args: ['-d', dir] },
    ]
  }
  return target === 'finder'
    ? [{ file: 'xdg-open', args: [dir] }]
    : [
        { file: 'x-terminal-emulator', args: [`--working-directory=${dir}`] },
        { file: 'gnome-terminal', args: [`--working-directory=${dir}`] },
        { file: 'konsole', args: ['--workdir', dir] },
      ]
}

export function buildOpenPathRouter(): Hono {
  const app = new Hono()

  // Capability probe for the client UI: show the Reveal/Open buttons only
  // when THIS request comes from the server machine. Same gate as the POST.
  app.get('/open-path/capability', (c) => {
    return c.json({ local: isLoopbackAddress(peerAddress(c)) && hostHeaderIsLoopback(c) })
  })

  app.post('/open-path', async (c) => {
    assertLocal(c)

    const body = await safeJson<{ path?: unknown; target?: unknown }>(c.req)
    const path = body.path
    const target = body.target
    if (typeof path !== 'string' || path.length === 0) {
      throw new HttpError(400, "body.path must be a non-empty string")
    }
    if (!isOpenPathTarget(target)) {
      throw new HttpError(400, "body.target must be one of: finder, terminal")
    }
    if (!isAbsolute(path)) {
      throw new HttpError(400, 'body.path must be an absolute path')
    }

    const st = await stat(path).catch(() => null)
    if (!st || !st.isDirectory()) {
      throw new HttpError(400, `not a directory: ${path}`)
    }

    const candidates = openCommandsFor(platform(), target, path)
    let lastErr: unknown
    for (const { file, args } of candidates) {
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
        if (code !== 'ENOENT') break
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr)
    throw new HttpError(500, `failed to open ${path}: ${message}`)
  })

  return app
}
