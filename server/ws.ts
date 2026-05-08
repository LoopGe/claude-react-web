// WebSocket multiplexer — ONE connection per client, fans out every
// session event (global list + per-session messages + permissions +
// context-usage) onto this single socket.
//
// The existing SSE routes in server/routes.ts are preserved as a
// fallback. This file is additive: it attaches a `ws`-backed
// WebSocketServer to the same Node http.Server that Hono runs on,
// handles /api/ws upgrades, and leaves all REST routes untouched.
//
// Design notes:
// - The SessionManager already publishes everything through its
//   subscribeGlobal / subscribe / subscribePermissions /
//   subscribeContextUsage iterables. This module is a thin fan-out
//   bridge; it never calls any SessionManager mutator.
// - Each subscribed session spawns a background driver task that
//   consumes the manager's iterables and writes onto the WS. Cleanup on
//   WS close tears every driver down via unsubscribe() so the
//   SessionManager doesn't leak subscribers.
// - History replay on subscribe is transactional: we fetch the
//   snapshot, then the live iterable — in that order, synchronously —
//   so there's no gap during which a newly-produced event could be
//   missed.

import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { SessionManager } from './session-manager.js'
import {
  WS_PATH,
  type WsClientFrame,
  type WsServerFrame,
} from './ws-protocol.js'

/** Per-session subscription state held inside one WS connection. The
 *  driver promise lets us await its completion during teardown so we
 *  don't return from close() before every background task has settled. */
interface SessionSub {
  sessionId: string
  cleanup: () => void
}

/** Attach a WebSocket endpoint to an existing Node HTTP server. Returns
 *  a `shutdown()` function that closes every live socket — callers pass
 *  this into their SIGTERM handler so the process exits cleanly.
 *
 *  Intentionally NOT a Hono middleware — we need access to the raw
 *  Node server's `upgrade` event, which Hono doesn't expose. Mounting
 *  directly is simpler and avoids a two-layer handshake. */
export function attachWebSocket(httpServer: HttpServer, sm: SessionManager): () => Promise<void> {
  // `noServer: true` means the WSS doesn't listen on its own port; it
  // only handles connections handed to it via `handleUpgrade()`. That's
  // how we share a port with Hono.
  const wss = new WebSocketServer({ noServer: true, path: WS_PATH })

  // All live sockets, so shutdown() can close them. A Set is enough —
  // per-connection state lives in closures below.
  const sockets = new Set<WebSocket>()

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // Only hijack upgrades on our path; others (e.g. Vite HMR on a
    // different prefix, if reverse-proxied) can continue.
    const url = req.url ?? ''
    if (!url.startsWith(WS_PATH)) return
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    sockets.add(ws)
    const subs = new Map<string, SessionSub>()
    let globalCleanup: (() => void) | null = null
    let closed = false

    const send = (frame: WsServerFrame) => {
      if (ws.readyState !== ws.OPEN) return
      try {
        ws.send(JSON.stringify(frame))
      } catch {
        /* socket may have closed between the readyState check and send;
         * ignore — the close handler cleans up everything. */
      }
    }

    // --- global channel: sessions list + global permission mirror ----
    // Started immediately on connection so the client receives the
    // initial snapshot without needing to subscribe to anything first.
    const startGlobal = () => {
      const global = sm.subscribeGlobal()
      globalCleanup = () => global.unsubscribe()
      send({ kind: 'sessions-snapshot', sessions: global.snapshot })
      void (async () => {
        try {
          for await (const ev of global.iterable) {
            if (closed) return
            if (ev.kind === 'update') send({ kind: 'session-update', session: ev.session })
            else if (ev.kind === 'created') send({ kind: 'session-created', session: ev.session })
            else if (ev.kind === 'removed') send({ kind: 'session-removed', id: ev.id })
            else if (ev.kind === 'permission_request') {
              send({
                kind: 'global-permission-request',
                sessionId: ev.sessionId,
                request: ev.request,
              })
            }
          }
        } catch (err) {
          if (!closed) {
            send({ kind: 'error', message: `global channel: ${(err as Error).message}` })
          }
        }
      })()
    }

    // --- per-session channel (subscribe/unsubscribe) -----------------
    const startSession = (sessionId: string) => {
      // Idempotent: re-subscribing is a no-op. The client can safely
      // emit duplicate subscribe frames (e.g. after a tab refresh sees a
      // panel already open).
      if (subs.has(sessionId)) return
      let msgSub: { unsubscribe: () => void } | null = null
      let permSub: { unsubscribe: () => void } | null = null
      try {
        const msg = sm.subscribe(sessionId)
        const perms = sm.subscribePermissions(sessionId)
        const ctxIter = sm.subscribeContextUsage(sessionId)?.[Symbol.asyncIterator]()
        msgSub = msg
        permSub = perms

        // 1) Send the full replay batch as a single frame. Bundling
        //    history + pending permissions avoids the client having to
        //    stitch two streams together during initial paint.
        send({
          kind: 'replay',
          sessionId,
          messages: msg.history,
          permissions: perms.snapshot,
        })
        send({ kind: 'replay-done', sessionId })

        // 2) Drive the three live iterables concurrently. Same Promise.race
        //    pattern as the SSE route — each iterator tagged so the loop
        //    knows which frame to emit.
        const cleanupCbs: Array<() => void> = []
        let stopped = false
        const stop = () => {
          if (stopped) return
          stopped = true
          msgSub?.unsubscribe()
          permSub?.unsubscribe()
          for (const cb of cleanupCbs) cb()
        }
        cleanupCbs.push(() => {
          /* no-op placeholder — reserved for future per-driver cleanup */
        })

        void (async () => {
          const msgIter = msg.iterable[Symbol.asyncIterator]()
          const permIter = perms.iterable[Symbol.asyncIterator]()

          type Tagged =
            | { kind: 'msg'; result: IteratorResult<unknown> }
            | { kind: 'perm'; result: IteratorResult<unknown> }
            | { kind: 'ctx'; result: IteratorResult<unknown> }

          const tag = async (
            kind: Tagged['kind'],
            it: AsyncIterator<unknown>,
          ): Promise<Tagged> => ({ kind, result: await it.next() })

          let msgP: Promise<Tagged> | null = tag('msg', msgIter)
          let permP: Promise<Tagged> | null = tag('perm', permIter)
          let ctxP: Promise<Tagged> | null = ctxIter ? tag('ctx', ctxIter) : null

          try {
            while (!stopped && (msgP || permP || ctxP)) {
              const pending: Promise<Tagged>[] = []
              if (msgP) pending.push(msgP)
              if (permP) pending.push(permP)
              if (ctxP) pending.push(ctxP)
              const winner = await Promise.race(pending)
              if (winner.kind === 'msg') {
                if (winner.result.done) msgP = null
                else {
                  send({
                    kind: 'message',
                    sessionId,
                    message: winner.result.value as never,
                  })
                  msgP = tag('msg', msgIter)
                }
              } else if (winner.kind === 'perm') {
                if (winner.result.done) permP = null
                else {
                  const ev = winner.result.value as
                    | { kind: 'request'; payload: never }
                    | { kind: 'resolved'; pid: string; decision: never }
                  if (ev.kind === 'request') {
                    send({ kind: 'permission-request', sessionId, payload: ev.payload })
                  } else {
                    send({
                      kind: 'permission-resolved',
                      sessionId,
                      id: ev.pid,
                      decision: ev.decision,
                    })
                  }
                  permP = tag('perm', permIter)
                }
              } else {
                if (winner.result.done) ctxP = null
                else {
                  send({
                    kind: 'context-usage',
                    sessionId,
                    usage: winner.result.value,
                  })
                  ctxP = tag('ctx', ctxIter!)
                }
              }
            }
          } catch (err) {
            if (!closed && !stopped) {
              send({
                kind: 'error',
                sessionId,
                message: `subscription: ${(err as Error).message}`,
              })
            }
          } finally {
            stop()
          }
        })()

        subs.set(sessionId, { sessionId, cleanup: stop })
      } catch (err) {
        // SessionManager.require() throws HttpError for unknown sessions.
        // Relay that to the client rather than killing the connection;
        // the user might just have stale state after a session was
        // removed on another tab.
        msgSub?.unsubscribe()
        permSub?.unsubscribe()
        send({ kind: 'error', sessionId, message: (err as Error).message })
      }
    }

    const stopSession = (sessionId: string) => {
      const s = subs.get(sessionId)
      if (!s) return
      s.cleanup()
      subs.delete(sessionId)
    }

    ws.on('message', (raw) => {
      let frame: WsClientFrame
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8')) as WsClientFrame
      } catch {
        send({ kind: 'error', message: 'invalid JSON frame' })
        return
      }
      if (!frame || typeof frame !== 'object' || typeof frame.kind !== 'string') {
        send({ kind: 'error', message: 'frame missing kind' })
        return
      }
      switch (frame.kind) {
        case 'subscribe':
          if (typeof frame.sessionId === 'string' && frame.sessionId) startSession(frame.sessionId)
          break
        case 'unsubscribe':
          if (typeof frame.sessionId === 'string' && frame.sessionId) stopSession(frame.sessionId)
          break
        case 'ping':
          send({ kind: 'pong', nonce: frame.nonce })
          break
        default:
          // Exhaustiveness check — a new client-side kind we don't know.
          send({ kind: 'error', message: `unknown kind: ${(frame as { kind: string }).kind}` })
      }
    })

    ws.on('close', () => {
      closed = true
      for (const s of subs.values()) s.cleanup()
      subs.clear()
      globalCleanup?.()
      globalCleanup = null
      sockets.delete(ws)
    })

    ws.on('error', (err) => {
      // Stock ws surfaces parser errors etc. here. Log and let the close
      // handler do the cleanup.
      console.error('[ws] socket error:', err.message)
    })

    // Kick the global channel last so all listeners are wired before any
    // frame might arrive.
    startGlobal()
  })

  const shutdown = async () => {
    for (const ws of sockets) {
      try {
        ws.close(1001, 'server shutting down')
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }
  return shutdown
}
