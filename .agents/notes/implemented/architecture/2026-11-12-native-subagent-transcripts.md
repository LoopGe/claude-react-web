# Agent Note: Native subagent transcripts

Status: implemented

## Problem

Native nested agents already wrote their sidechain messages into the main session log, but there was no durable catalog identity or standalone transcript view. A descriptor-less old session therefore had no recoverable agent list, while a root-only transcript UI could not render native sidechain messages without changing their parentage. Live watchers also had to choose the correct provider without resuming dormant sessions or falling through to Claude's filesystem layout.

The execution model needed to stay deliberately small: one native JSONL log, synchronous final reports, depth one, and mid-flight detach. Adding independent child sessions or per-agent transcript files would create a second lifecycle and another source of truth without improving those guarantees.

## Decision

A strict, history-only `subagent/descriptor` event is appended durably before the first nested model request. It records the native toolUseId, parent, actual Agent/Task tool name, label, depth, and a detached execution-profile snapshot in the same `session.v1.jsonl` as the conversation. The cached catalog folds descriptors and evidence-backed legacy sidechains from that single log. Failed validation, permission denial, pre-abort, and descriptor writes do not start a nested request or create a catalog entry; legacy inference requires real sidechain evidence so an outer error cannot resurrect a failed call as an execution record.

Standalone reads select only the target agent's direct conversation. The reader reprojects assistant and real user frames to root parentage, derives tool-result parentage from the result's own tool_use_id, and synthesizes a stable prompt from the originating tool call instead of writing another durable prompt frame. Disk reads, initial WS resets, and live increments share this projection. Descriptor-only runs can therefore show a prompt without output, unknown agents remain an ordinary empty transcript, and final reports are not duplicated.

Provider-level readers make list/read available for live, dormant, resumed, and forked sessions. `ProviderSubagentTranscriptHub` chooses Claude's existing file hub or the native source through the manager's provider and capability resolver. `NativeSubagentTranscriptSource` uses the manager's fan-out rather than consuming the single-consumer native message stream. Each subscription registers live delivery before reading its snapshot, buffers independently, applies UUID deduplication, and serves dormant sessions from disk without resuming them.

Agent and Task share one nested runner, and nested requests remove both delegation tools. Explore remains an Agent profile rather than a new tool. After the ordinary depth, allowlist, denylist, and MCP ownership filters, Explore accepts only tools whose `readOnlyHint` is exactly true. This intentionally exceeds Claude Explore's denylist boundary: Bash, write tools, undeclared MCP tools, and explicitly writable MCP tools stay unavailable even under bypass permissions.

## Lifecycle and failure handling

Each native subscription owns its buffers and terminal state. Snapshot failures, catalog-read failures, and unexpected termination of the manager's inner subscription all call the same idempotent `failChannel`, which detaches live delivery, clears buffered input, rejects the output iterable, and removes the subscription. An already-produced initial reset is preserved before that error; later queued increments drop, and a pre-snapshot failure does not invent a reset. Ordinary unsubscribe and source close are clean EOF, with late inner termination suppressed after cleanup.

The production capability is enabled only after the descriptor, catalog, reader, source, manager, route, role, and real end-to-end paths are exercised. E2E coverage uses the real SessionManager, ProviderRegistry, NativeProvider, PermissionBroker, native log, REST router, provider-neutral source, and SessionConnection with scripted model streams.

## Alternatives considered

- **DSH-style independent child sessions and catalog state.** This loses because it introduces a separate residency and lifecycle model for a feature that only needs recoverable identity and display. The single native log already provides fork cuts, ordering, and durable sidechain parentage.
- **Claude-style per-agent JSONL files.** This loses because a second transcript writer could diverge from the native session log and complicate fork and compact behavior. Standalone projection supplies the same UI contract without duplicating conversation facts.
- **A durable nested prompt event.** This loses because it changes model and mirror history for presentational data already present in the originating tool call. The stable synthetic prompt stays in the standalone read layer.
- **Claude Explore's denylist.** This loses because Bash and general MCP tools still leave write-capable paths. Native Explore fails closed on explicit read-only metadata instead of treating a permission-mode bypass as authority to widen the tool surface.

## Consequences

The catalog and transcript pay repeated log-projection costs in exchange for one durable source of truth and deterministic resume/fork behavior; the existing cache bounds full reparses. Native's API agentId is its toolUseId, but provider-neutral consumers treat it as opaque and must not apply that identity rule to Claude.

Explore deliberately has a smaller tool surface than Claude Explore. This can reject an MCP tool that is safe in practice but lacks accurate read-only metadata; correct annotations are part of the integration contract.

The Stage A [native agent profile presets](2026-11-11-native-agent-profile-presets.md) decision remains the source for profile parsing and main-preset recovery. This note supersedes only its earlier statement that descriptors, standalone transcripts, and Task/Explore roles were still unimplemented.

## Deferred

Stage C `session/skill` recovery is not implemented. Forked Skills, plugin skills, continuable child sessions, launch-time background, automatic completion wake-up, configurable multi-level delegation, periodic progress summaries, and independent DSH-style child residency also remain outside this change.
