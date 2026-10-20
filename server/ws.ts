// WebSocket transport for the frame bridge — ONE connection per client.
//
// The transport-agnostic connection logic (global + per-session channels,
// replay, subscribe/unsubscribe, teardown) lives in server/frame-bridge.ts.
// This file owns only what is socket-specific:
//   - attaching a `WebSocketServer` to the shared Node http.Server
//   - the /api/ws upgrade gates: Host/Origin (request-guard, when bound),
//     then auth (with Bearer-failure rate limiting)
//   - the inbound frame size cap (WS_MAX_INBOUND_BYTES)
//   - parsing inbound frames to strings and feeding SessionConnection
//   - a WsFrameSink (server/ws-sink.ts) for outbound frames
//   - tracking live sockets so shutdown() can close them
//
// This file is additive: it leaves all REST routes untouched.

import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { authorizeUpgrade } from './auth.js'
import { checkUpgradeRequest, createRequestGuard, devVitePort, type BindAddress } from './request-guard.js'
import { SessionConnection } from './frame-bridge.js'
import { WsFrameSink } from './ws-sink.js'
import type { SessionBroadcaster } from './session-types.js'
import type { AppPluginBroadcaster } from './app-plugins/event-bus.js'
import type { SubagentTranscriptHub } from './subagent-transcript-hub.js'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'
import { WS_PATH } from './ws-protocol.js'

const log = createLogger('ws')

/** Liveness flag stamped on every socket by the heartbeat sweep below. */
declare module 'ws' {
  interface WebSocket {
    isAlive: boolean
  }
}

/** Inbound frame cap. The only client → server frames are
 *  `subscribe | unsubscribe | ping` (shared/ws-protocol.ts WsClientFrame):
 *  a session id and a mode literal — well under 1 KiB. Anything larger is
 *  closed with 1009 before it is buffered. */
export const WS_MAX_INBOUND_BYTES = 64 * 1024

/** Protocol-level dead-client sweep. Every HEARTBEAT_INTERVAL_MS each socket
 *  gets one `ping()`; a socket that answered the previous ping with a pong
 *  (browsers do this automatically, below the JS layer) is alive, one that
 *  didn't is a zombie — e.g. a tab the OS killed without a close handshake —
 *  and is terminated so its SessionConnection, session subscriptions and
 *  fan-out queues are freed instead of lingering until process exit. */
const HEARTBEAT_INTERVAL_MS = 30_000

/** Attach a WebSocket endpoint to an existing Node HTTP server. Returns
 *  a `shutdown()` function that closes every live socket — callers pass
 *  this into their SIGTERM handler so the process exits cleanly.
 *
 *  Intentionally NOT a Hono middleware — we need access to the raw
 *  Node server's `upgrade` event, which Hono doesn't expose. Mounting
 *  directly is simpler and avoids a two-layer handshake. */
export function attachWebSocket(
  httpServer: HttpServer,
  sm: SessionBroadcaster,
  appPlugins?: AppPluginBroadcaster,
  subagentTranscripts?: SubagentTranscriptHub,
  opts?: { bind?: BindAddress; trustDevOrigins?: boolean },
): () => Promise<void> {
  // Same Host/Origin policy as the HTTP middleware (server/request-guard.ts).
  // Only with a real bind, mirroring buildApp.
  const guard = opts?.bind
    ? createRequestGuard({
        bind: opts.bind,
        // Mirrors buildApp: devOriginPort covers loopback + LAN-interface
        // Vite origins (dev:host cross-machine), matched lazily.
        devOriginPort: opts.trustDevOrigins ? devVitePort() : undefined,
      })
    : undefined
  // `noServer: true` means the WSS doesn't listen on its own port; it
  // only handles connections handed to it via `handleUpgrade()`. That's
  // how we share a port with Hono.
  const wss = new WebSocketServer({ noServer: true, path: WS_PATH, maxPayload: WS_MAX_INBOUND_BYTES })

  // All live sockets, so shutdown() can close them. A Set is enough —
  // per-connection state lives in the SessionConnection closures.
  const sockets = new Set<WebSocket>()

  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (ws.isAlive === false) {
        // `_socket` is real but untyped in this ws version — diagnostics only.
        const addr = (ws as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress
        log.info(`terminating dead socket (no pong) addr=${addr ?? '?'}`)
        try { ws.terminate() } catch { /* already gone */ }
        continue
      }
      ws.isAlive = false
      try { ws.ping() } catch { /* close/error handlers own the cleanup */ }
    }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // Only hijack upgrades on our path; others (e.g. Vite HMR on a
    // different prefix, if reverse-proxied) can continue.
    const url = req.url ?? ''
    if (!url.startsWith(WS_PATH)) return
    // Host + Origin gate (DNS rebinding / cross-site WS hijack). WS upgrades
    // are not covered by CORS, so a foreign page could otherwise open one.
    if (guard) {
      const check = checkUpgradeRequest(guard, req)
      if (!check.ok) {
        log.warn(`rejected upgrade: ${check.reason} not allowed (host=${JSON.stringify(req.headers.host ?? '')} origin=${JSON.stringify(req.headers.origin ?? '')})`)
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        socket.destroy()
        return
      }
    }
    // Web access gate: reject the upgrade before the handshake when the
    // request lacks a valid token. The browser WS carries the crw_token
    // cookie automatically (same-origin), so an authenticated page just
    // works; a direct connection without the token is refused.
    const auth = authorizeUpgrade(req)
    if (auth === 'rate-limited') {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    if (auth === 'unauthorized') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.isAlive = true
    // Gauge derived from the Set itself — single source of truth, no
    // separate counter to drift.
    metrics.gauge('ws_connections', sockets.size)

    const conn = new SessionConnection({ sm, appPlugins, subagentTranscripts }, new WsFrameSink(ws))

    ws.on('pong', () => { ws.isAlive = true })

    ws.on('message', (raw) => {
      conn.handleClientFrame(typeof raw === 'string' ? raw : raw.toString('utf-8'))
    })

    ws.on('close', (code, reason) => {
      conn.close()
      sockets.delete(ws)
      // After the delete — the count must describe surviving connections.
      log.info(`socket closed code=${code} reason=${reason.toString() || '-'} (open=${sockets.size})`)
      metrics.gauge('ws_connections', sockets.size)
    })

    ws.on('error', (err) => {
      // Stock ws surfaces parser errors etc. here. Force-close so the
      // close handler fires and runs full cleanup (queue drain, session
      // unsubscribe, global listener detach). Without this, an error on
      // a half-open socket can leave sessions dangling until the next
      // GC cycle.
      log.error('socket error:', err.message)
      try { ws.close() } catch { /* already closing */ }
    })

    // Kick the global channel last so all listeners are wired before any
    // frame might arrive. The app-plugin channel follows the same rule.
    conn.start()
  })

  const shutdown = async () => {
    clearInterval(heartbeat)
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
