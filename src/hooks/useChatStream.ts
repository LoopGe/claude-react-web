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

import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWsHub, useWsHubStatus } from './useWsHub'
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
  const [opError, setOpError] = useState<string | null>(null)
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

  // Reset per-session state when sessionId changes. Uses
  // useLayoutEffect so the reset happens before paint but avoids both
  // react-hooks/set-state-in-effect and react-hooks/refs.
  const prevSessionRef = useRef(sessionId)
  useLayoutEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId
      setMessages([])
      setContextUsage(null)
      setQueuedAhead(0)
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return

    // Buffer messages that arrive BEFORE the replay completes into a
    // single commit. The server guarantees per-session frame order:
    //   {replay*, replay-done, (message|permission-request|...)*}
    // For small histories (≤50 msgs) this is a single replay + done.
    // For large histories the server chunks into 50-message replay
    // batches followed by a replay-done that carries the permissions.
    // Either way, we append on each replay frame and flush on done.
    let replayDone = false
    const pending: SdkMessage[] = []

    // Use the session-scoped listener: the hub pre-filters by sessionId
    // so we avoid the O(N panels) scan that `addListener` would do on
    // every frame. This is the key change that prevents one panel's
    // high-traffic session from delaying another panel's updates.
    const off = hub.addSessionListener(sessionId, (frame: WsServerFrame) => {
      switch (frame.kind) {
        case 'replay': {
          // Chunked replay: append each batch (small histories arrive
          // in one frame, large ones in chunks of 50).
          startTransition(() => {
            setMessages((prev) => [...prev, ...(frame.messages as SdkMessage[])])
          })
          // Permissions are on the first chunk only for small replays;
          // for chunked replays they arrive on replay-done instead.
          if (frame.permissions?.length) {
            for (const p of frame.permissions) {
              permsRef.current.onRequest(p)
            }
          }
          break
        }
        case 'replay-done': {
          replayDone = true
          // Flush any live messages that queued during replay.
          startTransition(() => {
            if (pending.length) {
              setMessages((prev) => [...prev, ...pending])
              pending.length = 0
            }
          })
          // Chunked replay: permissions ride on the final replay-done.
          if (frame.permissions?.length) {
            for (const p of frame.permissions) {
              permsRef.current.onRequest(p)
            }
          }
          break
        }
        case 'message': {
          const m = frame.message as SdkMessage
          if (!replayDone) {
            pending.push(m)
            return
          }
          // startTransition coalesces rapid successive message frames
          // (e.g. streaming tool-use deltas) into fewer re-renders.
          startTransition(() => {
            setMessages((prev) => [...prev, m])
          })
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
          setOpError(frame.message)
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

  // Hub status → per-panel banner. Derived via useMemo to avoid calling
  // setState inside an effect (react-hooks/set-state-in-effect).
  const hubStatus = useWsHubStatus()
  const displayedError = useMemo(() => {
    if (hubStatus === 'reconnecting')
      return opError === null || opError === 'Stream reconnecting…'
        ? 'Stream reconnecting…'
        : opError
    if (hubStatus === 'online') return opError === 'Stream reconnecting…' ? null : opError
    return opError
  }, [opError, hubStatus])

  const trackSentTurn = useCallback(() => {
    setQueuedAhead((n) => n + 1)
  }, [])

  const reset = useCallback(() => {
    setMessages([])
    setQueuedAhead(0)
    setOpError(null)
    setContextUsage(null)
  }, [])

  const clearError = useCallback(() => setOpError(null), [])

  return useMemo(
    () => ({ messages, queuedAhead, error: displayedError, contextUsage, trackSentTurn, reset, clearError }),
    [messages, queuedAhead, displayedError, contextUsage, trackSentTurn, reset, clearError],
  )
}
