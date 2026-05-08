// Compose the Hono app: CORS for dev, REST+SSE on /api, static client on /.

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionManager } from './session-manager.js'
import { buildApiRouter } from './routes.js'
import { buildFsRouter } from './fs-routes.js'
import type { SessionStore } from './persistence.js'

export interface AppOptions {
  /** Directory containing the built frontend (dist/client). */
  clientDir?: string
  /** Multi-session pool manager (created lazily if omitted). */
  sessionManager?: SessionManager
  /** Metadata store. If provided without `sessionManager`, a new manager
   *  is constructed wired up to this store. Ignored when `sessionManager`
   *  is supplied (assume the caller already wired it). */
  sessionStore?: SessionStore
  /** Default values exposed via GET /api/config (used by the "new session" form).
   *  `claudeBinary` is NOT exposed to the UI — it's a server-side concern
   *  that gets injected into every Query via options.pathToClaudeCodeExecutable. */
  defaults?: { cwd?: string; model?: string; claudeBinary?: string }
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
    new SessionManager({ store: opts.sessionStore, claudeBinary: opts.defaults?.claudeBinary })
  const app = new Hono()

  app.use('*', cors({ origin: (o) => o ?? '*', credentials: false }))
  app.use('*', async (c, next) => {
    // Basic request log — helps when diagnosing CLI issues.
    const start = Date.now()
    await next()
    const ms = Date.now() - start
    if (c.req.path !== '/api/health') {
      console.log(`[${c.req.method}] ${c.req.path} → ${c.res.status} (${ms}ms)`)
    }
  })

  const apiRouter = buildApiRouter(sessionManager)
  // Expose server defaults to the UI (used to prefill the "new session" form).
  // The fallback model string is sent through to the SDK unchanged when the
  // user doesn't override it; CLI `--model` and UI field both win over this.
  apiRouter.get('/config', (c) =>
    c.json({
      defaults: {
        cwd: opts.defaults?.cwd ?? process.cwd(),
        model: opts.defaults?.model ?? 'xiaomi/mimo-v2.5-pro',
      },
    }),
  )
  app.route('/api', apiRouter)
  app.route('/api/fs', buildFsRouter())

  const clientDir = resolveClientDir(opts.clientDir)
  if (clientDir) {
    console.log(`[app] serving client from ${clientDir}`)
    // Serve static assets. Hono's serveStatic only matches existing files;
    // we add an SPA fallback so client-side routing works too.
    app.use('/*', serveStatic({ root: clientDir }))
    app.get('*', (c) => {
      const indexPath = resolvePath(clientDir, 'index.html')
      const html = readFileSync(indexPath, 'utf8')
      return c.html(html)
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
