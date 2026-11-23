# Agent Note: Ordered transcript reconciliation

Status: implemented

## Problem

The seq sidecar's append-only catch-up assumes every unknown JSONL record belongs at the current head. Some provider records never pass through the live pump, so a restart can discover records that belong in the middle of the persisted projection. Head-appending them moves old assistant text, compact summaries and monitor events behind newer turns and persists the inverted order.

Two sessions confirmed the failure in the server `/messages` data: one with five chronological inversions (an old `No response requested.` and two distinct compact summaries at the tail), another with an old monitor event at the tail. The client was not duplicating these messages — the persisted projection itself was inverted.

The full contract is [Transcript 有序对账与投影重建设计](../../../../docs/superpowers/specs/2026-11-16-transcript-ordered-reconcile-design.md), which owns identity, placement, recovery and wire-protocol details. This note records the architectural choice and its trade-offs.

## Decision

Reconciliation is a server-owned ordered projection with exactly two modes: `append-only` for a proven unchanged ordered prefix with tail-only additions, and `ordered-rebuild` for every middle gap, order mismatch, schema migration or unproven append case. Provider chronology comes from the provider logs, never timestamps or arrival time. A rebuild preserves app-only occurrences, result revisions, aliases, lifecycle metadata and tombstones by stable occurrence identity, and never repairs order by dropping data or adding message-type filters. Whole-message and per-block assistants, UUID-less rows, fork aliases, native compact pairs, result series, synthesized completions and native repairs each keep one logical occurrence at a deterministic legal position; a second reconcile is an empty append with no rewrite or generation bump.

A per-session writer owns append, reconcile, eviction, reset, rebuild and deletion under the single-process deployment model. Live messages, non-public recovery operations and retractions are durable before publication. A rebuild runs only after the provider and dispatch paths quiesce, includes every persisted pending operation in the new projection, and publishes a complete new generation through one fsynced commit record. Every cancel or failure path releases already-committed old-generation frames and retains pending work for retry; retry restores committed recovery batches and never repeats an already-projected operation. Each session's writer serializes its own generation ledger, so one session's reset cannot block another's — there is no state-dir-wide allocation lock or cross-process owner lease.

The sidecar is an append-only generational log (v2) with explicit batch commits; the commit record is the publication marker, with no separate ACK journal or pointer replacement. V1 migration keeps a verified byte-level recovery baseline, never leaves a mixed v1/v2 file, and exposes its recovery/rebuild generations through the one publication point only after the rebuild commits. Missing, corrupt or ambiguous evidence fails closed into an explicit degraded read-only projection that blocks resume and further mutation until retry succeeds, rather than falling back to head-append. App-only results, local commands, prompts, synthetic handoffs and lifecycle metadata survive — including records older than store caps — while empty-result placeholders stay excluded and real completion evidence is never downgraded to an estimated stop. Permanent deletion uses the existing tombstone mechanism and removes the sidecar plus its migration baseline backup; fork, Side Chat, discard and native compact keep their identity boundaries.

Clients negotiate ordered-rebase support. A reset is ordered before new-generation frames on the primary subscription queue, while missed clear/compact history still forces a full reset. Pending input, worktree state and search results are rebuilt from stable identities and durable epochs (search invalidates on durable tombstone changes); plugin invocations are not cancelled and receive a typed reset. Snapshot reconciliation converges through later seq and lifecycle transitions rather than overwriting newer live state or starvation-prone full retries. Ordinary reconnect retains transient API-retry behavior; an ordered rebuild discards state belonging to the terminated request. Reset, reconnect and append races cannot resurrect withdrawn input, overwrite newer lifecycle state or mix generations.

Two incident fixes refine the recovery and identity layers without changing this architecture: [sidecar crash recovery](2026-11-19-sidecar-crash-recovery.md) demotes corrupt commits and recovers the physical tail byte-exact instead of permanently degrading, and [ordered-rebuild wire/disk twin dedup](../bug-fix/2026-11-20-ordered-rebuild-wire-disk-twin-dedup.md) aligns same-uuid wire/disk twins by `uuid+frameKind` at the composition layer.

## Alternatives considered

**Filter recap, `No response requested.` or task-notification rows.** Rejected: these are different records with real content, and type filters do not repair seq, search or discard behavior.

**Sort pages or the client by `receivedAt`.** Rejected: timestamps can tie or jitter, and sorting one page cannot repair the persisted projection or other consumers.

**Delete the sidecar and rebuild only from JSONL.** Rejected: result-frame retention is capped, and synthetic compact boundaries, live completions and not-yet-persisted prompts can exist only in the old sidecar.

**Keep the current append path and add more identity special cases.** Rejected: multi-block coverage is necessary but cannot represent a historical middle gap. The missing abstraction is ordered reconciliation, not another UUID exception.

**Renumber existing rows in place without a generation bump.** Rejected: connected clients and in-flight frames would interpret the new position of an old seq as the old message.

**Use SQLite.** Rejected for this phase: the required invariants are ordered identity, single-writer commits and generation invalidation, not a new storage dependency.

## Consequences

Bought: the incident fixtures render provider records in file order with no duplicated recap, assistant or monitor event, and the projection self-heals on resume instead of persisting an inversion. The ordered projection is the single authority for seq, search and discard, so a middle gap is repaired for every consumer at once rather than per-page.

Cost: a rebuild is O(session transcript size) and holds a full projection, as the store already does; large-session duration and memory are measured before any later streaming optimization. A missing sidecar is intentionally `sidecar-missing`, not an automatic success path — capped results and other app-only records cannot be proven complete from JSONL, so recovery needs an independent backup or manual inspection. V1 app-only placement depends on old canonical anchors, and ambiguous input deliberately fails instead of producing a best-effort order, so some damaged sidecars need manual inspection. Older clients require a reload before an online rebuild — an explicit deployment constraint, not a claim that optional protocol fields make old reducers generation-safe. Ordinary durable writes precede ring/WS confirmation, trading some append latency for a truthful persistence boundary.

Out of scope (spec §12): multi-process owner leases, log GC/compactLog, a separate ACK journal, attachment-lease coupling, plugin anchor re-resolution and a deletion-tombstone-store redesign lack incident evidence or belong to independent subsystems; building them preventively would violate the guard-evidence rule and block the core fix. Rebuilds append, they do not compact, so dead batches accumulate and are re-parsed on every reconcile — sidecar growth is bounded only by a future GC design, with a byte-size gauge and alert in the meantime.

## Testing

`server/transcript-reconcile.test.ts` pins the ordered projection builder and occurrence identity; `server/transcript-incident.test.ts` replays the incident fixtures (file order, no duplication, idempotent second reconcile); `server/transcript-sidecar.test.ts` pins the generational commit/fold, byte-exact tail recovery and corrupt-commit demotion; `server/session-manager.test.ts` pins the reconcile modes, quiesced rebuild, durable-before-publish and the degraded read-only failure. The [spec](../../../../docs/superpowers/specs/2026-11-16-transcript-ordered-reconcile-design.md) owns the full acceptance contract.

## Related

- [Multi-block assistant uuid reconcile](../bug-fix/2026-11-10-multi-block-assistant-uuid-reconcile.md) — this architecture extends the chronology scope that note left unresolved; it does not replace that note's response-coverage rule.
- [Original seq design](../../../../docs/superpowers/specs/2026-10-13-transcript-seq-refactor-design.md) — the base protocol, with generation now also covering ordered projection replacement.
- [Hide resume task-notification noise](../bug-fix/2026-11-06-hide-resume-task-notification-noise.md) — owns monitor/status-only visibility; this architecture changes sequence order only and does not hide payload-bearing monitor events or redesign their card.