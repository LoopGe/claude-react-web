// CLI argument parsing shared by the server launcher and the subcommand
// dispatcher. The server flag parser + HELP text were moved here verbatim from
// cli.ts so both modes share one parser and the dispatcher can detect a leading
// subcommand without booting the server.

export interface CliArgs {
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

/** Existing server flag parser — moved verbatim from cli.ts. */
export function parseServerArgs(argv: string[]): CliArgs {
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

/** Server-mode help text — moved verbatim from cli.ts. */
export const HELP = `
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

/** Strip --state-dir (valid anywhere) and detect a leading subcommand.
 *  Returns the captured --state-dir, the detected command (first non-flag
 *  token) and the remaining command argv. When no subcommand is present,
 *  `command` is undefined and the caller falls through to the server path
 *  with the ORIGINAL argv (serverArgv handling stays in cli.ts). */
export function parseArgv(argv: string[]): { stateDir?: string; command?: string; commandArgv: string[] } {
  const rest: string[] = []
  let stateDir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--state-dir') { stateDir = argv[++i]; continue }
    if (a.startsWith('--state-dir=')) { stateDir = a.slice('--state-dir='.length); continue }
    rest.push(a)
  }
  const first = rest[0]
  if (first && !first.startsWith('-')) return { stateDir, command: first, commandArgv: rest.slice(1) }
  return { stateDir, command: undefined, commandArgv: [] }
}
