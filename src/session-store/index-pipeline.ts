/** Index pipeline owner: composes the tool-index fold, the sidechain-index
 *  fold, and the order-insensitivity parking (`pendingResults`) that sits
 *  between and after them. Plus the rebuild-from-messages entry point and the
 *  unified index-map pruning.
 *
 *  The mirror fields this module owns (per the reducer-state-owners design):
 *  `pendingResults` — the parked completion-signal messages whose owning
 *  tool_use has not arrived yet. The tool/plan/question/sidechain lifecycle
 *  maps are owned by tool-index.ts and sidechain-index.ts respectively; this
 *  module COMPOSES those two folds and adds the parking layer on top.
 *
 *  `updateIndexesMirror` is the coordinator extracted from the reducer. It
 *  runs `updateToolIndexMirror` (tool/plan/question), then
 *  `updateSidechainIndexMirror` (subagent/workflow/skill), then the parking
 *  pass. The order matters: the parking pass reads all six lifecycle maps to
 *  decide whether a completion signal is already settled (and thus not worth
 *  parking) — so both folds must run first.
 *
 *  `drainPendingResults` re-applies parked results through the index branches
 *  at the end of a batch fold (and after each live message). Identity-stable
 *  when nothing is parked.
 *
 *  `rebuildIndexesFromMessages` is the hydrate entry point: folds a batch of
 *  cached messages through `updateIndexesMirror`, re-applies client-side
 *  dismissals, then drains parked results. It must NOT touch items/messages/
 *  liveTurn — those are the transcript layer's responsibility.
 *
 *  `pruneIndexesToLive` is the unified index-map pruning extracted from the
 *  reducer's trimFront and evictMessages. Both callers compute the `live`
 *  toolUseId set and `retained` uuid set, then call this single function to
 *  prune every lifecycle map in one shot. */

import type { SdkMessage } from '../types'
import type { ServerMirror, SessionState } from './types'
import { withMirror } from './types'
import {
  getPlanToolUseIds,
  getSkillStarts,
  getSubagentStarts,
  getToolResultIds,
  getToolUseStarts,
  getWorkflowStarts,
  parseTaskNotification,
} from './normalize'
import { getQuestionToolUseIds } from '../utils/question-answers'
import { updateToolIndexMirror } from './tool-index'
import { updateSidechainIndexMirror, reapplyDismissed } from './sidechain-index'

// ── updateIndexesMirror ─────────────────────────────────────────────────────
// Composed fold: tool-index → sidechain-index → parking. Extracted from the
// reducer's `updateIndexesMirror`. The tool fold runs first so the sidechain
// fold sees the updated tool/plan/question maps (resultOwnerKnown reads them
// when deciding whether to park).

export function updateIndexesMirror(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  // ── Tool / plan / question folds (delegated) ───────────────────────────
  // Delegated to tool-index.ts: the generic tool status seed/flip, the
  // toolResults payload capture, the planStatus seed/flip, the planContent
  // extraction, and the questionAnswers seed/parse. Runs FIRST so the
  // sidechain fold below sees the updated tool/plan/question maps
  // (resultOwnerKnown reads them when deciding whether to park).
  const afterTool = updateToolIndexMirror(mirror, message)

  // ── Sidechain folds (Subagent / Workflow / Skill) ──────────────────────
  // Delegated to sidechain-index.ts: the subagent / workflow / skill seed /
  // result / child folds, plus the task-notification completion signal.
  // Runs AFTER the tool/plan/question work so the order-insensitivity
  // parking below sees the updated sidechain maps (resultOwnerKnown and
  // resultIsSidechainChild read all six lifecycle maps).
  const nextMirror = updateSidechainIndexMirror(afterTool, message)

  // ── Order-insensitivity: park orphan completion signals ────────────────
  // The branches above are a fold over ARRIVAL order: a tool_result (or a
  // task-notification) can only settle a tool_use that was applied before it.
  // Out-of-order ingress (tail-first replay, disk paging, a replay merge that
  // drops the overlap) can land the signal first, so the later tool_use would
  // seed 'running' with nothing left to flip it. Park every completion signal
  // whose owning tool_use is not yet known; drainPendingResults re-applies it
  // through these same branches once the tool_use lands.
  const ownerIds = completionOwnerIds(message)
  if (ownerIds.length === 0) return nextMirror
  const parked = nextMirror.pendingResults
  const key = pendingResultKey(message, ownerIds)
  // A signal must NOT be parked once it is "settled": either a sidechain
  // child's result (owned by its parent record's child list) or every id it
  // carries is owned by a top-level lifecycle map (the common in-order case).
  const settled =
    resultIsSidechainChild(nextMirror, message, ownerIds) ||
    ownerIds.every((id) => resultOwnerKnown(nextMirror, id))
  if (settled) {
    // If an earlier out-of-order pass parked this same message, unpark it now.
    if (!parked.has(key)) return nextMirror
    const pendingResults = new Map(parked)
    pendingResults.delete(key)
    return { ...nextMirror, pendingResults }
  }
  if (parked.has(key)) return nextMirror
  const pendingResults = new Map(parked)
  pendingResults.set(key, message)
  while (pendingResults.size > PENDING_RESULTS_CAP) {
    const oldest = pendingResults.keys().next().value
    if (oldest === undefined) break
    pendingResults.delete(oldest)
  }
  return { ...nextMirror, pendingResults }
}

// ── drainPendingResults ─────────────────────────────────────────────────────
// Re-apply every parked completion-signal message through the index branches.
// Called at the end of a batch fold (and after each live message) — by then
// any tool_use the batch carried has been seeded, so a parked signal whose
// owner just arrived settles here. `updateIndexesMirror` also drops a parked
// entry once every id it carries is known, so this loop both settles and
// unparks. Identity-stable when nothing is parked (the common case) or nothing
// changed.

export function drainPendingResults(mirror: ServerMirror): ServerMirror {
  if (mirror.pendingResults.size === 0) return mirror
  let next = mirror
  // Snapshot the keys: a re-application may add or remove parked entries.
  for (const key of Array.from(mirror.pendingResults.keys())) {
    const parked = next.pendingResults.get(key)
    if (!parked) continue
    next = updateIndexesMirror(next, parked)
  }
  return next
}

// ── rebuildIndexesFromMessages ──────────────────────────────────────────────
// Moved from reducer.ts. Replay a list of cached messages through
// `updateIndexesMirror` to reconstruct the lifecycle index maps. Used by
// `SessionStore` on hydration: only `messages`/`items` are persisted to
// localStorage (the indexes are derived state). Bypasses `updateTranscript` —
// the items array is already populated from the cache; we only need the index
// side effects. Calling `applyMessage` here would double-append items.

export function rebuildIndexesFromMessages(
  state: SessionState,
  messages: readonly SdkMessage[],
): SessionState {
  let mirror = state.mirror
  for (const message of messages) {
    mirror = updateIndexesMirror(mirror, message)
  }
  let next = withMirror(state, mirror)
  // Re-apply client-side dismissals BEFORE drainPendingResults: the rebuild
  // re-seeds dismissed records as 'running' (the stream has no record of the
  // dismiss), and a parked task-notification for a trimmed-then-re-seeded id
  // would be re-applied by drainPendingResults (flipping running→done) before
  // reapplyDismissed could flip it to 'dismissed'. The task-notification
  // branch excludes 'dismissed', so applying first means drain sees
  // 'dismissed' and skips the flip. Covers the trim→page-back dismissal
  // regression: trimFront prunes a dismissed record (not in-flight), then a
  // head page re-seeds it as 'running'; reapplyDismissed flips it back.
  // Idempotent.
  next = reapplyDismissed(next)
  // After the whole batch: settle any result whose tool_use arrived in it
  // (out-of-order parking — see ServerMirror.pendingResults). Deferring to the
  // batch boundary lets a sidechain's child frames merge into the record
  // BEFORE its result settles it, so the drill-in detail isn't lost.
  next = withMirror(next, drainPendingResults(next.mirror))
  return next
}

// ── pruneIndexesToLive ──────────────────────────────────────────────────────
// Unified index-map pruning extracted from the reducer's trimFront and
// evictMessages. Both callers compute the `live` toolUseId set (ids still
// referenced by the retained items) and the `retained` uuid set (message uuids
// still in the transcript), then call this single function to prune every
// lifecycle map in one shot.
//
// `live` keys the toolUseId-indexed maps (toolStatus, toolResults, planStatus,
// planContent, questionAnswers, and the three sidechain maps). `retained` keys
// the uuid-indexed pendingResults (a parked result whose result message was
// front-trimmed / evicted can no longer be correlated and must be dropped).
//
// The sidechain maps default to `pruneSettledToLive` semantics: a still-in-
// flight record (running/background/pending) is NEVER dropped even when its
// owner tool_use was trimmed — the WorkingBubble pill / Waiting gate would
// otherwise hide live work mid-flight. Settled rows (done/interrupted/dismissed)
// are pruned normally. This matches trimFront's contract.
//
// `opts.hardSidechain` (evictMessages) switches the sidechain maps to a HARD
// prune (`pruneMapToLive`): a retracted leg's records must go even if they
// were still in-flight — the frames that owned them no longer exist. Without
// this flag the soft prune would keep them and evictMessages would have to
// override the three fields afterwards, wasting the soft-prune work.

export function pruneIndexesToLive(
  mirror: ServerMirror,
  live: Set<string>,
  retained: Set<string>,
  opts?: { hardSidechain?: boolean },
): ServerMirror {
  const toolStatus = pruneMapToLive(mirror.toolStatus, live)
  const toolResults = pruneMapToLive(mirror.toolResults, live)
  const pendingResults = prunePendingResults(mirror.pendingResults, retained)
  const planStatus = pruneMapToLive(mirror.planStatus, live)
  const planContent = pruneMapToLive(mirror.planContent, live)
  const questionAnswers = pruneMapToLive(mirror.questionAnswers, live)
  if (opts?.hardSidechain) {
    const activeSubagents = pruneMapToLive(mirror.activeSubagents, live)
    const activeWorkflows = pruneMapToLive(mirror.activeWorkflows, live)
    const activeSkills = pruneMapToLive(mirror.activeSkills, live)
    if (
      toolStatus === mirror.toolStatus &&
      toolResults === mirror.toolResults &&
      pendingResults === mirror.pendingResults &&
      planStatus === mirror.planStatus &&
      planContent === mirror.planContent &&
      questionAnswers === mirror.questionAnswers &&
      activeSubagents === mirror.activeSubagents &&
      activeWorkflows === mirror.activeWorkflows &&
      activeSkills === mirror.activeSkills
    ) {
      return mirror
    }
    return {
      ...mirror,
      toolStatus,
      toolResults,
      pendingResults,
      planStatus,
      planContent,
      questionAnswers,
      activeSubagents,
      activeWorkflows,
      activeSkills,
    }
  }
  const activeSubagents = pruneSettledToLive(mirror.activeSubagents, live)
  const activeWorkflows = pruneSettledToLive(mirror.activeWorkflows, live)
  const activeSkills = pruneSettledToLive(mirror.activeSkills, live)
  if (
    toolStatus === mirror.toolStatus &&
    toolResults === mirror.toolResults &&
    pendingResults === mirror.pendingResults &&
    planStatus === mirror.planStatus &&
    planContent === mirror.planContent &&
    questionAnswers === mirror.questionAnswers &&
    activeSubagents === mirror.activeSubagents &&
    activeWorkflows === mirror.activeWorkflows &&
    activeSkills === mirror.activeSkills
  ) {
    return mirror
  }
  return {
    ...mirror,
    toolStatus,
    toolResults,
    pendingResults,
    planStatus,
    planContent,
    questionAnswers,
    activeSubagents,
    activeWorkflows,
    activeSkills,
  }
}

// ── Pruning helpers ─────────────────────────────────────────────────────────
// Moved from reducer.ts. Shared by pruneIndexesToLive (this module) and by
// evictMessages (reducer.ts) which overrides the sidechain maps with a hard
// prune after calling pruneIndexesToLive.

/** Return a Map filtered to keys present in `live`, reusing the original
 *  reference when nothing is dropped (keeps selector identity stable). */
export function pruneMapToLive<V>(map: Map<string, V>, live: Set<string>): Map<string, V> {
  let dropped = false
  for (const key of map.keys()) {
    if (!live.has(key)) { dropped = true; break }
  }
  if (!dropped) return map
  const next = new Map<string, V>()
  for (const [key, value] of map) {
    if (live.has(key)) next.set(key, value)
  }
  return next
}

/** Like pruneMapToLive, but NEVER drops a record whose lifecycle status is
 *  still in-flight (`running`/`background`/`pending`) — even when its owner
 *  tool_use frame has been front-trimmed out of `items`. Dropping those would
 *  hide live work from the WorkingBubble pill / Waiting gate mid-flight
 *  (a busy tab can trim past an Agent's tool_use while the subagent is still
 *  running). Settled rows (done/interrupted/dismissed/…) are pruned normally. */
export function pruneSettledToLive<V extends { status: string }>(
  map: Map<string, V>,
  live: Set<string>,
): Map<string, V> {
  const isInFlight = (s: string) =>
    s === 'running' || s === 'background' || s === 'pending'
  let dropped = false
  for (const [key, value] of map) {
    if (!live.has(key) && !isInFlight(value.status)) { dropped = true; break }
  }
  if (!dropped) return map
  const next = new Map<string, V>()
  for (const [key, value] of map) {
    if (live.has(key) || isInFlight(value.status)) next.set(key, value)
  }
  return next
}

/** Drop parked results whose result message is no longer in the transcript
 *  (front-trim / refusal-fallback eviction). Without this an evicted result
 *  could still be re-applied by a later drain and wrongly settle a tool_use
 *  that was NOT evicted. Keeps uuid-less entries (nothing to correlate). */
export function prunePendingResults(
  pending: Map<string, SdkMessage>,
  retainedUuids: ReadonlySet<string>,
): Map<string, SdkMessage> {
  if (pending.size === 0) return pending
  let next: Map<string, SdkMessage> | null = null
  for (const [key, msg] of pending) {
    const uuid = typeof msg.uuid === 'string' ? msg.uuid : null
    if (uuid == null || retainedUuids.has(uuid)) continue
    if (!next) next = new Map(pending)
    next.delete(key)
  }
  return next ?? pending
}

// ── collectLiveToolUseIds ───────────────────────────────────────────────────
// Moved from reducer.ts. Union of every tool_use_id referenced by `items` —
// both the tool_use (assistant) and tool_result (user) sides. Used to prune
// the toolUseId-keyed lifecycle maps to live keys after a front-trim / evict.

/** Union of every tool_use_id referenced by `items` — both the tool_use
 *  (assistant) and tool_result (user) sides. Used to prune the toolUseId-keyed
 *  lifecycle maps to live keys after a front-trim. */
export function collectLiveToolUseIds(items: ServerMirror['items']): Set<string> {
  const live = new Set<string>()
  for (const it of items) {
    const m = it.msg
    for (const id of getToolUseStarts(m)) live.add(id)
    // Subagent/Workflow tool_uses are excluded from getToolUseStarts
    // (TOOL_STATUS_EXCLUDE — they own their lifecycle maps). Their ids must
    // still join the live set so those maps can be pruned alongside the rest.
    // Skill is NOT in TOOL_STATUS_EXCLUDE (its generic tool_result suppression
    // is load-bearing — see the ReportFindings note in normalize.ts), but
    // getSkillStarts is listed explicitly so a future exclusion can't silently
    // drop activeSkills keys from this set.
    for (const sub of getSubagentStarts(m)) live.add(sub.toolUseId)
    for (const wf of getWorkflowStarts(m)) live.add(wf.toolUseId)
    for (const sk of getSkillStarts(m)) live.add(sk.toolUseId)
    for (const id of getPlanToolUseIds(m)) live.add(id)
    for (const id of getQuestionToolUseIds(m)) live.add(id)
    for (const id of getToolResultIds(m)) live.add(id)
  }
  return live
}

// ── Parking helpers ─────────────────────────────────────────────────────────
// Moved from reducer.ts. Support the order-insensitivity parking inside
// updateIndexesMirror.

/** Hard cap on `pendingResults`. A genuinely orphaned id (the tool_use was
 *  evicted, or never existed — e.g. an EnterPlanMode result whose id owns no
 *  lifecycle map) can never be paired, so without a bound it would linger for
 *  the life of the session. Real orphan bursts are tiny (one per ring-boundary
 *  tool call); this is pure insurance. Maps keep insertion order, so eviction
 *  drops the oldest. */
const PENDING_RESULTS_CAP = 256

/** Stable key for a parked completion-signal message. The uuid is the natural
 *  key (and what a replay re-delivers); a uuid-less frame is rare, so fall back
 *  to a content-derived key that still dedups repeated re-applications. */
function pendingResultKey(message: SdkMessage, ownerIds: readonly string[]): string {
  if (typeof message.uuid === 'string' && message.uuid.length > 0) return message.uuid
  const at = typeof message.receivedAt === 'number' ? message.receivedAt : ''
  return `ids:${ownerIds.join(',')}:${at}`
}

/** The tool_use_ids a message can SETTLE. Two carriers:
 *   - a tool_result's owner ids (`getToolResultIds`);
 *   - the Agent tool_use_id a task-notification targets (SDK `system` frame or
 *     harness `<task-notification>` user injection).
 *  Empty for anything that settles no indexed record (a plain prompt, an
 *  unrelated system frame) — those are never parked. This is the "who does
 *  this message belong to" set the park logic keys on. */
function completionOwnerIds(message: SdkMessage): string[] {
  const resultIds = getToolResultIds(message)
  if (resultIds.length > 0) return resultIds
  if (message.type !== 'system' && message.type !== 'user') return []
  const target = parseTaskNotification(message)?.toolUseId
  return target ? [target] : []
}

/** Does some lifecycle map already own this tool_use id? If so, a tool_result
 *  for it is paired (or its completion branch will handle it) and must NOT be
 *  parked. Covers every map a tool_result can settle: generic tools
 *  (`toolStatus`), plans (`planStatus`), questions (`questionAnswers`), and the
 *  three sidechain owners (`activeSubagents` / `activeWorkflows` /
 *  `activeSkills`). */
function resultOwnerKnown(mirror: ServerMirror, id: string): boolean {
  return (
    mirror.toolStatus.has(id) ||
    mirror.planStatus.has(id) ||
    mirror.questionAnswers.has(id) ||
    mirror.activeSubagents.has(id) ||
    mirror.activeWorkflows.has(id) ||
    mirror.activeSkills.has(id)
  )
}

/** Is this completion signal aimed at a sidechain CHILD row — a nested row of
 *  an Agent/Workflow/Skill record rather than one of the six top-level
 *  lifecycle maps? Main-thread results carry `parent_tool_use_id: null`
 *  (verified in server/session-pump.ts); only subagent-internal hops carry a
 *  non-null parent. Child ids never enter those maps, so parking one would
 *  leak forever (and evict real orphans via the cap). Its own branch already
 *  settles it in-order, and `sweepRunningChildCalls` covers a stranded one.
 *  Returns false when the parent record (or the child row) isn't seeded yet —
 *  then it IS parked, and a later drain re-checks once the row exists. */
function resultIsSidechainChild(
  mirror: ServerMirror,
  message: SdkMessage,
  ownerIds: readonly string[],
): boolean {
  const parentId = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : ''
  if (!parentId) return false
  const hasChild = (children: ReadonlyArray<{ toolUseId: string }> | undefined): boolean =>
    children != null && children.some((c) => ownerIds.includes(c.toolUseId))
  if (hasChild(mirror.activeSubagents.get(parentId)?.childToolCalls)) return true
  if (hasChild(mirror.activeWorkflows.get(parentId)?.childAgents)) return true
  if (hasChild(mirror.activeSkills.get(parentId)?.childCalls)) return true
  return false
}
