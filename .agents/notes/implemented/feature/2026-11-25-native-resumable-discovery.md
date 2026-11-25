# Agent Note: Native resumable discovery and durable session titles

Status: implemented

## Problem

The `/resume` picker was blind to native sessions: `NativeProvider` implemented
neither `listResumable` nor `getSessionInfo`, while the claude provider
enumerates SDK transcripts on disk. The deletion contract is explicit —
**ordinary delete is recoverable; permanent delete is not** (the
[permanent clear command](2026-11-12-clear-permanent-command.md) note owns the
destructive side) — and claude satisfies it: an ordinary-deleted claude session
re-appears in the picker as an unknown row and re-adopts via `allowAdopt`.
Native broke it in four places:

1. Ordinary delete keeps the native log but drops the store entry, and no
   surface enumerated the retained log — the session was unrecoverable.
2. `sessions.json` loss or corruption stranded native logs; claude transcripts
   in the same state could be re-adopted from disk.
3. The permanent-delete rollback restore branch (`adoptDiskSession`) could not
   restore a native session whose index entry was already gone.
4. A native-only host (claude provider unregistered) left the picker
   permanently empty — enumeration is entirely provider-owned.

A second, related loss: native titles lived only in the store. `rename()`
mirrors titles into the provider transcript via `provider.renameSession?.()`,
but `NativeProvider` did not implement it, so the mirror fell through. A
renamed native session that was ordinarily deleted lost its name on recovery;
a claude session did not. Auto-generated titles had the same gap:
`autoGenerateTitle` writes the store only, and claude's auto-title durability
comes from the SDK `persist: true` path, not the mirror seam.

## Decision

`NativeProvider` implements `listResumable`, `getSessionInfo`, and
`renameSession` on top of a durable `session/title` log event and a host-side
selective listing scan. The manager's existing provider iteration in
`listResumable` and the multi-provider `adoptDiskSession` carry everything —
no manager logic changes. The full contract lives in the
[native resumable discovery design](../../../../docs/superpowers/specs/2026-11-25-native-resumable-discovery-design.md);
this note records the decisions and what they beat. The provider boundary
follows the
[provider seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md):
the event is neutral vocabulary, the scan is host-side.

### `session/title`: durable log-only title (DSH parity)

`SessionEventMap` (`server/providers/native/vocabulary/session-event.ts`)
carries `'session/title': { title: string }` — the DSH name and semantics.
Seq-numbered like every event, append-only, **latest-wins** by file position;
validator in `session-log/format.ts`. The event is log-only:
`projectNativeEventToSdkLine` returns null for it, and `historyFromEvents`,
search, and the subagent catalog ignore it by type-switch, so it never enters
model history, the renderable transcript, or search (zero token effect;
explicit test pins each).

- **Fork:** the seed copies events up to the cut, so title events are inherited
  unchanged; a fork's own rename appends a later event that latest-wins
  selects. A recovered fork shows the inherited source title until renamed —
  DSH accepts the same behavior.
- **Clear:** spawns a new id with its own log; the source log and its title are
  untouched. There is no title deletion and no clear mirroring: the manager
  seam early-returns on an empty title, exactly as for claude, so
  clear-title-then-delete can surface the last non-empty title (accepted
  claude-parity limitation).
- **Legacy v1/v2 logs** simply lack the event → title undefined. An optional
  v3 append, not a format break; no migration.

### Single-writer title appends

`appendSessionTitle(stateDir, id, title)` in `session-log/log.ts` owns the
single-writer decision because that module owns the `writers` map:

- A registry hit is always the current writer (`open` supersedes the previous
  entry), so the title rides its writer-operation queue and the live session
  keeps appending through the same object. Opening a second writer over a live
  session would `markSuperseded()` the live log — the anti-goal this path
  exists to prevent.
- With no live writer (dormant rename), the log is opened with `resume: true`,
  the eager v1/v2→v3 migration is awaited **before** appending (a neutral
  title has no legacy projection — appending it to an unmigrated legacy log
  throws), then flushed and closed.
- Missing log → `NativeSessionStorageError('missing')`; the manager's
  `persistTitleToTranscript` catches, warns, and keeps the store title
  (existing fail-soft, unchanged).

`NativeProvider.renameSession` delegates to this helper. Serialization
(`trackTitleWrite`), the tombstone guard, and the drain before permanent-delete
unlink stay manager-side, unchanged.

### Auto-title persistence (claude `persist:true` parity)

`NativeSession.generateTitle` appends the trimmed title as a `session/title`
event through the live writer **before returning**, mirroring the SDK
`persist: true` mechanism so the common path (auto-title, no manual rename)
also recovers with its name. A **log-level no-overwrite guard** skips the
append when the log's neutral events already contain any `session/title`
event, mirroring the manager's store-level double guard: a manual rename that
lands before the LLM call completes leaves an event the auto-append skips; one
that lands after appends a later event that latest-wins selects. A failed
append propagates through the existing `timeSdkControl` error path and the
manager leaves the session untitled — the append precedes the return the
manager persists from, so store and log never silently diverge.

### Selective listing scan and row cache

`server/providers/native-resumable-listing.ts` enumerates
`<stateDir>/native-sessions` directories (`isSafeSessionId`, stat
`session.v1.jsonl`, ENOENT → skip) and extracts row facts — header
`cwd`/`createdAt`, stat `lastModified`, first/last eligible user prompt, latest
title — with **one streaming pass per log**:

- A substring prefilter (`"type":"user/message"`, `"type":"session/title"`,
  legacy `"type":"user"`) selects lines for validated JSON parse; the writer
  serializes with compact `JSON.stringify`, so a substring miss is a guaranteed
  non-hit and a false positive only costs one parse. Assistant/tool/stream
  lines — the vast majority — are never parsed.
- Every complete line advances the seq chain (the validators check seq
  equality on each parsed hit, so non-hit lines must count too). A torn tail
  (bytes not ending in `\n`, possible mid-append) is never parsed and never
  counted.
- Prompt eligibility mirrors `parseLastUserPrompt`'s display contract:
  main-thread only, no compaction summaries, no interrupt placeholders, no
  synthetic-prefix frames; `stripHandles`, `condensePromptPreview`,
  `attachmentNameFallback`. The cleaners are exported from
  `history-reader.ts`, not duplicated. Neutral tool results are separate
  `tool/result` events, so no tool_result-block filter is needed.
- **Row cache:** module-level LRU keyed `(stateDir, id)`, freshness
  `(size, mtimeMs)`, cap 256, values are the small row facts — never event
  arrays. A failed scan caches nothing (a transient delete race or Windows
  lock must not pin a verdict); `deleteTranscript` calls
  `invalidateNativeResumableCache(id)` beside the history-cache invalidation,
  so a re-created id never serves a stale row. Warm picker opens are stat-only,
  zero parse. In-memory only — no durable checkpoints.
- Concurrency is bounded chunks of 16 (the claude `listResumable` precedent).
  Per-row fail-soft: a corrupt or unreadable log is skipped with a warn; the
  listing is display-only and the authoritative resume path still
  full-validates at open and surfaces corruption loudly. One corrupt log never
  kills the listing.
- `getSessionInfo(id)` shares the scan and cache for a single id: missing →
  `undefined`; corrupt → throw (the multi-provider adoption probe catches per
  provider, warns, continues → 404 when no provider owns the id).

The module lives **outside `native/`** on purpose: it composes core session-log
parsers with host display cleaners, and the host-free structural pin bans
value-importing host services from every production file under `native/`
(the `native-host-adapters.ts` precedent). Neither structural pin is relaxed.

### Builder decisions (spec D1–D5)

- **D1 — `?dir=` scope is exact `header.cwd` match.** No per-row git probing
  (cost; unknown rows have no meta to read a worktree field from). A native
  session whose cwd is a worktree appears only under "All projects"; the claude
  SDK's git-aware worktree grouping is deliberately not replicated.
- **D2 — the log title maps to `title`, not `customTitle`.** Native has no
  external renamer; the only writer is the app mirror. Manager precedence
  (`customTitle ?? live.title ?? meta.title`) keeps the store title
  authoritative for known sessions (correct when a best-effort mirror write
  failed), and the log title surfaces only for unknown (recovered) rows,
  riding adoption into the recovered meta.
- **D3 — one selective full pass, not head+tail windows.** Title events sit
  anywhere in the log, so a single pass serves all four facts: O(bytes) read
  + O(hits) parse. Cold "All projects" cost is honest and bounded by
  concurrency plus the row cache.
- **D4 — the listing module is host-side, outside `native/`.**
  `ResumableSession` and the display cleaners are host vocabulary; the
  host-free pin decides the placement, not preference.
- **D5 — in-memory row cache only.** The picker refetches on open; there is no
  live projection-feed requirement. Durable checkpoints would buy zero-IO
  cold reads at the price of a permanent lifecycle/versioning surface —
  disproportionate for one listing feature.

### Picker and client parity

`NativeProvider.listResumable` maps scan rows into `ResumableSession`;
`known`/`running`/`terminated` stay false and `provider` unset (the manager
annotates and defaults them). The unknown-row badge in
`ResumeSessionDialog.tsx` is provider-aware: `provider === 'native'` renders
`native`, otherwise the existing `CLI` wording — a recovered native row must
not read "CLI". `getSessionInfo` unlocks, all through the existing seam:
re-adoption after ordinary delete, recovery from `sessions.json` loss, and the
permanent-delete rollback restore branch.

## Alternatives considered

- **Title sidecar (`<id>/title.json`).** Would preserve head+tail lightweight
  reads and touch no log format; permanent delete already removes the
  directory. Rejected: a second durable artifact with its own fork/clear
  lifecycle pins, diverging from DSH's validated log-event semantics. The log
  is the durable unit that survives ordinary delete; keeping the title in it
  keeps one source of truth.
- **Full-parse enumeration through `nativeHistoryCache`.** Rejected: the
  4-entry LRU thrashes on enumeration and evicts hot-session entries — opening
  the picker would slow the next history page of the active session — and
  every row pays full validation cost per cold open.
- **Port DSH's projection registry + durable checkpoint cache.** Rejected for
  now: it presupposes one canonical event language, and this codebase
  deliberately keeps two (SDK `AgentMessage` + neutral `SessionEvent`) with
  translation at the provider seam, so a cross-provider registry fights the
  seam design; the drive point is already centralized (client reducer /
  server pump); transcript rewrites (evict/prepend/repair/rewind) break the
  append-only drive assumption the registry relies on; and the
  dynamic-registration / version-sharing / upgrade-fixture machinery solves
  plugin-hot-plug scale this app does not have. **Revisit trigger:** if
  native's per-open read-consumer scans keep multiplying, consolidate into a
  native-specific per-session read-model (one pass folds K values, extending
  the incremental subagent-catalog pattern) — not a generic framework.
- **Accept title loss (firstPrompt label on recovery).** Rejected: breaks the
  recoverable-delete parity the deletion contract requires.

## Consequences

The recoverable-delete contract holds end-to-end for native, including the
auto-title common path: ordinary delete → picker row carrying the title →
`allowAdopt` resume → recovered native session with the title in the store.
`sessions.json` loss and the permanent-delete rollback restore native
sessions, and a native-only host has a working picker. The title has one
durable home (the log), with the store as the authoritative live copy.

What it costs: a cold "All projects" open reads O(total log bytes) — mitigated
by 16-concurrency and the stat-keyed row cache, honest parity with the claude
picker's heaviness at scale. The prefilter couples to the writer's compact
`JSON.stringify` serialization; a round-trip test through the real writer
pins it. A recovered fork shows the inherited source title until renamed, and
clear-title-then-delete surfaces the stale title (both DSH/claude-accepted).
Worktree-cwd sessions are invisible under the main repo's dir scope (D1).

## Testing

`server/providers/native-resumable-listing.test.ts` pins the scan (writer
round-trip, prefilter, seq counting, torn tail, cache freshness/invalidation,
per-row fail-soft, dir scope). The `native resumable discovery through
SessionManager` suite in `server/providers/native/e2e-persistence.test.ts`
drives picker parity, manual-rename and auto-title recovery through ordinary
delete + `allowAdopt`, permanent delete removing row and log, and the
automatic-path adoption guard. Vocabulary, format, log, and host-adapter tests
pin the event's non-renderability, the single-writer append path, the
no-overwrite guard in both race orderings, and fork/clear title semantics.
The injection-class verification (spec builder note) found native has no
user-role XML injection producers; compact seeds carry `isCompactSummary`
and task notifications are operational frames, so the shared preview
eligibility predicates cover every native injection class without extension.
