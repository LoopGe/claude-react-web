// Global MCP server write operations.
//
// The four mutating routes in mcp-routes.ts are thin wrappers over these
// functions: they parse the request body, delegate here, and mask secrets in
// the response. Keeping the store mutations out of the route handlers lets the
// first-party agent tools reach the same behavior without an HTTP round-trip.
//
// Semantics match the former inline handler bodies exactly: create rejects a
// missing name (400), an existing name (409), then an invalid config (400);
// update/remove/toggle answer 404 for an unknown name; update merges env and
// headers instead of replacing them; every mutation stamps `updatedAt`.

import { HttpError } from './errors.js'
import {
  validateMcpServer,
  type McpConfigStore,
  type McpServerInput,
  type StoredMcpServer,
} from './mcp-config.js'

/** Create a new server, returning the stored record (secrets intact). */
export function createMcpServer(store: McpConfigStore, input: McpServerInput): StoredMcpServer {
  if (!input.name || !input.name.trim()) throw new HttpError(400, 'name is required')
  if (store.get(input.name.trim())) {
    throw new HttpError(409, `MCP server "${input.name}" already exists; use PUT to update`)
  }

  const errors = validateMcpServer(input)
  if (errors.length > 0) throw new HttpError(400, errors.join('; '))

  const now = Date.now()
  const server: StoredMcpServer = {
    name: input.name.trim(),
    type: input.type ?? 'stdio',
    command: input.command,
    args: input.args,
    env: input.env,
    url: input.url,
    headers: input.headers,
    alwaysLoad: input.alwaysLoad,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }
  store.upsert(server)
  return server
}

/** Update an existing server. env/headers are merged (not replaced) so
 *  changing args never accidentally deletes stored secrets. */
export function updateMcpServer(
  store: McpConfigStore,
  name: string,
  input: Partial<McpServerInput>,
): StoredMcpServer {
  const existing = store.get(name)
  if (!existing) throw new HttpError(404, `MCP server "${name}" not found`)

  const updated: StoredMcpServer = {
    ...existing,
    type: input.type ?? existing.type,
    updatedAt: Date.now(),
  }
  if (input.command !== undefined) updated.command = input.command
  if (input.args !== undefined) updated.args = input.args
  if (input.url !== undefined) updated.url = input.url
  if (input.alwaysLoad !== undefined) updated.alwaysLoad = input.alwaysLoad
  if (input.enabled !== undefined) updated.enabled = input.enabled

  // Merge env: new keys added, existing keys kept unless overwritten.
  if (input.env) {
    updated.env = { ...(existing.env ?? {}), ...input.env }
  }
  // Merge headers: same strategy.
  if (input.headers) {
    updated.headers = { ...(existing.headers ?? {}), ...input.headers }
  }

  const errors = validateMcpServer(updated)
  if (errors.length > 0) throw new HttpError(400, errors.join('; '))

  store.upsert(updated)
  return updated
}

/** Remove an existing server. */
export function removeMcpServer(store: McpConfigStore, name: string): void {
  if (!store.get(name)) throw new HttpError(404, `MCP server "${name}" not found`)
  store.remove(name)
}

/** Set a server's enabled flag, returning the updated record. */
export function setMcpServerEnabled(
  store: McpConfigStore,
  name: string,
  enabled: boolean,
): StoredMcpServer {
  const existing = store.get(name)
  if (!existing) throw new HttpError(404, `MCP server "${name}" not found`)

  const updated: StoredMcpServer = { ...existing, enabled, updatedAt: Date.now() }
  store.upsert(updated)
  return updated
}
