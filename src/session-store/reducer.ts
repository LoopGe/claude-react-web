import type { PermissionRequest, SdkMessage } from '../types'
import {
  createInitialClientIntent,
  createInitialServerMirror,
  type ServerMirror,
  type SessionAction,
  type SessionState,
  withIntent,
  withMirror,
} from './types'
import {
  msgTime,
  recomputeActiveWorktree,
  toTranscriptItem,
} from './normalize'
import { promptContentFingerprint } from '../../shared/prompt-fingerprint.js'
import {
  bumpGeneration,
  emptyWindow,
} from './seq-window'
import {
  flushLiveTurn,
} from './live-turn'
import {
  applyTasksSnapshot,
  dismissSubagent,
  reapplyDismissed,
} from './sidechain-index'
import {
  applyPermissionRequest,
  applyPermissionResolved,
} from './tool-index'
import {
  sweepAtTurnEnd,
} from './turn-status'
import {
  evictMessages,
  prependMessages,
} from './transcript-log'
// WINDOW_* handlers live in window-bridge.ts (Task 7 fix round 1). The seam
// breaks the message-pipeline ↔ transcript-log value-import cycle: window-bridge
// imports applyMessage from message-pipeline and prependMessages/evictMessages
// from transcript-log, so neither message-pipeline nor transcript-log needs to
// import the other for the WINDOW path.
import {
  windowEvict,
  windowLive,
  windowPage,
} from './window-bridge'
// applyMessage moved to message-pipeline.ts (Task 7). The reducer's MESSAGE
// action delegates here; replayReplace (still in reducer.ts until Task 8)
// also calls it. The WINDOW_* handlers in window-bridge.ts import this same
// binding — window-bridge is the seam that breaks the would-be
// message-pipeline ↔ transcript-log value-import cycle (transcript-log no
// longer imports message-pipeline).
import { applyMessage } from './message-pipeline'
// Optimistic/ack/consumed/steered intent handlers and clearSendingPlaceholders
// moved to user-message-lifecycle.ts (Task 7). The reducer delegates the four
// user-message actions here; SESSION_TERMINATED uses clearSendingPlaceholders.
import {
  applyOptimisticUserMessage,
  ackUserMessage,
  applyMessageConsumed,
  applyMessageSteered,
  clearSendingPlaceholders,
} from './user-message-lifecycle'
// Re-export reapplyDismissed so the existing importer (`reducer.test.ts`)
// keeps resolving without a 4th-file edit. The canonical definition lives in
// sidechain-index.ts.
export { reapplyDismissed } from './sidechain-index'
// Re-export rebuildIndexesFromMessages (index-pipeline owner) and
// settleStaleLiveSubagents (turn-status owner) so the existing importers
// (`reducer.test.ts`, `sidechain-index.test.ts`, `skill-index.test.ts`,
// `tool-status.test.ts`) keep resolving without per-file edits.
export { rebuildIndexesFromMessages } from './index-pipeline'
export { settleStaleLiveSubagents } from './turn-status'
// Re-export MEMORY_ITEM_CAP (transcript-log owner) so the existing importer
// (`active-worktree.test.ts`) keeps resolving without a per-file edit.
export { MEMORY_ITEM_CAP } from './transcript-log'


export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'REPLAY_REPLACE':
      return replayReplace(state, action.messages, action.permissions)
    case 'MESSAGE':
      return applyMessage(state, action.message)
    case 'OPTIMISTIC_USER_MESSAGE':
      return applyOptimisticUserMessage(state, action.message)
    case 'ACK_USER_MESSAGE':
      return ackUserMessage(state, action.pendingId, action.serverUuid, action.receivedAt)
    case 'ROLLBACK_OPTIMISTIC_USER_MESSAGE': {
      // Only roll back if the placeholder is still pending — between the
      // failed POST and this dispatch, the server echo might have already
      // consumed this placeholder (removing it from intent), in which case
      // we'd nuke the real message that landed in mirror.items.
      if (!state.intent.pendingPlaceholders.has(action.pendingId)) return state
      const nextPlaceholders = new Map(state.intent.pendingPlaceholders)
      nextPlaceholders.delete(action.pendingId)
      return withIntent(state, { ...state.intent, pendingPlaceholders: nextPlaceholders })
    }
    case 'PERMISSION_REQUEST':
      // Delegated to tool-index.ts: seeds `pidToToolUseId` from the
      // request's `toolUseID`. No-op (identity-stable) when the request
      // carries no `toolUseID`.
      return applyPermissionRequest(state, action.request)
    case 'PERMISSION_RESOLVED':
      // Delegated to tool-index.ts: clears the `pidToToolUseId` entry for
      // the resolved pid, flips `planStatus` to approved/rejected when the
      // pid maps to a plan, and parses the JSON answers payload from
      // `decision.message` into `questionAnswers` when the pid maps to a
      // question (closing the gap where the SDK does not always echo a
      // follow-up tool_result after a canUseTool deny+message
      // short-circuit). Identity-stable when nothing changed.
      return applyPermissionResolved(state, action.id, action.decision)
    case 'CONTEXT_USAGE':
      return withMirror(state, { ...state.mirror, contextUsage: action.usage })
    case 'PROMPT_SUGGESTION':
      return withMirror(state, { ...state.mirror, promptSuggestion: action.suggestion })
    case 'SESSION_STATE':
      return withMirror(state, { ...state.mirror, sessionState: action.state })
    case 'SESSION_TERMINATED': {
      // Same sweep the `result` frame runs, for the session state in which no
      // result frame can ever arrive. Without it a stranded SYNC subagent
      // record stays `running` forever and its card spins on a dead session —
      // the case TASKS_SNAPSHOT deliberately skips below on the assumption
      // that the result-frame sweep covers it. `liveTurn: null` and the
      // placeholder clear match that branch's reasoning: the SDK is finished,
      // so no echo is expected for anything still marked as sending.
      //
      // Idempotent by design: the dispatcher fires again after each replay (a
      // reload of a terminated session rebuilds the records the sweep must
      // then re-examine), so a no-op re-dispatch must NOT churn every
      // subscriber or dirty a persist. sweepAtTurnEnd returns the same mirror
      // reference when nothing needed sweeping.
      const swept = sweepAtTurnEnd(state.mirror)
      const intent = clearSendingPlaceholders(state.intent)
      // `apiRetry` is transient in exactly the same way as the slots above: it
      // lives outside the transcript because it is "only meaningful while a
      // retry is in flight", and its ONLY clearer is the next non-retry
      // message — which a terminated session never delivers. Without this a
      // "Retrying in Ns…" divider hangs on a session that can never retry.
      // `thinkingTokens` for the same reason: its terminal clearer is the
      // `result` frame, which a terminated session never delivers either.
      const transientCleared = state.mirror.liveTurn !== null
        || state.mirror.apiRetry !== null
        || state.mirror.thinkingTokens != null
      if (swept === state.mirror && !transientCleared && intent === state.intent) return state
      return {
        sessionId: state.sessionId,
        mirror: { ...swept, liveTurn: null, apiRetry: null, thinkingTokens: null },
        intent,
      }
    }
    case 'TASKS_SNAPSHOT': {
      // Delegated to sidechain-index.ts: replaces the whole task list, then
      // enriches matching subagent records (taskId / progressSummary /
      // lastToolName / isAsync / status flips). TASKS_SNAPSHOT is the sole
      // isAsync authority — see applyTasksSnapshot for the full rationale.
      const mirror = applyTasksSnapshot(state.mirror, action.tasks)
      if (mirror === state.mirror) return state
      return withMirror(state, mirror)
    }
    case 'MESSAGE_CONSUMED':
      return applyMessageConsumed(state, action.uuid, action.consumedAt)
    case 'MESSAGE_STEERED':
      return applyMessageSteered(state, action.uuid, action.state)
    case 'ERROR':
      // ERROR straddles the boundary: the WS error frame writes it (server-
      // originated) but the lifecycle (clearError) is client-owned. We park
      // it on the intent layer because that's the layer the client mutates
      // freely — and importantly, a REPLAY_REPLACE rebuilding mirror must
      // NOT incidentally clear a stale error the user hasn't dismissed yet.
      return withIntent(state, { ...state.intent, error: action.message })
    case 'LIVE_TURN_FLUSH':
      // Coalesces unflushed chunks into flushedText (adjacent same-origin
      // merge) and folds the main-thread text into the in-place draft at the
      // 80ms cadence. See live-turn.ts for the full rationale.
      return withMirror(state, flushLiveTurn(state.mirror))
    case 'DISMISS_SUBAGENT': {
      // Delegated to sidechain-index.ts: flips an in-flight subagent
      // (running/background/pending) to `dismissed` and records the id on
      // intent.dismissedSubagents so the dismiss survives mirror rebuilds.
      // No-op for already-settled records.
      return dismissSubagent(state, action.toolUseId)
    }
    case 'CLEAR_TRANSCRIPT': {
      // Same full wipe as RESET, but the post-/clear session is live and
      // empty with no pending replay (the WS subscription persists, the
      // server doesn't re-replay, system/init isn't broadcast). Mark the
      // transcript ready so MessageList shows the empty-state instead of
      // an infinite skeleton.
      // The seq window empties too, but its generation/headSeq cursor is
      // PRESERVED: the window only re-anchors on the server's WINDOW_BUMP
      // (the /clear generation+1 arrives via the attached/cleared frame),
      // so a pre-bump page can't be mistaken for post-clear content.
      const mirror = {
        ...createInitialServerMirror(),
        replayReady: true,
        window: emptyWindow(state.mirror.window.generation, state.mirror.window.headSeq),
      }
      return {
        sessionId: state.sessionId,
        mirror,
        intent: createInitialClientIntent(),
      }
    }
    case 'EVICT_MESSAGES':
      return evictMessages(state, action.uuids)
    case 'WINDOW_PAGE':
      return windowPage(state, action)
    case 'WINDOW_LIVE':
      return windowLive(state, action.seq, action.generation, action.message)
    case 'WINDOW_EVICT':
      return windowEvict(state, action.seqs)
    case 'WINDOW_BUMP':
      return {
        sessionId: state.sessionId,
        mirror: {
          ...createInitialServerMirror(),
          replayReady: true,
          window: bumpGeneration(state.mirror.window, action.generation, action.headSeq),
        },
        intent: createInitialClientIntent(),
      }
    default:
      return state
  }
}

/** Keep-first uuid dedup over a REPLAY_REPLACE payload. A single
 *  server-built burst is a contiguous ring slice and never repeats a uuid —
 *  the only shape that does is a superseded-burst concatenation
 *  ([older-burst-prefix][newer-full-burst], produced by the retired server
 *  write-queue supersede), whose overlap the
 *  cache-split below cannot see (it only splits against the cache, not
 *  within the payload). Without this, a cold store renders the overlap
 *  twice. Two-pass: the first scan exits without rebuilding when every
 *  uuid is unique (the overwhelmingly common case); uuid-less frames can
 *  never collide and are always kept. Exported for tests (same pattern as
 *  splitReplayAgainstCache). */
export function dedupeReplayPayload(messages: SdkMessage[]): SdkMessage[] {
  const uuids = new Set<string>()
  let hasDup = false
  for (const m of messages) {
    const u = typeof m?.uuid === 'string' ? m.uuid : null
    if (u == null) continue
    if (uuids.has(u)) {
      hasDup = true
      break
    }
    uuids.add(u)
  }
  if (!hasDup) return messages
  const kept = new Set<string>()
  const out: SdkMessage[] = []
  for (const m of messages) {
    const u = typeof m?.uuid === 'string' ? m.uuid : null
    if (u == null) {
      out.push(m)
      continue
    }
    if (kept.has(u)) continue
    kept.add(u)
    out.push(m)
  }
  return out
}

function replayReplace(
  prevState: SessionState,
  messages: SdkMessage[],
  permissions: PermissionRequest[],
): SessionState {
  // Dedup BEFORE anything reads the payload — see dedupeReplayPayload.
  const payload = dedupeReplayPayload(messages)
  const prevMirror = prevState.mirror
  // If the server replay is empty but we already have cached messages
  // (from localStorage), keep the cache as a fallback. This prevents
  // blank screens when the server's history ring has been trimmed or
  // the session was garbage collected.
  if (payload.length === 0 && prevMirror.items.length > 0) {
    return withMirror(prevState, { ...prevMirror, replayReady: true })
  }
  // Replay on top of an existing (cached) transcript. The replay payload can
  // relate to the cache three different ways, and we must NOT blind-append:
  //
  //   - Clean reconnect (sinceUuid hit the ring): the server already sliced to
  //     messages STRICTLY AFTER the client's lastUuid, so they're all newer →
  //     pure append (the original incremental-replay behaviour).
  //   - Resume seed / sinceUuid miss → FULL replay: the payload is the disk
  //     transcript tail, which OVERLAPS the cache. Blind-appending would
  //     render every overlapping message twice (the "shows twice" regression).
  //   - Cache trimmed below the replay window: the payload's leading portion
  //     is OLDER than the cache's first item.
  //
  // splitReplayAgainstCache() splits the payload into older / overlapping
  // / newer relative to the cache and routes each part to the path that
  // already dedups it correctly (prependMessages for older, applyMessage for
  // newer, drop the overlap). This makes the merge correct regardless of how
  // the server happened to slice — no reliance on sinceUuid landing cleanly.
  if (payload.length > 0 && prevMirror.items.length > 0) {
    const { older, mid, newer, overlap } = splitReplayAgainstCache(payload, prevMirror.items)
    // Preserve an in-progress turn's accumulated text across a benign
    // reconnect / panel-switch-back replay. The live turn's partial text lives
    // ONLY in `liveTurn` — stream_event deltas never enter the history ring
    // (the replay cannot carry them), so nulling liveTurn here made the
    // StreamingFooter vanish even though the turn was still running server-side.
    // A `result` in the replay's NEWER slice is the one reliable "the turn
    // ended" signal: it always sits chronologically after the cache (a
    // liveTurn can only belong to a turn started after the cache's last item),
    // and applyMessage also nulls liveTurn on it below. A result in the
    // OLDER/prepended slice predates the cache window and must NOT clear a
    // still-current liveTurn.
    const turnEnded = newer.some((m) => m.type === 'result')
    let state: SessionState = withMirror(prevState, {
      ...prevMirror,
      liveTurn: turnEnded ? null : prevMirror.liveTurn,
      replayReady: true,
    })
    for (const permission of permissions) {
      state = reduceSessionState(state, { type: 'PERMISSION_REQUEST', request: permission })
    }
    if (older.length > 0) state = prependMessages(state, older)
    // Overlap frames with a degraded cached copy are replaced by the
    // authoritative replay copy BEFORE the newer tail appends — see the
    // helper doc. Identical copies are skipped inside the helper.
    state = replaceStaleCachedMessages(state, overlap)
    for (const message of newer) {
      state = applyMessage(state, message)
    }
    // Mid slice: no-uuid-overlap payload frames inside the cache's time span
    // — holes to fill + uuid-mismatched prompt twins to skip. Applied at the
    // tail (applyMessage machinery), then repositioned by the repair pass.
    state = applyMidSlice(state, mid, payload)
    // Chronology repair: repositions anything the merge (or a historical
    // bug) left out of time order. No-op on healthy state.
    state = repairChronology(state)
    const finalLen = state.mirror.items.length
    const prevLen = prevMirror.items.length
    if (finalLen < prevLen) {
      console.warn(
        `[replayReplace] MERGE: items shrunk ${prevLen} → ${finalLen} ` +
        `(replay=${payload.length}, older=${older.length}, mid=${mid.length}, newer=${newer.length})`,
      )
    }
    // Never synthesize a turn end while merging a replay into an existing
    // client cache. This is the live/incremental reconnect path, and the replay
    // may legitimately end with an in-progress synchronous Agent tool_use and
    // no result frame yet. Historical disk hydration is handled only by the
    // fresh-state path below.
    // Re-apply client-side dismissals: the merge rebuilds activeSubagents from
    // the replay payload, which has no record of the dismiss. Same rationale as
    // the fresh-state path below. Idempotent.
    return reapplyDismissed(state)
  }
  // Fresh state path: the prior mirror has no items (cold start, or the cache
  // was empty before the replay). Start from `prevMirror` rather than a brand-
  // new mirror so any live-dispatched frames that landed during the replay
  // window (permission-request, context-usage, message-consumed) are
  // preserved. items being empty implies the derived index Maps
  // (toolStatus / planStatus / activeSubagents / …) are already empty too —
  // no risk of carrying stale entries forward.
  //
  // This is the line that closes the "first message stuck" StrictMode race:
  // even if React mounts twice and runs us through this branch a second time,
  // the placeholder in `prevState.intent` (and any live server-side state in
  // prevMirror) survives.
  let working: SessionState = { sessionId: prevState.sessionId, mirror: prevMirror, intent: prevState.intent }
  for (const permission of permissions) {
    working = reduceSessionState(working, { type: 'PERMISSION_REQUEST', request: permission })
  }
  for (const message of payload) {
    working = applyMessage(working, message)
  }
  // Re-apply client-side dismissals BEFORE the turn-end sweep: the replay
  // re-seeds dismissed records as 'running' (the stream has no record of the
  // dismiss), and the sweep would flip a sync (non-live-bg) running record to
  // 'interrupted' — a terminal state reapplyDismissed can't rescue (it only
  // flips running/background/pending). Applying first means the sweep sees
  // 'dismissed' and skips it (dismissed is not in its running/background/
  // pending flip set). Idempotent.
  working = reapplyDismissed(working)
  // A fresh replay without result frames is swept only when every frame came
  // from the persisted CLI transcript. A new tab can subscribe to a live
  // session mid-turn with an empty client cache; that fresh in-memory replay
  // also has no result yet and must preserve a running synchronous subagent.
  const isDiskReplay = payload.length > 0 && payload.every((m) => m.restoredFromDisk === true)
  const sweptMirror = isDiskReplay && !payload.some((m) => m.type === 'result')
    ? sweepAtTurnEnd(working.mirror)
    : working.mirror
  // Preserve `working.intent` rather than `prevState.intent`: applyMessage in
  // the loop above may have consumed pending placeholders (echo-merge clears
  // them from intent), and reapplyDismissed may have pruned dismissedSubagents
  // ids. Both intent changes must survive; using prevState.intent would
  // reintroduce stale placeholders and lose the dismissal pruning.
  return {
    sessionId: prevState.sessionId,
    mirror: { ...sweptMirror, replayReady: true },
    intent: working.intent,
  }
}

/** Cheap content-shape fingerprint for the replace-compare below. Block types
 *  plus string lengths with head/tail anchors — NEVER a full serialization
 *  (a replay payload routinely carries multi-MB base64 images, and the cached
 *  copy holds one too after a restore; stringifying both per overlap frame
 *  would churn tens of MB on the main thread).
 *
 *  Soundness for the same-uuid compare: the cached copy is either the server
 *  copy verbatim (JSON round-trips preserve shape) or its persist projection,
 *  which only ever SHRINKS content (drops blocks, truncates strings with a
 *  marker appended). So equal shape ⟹ no shrink happened ⟹ identical content;
 *  the head/tail anchors make a same-length different-bytes collision
 *  impossible in practice. */
function strShape(s: string): string {
  return `${s.length}:${s.slice(0, 24)}:${s.slice(-24)}`
}

function blockShape(b: unknown): string {
  if (!b || typeof b !== 'object') return '?'
  const t = (b as { type?: unknown }).type
  if (t === 'text' || t === 'thinking') {
    const v = (b as { text?: unknown; thinking?: unknown })
    const s = typeof v.text === 'string' ? v.text : typeof v.thinking === 'string' ? v.thinking : ''
    return `${t === 'text' ? 't' : 'k'}:${strShape(s)}`
  }
  if (t === 'image') {
    const d = (b as { source?: { data?: unknown } }).source?.data
    return typeof d === 'string' ? `i:${strShape(d)}` : 'i'
  }
  if (t === 'tool_use') {
    // Only the fields capToolInput can shrink — structural fields don't
    // affect the compare and full-input serialization is unbounded.
    const o = (b as { input?: unknown }).input
    if (!o || typeof o !== 'object') return 'tu'
    const big = (v: unknown): string => (typeof v === 'string' ? strShape(v) : '·')
    const edits = Array.isArray((o as Record<string, unknown>)['edits'])
      ? ((o as Record<string, unknown>)['edits'] as unknown[]).map((e) => {
          const eo = (e ?? {}) as Record<string, unknown>
          return `${big(eo['old_string'])}>${big(eo['new_string'])}`
        }).join(';')
      : '·'
    const rec = o as Record<string, unknown>
    return `tu:${big(rec['content'])}:${big(rec['old_string'])}:${big(rec['new_string'])}:${edits}`
  }
  if (t === 'tool_result') {
    const c = (b as { content?: unknown }).content
    if (typeof c === 'string') return `r:${strShape(c)}`
    if (Array.isArray(c)) return `r:[${c.map(blockShape).join('|')}]`
    return 'r'
  }
  return String(t ?? '?')
}

function contentShape(msg: SdkMessage): string {
  const c = (msg.message as { content?: unknown } | undefined)?.content
  if (c === undefined) return 'u'
  if (c === null) return 'n'
  if (typeof c === 'string') return `s:${strShape(c)}`
  if (!Array.isArray(c)) return 'o'
  return c.map(blockShape).join('|')
}

/** Replace cached copies whose content differs from the authoritative replay
 *  copy under the same uuid.
 *
 *  The persist projection (project.ts) degrades cached messages on the promise
 *  that "replay restores them within seconds" — image blocks are dropped and
 *  long text is capped. The overlap bracket alone made that promise false: a
 *  same-uuid replay frame was DROPPED as already-on-screen, so the degraded
 *  cached copy won and pasted images vanished permanently after a reload
 *  (text still rendered, so nothing but the missing image gave it away).
 *
 *  For each overlap frame whose uuid is in the cache, a content compare picks
 *  between the two outcomes the overlap previously conflated:
 *    - identical copies (the common full-overlap reconnect) → skipped, zero
 *      cost, no churn (the "shows twice" guard stays intact — nothing is
 *      re-applied or re-indexed);
 *    - differing copies (cache degraded by the projection, or ring vs disk
 *      image encodings) → the cached item + message are swapped for the
 *      replay copy at their existing position, keeping the items/messages
 *      index alignment. toTranscriptItem re-derives plainText / deliveryStatus
 *      from the full copy; the lifecycle indexes are untouched — the
 *      projection preserves everything they read (is_error, short needles).
 *      Identical-sibling items keep their object identity. */
function replaceStaleCachedMessages(state: SessionState, incoming: SdkMessage[]): SessionState {
  if (incoming.length === 0) return state
  const mirror = state.mirror
  const indexByUuid = new Map<string, number>()
  for (let i = 0; i < mirror.messages.length; i++) {
    const u = mirror.messages[i]?.uuid
    if (typeof u === 'string') indexByUuid.set(u, i)
  }
  let items = mirror.items
  let messages = mirror.messages
  for (const msg of incoming) {
    const u = typeof msg.uuid === 'string' ? msg.uuid : null
    if (u == null) continue
    const idx = indexByUuid.get(u)
    if (idx === undefined) continue
    const cached = messages[idx]
    if (cached === msg) continue
    // Shape compare, not identity: the cache copy went through JSON
    // round-trips (persist) and the projection, so reference equality never
    // holds for a degraded copy and rarely for an intact one. Only runs for
    // uuid matches (the overlap bracket).
    if (contentShape(cached) === contentShape(msg)) continue
    const item = toTranscriptItem(msg, items[idx - 1])
    if (!item) continue
    if (items === mirror.items) {
      items = [...mirror.items]
      messages = [...mirror.messages]
    }
    items[idx] = item
    messages[idx] = msg
  }
  if (items === mirror.items) return state
  return withMirror(state, {
    ...mirror,
    items,
    messages,
    activeWorktree: recomputeActiveWorktree(mirror.activeWorktree, messages),
  })
}

/** Apply the `mid` slice of a no-overlap time partition — payload frames that
 *  fall inside the cache's time span without matching any cached uuid.
 *
 *  Two populations live here, and they need opposite handling:
 *
 *    - HOLES: frames the cache genuinely lost (a truncated burst that was
 *      applied out of order, a merge that dropped them, a corrupt remnant
 *      state). Filling them is the point — the server ring is the transcript
 *      authority, and a frame the cache lacks belongs in the transcript.
 *    - TWINS: uuid-mismatched copies of frames the cache already holds. The
 *      only uuid-mismatch class is top-level prompts (server-minted broadcast
 *      uuid vs on-disk SDK uuid); they are detected by content fingerprint
 *      within {@link TWIN_TIME_WINDOW_MS} and skipped — applying one would
 *      paint a duplicate prompt bubble next to its cached twin.
 *
 *  Null-time mid frames are stamped with their payload predecessor's time
 *  before applying: the payload is a contiguous chronological slice, so the
 *  predecessor's time is a true lower bound, and repairChronology can only
 *  reposition frames it can time-compare. (receivedAt is a client-side
 *  placement field for live frames anyway; the display change is limited to
 *  previously-timeless hole frames.)
 *
 *  Mid frames apply through applyMessage (append at the tail, full index
 *  machinery) — out of position by construction. repairChronology runs right
 *  after in replayReplace and moves them to their time-correct position; the
 *  decouple is what keeps this helper trivial and the repair generic. */
function applyMidSlice(state: SessionState, mid: SdkMessage[], payload: SdkMessage[]): SessionState {
  if (mid.length === 0) return state
  // Identity by reference: the partition returns the same message objects the
  // payload holds, so a reference set is exhaustive — no uuid fallback needed.
  const midRefs = new Set<SdkMessage>(mid)
  // Cached top-level prompts by content fingerprint → their times. Built
  // lazily-ish: only when a mid slice exists (rare — no-overlap partitions
  // with an in-span component).
  const mirror = state.mirror
  const promptTwinTimes = new Map<string, number[]>()
  for (const it of mirror.items) {
    const m = it.msg
    if (m.type === 'user' && m.parent_tool_use_id == null) {
      const fp = promptContentFingerprint(m)
      if (fp == null) continue
      const t = msgTime(m)
      if (t == null) continue
      const list = promptTwinTimes.get(fp)
      if (list) list.push(t)
      else promptTwinTimes.set(fp, [t])
    }
  }
  let working = state
  let lastTime: number | null = null
  for (const m of payload) {
    const inMid = midRefs.has(m)
    const t = msgTime(m)
    if (t != null) lastTime = t
    if (!inMid) continue
    if (m.type === 'user' && m.parent_tool_use_id == null) {
      const fp = promptContentFingerprint(m)
      const placeTime = t ?? lastTime
      if (fp != null && placeTime != null) {
        const times = promptTwinTimes.get(fp)
        if (times != null && times.some((ct) => Math.abs(ct - placeTime) <= TWIN_TIME_WINDOW_MS)) {
          continue
        }
      }
    }
    const stamped = t == null && lastTime != null ? { ...m, receivedAt: lastTime } : m
    working = applyMessage(working, stamped)
  }
  return working
}

/** Upper bound on reposition moves in one repair pass — a pathological input
 *  (thousands of inversions) aborts the pass atomically instead of churning
 *  O(n²) splices on the render path. The 96b4eaaa corruption needed ~150. */
const REPAIR_MOVES_CAP = 2000

/** Re-order the mirror chronologically. A no-op on healthy state: the pass
 *  only touches elements whose time is MORE than {@link REPAIR_TIME_TOLERANCE_MS}
 *  out of order relative to their nearest timed predecessor — healthy
 *  transcripts are ordered to within the CLI's per-line millisecond jitter.
 *
 *  This is what makes out-of-position application safe (mid slices append at
 *  the tail and are moved into place here), and what heals caches already
 *  damaged by the historical merge bugs: displaced runs (e.g. the disk-seed
 *  head sitting after live messages in the 96b4eaaa store) are detected as
 *  time inversions and re-inserted at their chronological position.
 *
 *  Mechanics: a forward scan; element i is displaced when its time precedes
 *  its nearest timed predecessor's by more than the tolerance. The displaced
 *  RUN extends backwards over contiguous null-time members (they were emitted
 *  between the same neighbours and must travel with the cluster), is spliced
 *  out, and re-inserted after the last timed element whose time ≤ the run's
 *  time. Frames without any comparable time never move. Bounded by
 *  {@link REPAIR_MOVES_CAP} — exceeding it aborts the whole pass atomically
 *  (the original mirror is returned) so a pathological transcript can never
 *  half-repair. */
function repairChronology(state: SessionState): SessionState {
  const mirror = state.mirror
  const n = mirror.items.length
  if (n < 2) return state
  const times: (number | null)[] = new Array(n)
  for (let i = 0; i < n; i++) times[i] = msgTime(mirror.messages[i])
  let items = mirror.items
  let messages = mirror.messages
  let copied = false
  let moves = 0
  let i = 1
  while (i < n) {
    const t = times[i]
    if (t == null) { i++; continue }
    let p = i - 1
    while (p >= 0 && times[p] == null) p--
    if (p < 0) { i++; continue }
    if (times[p]! - t <= REPAIR_TIME_TOLERANCE_MS) { i++; continue }
    // Displaced: extend the run over contiguous null-time members on BOTH
    // sides — backward between p and i, and forward past i. Null-time frames
    // (results, command_lifecycle) are emitted adjacent to their cluster's
    // timed frames; a move that leaves trailing nulls behind would split the
    // cluster across the transcript (the exact displacement this pass fixes).
    let s = i
    while (s - 1 > p && times[s - 1] == null) s--
    let e = i
    while (e + 1 < n && times[e + 1] == null) e++
    // Insertion point: after the last timed element with time ≤ t, scanning
    // backward from p (null-time entries are transparent). q lands ≤ p < s,
    // so the later splice never needs index adjustment.
    let q = p
    while (q >= 0 && (times[q] == null || times[q]! > t)) q--
    const insertAt = q + 1
    const runLen = e - s + 1
    if (!copied) {
      items = [...items]
      messages = [...messages]
      copied = true
    }
    const runItems = items.splice(s, runLen)
    const runMsgs = messages.splice(s, runLen)
    const runTimes = times.splice(s, runLen)
    items.splice(insertAt, 0, ...runItems)
    messages.splice(insertAt, 0, ...runMsgs)
    times.splice(insertAt, 0, ...runTimes)
    moves++
    if (moves > REPAIR_MOVES_CAP) {
      // Atomic abort — the partial edits live only in the copies.
      console.warn(
        `[repairChronology] aborted after ${moves} moves (cap ${REPAIR_MOVES_CAP}) — ` +
        `leaving the mirror untouched`,
      )
      return state
    }
    // Continue scanning after the re-inserted run.
    i = insertAt + runLen
  }
  if (moves > 0) {
    // Rare by design (only fires on displaced/healing state) — surface it so
    // a recurring warn is visible instead of silently absorbed.
    console.warn(`[repairChronology] moved ${moves} displaced item(s) into chronological order`)
  }
  if (!copied) return state
  return withMirror(state, {
    ...mirror,
    items,
    messages,
    // A reorder can change which worktree block is last — rescan.
    activeWorktree: recomputeActiveWorktree(mirror.activeWorktree, messages),
  })
}

/** Overlap-anchor key: the message uuid, or null when the frame must NOT
 *  anchor the overlap bracket.
 *  We anchor ONLY on disk-stable frames (assistant / system / tool_result-
 *  bearing user), whose uuids match between the in-memory ring and the on-disk
 *  transcript. Top-level user prompts are deliberately excluded (return null):
 *  their server-minted uuid never matches the on-disk SDK uuid, so they can't
 *  anchor reliably — AND keying them by content signature is WRONG, because
 *  two distinct turns can carry identical prompt text ("ok", "yes"). Treating
 *  such a repeated prompt as an overlap would silently drop a legitimate new
 *  turn. Prompt dedup is handled positionally instead: prompts in the OLDER
 *  portion are signature-deduped by prependMessages/countPromptOverlap, and
 *  prompts inside the overlap bracket are dropped with it. */
function overlapAnchorUuid(msg: SdkMessage): string | null {
  // A top-level user prompt is never an anchor — but deciding that needs only
  // the cheap type check, not the markdown pipeline. The prompt-signature
  // VALUE is never matched against cacheUuids (which holds uuids, not
  // signatures); only its non-null "is a prompt" fact is used, and the type
  // check answers that exactly. Running extractMessagePlainText here made
  // every replay pay O(replay top-level prompts) full unified-markdown parses
  // for a result that was thrown away (~300ms on a 550-message replay).
  if (msg.type === 'user' && msg.parent_tool_use_id == null) return null // a prompt — never an anchor
  return typeof msg.uuid === 'string' ? msg.uuid : null
}

/** Split a replay payload into the portion OLDER than the cached transcript,
 *  the NEWER portion, and the middle. The middle comes in two flavours:
 *
 *    - `overlap` — payload frames whose uuid is already cached (the bracket
 *      between the first and last uuid match). The caller drops them by
 *      default (identical cached copies must not be re-applied) but may
 *      REPLACE degraded cached copies whose content differs from the
 *      authoritative replay copy (replaceStaleCachedMessages — the
 *      image-restore path).
 *    - `mid` — no-uuid-overlap payload frames that fall INSIDE the cache's
 *      time span. These are either holes the cache lost (fill them —
 *      applyMidSlice) or uuid-mismatched twins of cached frames (skipped by
 *      fingerprint+time twin check there). Only produced by the no-overlap
 *      time partition; the uuid-bracket path keeps its historic
 *      drop-the-bracket semantics (mid: []) — holes inside a matched bracket
 *      are the rarer shape and the repair pass covers them only via a later
 *      broad replay.
 *
 *  Both the replay payload and the cache are chronological slices of the same
 *  transcript. We bracket the overlap by disk-stable uuid (overlapAnchorUuid):
 *  the FIRST payload frame whose uuid is already in the cache marks where the
 *  overlap begins, the LAST marks where it ends. Everything before the first
 *  anchor is older (→ prependMessages, which dedups prompts by signature +
 *  prepends + indexes); everything after the last anchor is newer (→
 *  applyMessage append); the overlap itself is dropped.
 *
 *  The clean-reconnect case (server already sliced to strictly-newer messages)
 *  has zero overlap, so `firstOverlap` stays -1 and the entire payload is
 *  partitioned by time (partitionNoOverlapByTime): predates the cache head →
 *  `older`; postdates the cache tail → `newer` (byte-identical to the original
 *  blind append for a genuine incremental reconnect); inside the cache's time
 *  span without a uuid match → `mid`. The resume-seed / full-replay case
 *  overlaps the cache tail, so that overlap is dropped instead of
 *  double-appended.
 *
 *  We use the first/last anchor bracket rather than per-message membership: a
 *  payload is a contiguous transcript slice, so a uuid that appears mid-payload
 *  but not in the cache (e.g. an assistant frame the cache trimmed) must still
 *  be kept, not dropped as a false non-overlap. */
export function splitReplayAgainstCache(
  messages: SdkMessage[],
  items: ServerMirror['items'],
): { older: SdkMessage[]; mid: SdkMessage[]; newer: SdkMessage[]; overlap: SdkMessage[] } {
  // cacheUuids holds the uuid of EVERY cache message — disk-stable frames
  // (assistant / system / tool_result-bearing user) AND top-level user prompts
  // — so the overlap bracket below can match a re-sent prompt by uuid too.
  // This is what lets a bridged session (whose in-memory ring and client cache
  // share the server-minted prompt uuid, after the resume-seed rewrite) detect
  // prompt overlap the same way it detects assistant overlap — fixing the
  // "#3" mid-turn-drop dup without signature matching (uuids are unique, so
  // same-text different turns never false-match).
  const cacheUuids = new Set<string>()
  // `cacheHasAnchor` / `replayHasAnchor` track DISK-STABLE anchors only (not
  // prompts). The no-anchor fallback gate below uses these: a prompt-only
  // transcript (the degenerate dup case) has no disk-stable anchor on either
  // side, so the gate opens. Counting prompts as anchors here would make the
  // gate almost always closed (every transcript has a prompt) and strand old,
  // un-bridged sessions (whose prompt uuids DON'T match) back on the dup path.
  let cacheHasAnchor = false
  for (const it of items) {
    // Cheap uuid/type check only — overlapAnchorUuid no longer touches the
    // markdown pipeline, so this loop is O(items) uuid lookups even though it
    // runs over EVERY cached item on every replay.
    const key = overlapAnchorUuid(it.msg)
    if (key != null) {
      cacheUuids.add(key)
      cacheHasAnchor = true
    } else if (typeof it.msg.uuid === 'string') {
      cacheUuids.add(it.msg.uuid)
    }
  }
  let firstOverlap = -1
  let lastOverlap = -1
  let replayHasAnchor = false
  for (let i = 0; i < messages.length; i++) {
    const key = overlapAnchorUuid(messages[i])
    if (key != null) {
      replayHasAnchor = true
      if (cacheUuids.has(key)) {
        if (firstOverlap === -1) firstOverlap = i
        lastOverlap = i
      }
    } else if (typeof messages[i].uuid === 'string' && cacheUuids.has(messages[i].uuid as string)) {
      // A top-level prompt whose uuid is already in the cache → overlap. Only
      // reachable for bridged sessions (uuid matches); un-bridged sessions
      // carry a different (SDK) uuid and fall through to the fallback below.
      if (firstOverlap === -1) firstOverlap = i
      lastOverlap = i
    }
  }
  if (firstOverlap !== -1) {
    return {
      older: messages.slice(0, firstOverlap),
      mid: [],
      newer: messages.slice(lastOverlap + 1),
      overlap: messages.slice(firstOverlap, lastOverlap + 1),
    }
  }
  // No disk-stable anchor overlap. Degenerate case: a transcript with NO
  // disk-stable frames at all (a turn that never produced an assistant /
  // system / result message — e.g. the model never responded, or the turn
  // was interrupted / crashed before any output). Top-level user prompts
  // can't anchor by uuid (their server-minted in-memory uuid differs from
  // the on-disk SDK uuid on UN-BRIDGED sessions), so the anchor path above
  // finds nothing and would return the whole payload as `newer` — applyMessage
  // would then append the same prompt again on EVERY reconnect / resume
  // replay, growing a stack of duplicate user bubbles (+1 per reconnect).
  // This is the "I see three copies of my message after a server restart" bug.
  //
  // This fallback covers UN-BRIDGED sessions (old sessions, or desync where
  // the resume-seed rewrite bailed). Bridged sessions resolve via the uuid
  // path above and never reach here.
  //
  // Fingerprint (NOT plain text alone — see promptContentFingerprint): folds
  // in a digest of non-text blocks so different images/attachments don't
  // collide. Plain-text signatures would collapse every image-only prompt
  // onto '' and every same-text+different-image prompt onto one string,
  // silently dropping a genuinely different message (data loss).
  //
  // EXACT-equality (not suffix / subset) is deliberate: it fixes the
  // restart-replay dup without risking a legitimate new same-content turn.
  // The only residual false-drop is a cross-tab same-CONTENT prompt in a
  // no-anchor transcript (e.g. two tabs pasting the identical image with no
  // reply yet) — a single tab can't send while disconnected, so it can't
  // happen single-tab.
  if (!cacheHasAnchor && !replayHasAnchor && promptSequencesEqual(items, messages)) {
    return { older: [], mid: [], newer: [], overlap: [] }
  }
  // No uuid overlap. The legacy behaviour treated the whole payload as
  // `newer` — correct for a genuine incremental reconnect slice, but a
  // blind append of a payload that is chronologically OLDER than the cache
  // is the mechanism that landed the disk-seed head after live messages in
  // the 96b4eaaa reorder (and the `!!STALE-BUFFER` trace proved the mixed
  // payloads that produce such disjoint no-overlap batches happen in the
  // wild). Partition the payload by TIME against the cache's span instead:
  //
  //   older — predates the cache head (prepended; uuid + prompt-signature
  //           dedup applies there)
  //   mid   — inside the cache's time span without matching any uuid: either
  //           a HOLE the cache lost (fill it — see applyMidSlice) or a
  //           uuid-mismatched twin of a cached frame (server-minted prompt
  //           uuid vs disk uuid — skipped by fingerprint+time twin check)
  //   newer — postdates the cache tail (appended; the original behaviour)
  //
  // Frames without a comparable time ride their payload predecessor's run
  // (the payload is a contiguous chronological slice, so a null-time frame
  // belongs to the run of the timed neighbour before it); a leading
  // null-time run defaults to `newer` — the legacy append.
  return partitionNoOverlapByTime(messages, items)
}

/** Time tolerance for partition/repair decisions. Healthy transcripts are
 *  ordered to within milliseconds (the CLI's own per-line jitter); genuine
 *  displacement (the reorder bug) moves content by minutes-to-days. Anything
 *  below this threshold is treated as ordered. */
const REPAIR_TIME_TOLERANCE_MS = 5_000

/** How far from a cached prompt (by time) a same-fingerprint payload copy is
 *  considered its twin rather than a distinct turn. Prompt copies of the same
 *  logical message (server broadcast → SDK transcript write) land within
 *  milliseconds of each other; a genuinely repeated prompt ("continue",
 *  "ok") is a separate send whose wall-clock distance is user-scale. The
 *  window is deliberately tight: a false twin-drop silently deletes a real
 *  turn's prompt bubble, while a missed twin only risks a duplicate bubble
 *  in the rare un-bridged-restart path this check exists for. */
const TWIN_TIME_WINDOW_MS = 2_000

function partitionNoOverlapByTime(
  messages: SdkMessage[],
  items: ServerMirror['items'],
): { older: SdkMessage[]; mid: SdkMessage[]; newer: SdkMessage[]; overlap: SdkMessage[] } {
  const older: SdkMessage[] = []
  const mid: SdkMessage[] = []
  const newer: SdkMessage[] = []
  if (messages.length === 0) return { older, mid, newer, overlap: [] }
  const cacheHeadTime = msgTime(items[0]?.msg)
  const cacheTailTime = msgTime(items[items.length - 1]?.msg)
  if (cacheHeadTime == null || cacheTailTime == null) {
    // No comparable cache times — preserve the legacy append behaviour.
    return { older, mid, newer: messages, overlap: [] }
  }
  // Leading null-time frames have no timed predecessor to ride — they belong
  // with the payload's FIRST timed frame (they precede it in payload order,
  // and the payload is a chronological slice, so that frame's run is their
  // run). Defaulting them to 'newer' would split the cluster across the
  // transcript: the timed frame prepends/appends while its leading null-time
  // members land at the opposite end.
  let firstTimedRun: 'older' | 'mid' | 'newer' | null = null
  for (const m of messages) {
    const t = msgTime(m)
    if (t == null) continue
    firstTimedRun =
      t < cacheHeadTime - REPAIR_TIME_TOLERANCE_MS
        ? 'older'
        : t > cacheTailTime + REPAIR_TIME_TOLERANCE_MS
          ? 'newer'
          : 'mid'
    break
  }
  let run: 'older' | 'mid' | 'newer' = firstTimedRun ?? 'newer'
  for (const m of messages) {
    const t = msgTime(m)
    if (t == null) {
      // Ride the predecessor's run (payload order is chronological).
      if (run === 'older') older.push(m)
      else if (run === 'mid') mid.push(m)
      else newer.push(m)
      continue
    }
    if (t < cacheHeadTime - REPAIR_TIME_TOLERANCE_MS) run = 'older'
    else if (t > cacheTailTime + REPAIR_TIME_TOLERANCE_MS) run = 'newer'
    else run = 'mid'
    if (run === 'older') older.push(m)
    else if (run === 'mid') mid.push(m)
    else newer.push(m)
  }
  return { older, mid, newer, overlap: [] }
}

function promptSequencesEqual(
  items: ServerMirror['items'],
  messages: SdkMessage[],
): boolean {
  let i = 0
  let m = 0
  let matched = 0
  // Advance each cursor to its next top-level prompt fingerprint (null when
  // exhausted). Pair them; mismatch or one-sided exhaustion -> not equal.
  const nextItemFp = (): string | null => {
    while (i < items.length) {
      const fp = promptContentFingerprint(items[i].msg)
      if (fp != null) return fp
      i++
    }
    return null
  }
  const nextMsgFp = (): string | null => {
    while (m < messages.length) {
      // Deliberately NOT projected before fingerprinting: projecting an
      // image-only prompt erases the image identity (every marker-substituted
      // copy fingerprints identically), which would false-drop a genuinely
      // different same-text prompt — the exact data loss promptContentFingerprint
      // exists to prevent. The residual cost is a one-time cosmetic duplicate
      // when an UN-BRIDGED prompt-only transcript's cached copy is degraded
      // (marker) and a cursor-less full replay re-sends the prompt: the
      // fingerprint mismatch appends the full copy once, after which its
      // fingerprint exists on-screen and later replays dedup against it.
      // Bridged sessions (the norm) never reach this fallback — their prompt
      // uuids match and the overlap bracket handles them exactly.
      const fp = promptContentFingerprint(messages[m])
      if (fp != null) return fp
      m++
    }
    return null
  }
  while (true) {
    const iFp = nextItemFp()
    const mFp = nextMsgFp()
    // Require at least one matched prompt AND simultaneous exhaustion, so a
    // payload with no top-level prompts on either side (attachments only) is
    // NOT dropped as "full overlap".
    if (iFp == null || mFp == null) return matched > 0 && iFp == null && mFp == null
    if (iFp !== mFp) return false
    matched++
    i++
    m++
  }
}

// applyMessage moved to message-pipeline.ts (Task 7). The reducer imports it
// from there and delegates the MESSAGE action. applyOptimisticUserMessage,
// ackUserMessage, applyMessageConsumed, applyMessageSteered, and
// clearSendingPlaceholders moved to user-message-lifecycle.ts; the reducer
// delegates the four user-message actions and uses clearSendingPlaceholders in
// the SESSION_TERMINATED branch. rememberPendingConsumed / PENDING_CONSUMED_CAP
// moved to transcript-log.ts (alongside stampMessageConsumed / stampMessageSteered).

// `rebuildIndexesFromMessages`, `updateIndexesMirror`, `drainPendingResults`,
// `prunePendingResults`, `pruneMapToLive`, `pruneSettledToLive`,
// `collectLiveToolUseIds`, and the parking helpers (`pendingResultKey`,
// `completionOwnerIds`, `resultOwnerKnown`, `resultIsSidechainChild`,
// `PENDING_RESULTS_CAP`) moved to index-pipeline.ts (the index-pipeline owner).
// `sweepAtTurnEnd` and `settleStaleLiveSubagents` (plus `isStaleLiveSubagent`,
// `PENDING_TIMEOUT_MS`, `EPOCH_PLAUSIBILITY_FLOOR`) moved to turn-status.ts.
// `windowLive` / `windowPage` / `windowEvict` (plus the private
// `freshWindowMessages` helper) moved to window-bridge.ts (Task 7 fix round 1
// — the seam that breaks the message-pipeline ↔ transcript-log value-import
// cycle). `prependMessages` (plus the private `countPromptOverlap` helper),
// `trimFront`, `evictMessages`, `updateTranscriptMirror`, the private
// `seqsForUuids` helper, and `MEMORY_ITEM_CAP` moved to transcript-log.ts
// (the transcript-log owner). The public ones are imported at the top;
// `MEMORY_ITEM_CAP` is re-exported for existing importers.
