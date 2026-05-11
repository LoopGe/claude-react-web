// WebSocket hub — single long-lived connection shared across the app.
//
// Replaces the previous SSE-per-panel architecture. One connection per
// browser tab (regardless of how many Chat panels are open); consumers
// subscribe/unsubscribe per sessionId and receive an envelope stream
// filtered to what they care about.
//
// Design:
// - Exactly ONE <WsHubProvider> at the App root. It owns the WebSocket
//   instance and handles auto-reconnect with backoff.
// - Consumers (useChatStream, usePermissionChannel, App-level global
//   listener) read from the hub via `useWsHubContext` and attach their
//   own handlers. Handlers are stored in a ref so adding/removing a
//   listener never churns the connection.
// - The hub keeps a local record of "which sessions are we subscribed
//   to" so that on reconnect we can replay the subscribe frames
//   automatically — consumers don't re-subscribe by themselves.
// - On the first frame from the server that ISN'T a sessions-snapshot
//   we consider the connection "fully up". That's when onReconnect
//   fires on post-initial opens, so banners can clear themselves.

import { createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { WS_PATH, type WsClientFrame, type WsServerFrame } from '../ws-types'

/** Handler for any server frame. Receives the full envelope so
 *  consumers can narrow by `kind`. Returning false is ignored — this
 *  is a pure notification channel. */
export type WsHubListener = (frame: WsServerFrame) => void

/** Lifecycle state exposed to the app, used to drive the reconnecting
 *  banner. Kept coarse (online / reconnecting) rather than mirroring
 *  every WS readyState transition — the UI doesn't need that detail. */
export type WsHubStatus = 'connecting' | 'online' | 'reconnecting'

interface WsHubApi {
  /** Register a global listener. Receives ALL frames (including
   *  session-scoped ones). Returns an unregister fn. */
  addListener: (fn: WsHubListener) => () => void
  /** Register a session-scoped listener. Only receives frames whose
   *  `sessionId` field matches. This is O(1) dispatch per frame
   *  (indexed by sessionId) instead of O(N) global fan-out — use it
   *  in useChatStream for per-panel message handling. Returns an
   *  unregister fn. */
  addSessionListener: (sessionId: string, fn: WsHubListener) => () => void
  /** Idempotently subscribe a session. Safe to call repeatedly; the
   *  hub tracks ref-counts internally so multiple components can
   *  subscribe to the same session without stepping on each other. */
  subscribe: (sessionId: string) => () => void
}

const WsHubContext = createContext<WsHubApi | null>(null)

// Status lives in its own context so that status changes (connecting →
// online → reconnecting) don't change the hub object's identity.
// Components that read hub status use useWsHubStatus() instead of
// hub.status, keeping the hub referentially stable across flips.
const WsStatusContext = createContext<WsHubStatus>('connecting')

/** URL the hub connects to — relative to the current origin so it
 *  works in both dev (Vite proxies /api/ws to 3456) and prod (served
 *  from the same origin as /api). */
function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}${WS_PATH}`
}

interface ProviderProps {
  children: ReactNode
  /** Override the URL for tests. Default derives from window.location. */
  url?: string
}

export function WsHubProvider({ children, url }: ProviderProps) {
  // Listeners are stored in a ref so add/remove doesn't re-create the
  // connection. React state only holds the coarse `status` for banner
  // rendering.
  const listenersRef = useRef<Set<WsHubListener>>(new Set())
  const sessionListenersRef = useRef<Map<string, Set<WsHubListener>>>(new Map())
  const refCountsRef = useRef<Map<string, number>>(new Map())
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const pingTimerRef = useRef<number | null>(null)
  const attemptsRef = useRef<number>(0)
  const unmountedRef = useRef(false)
  // Ref to break the circular dependency between connect ↔ scheduleReconnect.
  // connect is declared first; scheduleReconnect calls connectRef.current().
  const connectRef = useRef<() => void>(() => {})
  const [status, setStatus] = useState<WsHubStatus>('connecting')

  /** Send a frame if the socket is open. Silently drops otherwise —
   *  callers re-issue subscribes on (re)open, so a dropped frame
   *  during reconnect isn't fatal. */
  const safeSend = useCallback((frame: WsClientFrame) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      /* socket may have transitioned to CLOSING; ignore */
    }
  }, [])

  // Reconnect scheduler — declared before `connect` so it can be
  // referenced without a forward-declaration lint error. The actual
  // connect fn is called through connectRef to break the cycle.
  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return
    setStatus('reconnecting')
    // Exponential backoff, capped. Jitter prevents the "thundering
    // herd" when the server comes back and 200 tabs all connect at
    // the same millisecond.
    const attempt = attemptsRef.current
    attemptsRef.current = attempt + 1
    const base = Math.min(500 * 2 ** attempt, 15_000)
    const jitter = Math.random() * 400
    const delay = base + jitter
    if (reconnectTimerRef.current != null) window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      connectRef.current()
    }, delay)
  }, [])

  // Actual connect logic — separated from the main effect so the
  // reconnect path can reuse it.
  const connect = useCallback(() => {
    if (unmountedRef.current) return
    const target = url ?? wsUrl()
    let ws: WebSocket
    try {
      ws = new WebSocket(target)
    } catch (err) {
      // Some browsers throw synchronously on bad URLs. Schedule a
      // retry rather than crashing the React tree.
      console.error('[wsHub] failed to construct WebSocket:', err)
      scheduleReconnect()
      return
    }
    wsRef.current = ws

    ws.addEventListener('open', () => {
      if (unmountedRef.current) return
      attemptsRef.current = 0
      setStatus('online')
      // Re-subscribe to every session we were holding. Server treats
      // duplicate subscribes as idempotent, so a tab that never
      // disconnected doesn't get clobbered either.
      for (const sessionId of refCountsRef.current.keys()) {
        safeSend({ kind: 'subscribe', sessionId })
      }
      // App-level heartbeat — some reverse proxies close idle WS
      // after 30-60s. A 25s app-level ping is safely below that, and
      // the server echoes a tiny pong so we also get a failure
      // signal if the pipe is half-closed.
      if (pingTimerRef.current != null) window.clearInterval(pingTimerRef.current)
      pingTimerRef.current = window.setInterval(() => {
        safeSend({ kind: 'ping', nonce: Date.now() })
      }, 25_000)
    })

    ws.addEventListener('message', (ev) => {
      let frame: WsServerFrame
      try {
        frame = JSON.parse(ev.data) as WsServerFrame
      } catch {
        return
      }
      if (!frame || typeof frame !== 'object' || typeof frame.kind !== 'string') return
      // Fan out to global listeners (O(N) where N is total listeners).
      for (const fn of listenersRef.current) {
        try {
          fn(frame)
        } catch (err) {
          console.error('[wsHub] listener threw:', err)
        }
      }
      // Fan out to session-scoped listeners (O(1) lookup by sessionId).
      // This is the fast path used by useChatStream — each panel only
      // processes frames for its own session without scanning others.
      const sid = 'sessionId' in frame ? (frame as { sessionId?: string }).sessionId : undefined
      if (sid) {
        const sessionSet = sessionListenersRef.current.get(sid)
        if (sessionSet) {
          for (const fn of sessionSet) {
            try {
              fn(frame)
            } catch (err) {
              console.error('[wsHub] session listener threw:', err)
            }
          }
        }
      }
    })

    ws.addEventListener('close', () => {
      if (unmountedRef.current) return
      if (pingTimerRef.current != null) {
        window.clearInterval(pingTimerRef.current)
        pingTimerRef.current = null
      }
      scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // Browsers don't give useful detail here; the close event follows
      // and scheduleReconnect handles the retry. Logging the event
      // itself is noise.
    })
  }, [safeSend, url, scheduleReconnect])
  // Keep the ref in sync so scheduleReconnect (empty-dep) always calls
  // the latest connect closure. Layout effect avoids react-hooks/refs.
  useLayoutEffect(() => {
    connectRef.current = connect
  })

  useEffect(() => {
    unmountedRef.current = false
    connect()
    return () => {
      unmountedRef.current = true
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (pingTimerRef.current != null) {
        window.clearInterval(pingTimerRef.current)
        pingTimerRef.current = null
      }
      const ws = wsRef.current
      wsRef.current = null
      if (ws) {
        try {
          ws.close(1000, 'client unmounting')
        } catch {
          /* ignore */
        }
      }
    }
    // connect is referentially stable (wrapped in useCallback with
    // stable deps); we only want this effect once for the provider's
    // lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addListener = useCallback((fn: WsHubListener) => {
    listenersRef.current.add(fn)
    return () => {
      listenersRef.current.delete(fn)
    }
  }, [])

  const addSessionListener = useCallback((sessionId: string, fn: WsHubListener) => {
    let set = sessionListenersRef.current.get(sessionId)
    if (!set) {
      set = new Set()
      sessionListenersRef.current.set(sessionId, set)
    }
    set.add(fn)
    return () => {
      const s = sessionListenersRef.current.get(sessionId)
      if (!s) return
      s.delete(fn)
      if (s.size === 0) sessionListenersRef.current.delete(sessionId)
    }
  }, [])

  const subscribe = useCallback(
    (sessionId: string) => {
      const cur = refCountsRef.current.get(sessionId) ?? 0
      refCountsRef.current.set(sessionId, cur + 1)
      if (cur === 0) {
        // First subscriber for this session — ask server to start
        // streaming. Any frames that arrive before this subscribe is
        // acknowledged by the server are impossible because we drop
        // the send if socket isn't OPEN; when it reopens we replay
        // all subscribes.
        safeSend({ kind: 'subscribe', sessionId })
      }
      return () => {
        const c = refCountsRef.current.get(sessionId) ?? 0
        if (c <= 1) {
          refCountsRef.current.delete(sessionId)
          safeSend({ kind: 'unsubscribe', sessionId })
        } else {
          refCountsRef.current.set(sessionId, c - 1)
        }
      }
    },
    [safeSend],
  )

  // Memoize so the controls part (addListener/subscribe) has stable
  // identity across re-renders. Status is deliberately excluded — it
  // lives in its own WsStatusContext so status flips (connecting →
  // online → reconnecting) don't change the hub object's identity.
  // This prevents effect teardown/rebuild in consumers like
  // useChatStream that have `[hub]` in their dependency arrays.
  const api = useMemo<WsHubApi>(
    () => ({ addListener, addSessionListener, subscribe }),
    [addListener, addSessionListener, subscribe],
  )
  return createElement(
    WsHubContext.Provider,
    // eslint-disable-next-line react-hooks/refs -- api is memoized, not a live ref
    { value: api },
    createElement(WsStatusContext.Provider, { value: status }, children),
  )
}

/** Imperative hub handle for hooks that need to both subscribe and
 *  listen. Throws if used outside a <WsHubProvider>. The returned
 *  object is referentially stable across status changes — read
 *  status via useWsHubStatus() instead. */
export function useWsHub(): WsHubApi {
  const ctx = useContext(WsHubContext)
  if (!ctx) throw new Error('useWsHub must be used inside <WsHubProvider>')
  return ctx
}

/** Read the current WebSocket hub lifecycle status. Separated from
 *  useWsHub so status flips don't change the hub object's identity
 *  and trigger effect teardown in consumers. */
export function useWsHubStatus(): WsHubStatus {
  return useContext(WsStatusContext)
}
