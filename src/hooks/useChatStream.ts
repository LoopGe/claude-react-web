import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSessionStore, useSessionField } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import { clearAllSessionStorage } from '../session-store/store'
import type { ActiveSubagent, ActivePhase, PlanStatus, ToolResultEntry, ToolStatus, TranscriptItem } from '../session-store/types'
import { useWsHub, useWsHubStatus } from './useWsHub'
import { api } from './useApi'
import { randomId } from '../utils/uuid'
import type { WsServerFrame } from '../ws-types'
import type { ElicitationRequestUi, ElicitationResolved, PermissionRequest, PermissionResolved, SdkMessage, SkillFrontmatter, TaskRecordUi, UserDialogRequestUi, DialogResolved } from '../types'
import { extractMessagePlainText } from '../../shared/search/extract'
import type { TranscriptPageResponse } from '../../shared/transcript-page'

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
  // NOTE: `streamingContent` is deliberately NOT exposed here. It is the
  // 12.5 Hz hot field (LIVE_TURN_FLUSH cadence); subscribing to it at hook
  // level re-rendered the entire Chat body (and every SideChatDrawer) on
  // every 80ms flush. The live turn's text is consumed at exactly two
  // leaves — MessageList (via the optional `sessionId` prop + its own
  // useOptionalSessionField subscription) — which keeps the flush render
  // bounded to the transcript subtree.
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
  /** True until the transcript's tail page has landed (the seq protocol's
   *  initial paint). MessageList freezes the pinned "current question"
   *  header's notification while this is set and emits exactly once when it
   *  lifts. (The old IDB-cold-load / backfill-burst drain windows are gone
   *  with the seq-window protocol — there is exactly one settle point.) */
  transcriptSettling: boolean
  /** Seq of the oldest message that reached the ordered log (null while the
   *  window is empty; slot-routed frames at the window top are skipped — see
   *  seq-window.ts). MessageList anchors its virtuoso `firstItemIndex` on
   *  it; the anchor then moves by rendered-row counts, so prepends commit in
   *  the same render (Task 9). loadOlder pages `before=` it. */
  oldestSeq: number | null
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
  /** True when older messages exist on the server below the oldest one
   *  currently displayed (the last page's `hasMore`, mirrored from the
   *  seq window). */
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
   *  `running` is merged into the subscribe effect's deps, and `terminated`
   *  gates the SESSION_TERMINATED sweep (see below).
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
  const store = useMemo(() => getSessionStore(sessionId), [sessionId])
  // Individual field subscriptions — only re-render when the specific
  // field's reference changes (Object.is check). During streaming content
  // deltas, only streamingContent / activePhase / tokenRate change; all
  // other fields keep their references stable.
  const items = useSessionField(sessionId, 'items')
  const messages = useSessionField(sessionId, 'messages')
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
  // Seq-window view (the single source for the paging UI state now — no
  // hook-local hasOlder React state: WINDOW_PAGE writes it, the snapshot
  // mirrors it, and this subscription keeps the return object reactive).
  const oldestSeq = useSessionField(sessionId, 'oldestSeq')
  const hasOlder = useSessionField(sessionId, 'hasOlder')
  const permsRef = useRef(permissions)
  // --- Lazy history paging (scroll-up) ---------------------------------
  // loadingOlder is React state (drives UI). The in-flight guard is a ref
  // (doesn't need to trigger renders). Reset when the session changes.
  const [loadingOlder, setLoadingOlder] = useState(false)
  const inFlightRef = useRef(false)
  // Armed when the server's seq space is known to have moved (session-cleared,
  // an attached generation bump): any tail page read at a LOWER generation is
  // a pre-reset read — pre-clear content that must not resurrect on the
  // emptied window. Cleared on session switch.
  const minGenerationRef = useRef<number | null>(null)
  // Monotonic counter bumped by the session-cleared handler; see
  // fetchValidatedPage for why a floor alone cannot express "this page was
  // REQUESTED before the clear" (before any generation is adopted the floor
  // degenerates to 0 and accepts the pre-clear gen-0 page). Reset per
  // subscribe-effect run (session switch).
  const clearEpochRef = useRef(0)
  // ── REST gap-fill worker state ────────────────────────────────────────
  // Serial worker: at most one fillGap loop per hook instance. A call that
  // lands while the loop is running only sets `rerun` — the loop re-reads
  // the window snapshot every iteration, so a hole created between the
  // final snapshot check and the worker's exit is picked up by the rerun
  // pass instead of stranding.
  const fillGapRunningRef = useRef(false)
  const fillGapRerunRef = useRef(false)
  /** Highest missing seq the current gap-fill must reach (from an `attached`
   *  frame's headSeq - 1); null when no attached-driven gap is open. Live
   *  holes don't need it — the window's own `hole` marker tracks them. */
  const gapTargetRef = useRef<number | null>(null)

  useEffect(() => {
    permsRef.current = permissions
  }, [permissions])

  useEffect(() => {
    // Gated on replayReady, NOT just `terminated`: this effect also runs on
    // mount, which for a reloaded terminated session happens BEFORE the tail
    // page lands — exactly when the store is still empty. Sweeping there
    // would be a no-op on the empty store and then leave the just-windowed
    // records unswept (terminated never flips again), and it would also beat
    // a windowed Agent tool_result to the punch — that merge needs status
    // 'running', so an early sweep would drop a finished subagent's output.
    // Waiting for replayReady means the records exist and any payload has
    // already been applied.
    if (!terminated || !replayReady) return
    // A terminated session never delivers the `result` frame that normally
    // drives the turn-end sweep, so a sync (foreground) subagent record — the
    // one TASKS_SNAPSHOT leaves `running` on the assumption that the
    // result-frame sweep will cover it — would otherwise keep its card
    // spinning forever on a dead session. Idempotent (see the action), so
    // re-firing per page load and on a terminate→resume→terminate cycle is
    // safe.
    store.dispatch({ type: 'SESSION_TERMINATED' })
  }, [terminated, replayReady, store])

  useEffect(() => {
    sessionStoreRegistry.retain(sessionId)
    return () => {
      sessionStoreRegistry.release(sessionId)
    }
  }, [sessionId])

  // ── REST gap-fill (the seq protocol's only hole-repair path) ─────────
  //
  // One loop shape serves every caller:
  //  · a live frame whose seq jumped (the window parked it and marked
  //    `hole`) — anchor at the hole's top edge and walk down;
  //  · an `attached` reconnect catch-up (newestSeq < headSeq - 1, nothing
  //    parked yet) — anchor at headSeq and let the walk-down take over once
  //    the first page parks behind the hole.
  // Every iteration re-reads the window snapshot, so frames that landed
  // while a fetch was in flight are folded in without a second fetch chain.
  /** Every transcript page read — tail pages, gap-fill pages, AND loadOlder
   *  head pages — funnels through this validation, because a page served
   *  before the server's reset landed (pre-clear content) must never be
   *  applied: on an emptied window it would resurrect the cleared transcript
   *  AND pin the dead generation (every later page would then mismatch and
   *  be ignored, live frames of the new generation dropped). TWO stale
   *  signals, because neither alone covers every race:
   *  · **clear epoch** — a monotonic counter bumped by the session-cleared
   *    handler. Each attempt captures the epoch at request time; a result
   *    that comes back under an advanced epoch was REQUESTED before the
   *    clear. This is the only signal that works before any generation has
   *    been adopted (the window's cursor is still −1, so a floor of
   *    `generation + 1` degenerates to 0 and accepts the pre-clear gen-0
   *    page — the multi-tab /clear race).
   *  · **generation floor** (minGenerationRef) — armed by session-cleared
   *    and by the attached generation bump: a page at a LOWER generation is
   *    stale even when this client's own request raced nothing (another
   *    tab's clear moved the universe between our attach and our read).
   *  Retry on either signal: once the server's reset has landed every fetch
   *  returns the new generation, so this terminates in one round trip in
   *  practice; the cap turns a server that never actually resets into a
   *  loud error instead of a spin. */
  const fetchValidatedPage = useCallback(
    async (url: string): Promise<TranscriptPageResponse> => {
      for (let retries = 0; ; retries++) {
        const epochAtRequest = clearEpochRef.current
        const page = await api.get<TranscriptPageResponse>(url)
        const stale =
          clearEpochRef.current !== epochAtRequest ||
          (minGenerationRef.current != null && page.generation < minGenerationRef.current)
        if (!stale) return page
        if (retries >= 5) throw new Error('transcript generation moved')
      }
    },
    [],
  )

  const fillGap = useCallback(async (): Promise<void> => {
    if (fillGapRunningRef.current) {
      fillGapRerunRef.current = true
      return
    }
    fillGapRunningRef.current = true
    try {
      for (;;) {
        fillGapRerunRef.current = false
        for (;;) {
          const snap = store.getSnapshot()
          const hole = snap.hole
          const target = gapTargetRef.current
          let before: number
          if (hole) {
            // The endpoint returns messages with seq < before, so anchoring
            // just above the missing range's top edge covers [from, to] on
            // the first page (limit 200) and walks further down on the next
            // iteration when the gap is wider than one page.
            before = hole[1] + 1
          } else if (target != null && snap.newestSeq != null && snap.newestSeq < target) {
            before = target + 1
          } else {
            gapTargetRef.current = null
            break
          }
          let page: TranscriptPageResponse
          try {
            page = await fetchValidatedPage(
              `/sessions/${sessionId}/messages?before=${before}&limit=200`,
            )
          } catch {
            // Network/parse error (or a generation floor that never
            // resolves) — stop; the next live frame (or the next attached
            // handshake) re-arms the fill.
            gapTargetRef.current = null
            return
          }
          const pre = store.getSnapshot()
          store.dispatch({
            type: 'WINDOW_PAGE',
            at: 'tail',
            generation: page.generation,
            headSeq: page.headSeq,
            messages: page.messages,
            // OR, not overwrite: a hole-fill page runs mid-transcript, and
            // the page's hasMore describes content below the PAGE — which
            // the window may already hold. OR-ing can only keep hasOlder
            // true (one wasted loadOlder at worst); overwriting could flip
            // it falsely false and strand the older history.
            hasMore: page.hasMore || pre.hasOlder,
          })
          const post = store.getSnapshot()
          const progressed =
            post.newestSeq !== pre.newestSeq ||
            post.hole?.[0] !== pre.hole?.[0] ||
            post.hole?.[1] !== pre.hole?.[1]
          if (!progressed) {
            // The page changed nothing (stale generation, all seqs already
            // owned, empty range — including a tombstoned seq sitting inside
            // the hole, which no page can ever return): stop — otherwise
            // this loops forever. Known residual: a tombstone inside the
            // hole strands the parked frames until the panel is REOPENED (a
            // fresh tail page re-anchors the window); a reconnect does NOT
            // heal it — with an equal generation the attached handshake
            // finds nothing to reconcile and the gap-fill hits the same
            // no-progress wall.
            gapTargetRef.current = null
            break
          }
        }
        if (!fillGapRerunRef.current) return
      }
    } finally {
      fillGapRunningRef.current = false
    }
  }, [store, sessionId, fetchValidatedPage])

  useEffect(() => {
    if (!sessionId) return
    // ── Open path (seq-window protocol): subscribe + REST tail page ─────
    //
    // Ordering contract: the subscribe and the tail-page fetch run
    // concurrently. Frames that arrive BEFORE the page lands are dropped by
    // construction — the window is empty with generation -1, so WINDOW_LIVE's
    // liveAppend no-ops on the generation mismatch. The page is authoritative
    // for everything up to its read point; anything newer either
    // contiguous-appends, parks behind a hole (healed by fillGap), or is
    // caught by the attached handshake. Nothing can be lost: a frame the page
    // predates carries a seq ≥ the page's headSeq, so the next live frame
    // re-arms the fill.
    let cancelled = false
    // Per-run reset of the cross-session refs. This effect re-runs on
    // session switch BEFORE the session-switch reset effect below (React
    // runs effects in declaration order), so arming/clearing these here —
    // keyed to the run's own session — is what keeps a previous session's
    // generation floor or gap target from leaking into the new session's
    // open fetch.
    minGenerationRef.current = null
    clearEpochRef.current = 0
    gapTargetRef.current = null
    fillGapRerunRef.current = false

    const refetchTail = async (): Promise<void> => {
      try {
        const page = await fetchValidatedPage(`/sessions/${sessionId}/messages?limit=200`)
        if (cancelled) return
        store.dispatch({
          type: 'WINDOW_PAGE',
          at: 'tail',
          generation: page.generation,
          headSeq: page.headSeq,
          messages: page.messages,
          hasMore: page.hasMore,
        })
      } catch {
        if (!cancelled) store.dispatch({ type: 'ERROR', message: 'Failed to load transcript history' })
      }
    }

    const off = hub.addSessionListener(sessionId, (frame: WsServerFrame) => {
      switch (frame.kind) {
        case 'attached': {
          // Seq-space handshake (server sends it after every successful
          // subscribe — the reconnect catch-up trigger, spec §6).
          const snap = store.getSnapshot()
          if (snap.newestSeq == null) {
            // Empty window: the open path's tail page adopts the server's
            // generation — reconciling here would double-fetch on every
            // panel open (the handshake usually races the initial page).
            // Accepted trade: if the open fetch FAILED (error band up), an
            // attached frame arriving afterwards does not retry it — the
            // failure is surfaced loudly and the next subscribe (panel
            // reopen, running flip) re-fetches.
            break
          }
          if (frame.generation !== snap.generation) {
            // Dead universe (/clear or a server-side reset): whole-window
            // invalidation, then re-fetch the tail under the new generation.
            store.dispatch({ type: 'WINDOW_BUMP', generation: frame.generation, headSeq: frame.headSeq })
            minGenerationRef.current = frame.generation
            void refetchTail()
          } else if (snap.newestSeq < frame.headSeq - 1) {
            // Missed live frames while disconnected: page the REST gap
            // [newestSeq + 1, headSeq - 1] closed — the same paging code
            // path scroll-up loadOlder uses.
            gapTargetRef.current = frame.headSeq - 1
            void fillGap()
          }
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
          if (frame.seq != null && frame.generation != null) {
            // Seq-carrying frame — the seq-window protocol path. WINDOW_LIVE
            // REPLACES the legacy MESSAGE dispatch here (dispatching both
            // would append the message to the ordered log twice).
            store.dispatch({ type: 'WINDOW_LIVE', seq: frame.seq, generation: frame.generation, message })
            // Hole detection, snapshot convention (Task 7's plan decision —
            // the reducer keeps returning SessionState; no return-value side
            // channel): the parked-frame hole travels on the window and is
            // read from the snapshot after the dispatch. liveAppend parks
            // any seq beyond newestSeq + 1 and marks the hole; the REST page
            // over that range is fetched here.
            const snap = store.getSnapshot()
            if (snap.hole) void fillGap()
          } else {
            // No seq on the frame (synthetic / ephemeral frame: stream
            // events, pump errors) — legacy ordered-log append, no window
            // engagement.
            store.dispatch({ type: 'MESSAGE', message })
          }
          break
        }
        case 'messages-evicted': {
          // Server tombstones by seq (refusal-fallback retraction, resolved
          // user-dialog eviction). The reducer maps the seqs to their uuids
          // and reuses the uuid eviction machinery, so the ordered log and
          // the lifecycle maps stay in lockstep with the window.
          store.dispatch({ type: 'WINDOW_EVICT', seqs: frame.seqs })
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
          // message's own broadcast / next page folds it in. Either way
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
          // If the transcript never became ready (e.g. the subscribe failed
          // because the session was already torn down), MessageList shows an
          // infinite skeleton. Force the ready state so the error becomes
          // visible. WINDOW_BUMP with the CURRENT cursor is the seq-protocol
          // equivalent of the old empty REPLAY_REPLACE: it wipes to the empty
          // live state and flips replayReady. Reached only while no tail page
          // has landed (a landed page sets replayReady) — so the window is
          // empty and nothing is lost by the wipe.
          if (!store.getSnapshot().replayReady) {
            const snap = store.getSnapshot()
            store.dispatch({ type: 'WINDOW_BUMP', generation: snap.generation, headSeq: snap.headSeq })
          }
          store.dispatch({ type: 'ERROR', message: frame.message })
          break
        }
        case 'subscribe-result': {
          // The state half of a subscribe answer (the `error` frame above
          // carries the prose). `ok` means this connection is being served —
          // so a band left by an earlier refusal is stale and must go, since
          // nothing else clears intent.error on a healed panel.
          if (frame.ok === true && store.getSnapshot().error != null) {
            store.dispatch({ type: 'ERROR', message: null })
          }
          break
        }
        case 'session-cleared': {
          // SDK-emitted `cleared` control event (forwarded at server/ws.ts).
          // The local `/clear` command mints a fresh session under a new id
          // and the client swaps panels, so there is no in-place transcript
          // for that path; this handler stays for the SDK's own in-band
          // clears, which append a new init to the on-disk transcript. The
          // server's transcript store bumped its generation
          // (transcript-store.reset: generation+1, seq space zeroed). Wipe
          // to the empty live state (CLEAR_TRANSCRIPT preserves the cursor
          // values — meaningless until the next page re-anchors them), arm
          // the generation floor, and re-fetch the tail: an in-flight tail
          // page that was read BEFORE the clear carries pre-clear content
          // at the old generation, and adopting it on the emptied window
          // would resurrect the cleared transcript AND pin the dead
          // generation (every later page would then mismatch and be
          // ignored). The floor makes such a page retry — the role
          // clearedRef played before the seq protocol.
          store.dispatch({ type: 'CLEAR_TRANSCRIPT' })
          // Arm both stale signals: the floor (post-adoption case) and the
          // epoch — the epoch is what actually invalidates in-flight page
          // requests when NO generation has been adopted yet (the window's
          // cursor is still −1 here, so `generation + 1` degenerates to a
          // floor of 0 that a pre-clear gen-0 page would pass).
          minGenerationRef.current = store.getSnapshot().generation + 1
          clearEpochRef.current++
          permsRef.current.onCleared?.()
          void refetchTail()
          break
        }
        default:
          break
      }
    })

    // Subscribe. `force` — this listener needs the channel established (or
    // re-established) for itself: a confirmed-live channel alone doesn't
    // mean THIS listener's attached handshake ran (a panel mounts after a
    // resume; the server answers the subscribe with subscribe-result +
    // attached, and attached is the reconnect catch-up trigger).
    const release = hub.subscribe(sessionId, { force: true })
    void refetchTail()

    return () => {
      cancelled = true
      off()
      release()
    }
  }, [hub, sessionId, store, running, fillGap, fetchValidatedPage])

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
    // New session: reset the hook-owned paging state. The setState call is
    // intentional — loadingOlder is derived from `sessionId` and must reset
    // when it changes; there's no render-time value to compute it from. The
    // reset runs once per session switch (not every render), so the
    // cascading-render concern the rule guards against doesn't apply here.
    // (hasOlder/oldestSeq live in the store's window and reset with it;
    // minGenerationRef/gapTargetRef are reset per subscribe-effect run —
    // see the open path — which is ordered BEFORE this effect.)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingOlder(false)
    inFlightRef.current = false
  }, [sessionId])

  const loadOlder = useCallback(async (): Promise<number> => {
    if (inFlightRef.current) return 0
    // Both guards read the WINDOW snapshot (single source of truth — the
    // old cursorRef/clearedRef/burst-gate dual bookkeeping is gone):
    //  · oldestSeq == null — the window is empty (hasOlder can be stale-true
    //    on an emptied window, and paging "before null" is meaningless);
    //  · !hasOlder — the last page reported nothing older.
    // A post-/clear resurrection is blocked by the validated fetch below,
    // NOT by generation mismatching alone: CLEAR_TRANSCRIPT PRESERVES the
    // window's generation (it does not bump it) and empties it, and
    // pageLoaded bootstraps ANY generation onto an empty window — so a
    // pre-clear head page landing on the emptied window would adopt the
    // dead generation and prepend the cleared transcript. The fetch's
    // clear-epoch/floor validation discards such a page and retries.
    const snap = store.getSnapshot()
    if (!snap.hasOlder || snap.oldestSeq == null) return 0
    inFlightRef.current = true
    setLoadingOlder(true)
    try {
      // Through the validated fetch like every other page read: a head page
      // in flight when a session-cleared lands is pre-clear content, and
      // pageLoaded bootstraps ANY generation onto the emptied window — the
      // same resurrection hazard the tail and gap-fill paths guard against.
      const page = await fetchValidatedPage(
        `/sessions/${sessionId}/messages?before=${snap.oldestSeq}&limit=200`,
      )
      store.dispatch({
        type: 'WINDOW_PAGE',
        at: 'head',
        generation: page.generation,
        headSeq: page.headSeq,
        messages: page.messages,
        hasMore: page.hasMore,
      })
      // hasOlder needs no setter: pageLoaded (at:'head') writes hasMore into
      // the window and the snapshot mirrors it.
      return page.messages.length
    } catch {
      // Network/parse error — leave hasOlder as-is so the user can retry by
      // scrolling again. Don't surface to the error banner (non-fatal).
      return 0
    } finally {
      inFlightRef.current = false
      setLoadingOlder(false)
    }
  }, [store, sessionId, fetchValidatedPage])

  // True until the tail page lands — the one settle point of the seq
  // protocol. MessageList freezes the pinned-header notification during this
  // window — see its `transcriptSettling` prop.
  const transcriptSettling = !replayReady

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
      oldestSeq,
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
    [items, messages, displayedError, contextUsage, promptSuggestion, tasks, apiRetry, thinkingTokens, tokenRate, activePhase, permissionDecisions, planStatus, planContent, questionAnswers, toolStatus, toolResults, activeSubagents, subagentIndex, workflowIndex, skillIndex, replayReady, transcriptSettling, oldestSeq, insertUserMessage, ackUserMessage, rollbackUserMessage, reset, clearError, dismissSubagent, loadOlder, hasOlder, loadingOlder],
  )
}
