// First-party tool server listing — the wire shape for exposing the
// registry's static tool metadata to clients. First-party servers are
// in-process (createSdkMcpServer), so unlike normal MCP servers there is no
// live connection to probe with listTools(); definitions come straight from
// the code-registered registry instead.

/** Server name of the first-party git tool server — tools surface as
 *  `mcp__git-tools__{name}`. Config/session maps keyed by the pre-rename
 *  `apptools` name are migrated to this on load. */
export const GIT_TOOLS_SERVER_NAME = 'git-tools'

/** Pre-rename server name kept only for config/session migration. */
export const LEGACY_GIT_TOOLS_SERVER_NAME = 'apptools'

/** Rename a legacy `apptools` key to `git-tools` in a first-party-tools map.
 *  When both keys are present the new key wins — including an explicit
 *  `null` (the live-session inherit/clear marker), which must not be treated
 *  as absent. Returns the input unchanged when there is no legacy entry. */
export function migrateLegacyGitToolsKey<T>(
  map: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!map || !(LEGACY_GIT_TOOLS_SERVER_NAME in map)) return map
  const rest: Record<string, T> = {}
  for (const [k, v] of Object.entries(map)) {
    if (k !== LEGACY_GIT_TOOLS_SERVER_NAME) rest[k] = v
  }
  return {
    ...rest,
    [GIT_TOOLS_SERVER_NAME]: GIT_TOOLS_SERVER_NAME in map
      ? map[GIT_TOOLS_SERVER_NAME]!
      : map[LEGACY_GIT_TOOLS_SERVER_NAME]!,
  }
}

/** Static metadata for one first-party tool (cwd-independent — handlers are
 *  bound per session at spawn; only name/description are listed here). */
export interface FirstPartyToolDef {
  name: string
  description: string
  /** True when the tool only reads workspace state (registry readOnlyToolNames
   *  set — the same source the permission-broker read-only exemption uses). */
  readOnly: boolean
}

/** One registered first-party tool server with its static tool listing.
 *  Served by `GET /api/first-party-tools` and embedded per server in the
 *  `GET /api/sessions/:id/tools` status entries. */
export interface FirstPartyToolServerInfo {
  name: string
  description: string
  tools: FirstPartyToolDef[]
  /** Present when listing this server's tools failed (buildTools threw);
   *  `tools` is empty in that case. */
  error?: string
}
