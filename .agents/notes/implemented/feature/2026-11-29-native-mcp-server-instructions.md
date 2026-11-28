# Agent Note: MCP server instructions in the native system prompt

Status: implemented

## Problem

An MCP server may return advisory `instructions` in its handshake — guidance for
using its tools and resources ("call search before answering", "ids are opaque").
Claude CLI surfaces this to the model in a dedicated system-prompt section and
announces changes when servers connect or disconnect. Native read neither the
field nor the section, so the model lost the server's own usage guidance and
had to infer it from tool schemas.

## Decision

- Capture `client.getInstructions()` on every successful connect, per local
  record and per shared stdio record (shared views re-project under their
  session-local server name). Blank strings are treated as absent. Toggling a
  server off clears the local copy; the shared copy clears on reconnect.
- Expose `connections.instructions()` — connected servers only, name-sorted,
  same visibility rule as tool / prompt discovery (a failed or disabled server
  contributes nothing).
- Session renders the CLI's exact section once per turn, appended after the
  skills section:
  ```
  # MCP Server Instructions
  The following MCP servers have provided instructions for how to use their tools and resources:
  ## <server>
  <instructions>
  ```
  Empty when nothing supplied instructions, so a tools-only setup keeps its
  prompt byte-identical. Because it is read from the live connections at
  request time, a `setMcpServers` replace or reconnect lands on the next round;
  the turn already awaits MCP readiness before building the prompt.
- The section rides BOTH prompt variants — the main turn and
  `subagentSystem` — because nested agents receive the same MCP tool set and
  need the server's usage guidance too.
- The section is prompt text, not an attachment: no host UI surface, no
  transcript row.

## Alternatives considered

- **Bake instructions into the spawn-time section registry** (like tool
  guidance): rejected — connections settle after the session is built, and the
  registry is deliberately a spawn-time snapshot. A per-turn section is the
  same shape skills already use.
- **Emit the CLI's `mcp_instructions_delta` notice on connect/disconnect**
  (including "their instructions above no longer apply"): requires a
  notification pipeline plus attachment injection native does not have; the
  per-turn rebuild already retracts stale instructions on the next prompt, and
  the model never sees a server's text after it disappears.
- **Truncate or summarize instructions**: kept verbatim — the server owns the
  text and the CLI passes it whole.

## Consequences

- A server's usage guidance reaches the model with the CLI's heading, so prompts
  written against Claude's own instructions behave the same here.
- Instructions cost prompt tokens on every turn while the server is connected,
  and are priced as their own `/context` row (`MCP server instructions`), so
  the breakdown still sums to the bar's total.
- A server that disconnects mid-conversation silently drops out of the section
  next turn (no explicit retraction sentence — documented deviation).

## Verification

- `server/providers/native/mcp/connections.test.ts`: `instructions()` returns
  the handshake text of a connected server and nothing for a server without it.
- `server/providers/native/e2e-mcp.test.ts`: through `SessionManager`, the
  first request's captured `system` contains the heading, `## p`, and the
  server's text, and `contextUsage()` carries the `MCP server instructions`
  category.
- `npx vitest run` on those files; both `tsc` configs; `eslint` on the changed
  files.
