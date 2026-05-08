// Per-session view onto the shared WebSocket hub.
//
// Replaces the old per-session SSE connection. All frames arrive on
// the single hub connection owned by <WsHubProvider>; this hook
// filters by sessionId and dispatches to local state + injected
// permission handlers. One hub connection serves all panels regardless
// of how many Chat components are mounted.
//
// The `queuedAhead` counter optimistically tracks turns this tab
// posted that haven't seen a matching `result` yet — the server FIFO-
// queues turns but doesn't expose depth, so we count locally.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWsHub } from './useWsHub'
import type { WsServerFrame } from '../ws-types'
import type { PermissionRequest, PermissionResolved, SdkMessage } from '../types'

export interface ContextUsage {
  totalTokens?: number
  maxTokens?: number
  percentage?: number
  model?: string
}

export interface ChatStream {
  messages: SdkMessage[]
  queuedAhead: number
  error: string | null
  /** Latest context-usage snapshot pushed by the server mid-stream. */
  contextUsage: ContextUsage | null
  /** Bump the queued counter by one (call after POST /messages succeeds). */
  trackSentTurn: () => void
  /** Clear all local state — used when switching between sessions. */
  reset: () => void
  /** Clear just the error banner. */
  clearError: () => void
}

export interface PermissionHandlers {
  onRequest: (req: PermissionRequest) => void
  onResolved: (res: PermissionResolved) => void
}

export function useChatStream(sessionId: string, permissions: PermissionHandlers): ChatStream {
  const [messages, setMessages] = useState<SdkMessage[]>([])
  const [queuedAhead, setQueuedAhead] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)

  const hub = useWsHub()

  // Stash the permission handlers in a ref so changing them doesn't
  // re-run the subscribe effect (which would briefly unsubscribe and
  // re-subscribe from the hub, causing the server to resend a full
  // replay and the UI to blink).
  const permsRef = useRef(permissions)
  useEffect(() => {
    permsRef.current = permissions
  })

  useEffect(() => {
    if (!sessionId) return
    // Reset per-session state when switching to a different session.
    // (Chat remounts on key={session.id}, so this is also true at
    // mount — keeping it explicit costs nothing and guards against
    // hot-reload edge cases.)
    setMessages([])
    setContextUsage(null)
    setQueuedAhead(0)

    // Buffer messages that arrive BEFORE the replay frame completes
    // into a single commit, so React doesn't re-render N times while
    // we're walking through a large history.
    //
    // The server guarantees: for a given sessionId, the frame order is
    // {replay, replay-done, (message|permission-request|...)*}. We
    // accept live frames arriving AFTER replay-done as normal pushes.
    // If a late frame sneaks in before replay-done (shouldn't happen,
    // but be defensive) we append it to the pending queue too — it
    // lands in the right place once we flush.
    let replayDone = false
    const pending: SdkMessage[] = []

    const off = hub.addListener((frame: WsServerFrame) => {
      // Only frames for our session; other panels have their own
      // listeners and the global App listener handles session-list
      // frames.
      if (!('sessionId' in frame) || frame.sessionId !== sessionId) return

      switch (frame.kind) {
        case 'replay': {
          // Fresh replay batch — treat as the source of truth for
          // state. Any previously-buffered permissions in the replay
          // get forwarded to the injected handler so open modals
          // re-appear after a reconnect.
          setMessages(frame.messages as SdkMessage[])
          for (const p of frame.permissions) {
            permsRef.current.onRequest(p)
          }
          break
        }
        case 'replay-done': {
          replayDone = true
          if (pending.length) {
            setMessages((prev) => [...prev, ...pending])
            pending.length = 0
          }
          break
        }
        case 'message': {
          const m = frame.message as SdkMessage
          if (!replayDone) {
            pending.push(m)
            return
          }
          setMessages((prev) => [...prev, m])
          if (m.type === 'result') {
            setQueuedAhead((n) => (n > 0 ? n - 1 : 0))
          }
          break
        }
        case 'permission-request': {
          permsRef.current.onRequest(frame.payload)
          break
        }
        case 'permission-resolved': {
          permsRef.current.onResolved({
            id: frame.id,
            ...frame.decision,
          })
          break
        }
        case 'context-usage': {
          setContextUsage(frame.usage as ContextUsage)
          break
        }
        case 'error': {
          // Session-scoped error from the hub (usually "unknown session").
          // Surface it in the panel banner but don't tear down state;
          // the server might still be starting up.
          setError(frame.message)
          break
        }
        default:
          break
      }
    })

    const release = hub.subscribe(sessionId)
    return () => {
      off()
      release()
    }
  }, [hub, sessionId])

  // Hub status → per-panel banner. Identical wording/semantics to the
  // App-level banner so the user sees a consistent story whichever one
  // is attached to their panel.
  useEffect(() => {
    if (hub.status === 'reconnecting') {
      setError((prev) =>
        prev === null || prev === 'Stream reconnecting…' ? 'Stream reconnecting…' : prev,
      )
    } else if (hub.status === 'online') {
      setError((prev) => (prev === 'Stream reconnecting…' ? null : prev))
    }
  }, [hub.status])

  const trackSentTurn = useCallback(() => {
    setQueuedAhead((n) => n + 1)
  }, [])

  const reset = useCallback(() => {
    setMessages([])
    setQueuedAhead(0)
    setError(null)
    setContextUsage(null)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return useMemo(
    () => ({ messages, queuedAhead, error, contextUsage, trackSentTurn, reset, clearError }),
    [messages, queuedAhead, error, contextUsage, trackSentTurn, reset, clearError],
  )
}
