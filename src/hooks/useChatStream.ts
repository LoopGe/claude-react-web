// SSE subscription + user-turn queue counter for one Chat session.
//
// Why this exists: keeping the subscription wiring next to the queue
// arithmetic makes both things easier to reason about. The `queuedAhead`
// counter ONLY tracks turns the current tab sent that haven't completed
// — it's an optimistic local estimate, not authoritative state. The
// server queues turns FIFO, but doesn't expose "how many are queued",
// so we count them ourselves and decrement on every `result` message.

import { useCallback, useMemo, useState } from 'react'
import { useSSE } from './useSSE'
import type { SdkMessage } from '../types'

export interface ChatStream {
  messages: SdkMessage[]
  queuedAhead: number
  error: string | null
  /** Bump the queued counter by one (call after POST /messages succeeds). */
  trackSentTurn: () => void
  /** Clear all local state — used when switching between sessions. */
  reset: () => void
  /** Clear just the error banner. */
  clearError: () => void
}

export function useChatStream(sessionId: string): ChatStream {
  const [messages, setMessages] = useState<SdkMessage[]>([])
  const [queuedAhead, setQueuedAhead] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useSSE(`/api/sessions/${sessionId}/stream`, {
    // Replay means we're rebuilding from history on (re)connect — we do NOT
    // know how many of those user turns were ours in this tab, so leave the
    // queued counter alone. It only tracks turns sent from this tab that
    // haven't completed yet.
    onReplay: (m) => setMessages((prev) => [...prev, m]),
    onMessage: (m) => {
      setMessages((prev) => [...prev, m])
      if (m.type === 'result') {
        setQueuedAhead((n) => (n > 0 ? n - 1 : 0))
      }
    },
    onError: () => setError('Stream disconnected. Refresh the page to retry.'),
  })

  const trackSentTurn = useCallback(() => {
    setQueuedAhead((n) => n + 1)
  }, [])

  const reset = useCallback(() => {
    setMessages([])
    setQueuedAhead(0)
    setError(null)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  // Memoise so consumers can put the whole object in a useCallback dep
  // list without re-creating downstream callbacks on every render.
  return useMemo(
    () => ({ messages, queuedAhead, error, trackSentTurn, reset, clearError }),
    [messages, queuedAhead, error, trackSentTurn, reset, clearError],
  )
}
