// Electron main process — the desktop host.
//
// Construction of the server context (stores, SessionManager, Hono app) is
// shared with the web launcher via server/bootstrap.ts. This host adds only:
//   - a state dir under userData (see boot()), isolated from the web build's
//     own state
//   - a default session workspace derived from the user's session history,
//     because a GUI launch has no meaningful `process.cwd()` (see boot())
//   - a custom `crw://` protocol that serves the built client and proxies
//     /api/* into the in-process Hono app (no TCP port, no CORS surface)
//   - MessageChannel-backed realtime: one SessionConnection per renderer,
//     writing through a PortFrameSink
//   - the application lifecycle (window, shutdown)
//
// There is NO HTTP server and NO WebSocket: the renderer talks to the host
// only through the preload bridge.

import { app, BrowserWindow, ipcMain, MessageChannelMain, protocol } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServerContext, type ServerContext } from '../server/bootstrap.js'
import { SessionStore } from '../server/persistence.js'
import { pickLastUsedCwd } from '../server/default-cwd.js'
import { SessionConnection } from '../server/frame-bridge.js'
import { PortFrameSink } from './frame-sink-ipc.js'
import { installAppMenu } from './menu.js'
import { setupAutoUpdate } from './updater.js'
import type { WsClientFrame } from '../shared/ws-protocol.js'
import { createLogger } from '../server/log.js'

const log = createLogger('desktop')

const here = fileURLToPath(new URL('.', import.meta.url))
/** Built client (vite build → dist/client). Resolved relative to the bundle. */
const CLIENT_DIR = resolvePath(here, '..', 'client')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'crw',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

let ctx: ServerContext | null = null
/** Live realtime connections, keyed by an incrementing id. `owner` is the
 *  renderer's webContents id so a disconnect tears down only its own. */
const connections = new Map<number, { conn: SessionConnection; owner: number }>()
let connSeq = 0

/** Content types for the handful of asset extensions the client emits. */
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

/** Serve one client asset from CLIENT_DIR, path-traversal-safe. Falls back to
 *  index.html for unknown paths (SPA routing), with no-store so the renderer
 *  never caches a stale bundle. */
function serveClient(pathname: string): Response {
  const clean = pathname.replace(/^\/+/, '')
  const candidate = resolvePath(CLIENT_DIR, normalize(clean))
  // Reject anything that escaped CLIENT_DIR.
  if (candidate !== CLIENT_DIR && !candidate.startsWith(CLIENT_DIR + sep)) {
    return new Response('forbidden', { status: 403 })
  }
  const filePath = existsSync(candidate) && extname(candidate) ? candidate : join(CLIENT_DIR, 'index.html')
  const body = readFileSync(filePath)
  const type = MIME[extname(filePath)] ?? 'application/octet-stream'
  return new Response(body, {
    headers: { 'content-type': type, 'cache-control': 'no-store' },
  })
}

async function registerProtocol(): Promise<void> {
  protocol.handle('crw', async (req) => {
    const url = new URL(req.url)
    // crw://app/<path> — the host segment is ignored; the path is what matters.
    if (!ctx) return new Response('host not ready', { status: 503 })

    // Everything under /api/* runs through the exact same Hono app the web
    // server mounts, in-process. Building a Request from the electron Request
    // keeps REST semantics (methods, bodies, headers) identical.
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: hasBody ? await req.arrayBuffer() : undefined,
        // @ts-expect-error duplex is required by undici for streamed bodies
        duplex: hasBody ? 'half' : undefined,
      })
      return ctx.app.fetch(request)
    }

    return serveClient(url.pathname)
  })
}

function buildWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1a1d24',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  void win.loadURL('crw://app/index.html')
  return win
}

function wireIpc(): void {
  // --- Realtime: mint a MessageChannel per renderer ------------------------
  // Each renderer gets its own SessionConnection; frames flow over the
  // transferred MessagePort, never the shared IPC bus.
  ipcMain.on('crw:connect', (evt) => {
    if (!ctx) return
    const { port1, port2 } = new MessageChannelMain()
    const id = ++connSeq
    const sink = new PortFrameSink(port1, () => {
      // Overflow: tell the renderer to re-subscribe; it re-establishes and the
      // bridge re-serves a replay.
      try { port1.postMessage(JSON.stringify({ kind: 'error', message: 'ipc queue overflow; re-subscribe' })) } catch { /* gone */ }
    })
    const conn = new SessionConnection(
      { sm: ctx.sessionManager, appPlugins: ctx.appPluginEnabled ? ctx.appPluginManager : undefined },
      sink,
    )
    // Ownership: the renderer's webContents id, so a disconnect only tears
    // down that renderer's connection (correct once multiple windows exist).
    const owner = evt.sender.id
    connections.set(id, { conn, owner })

    port1.on('message', (e) => conn.handleClientFrame(e.data as WsClientFrame | string))
    port1.on('close', () => {
      conn.close()
      connections.delete(id)
    })
    port1.start()
    // Transfer the host end to the renderer, then start the channels.
    evt.sender.postMessage('crw:port', null, [port2])
    conn.start()
  })

  ipcMain.on('crw:disconnect', (evt) => {
    // Close only the connections owned by the renderer that asked.
    const owner = evt.sender.id
    for (const [id, entry] of connections) {
      if (entry.owner !== owner) continue
      entry.conn.close()
      connections.delete(id)
    }
  })

}

/** True when `path` is an existing directory a session could actually use.
 *  Async on purpose: a recorded workspace can live on a disconnected network
 *  drive or a hung SMB share, and a blocking stat there would freeze the main
 *  thread for the mount timeout — before any window has opened, so the app
 *  would just look dead. */
async function isUsableDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The workspace to advertise as this host's default session cwd.
 *
 * This must not be `process.cwd()`. A packaged GUI app is launched with no
 * meaningful working directory — macOS starts it in `/`, a Windows shortcut in
 * the install directory — so the app has to *declare* a default rather than
 * inherit an accident. `process.cwd()` remains the right fallback for the CLI
 * (you ran it somewhere; that somewhere is your workspace), which is why this
 * is solved here and not in the shared `buildApp` fallback.
 *
 * The honest answer is the workspace the user last worked in, so we read the
 * persisted session index. `createServerContext` loads the same file into the
 * real store a moment later; this read is read-only and discarded, so the
 * duplication costs one extra parse at boot.
 */
async function resolveDefaultCwd(stateDir: string): Promise<string> {
  const fallback = homedir()
  try {
    const sessions = await new SessionStore({ stateDir }).load()
    const { cwd, fellBack } = await pickLastUsedCwd(sessions, { fallback, isUsableDir })
    // Report which of the two happened rather than comparing values: the
    // winning workspace may legitimately *be* the home directory, and this
    // line is the only record of what the host actually chose.
    log.info(
      fellBack
        ? `default cwd: ${cwd} (home — no usable session workspace)`
        : `default cwd: ${cwd} (last used workspace)`,
    )
    return cwd
  } catch (err) {
    // A missing/corrupt index must never stop the host from booting; the
    // SessionStore already treats ENOENT as empty, so this is belt-and-braces.
    log.warn('could not derive default cwd from session history:', (err as Error).message)
    return fallback
  }
}

async function boot(): Promise<void> {
  // Pin the process cwd before anything resolves a relative path. A GUI launch
  // gives us `/` (macOS) or the install dir (Windows shortcuts), and anything
  // that falls back to the process cwd — including an SDK subprocess spawned
  // without an explicit cwd — would otherwise land there.
  try {
    process.chdir(homedir())
  } catch (err) {
    log.warn('could not chdir to home:', (err as Error).message)
  }

  // Desktop state lives under userData, isolated from the web build's
  // ~/.claude-react-web so the two hosts never share sessions/config.
  const stateDir = join(app.getPath('userData'), 'state')
  // No explicit claudeBinary: the agent SDK resolves its own CLI from the
  // platform package (@anthropic-ai/claude-agent-sdk-<platform>) that ships
  // inside the bundle. resolveClaudeBinary() still honors CLAUDE_CODE_BINARY /
  // `which claude` for a system install, which is the right fallback here.

  const cwd = await resolveDefaultCwd(stateDir)
  ctx = await createServerContext({ stateDir, appPlugins: true, cwd })
  log.info(`desktop host ready (state=${stateDir})`)

  await registerProtocol()
  wireIpc()
  const win = buildWindow()
  // Menu items target the focused window; fall back to the one we just built.
  installAppMenu(() => BrowserWindow.getFocusedWindow() ?? win ?? BrowserWindow.getAllWindows()[0] ?? null)

  // Auto-update is fire-and-forget: it no-ops when unpackaged or feedless and
  // never blocks the window. Errors are handled inside setupAutoUpdate.
  void setupAutoUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) buildWindow()
  })
}

app.whenReady().then(boot).catch((err) => {
  log.error('desktop boot failed:', err)
  app.quit()
})

app.on('window-all-closed', () => {
  // Quit on all platforms (including macOS): this is a tool window, not a
  // document app; leaving a headless host running confuses the user.
  app.quit()
})

app.on('before-quit', (e) => {
  if (!ctx) return
  e.preventDefault()
  const c = ctx
  ctx = null
  // Tear down every live connection, then the server context.
  for (const entry of connections.values()) entry.conn.close()
  connections.clear()
  void c.shutdown().finally(() => app.exit(0))
})
