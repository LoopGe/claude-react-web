# Agent Note: Model-facing MCP resource tools in the native provider

Status: implemented

## Problem

The native provider exposed MCP servers' TOOLS but none of their RESOURCES, and
had no way to re-read a live server's tool list. The CLI ships
`ListMcpResources`, `ReadMcpResource`, `ReadMcpResourceDir` and
`RefreshMcpTools`; a native session could neither enumerate nor read a
resource, and a server whose tool list changed after connect stayed stale until
the session was recreated.

## Decision

Add the three resource tools that the MCP SDK client can actually support, and
fix the connection layer they immediately exposed.

- `NativeMcpConnections` gains `serverNames()`, `capabilities(name)`,
  `listResources(name, signal)` and `refreshTools(name | undefined, signal)`;
  `readResource` accepts an optional signal. Local records paginate
  `resources/list` themselves; shared stdio records gained the same
  `serverCapabilities()` / `listResources()` / `refreshTools()` surface, so a
  shared child behaves identically to a local one.
- `tools/mcp-resources.ts` holds the three `ToolDef`s (promptOrder 206–208,
  `readOnlyHint: true`): `ListMcpResources` (optional `server` filter),
  `ReadMcpResource` (`server` + `uri`, text inline, blob saved under
  `<tmp>/crw-mcp-resources/` and its path returned) and `RefreshMcpTools`
  (optional `server`, reports per-server `status` / `toolCount` / `added` /
  `removed`).
- Capability gate: a server that does not declare `resources` is skipped by
  `ListMcpResources` instead of being asked, and `ReadMcpResource` maps the
  SDK's `-32601` (method not found) and `-32002` (resource not found) onto the
  CLI's own sentences.
- `ui://` resources are filtered out of the model-facing list (the CLI does the
  same — those are MCP Apps documents the host reads, not the model).

**A real bug the resource work exposed:** the connection layer ran
`tools/list` unconditionally, so a server that legitimately declares only
`resources` answered `-32601 Method not found` and the WHOLE connection failed
(`status: 'failed'`, zero tools). Discovery now follows the declared `tools`
capability on both the local and shared paths, and `refreshTools` treats a
tool-less server as a zero-tool refresh instead of an error.

## Alternatives considered

- **Implement `ReadMcpResourceDir`** — rejected: `resources/directory/read` is
  a non-standard extension the MCP SDK client here does not expose, and the CLI
  gates the tool behind its own build flag. Registering a tool that always
  errors "not enabled" would be worse than not shipping it.
- **Cache resource listings per server** — deferred: the CLI keeps a list cache
  so a read can verify its URI; here a read goes straight to the server and a
  stale URI surfaces as the CLI's `-32002` sentence telling the model to re-list.
  A cache adds invalidation surface for no user-visible gain at this size.
- **Claim the CLI's "available immediately" refresh ack** — rejected as a false
  claim: this provider snapshots its tool list once per turn (`runTurn`'s
  `deps.tools` and its `toolByName`), so a tool that appears mid-turn cannot be
  called in that same turn. The ack says "from your NEXT turn" instead.
- **Store blobs in the workspace** — rejected: a resource read must not write
  into the user's repo; a per-process temp directory is the honest analogue of
  the CLI's attachment store.

## Consequences

- Every native session now advertises three read-only MCP resource tools, even
  with no MCP servers configured (they answer "No resources found..." and an
  empty refresh). This matches the CLI's always-registered set and is pinned in
  `native-session.test.ts`'s five tool-list expectations.
- `RefreshMcpTools` rebuilds the session tool list through
  `onToolsRefreshed()`; the rebuilt list lands in the NEXT turn's request, and
  the ack states that plainly.
- A resource-only MCP server now connects successfully; previously it failed
  outright. `RefreshMcpTools` on it reports `toolCount: 0` with the refreshed
  status rather than an error.
- Binary blobs accumulate in `<tmp>/crw-mcp-resources/` unbounded for the
  process lifetime (no janitor). They are temp files, not session state.

## Verification

- `tools/mcp-resources.test.ts` (7 cases): schema/order pins, capability gating,
  `ui://` filtering, the no-resources sentence, unknown-server message,
  broken-server isolation, text + blob read (file content checked on disk),
  `-32601` / `-32002` sentence mapping, refresh diff + NEXT-turn ack.
- `e2e-mcp.test.ts`: a real in-process resource server listed and read through
  `SessionManager`; a connected SDK server refreshed over the live connection.
  Full file 12/12.
- `native-session.test.ts` 289/289, `mcp/connections.test.ts`,
  `mcp/shared-record.test.ts`, `mcp/tools.test.ts` green; full native suite
  2594 tests with only the known environment flake class outside this change.
- `tsc` both configs, `eslint` on every touched file, `verify:agent-notes`.
