// claude-react-web — bin entry.
//
// Parses argv, starts the Hono server on the chosen port, and (unless
// --no-open) opens the user's default browser at the served URL.

import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import open from 'open'
import QRCode from 'qrcode'
import { buildApp } from './app.js'
import pkg from '../package.json' with { type: 'json' }
import { isLoopbackHost, lanIPv4Addresses } from './net.js'
import { setWebAuth } from './auth.js'
import { loadConfig, config } from './config.js'
import { disableFileLogging, getLogFilePath, createLogger } from './log.js'
import { SessionStore, defaultStateDir } from './persistence.js'
import { McpConfigStore } from './mcp-config.js'
import { SessionManager } from './session-manager.js'
import { SnippetStore } from './snippet-store.js'
import { UiStateStore } from './ui-state-store.js'
import { UploadStore } from './upload-store.js'
import { MpStore } from './mp-store.js'
import { AppPluginStore } from './app-plugins/app-plugin-store.js'
import { AppPluginMarketplaceStore } from './app-plugins/marketplace-store.js'
import { AppPluginManager } from './app-plugins/app-plugin-manager.js'
import { seedBuiltinMarketplace } from './app-plugins/builtin-marketplace.js'
import { attachWebSocket } from './ws.js'
import { checkForUpdates } from './update-checker.js'
import { startEventLoopProbe } from './event-loop-probe.js'
import { resolveClaudeBinary } from './claude-binary.js'

const log = createLogger('cli')

interface CliArgs {
  port: number
  host: string
  open: boolean
  cwd?: string
  model?: string
  stateDir?: string
  claudeBinary?: string
  token?: string
  disableAppPlugins: boolean
  safeMode: boolean
  help: boolean
  version: boolean
}

const HELP = `
claude-react-web — local interactive chat powered by @anthropic-ai/claude-agent-sdk

Usage:
  claude-react-web [options]

Options:
  -p, --port <port>    Server port (default: 3456)
      --host <host>    Bind host (default: 127.0.0.1). Use 0.0.0.0 to allow
                       LAN access (e.g. from a phone) — this REQUIRES a web
                       access token (auto-generated if --token is omitted).
      --token <token>  Shared web access token required to use the UI. When
                       set, every visitor must supply it via /?token=<token>
                       once (a cookie is then set). Auto-generated when the
                       host is non-loopback and no token is configured. Pin
                       a stable value here or as "accessToken" in config.json.
  -o, --open           Open browser on start (default)
      --no-open        Do not open a browser window
      --cwd <path>     Default cwd advertised to new sessions (informational)
      --model <name>   Default model advertised to new sessions (informational)
      --state-dir <p>  Where to keep session metadata and config.json
                       (default: ~/.claude-react-web)
      --claude-binary <path>
                       Path to the claude CLI binary. Default: resolved from
                       CLAUDE_CODE_BINARY env or \`which claude\`. Use this if
                       the SDK's auto-detection picks a wrong native build
                       (e.g. musl binary on a glibc host).
  -V, --version        Print version and exit
  -h, --help           Show this help and exit
`.trim()

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: 3456,
    host: '127.0.0.1',
    open: true,
    disableAppPlugins: false,
    safeMode: false,
    help: false,
    version: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '-p':
      case '--port': {
        const v = Number(next())
        if (!Number.isInteger(v) || v <= 0 || v > 65535) {
          console.error(`invalid --port: ${argv[i]}`)
          process.exit(2)
        }
        args.port = v
        break
      }
      case '--host':
        args.host = next() ?? args.host
        break
      case '-o':
      case '--open':
        args.open = true
        break
      case '--no-open':
        args.open = false
        break
      case '--cwd':
        args.cwd = next()
        break
      case '--model':
        args.model = next()
        break
      case '--state-dir':
        args.stateDir = next()
        break
      case '--claude-binary':
        args.claudeBinary = next()
        break
      case '--token':
        args.token = next()
        break
      case '--disable-app-plugins':
        args.disableAppPlugins = true
        break
      case '--safe-mode':
        args.safeMode = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      case '-V':
      case '--version':
        args.version = true
        break
      default:
        console.error(`unknown argument: ${a}`)
        process.exit(2)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.version) {
    console.log(pkg.version)
    return
  }
  if (args.help) {
    console.log(HELP)
    return
  }

  const stateDir = args.stateDir ?? defaultStateDir()
  await loadConfig(stateDir)
  if (!config.authToken) {
    console.warn(
      '[cli] WARNING: authToken is not configured.\n' +
      '       Open the web UI to set it, or edit config.json and add:\n' +
      '         "authToken": "<your token>"',
    )
  }

  // --- Web access auth gating -----------------------------------------
  // Resolve the shared web-access token and whether auth is enforced.
  //  1) Explicit token (--token or config.accessToken) → always enforce.
  //  2) Else non-loopback host → auto-generate a token and enforce
  //     (safe-by-default when exposed to a LAN).
  //  3) Else (loopback + no token) → no auth (preserves local behavior).
  const explicitToken = args.token || config.accessToken
  const isPublic = !isLoopbackHost(args.host)
  let accessToken = explicitToken
  let authEnabled = false
  let tokenAutoGenerated = false
  if (explicitToken) {
    authEnabled = true
  } else if (isPublic) {
    accessToken = randomBytes(24).toString('base64url')
    authEnabled = true
    tokenAutoGenerated = true
  }
  setWebAuth(accessToken, authEnabled)
  const store = new SessionStore({ stateDir })
  const loaded = await store.load()
  if (loaded.length) {
    log.info(`loaded ${loaded.length} session(s) from ${stateDir}`)
  }

  const mcpStore = new McpConfigStore({ stateDir })
  const mcpServers = await mcpStore.load()
  if (mcpServers.length) {
    log.info(`loaded ${mcpServers.length} MCP server(s) from ${stateDir}`)
  }

  const mpStore = new MpStore({ stateDir })
  const mpEntries = await mpStore.load()
  if (mpEntries.length) {
    log.info(`loaded ${mpEntries.length} marketplace(s) from ${stateDir}`)
  }

  const snippetStore = new SnippetStore({ stateDir })
  const snippets = await snippetStore.load()
  if (snippets.length) {
    log.info(`loaded ${snippets.length} composer snippet(s) from ${stateDir}`)
  }

  const uiStateStore = new UiStateStore({ stateDir })
  await uiStateStore.load()

  const uploadStore = new UploadStore({ stateDir })
  const uploadEntries = await uploadStore.load()
  if (uploadEntries.length) {
    log.info(`loaded ${uploadEntries.length} uploaded-file registry ${uploadEntries.length === 1 ? 'entry' : 'entries'} from ${stateDir}`)
  }

  const claudeBinary = resolveClaudeBinary(args.claudeBinary)
  if (claudeBinary) {
    log.info(`using claude binary: ${claudeBinary}`)
  } else {
    log.info(
      'no claude binary explicitly set — relying on SDK auto-detection ' +
        '(if sessions fail with "Claude Code native binary not found", pass --claude-binary)',
    )
  }

  // Construct the SessionManager explicitly (rather than letting buildApp do
  // it lazily) so the App Plugin manager's host adapters can reference it.
  // buildApp accepts a pre-built manager via opts.sessionManager.
  const sessionManager = new SessionManager({
    store,
    mcpConfigStore: mcpStore,
    mpStore,
    claudeBinary,
    autoResume: true,
    crashRecovery: true,
  })

  // Seed the uploads registry from sessions' on-disk claude-web-uploads/
  // folders. Idempotent (path-keyed) — safe on every boot; deleted entries
  // never resurrect because every delete also unlinks the file.
  const backfilled = await uploadStore.backfillFromSessions(sessionManager.list())
  if (backfilled > 0) {
    log.info(`backfilled ${backfilled} upload ${backfilled === 1 ? 'entry' : 'entries'} from session cwds`)
  }

  // App Plugins subsystem. Under --disable-app-plugins we still construct
  // the manager (so shutdown() is uniform) but pass `undefined` to buildApp
  // and attachWebSocket — the /api/app-plugins routes are NOT mounted and
  // no app-plugin WS frames are emitted, matching the "absent" contract.
  // Under --safe-mode the registry loads and static contributions register,
  // but no subprocess ever activates (honoured by Stage B2's runtime).
  const appPluginStore = new AppPluginStore({ stateDir })
  const appPluginMarketplaceStore = new AppPluginMarketplaceStore({ stateDir })
  await appPluginMarketplaceStore.load()
  // Seed the bundled official App Plugin marketplace on first launch (no-op on
  // later launches; skipped when app plugins are disabled).
  if (!args.disableAppPlugins) {
    await seedBuiltinMarketplace(appPluginMarketplaceStore)
  }
  const appPluginManager = new AppPluginManager({
    store: appPluginStore,
    stateDir,
    hostVersion: pkg.version,
    hostNodeMajor: Number((process.versions.node ?? '0.0.0').split('.')[0]),
    sm: sessionManager,
    safeMode: args.safeMode,
    disabled: args.disableAppPlugins,
    marketplaceStore: appPluginMarketplaceStore,
  })
  await appPluginManager.initialize()
  if (args.disableAppPlugins) {
    log.info('app plugins disabled (--disable-app-plugins)')
  }

  const { getLogConfig } = await import('./log.js')
  const initial = getLogConfig()
  log.info(
    `log: level=${initial.level}` +
      (initial.scopes ? ` scopes=${initial.scopes.join(',')}` : ' scopes=*') +
      ' (override via LOG_LEVEL / LOG_SCOPES, or PUT /api/log at runtime)',
  )
  const logFilePath = getLogFilePath()
  if (logFilePath) {
    log.info(`file logging: ${logFilePath}`)
  }

  const { app } = buildApp({
    sessionManager,
    sessionStore: store,
    mcpConfigStore: mcpStore,
    snippetStore,
    uploadStore,
    uiStateStore,
    mpStore,
    appPluginManager: args.disableAppPlugins ? undefined : appPluginManager,
    appPluginMarketplaceStore: args.disableAppPlugins ? undefined : appPluginMarketplaceStore,
    defaults: { cwd: args.cwd, model: args.model, claudeBinary },
    configDir: stateDir,
    bind: { host: args.host, port: args.port },
  })
  const url = `http://${args.host}:${args.port}`
  const tokenQuery = `/?token=${accessToken}`
  const localOpenUrl = authEnabled
    ? `http://127.0.0.1:${args.port}${tokenQuery}`
    : url

  // Print the web-access summary. When auth is enabled this is the ONLY
  // place the token is logged. For LAN-reachable hosts (isPublic) each LAN
  // URL is followed by a scannable terminal QR code so a phone can open the
  // already-authenticated UI without typing the token by hand. Async because
  // QR rendering is async; a render failure degrades to the plain-text link.
  async function printAccessSummary(): Promise<void> {
    if (!authEnabled) return
    console.log('[cli] ──────────────────────────────────────────────')
    console.log('[cli] 🔒 WEB ACCESS TOKEN REQUIRED')
    if (tokenAutoGenerated) {
      console.log('[cli]    (auto-generated because the host is non-loopback)')
    }
    console.log('[cli]    Open ONE of these links to sign in:')
    console.log(`[cli]      http://127.0.0.1:${args.port}${tokenQuery}`)
    for (const ip of lanIPv4Addresses()) {
      const lanUrl = `http://${ip}:${args.port}${tokenQuery}`
      console.log(`[cli]      ${lanUrl}`)
      if (isPublic) {
        try {
          const qr = await QRCode.toString(lanUrl, { type: 'terminal', small: true })
          // QRCode emits its own multi-line block; print as-is so the
          // module quiet-zone renders correctly (no [cli] prefix).
          console.log(qr)
        } catch {
          /* QR render failed — the plain-text link above still works */
        }
      }
    }
    if (isPublic) {
      console.log('[cli]    📱 Scan a QR code above to open it on your phone.')
    }
    console.log('[cli]    WARNING: anyone on your network with this link gets')
    console.log('[cli]    FULL access (shell, files, git, API key). Keep it private.')
    if (tokenAutoGenerated) {
      console.log('[cli]    To keep a stable token across restarts, set "accessToken"')
      console.log('[cli]    in config.json or pass --token <value>.')
    }
    console.log('[cli] ──────────────────────────────────────────────')
  }

  const server = serve(
    {
      fetch: app.fetch,
      hostname: args.host,
      port: args.port,
    },
    (info) => {
      console.log(`[cli] listening on http://${info.address}:${info.port}`)
      console.log(`[cli] session idle GC active (30 min)`)

      // Fire-and-forget: prints the auth summary + QR codes. Ordered after
      // the listen log because it's awaited inside; failures are swallowed.
      void printAccessSummary()

      if (args.open) {
        open(localOpenUrl).catch(() => {
          log.info(`could not auto-open browser — visit ${localOpenUrl} manually`)
        })
      }
      // Fire-and-forget update probe. Failures are swallowed — the
      // checker writes the error to its cached snapshot, which the UI
      // can surface in the About view; we don't want to spam stdout
      // when the registry is unreachable behind a firewall. Skipped
      // entirely when no registry is configured (info.disabled).
      void checkForUpdates().then((upd) => {
        if (upd.disabled) return
        if (upd.hasUpdate && upd.latest) {
          log.info(`update available: ${upd.current} → ${upd.latest}`)
          log.info(`  run: npx claude-react-web@latest`)
        }
      }).catch(() => {})
    },
  )

  // Abrupt client deaths (process kill, network drop, proxy timeout) RST the
  // TCP socket mid-connection. Neither @hono/node-server nor — for sockets
  // erroring outside its write path — Node attach a catch-all 'error'
  // listener, and an 'error' event with NO listener crashes the whole process
  // ("Unhandled 'error' event … read ECONNRESET"; reproduced by hard-exiting
  // a single WS client). Swallow it here: every real consumer (hono, ws) has
  // its own error/close handling — this only stops the fatal unhandled-event
  // path. 'connection' fires for every TCP socket the server accepts,
  // including the ones later upgraded to WebSocket.
  server.on('connection', (socket) => {
    socket.on('error', () => {})
  })

  // Attach the WebSocket multiplexer to the same HTTP server. The
  // returned shutdown fn closes every live socket during SIGINT.
  // @hono/node-server returns a Node http.Server (same shape), so cast
  // is safe.
  const wsShutdown = attachWebSocket(server as unknown as Server, sessionManager, args.disableAppPlugins ? undefined : appPluginManager)

  // Diagnostic: sample event-loop delay so a synchronous stall (which makes
  // unrelated sessions appear to hang) shows up in the logs as a max spike.
  // Default-on; disable with EVENT_LOOP_PROBE=0.
  const elProbe = startEventLoopProbe()

  const shutdown = async (signal: string) => {
    console.log(`\n[cli] received ${signal}, shutting down...`)
    elProbe.stop()
    // BEFORE any await: the same console signal that reaches us also kills
    // plugin children (no SIGINT handler) — mark their exits as expected
    // teardown, not crashes (see PluginProcessManager.shuttingDown).
    appPluginManager.prepareForShutdown()
    try {
      await wsShutdown()
    } catch (err) {
      log.error('ws shutdown error:', err)
    }
    disableFileLogging()
    await uiStateStore.flush()
    // App Plugins: flush the registry + marketplace store + tear down any
    // subprocesses (Stage B2). Runs before sessionManager.shutdown() so a
    // plugin mid-Host-call doesn't race the session pool teardown.
    try {
      await appPluginMarketplaceStore.flush()
    } catch (err) {
      log.error('app plugins marketplace flush error:', err)
    }
    try {
      await appPluginManager.shutdown()
    } catch (err) {
      log.error('app plugins shutdown error:', err)
    }
    try {
      await sessionManager.shutdown()
    } finally {
      server.close(() => process.exit(0))
      // Hard exit after 3s in case sockets are hung
      setTimeout(() => process.exit(0), 3000).unref()
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[cli] fatal:', err)
  process.exit(1)
})
