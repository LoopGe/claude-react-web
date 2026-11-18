// Test-only MCP server over stdio (native provider connection-manager tests).
//
/* global process -- Node globals are not configured for non-TS server files */
//
// argv: [byePath, mode?, flakyBudget?]
//   byePath  file written when the child is asked to stop, so a test can prove
//            the spawned process really terminated (no leaked child).
//   --hang   never answer `initialize` (no MCP server is created at all) so the
//            client's connect timeout has to fire.
//   --hang-tools  answer `initialize`, then never answer `tools/list`, so tool
//            discovery — not the handshake — is what is in flight.
//   --crash  answer `initialize` and `tools/list` normally, and register a
//            `slow` tool that never answers and exits the process when called.
//            A test places an in-flight `slow` call and the crash is guaranteed
//            to land under it — strictly after the handshake AND discovery, so
//            load cannot turn "crash after discovery" into a connect failure
//            (the old fixed exit timer armed at transport setup could).
//   --flaky  spawn 1 behaves like --crash; spawns 2..(1+budget) exit(1) BEFORE
//            the handshake (budget = argv[4], default 3), so a reconnect
//            supervisor burns its attempt budget deterministically; later
//            spawns are healthy. The spawn count persists in `${byePath}.flaky`
//            so a test can prove exactly which attempts ran (and that none
//            ran after give-up / close).
//
// The marker is written on every way out: a POSIX signal handler, stdin EOF
// (which is how a stdio transport's `close()` reaches the child), and the
// process exit hook. On Windows a `kill('SIGTERM')` is a hard terminate that
// never runs JS handlers, so the stdin-EOF/exit path is the one that matters
// there.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

const byePath = process.argv[2]
const mode = process.argv[3]

function markOnce(path, text) {
  try {
    writeFileSync(path, text)
  } catch {
    // the temp dir can already be gone during a hard shutdown
  }
}

let wroteBye = false
function bye() {
  if (wroteBye) return
  wroteBye = true
  markOnce(byePath, 'bye')
}

process.on('SIGTERM', () => {
  bye()
  process.exit(0)
})
process.on('SIGINT', () => {
  bye()
  process.exit(0)
})
process.on('exit', bye)
process.stdin.on('end', () => {
  bye()
  process.exit(0)
})

// --flaky spawn accounting, before any exit path so every spawn is counted.
// Attempts are serialized by the supervisor, so the read-increment-write is
// never concurrent.
if (mode === '--flaky') {
  const countPath = `${byePath}.flaky`
  let prev = 0
  try {
    prev = parseInt(readFileSync(countPath, 'utf8'), 10) || 0
  } catch {
    // first spawn: no counter file yet
  }
  const spawn = prev + 1
  markOnce(countPath, String(spawn))
  const budget = parseInt(process.argv[4] ?? '3', 10)
  if (spawn >= 2 && spawn <= 1 + budget) {
    process.exit(1)
  }
}

if (mode === '--hang') {
  // Consume input and never answer: `initialize` is left pending.
  process.stdin.resume()
} else if (mode === '--hang-tools') {
  // A raw `Server`, not `McpServer`: `McpServer` installs its own `tools/list`
  // handler on connect and refuses a second one, so owning that handler is the
  // only way to stall discovery. The handshake answers normally (the client
  // initializes and knows this server advertises tools); `tools/list` is
  // acknowledged with a marker file and then never settles.
  const server = new Server(
    { name: 'fixture-hang-tools', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => {
    markOnce(`${byePath}.tools-requested`, 'tools/list')
    return new Promise(() => {})
  })
  await server.connect(new StdioServerTransport())
} else {
  const server = new McpServer({ name: 'fixture-echo', version: '1.0.0' })
  server.registerTool(
    'echo',
    {
      description: 'Echo the given text back.',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  )
  if (mode === '--crash' || mode === '--flaky') {
    server.registerTool(
      'slow',
      {
        description: 'Never answers; calling it crashes the server.',
        inputSchema: {},
      },
      () => {
        // The handler runs on receipt of the call and no response is ever
        // sent, so the call is in flight by construction when the exit lands.
        // The `exit` hook above still writes the `bye` marker.
        process.exit(1)
      },
    )
  }
  await server.connect(new StdioServerTransport())
}
