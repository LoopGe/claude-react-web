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
   *  session-scope ones). Returns an unregister fn. */
  addListener: (fn: WsHubListener) => () => void
  /** Register a session-scope listener. Only receives frames whose
   *  `sessionId` field matches. This is O(1) dispatch per frame
   *  (indexed by sessionId) instead of O(N) global fan-out — use it
   *  in useChatStream for per-panel message handling. Returns an
   *  unregister fn. */
  addSessionListener: (sessionId: string, fn: WsHubListener) => () => void
  /** Idempotently subscribe a session. Safe to call repeatedly; the
   *  hub tracks ref-counts internally so multiple components can
   *  subscribe to the same session without stepping on each other.
   *  A frame is sent on the first holder AND whenever the server has not
   *  confirmed a channel for that session here (see applyChannelLiveness) —
   *  a refused subscribe must not be able to strand a later consumer with
   *  no replay. Pass `sinceUuid` for incremental replay (server sends only
   *  messages after that UUID). */
  subscribe: (sessionId: string, sinceUuid?: string) => () => void
  /** Force a subscribe frame for a session, bypassing BOTH guards
   *  `subscribe` applies (the 0→1 ref-count and the known-live check).
   *  For consumers that know their listener needs a replay right now even
   *  though the hub believes the channel is served — e.g. useChatStream on
   *  an observed dormant/slept → running flip. Server treats a repeated
   *  subscribe as an idempotent no-op when a channel already exists. */
  resubscribe: (sessionId: string, sinceUuid?: string) => void
  /** Update the last known message UUID for a session. Used for
   *  incremental replay on reconnect — the hub stores this and sends
   *  it with re-subscribe frames after a connection drop. */
  setLastMessageUuid: (sessionId: string, uuid: string) => void
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

/** Fold one inbound frame into the set of sessions whose message channel the
 *  server has ACTUALLY established on this connection.
 *
 *  A ref-count is a count of interested consumers, not of live channels: a
 *  subscribe sent for a session the server cannot serve yet still increments
 *  the count while establishing nothing. Trusting the count alone made that
 *  first, failed subscribe poison the session for everyone else — the panel's
 *  <Chat>/useChatStream mounts only once the session is running, and its
 *  subscribe was then suppressed as a duplicate, so the server was never asked
 *  for a replay and the transcript rendered blank on EVERY resume.
 *
 *  (Verified against the server: a session the user put to sleep — or one it
 *  has never heard of — is refused with `session X not found`, because
 *  startSession deliberately will not wake a slept session from a subscribe.
 *  A merely dormant session IS auto-resumed there and served normally.)
 *
 *  So the hub tracks the truth from the server's own answers:
 *   • `replay` — the subscribe was served: the channel exists. This is the
 *     ONLY positive signal, because the success path always sends at least one
 *     `replay` (an empty one included) before its `replay-done`, while the
 *     REFUSAL path sends `error` + `replay-done` with no replay at all — a
 *     `replay-done` is therefore not evidence of anything.
 *   • `error` — the subscribe was refused: nothing was established.
 *   • `session-update` with the session no longer running — every server
 *     teardown path (unload / sleep / spawn-failed / crash) ends the subscriber
 *     queues AND broadcasts `running: false` (session-manager.ts:4854, :861), so
 *     a channel recorded earlier is gone even though no frame said so.
 *   • `session-removed` — the session left the store entirely (`/clear`,
 *     discard, delete from another tab), which is the one teardown that
 *     broadcasts `removed` instead of the dormant update; the id can come back
 *     later via resume(X), so the entry must not outlive it.
 *
 *  Only the NEGATIVE direction of `session-update` is read: a RUNNING session
 *  may still have no channel here (that is the resume case), and marking it
 *  live would re-create the very suppression this guards against.
 *
 *  Every field access is shape-checked: this runs on the hot path before
 *  fan-out, where the handler's only other validation is `typeof frame.kind`,
 *  and a throw here would drop the frame for every listener on the socket. */
function applyChannelLiveness(live: Set<string>, frame: WsServerFrame): void {
  switch (frame.kind) {
    case 'replay':
      if (typeof frame.sessionId === 'string') live.add(frame.sessionId)
      break
    case 'error':
      // Best-effort echo — connection-level errors carry no sessionId.
      if (typeof frame.sessionId === 'string') live.delete(frame.sessionId)
      break
    case 'session-removed':
      if (typeof frame.id === 'string') live.delete(frame.id)
      break
    case 'session-update': {
      const session = frame.session as { id?: unknown; running?: unknown } | undefined
      if (session && typeof session.id === 'string' && session.running === false) {
        live.delete(session.id)
      }
      break
    }
    default:
      break
  }
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
  /** Last known message UUID per session. Sent with subscribe frames so
   *  the server can do incremental replay instead of full history. Also
   *  used on reconnect to avoid re-sending the entire message history. */
  const lastUuidRef = useRef<Map<string, string | null>>(new Map())
  /** Sessions whose channel the server has confirmed as established on the
   *  CURRENT socket (see applyChannelLiveness). Cleared whenever the socket
   *  is replaced — channels do not survive a connection. */
  const liveSessionsRef = useRef<Set<string>>(new Set())
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
    // Close any existing socket before creating a new one to prevent
    // orphaned connections accumulating during rapid reconnects.
    const old = wsRef.current
    if (old && old.readyState !== WebSocket.CLOSED) {
      try { old.close(1000, 'replaced') } catch { /* already closing */ }
    }
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
      // A fresh socket owns no channels — whatever we recorded as live died
      // with the previous connection. Every held session is re-subscribed
      // just below and re-confirmed by its replay.
      liveSessionsRef.current.clear()
      // Re-subscribe to every session we were holding. Server treats
      // duplicate subscribes as idempotent, so a tab that never
      // disconnected doesn't get clobbered either.
      for (const sessionId of refCountsRef.current.keys()) {
        const sinceUuid = lastUuidRef.current.get(sessionId) ?? undefined
        safeSend({ kind: 'subscribe', sessionId, ...(sinceUuid ? { sinceUuid } : {}) })
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
      if (unmountedRef.current) return
      let frame: WsServerFrame
      try {
        frame = JSON.parse(ev.data) as WsServerFrame
      } catch {
        return
      }
      if (!frame || typeof frame !== 'object' || typeof frame.kind !== 'string') return
      // Track channel liveness BEFORE fan-out so a listener reacting to this
      // frame (e.g. one that re-subscribes on an `error`) sees the updated set.
      applyChannelLiveness(liveSessionsRef.current, frame)
      // Fan out to global listeners (O(N) where N is total listeners).
      for (const fn of listenersRef.current) {
        try {
          fn(frame)
        } catch (err) {
          console.error('[wsHub] listener threw:', err)
        }
      }
      // Fan out to session-scope listeners (O(1) lookup by sessionId).
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
      // Only react if this socket is still the active one. When
      // connect() replaces a socket, the old socket's close event
      // still fires — without this guard it would schedule a
      // reconnect that closes the *new* working socket.
      if (wsRef.current !== ws) return
      // The connection is gone, so its channels are too. Clearing here (and
      // not only on the next open) keeps "live" == "live on the current
      // socket" true for the whole reconnect gap.
      liveSessionsRef.current.clear()
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
    (sessionId: string, sinceUuid?: string) => {
      const cur = refCountsRef.current.get(sessionId) ?? 0
      refCountsRef.current.set(sessionId, cur + 1)
      // Send unless the server has already confirmed a channel here. The
      // ref-count alone is NOT that confirmation: a subscribe refused for a
      // slept/unservable session still counted a holder, so a later consumer —
      // the one that actually needs the replay, since <Chat>/useChatStream
      // only mounts once the session runs — was suppressed as a duplicate and
      // the session was never served. On a live channel the repeat is an
      // idempotent no-op server-side (a `debug` line, no second replay), so
      // erring toward sending is cheap; erring toward silence was the bug.
      //
      // Deliberately NOT tracked: an in-flight ("sent, not yet answered")
      // state to suppress those repeats. Its stale direction — believing a
      // subscribe is still in flight when its answer was swallowed by the
      // server's `starting`/`subs.has` guard — skips a frame a listener needs,
      // which is the blank transcript again. Paying one extra ignored frame
      // keeps every failure mode on the harmless side.
      if (cur === 0 || !liveSessionsRef.current.has(sessionId)) {
        // Any frames arriving before the server acknowledges this subscribe
        // are impossible: the send is dropped while the socket isn't OPEN,
        // and on reopen every held session is re-subscribed.
        if (sinceUuid) lastUuidRef.current.set(sessionId, sinceUuid)
        safeSend({ kind: 'subscribe', sessionId, ...(sinceUuid ? { sinceUuid } : {}) })
      }
      return () => {
        const c = refCountsRef.current.get(sessionId) ?? 0
        if (c <= 1) {
          refCountsRef.current.delete(sessionId)
          lastUuidRef.current.delete(sessionId)
          // The unsubscribe below tears the channel down, so it is no longer
          // live for the next holder.
          liveSessionsRef.current.delete(sessionId)
          safeSend({ kind: 'unsubscribe', sessionId })
        } else {
          refCountsRef.current.set(sessionId, c - 1)
        }
      }
    },
    [safeSend],
  )

  const setLastMessageUuid = useCallback((sessionId: string, uuid: string) => {
    lastUuidRef.current.set(sessionId, uuid)
  }, [])

  // Force a fresh subscribe frame for a session, bypassing BOTH guards
  // `subscribe` applies (the 0→1 ref-count and the known-live check). Used by
  // consumers that know their listener needs a replay NOW — e.g. useChatStream
  // on an observed dormant-or-slept → running flip.
  // The server treats a repeated subscribe as an idempotent no-op when a live
  // channel exists, so this is harmless when the channel is already served.
  const resubscribe = useCallback(
    (sessionId: string, sinceUuid?: string) => {
      if (sinceUuid) lastUuidRef.current.set(sessionId, sinceUuid)
      safeSend({ kind: 'subscribe', sessionId, ...(sinceUuid ? { sinceUuid } : {}) })
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
    () => ({ addListener, addSessionListener, subscribe, resubscribe, setLastMessageUuid }),
    [addListener, addSessionListener, subscribe, resubscribe, setLastMessageUuid],
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
