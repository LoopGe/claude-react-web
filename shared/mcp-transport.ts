// Neutral MCP transport-target contract: the serializable subset of a server
// config needed to build a client transport. This module imports nothing, so
// it is safe to import from both host and host-free code.

/** Serializable subset of a stored server needed to build a client transport.
 *  `StoredMcpServer` is structurally assignable to it. */
export interface McpTransportTarget {
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}
