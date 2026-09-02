// First-party tool registry: the code-internal register of in-process MCP
// servers the host injects into sessions (replacing the apptools singleton).
// First-party servers are built per session (handlers bind the session cwd)
// and injected into the session's mcpServers map at spawn and on live
// setMcpServers. The registry also derives FQN sets for the permission-broker
// (read-only exemption) and git-broadcast (mutating-tool detection) seams.

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { gitAppTools } from './app-tools.js'
import type { FirstPartyToolServer } from './types.js'

export class FirstPartyToolRegistry {
  private readonly servers = new Map<string, FirstPartyToolServer>()

  register(s: FirstPartyToolServer): void {
    if (this.servers.has(s.name)) {
      throw new Error(`first-party tool server '${s.name}' is already registered`)
    }
    this.servers.set(s.name, s)
  }

  get(name: string): FirstPartyToolServer | undefined {
    return this.servers.get(name)
  }

  list(): ReadonlyArray<FirstPartyToolServer> {
    return [...this.servers.values()]
  }

  /** Build every enabled (and cwd-satisfied) first-party server into an
   *  mcpServers map. `enabled` is a resolver the session-manager injects
   *  (session override ?? global config ?? server.defaultEnabled); a server
   *  with `requiresCwd` is skipped when `cwd` is null. Returns undefined when
   *  nothing is injected. Per-server build failures are reported via
   *  `onError` and that server is skipped (others still inject). */
  injectAll(
    cwd: string | null,
    enabled: (name: string) => boolean,
    onError?: (name: string, message: string) => void,
  ): Record<string, unknown> | undefined {
    let result: Record<string, unknown> | undefined
    for (const s of this.servers.values()) {
      if (!enabled(s.name)) continue
      if (s.requiresCwd && !cwd) continue
      try {
        const server = createSdkMcpServer({
          name: s.name,
          version: '1.0.0',
          tools: s.buildTools(cwd),
        })
        result ??= {}
        result[s.name] = server
      } catch (e) {
        onError?.(s.name, e instanceof Error ? e.message : String(e))
      }
    }
    return result
  }

  /** FQN (`mcp__{server}__{tool}`) of every read-only tool across all servers —
   *  the shape the permission-broker sees in `canUseTool(toolName, …)`. */
  readOnlyToolFqns(): ReadonlySet<string> {
    const out = new Set<string>()
    for (const s of this.servers.values()) {
      for (const t of s.readOnlyToolNames ?? []) out.add(this.fqn(s.name, t))
    }
    return out
  }

  /** FQN of every mutating tool — the shape session-pump matches tool_use
   *  block names against for git-status broadcast scheduling. */
  mutatingToolFqns(): ReadonlySet<string> {
    const out = new Set<string>()
    for (const s of this.servers.values()) {
      for (const t of s.mutatingToolNames ?? []) out.add(this.fqn(s.name, t))
    }
    return out
  }

  private fqn(server: string, tool: string): string {
    return `mcp__${server}__${tool}`
  }
}

/** Singleton registry — first-party servers are code-registered at module
 *  load (no user-configurable registration this pass). */
export const firstPartyRegistry = new FirstPartyToolRegistry()
firstPartyRegistry.register(gitAppTools)