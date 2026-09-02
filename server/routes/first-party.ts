// Static first-party tool-server listing. First-party servers are in-process
// (createSdkMcpServer) — there is no live connection to probe with
// `client.listTools()` like a normal MCP server, so the listing comes
// straight from the code-registered FirstPartyToolRegistry. Stateless: no
// session, no config, no cwd.

import { Hono } from 'hono'
import { firstPartyRegistry } from '../sdk-tools/registry.js'

export function buildFirstPartyRouter() {
  const app = new Hono()
  app.get('/first-party-tools', (c) => c.json({ servers: firstPartyRegistry.listToolDefs() }))
  return app
}
