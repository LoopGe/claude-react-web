# Agent Note: MCP prompts as native slash commands

Status: implemented

## Problem

The native provider listed MCP tools and resources but dropped the third
discovery surface: server prompts. Claude CLI exposes every discovered prompt as
a slash command (`/mcp__<server>__<prompt> <args…>`), whose body is the
`prompts/get` result rendered into prompt blocks. In native a user typing such a
command hit "unknown command", and the `/` catalog never showed the prompt at all
— so a server whose only capability is prompts was invisible.

## Decision

- **Discovery** (`mcp/connections.ts`, `mcp/shared-record.ts`): each connect
  pass fetches `prompts/list` (all pages) **only when the server declares the
  `prompts` capability** — the same fail-closed gate tools already use, because
  an undeclared `-32601` used to fail the entire connection. Rows are stored per
  connection and exposed by `promptCommands()` (shared records are re-projected
  under the session-local server name, like their tools), plus `getPrompt()`
  routed through the same queue / signal rules as tool calls.
- **Row shape** (`commands.ts`): `mcpPromptCommandRows()` composes
  `mcp__<server>__<prompt>`, keeps the server's declared argument order as the
  `argumentHint` and stores the spec on the row (`mcpPrompt`). Servers whose name
  is not `[A-Za-z0-9_-]+` or contains the `__` delimiter are skipped — the CLI's
  own rule is to refuse them and tell the user to rename the server, not to
  escape the name. Rows whose composed name falls outside the canonical slash
  grammar are dropped too.
- **Invocation**: `commandInvocationForTurn` became async and takes a resolver;
  an MCP row is resolved at turn time by `renderMcpPromptCommand` — positional
  words map onto the declared names, `required` is enforced with the CLI's exact
  sentence (`Missing required argument(s): …. Usage: /mcp__… args`), then
  `prompts/get` runs. A `/mcp__…` turn waits for `whenReady()` before the catalog
  is frozen (ordinary turns never do); the row list is rebuilt from the live
  connections each turn, so a reconnect / replace is reflected without a cache.
- **Rendering** (`mcp/prompt-render.ts`): each returned message's content blocks
  become prompt text — `text` verbatim; `resource` inlined when it carries
  `text`, otherwise noted; `resource_link` as a bracketed link line; `image` /
  `audio` and blob resources as a "not inlined" note. An empty or shapeless
  result throws instead of letting the bare literal reach the model.
- Catalog order: builtins → custom → plugin → MCP prompts → skills, same
  case-folded dedupe as every other row.

## Alternatives considered

- **Reuse the CLI's `userFacingName` / aliases** (`server:prompt (MCP)` for stdio,
  the bare prompt name for http/sse): the native catalog is one flat namespace
  keyed by the command name; aliases would need a second lookup table and would
  collide with custom commands. Kept the canonical `mcp__…` name only.
- **Cache prompt rows on the session**: rejected — the connections already own
  discovery; a second copy would drift on `setMcpServers` / reconnect.
- **Save image / blob prompt content to the attachment store** (CLI behaviour):
  rejected for now — prompt binaries would grow the CAS from a surface the user
  did not upload. They render as a note instead; documented deviation.
- **`prompts/list_changed` refresh**: native has no server-notification plumbing;
  prompts refresh on reconnect / `setMcpServers`, not on the notification.
  Documented deviation.

## Consequences

- A prompts-only server is usable and appears in the `/` catalog with its
  description and argument hint.
- A required argument missing fails that turn loudly with the CLI sentence; an
  unknown prompt name stays unresolved and falls through as plain text, exactly
  like any other unknown command.
- Because native keeps the raw typed turn for every slash command, the model
  sees `/mcp__… args` plus the rendered prompt body (same as custom commands and
  skills).
- Binary prompt content is never inlined; the model is told what it was missing.

## Verification

- `server/providers/native/commands.test.ts`: row composition, invalid-server
  skip, positional mapping, missing-argument sentence.
- `server/providers/native/mcp/prompt-render.test.ts`: text / resource /
  resource_link / binary note / empty-result refusal.
- `server/providers/native/mcp/connections.test.ts`: capability gate (a
  tools-only server contributes no prompt rows), `getPrompt` round trip.
- `server/providers/native/e2e-mcp.test.ts`: through `SessionManager`, a real
  in-process prompt server appears in `supportedCommands` and `/mcp__p__greet
  Ada` injects `Hello Ada…` into the first request.
- `npx vitest run` on those files; both `tsc` configs; `eslint` on the changed
  files.
