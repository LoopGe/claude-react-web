// WebSocket transport for the frame bridge — ONE connection per client.
//
// The transport-agnostic connection logic (global + per-session channels,
// replay, subscribe/unsubscribe, teardown) lives in server/frame-bridge.ts.
// This file owns only what is socket-specific:
//   - attaching a `WebSocketServer` to the shared Node http.Server
//   - the /api/ws upgrade + auth gate
//   - parsing inbound frames to strings and feeding SessionConnection
//   - a WsFrameSink (server/ws-sink.ts) for outbound frames
//   - tracking live sockets so shutdown() can close them
//
// The existing SSE routes in server/routes.ts are preserved as a fallback.
// This file is additive: it leaves all REST routes untouched.

import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { isUpgradeAuthorized } from './auth.js'
import { SessionConnection } from './frame-bridge.js'
import { WsFrameSink } from './ws-sink.js'
import type { SessionBroadcaster } from './session-types.js'
import type { AppPluginBroadcaster } from './app-plugins/event-bus.js'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'
import { WS_PATH } from './ws-protocol.js'

const log = createLogger('ws')

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
): () => Promise<void> {
  // `noServer: true` means the WSS doesn't listen on its own port; it
  // only handles connections handed to it via `handleUpgrade()`. That's
  // how we share a port with Hono.
  const wss = new WebSocketServer({ noServer: true, path: WS_PATH })

  // All live sockets, so shutdown() can close them. A Set is enough —
  // per-connection state lives in the SessionConnection closures.
  const sockets = new Set<WebSocket>()

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // Only hijack upgrades on our path; others (e.g. Vite HMR on a
    // different prefix, if reverse-proxied) can continue.
    const url = req.url ?? ''
    if (!url.startsWith(WS_PATH)) return
    // Web access gate: reject the upgrade before the handshake when the
    // request lacks a valid token. The browser WS carries the crw_token
    // cookie automatically (same-origin), so an authenticated page just
    // works; a direct connection without the token is refused.
    if (!isUpgradeAuthorized(req)) {
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
    // Gauge derived from the Set itself — single source of truth, no
    // separate counter to drift.
    metrics.gauge('ws_connections', sockets.size)

    const conn = new SessionConnection({ sm, appPlugins }, new WsFrameSink(ws))

    ws.on('message', (raw) => {
      conn.handleClientFrame(typeof raw === 'string' ? raw : raw.toString('utf-8'))
    })

    ws.on('close', () => {
      conn.close()
      sockets.delete(ws)
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
