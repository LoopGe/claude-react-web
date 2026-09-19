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
import type { WsClientFrame, WsServerFrame } from '../ws-types'
import { getTransport, type TransportConnection, type TransportFrameHandlers } from '../transport'

/** Per-subscribe options (see WsHubApi.subscribe). */
export interface SubscribeOpts {
  /** Require a replay for the caller's own listener: the server re-serves it
   *  for the `sinceUuid` given. Use when a new listener attaches — a panel
   *  mounting, or one that attached after an earlier burst — because a
   *  confirmed-live channel alone does not mean THIS listener ever saw the
   *  history. */
  force?: boolean
  /** Opt into tail-first replay: on a no-cache cold start (no sinceUuid)
   *  the server sends the newest chunk first (`tail: true` — rendered
   *  immediately) and the rest newest→oldest as `backfill: true` frames
   *  the client prepends. The server only honors this together with an
   *  absent sinceUuid and ignores the field entirely on older builds. */
  replayMode?: 'tail-backfill'
}

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
  /** Hold a session's channel. Safe to call repeatedly: the hub ref-counts
   *  holders internally and releases the channel when the last one lets go.
   *  A subscribe frame is sent unless the server has already CONFIRMED a
   *  channel here (`subscribe-result`), so a refused subscribe cannot strand
   *  a later consumer with no replay.
   *
   *  `opts.force` additionally requires a replay for the caller's own
   *  listener: the server re-serves it for the `sinceUuid` given. Use it when
   *  a new listener attaches — a panel mounting, or one that attached after
   *  an earlier burst — because a confirmed-live channel alone does not mean
   *  THIS listener ever saw the history.
   *
   *  `opts.replayMode` opts this subscriber into tail-first replay (see
   *  WsSubscribe.replayMode). Deliberately a per-call opt-in and NOT a
   *  hub-wide constant: the frame that establishes the channel is emitted by
   *  whichever consumer gets there first, and a non-chat consumer
   *  (useGitStatus mounts with the panel) would otherwise advertise the
   *  capability with no sinceUuid while useChatStream still holds a cached
   *  transcript — the server would then serve a tail-backfill burst to a
   *  cached client and corrupt its ordering. Only the consumer that owns the
   *  replay semantics (useChatStream, when it has no anchor uuid) may set it.
   *
   *  Pass `sinceUuid` for incremental replay (the server sends only messages
   *  after that UUID); it also becomes the cursor used on reconnect. */
  subscribe: (sessionId: string, sinceUuid?: string, opts?: SubscribeOpts) => () => void
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

/** Per-session channel bookkeeping for ONE connection, keyed by sessionId.
 *  Deliberately ONE entry per session rather than parallel maps: the pieces
 *  describe the same channel, and the last release drops the whole entry so
 *  they cannot drift out of step.
 *
 *  `live` is the piece that has to come from the server: a ref-count is a
 *  count of interested consumers, NOT proof of a channel. Treating the count
 *  as proof is what produced the reported bug — a subscribe refused while the
 *  session was unservable still incremented it, so the panel's
 *  <Chat>/useChatStream (which mounts only once the resume lands) had its
 *  subscribe suppressed as a duplicate and the server was never asked for a
 *  replay. `subscribe-result` now states the truth.
 *
 *  Deliberately NOT tracked: an in-flight ("sent, not yet answered") flag to
 *  suppress the extra frame a second consumer emits while the first is
 *  unanswered. It saves one duplicate per mount, and its stale direction —
 *  believing a frame is still in flight when its answer never came (a socket
 *  that flipped to CLOSING between the readyState check and the send, or a
 *  backend that predates this frame) — skips a frame a listener needs, which
 *  is the blank transcript again. A duplicate is cheap by comparison: the
 *  server answers it and re-serves the replay. */
interface ChannelState {
  /** Components holding this channel. */
  count: number
  /** Server-confirmed: a channel for this session is live on this connection. */
  live: boolean
  /** Latest known message uuid — the cursor for incremental replay. */
  lastUuid: string | null
}

function newChannelState(): ChannelState {
  return { count: 0, live: false, lastUuid: null }
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
  /** Channel bookkeeping per session — holders, server-confirmed liveness, and
   *  the replay cursor. See ChannelState. */
  const channelsRef = useRef<Map<string, ChannelState>>(new Map())
  const connRef = useRef<TransportConnection | null>(null)
  /** Monotonic id for the current connection: a later connect() bumps it, so
   *  a stale connection's late open/close events are ignored (the equivalent
   *  of the old `wsRef.current !== ws` guard). */
  const connSeqRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const pingTimerRef = useRef<number | null>(null)
  const attemptsRef = useRef<number>(0)
  const unmountedRef = useRef(false)
  // Ref to break the circular dependency between connect ↔ scheduleReconnect.
  // connect is declared first; scheduleReconnect calls connectRef.current().
  const connectRef = useRef<() => void>(() => {})
  const [status, setStatus] = useState<WsHubStatus>('connecting')

  /** Send a frame on a specific connection, if it is open. The transport
   *  drops silently otherwise — callers re-issue subscribes on (re)open, so a
   *  dropped frame during reconnect isn't fatal.
   *
   *  Takes the connection explicitly because a transport may fire `onOpen`
   *  SYNCHRONOUSLY from connect() (a WS to an already-up socket, or an IPC
   *  channel), i.e. before `connRef.current` has been assigned. Anything
   *  driven from onOpen must send through its captured handle, not the ref. */
  const sendOn = useCallback((conn: TransportConnection, frame: WsClientFrame) => {
    conn.send(frame)
  }, [])

  /** Send a frame on the current connection. For callers outside the
   *  connect() lifecycle (subscribe/unsubscribe), where connRef is settled. */
  const safeSend = useCallback((frame: WsClientFrame) => {
    connRef.current?.send(frame)
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
    // Close any existing connection before creating a new one to prevent
    // orphaned connections accumulating during rapid reconnects. (The
    // transport treats an already-closed channel as a no-op.)
    connRef.current?.close(1000, 'replaced')

    // Identifies THIS connection. A later connect() bumps the sequence, so a
    // stale connection's late open/close events are ignored — the equivalent
    // of the old `wsRef.current !== ws` guard.
    const seq = ++connSeqRef.current

    // The connection handle is captured by the handlers rather than read from
    // connRef: a transport may fire onOpen synchronously from connect(),
    // before `connRef.current = conn` below runs, and sending through a null
    // ref would silently drop every re-subscribe. If a transport ever fires
    // before connect() returns, the open is deferred until the handle exists.
    let conn: TransportConnection | null = null
    let pendingOpen = false

    const handlers: TransportFrameHandlers = {
      onOpen: () => {
        if (unmountedRef.current || connSeqRef.current !== seq) return
        if (!conn) {
          // Connect() has not returned yet — re-run once the handle is set.
          pendingOpen = true
          return
        }
        attemptsRef.current = 0
        setStatus('online')
        // A fresh connection owns no channels: forget what the previous
        // connection confirmed, then re-ask for every session still held (the
        // server answers each frame, so liveness is re-learned rather than
        // assumed). Deliberately NO replayMode here: the reconnect resend
        // can't know whether a cached transcript exists (the frame is
        // re-emitted for every holder, not just the chat consumer), so it uses
        // the ordinary — always-correct — replay mode.
        for (const state of channelsRef.current.values()) state.live = false
        for (const [sessionId, state] of channelsRef.current) {
          sendOn(conn, {
            kind: 'subscribe',
            sessionId,
            ...(state.lastUuid ? { sinceUuid: state.lastUuid } : {}),
          })
        }
        // App-level heartbeat — some reverse proxies close idle WS
        // after 30-60s. A 25s app-level ping is safely below that, and
        // the server echoes a tiny pong so we also get a failure
        // signal if the pipe is half-closed.
        if (pingTimerRef.current != null) window.clearInterval(pingTimerRef.current)
        pingTimerRef.current = window.setInterval(() => {
          safeSend({ kind: 'ping', nonce: Date.now() })
        }, 25_000)
      },

      onFrame: (raw) => {
        if (unmountedRef.current) return
        const frame = raw as WsServerFrame
        if (!frame || typeof frame !== 'object' || typeof frame.kind !== 'string') return
        // Fold the server's answer to a subscribe into this connection's channel
        // state BEFORE fan-out, so a listener reacting to the frame sees it
        // already applied. Shape-checked: the handler's only other validation is
        // `typeof frame.kind`, and a throw here would drop the frame for every
        // listener on the socket.
        if (frame.kind === 'subscribe-result' && typeof frame.sessionId === 'string') {
          const state = channelsRef.current.get(frame.sessionId)
          if (state) state.live = frame.ok === true
        }
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
      },

      onClose: () => {
        if (unmountedRef.current || connSeqRef.current !== seq) return
        // The connection is gone, so its channels are too. Forgetting here (and
        // not only on the next open) keeps "live" == "live on the current
        // connection" true for the whole reconnect gap.
        for (const state of channelsRef.current.values()) state.live = false
        if (pingTimerRef.current != null) {
          window.clearInterval(pingTimerRef.current)
          pingTimerRef.current = null
        }
        scheduleReconnect()
      },

      onError: () => {
        // Browsers don't give useful detail here; the close event follows
        // and scheduleReconnect handles the retry. Logging the event
        // itself is noise.
      },
    }

    try {
      conn = getTransport().connect(handlers, { url })
      connRef.current = conn
      // A transport that opened synchronously during connect() set pendingOpen;
      // replay it now that the handle exists.
      if (pendingOpen) {
        pendingOpen = false
        handlers.onOpen()
      }
    } catch (err) {
      // Some browsers throw synchronously on bad URLs. Schedule a
      // retry rather than crashing the React tree.
      console.error('[wsHub] failed to construct WebSocket:', err)
      scheduleReconnect()
      return
    }
  }, [safeSend, sendOn, url, scheduleReconnect])
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
      const conn = connRef.current
      connRef.current = null
      conn?.close(1000, 'client unmounting')
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
    (sessionId: string, sinceUuid?: string, opts?: SubscribeOpts) => {
      let state = channelsRef.current.get(sessionId)
      if (!state) {
        state = newChannelState()
        channelsRef.current.set(sessionId, state)
      }
      state.count += 1
      if (sinceUuid) state.lastUuid = sinceUuid
      // Send unless the server has already CONFIRMED a channel here. The
      // holder count is not that confirmation (a refused subscribe still
      // counted one, which is what stranded resumed sessions), and there is
      // deliberately no in-flight flag: see ChannelState.
      if (opts?.force || !state.live) {
        // Any frames arriving before the server answers this subscribe are
        // impossible: the send is dropped while the socket isn't OPEN, and on
        // reopen every held session is re-subscribed.
        safeSend({
          kind: 'subscribe',
          sessionId,
          ...(sinceUuid ? { sinceUuid } : {}),
          ...(opts?.replayMode ? { replayMode: opts.replayMode } : {}),
        })
      }
      // Captured, not re-read: a release that runs twice (or after the entry
      // was replaced) must not decrement a successor's count and tear down a
      // channel another component still holds.
      let released = false
      return () => {
        if (released) return
        released = true
        if (channelsRef.current.get(sessionId) !== state) return
        state.count -= 1
        if (state.count > 0) return
        // Last holder gone: the unsubscribe below tears the channel down, so
        // the whole entry goes with it (including any confirmed liveness).
        channelsRef.current.delete(sessionId)
        safeSend({ kind: 'unsubscribe', sessionId })
      }
    },
    [safeSend],
  )

  const setLastMessageUuid = useCallback((sessionId: string, uuid: string) => {
    // Only writers that hold the channel report a cursor, so a missing entry
    // means nobody is holding it and there is no reconnect slice to anchor.
    const state = channelsRef.current.get(sessionId)
    if (state) state.lastUuid = uuid
  }, [])

  // Memoize so the controls part (addListener/subscribe) has stable
  // identity across re-renders. Status is deliberately excluded — it
  // lives in its own WsStatusContext so status flips (connecting →
  // online → reconnecting) don't change the hub object's identity.
  // This prevents effect teardown/rebuild in consumers like
  // useChatStream that have `[hub]` in their dependency arrays.
  const api = useMemo<WsHubApi>(
    () => ({ addListener, addSessionListener, subscribe, setLastMessageUuid }),
    [addListener, addSessionListener, subscribe, setLastMessageUuid],
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
