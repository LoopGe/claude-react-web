import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getSessionLastMessageUuid, getSessionStore, useSessionField } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import { clearAllSessionStorage } from '../session-store/store'
import type { ActiveSubagent, ActivePhase, PlanStatus, TranscriptItem } from '../session-store/types'
import { useWsHub, useWsHubStatus } from './useWsHub'
import type { WsServerFrame } from '../ws-types'
import type { PermissionRequest, PermissionResolved, SdkMessage, SkillFrontmatter } from '../types'

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
  queuedAhead: number
  error: string | null
  contextUsage: ContextUsage | null
  tokenRate: number | null
  streamingContent: string | null
  activePhase: ActivePhase
  permissionDecisions: ReadonlyMap<string, 'allow' | 'deny'>
  planStatus: ReadonlyMap<string, PlanStatus>
  planContent: ReadonlyMap<string, string>
  activeSubagents: ActiveSubagent[]
  subagentIndex: ReadonlyMap<string, ActiveSubagent>
  replayReady: boolean
  trackSentTurn: () => void
  /** Optimistically insert the user's message into the transcript so it
   *  appears immediately, before the server echoes it back. Returns the
   *  pendingId so the caller can roll it back if the POST fails. The
   *  real message from the WS stream will replace this placeholder
   *  (matched by id, not by content — works for multimodal too). */
  insertUserMessage: (text: string) => string
  /** Remove a previously-inserted optimistic user message. Used by the
   *  Composer's send() catch path so a failed POST doesn't leave a
   *  ghost row in the transcript. */
  rollbackUserMessage: (pendingId: string) => void
  reset: () => void
  clearError: () => void
}

export interface PermissionHandlers {
  onRequest: (req: PermissionRequest) => void
  onResolved: (res: PermissionResolved) => void
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
  const queuedAhead = useSessionField(sessionId, 'queuedAhead')
  const permissionDecisions = useSessionField(sessionId, 'permissionDecisions')
  const planStatus = useSessionField(sessionId, 'planStatus')
  const planContent = useSessionField(sessionId, 'planContent')
  const activeSubagents = useSessionField(sessionId, 'activeSubagents')
  const subagentIndex = useSessionField(sessionId, 'subagentIndex')
  const replayReady = useSessionField(sessionId, 'replayReady')
  const permsRef = useRef(permissions)

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
    const pendingLive: SdkMessage[] = []

    const off = hub.addSessionListener(sessionId, (frame: WsServerFrame) => {
      switch (frame.kind) {
        case 'replay': {
          if (!replaying) {
            replaying = true
            replayMessages = []
            replayPermissions = []
            pendingLive.length = 0
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
            ...pendingLive.map((message) => ({ type: 'MESSAGE', message } as const)),
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
            pendingLive.push(message)
          } else {
            store.dispatch({ type: 'MESSAGE', message })
            const lastUuid = getSessionLastMessageUuid(sessionId)
            if (lastUuid) hub.setLastMessageUuid(sessionId, lastUuid)
          }
          break
        }
        case 'permission-request': {
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
        case 'context-usage':
          store.dispatch({ type: 'CONTEXT_USAGE', usage: frame.usage as ContextUsage })
          break
        case 'error':
          store.dispatch({ type: 'ERROR', message: frame.message })
          break
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

  const trackSentTurn = useCallback(() => {
    store.dispatch({ type: 'TRACK_SENT_TURN' })
  }, [store])

  const insertUserMessage = useCallback((text: string): string => {
    const pendingId = `optimistic:${crypto.randomUUID()}`
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

  const reset = useCallback(() => {
    store.reset()
  }, [store])

  const clearError = useCallback(() => {
    store.dispatch({ type: 'ERROR', message: null })
  }, [store])

  return useMemo(
    () => ({
      items,
      messages,
      queuedAhead,
      error: displayedError,
      contextUsage,
      tokenRate,
      streamingContent,
      activePhase,
      permissionDecisions,
      planStatus,
      planContent,
      activeSubagents,
      subagentIndex,
      replayReady,
      trackSentTurn,
      insertUserMessage,
      rollbackUserMessage,
      reset,
      clearError,
    }),
    [items, messages, queuedAhead, displayedError, contextUsage, tokenRate, streamingContent, activePhase, permissionDecisions, planStatus, planContent, activeSubagents, subagentIndex, replayReady, trackSentTurn, insertUserMessage, rollbackUserMessage, reset, clearError],
  )
}
