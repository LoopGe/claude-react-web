import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getSessionLastMessageUuid, getSessionStore, useSessionSnapshot } from '../session-store/selectors'
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
  activeSubagents: ActiveSubagent[]
  replayReady: boolean
  trackSentTurn: () => void
  /** Optimistically insert the user's message into the transcript so it
   *  appears immediately, before the server echoes it back. The real
   *  message from the WS stream will replace this placeholder. */
  insertUserMessage: (text: string) => void
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
  const snapshot = useSessionSnapshot(sessionId)
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
      return snapshot.error == null || snapshot.error === 'Stream reconnecting…'
        ? 'Stream reconnecting…'
        : snapshot.error
    }
    if (hubStatus === 'online') return snapshot.error === 'Stream reconnecting…' ? null : snapshot.error
    return snapshot.error
  }, [hubStatus, snapshot.error])

  const trackSentTurn = useCallback(() => {
    store.dispatch({ type: 'TRACK_SENT_TURN' })
  }, [store])

  const insertUserMessage = useCallback((text: string) => {
    const message: SdkMessage = {
      type: 'user',
      uuid: `optimistic:${crypto.randomUUID()}`,
      message: { role: 'user', content: text },
    }
    store.dispatch({ type: 'OPTIMISTIC_USER_MESSAGE', message })
  }, [store])

  const reset = useCallback(() => {
    store.reset()
  }, [store])

  const clearError = useCallback(() => {
    store.dispatch({ type: 'ERROR', message: null })
  }, [store])

  return useMemo(
    () => ({
      items: snapshot.items,
      messages: snapshot.messages,
      queuedAhead: snapshot.queuedAhead,
      error: displayedError,
      contextUsage: snapshot.contextUsage,
      tokenRate: snapshot.tokenRate,
      streamingContent: snapshot.streamingContent,
      activePhase: snapshot.activePhase,
      permissionDecisions: snapshot.permissionDecisions,
      planStatus: snapshot.planStatus,
      activeSubagents: snapshot.activeSubagents,
      replayReady: snapshot.replayReady,
      trackSentTurn,
      insertUserMessage,
      reset,
      clearError,
    }),
    [snapshot, displayedError, trackSentTurn, insertUserMessage, reset, clearError],
  )
}
