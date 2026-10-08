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

/** A user-runnable diagnostic for a failed MCP server: either a shell command
 *  (stdio servers) or the endpoint URL (http/sse). */
export interface McpDiagnostic {
  kind: 'command' | 'url'
  value: string
}

/** Best-effort shell quoting for a diagnostic argv join: anything containing
 *  whitespace, an empty string, or a double quote gets double-quoted with
 *  inner quotes escaped. NOT a full cross-shell argument parser — double
 *  quotes keep `$`/backtick expansion live on POSIX shells, and the `\"`
 *  escape works in cmd.exe but not in PowerShell (which wants `""`).
 *  The goal is that the common cases (paths with spaces, header values)
 *  survive a paste into the user's terminal; exotic argv may still need
 *  manual editing. */
function quoteArg(a: string): string {
  if (a !== '' && !/[\s"]/.test(a)) return a
  return `"${a.replace(/"/g, '\\"')}"`
}

/** Narrow an SDK-reported MCP server config (arrives untyped through
 *  McpServerStatus.config) into a one-line diagnostic. When a server fails,
 *  the CLI only surfaces transport-level text ("Connection closed"); running
 *  the start command / visiting the URL directly is how the real cause
 *  (npm E401, crash on boot, unreachable host …) becomes visible. Primitive
 *  args render faithfully (String()); null/object entries are dropped rather
 *  than guessed at; unrecognized shapes return null. */
export function mcpDiagnostic(config: unknown): McpDiagnostic | null {
  if (!config || typeof config !== 'object') return null
  const c = config as { command?: unknown; args?: unknown; url?: unknown }
  if (typeof c.command === 'string' && c.command.trim()) {
    const args = Array.isArray(c.args)
      ? c.args.filter((a): a is string | number | boolean | bigint => typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean' || typeof a === 'bigint')
      : []
    return { kind: 'command', value: [quoteArg(c.command), ...args.map((a) => quoteArg(String(a)))].join(' ') }
  }
  if (typeof c.url === 'string' && c.url.trim()) {
    return { kind: 'url', value: c.url }
  }
  return null
}
