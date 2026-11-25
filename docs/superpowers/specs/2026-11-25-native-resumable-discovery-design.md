# Native resumable discovery — design

Date: 2026-11-25
Status: proposed

## Problem

Native sessions resume fine from the sidebar (store-driven path, e2e-proven
in `server/providers/native/e2e-persistence.test.ts`), but the `/resume`
picker is blind to them: `NativeProvider` implements neither
`listResumable` nor `getSessionInfo`. Concrete gaps:

1. **Ordinary-deleted native sessions are unrecoverable.** Ordinary delete
   keeps the log (`deleteTranscript` is opt-in) but drops the store entry;
   no surface enumerates the retained log. A claude session in the same
   state re-appears in the picker (`known: false`) and re-adopts via
   `allowAdopt`. The deletion contract is explicit: **ordinary delete is
   recoverable; permanent delete is not.**
2. **sessions.json loss/corruption strands native logs** — claude
   transcripts can be re-adopted from disk; native logs cannot.
3. The **permanent-delete rollback** re-adopt branch
   (`session-manager.ts`, `adoptDiskSession` call in the failed-upgrade
   restore) cannot restore a native session whose index entry is already
   gone.
4. A **native-only future** (claude provider unregistered) leaves the
   picker permanently empty — enumeration is entirely provider-owned.

A second, related loss: **native titles live only in the store.**
`rename()` already mirrors titles into the provider transcript via
`provider.renameSession?.()` (`persistTitleToTranscript`,
`session-manager.ts:6710`; both live and dormant rename paths call it,
serialized through `trackTitleWrite`, tombstone-guarded, drained before
permanent-delete unlink). `ClaudeProvider` implements it (SDK
`renameSession` → customTitle entry); `NativeProvider` does not, so the
mirror falls through. A renamed native session that is ordinarily deleted
loses its name on recovery; a claude session does not.

The multi-provider adoption seam is already in place (commit `a317a476`:
`adoptDiskSession` probes every provider that implements `getSessionInfo`,
default-first, and persists the owning provider). This design adds the
native side of that seam plus picker enumeration. **Manager changes: zero.**

## Reference: how DSH does it

Read-only investigation of `D:\codes\deepseek-harness`:

- **`packages/session/session-title/`** — titles are durable log-only
  state: every accepted revision appends a **`session/title` event**;
  `foldSessionTitle()` selects the latest. Titles survive replay, resume,
  and paging like any other event; they never enter model input,
  `deriveMessages()`, system prompt, or tool schemas (zero token effect).
  **Forks inherit title events in their seed unchanged.** There is **no
  title deletion**. Three sources, newest wins (deterministic first-prompt
  fallback, optional LLM provider, explicit rename); a user rename pins
  the session against automatic revision.
- **`packages/session/session-projection/` + `session-projection-cache/`**
  — a generic projection registry (synchronous per-event folds, eager
  drive, `Object.is` reference gates, `asOfSeq` consistent cuts) plus
  durable per-session checkpoints (mandatory writes at creation /
  `turn/end` / disposal, throttled between; log-leads-cache-follows;
  lifecycle + `stateVersion` fencing; backup-and-skip salvage; restore
  recipe that refolds only the suffix). List rows carry a **summary
  subset** of projection keys and read cold values with **zero IO** via
  `cachedSnapshot`.

**What we take:** the `session/title` event semantics (name, latest-wins,
log-only, fork inheritance, no deletion). **What we do not take:** the
projection machinery — see Alternatives.

## Goals

1. Native rows in `GET /sessions/resumable` with full parity to claude
   rows: `known` / `running` / `terminated` / `canRetryResume` annotation,
   title precedence, `?dir=` scope, first/last prompt previews.
2. Ordinary-deleted native sessions recoverable end-to-end: picker row
   (`known: false`) → `POST /resume` with `allowAdopt` → re-adopted under
   `native` **with its title**.
3. `NativeProvider.renameSession`: titles durable in the log, written on
   every rename (live and dormant), surviving ordinary delete + recovery.
   Auto-generated titles persist too (§2a) — auto-title is the common
   path, so recovery-with-title must hold for it, not only for manual
   renames.
4. Manager unchanged; the existing provider iteration in `listResumable`
   and the multi-provider `adoptDiskSession` carry everything.
5. Client: unknown-row badge is provider-aware (a recovered native row
   must not read "CLI").

## Non-goals

- No projection registry, no durable checkpoint infrastructure.
- No native LLM title generation / auto-revision pinning (DSH's title
  service scheduling). Auto-title **durability** IS in scope (Design
  §2a): `autoGenerateTitle` does NOT flow through `rename()` — it writes
  the store only (`session-manager.ts:7933-7937`), and claude's auto-title
  durability comes from the SDK `persist: true` path
  (`claude-session.ts:271-279`), not the mirror seam. Native persists the
  auto-title provider-side, mirroring that mechanism.
- No title-clear mirroring. The manager seam early-returns on an empty
  title (`persistTitleToTranscript`: `if (!providerName || !title) return`),
  exactly as for claude; a recovered session may surface the last
  non-empty title. Accepted claude-parity limitation.
- No worktree-group dir scoping (Decision D1).
- No cross-stateDir enumeration, no GC/retention changes, no change to
  permanent-delete semantics (it already recursively removes the whole
  session directory, `session-log/log.ts:226`).

## Anti-goals

- A second durable title artifact (sidecar file) — rejected alternative.
- Full validated parse of every log per picker open through the 4-entry
  `nativeHistoryCache` — thrashes hot-session parse entries.
- `renameSession` opening a second writer over a live session —
  `NativeSessionLog.open()` calls `markSuperseded()` on the previous
  writer (`log.ts:378`); that would kill the live session's log.
- Title events entering model history, the renderable transcript, or
  search.
- One corrupt log killing the whole listing.

## Design

### 1. `session/title` event (neutral vocabulary)

- New operational event in `SessionEventMap`
  (`server/providers/native/vocabulary/session-event.ts`):
  `'session/title': { title: string }` — DSH-parity name and semantics.
  Seq-numbered like every event; append-only; **latest-wins** on read.
- Validator in `session-log/format.ts`; the writer's append path accepts
  it through `NativeEventInput`.
- **Non-renderable by construction:** `projectNativeEventToSdkLine`
  (host adapter) returns null for it; `historyFromEvents`, search, and
  the subagent catalog ignore it (type-switch). Explicit test pins each.
- Legacy v1/v2 logs simply lack the event → title undefined. No
  migration: an optional v3 append, not a format break.
- **Fork:** the seed copies events up to the cut, so title events are
  inherited unchanged (DSH-parity, accepted). A fork's own rename appends
  a later event; latest-wins gives the fork its own title. An unknown
  fork row in the picker shows the inherited source title until renamed
  — DSH accepts the same behavior.
- **Clear:** spawns a new id with its own log; the source log (and its
  title) is untouched.

### 2. `renameSession` (provider method)

Signature per `server/providers/types.ts:463`:
`renameSession?(sessionId, title, opts?: { dir? }): Promise<unknown>`.

The single-writer discipline lives in `log.ts`, which owns the `writers`
map. Add a module-level helper (e.g. `appendSessionTitle(stateDir, id,
title)`) that:

- resolves the log path; if a **current** writer exists in the map (not
  superseded, not closed) → append + flush through it. This is the live
  session case: the title event interleaves into the same append-only
  seq chain; the live core's in-memory history is unaffected (it never
  re-reads the log mid-session, and the event is non-renderable).
- otherwise → `open({ resume: true })` → append → flush → close. This is
  the dormant case; eager v1/v2→v3 migration rides the established open
  path.
- missing log → throw `NativeSessionStorageError('missing')`. The
  manager's `persistTitleToTranscript` already catches + warns and keeps
  the app title (existing fail-soft, unchanged).

Manager side is already complete: serialization (`trackTitleWrite`),
tombstone guard, drain before permanent-delete unlink. **Zero manager
change.**

### 2a. Auto-title persistence (provider-side, claude `persist:true` parity)

`autoGenerateTitle` never calls the mirror seam — it writes the store
only. Claude's auto-titles are durable because `ClaudeSession.generateTitle`
passes `persist: true` to the SDK and the CLI writes its own transcript.
Native mirrors that mechanism: **`NativeSession.generateTitle` appends a
`session/title` event through the live writer before returning the title
string** (`native-session.ts:2334`). The manager's store write + broadcast
stay exactly as they are.

- **Log-level no-overwrite guard:** before appending, fold the latest
  `session/title` from the log; if one already exists, skip the append
  (return the generated string unchanged — the manager's store-level
  guards still decide what the store keeps). This mirrors the manager's
  double no-overwrite guard (entry + post-await,
  `session-manager.ts:7911,7922`) at the log layer and makes both race
  orderings consistent: a manual rename that lands BEFORE the LLM call
  completes leaves a title event the auto-append skips; one that lands
  AFTER appends a later event that latest-wins selects.
- The append rides the same single-writer helper as §2 (live writer
  path only — `generateTitle` is a live-handle control method, so the
  dormant branch is unreachable here).
- A failed append surfaces through the existing `timeSdkControl` error
  path; the manager leaves the session untitled (its existing behavior
  on a thrown `generateTitle`). No silent store/log divergence: the
  append precedes the return the manager persists from.

### 3. Selective listing scan (host-side module)

New module `server/providers/native-resumable-listing.ts` — host-side,
OUTSIDE `native/` (the `native-host-adapters.ts` precedent): the host-free
structural pin (`host-free.test.ts`) bans value-imports of host-domain
services (including `history-reader`) from EVERY production file under
`native/`, not only core. The module imports core parsers
(`session-log/format`, `paths`, `migration`) plus host display helpers
(`history-reader` cleaners). Both structural pins stay literally
untouched.

**Enumerate:** `readdir <stateDir>/native-sessions` → directories whose
name passes `isSafeSessionId` → `stat session.v1.jsonl` (ENOENT → skip).
Subagent transcripts live inside the same session log (sidechain
events), not as separate files — enumerating session directories lists
exactly the main sessions.

**Per row, one sequential pass with selective parse:**

- Cheap substring prefilter on the raw line for the types we need
  (`"type":"session/header"`, `"type":"user/message"`,
  `"type":"session/title"`, and legacy `"type":"user"`). The writer
  serializes with `JSON.stringify` (compact, stable), so the prefilter
  cannot false-negative; false positives are parsed and rejected.
- JSON.parse + validated parse **only on hits**: `parseHeaderLine` for
  the header; `parseEventLineV3` (v3) or `parseEventLine` +
  `migrateEventToV3` (legacy) for user/title events. Non-hit lines
  (assistant/tool/stream — the vast majority) are never parsed.
- Extract: header → `cwd`, `createdAt`; stat → `lastModified`; first
  eligible user message → `firstPrompt`; last eligible → `lastPrompt`;
  latest `session/title` → `title`.

**Prompt eligibility mirrors `parseLastUserPrompt`'s display contract**
(`history-reader.ts:273-309`): skip `isCompactSummary` and sidechain
events (`parent_tool_use_id != null`); then host-side cleaning —
`stripHandles`, `isInterruptPlaceholder`, `SYNTHETIC_FRAME_PREFIX_RE`,
tool_result frames excluded, `condensePromptPreview` cap,
`attachmentNameFallback`. The scan extracts raw text from neutral
`user/message` content; the host module applies the shared cleaners.
Builder verification item: native synthetic injection classes (e.g.
task-result injections) must be checked against these predicates.

**Row cache:** module-level LRU keyed `(stateDir, id)`, freshness
`(size, mtimeMs)`, value = the extracted row facts (small — not event
arrays). Cap 256. Same family as `lastPromptCache` /
`jsonl-cache` / `nativeHistoryCache`. Warm picker open: stat-only, zero
parse. **In-memory only** — no durable checkpoints (Decision D5).

**Concurrency:** bounded chunks of 16 (the claude `listResumable`
precedent, `claude-provider.ts:820`).

**Per-row fail-soft:** corrupt header / unreadable file → skip the row +
`log.warn`; a file deleted mid-scan → skip. The listing is display-only;
the authoritative resume path still full-validates at open and surfaces
corruption loudly. (Claude degrades the whole list on SDK error; per-row
isolation is strictly better and matches the per-row preview fail-soft
already in place.)

**`?dir=` scope:** `header.cwd === dir` exact match (Decision D1).

**Mapping to `ResumableSession`** happens in `native-provider.ts` (host
type): the log title rides as **`title`, not `customTitle`** (Decision
D2); `known/running/terminated` default false (the manager annotates);
`provider` left unset (the manager defaults it to `provider.name`).

### 4. `getSessionInfo(id)`

Same selective scan for a single id, sharing the row cache. Missing →
`undefined`. Corrupt → throw (the multi-provider `adoptDiskSession`
catches per provider, warns, continues → 404 when no provider owns the
id; claude-parity).

Unlocks, all through the existing seam: re-adoption after ordinary
delete, recovery from sessions.json loss, and the permanent-delete
rollback restore branch.

### 5. Client badge

`src/components/session-list/ResumeSessionDialog.tsx:263`: the
unknown-row badge becomes provider-aware — `s.provider === 'native'` →
`native`, otherwise the existing `CLI` wording. The manager always sets
`provider` on picker rows. Known rows: no badge (unchanged).

## Decisions (builder's calls, marked)

- **D1 — dir scope is exact `header.cwd` match.** A native session whose
  cwd is a worktree does not appear under the main repo's "this project"
  scope; "All projects" shows it. No per-row git probing (cost; unknown
  rows have no meta to read a worktree field from). The claude SDK's
  git-aware worktree grouping is deliberately not replicated.
- **D2 — log title returned as `title`, not `customTitle`.** Native has
  no external renamer; the only writer is the app mirror. Manager
  precedence (`customTitle ?? live.title ?? meta.title`) therefore keeps
  the store title authoritative for known sessions (correct when a
  best-effort mirror write failed), and the log title surfaces only for
  unknown (recovered) sessions — riding adoption into the recovered
  meta.
- **D3 — one selective full pass, not head+tail windows.** Title events
  sit anywhere in the log, so a single pass serves all four facts:
  O(bytes) read + O(hits) parse. Cold "All projects" cost is honest and
  bounded by concurrency + the row cache; warm opens are stat-only.
- **D4 — listing module host-side, OUTSIDE `native/`.** `ResumableSession`
  and the display cleaners are host vocabulary; the host-free pin bans
  value-importing host services from every `native/` prod file, so the
  module lives at `server/providers/native-resumable-listing.ts`
  (the `native-host-adapters.ts` precedent). Pins stay literally untouched.
- **D5 — in-memory row cache only.** The picker refetches on open; there
  is no live projection-feed requirement. Durable checkpoints would buy
  zero-IO cold reads at the price of a permanent lifecycle/versioning
  surface — disproportionate for one listing feature.

## Alternatives considered

- **Title sidecar (`<id>/title.json`).** Would preserve head+tail
  lightweight reads and touch no log format; permanent delete already
  removes the directory. Rejected: a second durable artifact with its
  own fork/clear lifecycle pins, diverging from DSH's validated
  log-event semantics. The log is the durable unit that survives
  delete; keeping the title in it keeps one source of truth.
- **Full parse via `nativeHistoryCache` per row.** Rejected: the 4-entry
  LRU thrashes on enumeration and evicts hot-session entries (opening
  the picker would slow the next history page of the active session);
  full validation cost per row per cold open.
- **Port DSH's projection registry + durable checkpoint cache.**
  Rejected for now: it presupposes ONE canonical event language — we
  deliberately keep two (SDK `AgentMessage` + neutral `SessionEvent`)
  with translation at the provider seam, so a cross-provider registry
  fights the seam design; our drive point is already centralized
  (client reducer / server pump); our transcript rewrites
  (evict/prepend/repair/rewind) break the append-only drive assumption
  the registry relies on; and the dynamic-registration /
  version-sharing / summary-exclusion / upgrade-fixture machinery
  solves plugin-hot-plug scale we do not have. **Revisit trigger:** if
  native's per-open read-consumer scans keep multiplying (parity work
  is adding them), consolidate into a native-specific per-session
  read-model (one pass folds K values, extending the incremental
  subagent-catalog pattern) — not a generic framework.
- **Accept title loss (firstPrompt label on recovery).** Rejected:
  breaks the recoverable-delete parity the deletion contract requires.

## Acceptance criteria

1. Picker lists native sessions alongside claude (dir-scoped and
   all-projects), with correct previews, titles, and
   known/running/terminated badges; unknown native rows badge `native`,
   not `CLI`.
2. Rename (live and dormant) appends `session/title`; ordinary delete →
   picker row carrying the renamed title → resume with `allowAdopt` →
   recovered native session with the title in the store. Permanent
   delete → row gone, directory gone.
2a. An **auto-titled** session (no manual rename) recovers with its
   auto-title through the same delete → picker → adopt flow. Auto-title
   never overwrites a manual rename in the log, in either race ordering
   (rename before / after the LLM call completes).
3. A native log whose store entry was removed is still listed and
   adoptable (sessions.json-loss recovery).
4. One corrupt native log does not break the listing; resuming that
   session fails loudly.
5. Legacy v1/v2 logs enumerate (title undefined) and resume unchanged
   (eager migration untouched).
6. Fork inherits the seed title; fork rename is latest-wins; clear
   leaves the source title.
7. Title events never appear in model history, renderable transcript,
   or search (explicit pins).
8. Live-session rename never supersedes the live writer (single-writer
   pin).
9. Manager diff zero; core neutrality pins green; full suite +
   typecheck + lint green.

## Risks

- **Cold "All projects" scan cost** with many large logs: O(total bytes)
  read on a cold open. Mitigated by 16-concurrency and the stat-keyed
  row cache; honest parity with the claude picker's documented heaviness
  at scale.
- **Prefilter couples to writer serialization** (`JSON.stringify`
  compact form). Pinned by a round-trip test: write a log through the
  real writer, scan it, assert the extracted facts.
- **Native synthetic injections** may pollute previews if claude's
  predicates do not cover them — builder verification item, with a test
  per injection class found.
- **Recovered fork shows the inherited source title** until renamed
  (DSH-accepted).
- **Clear-title-then-delete surfaces the stale title** (claude-parity
  limitation, documented above).

## Builder notes

- Verify `historyFromEvents` / search / subagent catalog ignore
  `session/title` by construction (type-switch); add explicit pins.
- Verify native task-result injection marking against the preview
  predicates; extend eligibility only where a real class is proven.
- Writer-map helper: distinguish current vs superseded/closed writers;
  check `close()` removal semantics before choosing the lookup.
- **Dormant rename must await the eager v1/v2→v3 migration before
  appending** — `projectNeutralEventToLegacy` throws on a v3-only
  `session/title` against an unmigrated legacy log (settled: await the
  open path's migration promise, then append).
- **Selective parse seq counting:** `parseEventLineV3` validates the seq
  chain, so the scan must count EVERY committed line (not only parsed
  hits) to supply the correct seq. The prefilter skips parsing, never
  counting (settled mechanical rule).
- The display cleaners the scan reuses (`stripHandles`,
  `isInterruptPlaceholder`, `SYNTHETIC_FRAME_PREFIX_RE`,
  `condensePromptPreview`, `attachmentNameFallback`) — export whichever
  are private in `history-reader.ts`; do not duplicate them (settled).
- Agent note: `.agents/notes/proposed/feature/2026-11-25-native-resumable-discovery.md`
  (decision + rejected alternatives), moved to `implemented/` when the
  code lands; cross-link the provider-seam neutralization note.
- TDD throughout (failing test first per behavior); code-review on the
  full diff before commit.