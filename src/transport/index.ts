// Transport selection.
//
// One process-wide Transport. The web build resolves to fetch + WebSocket;
// the desktop build's preload injects a `__CRW_DESKTOP__` bridge whose
// transport speaks IPC instead (no TCP, no WebSocket), so the same client
// code runs unchanged. Only transport/web.ts opens a network socket.

import { createWebTransport } from './web'
import { createDesktopTransport, type DesktopRealtimeBridge } from './desktop'
import type { Transport } from './types'
import type { DesktopMenuCommand } from '../../shared/desktop-bridge'

export { toApiError } from './types'
export type {
  ApiError,
  Transport,
  TransportConnection,
  TransportConnectOptions,
  TransportFrameHandlers,
  TransportRequestOptions,
} from './types'

export type { DesktopMenuCommand } from '../../shared/desktop-bridge'

/** Bridge the desktop (Electron) preload exposes on window. The realtime
 *  channel is the only transport concern (desktop REST still goes through
 *  `fetch`, because the host proxies /api/* from the `crw://` custom scheme
 *  into the in-process app). `onMenu` is a UI concern carried on the same
 *  bridge; it is optional so a preload without it (or a test fake) still
 *  satisfies the type. */
export interface DesktopBridge extends DesktopRealtimeBridge {
  onMenu?(handler: (command: DesktopMenuCommand) => void): () => void
}

declare global {
  interface Window {
    __CRW_DESKTOP__?: DesktopBridge
  }
}

let cached: Transport | null = null

/** Resolve the active transport. An injected desktop realtime bridge wins
 *  (web transport for REST, MessagePort for realtime); otherwise the pure web
 *  transport. Cached so identity is stable across calls. */
export function getTransport(): Transport {
  if (cached) return cached
  const bridge = typeof window !== 'undefined' ? window.__CRW_DESKTOP__ : undefined
  cached = bridge ? createDesktopTransport(bridge) : createWebTransport()
  return cached
}

/** Test/dev seam: override (or clear, with null) the active transport. */
export function setTransport(next: Transport | null): void {
  cached = next
}
