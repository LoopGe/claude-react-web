// Compose the Hono app: CORS for dev, REST + WebSocket on /api, static client on /.

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionManager } from './session-manager.js'
import { HttpError } from './errors.js'
import { buildApiRouter } from './routes/index.js'
import { buildFsRouter } from './fs-routes.js'
import { buildMcpConfigRouter } from './mcp-routes.js'
import { config as serverConfig } from './config.js'
import type { SessionStore } from './persistence.js'
import type { McpConfigStore } from './mcp-config.js'

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
  /** Default values exposed via GET /api/config (used by the "new session" form).
   *  `claudeBinary` is NOT exposed to the UI — it's a server-side concern
   *  that gets injected into every Query via options.pathToClaudeCodeExecutable. */
  defaults?: { cwd?: string; model?: string; claudeBinary?: string }
  /** State directory containing config.json. Passed to the API router
   *  so the setup endpoint can write config changes to disk. */
  configDir?: string
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
      claudeBinary: opts.defaults?.claudeBinary,
      autoResume: true,
    })
  const app = new Hono()

  // Global error handler — catches unhandled errors from sub-routers
  // (e.g. buildFsRouter) that don't have their own onError.
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 410 | 500)
    }
    console.error('[app] unhandled error:', err)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  })

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

  app.use('*', async (c, next) => {
    // Basic request log — helps when diagnosing CLI issues.
    const start = Date.now()
    await next()
    const ms = Date.now() - start
    if (c.req.path !== '/api/health') {
      console.log(`[${c.req.method}] ${c.req.path} → ${c.res.status} (${ms}ms)`)
    }
  })

  const apiRouter = buildApiRouter(sessionManager, opts.configDir)
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
  app.route('/api', apiRouter)
  app.route('/api/fs', buildFsRouter())
  if (opts.mcpConfigStore) {
    app.route('/api/mcp-config', buildMcpConfigRouter(opts.mcpConfigStore))
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
