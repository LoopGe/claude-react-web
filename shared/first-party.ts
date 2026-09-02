// First-party tool server listing — the wire shape for exposing the
// registry's static tool metadata to clients. First-party servers are
// in-process (createSdkMcpServer), so unlike normal MCP servers there is no
// live connection to probe with listTools(); definitions come straight from
// the code-registered registry instead.

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
