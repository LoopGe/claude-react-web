# Agent Note: Ordered rebuild aligns wire/disk twins by uuid+frameKind

Status: implemented

## Problem

Resuming session `2d6a7e71` after a server kill froze its transcript: the client
store held 662 messages with 83 duplicated uuids (React duplicate keys broke
Virtuoso). The corruption was server-side — the committed seq projection itself
held one uuid at two seqs, a disk-normalized copy (`source: provider`, final
`stop_reason`/usage) beside a live wire copy (`source: app`, `stop_reason: null`,
streaming usage).

`reconcileOrdered` disambiguates every uuid-bearing occurrence with a semantic
content hash (`occCtx` → `occurrenceIdOf(..., {appOperationId})`, added by
`e81b9978` "I7 order-insensitive content-stable occurrence identity").
`semanticMessageProjection` deliberately keeps `stop_reason`/usage (spec §5.3),
and a live wire assistant frame ALWAYS differs from the CLI's persisted final
frame in exactly those fields. The twins therefore hash differently, the old
wire copy classifies as app-only, and `buildOrderedProjection` inserts it beside
its canonical twin. No uuid-level alignment existed; `validateProjection` checks
only occurrenceId uniqueness.

Before I7 the same divergence threw `identity-conflict` (rebuild failed,
degraded) — I7 traded that loud failure for silent duplication. The defect became
reachable on resume only after the sidecar crash-recovery chain
(`37887a9a`…`0a324bc6`): demote corrupt commit → v1 fallback → forced
ordered-rebuild over live wire history. The append-only path was never affected
(`backfillFromEntries` dedups by uuid).

A second, independent collision survived the twin fix on the real data: one
user prompt and one compact summary shared a uuid. A historical FIFO-pairing
ledger entry (the pre-exact-uuid `onPromptEcho` bug that "paired synthetic CLI
frames onto unrelated sends") mapped the prompt's `u` onto the SUMMARY's disk
uuid `v`; `rewriteSeedPromptUuids` then rewrote the summary onto `u` because it
only filtered type/parent, not synthetic markers. Different frameKind
(`user` vs `user:compact_summary`) is spec-legal multi-occurrence, so the
aligner correctly kept both — the collision had to be prevented at the rewrite.

## Decision

`alignOldByUuid` (server/transcript-reconcile.ts, pure) runs in the composition
layer between building `old`/`canonical` and `buildOrderedProjection`. For each
old entry classified `app` whose `uuid+frameKind` matches EXACTLY ONE canonical
entry — the spec §5.2 base identity — the old entry adopts the canonical
occurrenceId/msg/source, so the builder sees one occurrence, not two:

- canonical (disk final) content wins; lifecycle metadata
  (`consumedAt/injectedAt/requeuedAt/steeredAt`) merges from the old wire copies
  where canonical lacks it (§5.3 lifecycle merge; all four are provenance, so
  the merge never trips identity-conflict). Among multiple wire twins the
  newest stamp wins (max), so an older copy cannot block a newer one;
- eviction OR-merges onto the canonical copy from EVERY old copy that names the
  occurrence — including hash-matched provider copies — and the aligned entry
  reports the merged flag: the builder's `oldByOcc` is last-wins, so an entry
  reporting only its own flag could shadow an evicted twin and resurrect a
  retracted message (§5.4);
- zero or multiple canonical candidates leave the old entry untouched — multiple
  same-key canonical entries are §5.2's legitimate multi-occurrence case, and
  guessing a merge there would drop data.

The hash disambiguator stays: it still separates genuinely distinct occurrences
that share uuid+frameKind. The fix restores the base-identity alignment the
hash-only scheme lost, at the layer the spec assigns identity to (§7.1 step 4,
§15 module boundaries).

`rewriteSeedPromptUuids` (server/prompt-uuid-store.ts) gates candidates on
`isHumanUserMessage` (shared/user-frames.ts — the full synthetic ladder:
tool_result carriers, task-notification injections, isSynthetic, compact
summaries, and the NON-isMeta local-command log markup) plus the disk-only
`isMeta` marker the ladder does not read. A synthetic CLI frame is never a
host-prompt echo, so no ledger mapping — including a stale mispaired one — may
rewrite its uuid. The pairing source itself is already exact-uuid
(`onPromptEcho`); this guard contains the historical mispaired data that
persists in ledgers.

## Why the existing tests missed it

Every rebuild fixture seeded IDENTICAL content on the sidecar and JSONL sides
(`transcript-incident.test.ts` passes the same objects to both;
`session-manager.test.ts`'s `emitAssistant`/`jsonlAssistant` emit the same shape
with no usage/stop_reason at all). Identical content → identical hash → the
twins always matched, so the divergence dimension was never exercised. The pure
builder tests hand-write occurrenceIds without disambiguators, testing the
builder's contract but never the composition layer's hash identity where the
defect lives. The only stop_reason-varying test asserted the OPPOSITE branch
(same occurrenceId + different content → identity-conflict). And the append-only
path's uuid dedup masked the divergence in every non-inverted fixture: the bug
needed the cross product "rebuild-triggering inversion × wire/disk finalization
delta", which no fixture combined. I7 itself shipped with order-insensitivity
tests (sorted keys), none for the twin divergence its disambiguator creates.

Lesson: any test exercising occurrence identity must model the production
wire/disk finalization delta — fixtures that reuse one message object on both
sides are testing a world that does not exist.

## Alternatives considered

- Exclude usage/stop_reason from `semanticMessageProjection`: violates §5.3
  (they are semantic, and result turn-terminal placement reads stop_reason) and
  weakens identity-conflict detection for genuine content changes.
- uuid-level dedup inside `buildOrderedProjection`: wrong layer — the spec
  assigns identity decisions to the composition layer; the builder is a pure
  contract over already-identified entries, and a blanket uuid dedup there would
  also swallow §5.2's legitimate multi-occurrence cases.
- Revert I7's disambiguator: restores the pre-I7 failure mode — every wire/disk
  twin throws identity-conflict and the rebuild degrades.
- Delete/move the corrupt sidecar by hand: destructive to recovery state and
  leaves the code defect; the fix self-heals instead.

## Consequences

A corrupt projection self-heals on the next resume: hydrated duplicate uuids
make `isOrderedSubsequence` fail → clean rebuild → `transcript-rebased` →
clients REBASE. The second reconcile is an append-only empty increment (§7.4
idempotence, tested). Unaligned app-only frames (wire-only system frames) keep
their anchor-based placement.

Observed but out of scope: after corrupt-batch demotion the v1 fallback resets
the store generation to 0, so the recovery rebuild allocated generation 1 while
the sidecar history held generation 2, reusing the dead batchId
`rebuild-<id>-1`. A load BEFORE the fresh re-commit demotes that batch (its
historical rows no longer match the old commit's count); AFTER the re-commit,
a fresh manager reloads the projection and reconciles append-only (verified on
the real corrupt sidecar copy). Whether generation should be allocated from the
ledger max instead of the hydrated store's reset generation is a separate
crash-recovery question
([sidecar crash recovery](../architecture/2026-11-19-sidecar-crash-recovery.md)).

Known limitations left as follow-ups (review findings, deliberately not widened
into this incident fix): the append-only path keeps the wire pre-finalization
content for uuid-known frames (pre-existing `backfillFromEntries` uuid-dedup
behavior — it never duplicated, it just never refreshes usage/stop_reason from
disk); `validateProjection` does not reject a canonical-side same uuid+frameKind
collision, because uuid sharing across frameKind is spec-legal (§5.2) and the
known collision source (stale synthetic rewrites) is closed by the guard above;
legacy v1 sidecar summaries persisted BEFORE the pump's `isCompactSummary`
stamping lack the marker, so their frameKind (`user`) differs from the disk
twin's (`user:compact_summary`) and alignment stands down — no such twin
surfaced in the incident data, and widening identity heuristically for an
unobserved population would violate the no-speculative-guards rule; and a
genuine human prompt whose leading text matches the local-command log markup
classifies non-human app-wide (`isHumanUserMessage`), so the bridge skips it and
the client's signature fallback handles overlap — consistent with the single
human-classification authority, not a bridge-specific regression.

`LIFECYCLE_KEYS` is exported from transcript-projection.ts and PROVENANCE_KEYS
is derived from it, so the merge set cannot drift out of the semantic
exclusion set (a drift would re-classify merged rows app-only on every
reconcile).

## Testing

`server/transcript-reconcile.test.ts` (alignOldByUuid describe): twin dedup with
production-shaped hashed identities, lifecycle merge + canonical-wins +
newest-twin-wins, evicted OR-merge including the asymmetric hash-matched-disk /
visible-wire orders (last-wins oldByOcc shadowing), corrupt-store double-copy
fold, ambiguity/uuid-less/frameKind-mismatch conservatism, §7.4 idempotence.
`server/transcript-incident.test.ts`: v1 wire sidecar [A,N,B,S] vs disk JSONL
[A,B,N] with finalization divergence — red before the fix (uuids
[A,B,N,A,N,B,S]), green after ([A,B,S,N], disk content wins); idempotence leg
boots a FRESH SessionManager over the same dir (the same holder short-circuits
on `reconciled`, so a second read on one manager proves nothing).
`server/prompt-uuid-store.test.ts`: compact summary, isMeta, NON-isMeta
local-command stdout, and task-notification frames keep their uuids under stale
mispaired mappings (red before the guard). Full transcript suite +
session-manager tests green (824 tests across the affected files).

Real-data verification: an isolated SessionManager over a COPY of the incident
session's corrupt sidecar + provider JSONL + app stores rebuilt 2671 entries
with ZERO duplicate uuids (83 before the twin fix, 1 before the rewrite guard);
a fresh manager over the same copy then re-reconciled append-only (generation
stable, still zero duplicates).

## Related

- [Ordered transcript reconciliation](../architecture/2026-11-16-transcript-ordered-reconcile.md)
  owns the occurrence-identity decision this fix repairs (spec §5.2/§5.3/§7.1).
- [Whole-message assistant uuid reconcile](2026-11-10-multi-block-assistant-uuid-reconcile.md)
  — the response-coverage rule across uuid spaces; adjacent, not overlapping
  (that fix handles different-uuid copies of one response, this one same-uuid
  copies across the wire/disk boundary).
