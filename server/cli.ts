// claude-react-web — bin entry.
//
// Parses argv, starts the Hono server on the chosen port, and (unless
// --no-open) opens the user's default browser at the served URL.

import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import open from 'open'
import { buildApp } from './app.js'
import { loadConfig, config } from './config.js'
import { SessionStore, defaultStateDir } from './persistence.js'
import { McpConfigStore } from './mcp-config.js'
import { attachWebSocket } from './ws.js'

interface CliArgs {
  port: number
  host: string
  open: boolean
  cwd?: string
  model?: string
  stateDir?: string
  claudeBinary?: string
  help: boolean
}

/** Resolve the absolute path to the `claude` CLI binary.
 *
 *  Priority:
 *   1. Explicit CLI flag (--claude-binary)
 *   2. CLAUDE_CODE_BINARY env var
 *   3. `which claude` lookup on the shell PATH
 *   4. undefined → let the SDK fall back to its own resolution
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
  try {
    const out = execSync('which claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (out && existsSync(out)) return out
  } catch {
    /* claude not on PATH — fall through */
  }
  return undefined
}

const HELP = `
claude-react-web — local interactive chat powered by @anthropic-ai/claude-agent-sdk

Usage:
  claude-react-web [options]

Options:
  -p, --port <port>    Server port (default: 3456)
      --host <host>    Bind host (default: 127.0.0.1)
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
    const configPath = `${stateDir}/config.json`
    console.warn(
      `[cli] WARNING: authToken is not set in ${configPath}.\n` +
      '       Open the web UI to configure it, or add this to config.json:\n' +
      '         {\n' +
      '           "authToken": "<your token>",\n' +
      '           "baseUrl": "<optional; defaults to https://api.anthropic.com>"\n' +
      '         }',
    )
  }
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

  const claudeBinary = resolveClaudeBinary(args.claudeBinary)
  if (claudeBinary) {
    console.log(`[cli] using claude binary: ${claudeBinary}`)
  } else {
    console.log(
      '[cli] no claude binary explicitly set — relying on SDK auto-detection ' +
        '(if sessions fail with "Claude Code native binary not found", pass --claude-binary)',
    )
  }

  const { app, sessionManager } = buildApp({
    sessionStore: store,
    mcpConfigStore: mcpStore,
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
      if (args.open) {
        open(url).catch(() => {
          console.log(`[cli] could not auto-open browser — visit ${url} manually`)
        })
      }
    },
  )

  // Attach the WebSocket multiplexer to the same HTTP server. The
  // returned shutdown fn closes every live socket during SIGINT.
  // @hono/node-server returns a Node http.Server (same shape), so cast
  // is safe.
  const wsShutdown = attachWebSocket(server as unknown as Server, sessionManager)

  const shutdown = async (signal: string) => {
    console.log(`\n[cli] received ${signal}, shutting down...`)
    try {
      await wsShutdown()
    } catch (err) {
      console.error('[cli] ws shutdown error:', err)
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
