import type { PermissionRequest, SdkMessage } from '../types'
import {
  createInitialClientIntent,
  createInitialServerMirror,
  type ClientIntent,
  type LiveTurnState,
  type ServerMirror,
  type SessionAction,
  type SessionState,
  type TranscriptItem,
  type WorkflowStatus,
  withIntent,
  withMirror,
} from './types'
import {
  extractPlanContent,
  getPlanResultDecisions,
  getPlanToolUseIds,
  getSubagentStarts,
  getToolResultEntries,
  getToolResultIds,
  getToolResultOutcomes,
  getToolUseStarts,
  getWorkflowChildStarts,
  getWorkflowStarts,
  isTrimBoundary,
  parseTaskNotification,
  toTranscriptItem,
  topLevelUserPromptSignature,
} from './normalize'
import {
  extractQuestionAnswers,
  getQuestionToolUseIds,
  parseQuestionAnswersMessage,
} from '../utils/question-answers'
import { toolDebug, toolDebugEnabled } from './debug'
import { parseWorkflowOutput } from './workflow-meta'
import { promptContentFingerprint } from '../../shared/prompt-fingerprint.js'

export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'REPLAY_REPLACE':
      return replayReplace(state, action.messages, action.permissions)
    case 'PREPEND_MESSAGES':
      return prependMessages(state, action.messages)
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
    case 'PERMISSION_REQUEST': {
      const permissionPending = new Map(state.mirror.permissionPending)
      permissionPending.set(action.request.id, action.request)
      const pidToToolUseId = new Map(state.mirror.pidToToolUseId)
      if (action.request.toolUseID) pidToToolUseId.set(action.request.id, action.request.toolUseID)
      return withMirror(state, { ...state.mirror, permissionPending, pidToToolUseId })
    }
    case 'PERMISSION_RESOLVED': {
      // Allocate fresh Maps lazily — most PERMISSION_RESOLVED frames
      // arrive for permissions we already cleaned up locally (the user
      // optimistically decided), so cloning four Maps unconditionally
      // burns CPU and breaks reference equality for selectors that
      // depend on stable Map identity (e.g. PlanCard memoization).
      let permissionPending = state.mirror.permissionPending
      let pidToToolUseId = state.mirror.pidToToolUseId
      let permissionDecisions = state.mirror.permissionDecisions
      let planStatus = state.mirror.planStatus
      let questionAnswers = state.mirror.questionAnswers
      let changed = false
      if (permissionPending.has(action.id)) {
        permissionPending = new Map(permissionPending)
        permissionPending.delete(action.id)
        changed = true
      }
      const toolUseId = pidToToolUseId.get(action.id)
      if (toolUseId) {
        permissionDecisions = new Map(permissionDecisions)
        permissionDecisions.set(toolUseId, action.decision.behavior)
        // Cap entries — a session with thousands of approved tool runs
        // (long autonomous agent loops) would otherwise grow this Map
        // forever. Keys are tool_use_ids that have already been
        // surfaced in the UI; evicting the oldest just means a
        // (typically already-scrolled-out-of-view) plan/tool card no
        // longer flips its badge from "pending" to "approved/rejected"
        // on a future scroll-back. Maps preserve insertion order, so
        // keys().next() is the oldest.
        const PERMISSION_DECISIONS_CAP = 1024
        while (permissionDecisions.size > PERMISSION_DECISIONS_CAP) {
          const oldest = permissionDecisions.keys().next().value
          if (oldest === undefined) break
          permissionDecisions.delete(oldest)
        }
        changed = true
        if (planStatus.has(toolUseId)) {
          planStatus = new Map(planStatus)
          planStatus.set(toolUseId, action.decision.behavior === 'allow' ? 'approved' : 'rejected')
        }
        // AskUserQuestion answers ride on the resolution `message` field
        // (built by server/permission-helpers.ts:formatQuestionAnswers).
        // Normally the JSON answers payload also lands as a tool_result
        // block on a follow-up user message — extractQuestionAnswers in
        // updateIndexes() parses that and replaces the pending entry.
        // But the SDK does not always echo a corresponding tool_result
        // through the Query stream after a canUseTool deny+message
        // short-circuit, which leaves the inline QuestionCard rendering
        // 'pending' forever even though the user already answered.
        // Decoding the same JSON here closes that gap — questionAnswers
        // flips from [] to the parsed entries the moment the resolution
        // frame lands, independent of whether tool_result follows.
        // Scope: only when we previously seeded a pending entry for
        // this toolUseId (i.e. it really was an AskUserQuestion call).
        if (questionAnswers.has(toolUseId) && action.decision.questionResolution === 'clarified') {
          questionAnswers = new Map(questionAnswers)
          questionAnswers.set(toolUseId, [{ question: '', answer: null, clarified: true }])
        } else if (questionAnswers.has(toolUseId) && action.decision.message) {
          const parsed = parseQuestionAnswersMessage(action.decision.message)
          if (parsed.length > 0) {
            questionAnswers = new Map(questionAnswers)
            questionAnswers.set(toolUseId, parsed)
          }
        }
      }
      if (pidToToolUseId.has(action.id)) {
        pidToToolUseId = new Map(pidToToolUseId)
        pidToToolUseId.delete(action.id)
        changed = true
      }
      if (!changed) return state
      return withMirror(state, {
        ...state.mirror,
        permissionPending,
        pidToToolUseId,
        permissionDecisions,
        planStatus,
        questionAnswers,
      })
    }
    case 'CONTEXT_USAGE':
      return withMirror(state, { ...state.mirror, contextUsage: action.usage })
    case 'MESSAGE_CONSUMED':
      return applyMessageConsumed(state, action.uuid, action.consumedAt)
    case 'ERROR':
      // ERROR straddles the boundary: the WS error frame writes it (server-
      // originated) but the lifecycle (clearError) is client-owned. We park
      // it on the intent layer because that's the layer the client mutates
      // freely — and importantly, a REPLAY_REPLACE rebuilding mirror must
      // NOT incidentally clear a stale error the user hasn't dismissed yet.
      return withIntent(state, { ...state.intent, error: action.message })
    case 'LIVE_TURN_FLUSH': {
      const liveTurn = state.mirror.liveTurn
      if (!liveTurn || !liveTurn.dirty) return state
      return withMirror(state, {
        ...state.mirror,
        liveTurn: {
          ...liveTurn,
          flushedText: liveTurn.flushedText + liveTurn.textChunks.join(''),
          textChunks: [],
          dirty: false,
        },
      })
    }
    case 'DISMISS_SUBAGENT': {
      // Flip an in-flight subagent (running/background/pending) to `dismissed`
      // so it leaves the WorkingBubble chip set. Uses a dedicated `dismissed`
      // status (NOT `interrupted`) so the inline SubagentCard renders a neutral
      // state instead of a false error. The result merge only processes
      // status === 'running' records, and the completion branch excludes
      // `dismissed`, so a dismissed record stays dismissed for BOTH sync and
      // async subagents — an explicit dismiss is a deliberate terminal state.
      // Also records the id on intent.dismissedSubagents so the dismiss
      // survives mirror rebuilds (refresh/replay re-derive activeSubagents
      // from the message stream, which has no record of the dismiss).
      // No-op for already-settled records.
      const existing = state.mirror.activeSubagents.get(action.toolUseId)
      if (!existing || (existing.status !== 'running' && existing.status !== 'background' && existing.status !== 'pending')) return state
      const activeSubagents = new Map(state.mirror.activeSubagents)
      activeSubagents.set(action.toolUseId, {
        ...existing,
        status: 'dismissed',
        endedAt: existing.endedAt ?? existing.startedAt,
      })
      const dismissedSubagents = new Set(state.intent.dismissedSubagents)
      dismissedSubagents.add(action.toolUseId)
      return withIntent(
        withMirror(state, { ...state.mirror, activeSubagents }),
        { ...state.intent, dismissedSubagents },
      )
    }
    case 'CLEAR_TRANSCRIPT': {
      // Same full wipe as RESET, but the post-/clear session is live and
      // empty with no pending replay (the WS subscription persists, the
      // server doesn't re-replay, system/init isn't broadcast). Mark the
      // transcript ready so MessageList shows the empty-state instead of
      // an infinite skeleton.
      const mirror = { ...createInitialServerMirror(), replayReady: true }
      return {
        sessionId: state.sessionId,
        mirror,
        intent: createInitialClientIntent(),
      }
    }
    default:
      return state
  }
}

function replayReplace(
  prevState: SessionState,
  messages: SdkMessage[],
  permissions: PermissionRequest[],
): SessionState {
  const prevMirror = prevState.mirror
  // If the server replay is empty but we already have cached messages
  // (from localStorage), keep the cache as a fallback. This prevents
  // blank screens when the server's history ring has been trimmed or
  // the session was garbage collected.
  if (messages.length === 0 && prevMirror.items.length > 0) {
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
  if (messages.length > 0 && prevMirror.items.length > 0) {
    let state: SessionState = withMirror(prevState, {
      ...prevMirror,
      liveTurn: null,
      replayReady: true,
    })
    for (const permission of permissions) {
      state = reduceSessionState(state, { type: 'PERMISSION_REQUEST', request: permission })
    }
    const { older, newer } = splitReplayAgainstCache(messages, prevMirror.items)
    if (older.length > 0) state = prependMessages(state, older)
    for (const message of newer) {
      state = applyMessage(state, message)
    }
    // Full-overlap drop: the split treated the whole payload as already on
    // screen (older=[], newer=[]), so applyMessage never ran and
    // lastMessageUuid stays at the stale cached value (a server-minted prompt
    // uuid the post-restart ring doesn't carry). Advance it to the replay's
    // last message uuid — that is the newest the server has, and (after a
    // restart re-seed) the uuid the server's ring actually recognizes. Without
    // this, the next reconnect's sinceUuid misses the ring and the server
    // re-sends the same full replay on every reconnect until a live message
    // happens to land.
    if (older.length === 0 && newer.length === 0 && messages.length > 0) {
      const lastUuid = typeof messages[messages.length - 1].uuid === 'string'
        ? (messages[messages.length - 1].uuid as string)
        : null
      if (lastUuid && state.mirror.lastMessageUuid !== lastUuid) {
        state = withMirror(state, { ...state.mirror, lastMessageUuid: lastUuid })
      }
    }
    const finalLen = state.mirror.items.length
    const prevLen = prevMirror.items.length
    if (finalLen < prevLen) {
      console.warn(
        `[replayReplace] MERGE: items shrunk ${prevLen} → ${finalLen} ` +
        `(replay=${messages.length}, older=${older.length}, newer=${newer.length})`,
      )
    }
    // Never synthesize a turn end while merging a replay into an existing
    // client cache. This is the live/incremental reconnect path, and the replay
    // may legitimately end with an in-progress synchronous Agent tool_use and
    // no result frame yet. Historical disk hydration is handled only by the
    // fresh-state path below.
    return state
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
  for (const message of messages) {
    working = applyMessage(working, message)
  }
  // A fresh replay without result frames is swept only when every frame came
  // from the persisted CLI transcript. A new tab can subscribe to a live
  // session mid-turn with an empty client cache; that fresh in-memory replay
  // also has no result yet and must preserve a running synchronous subagent.
  const isDiskReplay = messages.length > 0 && messages.every((m) => m.restoredFromDisk === true)
  const sweptMirror = isDiskReplay && !messages.some((m) => m.type === 'result')
    ? sweepAtTurnEnd(working.mirror)
    : working.mirror
  return withMirror(prevState, { ...sweptMirror, replayReady: true })
}

/** Overlap-anchor key: the message uuid, or null when the frame must NOT
 *  anchor the overlap bracket.
 *
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
  if (topLevelUserPromptSignature(msg) != null) return null // a prompt — never an anchor
  return typeof msg.uuid === 'string' ? msg.uuid : null
}

/** Split a replay payload into the portion OLDER than the cached transcript
 *  and the portion NEWER than it, dropping anything that overlaps the cache.
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
 *  has zero overlap, so `firstOverlap` stays -1 and the entire payload falls
 *  into `newer` — byte-identical to the original blind append. The resume-seed
 *  / full-replay case overlaps the cache tail, so that overlap is dropped
 *  instead of double-appended.
 *
 *  We use the first/last anchor bracket rather than per-message membership: a
 *  payload is a contiguous transcript slice, so a uuid that appears mid-payload
 *  but not in the cache (e.g. an assistant frame the cache trimmed) must still
 *  be kept, not dropped as a false non-overlap. */
export function splitReplayAgainstCache(
  messages: SdkMessage[],
  items: ServerMirror['items'],
): { older: SdkMessage[]; newer: SdkMessage[] } {
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
      newer: messages.slice(lastOverlap + 1),
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
    return { older: [], newer: [] }
  }
  // No overlap → clean reconnect (or a disjoint older batch). Treat the whole
  // payload as newer; applyMessage append preserves the original behaviour.
  return { older: [], newer: messages }
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
 *     older batch through updateIndexes — NOT a full rebuild. A full rebuild
 *     would clobber statuses that were set out-of-band (e.g. an ExitPlanMode
 *     plan flipped to 'approved' via PERMISSION_RESOLVED without a
 *     tool_result). The older batch's ids are disjoint from the live tail,
 *     so additive indexing is both sufficient and non-destructive. */
function prependMessages(state: SessionState, older: SdkMessage[]): SessionState {
  if (older.length === 0) return state
  const mirror = state.mirror

  const existingIds = new Set<string>()
  for (const it of mirror.items) existingIds.add(it.id)

  // How many trailing prompts of the incoming disk batch are the SAME
  // logical messages as the leading prompts already on screen (the uuid
  // boundary that uuid-dedup can't bridge — see the doc comment). Match the
  // batch's trailing prompt run against the on-screen leading prompt run
  // element-wise, from the boundary inward, by content signature.
  const overlap = countPromptOverlap(older, mirror.items)
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

  let next: SessionState = withMirror(state, {
    ...mirror,
    items: [...newItems, ...mirror.items],
    messages: [...newMessages, ...mirror.messages],
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
  let leadRun = 0
  while (leadRun < items.length && topLevelUserPromptSignature(items[leadRun].msg) != null) {
    leadRun++
  }
  let n = 0
  while (n < older.length && n < leadRun) {
    const batchSig = topLevelUserPromptSignature(older[older.length - 1 - n])
    if (batchSig == null) break // batch tail is no longer a top-level prompt
    // items[leadRun - 1 - n] is within the leading run, so its signature is
    // guaranteed non-null — only the content needs to match.
    if (batchSig !== topLevelUserPromptSignature(items[leadRun - 1 - n].msg)) break
    n++
  }
  return n
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
  const next = new Map(state.intent.pendingPlaceholders)
  next.delete(pendingId)
  next.set(updated.id, updated)

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
  if (mIdx >= 0) messages[mIdx] = nextMsg
  let pendingConsumedMessages: ReadonlyMap<string, number> = mirror.pendingConsumedMessages
  if (pendingConsumedMessages.has(uuid)) {
    const nextConsumedMessages = new Map(pendingConsumedMessages)
    nextConsumedMessages.delete(uuid)
    pendingConsumedMessages = nextConsumedMessages
  }
  return withMirror(state, { ...mirror, items, messages, pendingConsumedMessages })
}

// --- Memory bound: front-trim the in-memory transcript -----------------
// The server's history ring is capped (historyCap = 500), but the client's
// items/messages arrays grow unbounded as long as the WS keeps pushing — a
// long autonomous-agent session can accumulate tens of thousands of frames.
// We keep at most MEMORY_ITEM_CAP items in memory; trimmed messages remain
// recoverable by scrolling up (loadOlder re-reads them from disk).
export const MEMORY_ITEM_CAP = 1000
// Hysteresis: only trim once we exceed CAP + SLACK, then drop back to CAP. So
// trimming runs once every SLACK appends (not every message), keeping the
// common append path allocation-free.
const MEMORY_TRIM_SLACK = 256
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

/** Union of every tool_use_id referenced by `items` — both the tool_use
 *  (assistant) and tool_result (user) sides. Used to prune the toolUseId-keyed
 *  lifecycle maps to live keys after a front-trim. */
function collectLiveToolUseIds(items: ServerMirror['items']): Set<string> {
  const live = new Set<string>()
  for (const it of items) {
    const m = it.msg
    for (const id of getToolUseStarts(m)) live.add(id)
    for (const id of getPlanToolUseIds(m)) live.add(id)
    for (const id of getQuestionToolUseIds(m)) live.add(id)
    for (const id of getToolResultIds(m)) live.add(id)
  }
  return live
}

/** Return a Map filtered to keys present in `live`, reusing the original
 *  reference when nothing is dropped (keeps selector identity stable). */
function pruneMapToLive<V>(map: Map<string, V>, live: Set<string>): Map<string, V> {
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

/** Drop the oldest items/messages once the in-memory transcript exceeds
 *  MEMORY_ITEM_CAP + MEMORY_TRIM_SLACK, bringing it back down to ~CAP.
 *
 *  The cut point is snapped FORWARD to the first isTrimBoundary message so the
 *  new items[0] is both on-disk AND not a plain top-level user prompt. This
 *  matters for two downstream consumers:
 *    - loadOlder()'s first page anchors `beforeUuid` on items[0]. That uuid
 *      MUST exist on disk, or the server falls back to the newest page and
 *      reverse-paging silently stalls. isTrimBoundary (not the looser
 *      isDiskStableMsg) guarantees a persisted frame — see its doc comment.
 *    - countPromptOverlap() dedups the leading user-prompt run against an
 *      incoming disk page by content signature (uuids differ disk vs memory).
 *      A non-empty leading prompt run after a trim could resurface as
 *      duplicates on the next loadOlder; an empty run (overlap 0) cannot.
 *
 *  Snapping past a long sidechain (subagent) run can keep somewhat fewer than
 *  CAP — acceptable, and bounded because every real turn ends with a
 *  main-thread assistant frame.
 *
 *  The five toolUseId-keyed lifecycle maps (toolStatus, toolResults,
 *  planStatus, planContent, questionAnswers) are pruned to ids still
 *  referenced by the retained items so they don't leak. permissionDecisions
 *  self-caps at 1024 and activeSubagents clears each result frame, so neither
 *  is touched. */
function trimFront(state: SessionState): SessionState {
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
  return withMirror(state, {
    ...mirror,
    items,
    messages,
    toolStatus: pruneMapToLive(mirror.toolStatus, live),
    toolResults: pruneMapToLive(mirror.toolResults, live),
    planStatus: pruneMapToLive(mirror.planStatus, live),
    planContent: pruneMapToLive(mirror.planContent, live),
    questionAnswers: pruneMapToLive(mirror.questionAnswers, live),
  })
}

/** Turn-end sweep: flip still-running tools to 'error', still-running
 *  subagents to 'interrupted', still-background subagents to 'pending',
 *  and still-running workflows to 'interrupted'. Called from applyMessage
 *  (on each `result` frame — the live path) and from replayReplace (once
 *  after replay — because the CLI transcript has no `result` frames, so the
 *  per-turn sweep never fires during disk-loaded replay; this one call
 *  catches all unswept records at once).
 *
 *  Identity-stable: returns the same mirror reference when nothing needed
 *  sweeping (clone-on-write per Map). */
/** Client-side safety-net timeout for stranded `pending` background
 *  subagents. A `pending` record (parent turn ended) is normally cleared by
 *  the SERVER watcher synthesizing a task_notification when the subagent's
 *  own transcript reaches a terminal stop_reason. But if that watcher is lost
 *  (server restart cleared the in-memory watcher map, the SDK's bounded resume
 *  replay didn't re-include the launch ack, or the subagent transcript path
 *  drifted) the record strands at `pending` forever — the WorkingBubble chip
 *  reappears on every parent turn and never clears. This timeout flips such a
 *  stranded record to `interrupted` once its last child-frame activity
 *  (`endedAt`) is older than the threshold, so the chip clears.
 *
 *  Generous (30 min) and RECOVERABLE: a late real completion still overrides
 *  (the task_notification completion branch accepts 'interrupted'). It only
 *  fires for `pending` (post-turn) records whose `endedAt` is stale — a
 *  still-running subagent advances `endedAt` via its child frames, so it is
 *  never false-stopped. The one residual risk (a post-turn subagent
 *  mid-inference with no child frames for >30 min) is rare and recoverable. */
const PENDING_TIMEOUT_MS = 30 * 60 * 1000

function sweepAtTurnEnd(mirror: ServerMirror): ServerMirror {
  let toolStatus = mirror.toolStatus
  let activeSubagents = mirror.activeSubagents
  let activeWorkflows = mirror.activeWorkflows

  // toolStatus: running → error
  const swept = toolDebugEnabled() ? [] as string[] : null
  for (const [id, status] of toolStatus) {
    if (status !== 'running') continue
    if (toolStatus === mirror.toolStatus) toolStatus = new Map(toolStatus)
    toolStatus.set(id, 'error')
    if (swept) swept.push(id)
  }
  if (swept && swept.length > 0) {
    toolDebug('SWEEP running→error at turn end', { ids: swept })
  }

  // subagents: running (sync orphan) → interrupted; background (async,
  // still working) → pending. Completed records survive.
  for (const [id, sub] of activeSubagents) {
    if (sub.status === 'running') {
      if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
      activeSubagents.set(id, { ...sub, status: 'interrupted', endedAt: sub.endedAt ?? sub.startedAt })
    } else if (sub.status === 'background') {
      if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
      activeSubagents.set(id, { ...sub, status: 'pending', endedAt: sub.endedAt ?? sub.startedAt })
    }
  }

  // Stale-pending safety net (see PENDING_TIMEOUT_MS): flip `pending`
  // records whose last child-frame activity is older than the threshold to
  // `interrupted`. `endedAt` is advanced by child frames (the async-detector
  // branch), so a still-running subagent never trips this — only one that has
  // gone quiet long enough to be considered stranded. Runs on every turn end
  // and on replay, so a stranded chip clears without needing a reload.
  const now = Date.now()
  // Plausibility floor: a real server-stamped receivedAt is always post-2001
  // epoch ms (> 1e12). A value below that is a non-epoch sentinel (a corrupt
  // stamp or a test fixture using relative offsets) — the safety net must not
  // treat 1970-era values as "30 min stale" and false-stop on them.
  const EPOCH_PLAUSIBILITY_FLOOR = 1_000_000_000_000
  for (const [id, sub] of activeSubagents) {
    if (sub.status !== 'pending') continue
    const lastActivity = sub.endedAt ?? sub.startedAt
    if (typeof lastActivity !== 'number' || lastActivity < EPOCH_PLAUSIBILITY_FLOOR) continue
    if (now - lastActivity <= PENDING_TIMEOUT_MS) continue
    if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
    activeSubagents.set(id, { ...sub, status: 'interrupted' })
  }

  // workflows: running → interrupted; flip still-running children too.
  for (const [id, wf] of activeWorkflows) {
    const runningChildren = wf.childAgents.some((c) => c.status === 'running')
    if (wf.status === 'running' || runningChildren) {
      if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
      activeWorkflows.set(id, {
        ...wf,
        status: wf.status === 'running' ? 'interrupted' : wf.status,
        endedAt: wf.endedAt ?? wf.startedAt,
        childAgents: wf.childAgents.map((c) =>
          c.status === 'running'
            ? { ...c, status: 'interrupted' as const, endedAt: c.endedAt ?? c.startedAt }
            : c,
        ),
      })
    }
  }

  if (toolStatus === mirror.toolStatus && activeSubagents === mirror.activeSubagents && activeWorkflows === mirror.activeWorkflows) {
    return mirror
  }
  return { ...mirror, toolStatus, activeSubagents, activeWorkflows }
}

function applyMessage(state: SessionState, message: SdkMessage): SessionState {
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
  // a dedicated slot here, and cleared by the next non-retry message. It also
  // does NOT advance lastMessageUuid — it must not anchor sinceUuid (the
  // server ring still holds the frame, so a reconnect whose sinceUuid points
  // at the prior non-retry message re-sends the api_retry and re-arms the
  // slot). updateTranscriptMirror is a no-op for api_retry (toTranscriptItem
  // returns null), so it neither appends nor needs the old in-place
  // replace/strip logic.
  const isApiRetry = message.type === 'system' && message.subtype === 'api_retry'
  // `stream_event` is a live-streaming delta (one per content chunk — hundreds
  // per heavy turn). It must NOT advance lastMessageUuid: the uuid-anchored WS
  // incremental replay (`sinceUuid`) relies on the cursor pointing at a durable
  // message the server ring still holds. Stream_event uuids are ephemeral —
  // never persisted to the disk transcript and (since the server ring fix)
  // never in the ring — so a sinceUuid pointing at one misses the ring and
  // forces a full replay on every reconnect. Anchoring on durable messages
  // keeps the incremental path working.
  const isStreamEvent = message.type === 'stream_event'

  const workingMirror: ServerMirror = {
    ...mirror,
    eventCount: mirror.eventCount + 1,
    ...(messageUuid && !isApiRetry && !isStreamEvent ? { lastMessageUuid: messageUuid } : {}),
    apiRetry: isApiRetry ? incomingMessage : null,
  }

  let working: SessionState = {
    sessionId: state.sessionId,
    mirror: workingMirror,
    intent: workingIntent,
  }

  working = withMirror(working, updateLiveTurnMirror(working.mirror, incomingMessage))
  working = withMirror(working, updateTranscriptMirror(working.mirror, incomingMessage))
  working = withMirror(working, updateIndexesMirror(working.mirror, incomingMessage))

  if (messageUuid && working.mirror.pendingConsumedMessages.has(messageUuid)) {
    const pendingConsumedMessages = new Map(working.mirror.pendingConsumedMessages)
    pendingConsumedMessages.delete(messageUuid)
    working = withMirror(working, { ...working.mirror, pendingConsumedMessages })
  }

  if (incomingMessage.type === 'result') {
    // Turn-end sweep via the shared helper. The live-only concerns
    // (liveTurn=null, clearSendingPlaceholders) are applied on top.
    working = {
      sessionId: working.sessionId,
      mirror: { ...sweepAtTurnEnd(working.mirror), liveTurn: null },
      // Clear any lingering optimistic placeholders — the result frame means
      // the SDK has finished processing, so no server echo is expected anymore.
      intent: clearSendingPlaceholders(working.intent),
    }
  }

  // Bound in-memory growth. No-op until the transcript exceeds CAP + SLACK,
  // so the common append path stays allocation-free.
  working = trimFront(working)

  return working
}

function updateTranscriptMirror(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  const prev = mirror.items[mirror.items.length - 1]
  const item = toTranscriptItem(message, prev)
  if (!item) return mirror

  return {
    ...mirror,
    items: [...mirror.items, item],
    messages: [...mirror.messages, item.msg],
  }
}

/** Replay a list of cached messages through `updateIndexes()` to
 *  reconstruct the lifecycle index maps (`toolStatus`, `planStatus`,
 *  `planContent`, `questionAnswers`, `activeSubagents`).
 *
 *  Used by `SessionStore` on hydration: only `messages`/`items` are
 *  persisted to localStorage (the indexes are derived state). Without
 *  this rebuild, every cached tool_use card would render the default
 *  "running" badge forever — `useToolStatus` falls back to 'running'
 *  for any toolUseId not in the map, and the seeding step that puts it
 *  there only runs on live `MESSAGE` actions, not on hydrate. The
 *  symptom we hit was older Read/Grep/Bash cards stuck on the spinner
 *  after a page reload even though the conversation had moved on.
 *
 *  We deliberately bypass `updateTranscript` — the items array is
 *  already populated from the cache; we only need the index side
 *  effects. Calling `applyMessage` here would double-append items.
 *
 *  Note: skips `liveTurn` and `pendingUserMessageIds` work too, which is
 *  fine — those are ephemeral and re-derived from the live stream. */
export function rebuildIndexesFromMessages(
  state: SessionState,
  messages: readonly SdkMessage[],
): SessionState {
  let mirror = state.mirror
  for (const message of messages) {
    mirror = updateIndexesMirror(mirror, message)
  }
  return withMirror(state, mirror)
}

/** Re-apply client-side dismissals to a freshly-rebuilt mirror. After a
 *  hydrate / replay rebuilds `activeSubagents` from the message stream, the
 *  records the user dismissed come back as `running`/`background`/`pending`
 *  (the stream has no record of the dismiss). This flips them back to
 *  `dismissed` (stamping `endedAt` the same way DISMISS_SUBAGENT does) and
 *  prunes ids that no longer have a dismissable record (absent post-/clear,
 *  or settled naturally to done/interrupted/rejected). Ids whose record is
 *  already `dismissed` are kept so a future rebuild can re-apply. Idempotent. */
export function reapplyDismissed(state: SessionState): SessionState {
  if (state.intent.dismissedSubagents.size === 0) return state
  let activeSubagents = state.mirror.activeSubagents
  let mirrorChanged = false
  for (const id of state.intent.dismissedSubagents) {
    const sub = activeSubagents.get(id)
    if (!sub) continue
    if (sub.status !== 'running' && sub.status !== 'background' && sub.status !== 'pending') continue
    if (activeSubagents === state.mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
    activeSubagents.set(id, { ...sub, status: 'dismissed', endedAt: sub.endedAt ?? sub.startedAt })
    mirrorChanged = true
  }
  // Prune ids whose record no longer exists or settled naturally; keep ids
  // that are still dismissed or dismissable so a future rebuild can re-apply.
  let dismissed = state.intent.dismissedSubagents
  for (const id of state.intent.dismissedSubagents) {
    const sub = activeSubagents.get(id)
    if (!sub) {
      if (dismissed === state.intent.dismissedSubagents) dismissed = new Set(dismissed)
      ;(dismissed as Set<string>).delete(id)
      continue
    }
    if (sub.status !== 'dismissed' && sub.status !== 'running' && sub.status !== 'background' && sub.status !== 'pending') {
      if (dismissed === state.intent.dismissedSubagents) dismissed = new Set(dismissed)
      ;(dismissed as Set<string>).delete(id)
    }
  }
  const intent = dismissed === state.intent.dismissedSubagents ? state.intent : { ...state.intent, dismissedSubagents: dismissed }
  const mirror = mirrorChanged ? { ...state.mirror, activeSubagents } : state.mirror
  if (mirror === state.mirror && intent === state.intent) return state
  return withIntent(withMirror(state, mirror), intent)
}

function updateIndexesMirror(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  let changed = false
  let planStatus = mirror.planStatus
  let planContent = mirror.planContent
  let questionAnswers = mirror.questionAnswers
  let toolStatus = mirror.toolStatus
  let toolResults = mirror.toolResults
  let activeSubagents = mirror.activeSubagents
  let activeWorkflows = mirror.activeWorkflows

  // Generic tool status — seed 'running' for every tool_use the assistant
  // emits (excluding ones with their own status map: Plan/Subagent/Question).
  const toolStarts = getToolUseStarts(message)
  if (toolStarts.length > 0) {
    toolStatus = new Map(toolStatus)
    for (const id of toolStarts) {
      // Don't clobber a status that's already terminal — could happen in
      // theory if a duplicate tool_use lands during replay.
      if (!toolStatus.has(id)) toolStatus.set(id, 'running')
    }
    toolDebug('seed running', { ids: toolStarts, total: toolStatus.size })
    changed = true
  }

  // Flip to 'success' or 'error' when the matching tool_result lands.
  // Most user messages don't carry tool_results, so defer the Map clone
  // until we actually have a status to update — same trick as the
  // subagent branch below.
  if (message.type === 'user' && toolStatus.size > 0) {
    const outcomes = getToolResultOutcomes(message)
    if (outcomes.length > 0) {
      let touched = false
      // Only allocated when diagnostics are on — keeps the hot path free.
      const orphans = toolDebugEnabled() ? [] as string[] : null
      for (const { toolUseId, outcome } of outcomes) {
        const prev = toolStatus.get(toolUseId)
        // No seeded entry for this result's tool_use_id. Either the
        // result is for an excluded tool (Plan/Subagent/Question — fine),
        // or the id genuinely doesn't match any tool_use we seeded — the
        // latter is the "id-mismatch" failure mode that strands a card on
        // 'running' forever. We can't tell the two apart here, so log it
        // for offline diagnosis rather than guessing.
        if (!prev) {
          if (orphans) orphans.push(toolUseId)
          continue
        }
        if (prev === outcome) continue
        if (!touched) {
          if (toolStatus === mirror.toolStatus) toolStatus = new Map(toolStatus)
          touched = true
        }
        toolStatus.set(toolUseId, outcome)
        toolDebug('flip', { id: toolUseId, from: prev, to: outcome })
      }
      if (orphans && orphans.length > 0) {
        toolDebug('ORPHAN result (no matching seeded tool_use)', {
          ids: orphans,
          seededIds: Array.from(toolStatus.keys()),
        })
      }
      if (touched) changed = true
    }
  }

  // Capture tool_result payloads so the originating tool_use card can
  // render the result inline (instead of a separate bubble). Only store
  // results whose tool_use_id was seeded into `toolStatus` — that set is
  // exactly the generic tool cards (Plan/Question/Subagent are excluded by
  // getToolUseStarts' TOOL_STATUS_EXCLUDE and own their result rendering).
  // Same lazy-clone discipline as the status flip above.
  if (message.type === 'user' && toolStatus.size > 0) {
    const entries = getToolResultEntries(message)
    if (entries.length > 0) {
      let touched = false
      for (const { toolUseId, content, isError } of entries) {
        if (!toolStatus.has(toolUseId)) continue
        if (toolResults.has(toolUseId)) continue
        if (!touched) {
          if (toolResults === mirror.toolResults) toolResults = new Map(toolResults)
          touched = true
        }
        toolResults.set(toolUseId, { content, isError })
      }
      if (touched) changed = true
    }
  }

  const planIds = getPlanToolUseIds(message)
  if (planIds.length > 0) {
    planStatus = new Map(planStatus)
    for (const id of planIds) planStatus.set(id, 'pending')
    changed = true
  }

  const planResults = getPlanResultDecisions(message, planStatus)
  if (planResults.length > 0) {
    if (planStatus === mirror.planStatus) planStatus = new Map(planStatus)
    for (const result of planResults) planStatus.set(result.toolUseId, result.status)
    changed = true
  }

  // Extract plan body from ExitPlanMode tool_result outputs.  The CLI
  // injects plan content from disk into the output (not the input), so
  // we capture it here for the PermissionDialog and inline PlanCard.
  // tool_result blocks only ever land on user messages — gating on
  // msg.type avoids allocating the Set for every assistant/system/result.
  if (message.type === 'user' && planStatus.size > 0) {
    const knownPlanIds = new Set(planStatus.keys())
    const extracted = extractPlanContent(message, knownPlanIds)
    if (extracted.length > 0) {
      if (planContent === mirror.planContent) planContent = new Map(planContent)
      for (const { toolUseId, plan } of extracted) planContent.set(toolUseId, plan)
      changed = true
    }
  }

  // Track AskUserQuestion tool_use ids so the inline QuestionCard can
  // render a "pending" state immediately (before the user answers).
  // We seed with an empty answers array; the tool_result handler below
  // replaces it when the JSON answers payload lands.
  const questionIds = getQuestionToolUseIds(message)
  if (questionIds.length > 0) {
    let touched = false
    for (const id of questionIds) {
      if (questionAnswers.has(id)) continue
      if (!touched) {
        questionAnswers = new Map(questionAnswers)
        touched = true
      }
      questionAnswers.set(id, [])
    }
    if (touched) changed = true
  }

  // Parse JSON answers from AskUserQuestion tool_results (built by
  // server/permission-helpers.ts:formatQuestionAnswers).  Same gating
  // pattern as the plan-content branch above — only user messages
  // carry tool_results, and we only care if we've seen the matching
  // tool_use first.
  if (message.type === 'user' && questionAnswers.size > 0) {
    const knownQuestionIds = new Set(questionAnswers.keys())
    const extracted = extractQuestionAnswers(message, knownQuestionIds)
    if (extracted.length > 0) {
      if (questionAnswers === mirror.questionAnswers) questionAnswers = new Map(questionAnswers)
      for (const { toolUseId, answers } of extracted) questionAnswers.set(toolUseId, answers)
      changed = true
    }
  }

  const starts = getSubagentStarts(message)
  if (starts.length > 0) {
    activeSubagents = new Map(activeSubagents)
    // Stamp `startedAt` once per subagent so the chip can show an
    // elapsed time. Preserve any existing value if we re-encounter the
    // same toolUseId (e.g. duplicate dispatch during replay).
    //
    // Prefer the server-stamped `message.receivedAt` — it travels with the
    // SDK frame across replays, so a page refresh that rebuilds indexes
    // from cached messages recovers the original wall-clock start. Without
    // this fallback, the elapsed timer resets to 0 on every reload.
    const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
    for (const subagent of starts) {
      const existing = activeSubagents.get(subagent.toolUseId)
      activeSubagents.set(subagent.toolUseId, {
        ...subagent,
        startedAt: existing?.startedAt ?? subagent.startedAt ?? stamp,
        endedAt: existing?.endedAt,
        status: existing?.status ?? 'running',
        toolCount: existing?.toolCount ?? 0,
        // Frame-timing detection (child after result) overrides the input
        // flag, so preserve an existing value across replay re-encounters.
        isAsync: existing?.isAsync ?? subagent.isAsync,
      })
    }
    changed = true
  }

  const subagentResultEntries = getToolResultEntries(message)
  if (subagentResultEntries.length > 0 && activeSubagents.size > 0) {
    // Don't delete on tool_result — keep the record around so the
    // overlay can be reopened after completion. Flip status to 'done'
    // ('interrupted' when the result carries is_error, so a failed
    // subagent doesn't show a green check) and stamp endedAt. Also
    // capture the result payload so SubagentCard can merge the
    // subagent's returned output inline at the bottom of the card —
    // mirrors the generic ToolCard merge. The "running"/"background"
    // filter elsewhere drops completed subagents from the WorkingBubble
    // chip row automatically.
    //
    // EXCEPTION — async/background launch ack: an async subagent's Agent
    // tool_result is a launch acknowledgement, not completion. Flip to
    // 'background' instead (no endedAt/result) and let the
    // task-notification completion branch below finish the lifecycle.
    //
    // Most turns include tool_results unrelated to subagents, so defer
    // the Map clone until we actually have a matching id — otherwise
    // every Bash/Read/Edit hop allocates a fresh Map for nothing.
    let touched = false
    // Prefer the server-stamped wall-clock time so a page refresh that
    // re-reduces cached messages recovers the original completion time
    // (otherwise endedAt jumps forward to "now" on reload, blowing up the
    // displayed elapsed range for completed subagents).
    const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
    for (const { toolUseId, content, isError } of subagentResultEntries) {
      const existing = activeSubagents.get(toolUseId)
      if (!existing || existing.status !== 'running') continue
      if (!touched) {
        if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
        touched = true
      }
      // Async/background launch ack: the Agent tool_result is just a launch
      // acknowledgement ("Async agent launched successfully … agentId"),
      // NOT the subagent's completion — the real output streams later as
      // child frames and the completion lands as a <task-notification>.
      // Flip to 'background' (still shown in the WorkingBubble chip row) and
      // deliberately DO NOT set endedAt/result: the ack time isn't the real
      // completion time and the ack text isn't the real output. Detected via
      // the run_in_background input flag (most reliable, when the SDK stamped
      // one) or, when absent, by sniffing the ack text — a synchronous
      // subagent's real tool_result never matches the ack signature.
      const ackText = typeof content === 'string' ? content : resultContentToText(content)
      // An explicit `run_in_background: false` opts out of ack-sniffing
      // entirely (a synchronous subagent's real tool_result must not be
      // mistaken for a launch ack even if its text happens to contain the
      // signature). Sniff only when isAsync is true (definitive) or
      // undefined (no flag — fall back to the ack signature).
      const isAck = !isError && existing.isAsync !== false && (
        existing.isAsync === true ||
        (typeof ackText === 'string' && /^async agent launched successfully/i.test(ackText))
      )
      if (isAck) {
        activeSubagents.set(toolUseId, { ...existing, status: 'background' })
      } else {
        activeSubagents.set(toolUseId, {
          ...existing,
          status: isError ? 'interrupted' : 'done',
          endedAt: stamp,
          result: { content, isError },
        })
      }
    }
    changed = changed || touched
  }

  // Extend a subagent's endedAt to the latest child frame's receivedAt.
  //
  // For an async/background subagent the Agent tool_result is just a launch
  // ack ("Async agent launched successfully … agentId") that arrives within
  // ms of the tool_use — well before the subagent's real work streams as
  // child frames (parent_tool_use_id === subagent id). The result-merge
  // branch above flips the record to 'background' WITHOUT setting endedAt
  // (the ack time isn't the real run time), so without this extension the
  // card shows no elapsed at all until completion. Keep advancing endedAt to
  // each child frame so the chip/card timer reflects real work. The subagent
  // emits no dedicated end frame of its own, so the last child frame before
  // the <task-notification> is the de-facto completion signal. For a
  // synchronous subagent the tool_result already lands last, so
  // this is a no-op (stamp ≤ existing.endedAt). Fires for any child frame
  // (assistant text, tool_use, internal tool_result) — the latest wins.
  if (activeSubagents.size > 0) {
    const parentId = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : ''
    if (parentId) {
      const existing = activeSubagents.get(parentId)
      // Only advance endedAt/isAsync for LIVE records (running/background/
      // pending). A dismissed/interrupted/done/rejected record is settled —
      // a late child frame (an async subagent still streaming after the user
      // dismissed it or after completion) must NOT advance its endedAt, or the
      // card's frozen elapsed display would jump forward.
      if (existing && (existing.status === 'running' || existing.status === 'background' || existing.status === 'pending')) {
        const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
        // A child frame arriving AFTER the Agent tool_result is the
        // signature of an async/background subagent: the tool_result was a
        // launch ack, not the completion (sync subagents' tool_result lands
        // LAST). Flip isAsync on the first such frame — it stays true after.
        // Use `status === 'background' || 'pending'` (set ONLY by the
        // result-merge / sweep branches — 'background' for an ack, 'pending'
        // for an ack whose parent turn then ended) rather than `result !=
        // null`: the toolCount branch below also writes `result` from child
        // text, so a sync subagent with 2+ text-bearing child frames would
        // otherwise mislabel as async on the second frame. Status itself is
        // NOT touched here — a 'background'/'pending' record stays as-is
        // (still working) and just gets its endedAt advanced. 'pending' is
        // included because a background subagent's child frames can keep
        // streaming after the parent turn ended (the sweep moved it to
        // 'pending'); they're still proof of async.
        const nowAsync = existing.isAsync === true ? true
          : existing.status === 'background' || existing.status === 'pending'
        const endedAtChanged = existing.endedAt == null || stamp > existing.endedAt
        const asyncChanged = existing.isAsync !== nowAsync && nowAsync
        if (endedAtChanged || asyncChanged) {
          if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
          activeSubagents.set(parentId, {
            ...existing,
            ...(endedAtChanged ? { endedAt: stamp } : {}),
            ...(asyncChanged ? { isAsync: true } : {}),
          })
          changed = true
        }
      }
    }
  }

  // Count tool_use blocks in assistant messages that belong to a subagent
  // (identified by parent_tool_use_id). This pre-computes the value that
  // SubagentCard previously scanned the full message list to compute.
  //
  // Also capture the subagent's own text output into `result`. For an
  // async/background subagent the Agent tool_result is just a launch ack
  // (internal metadata — "Async agent launched successfully … agentId"),
  // not the real output; the real output streams as text blocks in these
  // child assistant frames. The last text-bearing child frame wins, which
  // is the subagent's final response. Processing order makes this safe for
  // both shapes: sync subagent → tool_result lands LAST and re-overrides
  // `result` via the merge branch above; async subagent → ack lands first,
  // child text overrides it here.
  if (message.type === 'assistant' && activeSubagents.size > 0) {
    const parentId = message.parent_tool_use_id
    if (typeof parentId === 'string') {
      const existing = activeSubagents.get(parentId)
      // Same non-live guard as the async-detector above: don't mutate settled
      // (done/interrupted/dismissed/rejected) records — late child frames
      // from an async subagent that completed or was dismissed must not
      // advance toolCount/result or churn the Map identity.
      if (existing && (existing.status === 'running' || existing.status === 'background' || existing.status === 'pending')) {
        const content = message.message?.content
        if (Array.isArray(content)) {
          let newTools = 0
          const textBlocks: Array<{ type: 'text'; text: string }> = []
          for (const b of content as Array<{ type?: string; text?: unknown }>) {
            if (b.type === 'tool_use') newTools++
            else if (b.type === 'text' && typeof b.text === 'string') {
              textBlocks.push({ type: 'text', text: b.text })
            }
          }
          if (newTools > 0 || textBlocks.length > 0) {
            if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
            activeSubagents.set(parentId, {
              ...existing,
              toolCount: existing.toolCount + newTools,
              ...(textBlocks.length > 0
                ? { result: { content: textBlocks, isError: false } }
                : {}),
            })
            changed = true
          }
        }
      }
    }
  }

  // Task-notification completion for async/background subagents. The Agent
  // tool_result was a launch ack (status flipped to 'background' above); the
  // real completion arrives as EITHER a harness `<task-notification>` user-
  // role XML injection OR an SDK `system`/`task_notification` frame — both
  // carry the originating Agent tool_use_id (the XML path always, the system
  // frame optionally). Match it back to the background record and flip to
  // 'done' ('interrupted' on failed/stopped), stamping endedAt to the
  // notification's receivedAt (the true completion moment, ≥ the last child
  // frame the async-detector branch advanced endedAt to). Mirrors the
  // synchronous result-merge so SubagentCard merges the output inline.
  //
  // `result` is only filled when no child text frame already captured it:
  // the async subagent's real output streamed as child assistant text
  // (authoritative), and the notification's <result> is the same content
  // repackaged — don't clobber. The SDK system-frame path carries no inline
  // result body (it lives in output_file), so fall back to summary.
  // parseTaskNotification returns null for shapes without a matchable
  // tool_use_id (notably the system frame when its optional tool_use_id is
  // absent) — the XML path then carries completion.
  // Parsed lazily: only when at least one subagent is active can a
  // completion signal possibly match, so skip the parse entirely for the
  // common no-subagents session (every assistant text frame, every Bash
  // tool_result, etc.). parseTaskNotification itself short-circuits on
  // message type, but avoiding the call is cheaper still on this hot path.
  const taskNotification = activeSubagents.size > 0 ? parseTaskNotification(message) : null
  if (taskNotification) {
    const existing = activeSubagents.get(taskNotification.toolUseId)
    // Accept 'background' (normal: ack seen, still in the dispatch turn) AND
    // 'running' (the launch-ack tool_result was lost — a WS gap / replay hole
    // — so the record never flipped to 'background'; the completion signal is
    // still authoritative and must flip it to 'done') AND 'pending' (the
    // parent turn already ended and the turn-end sweep moved a still-
    // 'background' record to 'pending' — the async subagent kept running and
    // its completion is arriving now, possibly turns later) AND 'interrupted'
    // (the server watcher's maxMs backstop may have synthesized a 'stopped'
    // frame that flipped the record to 'interrupted' while the subagent was
    // still legitimately running; a later REAL completion must be able to
    // override that synthesized stop, otherwise the false 'stopped' poisons
    // the record permanently — see server/subagent-watcher.ts). A real user
    // interrupt can also leave 'interrupted', but a task-notification only
    // arrives when the subagent actually settled, so overriding is correct in
    // both cases. A synchronous subagent never receives a task-notification,
    // so accepting 'running'/'interrupted' can't mis-flip a sync record.
    // 'dismissed' stays excluded: an explicit user dismiss is a deliberate
    // terminal state a late notification must not revive.
    if (existing && (existing.status === 'background' || existing.status === 'running' || existing.status === 'pending' || existing.status === 'interrupted')) {
      if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
      const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
      const isError = taskNotification.status !== 'completed'
      const resultContent = taskNotification.result ?? taskNotification.summary ?? ''
      activeSubagents.set(taskNotification.toolUseId, {
        ...existing,
        status: isError ? 'interrupted' : 'done',
        endedAt: stamp,
        // A task-notification only ever targets an async subagent, so stamp
        // isAsync definitively (the ack may have been lost, leaving isAsync
        // unset if no child frame arrived to trip the async-detector).
        isAsync: true,
        // Don't clobber an existing (child-text-captured) result, AND don't
        // set a result when the notification carries no content (notably a
        // synthesized `stopped` from the watcher backstop, whose summary is
        // '') — otherwise the empty result would block a later REAL
        // completion from populating the subagent's actual output.
        ...(existing.result || resultContent === '' ? {} : { result: { content: resultContent, isError } }),
      })
      changed = true
    }
  }

  // 鈹€ Workflow index 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // Mirrors the subagent indexing above, but for the Workflow orchestration tool.
  // A Workflow's own tool_use seeds a record (label/phases); its child agents
  // arrive as subagent-shaped tool_use blocks in sidechain frames whose
  // parent_tool_use_id is the Workflow id. We index those children (with their
  // phase tag) so the overlay can render the phase tree without re-scanning.

  // Seed / refresh Workflow records from the Workflow tool_use blocks.
  const wfStarts = getWorkflowStarts(message)
  if (wfStarts.length > 0) {
    if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
    // Prefer server-stamped wall-clock so replay/refresh keeps the original
    // workflow start instead of resetting to now.
    const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
    for (const wf of wfStarts) {
      const existing = activeWorkflows.get(wf.toolUseId)
      activeWorkflows.set(wf.toolUseId, {
        ...wf,
        // Preserve startedAt/endedAt/status/childAgents/result across replay
        // re-encounters — only fill in what's missing. `phases` is re-parsed
        // from input each time (it's static), which is harmless and keeps the
        // record correct if the input shape ever changes.
        startedAt: existing?.startedAt ?? stamp,
        endedAt: existing?.endedAt,
        status: existing?.status ?? 'running',
        childAgents: existing?.childAgents ?? [],
        result: existing?.result,
      })
    }
    changed = true
  }

  // Capture the Workflow's OWN tool_result (the synthesized summary that lands
  // on the MAIN thread, i.e. a user frame with no parent_tool_use_id). Flip
  // the record to done/interrupted and stash the result for inline rendering.
  // Reuses the same getToolResultEntries scan — we just match against the
  // Workflow ids instead of generic tool ids.
  if (message.type === 'user' && activeWorkflows.size > 0) {
    const wfResults = getToolResultEntries(message)
    if (wfResults.length > 0) {
      let touched = false
      // Prefer server-stamped wall-clock; falls back to now for messages
      // restored from disk that lack receivedAt.
      const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
      for (const { toolUseId, content, isError } of wfResults) {
        const existing = activeWorkflows.get(toolUseId)
        if (!existing || existing.status !== 'running') continue
        if (!touched) {
          if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
          touched = true
        }
        // Parse WorkflowOutput (status/taskType/runId/scriptPath/sessionUrl)
        // from the result content. Null when the content isn't a
        // WorkflowOutput-shaped JSON payload (e.g. a plain summary string) —
        // in that case the remote/runId/scriptPath fields stay undefined and
        // the record keeps working at its previous fidelity.
        const parsedOut = parseWorkflowOutput(content)
        activeWorkflows.set(toolUseId, {
          ...existing,
          status: isError ? 'interrupted' : 'done',
          endedAt: stamp,
          result: { content, isError },
          // Authoritative completion metadata (null-safe: parsedOut may be null).
          taskType: parsedOut?.taskType ?? existing.taskType,
          sessionUrl: parsedOut?.sessionUrl ?? existing.sessionUrl,
          runId: parsedOut?.runId ?? existing.runId,
          scriptPath: parsedOut?.scriptPath ?? existing.scriptPath,
          remote:
            parsedOut?.status === 'remote_launched' ||
            parsedOut?.taskType === 'remote_agent' ||
            existing.remote === true,
          // Rescue a still-generic label with the authoritative workflow name
          // (the script parse may have failed or the workflow was invoked by
          // `name`, so label could still be 'Workflow' at this point).
          label:
            existing.label === 'Workflow' && parsedOut?.workflowName
              ? parsedOut.workflowName
              : existing.label,
        })
      }
      changed = changed || touched
    }
  }

  // Index the Workflow's child agents. An assistant frame inside a Workflow's
  // sidechain carries parent_tool_use_id = the Workflow id; any subagent-shaped
  // tool_use blocks in it are this Workflow's children. getWorkflowChildStarts
  // returns them with their phase tag + the parentId they belong to.
  if (message.type === 'assistant' && activeWorkflows.size > 0) {
    const { parentId, children } = getWorkflowChildStarts(message)
    if (parentId && children.length > 0) {
      const wf = activeWorkflows.get(parentId)
      if (wf) {
        if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
        const byId = new Map(wf.childAgents.map((c) => [c.toolUseId, c]))
        // Server-stamped wall-clock survives replay; falls back to now
        // for disk-restored frames without receivedAt.
        const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
        for (const child of children) {
          const existing = byId.get(child.toolUseId)
          byId.set(child.toolUseId, {
            ...child,
            startedAt: existing?.startedAt ?? stamp,
            endedAt: existing?.endedAt,
            status: existing?.status ?? 'running',
            toolCount: existing?.toolCount ?? 0,
            result: existing?.result,
          })
        }
        activeWorkflows.set(parentId, { ...wf, childAgents: Array.from(byId.values()) })
        changed = true
      }
    }

    // Also tally tool_use blocks inside a child's own sidechain (a child agent
    // spawned by the Workflow runs its own tools — count them per child so a
    // chip can show "4 tools"). A child's sidechain frame has
    // parent_tool_use_id = the CHILD's tool_use id, not the Workflow's, so we
    // look up which child (across all active workflows) owns that id.
    const childParentId = message.parent_tool_use_id
    if (typeof childParentId === 'string') {
      const content = message.message?.content
      if (Array.isArray(content)) {
        let newTools = 0
        for (const b of content as Array<{ type?: string }>) {
          if (b.type === 'tool_use') newTools++
        }
        if (newTools > 0) {
          // Find the workflow + child whose toolUseId === childParentId.
          for (const [wfId, wf] of activeWorkflows) {
            const child = wf.childAgents.find((c) => c.toolUseId === childParentId)
            if (!child || child.status !== 'running') continue
            if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
            const updatedChild = { ...child, toolCount: child.toolCount + newTools }
            activeWorkflows.set(wfId, {
              ...wf,
              childAgents: wf.childAgents.map((c) =>
                c.toolUseId === childParentId ? updatedChild : c,
              ),
            })
            changed = true
            break
          }
        }
      }
    }
  }

  // Flip a Workflow child's status when its tool_result lands. A child's
  // result is a tool_result block whose tool_use_id is the CHILD's id; it
  // arrives in a user frame inside the Workflow's sidechain (parent_tool_use_id
  // = the Workflow id). Match against every active workflow's child index.
  if (message.type === 'user' && activeWorkflows.size > 0) {
    const childResults = getToolResultEntries(message)
    if (childResults.length > 0) {
      let touched = false
      // Prefer server-stamped wall-clock so child completion times survive
      // replay/refresh instead of jumping forward to now.
      const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
      for (const [wfId, wf] of activeWorkflows) {
        let childChanged = false
        const updatedChildren = wf.childAgents.map((c) => {
          if (c.status !== 'running') return c
          const match = childResults.find((r) => r.toolUseId === c.toolUseId)
          if (!match) return c
          childChanged = true
          return {
            ...c,
            status: (match.isError ? 'interrupted' : 'done') as WorkflowStatus,
            endedAt: stamp,
            result: { content: match.content, isError: match.isError },
          }
        })
        if (childChanged) {
          if (!touched) {
            if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
            touched = true
          }
          activeWorkflows.set(wfId, { ...wf, childAgents: updatedChildren })
        }
      }
      changed = changed || touched
    }
  }

  return changed
    ? { ...mirror, planStatus, planContent, questionAnswers, toolStatus, toolResults, activeSubagents, activeWorkflows }
    : mirror
}

// ── Token-rate sliding window ──────────────────────────────────────
const RATE_WINDOW_MS = 3000      // sliding-window span (balanced responsiveness)
const RATE_CHAR_THROTTLE_MS = 500  // min gap between char-path sample pushes
const RATE_SAMPLE_CAP = 60         // ring length hard cap (safety)
const CHARS_PER_TOKEN = 4          // char→token ratio, matches Claude Code's rough estimate

/** Push a (t, cumulativeTokens) sample into the sliding window and recompute
 *  the rate. Returns the fields that changed so callers spread them into the
 *  liveTurn they're building. Prunes samples older than RATE_WINDOW_MS; with
 *  <2 samples (or non-positive token delta) it keeps the existing rate
 *  rather than nulling it — so a frozen value survives a long idle until
 *  fresh samples re-establish the rate. */
function pushRateSample(liveTurn: LiveTurnState, now: number, tokens: number): Partial<LiveTurnState> {
  const samples = [...liveTurn.samples, { t: now, tokens }].filter(
    (s) => s.t >= now - RATE_WINDOW_MS,
  )
  const capped = samples.length > RATE_SAMPLE_CAP
    ? samples.slice(samples.length - RATE_SAMPLE_CAP)
    : samples

  let tokenRate = liveTurn.tokenRate
  if (capped.length >= 2) {
    const first = capped[0]
    const last = capped[capped.length - 1]
    const dt = (last.t - first.t) / 1000
    const dtokens = last.tokens - first.tokens
    if (dt > 0 && dtokens > 0) {
      tokenRate = Math.round(dtokens / dt)
    }
  }

  return tokenRate !== liveTurn.tokenRate
    ? { samples: capped, tokenRate }
    : { samples: capped }
}

function updateLiveTurnMirror(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  if (message.type !== 'stream_event') return mirror
  const event = message.event as Record<string, unknown> | undefined
  if (!event || typeof event.type !== 'string') return mirror

  let liveTurn = mirror.liveTurn
  if (!liveTurn) {
    liveTurn = {
      turnId: typeof message.uuid === 'string' ? message.uuid : `turn:${mirror.eventCount + 1}`,
      phase: null,
      textChunks: [],
      flushedText: '',
      tokenRate: null,
      startedAt: Date.now(),
      lastDeltaAt: Date.now(),
      dirty: false,
      totalChars: 0,
      lastRateUpdate: Date.now(),
      writingStartedAt: null,  // Track when actual writing starts
      samples: [],
      hasRealTokens: false,
    }
  }

  if (event.type === 'message_delta') {
    const usage = (event as { usage?: Record<string, unknown> }).usage
    const outputTokens = usage?.output_tokens
    if (typeof outputTokens === 'number') {
      const now = Date.now()

      // First real sample: reset the window so char-estimate samples are
      // discarded and the estimate→real switch can't cause a level jump.
      // The displayed rate is kept as-is until 2 real samples exist.
      const next = liveTurn.hasRealTokens
        ? pushRateSample(liveTurn, now, outputTokens)
        : { hasRealTokens: true, samples: [{ t: now, tokens: outputTokens }] }

      liveTurn = {
        ...liveTurn,
        ...next,
        outputTokens,
        lastDeltaAt: now,
      }
    }
  } else if (event.type === 'content_block_start') {
    const block = (event as { content_block?: Record<string, unknown> }).content_block
    if (block?.type === 'thinking') {
      liveTurn = { ...liveTurn, phase: 'thinking' }
    } else if (block?.type === 'text') {
      // Mark when actual writing starts (skip thinking phase)
      liveTurn = {
        ...liveTurn,
        phase: 'writing',
        writingStartedAt: liveTurn.writingStartedAt ?? Date.now(),
      }
    } else if (block?.type === 'tool_use') {
      liveTurn = { ...liveTurn, phase: { type: 'tool_use', name: String(block.name ?? 'tool') } }
    }
  } else if (event.type === 'content_block_delta') {
    const delta = (event as { delta?: Record<string, unknown> }).delta
    const text = delta?.text
    if (typeof text === 'string') {
      const now = Date.now()
      const newTotalChars = liveTurn.totalChars + text.length

      // Estimate token rate from character flow. Only when we have a writing
      // phase (not just tool_use), real tokens haven't taken over, and enough
      // time has passed since the last char sample (throttle). Pushes through
      // the SAME sliding window as the real path so the two stay unified.
      const hasWritingPhase = liveTurn.writingStartedAt !== null
      const estimatedTokens = Math.round(newTotalChars / CHARS_PER_TOKEN)

      let next: Partial<LiveTurnState> = { totalChars: newTotalChars }
      if (
        !liveTurn.hasRealTokens &&
        hasWritingPhase &&
        now - liveTurn.lastRateUpdate >= RATE_CHAR_THROTTLE_MS &&
        estimatedTokens > 0 &&
        estimatedTokens > (liveTurn.samples[liveTurn.samples.length - 1]?.tokens ?? 0)
      ) {
        next = { ...next, ...pushRateSample(liveTurn, now, estimatedTokens), lastRateUpdate: now }
      }

      liveTurn = {
        ...liveTurn,
        ...next,
        textChunks: [...liveTurn.textChunks, text],
        lastDeltaAt: now,
        dirty: true,
      }
    }
  } else if (event.type === 'message_stop') {
    liveTurn = {
      ...liveTurn,
      outputTokens: undefined,
    }
  }

  return { ...mirror, liveTurn }
}

/** Flatten a tool_result `content` payload to a plain string for signature
 *  sniffing (used by the async-ack detector). Accepts a string directly or
 *  an array of content blocks (joining the `text` blocks). Returns '' for
 *  anything else — the ack signature regex simply won't match. Local to the
 *  reducer so it doesn't depend on normalize.ts's private textOfContent. */
function resultContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: unknown }>)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}
