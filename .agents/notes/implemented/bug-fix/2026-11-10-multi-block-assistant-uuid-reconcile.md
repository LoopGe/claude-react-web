# Agent Note: Reconcile recognizes a whole-message assistant line across uuid spaces

Status: implemented

## Problem

The CLI writes one assistant message to its JSONL in one of two shapes. The
dominant shape is one line per content block, each with its own uuid — the same
uuids the live stream's frames carry. Rarely, it writes a single line carrying
every block under the message's original uuid; when the live stream sees that
message, it splits it into derived-uuid frames
(`uuid.slice(0,24) + blockIndex.toString(16).padStart(12,'0')`).

The transcript seq store deduped only by top-level uuid. For the second shape
the on-disk uuid matched nothing in the store, so a restart reconcile treated
the line as a new message and appended it at the seq head. That head row is what
the client's newest page reads (`GET /sessions/:id/messages`), so a resumed
session showed a stale thinking block plus its tool cards at the transcript
tail. Their matching `tool_result` rows sat hundreds of seqs back — outside the
page — so the cards rendered as `running` indefinitely. The same mismatch could
re-append a retracted message whose live frames had been tombstoned under
derived uuids.

## Decision

`shared/assistant-message.ts` owns the shape probe (`assistantMessageShapeOf`:
response id plus content blocks). Both surfaces that must recognize a
whole-message frame across uuid spaces consume it: the client's replay merge
(`dropCachedAssistantResponses`) and the server's transcript reconcile.
`TranscriptStore` keeps the seqs of each response id's rows in a Set, so
hydrating rows the live path already recorded never registers a row twice. The
coverage projection is derived from those rows on demand (tombstoned rows
included), not accumulated incrementally — a live session reconciles on its
first transcript read, after ingest, so an incrementally maintained projection
would double-count and defeat the check.

`backfillFromEntries` applies an extra check only to a **whole-message**
assistant line (more than one content block): if the store's recorded blocks for
that response id reproduce the line's blocks exactly, the live frames cover it
and the line is skipped. Coverage, not mere identity, decides — a partial live
recording does not match, so the line is appended instead of silently dropping
the blocks only it carries. A response whose rows are ALL tombstoned is covered
regardless of content: it was retracted, and letting the disk copy back would
resurrect it. The skipped line's original uuid is aliased to the covering frame's seq, so uuid-anchored reads (`/messages?aroundUuid`,
`/history?beforeUuid`) and search-jump previews still resolve. Per-block lines
never take this check (each carries one block of a shared response id;
collapsing them would lose every sibling); they dedupe by uuid, which matches
the live frames. The recorded-blocks read includes tombstoned rows, so a
retracted message's disk copy stays covered and is not resurrected.

Eviction follows the same identity: `TranscriptStore.evict` expands a uuid to
every row of the assistant response it names, so a retraction naming a
whole-message line's original uuid (aliased to a covering frame) retracts all
blocks rather than just the aliased one.

`foldSidecarRows` repairs sidecars already polluted by the old behavior. The
classification is by shape, not by provenance: a row carrying more than one
block is a whole-message candidate, and it is tombstoned when its blocks are
exactly the concatenation of the single-block rows for the same response id.
Evicted frames still participate, so a retracted message's late duplicate is
removed too; only a visible multi-block row is ever tombstoned. The duplicate's
uuid is re-pointed at the covering frame (`HydrateRow.aliasToSeq`), so
uuid-anchored reads do not resolve to the new tombstone. The comparison is
content-based (`isDeepStrictEqual`), so a partial live recording keeps the disk
copy. The repair is deterministic from the rows, so it is re-derived on every
load rather than persisted as a tombstone row.

## Alternatives considered

**Keep uuid-only dedupe.** Rejected: a whole-message line never shares a uuid
with the live derived-uuid frames, so the duplicate append is guaranteed, not a
race.

**Dedupe every assistant entry by response id.** Rejected: the dominant JSONL
shape is one line per block sharing one response id; a response-level skip drops
every block after the first on a cold rebuild and fork seed. The whole-message
check is deliberately narrower.

**Skip the whole-message line on response id alone.** Rejected: a partial live
recording would lose the blocks the disk line alone carries. The content check
keeps identity from masquerading as completeness.

**Normalize JSONL multi-block lines into per-block frames with derived uuids.**
Rejected: it would reimplement a CLI-internal uuid derivation, and it breaks the
disk/seq dual-read parity gate, which requires both read paths to emit the same
normalized message.

**Make `record()` dedupe by response id as well.** Rejected: the live split
frames legitimately share one response id, so deduping at record time would drop
every block after the first.

**Rewrite the polluted sidecar in place.** Rejected: the fold already projects
rows into the store, and the content-equal check makes the repair deterministic.
A rewrite adds an fs mutation and a second place where the same rule lives.

## Consequences

- Reconcile identifies the rare whole-message line across the live and disk uuid
  spaces, while the dominant per-block shape keeps every block.
- Already-polluted sidecars heal on their next load. The seq space stays stable
  because the duplicate is tombstoned rather than renumbered.
- A partial live recording of a whole-message line appends the complete disk
  line, which can render the covered blocks twice at the head. That state
  requires the server to die between a message's last split frame and the CLI
  persisting the line; it has not been observed, and completeness is preferred
  over silently dropping model output.
- Each session's store carries one seq-set per response id, bounded by
  transcript size. The heal collects multi-block response ids first, so a
  normal load allocates no per-message groups.
- Coverage is strict deep equality of content blocks. If the CLI ever changes
  how it serializes a streamed block when persisting, the check stops matching
  and the old visible duplicate returns — never a silent block loss.
- A CommandPalette hit whose uuid belongs to a whole-message response resolves
  to the covering frame, whose own uuid differs. The preview centers by matching
  the hit's uuid, so such a hit shows its surrounding page without exact-target
  highlighting. These responses are rare — one per session in the observed
  transcripts — and the page still resolves instead of 404ing.
- The client's replay merge keeps its identity-only rule (a cached frame of the
  same response suppresses the whole-message replay frame); it treats its cached
  items as the authoritative response for the merge. The shared module documents
  the difference, which the server must not copy because it cannot assume the
  live recording is complete.
- `foldSidecarRows` recognizes only the CLI's current split shape (one block per
  live frame). If the CLI changes that shape, newly written duplicates remain
  prevented by the coverage check, but already-written ones would no longer
  heal.