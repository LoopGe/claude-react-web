# Agent Note: Start page shows first-party tools through server-issued injection revisions

Status: implemented

## Problem

The empty Start page showed user-configured MCP servers and plugins, but not the
first-party servers grouped with them under Session Settings. Adding those chips
created a freshness problem that configuration signatures could not solve:
first-party servers are re-injected by spawn/resume, per-session toggles, and even
otherwise-identical dynamic MCP updates. Global defaults, meanwhile, do not
immediately change an already-running subprocess.

The `/tools` status payload also embeds static definitions for Settings' expanded
tool lists. Start needs only server-level status, and an error recorded by one
injection attempt must not survive a successful retry or be restored over a newer
handle's state.

## Decision

- Render a display-only **Built-in** row between MCP and Plugins. Include only
  `injected` servers with no recorded error, and load them through
  `GET /sessions/:id/tools?summary=1`, which skips `listToolDefs()` and returns an
  empty `tools` array per server.
- Stamp a UUID `firstPartyRevision` into `SessionInfo` after every spawn-time
  injection, successful live injection, and dormant override. Start and Settings
  refetch only when this token changes. UUIDs avoid cache collisions across server
  restarts; global configuration signatures deliberately play no part.
- Treat live injection as a transaction. `SessionMcpManager` builds servers and
  collects errors locally, waits for SDK acceptance, verifies handle identity,
  then commits revision/errors and broadcasts once. A rejected or stale request
  therefore has no session-visible injection state to roll back. The outer toggle
  rollback restores overrides only while its original handle is still current.
- Fold SDK per-server registration errors into status only for first-party names
  actually injected by that operation, so a same-named user MCP server cannot
  donate its error to a disabled built-in.
- Keep one canonical `FirstPartyToolStatus` in `shared/first-party.ts` for Start,
  Settings, and the server projection.

## Alternatives considered

Signing session/global configuration was rejected: it misses identical MCP
re-injections, produces irrelevant refreshes for overridden globals, and can
describe hypothetical rather than installed state. Listening to `running` was
also rejected because termination/resume cycles can reuse the same prop sequence
and resurrect stale cached results.

## Consequences

`injected` remains the existing effective-configuration projection, not a live
handshake probe. Initial asynchronous handshake failures are still not inferred;
known build/registration failures are filtered. Store-backed dormant sessions use
a dedicated dormant screen rather than ChatEmptyStateEnv, so this feature does not
add a separate store-backed status reader.

The pre-existing `pluginsSig` distinction between inherited (`undefined`) and
explicitly empty (`[]`) plugin sets is outside this change.
