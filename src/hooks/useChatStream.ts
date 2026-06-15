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
  sessionStoreRegistry.clear()
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
    // All live frames that arrive between `replay` and `replay-done` are
    // buffered here. We can't dispatch them immediately because
    // REPLAY_REPLACE (fired at replay-done) takes the third branch in
    // replayReplace() — `createInitialSessionState` — which wipes the
    // permissionPending/permissionDecisions/contextUsage/error fields a
    // direct dispatch would have set. The buffer is a sequence of
    // already-shaped store actions so we can flush them in arrival order
    // immediately after REPLAY_REPLACE.
    type PendingAction =
      | { type: 'MESSAGE'; message: SdkMessage }
      | { type: 'PERMISSION_REQUEST'; request: PermissionRequest }
      | {
          type: 'PERMISSION_RESOLVED'
          id: string
          decision: { behavior: 'allow' | 'deny'; persisted: boolean; message?: string }
        }
      | { type: 'CONTEXT_USAGE'; usage: ContextUsage }
      | { type: 'MESSAGE_CONSUMED'; uuid: string; consumedAt: number }
      | { type: 'ERROR'; message: string | null }
    const pendingLive: PendingAction[] = []

    const off = hub.addSessionListener(sessionId, (frame: WsServerFrame) => {
      switch (frame.kind) {
        case 'replay': {
          if (!replaying) {
            replaying = true
            replayMessages = []
            replayPermissions = []
            // Note: do NOT reset pendingLive here. It's freshly created on
            // mount and we never re-enter replay-mode from a clean state
            // without first going through replay-done (which empties it).
            // Wiping it here would drop live frames that legitimately
            // accumulated during a chunked replay where the server emits
            // a follow-up `replay` frame mid-stream.
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
          const actions = [
            { type: 'REPLAY_REPLACE', messages: replayMessages, permissions: replayPermissions } as const,
            ...pendingLive,
          ]
          store.dispatchMany(actions)
          const lastUuid = getSessionLastMessageUuid(sessionId)
          if (lastUuid) hub.setLastMessageUuid(sessionId, lastUuid)
          replayMessages = []
          replayPermissions = []
          pendingLive.length = 0
          replaying = false
          break
        }
        case 'message': {
          const message = frame.message as SdkMessage
          if (replaying) {
            pendingLive.push({ type: 'MESSAGE', message })
          } else {
            store.dispatch({ type: 'MESSAGE', message })
            const lastUuid = getSessionLastMessageUuid(sessionId)
            if (lastUuid) hub.setLastMessageUuid(sessionId, lastUuid)
          }
          break
        }
        case 'permission-request': {
          // The external onRequest handler runs immediately either way —
          // it drives modal state outside the store and shouldn't be
          // delayed by the replay window. The store action is buffered
          // during replay so REPLAY_REPLACE doesn't wipe it.
          permsRef.current.onRequest(frame.payload)
          if (replaying) {
            pendingLive.push({ type: 'PERMISSION_REQUEST', request: frame.payload })
          } else {
            store.dispatch({ type: 'PERMISSION_REQUEST', request: frame.payload })
          }
          break
        }
        case 'permission-resolved': {
          const resolved = {
            id: frame.id,
            ...frame.decision,
          }
          permsRef.current.onResolved(resolved)
          if (replaying) {
            pendingLive.push({ type: 'PERMISSION_RESOLVED', id: frame.id, decision: frame.decision })
          } else {
            store.dispatch({ type: 'PERMISSION_RESOLVED', id: frame.id, decision: frame.decision })
          }
          break
        }
        case 'context-usage': {
          const usage = frame.usage as ContextUsage
          if (replaying) {
            pendingLive.push({ type: 'CONTEXT_USAGE', usage })
          } else {
            store.dispatch({ type: 'CONTEXT_USAGE', usage })
          }
          break
        }
        case 'message-consumed': {
          // Flip the matching user bubble from "queued" to "consumed". If
          // the message itself hasn't arrived yet (frame raced ahead), the
          // reducer no-ops and the message's own broadcast / next replay
          // carries consumedAt, so it self-heals.
          if (replaying) {
            pendingLive.push({ type: 'MESSAGE_CONSUMED', uuid: frame.uuid, consumedAt: frame.consumedAt })
          } else {
            store.dispatch({ type: 'MESSAGE_CONSUMED', uuid: frame.uuid, consumedAt: frame.consumedAt })
          }
          break
        }
        case 'error': {
          if (replaying) {
            pendingLive.push({ type: 'ERROR', message: frame.message })
          } else {
            store.dispatch({ type: 'ERROR', message: frame.message })
          }
          break
        }
        case 'session-cleared': {
          // The backend confirmed a /clear and already truncated its
          // history ring (to [init, ...]). Reset the transcript store and
          // drop the local cache.
          //
          // Mid-replay guard: if a reconnect's replay raced ahead of this
          // frame, the buffers below hold PRE-clear messages (the server's
          // ring wasn't truncated yet when it built that replay). Were we
          // to leave them, the pending replay-done's REPLAY_REPLACE would
          // re-apply them on top of the freshly-reset store and resurrect
          // the cleared transcript. So drop every buffered replay/live
          // frame and force replay-mode off — the next subscribe (or the
          // post-clear live stream) repaints from the truncated ring.
          replayMessages = []
          replayPermissions = []
          pendingLive.length = 0
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

  const loadOlder = useCallback(async (): Promise<number> => {
    if (inFlightRef.current) return 0
    // After a /clear, the pre-clear transcript still exists on disk but
    // must stay hidden — refuse to page it back in for this session.
    if (clearedRef.current) return 0
    inFlightRef.current = true
    setLoadingOlder(true)
    try {
      const params = new URLSearchParams({ limit: '200' })
      if (cursorRef.current != null) {
        // Subsequent pages: page strictly before the last startIndex.
        params.set('before', String(cursorRef.current))
      } else {
        // First page: anchor on the oldest disk-stable message on screen.
        // Scan current items front-to-back for the first uuid the disk
        // transcript will recognise (assistant/system/tool_result user).
        const current = store.getState().items
        let anchor: string | null = null
        for (const it of current) {
          const u = diskStableUuid(it.msg)
          if (u) { anchor = u; break }
        }
        if (anchor) params.set('beforeUuid', anchor)
        // If no anchor exists (e.g. transcript is only user prompts so far),
        // omit both — the server returns the newest page, and dedup-by-uuid
        // in the reducer drops anything already shown.
      }

      const page = await api.get<HistoryPageResponse>(
        `/sessions/${sessionId}/history?${params.toString()}`,
      )
      cursorRef.current = page.startIndex
      setHasOlder(page.hasMore)
      if (page.messages.length === 0) return 0
      store.dispatch({ type: 'PREPEND_MESSAGES', messages: page.messages })
      return page.messages.length
    } catch {
      // Network/parse error — leave hasOlder as-is so the user can retry by
      // scrolling again. Don't surface to the error banner (non-fatal).
      return 0
    } finally {
      inFlightRef.current = false
      setLoadingOlder(false)
    }
  }, [sessionId, store])

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
      replayReady,
      insertUserMessage,
      ackUserMessage,
      rollbackUserMessage,
      reset,
      clearError,
      loadOlder,
      hasOlder,
      loadingOlder,
    }),
    [items, messages, displayedError, contextUsage, tokenRate, streamingContent, activePhase, permissionDecisions, planStatus, planContent, questionAnswers, toolStatus, toolResults, activeSubagents, subagentIndex, replayReady, insertUserMessage, ackUserMessage, rollbackUserMessage, reset, clearError, loadOlder, hasOlder, loadingOlder],
  )
}
