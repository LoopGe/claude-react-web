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
import type { SessionBroadcaster } from './session-types.js'
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

/** Backpressure threshold: pause draining when the kernel socket buffer
 *  exceeds this many bytes. Prevents unbounded memory growth when the
 *  client is slow (e.g. rendering a large replay). */
const BACKPRESSURE_HIGH = 1_000_000

/**
 * Async write queue with backpressure control for a single WebSocket.
 *
 * Replaces the old synchronous `send()` closure. All session drivers
 * call `enqueue()` which serializes the frame and appends it to an
 * in-memory buffer; a background drain loop sends frames one-by-one,
 * yielding via `setImmediate` between each so the event loop stays
 * responsive. When the kernel socket buffer exceeds
 * {@link BACKPRESSURE_HIGH} bytes, the drain loop suspends until the
 * `drain` event fires.
 *
 * This prevents a large replay frame from starving every other
 * session's live messages — the interleaving `setImmediate` gives
 * other drivers a chance to enqueue their (small) frames before the
 * next drain iteration.
 */
class WsWriteQueue {
  private queue: string[] = []
  private head = 0
  private draining = false
  private stopped = false
  private ws: WebSocket

  constructor(ws: WebSocket) {
    this.ws = ws
  }

  /** Enqueue a frame for async delivery. Drops silently if the socket
   *  has been stopped or is no longer OPEN — callers don't need to
   *  check readyState themselves. */
  enqueue(frame: WsServerFrame) {
    if (this.stopped || this.ws.readyState !== this.ws.OPEN) return
    this.queue.push(JSON.stringify(frame))
    if (!this.draining) void this.drain()
  }

  /** Signal that the socket is closing. Clears the queue and prevents
   *  any further drains from running. */
  stop() {
    this.stopped = true
    this.queue.length = 0
    this.head = 0
  }

  private async drain() {
    this.draining = true
    let framesSinceYield = 0
    try {
      while (this.head < this.queue.length && !this.stopped) {
        const data = this.queue[this.head++]!
        // Backpressure: if the kernel socket buffer is full, send the
        // frame with a callback that fires when it has been flushed.
        // This is the idiomatic ws backpressure mechanism — the library
        // does NOT emit `drain` events, so we rely on the send callback.
        if (this.ws.bufferedAmount > BACKPRESSURE_HIGH) {
          await new Promise<void>((resolve) => {
            if (this.stopped) { resolve(); return }
            const onClose = () => { cleanup(); resolve() }
            const cleanup = () => { this.ws.off('close', onClose) }
            this.ws.on('close', onClose)
            this.ws.send(data, () => { cleanup(); resolve() })
          })
          // The await above already yielded to the event loop.
          framesSinceYield = 0
        } else {
          if (this.stopped) return
          this.ws.send(data)
        }
        // Yield to the event loop periodically (every 10 frames) so
        // other session drivers' synchronous enqueue() calls get a
        // chance to run. Batching reduces GC pressure from 1 Promise
        // per frame while still preserving cross-session fairness.
        if (++framesSinceYield >= 10) {
          framesSinceYield = 0
          await new Promise<void>((r) => setImmediate(r))
        }
      }
    } finally {
      // Compact the buffer: drop consumed entries so memory doesn't grow
      // unbounded when enqueue/drain cycles repeat.
      if (this.head > 0) {
        if (this.head >= this.queue.length) {
          // All entries consumed — release the backing store entirely
          // instead of splicing an empty tail (O(1) vs O(n)).
          this.queue.length = 0
        } else {
          this.queue.splice(0, this.head)
        }
        this.head = 0
      }
      this.draining = false
    }
  }
}

/** Attach a WebSocket endpoint to an existing Node HTTP server. Returns
 *  a `shutdown()` function that closes every live socket — callers pass
 *  this into their SIGTERM handler so the process exits cleanly.
 *
 *  Intentionally NOT a Hono middleware — we need access to the raw
 *  Node server's `upgrade` event, which Hono doesn't expose. Mounting
 *  directly is simpler and avoids a two-layer handshake. */
export function attachWebSocket(httpServer: HttpServer, sm: SessionBroadcaster): () => Promise<void> {
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

    const queue = new WsWriteQueue(ws)

    // --- global channel: sessions list + global permission mirror ----
    // Started immediately on connection so the client receives the
    // initial snapshot without needing to subscribe to anything first.
    const startGlobal = () => {
      const global = sm.subscribeGlobal()
      globalCleanup = () => global.unsubscribe()
      queue.enqueue({ kind: 'sessions-snapshot', sessions: global.snapshot })
      void (async () => {
        try {
          for await (const ev of global.iterable) {
            if (closed) return
            if (ev.kind === 'update') queue.enqueue({ kind: 'session-update', session: ev.session })
            else if (ev.kind === 'created') queue.enqueue({ kind: 'session-created', session: ev.session })
            else if (ev.kind === 'removed') queue.enqueue({ kind: 'session-removed', id: ev.id })
            else if (ev.kind === 'permission_request') {
              queue.enqueue({
                kind: 'global-permission-request',
                sessionId: ev.sessionId,
                request: ev.request,
              })
            }
          }
        } catch (err) {
          if (!closed) {
            queue.enqueue({ kind: 'error', message: `global channel: ${(err as Error).message}` })
          }
        }
      })()
    }

    // --- per-session channel (subscribe/unsubscribe) -----------------
    const startSession = (sessionId: string, sinceUuid?: string) => {
      // Idempotent: re-subscribing is a no-op. The client can safely
      // emit duplicate subscribe frames (e.g. after a tab refresh sees a
      // panel already open).
      if (subs.has(sessionId)) return
      let msgSub: { unsubscribe: () => void } | null = null
      let permSub: { unsubscribe: () => void } | null = null
      let ctxSub: { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null = null
      let ctxIter: AsyncIterator<unknown> | null = null
      let gitSub: { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null = null
      let gitIter: AsyncIterator<unknown> | null = null
      let recapSub:
        | { iterable: AsyncIterable<unknown>; snapshot: unknown; unsubscribe: () => void }
        | null = null
      let recapIter: AsyncIterator<unknown> | null = null
      try {
        const msg = sm.subscribe(sessionId)
        msgSub = msg
        const perms = sm.subscribePermissions(sessionId)
        permSub = perms
        ctxSub = sm.subscribeContextUsage(sessionId)
        ctxIter = ctxSub?.iterable[Symbol.asyncIterator]() ?? null
        gitSub = sm.subscribeGitStatus(sessionId)
        gitIter = gitSub?.iterable[Symbol.asyncIterator]() ?? null
        recapSub = sm.subscribeSessionRecap(sessionId)
        recapIter = recapSub?.iterable[Symbol.asyncIterator]() ?? null

        // 1) Send replay. If the client supplied `sinceUuid`, try to
        //    send only messages after that point (incremental sync).
        //    Fall back to full replay if the UUID isn't in the ring
        //    (evicted by historyCap or client cache is stale).
        let replayHistory = msg.history
        if (sinceUuid) {
          const idx = msg.history.findIndex(
            (m) => (m as { uuid?: string }).uuid === sinceUuid,
          )
          if (idx >= 0) {
            replayHistory = msg.history.slice(idx + 1)
            console.log(
              `[ws] incremental sync for ${sessionId}: ` +
              `skipped ${idx + 1} msgs, sending ${replayHistory.length} new`,
            )
          } else {
            console.log(
              `[ws] sinceUuid ${sinceUuid} not found in ${sessionId} history ` +
              `(${msg.history.length} msgs) — full replay`,
            )
          }
        }
        const REPLAY_CHUNK_SIZE = 50
        if (replayHistory.length <= REPLAY_CHUNK_SIZE) {
          queue.enqueue({
            kind: 'replay',
            sessionId,
            messages: replayHistory,
            permissions: perms.snapshot,
          })
          queue.enqueue({ kind: 'replay-done', sessionId })
        } else {
          for (let i = 0; i < replayHistory.length; i += REPLAY_CHUNK_SIZE) {
            queue.enqueue({
              kind: 'replay',
              sessionId,
              messages: replayHistory.slice(i, i + REPLAY_CHUNK_SIZE),
              permissions: [],
            })
          }
          // Permissions arrive with the final replay-done frame. The
          // client merges them from whichever frame carries them.
          queue.enqueue({
            kind: 'replay-done',
            sessionId,
            permissions: perms.snapshot,
          })
        }

        // 2.5) Send the current recap snapshot if there is one. The
        //      live iterable picks up future transitions; the snapshot
        //      covers the "tab opens after recap was generated" case
        //      so the user doesn't see an empty card.
        if (recapSub?.snapshot) {
          queue.enqueue({
            kind: 'session-recap-update',
            sessionId,
            recap: recapSub.snapshot as never,
          })
        }

        // 2) Drive the live iterables concurrently. Same Promise.race
        //    pattern as the SSE route — each iterator tagged so the loop
        //    knows which frame to emit.
        let stopped = false
        const stop = () => {
          if (stopped) return
          stopped = true
          msgSub?.unsubscribe()
          permSub?.unsubscribe()
          ctxSub?.unsubscribe()
          gitSub?.unsubscribe()
          recapSub?.unsubscribe()
          // Return the context-usage / git-status / recap iterators so
          // their pushable waiters resolve with done:true instead of
          // hanging the driver.
          if (ctxIter) void ctxIter.return?.()
          if (gitIter) void gitIter.return?.()
          if (recapIter) void recapIter.return?.()
        }

        void (async () => {
          const msgIter = msg.iterable[Symbol.asyncIterator]()
          const permIter = perms.iterable[Symbol.asyncIterator]()

          type Tagged =
            | { kind: 'msg'; result: IteratorResult<unknown> }
            | { kind: 'perm'; result: IteratorResult<unknown> }
            | { kind: 'ctx'; result: IteratorResult<unknown> }
            | { kind: 'git'; result: IteratorResult<unknown> }
            | { kind: 'recap'; result: IteratorResult<unknown> }

          const tag = async (
            kind: Tagged['kind'],
            it: AsyncIterator<unknown>,
          ): Promise<Tagged> => ({ kind, result: await it.next() })

          let msgP: Promise<Tagged> | null = tag('msg', msgIter)
          let permP: Promise<Tagged> | null = tag('perm', permIter)
          let ctxP: Promise<Tagged> | null = ctxIter ? tag('ctx', ctxIter) : null
          let gitP: Promise<Tagged> | null = gitIter ? tag('git', gitIter) : null
          let recapP: Promise<Tagged> | null = recapIter ? tag('recap', recapIter) : null

          try {
            while (!stopped && (msgP || permP || ctxP || gitP || recapP)) {
              const pending: Promise<Tagged>[] = []
              if (msgP) pending.push(msgP)
              if (permP) pending.push(permP)
              if (ctxP) pending.push(ctxP)
              if (gitP) pending.push(gitP)
              if (recapP) pending.push(recapP)
              const winner = await Promise.race(pending)
              if (winner.kind === 'msg') {
                if (winner.result.done) msgP = null
                else {
                  queue.enqueue({
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
                    queue.enqueue({ kind: 'permission-request', sessionId, payload: ev.payload })
                  } else {
                    queue.enqueue({
                      kind: 'permission-resolved',
                      sessionId,
                      id: ev.pid,
                      decision: ev.decision,
                    })
                  }
                  permP = tag('perm', permIter)
                }
              } else if (winner.kind === 'ctx') {
                if (winner.result.done) ctxP = null
                else {
                  queue.enqueue({
                    kind: 'context-usage',
                    sessionId,
                    usage: winner.result.value,
                  })
                  ctxP = tag('ctx', ctxIter!)
                }
              } else if (winner.kind === 'git') {
                // git-status-changed signal — value carries { kind, sessionId }
                // but we re-emit the canonical frame with our own sessionId
                // (defence in depth: the broadcaster is trusted, but no harm
                // verifying we send the right session).
                if (winner.result.done) gitP = null
                else {
                  queue.enqueue({ kind: 'git-status-changed', sessionId })
                  gitP = tag('git', gitIter!)
                }
              } else {
                // session-recap-update — payload from broadcastSessionRecap
                // is { kind, sessionId, recap? }. Re-emit with our own
                // sessionId for symmetry with the other channels (the
                // broadcaster is trusted, but cross-checking costs nothing).
                if (winner.result.done) recapP = null
                else {
                  const v = winner.result.value as { recap?: unknown }
                  queue.enqueue({
                    kind: 'session-recap-update',
                    sessionId,
                    recap: v.recap as never,
                  })
                  recapP = tag('recap', recapIter!)
                }
              }
            }
          } catch (err) {
            if (!closed && !stopped) {
              queue.enqueue({
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
        ctxSub?.unsubscribe()
        gitSub?.unsubscribe()
        recapSub?.unsubscribe()
        queue.enqueue({ kind: 'error', sessionId, message: (err as Error).message })
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
        queue.enqueue({ kind: 'error', message: 'invalid JSON frame' })
        return
      }
      if (!frame || typeof frame !== 'object' || typeof frame.kind !== 'string') {
        queue.enqueue({ kind: 'error', message: 'frame missing kind' })
        return
      }
      switch (frame.kind) {
        case 'subscribe':
          if (typeof frame.sessionId === 'string' && frame.sessionId) startSession(frame.sessionId, frame.sinceUuid)
          break
        case 'unsubscribe':
          if (typeof frame.sessionId === 'string' && frame.sessionId) stopSession(frame.sessionId)
          break
        case 'ping':
          queue.enqueue({ kind: 'pong', nonce: frame.nonce })
          break
        default:
          // Exhaustiveness check — a new client-side kind we don't know.
          queue.enqueue({ kind: 'error', message: `unknown kind: ${(frame as { kind: string }).kind}` })
      }
    })

    ws.on('close', () => {
      closed = true
      queue.stop()
      for (const s of subs.values()) s.cleanup()
      subs.clear()
      globalCleanup?.()
      globalCleanup = null
      sockets.delete(ws)
    })

    ws.on('error', (err) => {
      // Stock ws surfaces parser errors etc. here. Force-close so the
      // close handler fires and runs full cleanup (queue drain, session
      // unsubscribe, global listener detach). Without this, an error on
      // a half-open socket can leave sessions dangling until the next
      // GC cycle.
      console.error('[ws] socket error:', err.message)
      try { ws.close() } catch { /* already closing */ }
    })

    // Kick the global channel last so all listeners are wired before any
    // frame might arrive.
    startGlobal()
  })

  const shutdown = async () => {
    // Send close frames to all connected clients. Some may never
    // acknowledge (e.g. backgrounded tabs), so we also set a hard
    // timeout to forcibly terminate stragglers.
    for (const ws of sockets) {
      try {
        ws.close(1001, 'server shutting down')
      } catch {
        /* ignore */
      }
    }
    const FORCE_CLOSE_MS = 2000
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const ws of sockets) {
          try { ws.terminate() } catch { /* ignore */ }
        }
      }, FORCE_CLOSE_MS)
      wss.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  return shutdown
}
