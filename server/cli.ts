// claude-react-web — bin entry.
//
// Parses argv, starts the Hono server on the chosen port, and (unless
// --no-open) opens the user's default browser at the served URL.

import { serve } from '@hono/node-server'
import open from 'open'
import { buildApp } from './app.js'
import { SessionStore, defaultStateDir } from './persistence.js'

interface CliArgs {
  port: number
  host: string
  open: boolean
  cwd?: string
  model?: string
  stateDir?: string
  help: boolean
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
      --state-dir <p>  Where to keep session metadata (default: ~/.claude-react-web)
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
  const store = new SessionStore({ stateDir })
  const loaded = await store.load()
  if (loaded.length) {
    console.log(`[cli] loaded ${loaded.length} session(s) from ${stateDir}`)
  }

  const { app, sessionManager } = buildApp({
    sessionStore: store,
    defaults: { cwd: args.cwd, model: args.model },
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

  const shutdown = async (signal: string) => {
    console.log(`\n[cli] received ${signal}, shutting down...`)
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
