# Agent Note: Transcript sidecar crash recovery — clean batch boundaries, demote corrupt commits

Status: implemented

## Problem

A server process dying mid-rebuild permanently blanked a session's transcript panel. Live incident: session `2d6a7e71`, 2026-11-19 — the session was live and idle, `/history` served all disk messages, but the client rendered nothing because the seq window hydrated empty (and `getTranscriptWindow` threw 423 `transcript-degraded`).

Proven mechanism (forensics on `transcripts/2d6a7e71….ndjson`):

1. `TranscriptSidecar.appendBatch` writes `[...rows, commit].join('\n') + '\n'` as ONE `writeFile` + `sync`. A crash mid-write leaves a torn tail **without a trailing newline**.
2. The next `appendBatch` writes its payload immediately after the torn bytes, so its FIRST row concatenates onto the torn line. Both become one unparseable physical line; `load()` skips it. Evidence: line 2199 was `rebuild-…-1` seq 1399 (partial) fused with `rebuild-…-2` seq 0; `rebuild-…-2` parsed 4873 rows (seq 1..4873) while its commit declared `count: 4874`.
3. `parseBatches → validateCommit` treated a complete-but-count-mismatched commit as fatal (`throw corrupt-sidecar`); `truncateToLastCommit` failed closed the same way.
4. `ensureTranscriptReconciled` caught, set `t.degraded = true`, and never hydrated the store. The seq window was empty → blank panel. Every boot re-threw → permanent.

`load()`'s old docblock assumption — "a torn tail can only ever lose the very last in-flight row, never corrupt earlier ones" — was false: a no-newline torn tail also eats the first row of the NEXT batch, and a later valid append buries the torn line mid-file.

The CLI JSONL (provider log) is authoritative and intact; the sidecar is a projection cache. Any corrupt projection is discardable and rebuildable via `reconcileOrdered`.

## Decision

Two defenses, both in `server/transcript-sidecar.ts`, plus reconcile logging:

**A. Clean physical boundary — `recoverTail` drops only the incomplete tail.** `ensureHandle` runs `recoverTail` once per handle open. It truncates the file to the last newline boundary (the incomplete final line a crash leaves), **byte-exact** via `Buffer.byteLength` so a multibyte row is never clipped mid-character. It keeps every complete line — including the committed v1 suffix that legitimately follows the last v2 generation commit (the fold replays it, spec §8.2). The previous behavior truncated v2 files to the last *commit*, discarding that v1 suffix (the final turn's rows — a data-loss hazard the unload path at `session-manager.ts:9462` worked around by draining durable work before dropping the holder). Uncommitted v2 batches left intact are ignored by the fold; a corrupt committed batch is demoted there — neither needs physical truncation. This corrected `recoverTail` is the single boundary defense; no separate offset tracking is maintained.

**B. Demote corrupt commits, never permanently degrade.** `validateCommit(b)` returns a corruption reason (`count mismatch` / `checksum mismatch`) or `null` — crash damage, not a fatal state. `parseBatches(rows)` returns `{ batches, corrupt }`: an invalid committed batch and its rows are excluded from `batches` and reported in `corrupt`. `foldSidecarRowsV2` adopts the latest VALID committed generation (the existing `committedBatchIds` replay gate already excludes demoted rows), or returns `hasCommittedGeneration: false` so the caller falls back to the intact v1 projection; it threads `corrupt` to the caller. `truncateToLastCommit` skips corrupt commits as anchors (their rows salvage into the tail) instead of throwing. `ensureTranscriptReconciled` logs `folded.corrupt` as a warning and proceeds to hydrate + `reconcileOrdered`, which rebuilds a fresh valid generation from the authoritative provider log. The durable-before-publish invariant is unchanged: a rebuild is exposed only after its own commit fsyncs; recovery discards the bad projection, it does not publish it.

`load()`'s docblock states the real failure mode and the two defenses.

## Verified runtime facts

- The fused-line mechanism was confirmed byte-for-byte on the incident sidecar (torn `rebuild-…-1` seq 1399 + `rebuild-…-2` seq 0 on one physical line; the committed generation one row short of its declared count).
- The provider log (`/history`) stayed intact and authoritative throughout; the blank panel was purely the degraded seq projection.
- A mid-write crash leaves a no-newline tail; `recoverTail`'s last-newline truncation removes exactly that fragment and nothing else.

## Alternatives considered

**Keep validateCommit fatal; repair the file manually / delete the sidecar.** Rejected as the primary mechanism: it makes every mid-write crash a permanent blank panel requiring manual state-dir surgery (the incident response). The provider log is authoritative, so automatic discard-and-rebuild is strictly safer. Manual repair remains the emergency hatch.

**Track a durable `goodOffset` and truncate to it before each append (the original plan).** Superseded during implementation: `ensureHandle` already runs `recoverTail` per open, which is the boundary defense. The real defects were `recoverTail` over-truncating to the last commit (dropping the v1 suffix) and using string length instead of byte length. Correcting `recoverTail` is smaller and reuses the existing mechanism; a parallel offset tracker would duplicate it.

**Make appendBatch fully atomic via temp-file + rename.** Rejected: the sidecar is an append-only mix of v1 live ingest and v2 batches; a whole-file rename would drop the v1 suffix and concurrent live appends.

**Recompute the commit count from parsed rows instead of validating.** Rejected: it would silently accept a partial projection as a committed generation — publishing lost rows as if complete. Demote-and-rebuild keeps the committed-generation invariant honest.

## Consequences

Bought: a mid-rebuild crash no longer blanks the panel — the corrupt generation is demoted and the transcript rebuilds from the provider log on the next reconcile; the committed v1 suffix survives handle reopens; multibyte rows are never clipped by tail recovery. The unload path's drain-before-drop workaround remains correct but no longer guards a truncation hazard.

Cost: demotion discards a corrupt generation's app-only rows (queued-not-published prompts, evictions recorded only in the sidecar); the rebuild recomposes from the provider log + result-frames sidecar, and transient dispatch states live in the T7b dispatch-state sidecar. Knowingly given up: app-only rows that exist nowhere else and sit in the corrupt batch — transient by definition. `recoverTail` now leaves complete uncommitted/corrupt lines in the file (the fold ignores/demotes them) rather than physically cutting to the last commit. Known limitation: rebuilds APPEND, they do not compact, so dead batches from repeated crash-recovery accumulate and are re-parsed on every reconcile; the demotion warn is filtered to unsuperseded corruption (`unsupersededCorrupt`) so it does not false-alarm forever, but sidecar compaction is a separate future feature, not part of this recovery fix.

## Testing

- `server/transcript-sidecar.test.ts`: count/checksum-mismatched commits demote and the previous valid generation is adopted; no valid generation → v1 fallback; `truncateToLastCommit` skips a corrupt anchor; `appendBatch` after a no-newline torn tail writes a clean intact batch; byte-exact recovery with multibyte content; a committed v1 suffix after a generation batch survives a later append.
- `server/session-manager.test.ts`: a count-mismatched generation batch rebuilds the full window from the provider log with the holder not degraded; the byte-for-byte fused-tail incident shape (v1 base + torn uncommitted batch fusing with the next generation's seq-0 row) recovers the full provider-log window.
