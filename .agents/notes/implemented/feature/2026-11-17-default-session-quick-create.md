# Agent Note: Immediate default-session creation

Status: implemented

## Problem

Setup's **Create New Session** action opened the full `NewSessionDialog` after credentials were already saved, and creating an ordinary session from the sidebar always required another form submission. Users needed a way to start a session in the server's default workspace without re-selecting cwd, model, permissions, MCP servers, or advanced options.

The quick path must not bypass the invariants of the ordinary create flow: current defaults must win over stale client state, the initial MCP selection must survive resume, an asynchronous create must not corrupt the active group view, and mobile creation must leave the result visible.

## Decision

`App.handleCreateDefaultSession` is the single immediate-create entry for Setup and the sidebar's **New Session (Default)** action. It uses `handleCreate` rather than duplicating POST, group, focus, or error behavior. The ordinary dialog and its recent-project prefill remain unchanged. The new menu row is injected only by the sidebar; the header nav strip and desktop titlebar keep their two-row menus.

The quick form selects the Claude provider, default permission mode, current cwd/model defaults, and every globally enabled MCP server. A single `configSource` selects force-refresh, reuse of Setup's refreshed cache, or server-side defaults; it never encodes contradictory boolean combinations. If current defaults cannot be read, cwd/model are omitted so the server applies its current values. Config and MCP config reads start in parallel. An MCP config read failure shows an error and creates nothing; it never becomes an explicit empty MCP selection. A 404 from the optional MCP router means the host has no global selection and creates with an explicit empty list.

`handleCreate` reports whether the created session actually opened in the current view. Creation captures `{ activeGroupId, focusedId }` at invocation and compares that view at completion. Membership belongs to the invocation-time group, while a deliberate group change or session selection made during the request always wins over automatic opening. Removal of the origin session is exempt only when it leaves an empty grid; a replacement selection made after that removal still wins. Group mutation callbacks and name/capacity validation also read their latest refs at completion, and inline `newGroupName` creation counts as joined when the new group is successfully minted. The mobile drawer closes only when creation returned `opened = true` and the viewport is mobile at completion; failures, full groups, and view switches leave it open so the result or error remains visible.

The default cwd remains the existing `defaults.cwd` / `serverDefaultCwd()` policy. This feature does not introduce a Documents fallback, Workspace Registry, automatic worktree isolation, or automatic session creation at application startup.

## Alternatives considered

- **Prefill the ordinary dialog.** Rejected because both requested interactions are immediate creation, not a shorter form flow.
- **Read only the React `defaults` state or `peekConfig()`.** Rejected because Setup refreshes and profile changes can leave those snapshots behind the server.
- **Create with an empty MCP selection when `/mcp-config` fails.** Rejected because it silently disables expected tools and persists that choice across resume.
- **Route the response using only the active group at completion.** Rejected because all ungrouped views share a null group id, so this cannot distinguish an unchanged view from a deliberate session selection. Comparing both invocation and completion view identities also preserves ordinary group-targeted creation from an ungrouped view.
- **Sample the target group after prefetching config.** Rejected because a view switch during the read would silently retarget membership. The target and view context are captured before any async work.
- **Close the mobile drawer at click time.** Rejected because creation can fail or finish outside the current group view, leaving the result hidden.
- **Return a rich create result to every caller.** Rejected in favor of one `opened` boolean: existing callers can ignore it, while the mobile path gets exactly the visibility fact it needs.
- **Add a separate default-session creation implementation.** Rejected because duplicating group and focus rules would drift from `handleCreate`.

## Consequences

Setup and sidebar creation share one implementation and preserve ordinary create behavior. The additional config and MCP reads are required to make defaults explicit and durable. A failed MCP read prevents creation instead of producing a session with silently reduced tools.

Existing `handleCreate` callers can ignore the returned boolean. All create paths now preserve a deliberate view change made while the POST is pending, without breaking an ordinary group-targeted create whose view is unchanged.

The quick path leaves the 1M beta unset in the client intentionally: `SessionManager.spawn` applies `ONE_M_CONTEXT_BETA` when `betas` is undefined, matching the ordinary dialog without duplicating that default.

## Deferred

Duplicate activations remain suppressed by a ref without a progress label or disabled menu row. This can make a slow create appear inactive after the menu closes; a visible busy state was outside the approved minimal interaction.

When every `/config` attempt fails, server-side creation falls back to the active profile's model rather than the CLI `--model` override. Matching the override in that outage path requires a server-owned default-model authority analogous to `serverDefaultCwd`; it was not added in this UI-only change.

## Testing

`src/App.default-session.test.tsx` covers Setup create/skip/failure, refreshed and failed config reads, in-flight profile defaults, MCP selection and failure, duplicate activation, group capacity and view switching, ungrouped-view preservation, and mobile drawer outcomes. Menu tests pin the optional third row and the unchanged two-row surfaces. The same-origin browser check exercises the real menu and immediate create against a mocked create endpoint without invoking a model.
