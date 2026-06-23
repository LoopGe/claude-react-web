/** Input shape for creating/updating a global MCP server. */
export interface McpServerInput {
  name: string
  type?: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  alwaysLoad?: boolean
  enabled?: boolean
  /** Per-server tool-call timeout in milliseconds. Overrides the global
   *  default for this server only. Values below 1000 are ignored by the
   *  SDK (falls through to the default). */
  timeout?: number
}
