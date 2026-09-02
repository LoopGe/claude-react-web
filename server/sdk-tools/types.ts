// First-party tool server contract for the SDK in-process MCP registry.
// A FirstPartyToolServer describes one in-process MCP server (e.g. the git
// `apptools` server) that the host injects into sessions. The SDK namespaces
// each server's tools as `mcp__{server}__{tool}`, so tool-name sets here are
// ALWAYS bare names — consumers derive FQNs via the registry.

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'

export interface FirstPartyToolServer {
  /** MCP server name — tools surface as `mcp__{name}__{tool}`. */
  name: string
  description: string
  /** Global default for injection. Session override and
   *  config.firstPartyTools override it (see SessionManager resolution). */
  defaultEnabled: boolean
  /** When true, the server is injected only for sessions that have a cwd. */
  requiresCwd: boolean
  /** Build the SDK tool definitions bound to the session cwd (null when the
   *  session has no cwd — a non-requiresCwd server may still use it). */
  buildTools(cwd: string | null): SdkMcpToolDefinition<any>[]
  /** BARE tool names (no `mcp__{name}__` prefix) that are read-only. */
  readOnlyToolNames?: ReadonlySet<string>
  /** BARE tool names that mutate the worktree / filesystem. */
  mutatingToolNames?: ReadonlySet<string>
}