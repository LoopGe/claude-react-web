# Agent Note: Transcript sidecar crash recovery — clean batch boundaries, demote corrupt commits

Status: proposed

## Problem

A server process dying mid-rebuild permanently blanks a session's transcript panel. Live incident: session `2d6a7e71`, 2026-11-19 — the session is live and idle, `/history` serves all 4873 disk messages, but the client renders nothing because the seq window hydrates empty.

Proven mechanism (forensics on `transcripts/2d6a7e71….ndjson`):

1. `TranscriptSidecar.appendBatch` writes `[...rows, commit].join('\n') + '\n'` as ONE `writeFile` + `sync`. A crash mid-write leaves a torn tail **without a trailing newline**.
2. The next `appendBatch` writes its payload immediately after the torn bytes, so its FIRST row concatenates onto the torn line. Both become one unparseable physical line; `load()` skips it. Evidence: line 2199 is `rebuild-…-1` seq 1399 (partial) fused with `rebuild-…-2` seq 0; `rebuild-…-2` parses 4873 rows (seq 1..4873) while its commit declares `count: 4874`.
3. `parseBatches → validateCommit` (`transcript-sidecar.ts:353`) treats a complete-but-count-mismatched commit as fatal: `throw corrupt-sidecar`. `truncateToLastCommit` (`:509`) fails closed the same way.
4. `ensureTranscriptReconciled` (`session-manager.ts:8332`) catches, sets `t.degraded = true`, and never hydrates the store. The seq window is empty → blank panel. Every boot re-throws → permanent.

`load()`'s docblock assumption — "a torn tail can only ever lose the very last in-flight row, never corrupt earlier ones" — is false: a no-newline torn tail also eats the first row of the NEXT batch, and a later valid append buries the torn line mid-file.

The CLI JSONL (provider log) is authoritative and intact; the sidecar is a projection cache. Any corrupt projection is discardable and rebuildable via `reconcileOrdered`.

## Proposal

Two independent defenses, plus a contract fix:

**A. Prevent — clean batch boundaries.** The sidecar tracks a durable `goodOffset` (byte position after the last fsync'd complete write). `appendBatch` truncates the file to `goodOffset` before writing its payload, then writes + fsyncs + advances `goodOffset`. A crash mid-write leaves garbage only AFTER `goodOffset`; the next append truncates it away before writing, so no batch ever concatenates onto a torn tail. On load, `goodOffset` is derived from the last parseable newline-terminated line (the physical tail is the only place a fresh tear can sit). This makes the append-only file self-healing at the write boundary.

**B. Recover — demote corrupt commits, never permanently degrade.** `validateCommit` failure (count or checksum mismatch) is crash damage, not a fatal state. `parseBatches` demotes an invalid committed batch: it is excluded from the committed set and reported in a `corrupt: Array<{batchId, reason}>` list; its rows are never applied (the fold's existing `committedBatchIds` gate at `:488` already excludes non-committed batch rows, so demotion alone suffices — no separate skip set). `foldSidecarRowsV2` then adopts the latest VALID committed generation; if none survives, `hasCommittedGeneration: false` and the caller falls back to the intact v1 projection. `truncateToLastCommit` likewise treats an invalid commit as part of the truncatable uncommitted tail instead of throwing. `ensureTranscriptReconciled` logs the corrupt list as a warning and proceeds; `reconcileOrdered` rebuilds a fresh valid generation from the authoritative CLI JSONL. The invariant preserved: an uncommitted/partial generation is NEVER exposed to the client (durable-before-publish stays); recovery discards the bad projection and rebuilds, it does not publish it.

**C. Contract fix.** `load()`'s torn-tail docblock is corrected to state the real failure mode (a no-newline tear eats the next batch's first row; a buried torn line is handled by demotion, not by load). The "fail closed, not hide corruption" stance in `truncateToLastCommit` is replaced by "discard the corrupt projection, rebuild from the provider log" — hiding nothing, because the rebuild is published only after its own durable commit.

## Alternatives considered

**Keep validateCommit fatal; repair the file manually / delete the sidecar.** Rejected as the primary mechanism: it makes every mid-write crash a permanent blank panel requiring manual state-dir surgery (the incident response). The provider log is authoritative, so automatic discard-and-rebuild is strictly safer and loses nothing the disk doesn't have. Manual repair remains the emergency hatch.

**Make appendBatch fully atomic via temp-file + rename.** Rejected: the sidecar is an append-only mix of v1 live ingest and v2 batches; a whole-file rename would drop the v1 suffix and concurrent live appends. Boundary truncation (A) gives crash safety without changing the append-only model.

**Skip only the torn line in load() and trust the count.** Rejected: the lost row is INSIDE a committed batch (the next batch's seq 0), not the torn line itself; skipping the torn line still leaves the count mismatch. Demotion (B) is required regardless of load-side repair.

**Recompute the commit count from parsed rows instead of validating.** Rejected: it would silently accept a partial projection as a committed generation — publishing lost rows as if complete. Demote-and-rebuild keeps the committed-generation invariant honest.

## Acceptance criteria

- A fixture sidecar reproducing the incident shape (v1 base + uncommitted torn batch + a committed generation missing its seq-0 row) hydrates via v1 fallback / last valid generation and `reconcileOrdered` rebuilds a full window from the provider log — no degrade, no blank.
- `appendBatch` after a simulated no-newline torn tail produces a clean file: the new batch parses intact, count matches, no fused line.
- A valid generation followed by a corrupt later generation adopts the valid one; the corrupt batch's rows never appear in the folded entries.
- `npm run verify` passes; the durable-before-publish invariant is unchanged (a rebuild is exposed only after its commit fsyncs).

## Risks

- Demotion discards a corrupt generation's app-only rows (queued-not-published prompts, evictions recorded only in the sidecar). The rebuild recomposes from the provider log + result-frames sidecar; transient dispatch states live in the T7b dispatch-state sidecar. Knowingly given up: app-only rows that exist nowhere else and sit in the corrupt batch — they are transient by definition.
- `goodOffset` derivation on load must be exact (byte lengths, UTF-8); an off-by-one truncation could clip a valid row. Pinned by a round-trip test (write batches, reload, derive offset, append, re-fold identical).
- This is T7b territory (`transcript-sidecar.ts`, reconcile). The uncommitted `transcript-writer.ts` WIP is runtime-inert and out of scope; the plan must not touch it.
