// Multiplexed SSE subscription for one Chat session.
//
// ONE EventSource drives both SDK messages and permission events — the
// server multiplexes them onto /api/sessions/:id/stream. This matters
// because browsers cap HTTP/1.1 connections at 6 per origin; at 2 SSE
// connections per session the 3-up grid used to saturate the pool and
// any subsequent POST (including "send message") would silently queue
// until a stream ended.
//
// The queuedAhead counter optimistically tracks turns this tab posted
// that haven't seen a matching `result` yet — the server FIFO-queues
// turns but doesn't expose depth, so we count locally.

import { useCallback, useMemo, useState } from 'react'
import { useNamedEventSource } from './useSSE'
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

  const events = useMemo(
    () => ({
      // History replay on connect — we DON'T adjust queuedAhead here because
      // we can't tell which user turns in history were ours in this tab.
      replay: (data: unknown) => {
        const m = data as SdkMessage
        if (m) setMessages((prev) => [...prev, m])
      },
      'replay-done': () => {
        /* no-op marker; useful for future "loading" UI */
      },
      message: (data: unknown) => {
        const m = data as SdkMessage
        if (!m) return
        setMessages((prev) => [...prev, m])
        if (m.type === 'result') {
          setQueuedAhead((n) => (n > 0 ? n - 1 : 0))
        }
      },
      // Permission events ride on the same connection — route them out.
      permission_request: (data: unknown) => {
        permissions.onRequest(data as PermissionRequest)
      },
      permission_resolved: (data: unknown) => {
        permissions.onResolved(data as PermissionResolved)
      },
      context_usage: (data: unknown) => {
        setContextUsage(data as ContextUsage)
      },
    }),
    [permissions],
  )

  const lifecycle = useMemo(
    () => ({
      onError: () => setError('Stream disconnected. Refresh the page to retry.'),
    }),
    [],
  )

  useNamedEventSource(`/api/sessions/${sessionId}/stream`, events, lifecycle)

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
