// Test-only MCP server over stdio (native provider connection-manager tests).
//
/* global process -- Node globals are not configured for non-TS server files */
//
// argv: [byePath, mode?]
//   byePath  file written when the child is asked to stop, so a test can prove
//            the spawned process really terminated (no leaked child).
//   --hang   never answer `initialize` (no MCP server is created at all) so the
//            client's connect timeout has to fire.
//   --hang-tools  answer `initialize`, then never answer `tools/list`, so tool
//            discovery — not the handshake — is what is in flight.
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
import { writeFileSync } from 'node:fs'
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
  await server.connect(new StdioServerTransport())
}