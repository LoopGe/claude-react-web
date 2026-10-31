/** Transcript log owner: the ordered render log (items / messages /
 *  activeWorktree) and the seq-window handlers that drive fresh messages into
 *  it.
 *
 *  The mirror fields this module owns (per the reducer-state-owners design):
 *    - `items` / `messages` — the ordered transcript rows and their backing
 *      messages, kept in lockstep with `mirror.window` by construction.
 *    - `activeWorktree` — the Enter/Exit worktree fold, maintained
 *      incrementally on the append path (`foldActiveWorktree`) and rescanned
 *      on every other path that rewrites `messages` (prepend / trim / evict /
 *      chronology repair / stale-copy replace).
 *    - `pendingConsumedMessages` — the message-consumed signals that arrived
 *      before their matching user-message broadcast. Co-owned with the
 *      message-pipeline (Task 7); this module prunes the entries on evict.
 *
 *  The WINDOW_* handlers (`windowLive` / `windowPage` / `windowEvict`) run
 *  their pure seq-window operator first, then apply the messages that are NEW
 *  to the window (freshly inserted seqs + pending runs that just drained) to
 *  the ordered log through the message-pipeline's `applyMessage` /
 *  `prependMessages` machinery. This keeps `mirror.messages` / `mirror.items`
 *  in lockstep with the window by construction — the UI reducer branches
 *  (subagent pairing, task folding, plan cards, permission state) consume
 *  only the ordered log and stay seq-agnostic.
 *
 *  `prependMessages` is also exported for the replay-merge path (Task 8) and
 *  for the reducer's `replayReplace` (until Task 8 extracts it). It supports
 *  two dedup modes:
 *    - `trustUuidDedup: true` — uuid-exact dedup for same-seq-space batches
 *      (tail-first replay backfill, WINDOW_PAGE at:'head'). The signature
 *      overlap check is skipped because the live stream and the REST page
 *      share one uuid space.
 *    - default — uuid dedup PLUS content-signature dedup for top-level user
 *      prompts, whose server-minted in-memory uuid differs from the on-disk
 *      SDK uuid. The signature check matches the batch's trailing prompt run
 *      against the on-screen leading prompt run element-wise from the
 *      boundary inward, so a genuinely-older same-text prompt is preserved.
 *
 *  `trimFront` and `evictMessages` both delegate index-map pruning to
 *  `pruneIndexesToLive` (index-pipeline) — they never directly write the
 *  toolUseId-keyed lifecycle maps. `trimFront` soft-prunes sidechain records
 *  (in-flight records survive a front-trim); `evictMessages` hard-prunes
 *  (a retracted leg's records must go even if still in-flight).
 *
 *  `updateTranscriptMirror` is the single append site for the ordered log.
 *  It folds just the new message into `activeWorktree` (O(its blocks));
 *  every other path that rewrites `messages` rescans with
 *  `recomputeActiveWorktree`. */

import type { SdkMessage } from '../types'
import {
  type ServerMirror,
  type SessionAction,
  type SessionState,
  type TranscriptItem,
  withMirror,
} from './types'
import {
  foldActiveWorktree,
  isTrimBoundary,
  messageTouchesWorktree,
  recomputeActiveWorktree,
  toTranscriptItem,
  topLevelUserPromptSignature,
} from './normalize'
import {
  evictSeqs,
  liveAppend,
  pageLoaded,
  type WindowState,
} from './seq-window'
import {
  collectLiveToolUseIds,
  pruneIndexesToLive,
  rebuildIndexesFromMessages,
} from './index-pipeline'
// applyMessage lives in message-pipeline.ts (Task 7 extracted it from the
// reducer). The WINDOW_* handlers call it at runtime to apply freshly-windowed
// messages to the ordered log. The import is a live ESM binding; applyMessage
// is a hoisted function declaration, so the circular reference
// (message-pipeline ↔ transcript-log) resolves at runtime — the call sites
// never fire at module-init. This is the cycle Task 7 deliberately moved off
// reducer.ts: neither module imports reducer.ts (the "no business module
// imports reducer.ts" end state).
import { applyMessage } from './message-pipeline'

// MEMORY_ITEM_CAP — the in-memory transcript bound. Re-exported by the
// reducer so existing importers (`active-worktree.test.ts`) keep resolving.
export const MEMORY_ITEM_CAP = 1000
// Hysteresis: only trim once we exceed CAP + SLACK, then drop back to CAP. So
// trimming runs once every SLACK appends (not every message), keeping the
// common append path allocation-free.
const MEMORY_TRIM_SLACK = 256

// ── WINDOW handlers ─────────────────────────────────────────────────────────
//
// Every WINDOW_* action runs its pure seq-window operator first, then applies
// the messages that are NEW to the window (freshly inserted seqs + pending
// runs that just drained) to the ordered render log through the existing
// applyMessage / prependMessages machinery. This keeps `mirror.messages` /
// `mirror.items` in lockstep with the window by construction — the UI reducer
// branches (subagent pairing, task folding, plan cards, permission state)
// consume only the ordered log and stay seq-agnostic.

/** Messages now held by `nw` but not by `prev`, ordered by seq. These are
 *  exactly the frames the transcript hasn't applied yet: a prev-window seq
 *  means applyMessage already ran for it; prev-pending seqs drained into
 *  `nw` are fresh (they were parked, never applied). */
function freshWindowMessages(
  prev: WindowState,
  nw: WindowState,
): Array<[number, SdkMessage]> {
  const out: Array<[number, SdkMessage]> = []
  for (const [seq, msg] of nw.window) {
    if (!prev.window.has(seq)) out.push([seq, msg])
  }
  out.sort((a, b) => a[0] - b[0])
  return out
}

/** WINDOW_LIVE: a seq-carrying live message frame. Contiguous seqs append
 *  at the tail; gapped seqs park in the window (hole exposed via snapshot)
 *  and are applied — in seq order — when the hole fills. The new window is
 *  attached BEFORE the fresh messages run so trimFront/eviction inside
 *  applyMessage sync the window they'll actually survive into. */
export function windowLive(
  state: SessionState,
  seq: number,
  generation: number,
  message: SdkMessage,
): SessionState {
  const prev = state.mirror.window
  const nw = liveAppend(prev, seq, message, generation)
  if (nw === prev) return state
  let next = withMirror(state, { ...state.mirror, window: nw })
  for (const [, msg] of freshWindowMessages(prev, nw)) {
    next = applyMessage(next, msg)
  }
  return next
}

/** WINDOW_PAGE: a REST page from GET /sessions/:id/messages. Tail pages
 *  (the newest page, a reconnect catch-up, or a hole fill) append in seq
 *  order and flip replayReady — the tail page IS the transcript's initial
 *  paint in the seq protocol. Head pages prepend below oldestSeq via
 *  prependMessages (uuid dedup is exact: the REST page and the live stream
 *  share one seq space, so the prompt-signature overlap check is skipped —
 *  the same reasoning as tail-first backfill chunks' trustUuidDedup). */
export function windowPage(
  state: SessionState,
  action: Extract<SessionAction, { type: 'WINDOW_PAGE' }>,
): SessionState {
  const prev = state.mirror.window
  const nw = pageLoaded(prev, {
    at: action.at,
    messages: action.messages,
    hasMore: action.hasMore,
    generation: action.generation,
    headSeq: action.headSeq,
    tombstones: action.tombstones,
  })
  if (nw === prev) return state
  const fresh = freshWindowMessages(prev, nw)
  let next = withMirror(state, { ...state.mirror, window: nw })
  if (action.at === 'head') {
    if (fresh.length === 0) return next
    return prependMessages(
      next,
      fresh.map(([, msg]) => msg),
      { trustUuidDedup: true },
    )
  }
  for (const [, msg] of fresh) {
    next = applyMessage(next, msg)
  }
  return withMirror(next, { ...next.mirror, replayReady: true })
}

/** WINDOW_EVICT: server tombstones by seq. Maps the seqs to their uuids
 *  (from the PRE-eviction window) and reuses evictMessages — which also
 *  syncs the window — so the ordered log and lifecycle-map pruning stay
 *  identical to the uuid-based path. */
export function windowEvict(state: SessionState, seqs: number[]): SessionState {
  const prev = state.mirror.window
  const nw = evictSeqs(prev, seqs)
  if (nw === prev) return state
  const uuids = new Set<string>()
  for (const seq of seqs) {
    const msg = prev.window.get(seq) ?? prev.pending.get(seq)
    const u = msg ? (msg as { uuid?: unknown }).uuid : undefined
    if (typeof u === 'string' && u.length > 0) uuids.add(u)
  }
  // Attach the evicted window FIRST: evictMessages' internal window sync
  // (seqsForUuids + evictSeqs) then finds the seqs already deleted and
  // no-ops, instead of computing a second window from `prev` that the
  // overwrite below would discard. Its uuid pruning (items/messages,
  // toolUseId lifecycle maps) still runs on the attached state.
  let next = withMirror(state, { ...state.mirror, window: nw })
  if (uuids.size > 0) next = evictMessages(next, Array.from(uuids))
  // Recording tombstones can DRAIN parked frames: the interrupt/withdraw
  // race lands the result (seq N+1) while the steer (seq N) is still
  // missing — it parks — and the late messages-evicted [N] then tombstones
  // the hole and moves the parked result into the window. Those drained
  // frames are fresh (never applied — see freshWindowMessages) and MUST
  // reach the ordered log, or a stranded `result` never clears liveTurn
  // (the stuck WorkingBubble). Same attach-before-apply ordering as
  // windowLive: applyMessage's internal trim/eviction must sync the
  // window the frames actually survive into.
  for (const [, msg] of freshWindowMessages(prev, nw)) {
    next = applyMessage(next, msg)
  }
  return next
}

// ── prependMessages ─────────────────────────────────────────────────────────
//
// Moved from reducer.ts. Prepend a chronological batch of older messages
// (loaded from disk on scroll-up, or a head page via WINDOW_PAGE at:'head')
// ahead of the current transcript.

/** Prepend a chronological batch of older messages (loaded from disk on
 *  scroll-up) ahead of the current transcript.
 *
 *  Correctness notes:
 *   - Dedup by uuid: a message already present (e.g. the boundary message
 *     the frontend used as its paging cursor, or overlap after a reconnect)
 *     is skipped so we never render it twice.
 *   - Content dedup for TOP-LEVEL USER PROMPTS: these can't be deduped by
 *     uuid because the server mints a fresh uuid for the in-memory copy
 *     while the pump drops the SDK's echo, so the on-disk copy carries a
 *     different (SDK) uuid (see topLevelUserPromptSignature). Paging anchors
 *     on the first disk-stable item (assistant/system) and reads strictly
 *     before it, so the disk page's TRAILING prompt run is exactly the
 *     on-screen LEADING prompt run — the same logical messages. We match
 *     those two runs element-wise from the boundary inward and drop the
 *     overlap, so a genuinely-older but textually-identical prompt further
 *     back is still preserved.
 *   - We build TranscriptItems for the older batch in order, threading the
 *     `prev` item so compact-summary detection (which looks at the previous
 *     item) works within the batch. The last older item becomes `prev` for
 *     the FIRST existing item — but we deliberately do NOT recompute the
 *     existing items: their isCompactSummary was already settled when they
 *     first arrived, and the only cross-boundary case (an existing first
 *     item that is a user message immediately after a compact_boundary we
 *     just prepended) is vanishingly rare and self-heals on next replay.
 *   - Indexes (toolStatus/planStatus/…) are updated by running ONLY the
 *     older batch through rebuildIndexesFromMessages — NOT a full rebuild. A
 *     full rebuild would clobber statuses that were set out-of-band (e.g. an
 *     ExitPlanMode plan flipped to 'approved' via PERMISSION_RESOLVED without
 *     a tool_result). The older batch's ids are disjoint from the live tail,
 *     so additive indexing is both sufficient and non-destructive. */
export function prependMessages(
  state: SessionState,
  older: SdkMessage[],
  opts?: { trustUuidDedup?: boolean },
): SessionState {
  if (older.length === 0) return state
  const mirror = state.mirror

  const existingIds = new Set<string>()
  for (const it of mirror.items) existingIds.add(it.id)

  // How many trailing prompts of the incoming disk batch are the SAME
  // logical messages as the leading prompts already on screen (the uuid
  // boundary that uuid-dedup can't bridge — see the doc comment). Match the
  // batch's trailing prompt run against the on-screen leading prompt run
  // element-wise, from the boundary inward, by content signature.
  // Skipped entirely for same-uuid-space batches (tail-first replay
  // backfill / WINDOW_PAGE at:'head'): uuid dedup is exact there, and the
  // signature check would false-drop a distinct older prompt whose text
  // repeats across the chunk boundary.
  const overlap = opts?.trustUuidDedup ? 0 : countPromptOverlap(older, mirror.items)
  const batch = overlap > 0 ? older.slice(0, older.length - overlap) : older

  const newItems: TranscriptItem[] = []
  const newMessages: SdkMessage[] = []
  let prev: TranscriptItem | undefined = undefined
  for (const msg of batch) {
    const uuid = typeof msg.uuid === 'string' ? msg.uuid : null
    if (uuid && existingIds.has(uuid)) continue
    const item = toTranscriptItem(msg, prev)
    if (!item) continue
    newItems.push(item)
    newMessages.push(item.msg)
    existingIds.add(item.id)
    prev = item
  }

  if (newItems.length === 0) return state

  const messages = [...newMessages, ...mirror.messages]
  let next: SessionState = withMirror(state, {
    ...mirror,
    items: [...newItems, ...mirror.items],
    messages,
    // Older frames only decide the state when nothing after them touches a
    // worktree — not knowable from the current value alone, so rescan.
    activeWorktree: recomputeActiveWorktree(mirror.activeWorktree, messages),
  })
  // Additive index update over just the prepended batch.
  next = rebuildIndexesFromMessages(next, newMessages)
  return next
}

/** Count how many trailing top-level user prompts of an incoming disk page
 *  (`older`) are the same logical messages as the leading top-level prompts
 *  already on screen (`items`).
 *
 *  Paging anchors on the first disk-stable message (assistant/system) and
 *  reads strictly before it, so the user prompts shown ABOVE that anchor are
 *  re-returned at the END of the disk page — the prompt closest to the
 *  anchor is `older[last]` on disk and the last item of the on-screen
 *  leading run in memory. Those prompts carry different uuids on disk vs in
 *  memory (server-minted vs SDK), so we compare by content signature.
 *
 *  Both runs are anchored at the boundary and grow AWAY from it in opposite
 *  array directions, so we must align them boundary-first: find the length
 *  of the on-screen leading prompt run, then walk inward from the anchor —
 *  `older[last-n]` against `items[K-1-n]`. Stop at the first mismatch (or a
 *  non-prompt on the batch side), so an older but textually-identical prompt
 *  further back in history is never falsely dropped. */
function countPromptOverlap(older: SdkMessage[], items: ServerMirror['items']): number {
  // Length of the contiguous top-level-prompt run at the START of the
  // on-screen transcript (i.e. the prompts sitting above the paging anchor).
  //
  // The type gate is checked BEFORE touching `.plainText`: plainText is a lazy
  // getter (see toTranscriptItem) and reading it forces the markdown
  // extraction. This loop's exit condition is precisely the first item that is
  // NOT a top-level prompt — the one item we must never pay for — and passing
  // `items[leadRun].plainText` as a plain argument would evaluate it first.
  const isTopLevelPrompt = (m: SdkMessage) => m.type === 'user' && m.parent_tool_use_id == null
  let leadRun = 0
  while (leadRun < items.length && isTopLevelPrompt(items[leadRun]!.msg)) {
    leadRun++
  }
  let n = 0
  while (n < older.length && n < leadRun) {
    const batchSig = topLevelUserPromptSignature(older[older.length - 1 - n])
    if (batchSig == null) break // batch tail is no longer a top-level prompt
    // items[leadRun - 1 - n] is within the leading run, so its signature is
    // guaranteed non-null — only the content needs to match. Pass the cached
    // plainText to skip re-extraction through the markdown pipeline.
    if (batchSig !== topLevelUserPromptSignature(items[leadRun - 1 - n].msg, items[leadRun - 1 - n].plainText)) break
    n++
  }
  return n
}

// ── trimFront ───────────────────────────────────────────────────────────────
//
// Moved from reducer.ts. Front-trim the in-memory transcript once it exceeds
// MEMORY_ITEM_CAP + MEMORY_TRIM_SLACK, bringing it back down to ~CAP.

/** Drop the oldest items/messages once the in-memory transcript exceeds
 *  MEMORY_ITEM_CAP + MEMORY_TRIM_SLACK, bringing it back down to ~CAP.
 *
 *  The cut point is snapped FORWARD to the first isTrimBoundary message so the
 *  new items[0] is both on-disk AND not a plain top-level user prompt. This
 *  matters for two downstream consumers:
 *    - loadOlder()'s first page anchors `beforeUuid` on items[0]. That uuid
 *      MUST exist on disk, or the server falls back to the newest page and
 *      reverse-paging silently stalls. isTrimBoundary guarantees a persisted
 *      frame — see its doc comment in normalize.ts.
 *    - countPromptOverlap() dedups the leading user-prompt run against an
 *      incoming disk page by content signature (uuids differ disk vs memory).
 *      A non-empty leading prompt run after a trim could resurface as
 *      duplicates on the next loadOlder; an empty run (overlap 0) cannot.
 *
 *  Snapping past a long sidechain (subagent) run can keep somewhat fewer than
 *  CAP — acceptable, and bounded because every real turn ends with a
 *  main-thread assistant frame.
 *
 *  The toolUseId-keyed lifecycle maps (toolStatus, toolResults, planStatus,
 *  planContent, questionAnswers, activeSubagents, activeWorkflows,
 *  activeSkills) are pruned to ids still referenced by the retained items so
 *  they don't leak. `activeSubagents` used to be skipped here on the belief
 *  that "it clears each result frame" — false: sweepAtTurnEnd only flips
 *  status, never deletes, so a long-lived tab accumulated every Agent launch
 *  it had ever seen and one stranded `running`/`pending` record made
 *  SubagentSwarm.oldestStart paint a multi-dozen-hour timer. */
export function trimFront(state: SessionState): SessionState {
  const mirror = state.mirror
  if (mirror.items.length <= MEMORY_ITEM_CAP + MEMORY_TRIM_SLACK) return state
  const beforeLen = mirror.items.length
  let cut = mirror.items.length - MEMORY_ITEM_CAP
  // Snap forward to the first disk-persisted boundary at or after `cut`.
  while (cut < mirror.items.length && !isTrimBoundary(mirror.items[cut].msg)) cut++
  // No safe boundary in the trim zone (pathological — e.g. an unbroken run of
  // plain prompts / sidechain frames). Skip this round rather than cut at an
  // unsafe point that would break reverse-paging.
  if (cut >= mirror.items.length) return state

  const items = mirror.items.slice(cut)
  const messages = mirror.messages.slice(cut)
  console.warn(`[trimFront] Trimmed ${cut} items (${beforeLen} → ${items.length})`)
  const live = collectLiveToolUseIds(items)
  const retained = new Set(items.map((it) => it.id))
  // Front-trimmed rows leave the seq window too — the window is the seq
  // view of what the ordered log holds, so oldestSeq must track items[0].
  const trimmedUuids = new Set<string>()
  for (const m of mirror.messages.slice(0, cut)) {
    if (typeof m.uuid === 'string') trimmedUuids.add(m.uuid)
  }
  const trimmedSeqs = seqsForUuids(mirror.window, trimmedUuids)
  // `tombstone: false` — trimFront is a client-side memory trim of OLD rows
  // the server still holds (loadOlder can refetch them); recording them
  // would poison the tombstone set with live seqs.
  const window =
    trimmedSeqs.length > 0
      ? evictSeqs(mirror.window, trimmedSeqs, { tombstone: false })
      : mirror.window
  // Unified index-map pruning (index-pipeline.ts): soft-prune the sidechain
  // maps so in-flight records survive a front-trim.
  const pruned = pruneIndexesToLive(mirror, live, retained)
  return withMirror(state, {
    ...pruned,
    items,
    messages,
    window,
    // Rescan the retained window (once per MEMORY_TRIM_SLACK appends): the
    // Enter that set the current value may be among the dropped frames.
    activeWorktree: recomputeActiveWorktree(mirror.activeWorktree, messages),
  })
}

// ── evictMessages ───────────────────────────────────────────────────────────
//
// Moved from reducer.ts. Remove the given uuids from the transcript
// (refusal-fallback retraction, dialog-resolved eviction).

/** Remove the given uuids from the transcript (refusal-fallback retraction:
 *  the CLI already-streamed partial messages of the refused leg). Mirrors
 *  trimFront's index pruning — after items/messages shrink, every
 *  toolUseId-keyed map entry whose owner frame was evicted is dropped so no
 *  orphan tool/plan/question card lingers.
 *
 *  Identity-stable when no listed uuid is present (late/duplicate
 *  dialog-resolved frames are a no-op). */
export function evictMessages(state: SessionState, uuids: string[]): SessionState {
  if (!uuids?.length) return state
  const mirror = state.mirror
  const uuidSet = new Set(uuids)
  const items = mirror.items.filter((it) => !uuidSet.has(it.id))
  if (items.length === mirror.items.length) return state
  const messages = mirror.messages.filter(
    (m) => !uuidSet.has((m as { uuid?: string }).uuid ?? ''),
  )
  // Keep the seq window in lockstep: drop every seq the evicted uuids map
  // to (window + pending) so the boundaries stay honest.
  const evictedSeqs = seqsForUuids(mirror.window, uuidSet)
  const window = evictedSeqs.length > 0 ? evictSeqs(mirror.window, evictedSeqs) : mirror.window
  // Clear the consumed-timestamp cache for evicted user turns too.
  const pendingConsumedMessages = new Map(mirror.pendingConsumedMessages)
  for (const [uuid] of pendingConsumedMessages) {
    if (uuidSet.has(uuid)) pendingConsumedMessages.delete(uuid)
  }
  const live = collectLiveToolUseIds(items)
  const retained = new Set(items.map((it) => it.id))
  // Unified index-map pruning (index-pipeline.ts) with HARD sidechain prune:
  // a retracted leg's records must go even if they were still in-flight — the
  // frames that owned them no longer exist (unlike trimFront's soft sidechain
  // prune, which preserves in-flight records).
  const pruned = pruneIndexesToLive(mirror, live, retained, { hardSidechain: true })
  return withMirror(state, {
    ...pruned,
    items,
    messages,
    window,
    activeWorktree: recomputeActiveWorktree(mirror.activeWorktree, messages),
    pendingConsumedMessages,
  })
}

// ── updateTranscriptMirror ──────────────────────────────────────────────────
//
// Moved from reducer.ts. The single append site for the ordered log.

/** Append one message to the ordered log: derive its TranscriptItem (threading
 *  the previous item so compact-summary detection works), append to both
 *  items and messages, and fold just the new message into activeWorktree
 *  (O(its blocks)). The one append site — every other path that rewrites
 *  `messages` rescans with recomputeActiveWorktree. */
export function updateTranscriptMirror(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  const prev = mirror.items[mirror.items.length - 1]
  const item = toTranscriptItem(message, prev)
  if (!item) return mirror

  return {
    ...mirror,
    items: [...mirror.items, item],
    messages: [...mirror.messages, item.msg],
    // The one append site: fold just the new message (O(its blocks)) — see
    // ServerMirror.activeWorktree for the invariant every other path keeps.
    activeWorktree: foldActiveWorktree(mirror.activeWorktree, item.msg),
  }
}

// ── seq/uuid helpers ────────────────────────────────────────────────────────

/** Seqs currently held by the window (window or pending) for any of the
 *  given message uuids. Used to keep the seq window in sync with uuid-based
 *  evictions and front-trims — the window must never hold a seq whose
 *  message the ordered log no longer does, or oldestSeq/newestSeq would
 *  describe content the transcript doesn't render (and Task 9's
 *  firstItemIndex anchor would drift off items[0]). The one sanctioned
 *  exception is slot-routed frames (api_retry slot, empty results), which
 *  sit in the window for dedup but are skipped by oldestSeq's derivation —
 *  see seq-window.ts isSlotRouted. */
function seqsForUuids(w: WindowState, uuids: ReadonlySet<string>): number[] {
  const out: number[] = []
  for (const [seq, msg] of w.window) {
    const u = (msg as { uuid?: unknown }).uuid
    if (typeof u === 'string' && uuids.has(u)) out.push(seq)
  }
  for (const [seq, msg] of w.pending) {
    const u = (msg as { uuid?: unknown }).uuid
    if (typeof u === 'string' && uuids.has(u)) out.push(seq)
  }
  return out
}

// `applyMessage` lives in message-pipeline.ts (Task 7); `dedupeReplayPayload`,
// `splitReplayAgainstCache`, `replayReplace`, `replaceStaleCachedMessages`,
// `applyMidSlice`, `repairChronology`, `overlapAnchorUuid`,
// `partitionNoOverlapByTime`, `promptSequencesEqual`, and the shape-compare
// helpers stay in reducer.ts — they belong to the replay-merge owner (Task 8).

// ── stampMessageConsumed / stampMessageSteered ──────────────────────────────
//
// Mirror-only consumed/steered stamps extracted from the reducer's
// applyMessageConsumed / applyMessageSteered (Task 7). The intent-side
// concerns (placeholder re-derivation, ack re-keying) live in
// user-message-lifecycle.ts, which delegates the mirror writes here. This
// keeps the dependency direction one-way: user-message-lifecycle →
// transcript-log (transcript-log never calls back into lifecycle).

/** Cap on the pendingConsumedMessages map. Matches the historical reducer
 *  constant — a transient parking lot for consumed signals that arrived
 *  before their matching user-message broadcast. The map is FIFO-evicted
 *  past this cap so a runaway producer can't grow it unboundedly. */
const PENDING_CONSUMED_CAP = 64

/** Bounded insert into the pendingConsumedMessages map: keeps the oldest
 *  entries and drops the oldest once the cap is exceeded. */
function rememberPendingConsumed(
  pending: ReadonlyMap<string, number>,
  uuid: string,
  consumedAt: number,
): Map<string, number> {
  const next = new Map(pending)
  next.set(uuid, consumedAt)
  while (next.size > PENDING_CONSUMED_CAP) {
    const oldest = next.keys().next().value
    if (typeof oldest !== 'string') break
    next.delete(oldest)
  }
  return next
}

/** Mirror-only consumed stamp: flips the matching item's deliveryStatus to
 *  'consumed', stamps msg.consumedAt, syncs the parallel `messages` array,
 *  prunes the pendingConsumedMessages entry for this uuid, and rescans
 *  activeWorktree when either side touches a worktree.
 *
 *  When the uuid is NOT in mirror.items (the message broadcast hasn't landed
 *  yet), the consumed signal parks in `pendingConsumedMessages` instead —
 *  the later broadcast's `effectiveConsumedAt` (message-pipeline) forwards
 *  it onto the appended item. Identity-stable when the signal is already
 *  parked with the same value, or when the on-screen item is already
 *  consumed.
 *
 *  The intent placeholder path (consumed signal for a placeholder that
 *  hasn't been acked yet) is owned by user-message-lifecycle.applyMessageConsumed
 *  — it must NOT call this function while the placeholder still lives in
 *  intent. This function only handles the mirror side. */
export function stampMessageConsumed(
  mirror: ServerMirror,
  uuid: string,
  consumedAt: number,
): ServerMirror {
  const idx = mirror.items.findIndex((it) => it.id === uuid)
  if (idx < 0) {
    // Item not yet on screen. Park the signal; the broadcast will pick it up.
    if (mirror.pendingConsumedMessages.get(uuid) === consumedAt) return mirror
    const pendingConsumedMessages = rememberPendingConsumed(
      mirror.pendingConsumedMessages,
      uuid,
      consumedAt,
    )
    return { ...mirror, pendingConsumedMessages }
  }
  const item = mirror.items[idx]
  if (item.deliveryStatus === 'consumed') return mirror
  // Stamp the underlying message so a later re-derivation (and any code
  // reading msg.consumedAt directly) agrees. Build a new msg object rather
  // than mutating the cached one, keeping the store's items immutable.
  const nextMsg: SdkMessage = { ...item.msg, consumedAt }
  const items = mirror.items.slice()
  items[idx] = { ...item, msg: nextMsg, deliveryStatus: 'consumed' }
  // Keep the parallel `messages` array's object reference in sync so a
  // later REPLAY/PREPEND that reads msg.consumedAt is consistent.
  const mIdx = mirror.messages.findIndex(
    (m) => (typeof m.uuid === 'string' ? m.uuid : null) === uuid,
  )
  const messages = mIdx >= 0 ? mirror.messages.slice() : mirror.messages
  // The swapped-in copy only differs by `consumedAt`, but it is built from the
  // ITEM's msg, which need not be the very object `messages[mIdx]` held — so
  // rescan whenever either side touches a worktree (O(1) otherwise).
  const worktreeTouched = mIdx >= 0 &&
    (messageTouchesWorktree(mirror.messages[mIdx]) || messageTouchesWorktree(nextMsg))
  if (mIdx >= 0) messages[mIdx] = nextMsg
  let pendingConsumedMessages: ReadonlyMap<string, number> = mirror.pendingConsumedMessages
  if (pendingConsumedMessages.has(uuid)) {
    const nextConsumedMessages = new Map(pendingConsumedMessages)
    nextConsumedMessages.delete(uuid)
    pendingConsumedMessages = nextConsumedMessages
  }
  return {
    ...mirror,
    items,
    messages,
    pendingConsumedMessages,
    activeWorktree: worktreeTouched
      ? recomputeActiveWorktree(mirror.activeWorktree, messages)
      : mirror.activeWorktree,
  }
}

/** Mirror-only steered stamp: stamps `injectedAt` (state='injected') or
 *  `requeuedAt` (state='requeued') on the matching item's msg, flips
 *  deliveryStatus accordingly, syncs the parallel `messages` array, and
 *  rescans activeWorktree when either side touches a worktree.
 *
 *  Simpler than stampMessageConsumed: the initial broadcast carries
 *  steeredAt (the 'injecting' state never arrives via this action), and the
 *  injected / requeued frames are pushed strictly after the broadcast, so the
 *  item is always present — a miss is a harmless no-op (replay's ring stamps
 *  are the durable truth). 'requeued' falls through to the queued→consumed
 *  flow: the msg keeps its stamps and deriveDeliveryStatus skips the steered
 *  branch once requeuedAt is present. */
export function stampMessageSteered(
  mirror: ServerMirror,
  uuid: string,
  steerState: 'injected' | 'requeued',
): ServerMirror {
  const idx = mirror.items.findIndex((it) => it.id === uuid)
  if (idx < 0) return mirror
  const item = mirror.items[idx]
  const stamp = steerState === 'injected' ? { injectedAt: Date.now() } : { requeuedAt: Date.now() }
  if (steerState === 'injected' && item.deliveryStatus === 'injected') return mirror
  const nextMsg: SdkMessage = { ...item.msg, ...stamp }
  const items = mirror.items.slice()
  items[idx] = {
    ...item,
    msg: nextMsg,
    deliveryStatus: steerState === 'injected' ? 'injected' : 'queued',
  }
  const mIdx = mirror.messages.findIndex(
    (m) => (typeof m.uuid === 'string' ? m.uuid : null) === uuid,
  )
  // Same rule as stampMessageConsumed: only slice when we'll actually swap an
  // entry (mIdx >= 0); otherwise preserve the original reference so a
  // messages/items invariant violation doesn't trigger spurious store emits.
  const messages = mIdx >= 0 ? mirror.messages.slice() : mirror.messages
  // Same rule as stampMessageConsumed: the swapped-in copy is built from the
  // ITEM's msg, so rescan only if either side touches a worktree.
  const worktreeTouched = mIdx >= 0 &&
    (messageTouchesWorktree(mirror.messages[mIdx]) || messageTouchesWorktree(nextMsg))
  if (mIdx >= 0) messages[mIdx] = nextMsg
  return {
    ...mirror,
    items,
    messages,
    activeWorktree: worktreeTouched
      ? recomputeActiveWorktree(mirror.activeWorktree, messages)
      : mirror.activeWorktree,
  }
}
