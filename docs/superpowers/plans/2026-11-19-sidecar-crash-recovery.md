# Transcript Sidecar Crash Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server crash mid-rebuild must never permanently blank a session's transcript: append at clean batch boundaries, and demote-and-rebuild corrupt commits instead of degrading to an empty window.

**Architecture:** Two defenses. (A) `appendBatch` truncates to a durable `goodOffset` before writing, so a no-newline torn tail can never fuse with the next batch's first row. (B) `parseBatches`/`truncateToLastCommit` demote a complete-but-invalid commit (count/checksum mismatch) to an excluded batch; the fold adopts the latest VALID committed generation or falls back to v1, and `reconcileOrdered` rebuilds from the authoritative CLI JSONL. Durable-before-publish is unchanged: a rebuild is exposed only after its own commit fsyncs.

**Tech Stack:** TypeScript (Node), vitest, `node:fs/promises` FileHandle (`writeFile`/`sync`/`truncate`), the existing `TranscriptSidecar` / `foldSidecarRowsV2` / `reconcileOrdered` machinery.

**Spec:** `.agents/notes/proposed/architecture/2026-11-19-sidecar-crash-recovery.md` (proven incident mechanism + decisions; read first).

## Global Constraints

- The CLI JSONL (provider log) is authoritative; the sidecar is a discardable projection. Recovery rebuilds from disk, never publishes a partial generation.
- Durable-before-publish invariant preserved: `reconcileOrdered` appends + fsyncs the commit BEFORE `store.reset/hydrate` (`session-manager.ts:8480-8500` region); do not reorder.
- Do NOT touch the uncommitted `server/transcript-writer.ts` WIP (runtime-inert, out of scope) or its `session-manager.test.ts` +18 hunk.
- `parseBatches`/`foldSidecarRowsV2`/`truncateToLastCommit` are pure functions — keep them pure; logging happens in the caller (`ensureTranscriptReconciled`), via `createLogger('transcript')`.
- Both tsconfigs typecheck; `npm run test` green; full-diff `code-review` before any commit lands on main (CLAUDE.md).
- Windows-safe FileHandle handling: release a failed descriptor before dropping it (existing `appendBatch` catch pattern).

## Review Focus

- **Corrupt LATEST generation over a valid earlier one:** the valid generation is adopted and the corrupt batch's rows never appear in folded entries — Task 1 pins it.
- **No surviving valid generation (the incident shape):** v1 fallback hydrates and `reconcileOrdered` rebuilds a full window, no degrade — Task 4 pins it.
- **`goodOffset` with multibyte UTF-8 content:** byte-exact round-trip (write → reload → derive → append → re-fold identical), no clipped row — Task 3 pins it.
- **Live v1 suffix appended after a rebuild batch:** boundary truncation never clips the committed v1 suffix or a prior valid generation — Task 3 pins it.
- **Rebuild-retry journal recovery (`recoverResetJournal`) facing a corrupt commit:** demotes/truncates instead of throwing fatal — Task 2 pins it.

---

### Task 1: Demote corrupt commits in parseBatches + fold fallback

**Files:**
- Modify: `server/transcript-sidecar.ts` (`validateCommit` ~348, `parseBatches` ~362, `foldSidecarRowsV2` ~396)
- Test: `server/transcript-sidecar.test.ts`

**Interfaces:**
- Produces: `validateCommit(b: ParsedBatch): string | null` (reason or null; no throw). `parseBatches(rows): { batches: ParsedBatch[]; corrupt: Array<{ batchId: string; reason: string }> }` — `batches` holds only VALID committed + uncommitted trailing batches; a corrupt committed batch and its rows are excluded entirely. `foldSidecarRowsV2(rows)` return shape gains `corrupt: Array<{ batchId: string; reason: string }>` (existing fields unchanged).

- [ ] **Step 1: Write failing tests** in `server/transcript-sidecar.test.ts`:
```ts
// fixture helpers: makeRow(seq, uuid, batchId), makeCommit(batchId, gen, count, checksum)
it('demotes a count-mismatched committed batch and adopts the previous valid generation', () => {
  const g1 = [makeRow(0, 'a', 'g1'), makeCommit('g1', 1, 1, checksumOf([...]))]
  const g2 = [makeRow(0, 'a', 'g2'), makeRow(1, 'b', 'g2'), makeCommit('g2', 2, 3, /*wrong*/ 'x')]
  const folded = foldSidecarRowsV2([...g1, ...g2])
  expect(folded.generation).toBe(1)
  expect(folded.entries.map((e) => e.uuid)).toEqual(['a']) // g2 rows excluded
  expect(folded.corrupt.map((c) => c.batchId)).toEqual(['g2'])
})
it('no valid generation → hasCommittedGeneration false (v1 fallback path)', () => {
  const bad = [makeRow(0, 'a', 'g1'), makeCommit('g1', 1, 2, 'x')]
  expect(foldSidecarRowsV2(bad).hasCommittedGeneration).toBe(false)
})
it('checksum mismatch demotes like count mismatch', () => { /* commit count right, checksum wrong → corrupt, prior gen adopted */ })
```
- [ ] **Step 2: Run** `npx vitest run server/transcript-sidecar.test.ts -t "demotes|no valid generation|checksum mismatch"` — expect FAIL (validateCommit throws / no corrupt field).
- [ ] **Step 3: Implement.** `validateCommit` returns the mismatch reason string or null. `parseBatches`: on a commit record, run `validateCommit`; null → committed as today; reason → push `{batchId, reason}` to `corrupt`, do NOT add to committed/open (its rows are dropped). Return `{batches, corrupt}`. `foldSidecarRowsV2`: consume `parseBatches(rows).batches`, thread `corrupt` into the return. The existing `committedBatchIds` replay gate (`:488`) already excludes demoted rows — no other fold change.
- [ ] **Step 4: Run** the tests + `npx vitest run server/transcript-sidecar.test.ts` — expect PASS (fix any existing test that asserted the fatal throw to the new demote contract; name them in the commit).
- [ ] **Step 5: Commit** `fix(transcript): demote corrupt sidecar commits instead of fatal throw`.

### Task 2: truncateToLastCommit + reconcile logging

**Files:**
- Modify: `server/transcript-sidecar.ts` (`truncateToLastCommit` ~509), `server/session-manager.ts` (`ensureTranscriptReconciled` ~8340, `recoverResetJournal` ~8678)
- Test: `server/transcript-sidecar.test.ts`, `server/session-manager.test.ts`

**Interfaces:**
- Consumes: Task 1 `validateCommit` (reason|null), `parseBatches` corrupt report.
- Produces: `truncateToLastCommit(raw)` treats an invalid commit as part of the truncatable tail (no throw); `ensureTranscriptReconciled` logs `folded.corrupt` via `log.warn` and proceeds to hydrate + reconcile.

- [ ] **Step 1: Write failing tests:**
```ts
it('truncateToLastCommit truncates past a complete-but-invalid commit', () => {
  const raw = [validRowLine, invalidCommitLine, tornTail].join('\n')
  const { prefix, salvaged } = truncateToLastCommit(raw)
  expect(prefix).toContain(validRowLine)
  expect(prefix).not.toContain(invalidCommitLine)
})
```
  Plus a manager-level test: a holder whose sidecar has a corrupt latest generation reconciles without `degraded` (assert `t.degraded` falsy and window non-empty after `ensureTranscriptReconciled` + a stubbed provider log).
- [ ] **Step 2: Run** — expect FAIL (truncateToLastCommit throws; manager degrades).
- [ ] **Step 3: Implement.** `truncateToLastCommit`: reuse `validateCommit`; an invalid commit is not a truncation anchor — keep scanning to the last VALID commit; the invalid batch's rows fall into the salvaged/tail side. `ensureTranscriptReconciled`: after `foldSidecarRowsV2`, `if (folded.corrupt.length) log.warn(...)`; the existing try/catch stays for genuine errors, but corrupt-sidecar no longer reaches it.
- [ ] **Step 4: Run** the targeted tests + `npx vitest run server/transcript-sidecar.test.ts server/session-manager.test.ts -t "^(?!.*T7b-2).*$"` — expect PASS.
- [ ] **Step 5: Commit** `fix(transcript): recover reconcile past corrupt commits; log demotions`.

### Task 3: Clean batch boundaries (goodOffset truncation)

**Files:**
- Modify: `server/transcript-sidecar.ts` (`load` ~98, `appendBatch` ~225, new private `goodOffset`)
- Test: `server/transcript-sidecar.test.ts`

**Interfaces:**
- Produces: private `goodOffset: number` (bytes after the last durable complete write); `load()` derives it (byte position after the last parseable newline-terminated line); `appendBatch` truncates to `goodOffset` before writing, advances it after fsync. `load()` signature unchanged (`Promise<SidecarRow[]>`).

- [ ] **Step 1: Write failing tests** (real temp-dir sidecar):
```ts
it('appendBatch after a no-newline torn tail writes a clean intact batch', async () => {
  // write a valid v1 row, then append raw torn bytes WITHOUT trailing newline
  await sc.appendRow(validRow)
  await fs.appendFile(file, '{"v":2,"batchId":"dead","seq":9') // torn, no \n
  await sc2.load() // derive goodOffset (must clip the torn tail)
  await sc2.appendBatch(rows, commit)
  const reloaded = await sc3.load()
  const parsed = parseBatches(reloaded)
  expect(parsed.corrupt).toEqual([])
  expect(parsed.batches.find((b) => b.batchId === commit.batchId)!.rows.length).toBe(rows.length)
})
it('goodOffset is byte-exact with multibyte UTF-8 content', async () => {
  // rows containing CJK/emoji; write → reload → append → re-fold; entries identical, no clipped row
})
it('boundary truncation preserves a committed v1 suffix after a generation batch', async () => { /* gen batch + v1 live rows → reload → append new batch → v1 rows intact */ })
```
- [ ] **Step 2: Run** — expect FAIL (torn tail fuses with the new batch's first row; count mismatch).
- [ ] **Step 3: Implement.** Track `goodOffset`. `load()`: while parsing lines, accumulate byte lengths (`Buffer.byteLength(line, 'utf8') + 1` for the newline); set `goodOffset` to the position after the last successfully parsed newline-terminated line; if the physical tail is a torn no-newline fragment, `goodOffset` excludes it. `appendBatch`: inside the queued run, `await handle.truncate(this.goodOffset)` before `writeFile(payload)`, then `sync`, then `this.goodOffset += Buffer.byteLength(payload, 'utf8')`. Reset `goodOffset` on `remove`/failed-handle release. Keep the existing failed-descriptor release pattern.
- [ ] **Step 4: Run** `npx vitest run server/transcript-sidecar.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `fix(transcript): append batches at clean durable boundaries`.

### Task 4: Incident-shape integration regression

**Files:**
- Test: `server/session-manager.test.ts` (transcript seq store describe)
- Modify (only if a seam is needed): `server/session-manager.ts` reconcile path

**Interfaces:**
- Consumes: Tasks 1-3 (demotion, recovery, boundaries).

- [ ] **Step 1: Write the failing regression** reproducing the proven incident shape: build a sidecar file = v1 base rows (unique seqs) + an uncommitted v2 batch whose last row is torn (no newline) + a committed v2 generation batch missing its seq-0 row (count mismatch). Stub the provider log (`composeTranscriptEntries` source) with the full ordered transcript. Run `ensureTranscriptReconciled` (via resume/create on the fixture session).
```ts
expect(holder.degraded).toBeFalsy()
const win = await sm.getTranscriptWindow(id)
expect(win.totalCount).toBe(providerLogCount) // full rebuild, not the 799-row v1 prefix
expect(win.messages.some((m) => m.msg.uuid === 'seq0-uuid')).toBe(true)
```
- [ ] **Step 2: Run** — expect FAIL on current code (degraded / empty window).
- [ ] **Step 3: Implement** any seam the test needs (prefer none — Tasks 1-3 should make it pass). If it passes unchanged, this step is a no-op verification.
- [ ] **Step 4: Run** `npx vitest run server/session-manager.test.ts -t "incident|crash|corrupt"` then the full manager suite `-t "^(?!.*T7b-2).*$"` — expect PASS.
- [ ] **Step 5: Commit** `test(transcript): crash-corrupt sidecar rebuilds full window (incident regression)`.

### Task 5: Docs + decision record

**Files:**
- Modify: `server/transcript-sidecar.ts` (`load` docblock — correct the torn-tail contract), `docs/superpowers/specs/2026-11-09-native-session-persistence-design.md` or the T7b transcript spec §9 (the sidecar recovery section)
- Move: `.agents/notes/proposed/architecture/2026-11-19-sidecar-crash-recovery.md` → `implemented/`, rewrite per the notes README (Proposal→Decision, Acceptance/Risks→Consequences, present tense)

- [ ] **Step 1: Update the `load()` docblock** to state the real failure mode and the boundary-truncation + demotion defenses; update the spec's recovery section to "demote corrupt commits, rebuild from the provider log" (replace "fail closed").
- [ ] **Step 2: Move + rewrite the note.** Run `npm run verify:agent-notes` — expect OK.
- [ ] **Step 3: Full verification** `npm run typecheck && npm run test && npm run lint && npm run verify:agent-notes` — expect all PASS (pre-existing T7b WIP failures attributed, not fixed).
- [ ] **Step 4: Review.** Run the `code-review` skill on the full branch diff; verify findings; fix confirmed issues (RED→GREEN); re-run review on non-trivial fixes. Only then land on main.
- [ ] **Step 5: Commit** `docs(transcript): sidecar crash-recovery contract`.
