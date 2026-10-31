import type { PermissionRequest, SdkMessage } from '../types'
import {
  createInitialClientIntent,
  createInitialServerMirror,
  type ClientIntent,
  type ServerMirror,
  type SessionAction,
  type SessionState,
  type TranscriptItem,
  withIntent,
  withMirror,
} from './types'
import {
  messageTouchesWorktree,
  msgTime,
  recomputeActiveWorktree,
  toTranscriptItem,
} from './normalize'
import { supersedeDraft } from './draft-state'
import { promptContentFingerprint } from '../../shared/prompt-fingerprint.js'
import {
  bumpGeneration,
  emptyWindow,
} from './seq-window'
import {
  flushLiveTurn,
  pruneFinalizedLiveTurnText,
  updateLiveTurnMirror,
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
  updateIndexesMirror,
  drainPendingResults,
} from './index-pipeline'
import {
  evictMessages,
  prependMessages,
  trimFront,
  updateTranscriptMirror,
  windowEvict,
  windowLive,
  windowPage,
} from './transcript-log'
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

function applyOptimisticUserMessage(state: SessionState, message: SdkMessage): SessionState {
  const mirror = state.mirror
  // Build the placeholder TranscriptItem. `prev` is the last RENDERED item —
  // which, post-refactor, is whichever placeholder is queued last (insertion
  // order) or, if none, the tail of mirror.items. We pass mirror tail as the
  // prev because compact-summary detection only fires on assistant/system
  // frames, and an optimistic user prompt's predecessor is always a server
  // frame in practice.
  const item = toTranscriptItem(message, mirror.items[mirror.items.length - 1])
  if (!item) return state

  // If the server's WS echo already arrived and was appended to mirror.items
  // before this optimistic insert ran, don't add a duplicate placeholder.
  // We mark that server item as a known-pending id so applyMessage's echo
  // path is a no-op on its NEXT arrival (the echo can land twice in some
  // reconnect paths).
  //
  // NOTE: This uses shallow === on `content`. For plain text strings this
  // works correctly. For multimodal messages (arrays), the ref comparison
  // always returns false — the safe direction (no false dedup).
  const last = mirror.items[mirror.items.length - 1]
  if (last && last.msg.type === 'user' && last.msg.message?.content === message.message?.content) {
    // Server echo landed first; nothing to do for the intent layer. The
    // placeholder is moot.
    return state
  }

  // Mark the placeholder as 'sending' so the user bubble renders a spinner.
  // The flag is implicitly cleared by the echo-merge in applyMessage, which
  // drops the placeholder from intent and appends the server's clean item to
  // mirror.items (which has no `sending` field). Stamp receivedAt locally so
  // the timestamp shows immediately.
  const placeholder: TranscriptItem = {
    ...item,
    sending: true,
    receivedAt: item.receivedAt ?? Date.now(),
  }
  const next = new Map(state.intent.pendingPlaceholders)
  next.set(placeholder.id, placeholder)
  return withIntent(state, { ...state.intent, pendingPlaceholders: next })
}

function ackUserMessage(
  state: SessionState,
  pendingId: string,
  serverUuid: string,
  receivedAt?: number,
): SessionState {
  // ACK flow: the REST POST returned the server-side uuid for an optimistic
  // placeholder. Two outcomes are possible — both must be idempotent against
  // the WS echo arriving before or after the ACK:
  //
  //   1. The WS echo has NOT landed yet. The placeholder still lives in
  //      intent.pendingPlaceholders. Re-key it to the server uuid, strip
  //      `sending`, and stamp receivedAt/consumedAt from what we know.
  //      The next echo for this uuid is a no-op (placeholder gone).
  //   2. The WS echo HAS landed. The placeholder was removed from intent
  //      by applyMessage. There's nothing to ack — return unchanged.
  const placeholder = state.intent.pendingPlaceholders.get(pendingId)
  if (!placeholder) return state

  const consumedAt = state.mirror.pendingConsumedMessages.get(serverUuid)
  const msg: SdkMessage = {
    ...placeholder.msg,
    uuid: serverUuid,
    ...(typeof receivedAt === 'number' ? { receivedAt } : {}),
    ...(typeof consumedAt === 'number' ? { consumedAt } : {}),
  }
  // Re-derive the TranscriptItem with the new uuid so its id matches the
  // server's. `prev` is unknown at this point — we pass undefined; compact-
  // summary detection on a user prompt is always false, so it's harmless.
  const updated = toTranscriptItem(msg, undefined)
  if (!updated) {
    // Couldn't rebuild — drop the placeholder anyway so the spinner clears.
    const next = new Map(state.intent.pendingPlaceholders)
    next.delete(pendingId)
    return withIntent(state, { ...state.intent, pendingPlaceholders: next })
  }
  // Carry sending=false implicitly (toTranscriptItem doesn't set it). Re-key
  // the map to the server uuid so the next echo (if any) can match.
  //
  // The re-key must PRESERVE the entry's position in the Map. A delete+set
  // moves the ack'd entry to the end, which (with another send still pending)
  // transiently renders the acked bubble BELOW the newer un-acked one — and
  // worse, breaks applyMessage's echo-merge, which consumes the OLDEST
  // placeholder on each top-level user echo in FIFO send order: after the
  // reorder the oldest entry is the WRONG one, so the echo eats the newer
  // placeholder and the acked one lingers as a duplicate bubble until the
  // turn-end sweep. Map preserves insertion order, so rebuilding the map
  // entry-by-entry (replacing the value at the ack'd entry's original slot)
  // keeps order === send order across ack/echo interleavings. This closes
  // the wrong-eat class ONLY for placeholders that eventually echo: a
  // placeholder removed without its echo (rollbackUserMessage after the
  // server nonetheless accepted, or a turn-end sweep racing a late echo)
  // still shifts the FIFO — a pre-existing edge accepted here, since
  // signature-based matching was explicitly deferred in applyMessage.
  const next = new Map<string, TranscriptItem>()
  for (const [key, value] of state.intent.pendingPlaceholders) {
    if (key === pendingId) next.set(updated.id, updated)
    else next.set(key, value)
  }

  // If the consumed signal already arrived, drop it from the mirror cache
  // since we've folded it into the placeholder's msg.
  let nextMirror = state.mirror
  if (typeof consumedAt === 'number' && state.mirror.pendingConsumedMessages.has(serverUuid)) {
    const pendingConsumedMessages = new Map(state.mirror.pendingConsumedMessages)
    pendingConsumedMessages.delete(serverUuid)
    nextMirror = { ...state.mirror, pendingConsumedMessages }
  }
  return {
    sessionId: state.sessionId,
    mirror: nextMirror,
    intent: { ...state.intent, pendingPlaceholders: next },
  }
}

function clearSendingPlaceholders(intent: ClientIntent): ClientIntent {
  // After a `result` frame the SDK has finished processing — any lingering
  // placeholders are abandoned. Drop them entirely (they'd otherwise spin
  // forever). The matching server messages are already in mirror.items by
  // this point (the result frame lands AFTER the user echo).
  if (intent.pendingPlaceholders.size === 0) return intent
  return { ...intent, pendingPlaceholders: new Map<string, TranscriptItem>() }
}

/** Flip a queued user message to 'consumed' when the live message-consumed
 *  frame arrives. Matches by uuid. No-op when the message isn't present yet
 *  (the frame raced ahead of the message broadcast) or is already consumed —
 *  in the race case the message will carry consumedAt on its own broadcast /
 *  the next replay, so we self-heal without tracking pending uuids. Mutates
 *  the message object's consumedAt in place (consistent with the server,
 *  where history and the live frame share one reference) and rebuilds just
 *  the affected TranscriptItem so deliveryStatus re-derives. */
/** MESSAGE_STEERED: stamp injectedAt / requeuedAt on the matching steered
 *  message and re-derive its deliveryStatus. Simpler than
 *  applyMessageConsumed: the initial broadcast carries steeredAt (the
 *  'injecting' state never arrives via this action), and the injected /
 *  requeued frames are pushed strictly after the broadcast, so the item is
 *  always present — a miss is a harmless no-op (replay's ring stamps are the
 *  durable truth). 'requeued' falls through to the queued→consumed flow:
 *  the msg keeps its stamps and deriveDeliveryStatus skips the steered
 *  branch once requeuedAt is present. */
function applyMessageSteered(state: SessionState, uuid: string, steerState: 'injected' | 'requeued'): SessionState {
  const mirror = state.mirror
  const idx = mirror.items.findIndex((it) => it.id === uuid)
  if (idx < 0) return state
  const item = mirror.items[idx]
  const stamp = steerState === 'injected' ? { injectedAt: Date.now() } : { requeuedAt: Date.now() }
  if (steerState === 'injected' && item.deliveryStatus === 'injected') return state
  const nextMsg: SdkMessage = { ...item.msg, ...stamp }
  const items = mirror.items.slice()
  items[idx] = { ...item, msg: nextMsg, deliveryStatus: steerState === 'injected' ? 'injected' : 'queued' }
  const mIdx = mirror.messages.findIndex(
    (m) => (typeof m.uuid === 'string' ? m.uuid : null) === uuid,
  )
  const messages = mirror.messages.slice()
  // Same rule as applyMessageConsumed: the swapped-in copy is built from the
  // ITEM's msg, so rescan only if either side touches a worktree.
  const worktreeTouched = mIdx >= 0 &&
    (messageTouchesWorktree(mirror.messages[mIdx]) || messageTouchesWorktree(nextMsg))
  if (mIdx >= 0) messages[mIdx] = nextMsg
  return withMirror(state, {
    ...mirror,
    items,
    messages,
    activeWorktree: worktreeTouched
      ? recomputeActiveWorktree(mirror.activeWorktree, messages)
      : mirror.activeWorktree,
  })
}

function applyMessageConsumed(state: SessionState, uuid: string, consumedAt: number): SessionState {
  const mirror = state.mirror
  // Also stamp a placeholder living in intent: the user message hasn't been
  // echoed by the server yet, so it isn't in mirror.items, but its bubble is
  // already rendered (via the buildSnapshot merge) and must flip from queued/
  // sending to consumed when the signal lands first. Without this branch the
  // post-refactor intent layer swallows the consumed signal until the echo —
  // a regression the pre-refactor code didn't have because placeholders lived
  // in items. We re-derive the placeholder so deliveryStatus is recomputed.
  const placeholder = state.intent.pendingPlaceholders.get(uuid)
  if (placeholder) {
    const nextMsg: SdkMessage = { ...placeholder.msg, consumedAt }
    const rebuilt = toTranscriptItem(nextMsg, undefined)
    const updated: TranscriptItem = rebuilt
      ? { ...rebuilt, sending: placeholder.sending }
      : { ...placeholder, msg: nextMsg, deliveryStatus: 'consumed' }
    const nextPlaceholders = new Map(state.intent.pendingPlaceholders)
    nextPlaceholders.set(uuid, updated)
    return withIntent(state, { ...state.intent, pendingPlaceholders: nextPlaceholders })
  }
  const idx = mirror.items.findIndex((it) => it.id === uuid)
  if (idx < 0) {
    if (mirror.pendingConsumedMessages.get(uuid) === consumedAt) return state
    const pendingConsumedMessages = rememberPendingConsumed(mirror.pendingConsumedMessages, uuid, consumedAt)
    return withMirror(state, { ...mirror, pendingConsumedMessages })
  }
  const item = mirror.items[idx]
  if (item.deliveryStatus === 'consumed') return state
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
  return withMirror(state, {
    ...mirror,
    items,
    messages,
    pendingConsumedMessages,
    activeWorktree: worktreeTouched
      ? recomputeActiveWorktree(mirror.activeWorktree, messages)
      : mirror.activeWorktree,
  })
}

// `MEMORY_ITEM_CAP` and `MEMORY_TRIM_SLACK` moved to transcript-log.ts (the
// transcript-log owner). The reducer re-exports MEMORY_ITEM_CAP from there so
// existing importers (`active-worktree.test.ts`) keep resolving.
const PENDING_CONSUMED_CAP = 64

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

// Exported for transcript-log.ts: the WINDOW_* handlers call applyMessage at
// runtime to apply freshly-windowed messages to the ordered log. The import
// is a live ESM binding; applyMessage is a hoisted function declaration, so
// the circular reference (reducer ↔ transcript-log) resolves at runtime —
// the call sites never fire at module-init. Task 7 moves applyMessage to
// message-pipeline.ts, which breaks the cycle (message-pipeline imports
// transcript-log; transcript-log imports message-pipeline; neither imports
// reducer.ts — the "no business module imports reducer.ts" end state).
export function applyMessage(state: SessionState, message: SdkMessage): SessionState {
  const mirror = state.mirror
  const messageUuid = typeof message.uuid === 'string' ? message.uuid : null
  const existingConsumedAt = messageUuid
    ? mirror.items.find((it) => it.id === messageUuid)?.msg.consumedAt
    : undefined
  const pendingConsumedAt = messageUuid ? mirror.pendingConsumedMessages.get(messageUuid) : undefined
  // Echo-merge: when the server's broadcast lands for a user message we sent
  // optimistically, drop the matching placeholder from intent. The server's
  // clean item then appends to mirror.items normally via updateTranscript
  // below — no in-place swap necessary now that placeholders don't live in
  // mirror.items.
  //
  // Guard: only match when the incoming message is a top-level user
  // message (parent_tool_use_id === null/undefined). Subagent tool_result
  // frames are also `type: 'user'` but should never consume a placeholder.
  const incomingParent = message.parent_tool_use_id
  let workingIntent = state.intent
  let placeholderConsumedAt: number | undefined
  if (
    message.type === 'user' &&
    workingIntent.pendingPlaceholders.size > 0 &&
    incomingParent == null
  ) {
    // Find the oldest placeholder — Maps preserve insertion order, so the
    // first key is the oldest send. Echoes arrive in send order, so this is
    // the correct match. If a multi-content match (e.g. by signature) is
    // ever needed, this is the place to add it; for now, order-based
    // matching mirrors the pre-refactor behaviour without the brittleness
    // of looking up by id in mirror.items.
    const oldestKey = workingIntent.pendingPlaceholders.keys().next().value
    if (typeof oldestKey === 'string') {
      // Forward any consumedAt previously stamped on the placeholder (via a
      // MESSAGE_CONSUMED frame that landed before this echo). The placeholder
      // is the only carrier of that state when it's been ack'd before the
      // server echo — pendingConsumedMessages was already cleared on ack.
      const placeholder = workingIntent.pendingPlaceholders.get(oldestKey)
      if (placeholder && typeof placeholder.msg.consumedAt === 'number') {
        placeholderConsumedAt = placeholder.msg.consumedAt
      }
      const nextPlaceholders = new Map(workingIntent.pendingPlaceholders)
      nextPlaceholders.delete(oldestKey)
      workingIntent = { ...workingIntent, pendingPlaceholders: nextPlaceholders }
    }
  }
  const effectiveConsumedAt = typeof pendingConsumedAt === 'number'
    ? pendingConsumedAt
    : (typeof placeholderConsumedAt === 'number' ? placeholderConsumedAt : existingConsumedAt)
  const incomingMessage: SdkMessage = typeof effectiveConsumedAt === 'number'
    ? { ...message, consumedAt: effectiveConsumedAt }
    : message

  // `api_retry` is a TRANSIENT rate-limit-retry indicator: it never enters
  // items/messages/IDB (keeping the transcript append-only). It is routed to
  // a dedicated slot here, and cleared by the next non-retry message.
  // updateTranscriptMirror is a no-op for api_retry (toTranscriptItem
  // returns null), so it neither appends nor needs the old in-place
  // replace/strip logic.
  //
  // No parent_tool_use_id check is needed (verified against the CLI binary's
  // own emitter, 2.1.x): the host loop converts an internal `api_error` into
  // `{type:'system', subtype:'api_retry', attempt, max_retries, …}` with NO
  // parent field, and the subagent-stream forwarding loop explicitly SKIPS
  // the child's api_retry frames — a subagent's retry instead rides a
  // `tool_progress` frame (data.type 'agent_api_retry', subagent_retry
  // payload), which our pump drops with every other tool_progress. So every
  // `system/api_retry` that reaches this reducer is a MAIN-thread retry.
  const isApiRetry = message.type === 'system' && message.subtype === 'api_retry'
  // `thinking_tokens` is a transient live estimate of the current thinking
  // block's token count (see toTranscriptItem — never a TranscriptItem). It
  // routes to `mirror.thinkingTokens` for the WorkingBubble, exactly like
  // api_retry routes to its slot. Unlike api_retry it is NOT cleared by every
  // other message: stream_event deltas interleave with thinking_tokens frames
  // during the same thinking phase, and clearing on them would flicker the
  // display off between estimates. It clears when the thinking block it
  // describes ends (any main-thread block-boundary frame — content_block_start
  // or the per-block `assistant` finalize) and on `result` (turn end).
  const isThinkingTokens = message.type === 'system' && message.subtype === 'thinking_tokens'
  // `stream_event` is a live-streaming delta (one per content chunk — hundreds
  // per heavy turn). It never enters items/messages (toTranscriptItem returns
  // null), but it drives the live-turn accumulator and the WorkingBubble phase.
  const isStreamEvent = message.type === 'stream_event'

  let thinkingTokens: number | null = mirror.thinkingTokens
  if (isThinkingTokens) {
    // NOTE: SDKThinkingTokensMessage carries no parent_tool_use_id — the
    // estimate is origin-blind at this layer (and the pump forwards every
    // frame). There is nothing to gate on; see the lifecycle note above.
    const estimate = (incomingMessage as { estimated_tokens?: unknown }).estimated_tokens
    thinkingTokens = typeof estimate === 'number' && Number.isFinite(estimate) ? estimate : null
  } else if (incomingMessage.type === 'result') {
    thinkingTokens = null
  } else if (incomingParent == null && incomingMessage.type === 'assistant') {
    // Durable per-block finalize ("one assistant message per completed content
    // block" — SDKAssistantMessage). Clears the estimate when its thinking
    // block completes, and — unlike the stream_event boundary below — this
    // frame is ring-persisted, so it also runs on a reconnect replay (missed
    // stream_events are never re-served) and in includePartialMessages:false
    // sessions. Without it a stale "~N tok" could ride a whole tool call.
    thinkingTokens = null
  } else if (incomingParent == null && isStreamEvent) {
    // Live block boundary: ANY content_block_start means the thinking block
    // the estimate described ("running total for the current thinking block"
    // — SDKThinkingTokensMessage) is over. Any block type clears, including
    // another thinking/redacted_thinking start — that is a NEW block whose own
    // estimates repaint within ms, while keeping the old count would let one
    // block's total ride the next (and never be overwritten if the new block
    // streams no estimates at all). Deliberately NO `user` clear: steer echoes,
    // queued-input echoes and <task-notification> injections are parentless
    // `user` frames that arrive mid-block and would wipe a live estimate, and
    // real turn changes are already covered by `result` (turn end) plus these
    // block boundaries (the new turn's first block).
    const ev = (incomingMessage as { event?: { type?: string } }).event
    if (ev?.type === 'content_block_start') thinkingTokens = null
  }

  const workingMirror: ServerMirror = {
    ...mirror,
    eventCount: mirror.eventCount + 1,
    apiRetry: isApiRetry ? incomingMessage : null,
    thinkingTokens,
  }

  let working: SessionState = {
    sessionId: state.sessionId,
    mirror: workingMirror,
    intent: workingIntent,
  }

  working = withMirror(working, updateLiveTurnMirror(working.mirror, incomingMessage))
  working = withMirror(working, updateTranscriptMirror(working.mirror, incomingMessage))
  working = withMirror(working, updateIndexesMirror(working.mirror, incomingMessage))
  // Live path: a tool_use that just seeded may have an orphan result parked
  // from an earlier out-of-order ingress — settle it now (see pendingResults).
  working = withMirror(working, drainPendingResults(working.mirror))
  // A finalized main-thread assistant message means its text now lives in the
  // transcript above — drop the duplicate from the live accumulator (see
  // pruneFinalizedLiveTurnText for the serial-response invariant this leans on).
  working = withMirror(working, pruneFinalizedLiveTurnText(working.mirror, incomingMessage))

  // A finalized main-thread assistant takes over the in-place draft row: the
  // row keeps its draft key (alias) so the hand-off updates in place instead
  // of remounting a fresh row.
  if (
    incomingMessage.type === 'assistant'
    && incomingMessage.parent_tool_use_id == null
    && working.mirror.draft
    && messageUuid
  ) {
    const { cleared, aliasEntry } = supersedeDraft(working.mirror.draft, messageUuid)
    working = withMirror(working, {
      ...working.mirror,
      draft: cleared,
      draftRowKeys: { ...working.mirror.draftRowKeys, [aliasEntry[0]]: aliasEntry[1] },
    })
  }

  if (messageUuid && working.mirror.pendingConsumedMessages.has(messageUuid)) {
    const pendingConsumedMessages = new Map(working.mirror.pendingConsumedMessages)
    pendingConsumedMessages.delete(messageUuid)
    working = withMirror(working, { ...working.mirror, pendingConsumedMessages })
  }

  if (incomingMessage.type === 'result') {
    // A draft still live at the turn's end is an interrupted half-card ("no
    // roll back"): freeze it as a session-memory partial row. A salvaged
    // partial response would have superseded the draft already (the MESSAGE
    // above), so this fires exactly when nothing salvaged it.
    const m = working.mirror
    const frozen = m.draft
      ? { ...m, frozenDrafts: [...m.frozenDrafts, m.draft], draft: null }
      : m
    // Turn-end sweep via the shared helper. The live-only concerns
    // (liveTurn=null, clearSendingPlaceholders) are applied on top.
    working = {
      sessionId: working.sessionId,
      mirror: { ...sweepAtTurnEnd(frozen), liveTurn: null },
      // Clear any lingering optimistic placeholders — the result frame means
      // the SDK has finished processing, so no server echo is expected anymore.
      intent: clearSendingPlaceholders(working.intent),
    }
  }

  // Bound in-memory growth. No-op until the transcript exceeds CAP + SLACK,
  // so the common append path stays allocation-free.
  working = trimFront(working)

  // Refusal-fallback retraction: evict the refused leg's already-streamed
  // partial messages. Two carriers, both idempotent (evictMessages no-ops on
  // unknown uuids):
  //   - assistant `supersedes` — evict-on-arrival for the replacement frame
  //     the CLI streams mid-turn;
  //   - system `model_refusal_fallback.retracted_message_uuids` — the
  //     end-of-turn audit record (this frame itself stays: it renders as the
  //     fallback notice and is the canonical replacement).
  // Runs through applyMessage so replay/disk-loaded transcripts evict too.
  const supersedes = incomingMessage.type === 'assistant'
    ? (incomingMessage as { supersedes?: unknown }).supersedes
    : undefined
  const retracted = incomingMessage.type === 'system' && incomingMessage.subtype === 'model_refusal_fallback'
    ? (incomingMessage as { retracted_message_uuids?: unknown }).retracted_message_uuids
    : undefined
  const evictUuids = [...(Array.isArray(supersedes) ? supersedes : []), ...(Array.isArray(retracted) ? retracted : [])]
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
  if (evictUuids.length > 0) {
    working = evictMessages(working, evictUuids)
  }

  return working
}

// `rebuildIndexesFromMessages`, `updateIndexesMirror`, `drainPendingResults`,
// `prunePendingResults`, `pruneMapToLive`, `pruneSettledToLive`,
// `collectLiveToolUseIds`, and the parking helpers (`pendingResultKey`,
// `completionOwnerIds`, `resultOwnerKnown`, `resultIsSidechainChild`,
// `PENDING_RESULTS_CAP`) moved to index-pipeline.ts (the index-pipeline owner).
// `sweepAtTurnEnd` and `settleStaleLiveSubagents` (plus `isStaleLiveSubagent`,
// `PENDING_TIMEOUT_MS`, `EPOCH_PLAUSIBILITY_FLOOR`) moved to turn-status.ts.
// `windowLive` / `windowPage` / `windowEvict` (plus the private
// `freshWindowMessages` helper), `prependMessages` (plus the private
// `countPromptOverlap` helper), `trimFront`, `evictMessages`,
// `updateTranscriptMirror`, the private `seqsForUuids` helper, and
// `MEMORY_ITEM_CAP` moved to transcript-log.ts (the transcript-log owner).
// The public ones are imported at the top; `MEMORY_ITEM_CAP` is re-exported
// for existing importers.
