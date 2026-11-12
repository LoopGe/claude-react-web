# Agent Note: Permanent clear command

Status: implemented

## Problem

`/clear` starts an empty replacement session but deliberately preserves the old provider transcript for resume. Ordinary session deletion also preserves that transcript, and Claude Code's retention sweep does not provide immediate deletion. A command was needed to start fresh while making the old conversation unrecoverable without first opening a deletion menu.

## Decision

`/clear-permanent` runs immediately without a confirmation dialog. It uses the existing `POST /sessions/:id/clear` endpoint with `{ deleteTranscript: true }`; ordinary `/clear`, `/reset`, `/new`, and `/handoff` keep their existing behavior.

The server creates replacement Y before deleting source X, preserving the existing clear guarantee that a spawn failure leaves X runnable. The permanent branch shares the locked deletion body used by `DELETE /sessions/:id?deleteTranscript=true`, including process-exit waits, provider-specific transcript deletion, cache invalidation, app-sidecar cleanup, tombstones, and strict error reporting. It does not remove X's worktree because Y inherits it. Public deletion also skips worktree cleanup whenever another persisted session still resolves to the same directory, so a deletion retry after a partial clear cannot remove Y's workspace.

If Y exists but X deletion fails, the command returns an error and does not emit the final `removed(X)`. The server re-announces Y's latest metadata with the existing `replacesSource` relationship, placing Y in X's group and sidebar position while retaining X for cleanup. The initiating panel stays on X and reports that Y was created but permanent deletion failed. Retrying either `/clear-permanent` or **Delete permanently** reuses Y rather than creating another replacement. A dormant replacement returns 409 instead of spawning a duplicate; resume Y or delete X directly. The replacement association is process-local, so direct permanent deletion is the recovery path after a server restart. Reconnect snapshots convert stale evicting replacements into explicit replace relationships, preserving Y's group slot whether source deletion later succeeds or remains incomplete.

The permanent-clear HTTP request has no client-side timeout because process-exit waits and filesystem deletion can legitimately exceed the default 30 seconds.

A permanent clear requested while another clear is already in flight returns 409 rather than borrowing the ordinary operation's successful response.

Deletion covers the provider transcript, companion and subagent transcripts, and app-owned session sidecars. It does not securely erase storage or remove shared uploads, input history, browser drafts, external backups, or unrelated project data.

## Alternatives considered

- **Changing `/clear` to always delete:** rejected because resumability is its established behavior.
- **Using `claude purge`:** rejected because it deletes project-level state rather than one session and does not create a replacement panel.
- **Clearing first and deleting from the client or route:** rejected because ordinary clear releases the session lock, removes provider metadata, and broadcasts `removed(X)` before permanent deletion can succeed.
- **Deleting first and clearing afterward:** rejected because deletion closes the source session, leaving no reliable way to inherit its settings into a replacement.
- **Calling the complete public delete operation from clear:** rejected because its default worktree cleanup would delete the replacement's workspace. The shared locked body takes an explicit worktree policy instead.
- **Calling SDK `deleteSession()` directly:** rejected because the application also needs provider dispatch, process-exit gating, app-sidecar cleanup, cache invalidation, and its existing missing-artifact and retry semantics.
- **Adding a new failure frame and client reconciliation protocol:** rejected because `replacesSource` already exposes the replacement while retaining the source for cleanup.

## Consequences

The command trades confirmation friction for a deliberately explicit destructive name. Success is immediate and unrecoverable. Multi-file deletion remains non-atomic: a late sidecar failure can leave deletion partially complete, so the error must remain visible and retryable rather than being presented as either full success or no-op.

Native sessions use the same provider dispatch as permanent deletion; no native-specific clear branch is required. Existing native deletion and ordinary-clear tests cover those shared contracts.

## Testing

Focused tests cover command matching and options, route opt-in parsing, Claude transcript removal, inability to resume, failure broadcasts, deletion retry without another spawn, and shared-worktree preservation. Existing tests cover ordinary clear resumability, spawn failure, late sidecar failure, native deletion, and last-consumer worktree cleanup.
