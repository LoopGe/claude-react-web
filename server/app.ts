// Compose the Hono app: CORS for dev, REST + WebSocket on /api, static client on /.

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionManager } from './session-manager.js'
import { buildAuthMiddleware, getWebAuth } from './auth.js'
import { isLoopbackHost, lanIPv4Addresses } from './net.js'
import { createErrorHandler } from './errors.js'
import { buildApiRouter } from './routes/index.js'
import { buildFsRouter } from './fs-routes.js'
import { buildGitRouter } from './git-routes.js'
import { buildMcpConfigRouter } from './mcp-routes.js'
import { buildSnippetRouter } from './snippet-routes.js'
import { config as serverConfig } from './config.js'
import { createLogger } from './log.js'
import type { SessionStore } from './persistence.js'
import type { McpConfigStore } from './mcp-config.js'
import type { SnippetStore } from './snippet-store.js'
import type { MpStore } from './mp-store.js'

export interface AppOptions {
  /** Directory containing the built frontend (dist/client). */
  clientDir?: string
  /** Multi-session pool manager (created lazily if omitted). */
  sessionManager?: SessionManager
  /** Metadata store. If provided without `sessionManager`, a new manager
   *  is constructed wired up to this store. Ignored when `sessionManager`
   *  is supplied (assume the caller already wired it). */
  sessionStore?: SessionStore
  /** Global MCP server config store. Mounted as /api/mcp-config and
   *  passed to SessionManager for merging into new sessions. */
  mcpConfigStore?: McpConfigStore
  /** Composer snippet store. Mounted as /api/snippets. Persists the
   *  user's reusable text macros to disk (previously localStorage-only). */
  snippetStore?: SnippetStore
  /** Homegrown marketplace store. When provided, the /api/mp/* routes
   *  are mounted and SessionManager spawns inject enabled plugin paths
   *  into Options.plugins. Optional to keep existing tests / standalone
   *  buildApp callers working without churn. */
  mpStore?: MpStore
  /** Default values exposed via GET /api/config (used by the "new session" form).
   *  `claudeBinary` is NOT exposed to the UI — it's a server-side concern
   *  that gets injected into every Query via options.pathToClaudeCodeExecutable. */
  defaults?: { cwd?: string; model?: string; claudeBinary?: string }
  /** State directory containing config.json. Passed to the API router
   *  so the setup endpoint can write config changes to disk. */
  configDir?: string
  /** Host/port the server is bound to. Used by GET /api/access-info to
   *  build the LAN URLs + QR codes shown in the "open on phone" dialog.
   *  When omitted, access-info reports no LAN reachability. */
  bind?: { host: string; port: number }
}

/**
 * Find the built client directory. We walk a few candidates so both the bundled
 * dist/cli.mjs (sibling dist/client/) and source `tsx server/cli.ts` (dist/
 * a few levels up) work without config.
 */
function resolveClientDir(override?: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    override,
    resolvePath(here, 'client'), // when bundled as dist/cli.mjs
    resolvePath(here, '..', 'dist', 'client'), // when running tsx from server/
    resolvePath(here, '..', '..', 'dist', 'client'),
  ].filter((x): x is string => !!x)

  for (const dir of candidates) {
    if (existsSync(resolvePath(dir, 'index.html'))) return dir
  }
  return null
}

export function buildApp(opts: AppOptions = {}): { app: Hono; sessionManager: SessionManager } {
  const sessionManager =
    opts.sessionManager ??
    new SessionManager({
      store: opts.sessionStore,
      mcpConfigStore: opts.mcpConfigStore,
      mpStore: opts.mpStore,
      claudeBinary: opts.defaults?.claudeBinary,
      autoResume: true,
    })
  const app = new Hono()

  // Global error handler — catches unhandled errors from sub-routers
  // (e.g. buildFsRouter) that don't have their own onError.
  app.onError(createErrorHandler('[app]'))

  // JSON 404 for unmatched /api/* routes (consistent with API error contract).
  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: `not found: ${c.req.method} ${c.req.path}` }, 404)
    }
    return c.text('Not found', 404)
  })

  app.use('*', cors({ origin: (o) => o ?? '*', credentials: false }))

  // Reject oversized request bodies early. This covers JSON payloads and
  // multipart uploads — the cap is generous (32 MB) to allow the 28 MB
  // base64 image payload plus JSON wrapper overhead.
  //
  // Uses Hono's built-in bodyLimit middleware which correctly handles
  // chunked transfer encoding by reading the actual stream when
  // Content-Length is absent — our previous Content-Length-only check
  // was bypassable by omitting that header.
  const MAX_BODY_BYTES = 32 * 1024 * 1024
  app.use('*', bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  }))

  // Web access gate. No-op unless auth is enabled (set by cli.ts when
  // bound to a non-loopback host or when an access token is configured).
  // Runs after CORS + body-limit, before logging + routes + static, so an
  // unauthenticated request never reaches the API, the WS, or the client
  // bundle.
  app.use('*', buildAuthMiddleware())

  const httpLog = createLogger('http')
  app.use('*', async (c, next) => {
    // Basic request log — helps when diagnosing CLI issues.
    // Only log API routes to avoid noise from static asset serving.
    if (!c.req.path.startsWith('/api/')) return next()
    const start = Date.now()
    await next()
    const ms = Date.now() - start
    if (c.req.path !== '/api/health') {
      // Route through the scope logger (not bare console.log) so this — the
      // highest-volume log line — actually reaches the file sink when file
      // logging is enabled. Bare console.log bypasses writeToFile().
      httpLog.info(`[${c.req.method}] ${c.req.path} → ${c.res.status} (${ms}ms)`)
    }
  })

  const apiRouter = buildApiRouter(sessionManager, opts.configDir, opts.mpStore, opts.defaults?.claudeBinary)
  // Expose server defaults to the UI (used to prefill the "new session" form).
  // The fallback model string is sent through to the SDK unchanged when the
  // user doesn't override it; CLI `--model` and UI field both win over this.
  apiRouter.get('/config', (c) =>
    c.json({
      configured: !!serverConfig.authToken,
      defaults: {
        cwd: opts.defaults?.cwd ?? process.cwd(),
        model: opts.defaults?.model ?? serverConfig.defaultModel,
      },
      models: serverConfig.modelList,
      maxOpenPanels: serverConfig.maxOpenPanels,
    }),
  )

  // Access info for the "open on phone" (QR) dialog. Mounted on the
  // authed apiRouter so only an already-signed-in client can read the
  // token (it's an httpOnly cookie, invisible to client JS otherwise).
  // Returns the LAN token-URLs the frontend renders as QR codes; empty
  // when the server is bound to loopback (no phone can reach it).
  apiRouter.get('/access-info', (c) => {
    const { accessToken, authEnabled } = getWebAuth()
    const port = opts.bind?.port
    const boundHost = opts.bind?.host ?? '127.0.0.1'
    const lanReachable = !!port && !isLoopbackHost(boundHost)
    const tokenQuery = authEnabled && accessToken ? `/?token=${accessToken}` : '/'
    const urls = lanReachable
      ? lanIPv4Addresses().map((ip) => ({ ip, url: `http://${ip}:${port}${tokenQuery}` }))
      : []
    return c.json({ authEnabled, boundHost, lanReachable, port: port ?? null, urls })
  })

  app.route('/api', apiRouter)
  app.route('/api/fs', buildFsRouter())
  app.route('/api/git', buildGitRouter())
  if (opts.mcpConfigStore) {
    app.route('/api/mcp-config', buildMcpConfigRouter(opts.mcpConfigStore))
  }
  if (opts.snippetStore) {
    app.route('/api/snippets', buildSnippetRouter(opts.snippetStore))
  }

  const clientDir = resolveClientDir(opts.clientDir)
  if (clientDir) {
    console.log(`[app] serving client from ${clientDir}`)
    // Read index.html once at startup and cache it. The previous approach
    // called readFileSync on every non-API request, blocking the event loop.
    const indexPath = resolvePath(clientDir, 'index.html')
    const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null
    // Serve static assets. Hono's serveStatic only matches existing files;
    // we add an SPA fallback so client-side routing works too.
    app.use('/*', serveStatic({ root: clientDir }))
    app.get('*', (c) => {
      if (indexHtml) return c.html(indexHtml)
      return c.text('index.html not found', 404)
    })
  } else {
    app.get('/', (c) =>
      c.text(
        'claude-react-web API is running, but no built client was found.\n' +
        'Run `npm run build` to produce dist/client, or use `npm run dev` for the Vite dev server.',
      ),
    )
  }

  return { app, sessionManager }
}
