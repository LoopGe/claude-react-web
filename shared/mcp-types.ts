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
}

/** One server entry inside an export file — a config snapshot only:
 *  no timestamps, no OAuth state. */
export interface McpExportServer {
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  alwaysLoad?: boolean
  enabled?: boolean
}

/** Versioned export file envelope. */
export interface McpExportFile {
  format: 'claude-react-web-mcp'
  version: 1
  exportedAt: number
  secretScope: 'masked' | 'full'
  servers: McpExportServer[]
}

/** One entry in the import preview (masked + import status). */
export interface McpImportPreviewServer {
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  alwaysLoad?: boolean
  enabled?: boolean
  envKeys?: string[]
  headerKeys?: string[]
  errors: string[]
  exists: boolean
}

/** Result of POST /import. */
export interface McpImportResult {
  imported: string[]
  updated: string[]
  skipped: string[]
  failed: { name: string; error: string }[]
}
