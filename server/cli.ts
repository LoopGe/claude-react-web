// claude-react-web — bin entry.
//
// Parses argv, starts the Hono server on the chosen port, and (unless
// --no-open) opens the user's default browser at the served URL.

import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import open from 'open'
import { buildApp } from './app.js'
import { setWebAuth } from './auth.js'
import { loadConfig, config } from './config.js'
import { disableFileLogging, getLogFilePath } from './log.js'
import { SessionStore, defaultStateDir } from './persistence.js'
import { McpConfigStore } from './mcp-config.js'
import { SnippetStore } from './snippet-store.js'
import { MpStore } from './mp-store.js'
import { attachWebSocket } from './ws.js'
import { checkForUpdates } from './update-checker.js'
import { startEventLoopProbe } from './event-loop-probe.js'

interface CliArgs {
  port: number
  host: string
  open: boolean
  cwd?: string
  model?: string
  stateDir?: string
  claudeBinary?: string
  token?: string
  help: boolean
}

/** Loopback hosts need no web-access token (only the local user can
 *  reach them). `0.0.0.0` binds all interfaces and is treated as public. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/** Collect non-internal IPv4 addresses for printing reachable LAN URLs. */
function lanIPv4Addresses(): string[] {
  const out: string[] = []
  const ifaces = networkInterfaces()
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address)
    }
  }
  return out
}

/** Resolve the absolute path to the `claude` CLI binary.
 *
 *  Priority:
 *   1. Explicit CLI flag (--claude-binary)
 *   2. CLAUDE_CODE_BINARY env var
 *   3. `which claude` (Unix) / `where claude` (Windows) lookup on PATH
 *   4. Windows .cmd shim parsing — extracts the real script path from
 *      npm's cmd-shim wrapper (handles pnpm/yarn global installs)
 *   5. undefined → let the SDK fall back to its own resolution
 *
 *  Why this matters: `@anthropic-ai/claude-agent-sdk` bundles platform-
 *  specific native binary packages (e.g. -linux-x64-musl, -linux-x64).
 *  npm ought to install only the matching one, but on at least some
 *  glibc hosts npm installs both AND the SDK picks the musl path first,
 *  which then fails to exec (no musl linker on glibc systems). Passing
 *  a real path via Options.pathToClaudeCodeExecutable side-steps the
 *  whole detection path. */
function resolveClaudeBinary(explicit: string | undefined): string | undefined {
  if (explicit) {
    if (!existsSync(explicit)) {
      console.warn(`[cli] --claude-binary ${explicit} does not exist; ignoring`)
    } else {
      return explicit
    }
  }
  const fromEnv = process.env.CLAUDE_CODE_BINARY
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      console.warn(`[cli] CLAUDE_CODE_BINARY=${fromEnv} does not exist; ignoring`)
    } else {
      return fromEnv
    }
  }

  const isWin = process.platform === 'win32'

  // PATH lookup — `which` on Unix, `where` on Windows
  const lookupCmd = isWin ? 'where claude' : 'which claude'
  try {
    const out = execSync(lookupCmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (out) {
      // `where` can return multiple paths (one per line); prefer .cmd on Windows
      const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      if (isWin && candidates.length > 1) {
        const cmdCandidate = candidates.find((p) => p.endsWith('.cmd'))
        if (cmdCandidate) {
          const resolved = resolveCmdShim(cmdCandidate)
          if (resolved) return resolved
          if (existsSync(cmdCandidate)) return cmdCandidate
        }
      }
      const first = candidates[0]
      if (first && existsSync(first)) {
        // On Windows, if the hit is a .cmd shim try to resolve through it
        if (isWin && first.endsWith('.cmd')) {
          const resolved = resolveCmdShim(first)
          return resolved || first
        }
        return first
      }
    }
  } catch {
    /* claude not on PATH — fall through */
  }

  // Windows only: try common global install locations
  if (isWin) {
    const appData = process.env.APPDATA
    if (appData) {
      const globalCli = join(appData, 'npm', 'claude.cmd')
      if (existsSync(globalCli)) {
        const resolved = resolveCmdShim(globalCli)
        return resolved || globalCli
      }
    }
  }

  return undefined
}

/** Parse an npm cmd-shim .cmd file to extract the real script path.
 *
 *  npm's cmd-shim generates files with a line like:
 *    "%_prog%"  %~dp0\node_modules\...\claude.js %*
 *  We extract the script path relative to the .cmd file's directory. */
function resolveCmdShim(cmdPath: string): string | null {
  try {
    const content = readFileSync(cmdPath, 'utf8')
    const cmdDir = dirname(cmdPath)

    // Match the NPM cmd-shim execution line pattern:
    //   "%_prog%" ... "%dp0%\relative\path.js" %*
    // or: %dp0%\relative\path.js
    const match = content.match(/%dp0%\\([^"]+\.js)"?\s*[%*]/) ?? content.match(/"%dp0%\\([^"]+)"/)
    if (match) {
      const resolved = join(cmdDir, match[1])
      if (existsSync(resolved)) {
        console.log(`[cli] resolved claude via .cmd shim: ${cmdPath} → ${resolved}`)
        return resolved
      }
    }
  } catch {
    /* unreadable .cmd — fall through */
  }
  return null
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
  -h, --help           Show this help and exit
`.trim()

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: 3456,
    host: '127.0.0.1',
    open: true,
    help: false,
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
      case '-h':
      case '--help':
        args.help = true
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
    console.log(`[cli] loaded ${loaded.length} session(s) from ${stateDir}`)
  }

  const mcpStore = new McpConfigStore({ stateDir })
  const mcpServers = await mcpStore.load()
  if (mcpServers.length) {
    console.log(`[cli] loaded ${mcpServers.length} MCP server(s) from ${stateDir}`)
  }

  const mpStore = new MpStore({ stateDir })
  const mpEntries = await mpStore.load()
  if (mpEntries.length) {
    console.log(`[cli] loaded ${mpEntries.length} marketplace(s) from ${stateDir}`)
  }

  const snippetStore = new SnippetStore({ stateDir })
  const snippets = await snippetStore.load()
  if (snippets.length) {
    console.log(`[cli] loaded ${snippets.length} composer snippet(s) from ${stateDir}`)
  }

  const claudeBinary = resolveClaudeBinary(args.claudeBinary)
  if (claudeBinary) {
    console.log(`[cli] using claude binary: ${claudeBinary}`)
  } else {
    console.log(
      '[cli] no claude binary explicitly set — relying on SDK auto-detection ' +
        '(if sessions fail with "Claude Code native binary not found", pass --claude-binary)',
    )
  }

  const { getLogConfig } = await import('./log.js')
  const initial = getLogConfig()
  console.log(
    `[cli] log: level=${initial.level}` +
      (initial.scopes ? ` scopes=${initial.scopes.join(',')}` : ' scopes=*') +
      ' (override via LOG_LEVEL / LOG_SCOPES, or PUT /api/log at runtime)',
  )
  const logFilePath = getLogFilePath()
  if (logFilePath) {
    console.log(`[cli] file logging: ${logFilePath}`)
  }

  const { app, sessionManager } = buildApp({
    sessionStore: store,
    mcpConfigStore: mcpStore,
    snippetStore,
    mpStore,
    defaults: { cwd: args.cwd, model: args.model, claudeBinary },
    configDir: stateDir,
  })
  const url = `http://${args.host}:${args.port}`

  const server = serve(
    {
      fetch: app.fetch,
      hostname: args.host,
      port: args.port,
    },
    (info) => {
      console.log(`[cli] listening on http://${info.address}:${info.port}`)
      console.log(`[cli] session idle GC active (30 min)`)

      // Web access auth summary. When enabled, print the token-bearing
      // URLs (the ONLY place the token is logged) and a security warning.
      // The token query param seeds a cookie on first visit.
      const tokenQuery = `/?token=${accessToken}`
      const localOpenUrl = authEnabled
        ? `http://127.0.0.1:${args.port}${tokenQuery}`
        : url
      if (authEnabled) {
        console.log('[cli] ──────────────────────────────────────────────')
        console.log('[cli] 🔒 WEB ACCESS TOKEN REQUIRED')
        if (tokenAutoGenerated) {
          console.log('[cli]    (auto-generated because the host is non-loopback)')
        }
        console.log('[cli]    Open ONE of these links to sign in:')
        console.log(`[cli]      http://127.0.0.1:${args.port}${tokenQuery}`)
        for (const ip of lanIPv4Addresses()) {
          console.log(`[cli]      http://${ip}:${args.port}${tokenQuery}`)
        }
        console.log('[cli]    WARNING: anyone on your network with this link gets')
        console.log('[cli]    FULL access (shell, files, git, API key). Keep it private.')
        if (tokenAutoGenerated) {
          console.log('[cli]    To keep a stable token across restarts, set "accessToken"')
          console.log('[cli]    in config.json or pass --token <value>.')
        }
        console.log('[cli] ──────────────────────────────────────────────')
      }

      if (args.open) {
        open(localOpenUrl).catch(() => {
          console.log(`[cli] could not auto-open browser — visit ${localOpenUrl} manually`)
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
          console.log(`[cli] update available: ${upd.current} → ${upd.latest}`)
          console.log(`[cli]   run: npx claude-react-web@latest`)
        }
      })
    },
  )

  // Attach the WebSocket multiplexer to the same HTTP server. The
  // returned shutdown fn closes every live socket during SIGINT.
  // @hono/node-server returns a Node http.Server (same shape), so cast
  // is safe.
  const wsShutdown = attachWebSocket(server as unknown as Server, sessionManager)

  // Diagnostic: sample event-loop delay so a synchronous stall (which makes
  // unrelated sessions appear to hang) shows up in the logs as a max spike.
  // Default-on; disable with EVENT_LOOP_PROBE=0.
  const elProbe = startEventLoopProbe()

  const shutdown = async (signal: string) => {
    console.log(`\n[cli] received ${signal}, shutting down...`)
    elProbe.stop()
    try {
      await wsShutdown()
    } catch (err) {
      console.error('[cli] ws shutdown error:', err)
    }
    disableFileLogging()
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
