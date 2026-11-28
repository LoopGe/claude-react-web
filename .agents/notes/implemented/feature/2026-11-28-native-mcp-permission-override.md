# Agent Note: Native per-server MCP permission-mode override

Status: implemented

## Problem

`POST /sessions/:id/mcp/:name/permission-mode` (and the SDK's
`setMcpPermissionModeOverride`) existed end to end except for the native core:
`session-manager-mcp.ts` forwarded to a handle method that native never
declared, so the call always answered **501**. Claude CLI supports it, and its
real semantics are narrow: the override is **tighten-only**. Setting "auto"
must never loosen a default-mode session, and the override is consulted only
when the session itself is already loose.

## Decision

Add `setMcpPermissionModeOverride(serverName, 'default' | 'auto' | null)` to
`NativeSession` and make the per-call mode computation server-aware.

- A private `Map<server, 'default'|'auto'>` holds the pins. Process-scoped and
  never persisted — the SDK does not report the pinned value back, so a resume
  starts clean (same as CLI).
- `effectivePermissionMode(sessionMode, server)` replaces the session mode with
  the pin **only** when a pin exists for that server AND the session mode is
  `bypassPermissions` or `auto`. Anything else keeps the session mode, which
  makes loosen-by-pin impossible by construction.
- `decidePermission` now resolves the owning server *before* the bypass
  shortcut and uses the effective mode in all three places the CLI's `fu()`
  does: the bypass fast path, the `isPersonOnlyAsk` gate for the
  `PermissionRequest` hook, and the `permissionMode` handed to `canUseTool`
  (which is what the broker's classifier / don't-ask paths read).
- `setMcpPermissionModeOverride` rejects anything but `'default' | 'auto' |
  null`, remembers the pin even for a server that is not connected yet, and
  returns `{ warning }` when the name matches neither a configured nor a
  discovered server (typo detection only — never blocks the pin).

No route, adapter, contract or `types.ts` change was needed: all three already
carried the optional method, and `native-host-frame-adapter.ts` already
forwarded it — the 501 came purely from the core not implementing it.

## Alternatives considered

- **Store the pin on the connection registry** — rejected: the pin is a
  permission fact about a session's view of a server, not a property of the
  shared connection (which two sessions can share).
- **Apply the override in the host broker instead of the core** — rejected:
  the bypass fast path lives in the core, so a broker-side override could
  never tighten a bypass session.
- **Copy the CLI's `plan && isBypassPermissionsModeAvailable` branch** —
  deferred: native plan mode already routes its own person-only asks and has
  no `isBypassPermissionsModeAvailable` equivalent, so importing the branch
  would loosen plan calls without a matching safety story.
- **Persist the pin across resume** — rejected, matches the CLI: the SDK has
  no way to read the value back, so a persisted pin would be unverifiable
  state that a UI cannot reconcile.

## Consequences

- The REST route now works for native sessions (no more 501); the client still
  has no UI for it, so this is server-only surface for now.
- A `default` pin on one server makes that server's tools prompt even in a
  bypass session, while every other tool (including other MCP servers) keeps
  bypassing — verified end to end.
- `auto` pins hand the call to the host's classifier path instead of the
  silent bypass.
- Replacing dynamic servers (`setMcpServers`) does not clear pins; they
  re-apply when a server of that name connects again.
- Known deviation: the CLI's `plan`-mode-with-bypass-available branch is not
  modeled (see Alternatives).

## Verification

- `server/providers/native/e2e-mcp.test.ts` — new describe with 5 cases:
  a `default` pin prompting inside bypass while `Bash` still bypasses; an
  `auto` pin reaching `canUseTool` as `auto`; clearing the pin restoring the
  bypass fast path; `auto` never loosening a default session; unknown-name
  warning vs known-name `{}`.
- `npx tsc -p tsconfig.json --noEmit`, `npx eslint` on both touched files.
