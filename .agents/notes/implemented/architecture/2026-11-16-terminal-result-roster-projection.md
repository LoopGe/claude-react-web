# Agent Note: Terminal results leave the WS roster

Status: implemented

## Problem

Raising `WsWriteQueue.MAX_QUEUE_CHARS` from 8M to 16M only delayed the task-snapshot reconnect loop. A second live incident reached exactly 18,241,480 characters: 51 task records contained 15,178,970 result characters, and an independent WS subscription closed with `1011 write queue overflow` when the roster was enqueued. The failing session was not the slept session reported next in the logs.

## Decision

Keep canonical full result strings in the live task map and existing `TaskResultStore`; do not migrate the sidecar. Project both initial and live `tasks-snapshot` emissions through one bounded function in `shared/tasks.ts`. Small results stay inline. Large results omit `result` and expose `resultRef` metadata (`totalChars`, `hasResult`, `isError`, `projection`, `resultVersion`), with per-result and whole-snapshot budgets. `task.updatedAt` and `task.runId` remain the single owners of those identity fields. Omitting the body is deliberate: an older client must never treat a truncated tail as canonical output. Extreme aggregate metadata uses bounded `tasks-snapshot-chunk` JSON fragments rather than discarding resource links, task identity, or live task state.

Read terminal results through `GET /sessions/:id/tasks/:taskId/result?runId=&offset=&limit=`. Pages use UTF-16 code-unit offsets, not raw-byte offsets, carry `nextOffset` and surrogate-aligned `previousOffset`, and require `limit >= 2` so the HTTP contract never splits a code point. Live state is authoritative and has no stale-disk fallback; dormant/slept/terminated sessions read the sidecar without resume. Non-terminal reads are also allowed when a running task already owns a canonical tool_result, preserving the existing resource-preview behavior. Run and requested-generation mismatches fail explicitly.

The client uses `resultRef` for lifecycle evidence but never treats a partial preview as a richer canonical result. Expanded rows and visible resources fetch one page at a time through `useTaskResult`; they do not rebuild the full body in renderer state. `ResourceTaskBody` shares one preview with transcript suppression, and canonical `ActiveSubagent.result` retains precedence.

`MAX_QUEUE_CHARS` is now 64M in both the WebSocket sink and desktop IPC sink as a last-resort transport guard. It is not the roster size control.

## Alternatives considered

**Raise the cap again without projection.** Rejected: the 16M incident already reproduced the same failure at 18.24M.

**Truncate or migrate canonical sidecar strings.** Rejected as unnecessary for the WS fault and harmful to complete result reads, fork/resume, and dormant access.

**Put partial previews into `activeSubagents` as notification results.** Rejected: truncated text cannot participate in full-result precedence or supplemental-block dedup. Partial output is lifecycle evidence and a view-local summary only.

**Wait for the complete streaming architecture.** Rejected for this independent fault: existing terminal results already have all data needed to break the reconnect loop. OutputRing, live output, workflow events and storage migration remain deferred.

**Change app-plugin/history streams in the same phase.** Rejected as scope: `sessions.event` carries original SDK messages, not `tasks-snapshot`; their versioning is separate.

## Testing

Shared tests pin small/full and large/partial projection, the aggregate snapshot budget, surrogate-safe pagination and an input larger than 16M. Frame-bridge tests cover initial and live projection without mutating canonical records. Manager/route tests cover live authority, dormant reads without resume, run/lifecycle errors and bounded continuation. Client tests cover partial lifecycle metadata, canonical precedence, lazy paging and stale-generation rejection. WS tests cover the observed 18,241,480-character frame and overflow at 64,000,001 characters.

## Consequences

The existing 18.24M roster becomes a bounded frame while complete results remain readable page by page. Dormant reads still parse the existing whole-session sidecar; this phase bounds transport and renderer state, not sidecar I/O or provider-owned transcript artifacts. Non-roster SDK/plugin streams and live output are unchanged.

## Related

This is the terminal-only first phase of [task output streaming architecture](../../proposed/architecture/2026-11-14-task-output-streaming.md). The complete live-output proposal and its upstream probes remain in force.
