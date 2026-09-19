// Desktop transport: REST over the ordinary fetch wrapper, realtime over the
// preload's MessagePort bridge.
//
// The Electron host serves the renderer from `crw://app` and proxies /api/*
// into the in-process Hono app, so REST requests are same-origin fetches —
// `webRequest` gives them the identical timeout/abort/error shape the web
// build uses (including the ApiError `code` field and `timeoutMs: 0`).
// Only the realtime channel differs: there is no WebSocket, so `connect` is
// delegated to the preload bridge, which wires a MessagePort to the host's
// frame bridge.

import { webRequest } from './web'
import type { Transport, TransportConnection, TransportConnectOptions, TransportFrameHandlers } from './types'

/** The realtime half the preload exposes on window.__CRW_DESKTOP__. */
export interface DesktopRealtimeBridge {
  connect(handlers: TransportFrameHandlers, opts?: TransportConnectOptions): TransportConnection
}

export function createDesktopTransport(bridge: DesktopRealtimeBridge): Transport {
  return {
    request: webRequest,
    connect: (handlers, opts) => bridge.connect(handlers, opts),
  }
}
