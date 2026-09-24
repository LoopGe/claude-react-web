import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSessionLastMessageUuid, getSessionStore, useSessionField } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import { isDiskStableMsg } from '../session-store/normalize'
import { clearAllSessionStorage } from '../session-store/store'
import type { ActiveSubagent, ActivePhase, PlanStatus, ToolResultEntry, ToolStatus, TranscriptItem } from '../session-store/types'
import { useWsHub, useWsHubStatus } from './useWsHub'
import { api } from './useApi'
import { randomId } from '../utils/uuid'
import type { WsServerFrame } from '../ws-types'
import type { ElicitationRequestUi, ElicitationResolved, PermissionRequest, PermissionResolved, SdkMessage, SkillFrontmatter, TaskRecordUi, UserDialogRequestUi, DialogResolved } from '../types'
import { extractMessagePlainText } from '../../shared/search/extract'

/** The disk-stable uuid of a message, or null. A message whose uuid matches
 *  between the in-memory ring and the on-disk transcript can anchor the first
 *  history page; plain user PROMPT uuids are minted server-side at send() time
 *  and do NOT match disk, so they return null. The type-level rule lives in
 *  isDiskStableMsg. (The reducer's front-trim uses the stricter isTrimBoundary
 *  — this scan can tolerate loose matches because it walks past them to a real
 *  one, but a forced boundary cannot. See isTrimBoundary's doc comment.) */
function diskStableUuid(msg: SdkMessage): string | null {
  if (typeof msg.uuid !== 'string') return null
  return isDiskStableMsg(msg) ? msg.uuid : null
}

interface HistoryPageResponse {
  messages: SdkMessage[]
  totalCount: number
  startIndex: number
  hasMore: boolean
}

export interface ContextUsage {
  totalTokens?: number
  maxTokens?: number
  rawMaxTokens?: number
  percentage?: number
  model?: string
  /** Tokens written to the cache on this turn. Present when the source
   *  iteration reports it; absent otherwise. */
  cacheCreationTokens?: number
  /** Tokens served from cache on this turn (cache hit). Present when the
   *  source iteration reports it; absent otherwise. */
  cacheReadTokens?: number
  /** Output tokens the model generated on this API call. Present when the
   *  source reports it; absent otherwise. */
  outputTokens?: number
  /** Token count at which the SDK's auto-compact triggers. Present once a
   *  `result` has supplied the model's context window; the bar renders
   *  "X% until auto-compact" from it. */
  autoCompactThreshold?: number
  /** The model's advertised max output tokens, surfaced so the draggable
   *  marker can invert a threshold position back into Settings.autoCompactWindow
   *  exactly (mirror of the server's LiteContextUsage.maxOutputTokens). */
  maxOutputTokens?: number
  skills?: {
    includedSkills: number
    totalSkills: number
    tokenCount: number
    skillFrontmatter?: SkillFrontmatter[]
  }
  agents?: {
    tokenCount: number
    agents?: Array<{ agentType: string; source: string; tokens: number }>
  }
  memoryFiles?: { tokenCount: number }
  mcpTools?: { tokenCount: number }
  /** Canonical context rows from the SDK control response (0.3.268). Classify
   *  on `kind` — 'used' occupies the window, 'free' is the remainder,
   *  'buffer' is the compaction reserve, 'deferred' is an out-of-window tool
   *  schema listed for awareness — never on the English `name`. */
  categories?: Array<{
    name: string
    tokens: number
    kind: 'used' | 'free' | 'buffer' | 'deferred'
  }>
}

export type { ActivePhase }

export interface ChatStream {
  items: TranscriptItem[]
  messages: SdkMessage[]
  error: string | null
  contextUsage: ContextUsage | null
  /** Predicted next-user-prompt from the SDK. Cleared on new user message. */
  promptSuggestion: string | null
  /** Full task list (background commands, subagents, ambient tasks) from
   *  the dedicated `tasks` WS channel. Drives the TasksPanel and the
   *  header task-count chip. */
  tasks: TaskRecordUi[]
  /** Transient `api_retry` frame (rate-limit retry indicator), or null when
   *  no retry is in flight. Routed to a dedicated slot (not items/messages) —
   *  MessageList renders it as a tail divider. */
  apiRetry: SdkMessage | null
  /** Live thinking-token estimate for the current thinking block
   *  (`system/thinking_tokens` frames), or null when none is in flight.
   *  Drives the WorkingBubble's token hint. */
  thinkingTokens: number | null
  tokenRate: number | null
  streamingContent: string | null
  activePhase: ActivePhase
  permissionDecisions: ReadonlyMap<string, 'allow' | 'deny'>
  planStatus: ReadonlyMap<string, PlanStatus>
  planContent: ReadonlyMap<string, string>
  questionAnswers: ReadonlyMap<string, import('../utils/question-answers').QuestionAnswerEntry[]>
  toolStatus: ReadonlyMap<string, ToolStatus>
  toolResults: ReadonlyMap<string, ToolResultEntry>
  activeSubagents: ActiveSubagent[]
  subagentIndex: ReadonlyMap<string, ActiveSubagent>
  /** Full Workflow index (running + completed) keyed by toolUseId. Used by
   *  WorkflowCard + WorkflowOverlay so completed Workflows stay inspectable
   *  after their tool_result lands — same keep-on-complete discipline as
   *  subagentIndex. */
  workflowIndex: ReadonlyMap<string, import('../session-store/types').WorkflowRecord>
  /** Full Skill index (running + completed) keyed by toolUseId. Read by the
   *  Skill card for its child counts + drill-in gate, and by Chat to adapt a
   *  forked skill into the record SubagentOverlay renders. */
  skillIndex: ReadonlyMap<string, import('../session-store/types').SkillRecord>
  replayReady: boolean
  /** True while the transcript is still settling for this session: the
   *  initial replay hasn't completed, the IDB cold-load may still prepend
   *  rows, or a tail-first backfill burst is draining. MessageList freezes
   *  the pinned "current question" header's notification while this is set
   *  (the measured visible-top churns with every prepended chunk) and emits
   *  exactly once when it lifts. */
  transcriptSettling: boolean
  /** Optimistically insert the user's message into the transcript so it
   *  appears immediately, before the server echoes it back. Returns the
   *  pendingId so the caller can roll it back if the POST fails. The
   *  real message from the WS stream will replace this placeholder
   *  (matched by id, not by content — works for multimodal too). */
  insertUserMessage: (text: string) => string
  /** Mark an optimistic user message as accepted by the REST send endpoint.
   *  This clears the local "sending" spinner using the server-side uuid;
   *  the later WS echo/replay/result still performs final reconciliation. */
  ackUserMessage: (pendingId: string, serverUuid: string, receivedAt?: number) => void
  /** Remove a previously-inserted optimistic user message. Used by the
   *  Composer's send() catch path so a failed POST doesn't leave a
   *  ghost row in the transcript. */
  rollbackUserMessage: (pendingId: string) => void
  reset: () => void
  clearError: () => void
  /** Dismiss a `pending` background subagent from the Waiting bubble. */
  dismissSubagent: (toolUseId: string) => void
  /** Lazy-load the previous page of history from disk and prepend it.
   *  No-op while a load is in flight or when there's nothing older.
   *  Resolves to the number of messages prepended (0 when none). */
  loadOlder: () => Promise<number>
  /** True when there may be older messages on disk before the first one
   *  currently displayed. Starts true (unknown) and becomes false once a
   *  page reports hasMore=false. */
  hasOlder: boolean
  /** True while a loadOlder() request is in flight. */
  loadingOlder: boolean
}

export interface PermissionHandlers {
  onRequest: (req: PermissionRequest) => void
  onResolved: (res: PermissionResolved) => void
  onCleared?: () => void
  /** MCP elicitation (OAuth auth / server-initiated form) callbacks.
   *  Optional so existing callers/tests that don't care about
   *  elicitations keep compiling unchanged. */
  onElicitationRequest?: (req: ElicitationRequestUi) => void
  onElicitationResolved?: (res: ElicitationResolved) => void
  /** User-dialog (blocking CLI prompt, e.g. refusal fallback) callbacks.
   *  Optional for the same forward-compat reason as elicitation. */
  onDialogRequest?: (req: UserDialogRequestUi) => void
  onDialogResolved?: (res: DialogResolved) => void
  /** Fired when a refusal-fallback dialog is resolved with `edit_prompt`:
   *  receives the plain text of the evicted leg's last user message so the
   *  Chat can prefill the composer. */
  onEditPrompt?: (text: string) => void
}

/** Clear all cached session state. Used in tests to avoid cross-test leaks. */
export function cacheClear() {
  void sessionStoreRegistry.clear()
  // Also wipe localStorage entries so stores recreated after clear()
  // don't reload stale data from a previous test.
  clearAllSessionStorage()
}

export function useChatStream(
  sessionId: string,
  permissions: PermissionHandlers,
  /** The session's lifecycle facts, which the message channel cannot show:
   *  `running` is merged into the subscribe/replay effect's deps, and
   *  `terminated` gates the SESSION_TERMINATED sweep (see below).
   *
   *  BOTH REQUIRED. They are a pair of facts about the session, not tuning
   *  knobs, and every value is meaningful — `terminated: false` means "still
   *  live, do not sweep". Defaulting them would let a new caller omit the
   *  argument and silently disable the termination sweep, reinstating the
   *  stranded-record bug with no type error; the omission has to be a compile
   *  error. (`useChatStream('')` — no session — passes false for both.) */
  running: boolean,
  /** True once the session is `terminated`. No further frame of any kind will
   *  arrive for it, so the store must run the turn-end sweep itself — see the
   *  SESSION_TERMINATED action. Passed in (rather than inferred) because the
   *  hook only sees the message channel, and termination is a session-info
   *  fact. */
  terminated: boolean,
): ChatStream {
  const hub = useWsHub()
  const hubStatus = useWsHubStatus()
  // True while THIS listener's tail-first burst is mid-drain (between the
  // `tail` frame and its `replay-done`). Deliberately listener-owned, NOT a
  // mirror of the hub's burst latch: the latch exists for cursor-anchor
  // semantics and terminates on five paths (error / session-cleared /
  // refused subscribe / idle session-update / connection close) that don't
  // all reach this listener — mirroring it would stick the pin freeze on
  // exactly those paths. The drain flag tracks the one thing the freeze
  // needs — "backfill chunks are still prepending" — and every path that
  // ends the buffer resets it below (replay-done, session-cleared, error).
  // A connection drop mid-burst keeps it true, which is correct: nothing is
  // changing while disconnected, and the reconnect's own tail→replay-done
  // cycle re-closes it. Re-read when the session id changes (the side-chat
  // hook instance survives a target switch) — render-phase adjustment, the
  // React-documented pattern, so the flag is correct before anything
  // renders with it.
  const [burstDraining, setBurstDraining] = useState(false)
  const [burstDrainingFor, setBurstDrainingFor] = useState(sessionId)
  if (burstDrainingFor !== sessionId) {
    setBurstDrainingFor(sessionId)
    setBurstDraining(false)
  }
  const store = useMemo(() => getSessionStore(sessionId), [sessionId])
  // Individual field subscriptions — only re-render when the specific
  // field's reference changes (Object.is check). During streaming content
  // deltas, only streamingContent / activePhase / tokenRate change; all
  // other fields keep their references stable.
  const items = useSessionField(sessionId, 'items')
  const messages = useSessionField(sessionId, 'messages')
  const streamingContent = useSessionField(sessionId, 'streamingContent')
  const activePhase = useSessionField(sessionId, 'activePhase')
  const tokenRate = useSessionField(sessionId, 'tokenRate')
  const contextUsage = useSessionField(sessionId, 'contextUsage')
  const promptSuggestion = useSessionField(sessionId, 'promptSuggestion')
  const tasks = useSessionField(sessionId, 'tasks')
  const apiRetry = useSessionField(sessionId, 'apiRetry')
  const thinkingTokens = useSessionField(sessionId, 'thinkingTokens')
  const error = useSessionField(sessionId, 'error')
  const permissionDecisions = useSessionField(sessionId, 'permissionDecisions')
  const planStatus = useSessionField(sessionId, 'planStatus')
  const planContent = useSessionField(sessionId, 'planContent')
  const questionAnswers = useSessionField(sessionId, 'questionAnswers')
  const toolStatus = useSessionField(sessionId, 'toolStatus')
  const toolResults = useSessionField(sessionId, 'toolResults')
  const activeSubagents = useSessionField(sessionId, 'activeSubagents')
  const subagentIndex = useSessionField(sessionId, 'subagentIndex')
  const workflowIndex = useSessionField(sessionId, 'workflowIndex')
  const skillIndex = useSessionField(sessionId, 'skillIndex')
  const replayReady = useSessionField(sessionId, 'replayReady')
  // True once the store's deferred localStorage hydrate has completed. The
  // subscribe effect gates on it so the WS subscribe carries the cached
  // lastMessageUuid (incremental replay) instead of null (full replay).
  const hydrateReady = useSessionField(sessionId, 'hydrateReady')
  // Gated together with hydrateReady: the IDB cold-load can still land rows
  // (and prepend them) after hydration, so the cache declaration this hook
  // sends — and the tail-first opt-in that depends on it — must wait for the
  // store's cache state to settle (see SessionSnapshot.idbReady).
  const idbReady = useSessionField(sessionId, 'idbReady')
  const permsRef = useRef(permissions)
  // Set true when a `session-cleared` frame lands for this session. Blocks
  // loadOlder() from paging the pre-/clear transcript back in from disk
  // (the on-disk log still holds it; the server only truncated its
  // in-memory ring). Reset on session switch.
  const clearedRef = useRef(false)
  // --- Lazy history paging (scroll-up) ---------------------------------
  // hasOlder/loadingOlder are React state (drive UI). The cursor index and
  // in-flight guard are refs (don't need to trigger renders). Declared here
  // (above the WS listener effect) so the session-cleared handler can call
  // setHasOlder(false) without a temporal-dead-zone reference. Reset whenever
  // the session changes (see the effect further down).
  const [hasOlder, setHasOlder] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // Disk index to page before next time (the previous response's startIndex).
  // null means "first page — anchor by uuid instead".
  const cursorRef = useRef<number | null>(null)
  const inFlightRef = useRef(false)

  useEffect(() => {
    permsRef.current = permissions
  }, [permissions])

  useEffect(() => {
    // Gated on replayReady, NOT just `terminated`: this effect also runs on
    // mount, which for a reloaded terminated session happens BEFORE the replay
    // lands — exactly when the store is still empty, and one frame before the
    // transcript (and any subagent record in it) is rebuilt. Sweeping there
    // would be a no-op on the empty store and then leave the just-replayed
    // records unswept (terminated never flips again), and it would also beat a
    // replayed Agent tool_result to the punch — that merge needs status
    // 'running', so an early sweep would drop a finished subagent's output.
    // Waiting for replayReady means the records exist and any payload has
    // already been applied.
    if (!terminated || !replayReady) return
    // A terminated session never delivers the `result` frame that normally
    // drives the turn-end sweep, so a sync (foreground) subagent record — the
    // one TASKS_SNAPSHOT leaves `running` on the assumption that the
    // result-frame sweep will cover it — would otherwise keep its card
    // spinning forever on a dead session. Idempotent (see the action), so
    // re-firing per replay and on a terminate→resume→terminate cycle is safe.
    store.dispatch({ type: 'SESSION_TERMINATED' })
  }, [terminated, replayReady, store])

  useEffect(() => {
    sessionStoreRegistry.retain(sessionId)
    return () => {
      sessionStoreRegistry.release(sessionId)
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    // The store hydrates its localStorage cache in a microtask after the
    // constructor, so on a cold panel mount this effect's first run happens
    // with an empty store. Subscribing now would send sinceUuid=null and force
    // a full server replay; waiting for hydrateReady lets the incremental
    // (sinceUuid) replay be used when a cache exists. hydrateReady is always
    // set (cache or not), so this never deadlocks.
    if (!hydrateReady) return
    // Hold the channel, and require a replay for THIS listener. The hold is
    // ref-counted and deduped (the same panel's header subscribes too); the
    // force is what makes the transcript independent of subscription order —
    // the server re-serves the replay, sliced at `sinceUuid`, so a warm store
    // costs nothing and a cold one gets the history. Relying on the hold alone
    // is what left the reported panel blank: it subscribed while the session
    // was unservable, the hub counted the holder anyway, and this hook mounts
    // only after the resume lands — by then its subscribe looked like a
    // duplicate.
    let replayMessages: SdkMessage[] = []
    let replayPermissions: PermissionRequest[] = []
    let replaying = false
    // True between a `tail: true` replay frame and its replay-done — the
    // tail-first burst. Messages were applied on arrival (tail frame) or
    // prepended per chunk (backfill frames), and the pending-request
    // snapshots rode the tail frame, so replay-done must NOT run the
    // buffered REPLAY_REPLACE — it only closes the burst (and finally
    // allows the replay cursor to advance; see replayCursor).
    let tailMode = false
    // True once the server's `error` frame has landed on this listener.
    // The startSession error path on the server enqueues `error` +
    // `replay-done` with NO replay frame between them, so this flag keeps
    // the replay-done diagnostic below from misattributing that expected
    // sequence to the discarded-buffer race.
    let errored = false
    // Cursor for this listener's forced replay (see the `subscribe` call at the
    // bottom of the effect). While a tail-first burst is open the store's
    // newest uuid is the TAIL's — not a valid resume anchor — and the hub
    // (which outlives a panel remount, unlike a per-hook ref) silently
    // substitutes the last complete position. `burstOpen` is read here for the
    // opt-in decision below: a partial burst's rows are all NEWER than the
    // pending backfill chunks, so it is safe to ask for tail-first again.
    const replayCursor = (): string | undefined =>
      getSessionLastMessageUuid(sessionId) ?? undefined
    // Phase 2 of the layered-state refactor removed the `pendingLive` buffer.
    // Previously, live frames arriving between `replay` and `replay-done` had
    // to be parked because REPLAY_REPLACE's fresh-state branch rebuilt the
    // entire state from scratch (createInitialSessionState), wiping anything a
    // direct dispatch had already written — permissionPending, contextUsage,
    // error, the optimistic placeholder. After the refactor, REPLAY_REPLACE
    // only rebuilds `state.mirror` and PRESERVES `state.intent` plus the
    // current mirror's already-set live fields, so a live frame can dispatch
    // immediately and its effect survives the replay-done that follows.
    //
    // Result: zero buffering, zero ordering guesswork, and the
    // StrictMode-double-mount race that motivated this whole refactor cannot
    // wipe the user's first optimistic message anymore.

    const off = hub.addSessionListener(sessionId, (frame: WsServerFrame) => {
      switch (frame.kind) {
        case 'replay': {
          if (frame.backfill) {
            // Tail-first replay backfill chunk: strictly older than
            // everything on screen, so PREPEND it immediately — no
            // buffering, no waiting for replay-done. The server only
            // sends these on a no-cache cold start, so prepend-to-front
            // can never land above cached items (see replay-plan.ts). A
            // /clear that raced in mid-backfill built these chunks from
            // the pre-clear ring — drop them so they can't resurrect the
            // cleared transcript. trustUuidDedup skips the prompt
            // content-signature overlap check: backfill chunks share the
            // ring's uuid space with the on-screen tail, so uuid dedup is
            // exact and the signature check would false-drop a distinct
            // older prompt whose text repeats ("continue") across a chunk
            // boundary.
            if (!clearedRef.current && frame.messages.length > 0) {
              store.dispatch({
                type: 'PREPEND_MESSAGES',
                messages: frame.messages as SdkMessage[],
                trustUuidDedup: true,
              })
            }
            break
          }
          if (frame.tail) {
            // Tail-first replay tail frame: the newest chunk, a complete
            // first screen. Apply it IMMEDIATELY — this is the whole point
            // of the mode (first paint after one frame, not after the full
            // ring drains). The pending-request snapshots (permissions /
            // elicitations / dialogs) ride THIS frame — same shape as the
            // ordinary single-frame replay — so a permission card appears
            // with the first paint, not after the backfill drains. The
            // trailing replay-done carries nothing and only closes the
            // burst. The server gates this mode on the client having no
            // cached transcript (no sinceUuid), so REPLAY_REPLACE runs its
            // fresh-state path; the merge path would still be correct if a
            // cache somehow existed.
            tailMode = true
            // Open the transcriptSettling drain window: backfill chunks will
            // prepend until replay-done closes it.
            setBurstDraining(true)
            replaying = false
            replayMessages = []
            replayPermissions = []
            // Same /clear race guard as the backfill branch above: a tail
            // frame that was in flight when an SDK in-band /clear landed
            // carries PRE-clear messages — applying it would resurrect the
            // cleared transcript (usually healed by the trailing
            // replay-done's empty REPLAY_REPLACE, but a connection drop
            // before that replay-done would leave the resurrection up).
            if (!clearedRef.current) {
              if (frame.permissions?.length) {
                for (const req of frame.permissions) permsRef.current.onRequest(req)
              }
              if (frame.elicitations?.length) {
                for (const req of frame.elicitations) permsRef.current.onElicitationRequest?.(req)
              }
              if (frame.dialogs?.length) {
                for (const req of frame.dialogs) permsRef.current.onDialogRequest?.(req)
              }
              store.dispatch({
                type: 'REPLAY_REPLACE',
                messages: frame.messages as SdkMessage[],
                // Tolerant of a frame that omits the field (older server
                // builds / hand-rolled frames) — same leniency as the
                // buffered path's optional-chain reads.
                permissions: (frame.permissions ?? []) as PermissionRequest[],
              })
              // The newest chunk went in first, so any tool_result whose
              // tool_use is still in an unsent backfill chunk was skipped.
              // Mark it in the STORE (not in this closure): the burst can be
              // interrupted and finished later by an ordinary replay, and the
              // marker has to outlive both this closure and this effect.
              store.dispatch({ type: 'MARK_TAIL_FIRST_APPLIED' })
            }
            // NOTE: no hub.setLastMessageUuid here. The burst is
            // incomplete until replay-done; advancing the reconnect
            // anchor now would make a mid-backfill disconnect resume
            // from the tail's uuid and permanently skip the unsent
            // backfill chunks (the server only re-sends what is strictly
            // after the anchor). replayCursor() below enforces the same
            // rule for live messages while the burst is open.
            break
          }
          if (!replaying) {
            replaying = true
            replayMessages = []
            replayPermissions = []
            // An ordinary (unmarked) burst opening means any earlier
            // tail-first burst is over — most commonly a reconnect that
            // re-subscribed with a sinceUuid, so the server serves the
            // ordinary incremental path. Leaving tailMode latched here
            // would make the pending replay-done take the tailMode
            // branch and silently drop this burst's buffered messages.
            tailMode = false
          }
          replayMessages.push(...(frame.messages as SdkMessage[]))
          if (frame.permissions?.length) {
            replayPermissions.push(...frame.permissions)
            for (const req of frame.permissions) permsRef.current.onRequest(req)
          }
          // Pending elicitations ride the same replay burst — this is the
          // reconnect/refresh recovery path for auth dialogs.
          if (frame.elicitations?.length) {
            for (const req of frame.elicitations) permsRef.current.onElicitationRequest?.(req)
          }
          // Pending user dialogs ride the same burst (refusal fallback etc).
          if (frame.dialogs?.length) {
            for (const req of frame.dialogs) permsRef.current.onDialogRequest?.(req)
          }
          break
        }
        case 'replay-done': {
          // Burst terminator: close the transcriptSettling drain window
          // regardless of which replay mode served the burst (a no-op after
          // an ordinary buffered replay, which never opened it).
          setBurstDraining(false)
          // Key diagnostic: on the success path the server ALWAYS sends ≥1
          // replay frame before replay-done (even an empty one — ws.ts
          // enqueues `replay` with messages:[] before `replay-done`). The
          // startSession ERROR path is the exception: it enqueues `error` +
          // `replay-done` with no replay frame, and `errored` tracks that so
          // we don't misattribute it to the race. Otherwise, reaching
          // replay-done with replaying===false means THIS listener instance
          // never saw the replay frames — they landed on a previous effect
          // instance that was torn down mid-replay (deps: running /
          // hydrateReady / store), discarding the buffer.
          //
          // No longer a blank-transcript report on its own: the replacement
          // instance forces its own replay (`subscribe(..., { force: true })`),
          // and the server re-serves one for a channel it already holds. It is
          // still worth a line — it says an effect re-ran mid-burst, which
          // costs a replay rebuild. A tail-first burst is the OTHER legitimate
          // exception: it applies its frames on arrival, so an empty buffer at
          // replay-done is the expected steady state there. (When the
          // terminator lands on a closure that never saw the tail frame, this
          // fires once — the burst's own frames were applied by the previous
          // instance, and the hub's burst latch, not this closure, is what
          // kept the resume anchor honest.)
          if (!replaying && !tailMode && replayMessages.length === 0 && !errored) {
            console.warn(
              `[useChatStream] replay-done for ${sessionId} arrived with NO preceding ` +
              `replay frame on this listener — an effect re-run (running=${running}) ` +
              `discarded the in-flight burst; the replacement instance re-requests it`,
            )
          }
          if (frame.permissions?.length) {
            replayPermissions.push(...frame.permissions)
            for (const req of frame.permissions) permsRef.current.onRequest(req)
          }
          if (frame.elicitations?.length) {
            for (const req of frame.elicitations) permsRef.current.onElicitationRequest?.(req)
          }
          if (frame.dialogs?.length) {
            for (const req of frame.dialogs) permsRef.current.onDialogRequest?.(req)
          }
          if (tailMode) {
            // Tail-first burst terminator: messages and pending-request
            // snapshots all rode the tail frame (applied on arrival) and
            // the backfill frames (prepended). Nothing to fold — the
            // server's tail-mode replay-done carries no payload. This is
            // also the point where the burst is complete, so the reconnect
            // anchor may finally advance (see the tail-frame NOTE above).
            tailMode = false
          } else {
            store.dispatch({ type: 'REPLAY_REPLACE', messages: replayMessages, permissions: replayPermissions })
          }
          // One settle point for every terminator. It is dispatched
          // unconditionally and gated INSIDE the reducer on the store's
          // marker, which is what makes it correct in the paths a
          // closure-local check misses: a burst applied by a previous
          // closure, and a burst interrupted by a socket drop whose results
          // are only re-paired by the NEXT (ordinary, buffered) replay.
          store.dispatch({ type: 'SETTLE_RESULT_INDEXES' })
          const lastUuid = getSessionLastMessageUuid(sessionId)
          if (lastUuid) hub.setLastMessageUuid(sessionId, lastUuid)
          replayMessages = []
          replayPermissions = []
          replaying = false
          break
        }
        case 'message': {
          const message = frame.message as SdkMessage
          // system/session_state_changed is an ephemeral liveness frame
          // (idle / running / requires_action), NOT transcript content — the
          // server early-continues it out of the ring, so mirror it and skip
          // the transcript pipeline entirely.
          if (message.type === 'system' && message.subtype === 'session_state_changed') {
            const state = (message as { state?: unknown }).state
            if (state === 'idle' || state === 'running' || state === 'requires_action') {
              store.dispatch({ type: 'SESSION_STATE', state })
            }
            break
          }
          store.dispatch({ type: 'MESSAGE', message })
          // The hub ignores this while a tail-first burst is open — a live
          // message landing mid-backfill must not advance the resume anchor
          // either (same rationale as the tail-frame NOTE above).
          if (!replaying) {
            const lastUuid = getSessionLastMessageUuid(sessionId)
            if (lastUuid) hub.setLastMessageUuid(sessionId, lastUuid)
          }
          break
        }
        case 'permission-request': {
          // The external onRequest handler drives modal state outside the
          // store; the store action records it for derived selectors.
          permsRef.current.onRequest(frame.payload)
          store.dispatch({ type: 'PERMISSION_REQUEST', request: frame.payload })
          break
        }
        case 'permission-resolved': {
          const resolved = {
            id: frame.id,
            ...frame.decision,
          }
          permsRef.current.onResolved(resolved)
          store.dispatch({ type: 'PERMISSION_RESOLVED', id: frame.id, decision: frame.decision })
          break
        }
        case 'elicitation-request': {
          // External handler drives the auth dialog's local state; unlike
          // permissions there is no transcript-side store action because
          // elicitations render no inline cards.
          permsRef.current.onElicitationRequest?.(frame.payload)
          break
        }
        case 'elicitation-resolved': {
          permsRef.current.onElicitationResolved?.({ id: frame.id, decision: frame.decision })
          break
        }
        case 'dialog-request': {
          // External handler drives the dialog's local state; dialogs render
          // no inline transcript cards (same as elicitations).
          permsRef.current.onDialogRequest?.(frame.payload)
          break
        }
        case 'dialog-resolved': {
          // Eviction is resolution-driven (CLI contract: any choice evicts
          // the refused leg's already-streamed messages) and runs in ONE
          // place — here — so decide/abort/cross-tab all behave the same.
          // For edit_prompt we first lift the evicted leg's last user
          // message text so Chat can prefill the composer with the original
          // question.
          if (frame.retractedMessageUuids?.length) {
            const uuidSet = new Set(frame.retractedMessageUuids)
            if (
              frame.decision.behavior === 'completed' &&
              frame.decision.result === 'edit_prompt'
            ) {
              const lastUserText = store
                .getSnapshot()
                .messages.filter(
                  (m) =>
                    uuidSet.has((m as { uuid?: string }).uuid ?? '') &&
                    (m as { type?: string }).type === 'user',
                )
                .map((m) => extractMessagePlainText(m as Parameters<typeof extractMessagePlainText>[0]))
                .filter((t): t is string => !!t)
                .at(-1)
              if (lastUserText) permsRef.current.onEditPrompt?.(lastUserText)
            }
            store.dispatch({ type: 'EVICT_MESSAGES', uuids: frame.retractedMessageUuids })
          }
          permsRef.current.onDialogResolved?.({
            id: frame.id,
            decision: frame.decision,
            retractedMessageUuids: frame.retractedMessageUuids,
          })
          break
        }
        case 'context-usage': {
          const usage = frame.usage as ContextUsage
          store.dispatch({ type: 'CONTEXT_USAGE', usage })
          break
        }
        case 'prompt-suggestion': {
          store.dispatch({ type: 'PROMPT_SUGGESTION', suggestion: (frame as { suggestion: string }).suggestion })
          break
        }
        case 'tasks-snapshot': {
          // Full task-list snapshot from the dedicated `tasks` channel.
          // The reducer also enriches matching activeSubagent records
          // (taskId / progressSummary / lastToolName / background flip).
          store.dispatch({ type: 'TASKS_SNAPSHOT', tasks: (frame as { tasks: TaskRecordUi[] }).tasks ?? [] })
          break
        }
        case 'message-consumed': {
          // Flip the matching user bubble from "queued" to "consumed". If
          // the message itself hasn't arrived yet (frame raced ahead), the
          // reducer stashes the timestamp in pendingConsumedMessages and the
          // message's own broadcast / next replay folds it in. Either way
          // the placeholder lookup in applyMessageConsumed self-heals.
          store.dispatch({ type: 'MESSAGE_CONSUMED', uuid: frame.uuid, consumedAt: frame.consumedAt })
          break
        }
        case 'messages-withdrawn': {
          // Queued user turns withdrawn by an interrupt with cancelQueued —
          // the server already removed them from its replay ring, so evict
          // the bubbles here too (same machinery as the refusal-fallback
          // eviction). The frame may list CLI-internal uuids this tab never
          // sent; the reducer's lookup simply finds nothing for those.
          if (frame.uuids.length > 0) {
            store.dispatch({ type: 'EVICT_MESSAGES', uuids: frame.uuids })
          }
          break
        }
        case 'error': {
          // If the replay never completed (e.g. subscribe failed because
          // the session was already torn down), replayReady is still false
          // and the MessageList shows an infinite loading skeleton. Force
          // replayReady=true so the skeleton clears and the error becomes
          // visible. Clear all replay buffers so a stale replay-done that
          // arrives later can't overwrite the error with error:null.
          errored = true
          // An error frame ends any in-flight burst for this listener (the
          // hub drops its latch here too) — release the pin freeze, or a
          // mid-backfill error with no trailing replay-done would stick
          // transcriptSettling on forever.
          setBurstDraining(false)
          if (!store.getSnapshot().replayReady) {
            replayMessages = []
            replayPermissions = []
            replaying = false
            tailMode = false
            store.dispatch({ type: 'REPLAY_REPLACE', messages: [], permissions: [] })
          }
          store.dispatch({ type: 'ERROR', message: frame.message })
          break
        }
        case 'subscribe-result': {
          // The state half of a subscribe answer (the `error` frame above
          // carries the prose). `ok` means this connection is being served —
          // so a band left by an earlier refusal is stale and must go, since
          // REPLAY_REPLACE deliberately preserves `intent.error` and nothing
          // else clears it on a healed panel. Read + guarded through the store
          // (not the `error` field) so the effect doesn't gain a dep that
          // would re-run — and re-force a replay — on every band change.
          if (frame.ok === true && store.getSnapshot().error != null) {
            store.dispatch({ type: 'ERROR', message: null })
          }
          break
        }
        case 'session-cleared': {
          // SDK-emitted `cleared` control event (forwarded at server/ws.ts).
          // The local `/clear` command no longer emits this frame: it mints a
          // fresh session under a new id and the client swaps panels, so there
          // is no in-place transcript to reset. This handler stays for the
          // SDK's own in-band clears, which append a new init to the on-disk
          // transcript — the store + cache reset + reverse-page block below
          // keep the pre-clear rows from resurrecting on scroll-up.
          //
          // Mid-replay guard: if a reconnect's replay raced ahead of this
          // frame, the buffers below hold PRE-clear messages (the server's
          // ring wasn't truncated yet when it built that replay). Were we
          // to leave them, the pending replay-done's REPLAY_REPLACE would
          // re-apply them on top of the freshly-reset store and resurrect
          // the cleared transcript. So drop every buffered replay frame
          // and force replay-mode off — the next subscribe (or the
          // post-clear live stream) repaints from the truncated ring.
          replayMessages = []
          replayPermissions = []
          replaying = false
          tailMode = false
          // The burst is dead along with its buffer — release the pin freeze
          // so the post-clear (empty) transcript re-evaluates the header.
          setBurstDraining(false)
          // Reset in-memory state AND erase the cache with no pending write
          // left behind (clearPersisted cancels the debounced save that a
          // plain reset() would schedule — otherwise that timer rewrites the
          // key with the empty state and the cache reappears).
          store.clearPersisted()
          permsRef.current.onCleared?.()
          // Block reverse-paging: the on-disk transcript still holds the
          // pre-clear messages; without this, scrolling up would pull them
          // back in. Reset on session switch (see the paging effect below).
          clearedRef.current = true
          setHasOlder(false)
          break
        }
        default:
          break
      }
    })

    const cursor = replayCursor()
    // "Nothing on screen" is stated, not inferred: the store can hold rows
    // with no cursor at all (an IDB cold-load prepends rows without setting
    // one), and backfill chunks are NEWER than those rows while the client
    // prepends them to the FRONT — the server must not serve them to a
    // client with a transcript. A PARTIAL burst is the exception: its rows
    // are the tail (newest in the ring), so everything the backfill carries
    // is older and prepending stays correct.
    const burstOpen = hub.isReplayBurstOpen(sessionId)
    const hasCachedTranscript = !burstOpen && (cursor != null || store.getSnapshot().items.length > 0)
    const release = hub.subscribe(
      sessionId,
      cursor,
      // This listener needs the history itself, not just a live channel: the
      // server re-serves the replay sliced at the cursor above, so a warm
      // store gets a near-empty burst and a cold one gets everything.
      hasCachedTranscript
        ? { force: true, hasCachedTranscript: true }
        : { force: true, replayMode: 'tail-backfill' },
    )
    return () => {
      // Key diagnostic: tearing down mid-replay discards the buffered
      // chunks (they live in this closure). The replacement effect forces a
      // fresh replay for itself, so this is no longer a blank-transcript
      // report — it says an effect re-ran mid-burst (deps: running /
      // hydrateReady / store), i.e. a replay rebuild was paid for nothing.
      if (replaying && replayMessages.length > 0) {
        console.warn(
          `[useChatStream] effect re-run for ${sessionId} DISCARDED in-flight replay ` +
          `buffer (${replayMessages.length} msgs, replaying=${replaying}) — ` +
          `deps changed mid-replay; the replacement instance re-requests it`,
        )
      }
      off()
      release()
    }
  }, [hub, sessionId, store, hydrateReady, idbReady, running])

  const displayedError = useMemo(() => {
    if (hubStatus === 'reconnecting') {
      return error == null || error === 'Stream reconnecting…'
        ? 'Stream reconnecting…'
        : error
    }
    if (hubStatus === 'online') return error === 'Stream reconnecting…' ? null : error
    return error
  }, [hubStatus, error])

  const insertUserMessage = useCallback((text: string): string => {
    const pendingId = `optimistic:${randomId()}`
    const message: SdkMessage = {
      type: 'user',
      uuid: pendingId,
      message: { role: 'user', content: text },
    }
    // Clear any prompt suggestion when the user sends a new message
    store.dispatch({ type: 'PROMPT_SUGGESTION', suggestion: null })
    store.dispatch({ type: 'OPTIMISTIC_USER_MESSAGE', message })
    return pendingId
  }, [store])

  const rollbackUserMessage = useCallback((pendingId: string) => {
    store.dispatch({ type: 'ROLLBACK_OPTIMISTIC_USER_MESSAGE', pendingId })
  }, [store])

  const ackUserMessage = useCallback((pendingId: string, serverUuid: string, receivedAt?: number) => {
    store.dispatch({ type: 'ACK_USER_MESSAGE', pendingId, serverUuid, receivedAt })
  }, [store])

  const reset = useCallback(() => {
    store.reset()
  }, [store])

  const clearError = useCallback(() => {
    store.dispatch({ type: 'ERROR', message: null })
  }, [store])

  /** Dismiss a `pending` background subagent from the Waiting bubble. Flips
   *  it to `interrupted` so it leaves the chip set; a late task_notification
   *  for a dismissed subagent is then ignored (the completion branch excludes
   *  `interrupted`). No-op for non-pending records. */
  const dismissSubagent = useCallback((toolUseId: string) => {
    store.dispatch({ type: 'DISMISS_SUBAGENT', toolUseId })
  }, [store])

  useEffect(() => {
    // New session: reset paging state. The setState calls are intentional —
    // paging UI state is derived from `sessionId` and must reset when it
    // changes; there's no render-time value to compute it from. The reset
    // runs once per session switch (not every render), so the cascading-
    // render concern the rule guards against doesn't apply here.
    cursorRef.current = null
    inFlightRef.current = false
    clearedRef.current = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasOlder(true)
    setLoadingOlder(false)
  }, [sessionId])

  /** Fetch one page from the server /history endpoint (the pre-IDB path, and
   *  the gap-probe when IDB is exhausted/has a boundary gap). Manages
   *  `cursorRef` (server startIndex) across calls. Returns the messages (NOT
   *  dispatched — the caller prepends them, possibly combined with IDB
   *  messages) + hasMore. */
  const fetchServerPage = useCallback(async (): Promise<{ messages: SdkMessage[]; hasMore: boolean }> => {
    const params = new URLSearchParams({ limit: '200' })
    if (cursorRef.current != null) {
      // Subsequent pages: page strictly before the last startIndex.
      params.set('before', String(cursorRef.current))
    } else {
      // First page: anchor on the oldest disk-stable message on screen.
      const current = store.getState().mirror.items
      let anchor: string | null = null
      for (const it of current) {
        const u = diskStableUuid(it.msg)
        if (u) { anchor = u; break }
      }
      if (anchor) params.set('beforeUuid', anchor)
      // If no anchor exists (transcript is only user prompts so far), omit
      // both — the server returns the newest page, dedup-by-uuid drops dupes.
    }
    const page = await api.get<HistoryPageResponse>(
      `/sessions/${sessionId}/history?${params.toString()}`,
    )
    cursorRef.current = page.startIndex
    return { messages: page.messages, hasMore: page.hasMore }
  }, [sessionId, store])

  const loadOlder = useCallback(async (): Promise<number> => {
    if (inFlightRef.current) return 0
    // After a /clear, the pre-clear transcript still exists on disk but
    // must stay hidden — refuse to page it back in for this session.
    if (clearedRef.current) return 0
    // While a tail-first burst is draining, a disk page would be PREPENDED to
    // the front — above the backfill chunks still to arrive, which are NEWER
    // than that page (they are ring content; a paged page is strictly older).
    // The transcript would render mid-history above older history, and the
    // chunk's trustUuidDedup skips the signature check that would otherwise
    // catch a duplicated prompt. The drain is bounded (the ring, one frame per
    // chunk), so refuse and let the user's next scroll-up retry.
    if (hub.isReplayBurstOpen(sessionId)) return 0
    inFlightRef.current = true
    setLoadingOlder(true)
    try {
      // 1. Try IDB first (local, no server round-trip).
      const idb = await store.loadOlderFromIdb(200)
      if (idb) {
        // 2. Probe the server when IDB is exhausted OR there's a seq gap at
        // the boundary (tab closed mid-write left a hole in IDB). Do this
        // BEFORE prepending so fetchServerPage anchors beforeUuid on the
        // ORIGINAL oldest in memory (the gap sits between the IDB block and
        // that oldest — anchoring on the post-prepend oldest would page the
        // wrong window and never bridge the gap). Server messages bridge the
        // gap (newer than the IDB block, older than memory) so they append
        // AFTER the IDB block in the combined oldest-first prepend; dedup by
        // uuid drops any IDB overlap. The next save backfills IDB.
        let combined = idb.messages
        let hasMore = idb.hasMore
        if (!idb.hasMore || !idb.contiguous) {
          const server = await fetchServerPage()
          combined = combined.concat(server.messages)
          hasMore = idb.hasMore || server.hasMore
        }
        if (combined.length > 0) {
          store.dispatch({ type: 'PREPEND_MESSAGES', messages: combined })
        }
        setHasOlder(hasMore)
        return combined.length
      }
      // 3. IDB unavailable — full server path.
      const server = await fetchServerPage()
      if (server.messages.length > 0) {
        store.dispatch({ type: 'PREPEND_MESSAGES', messages: server.messages })
      }
      setHasOlder(server.hasMore)
      return server.messages.length
    } catch {
      // Network/parse error — leave hasOlder as-is so the user can retry by
      // scrolling again. Don't surface to the error banner (non-fatal).
      return 0
    } finally {
      inFlightRef.current = false
      setLoadingOlder(false)
    }
  }, [store, fetchServerPage, hub, sessionId])

  // True while the transcript is still settling: the replay hasn't completed,
  // the IDB cold-load may still prepend rows, or this listener's tail-first
  // burst is mid-drain (burstDraining). MessageList freezes the pinned-header
  // notification during this window — see its `transcriptSettling` prop.
  const transcriptSettling = !replayReady || !idbReady || burstDraining

  return useMemo(
    () => ({
      items,
      messages,
      error: displayedError,
      contextUsage,
      promptSuggestion,
      tasks,
      apiRetry,
      thinkingTokens,
      tokenRate,
      streamingContent,
      activePhase,
      permissionDecisions,
      planStatus,
      planContent,
      questionAnswers,
      toolStatus,
      toolResults,
      activeSubagents,
      subagentIndex,
      workflowIndex,
      skillIndex,
      replayReady,
      transcriptSettling,
      insertUserMessage,
      ackUserMessage,
      rollbackUserMessage,
      reset,
      clearError,
      dismissSubagent,
      loadOlder,
      hasOlder,
      loadingOlder,
    }),
    [items, messages, displayedError, contextUsage, promptSuggestion, tasks, apiRetry, thinkingTokens, tokenRate, streamingContent, activePhase, permissionDecisions, planStatus, planContent, questionAnswers, toolStatus, toolResults, activeSubagents, subagentIndex, workflowIndex, skillIndex, replayReady, transcriptSettling, insertUserMessage, ackUserMessage, rollbackUserMessage, reset, clearError, dismissSubagent, loadOlder, hasOlder, loadingOlder],
  )
}
