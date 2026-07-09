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
import type { PermissionRequest, PermissionResolved, SdkMessage, SkillFrontmatter } from '../types'

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
}

export type { ActivePhase }

export interface ChatStream {
  items: TranscriptItem[]
  messages: SdkMessage[]
  error: string | null
  contextUsage: ContextUsage | null
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
  replayReady: boolean
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
}

/** Clear all cached session state. Used in tests to avoid cross-test leaks. */
export function cacheClear() {
  void sessionStoreRegistry.clear()
  // Also wipe localStorage entries so stores recreated after clear()
  // don't reload stale data from a previous test.
  clearAllSessionStorage()
}

export function useChatStream(sessionId: string, permissions: PermissionHandlers): ChatStream {
  const hub = useWsHub()
  const hubStatus = useWsHubStatus()
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
  const replayReady = useSessionField(sessionId, 'replayReady')
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
    sessionStoreRegistry.retain(sessionId)
    return () => {
      sessionStoreRegistry.release(sessionId)
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return

    let replayMessages: SdkMessage[] = []
    let replayPermissions: PermissionRequest[] = []
    let replaying = false
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
          if (!replaying) {
            replaying = true
            replayMessages = []
            replayPermissions = []
          }
          replayMessages.push(...(frame.messages as SdkMessage[]))
          if (frame.permissions?.length) {
            replayPermissions.push(...frame.permissions)
            for (const req of frame.permissions) permsRef.current.onRequest(req)
          }
          break
        }
        case 'replay-done': {
          if (frame.permissions?.length) {
            replayPermissions.push(...frame.permissions)
            for (const req of frame.permissions) permsRef.current.onRequest(req)
          }
          store.dispatch({ type: 'REPLAY_REPLACE', messages: replayMessages, permissions: replayPermissions })
          const lastUuid = getSessionLastMessageUuid(sessionId)
          if (lastUuid) hub.setLastMessageUuid(sessionId, lastUuid)
          replayMessages = []
          replayPermissions = []
          replaying = false
          break
        }
        case 'message': {
          const message = frame.message as SdkMessage
          store.dispatch({ type: 'MESSAGE', message })
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
        case 'context-usage': {
          const usage = frame.usage as ContextUsage
          store.dispatch({ type: 'CONTEXT_USAGE', usage })
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
        case 'error': {
          // If the replay never completed (e.g. subscribe failed because
          // the session was already torn down), replayReady is still false
          // and the MessageList shows an infinite loading skeleton. Force
          // replayReady=true so the skeleton clears and the error becomes
          // visible. Clear all replay buffers so a stale replay-done that
          // arrives later can't overwrite the error with error:null.
          if (!store.getSnapshot().replayReady) {
            replayMessages = []
            replayPermissions = []
            replaying = false
            store.dispatch({ type: 'REPLAY_REPLACE', messages: [], permissions: [] })
          }
          store.dispatch({ type: 'ERROR', message: frame.message })
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

    const release = hub.subscribe(sessionId, getSessionLastMessageUuid(sessionId) ?? undefined)
    return () => {
      off()
      release()
    }
  }, [hub, sessionId, store])

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
  }, [store, fetchServerPage])

  return useMemo(
    () => ({
      items,
      messages,
      error: displayedError,
      contextUsage,
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
      replayReady,
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
    [items, messages, displayedError, contextUsage, tokenRate, streamingContent, activePhase, permissionDecisions, planStatus, planContent, questionAnswers, toolStatus, toolResults, activeSubagents, subagentIndex, workflowIndex, replayReady, insertUserMessage, ackUserMessage, rollbackUserMessage, reset, clearError, dismissSubagent, loadOlder, hasOlder, loadingOlder],
  )
}
