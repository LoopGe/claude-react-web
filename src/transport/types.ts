// Shared client transport contract.
//
// Everything that talks to the server — REST requests and the realtime frame
// channel — goes through a Transport. The web build uses fetch + WebSocket
// (transport/web.ts); the desktop build injects an IPC-backed transport via
// window.__CRW_DESKTOP__ (see transport/index.ts). Business code depends only
// on this interface, never on fetch/WebSocket directly.

import type { WsClientFrame } from '../ws-types'

/** Error thrown by Transport.request for a non-ok response. */
export interface ApiError extends Error {
  status: number
  /** Typed error code when the server returned a structured body
   *  `{ error: { code, message } }` (e.g. PluginCommandError). Undefined for
   *  plain `{ error: "string" }` bodies. */
  code?: string
}

/** Map a non-ok Response + parsed body to an ApiError. Shared by every
 *  transport so the client sees one error shape regardless of wire. */
export function toApiError(res: Response, body: unknown): ApiError {
  const validationErrors = body && typeof body === 'object' && 'errors' in body && Array.isArray((body as { errors: unknown }).errors)
    ? (body as { errors: unknown[] }).errors
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const path = 'path' in item && typeof (item as { path: unknown }).path === 'string'
          ? (item as { path: string }).path
          : ''
        const message = 'message' in item && typeof (item as { message: unknown }).message === 'string'
          ? (item as { message: string }).message
          : ''
        return `${path} ${message}`.trim()
      })
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .join('; ')
    : ''

  // The server returns errors in one of three shapes:
  //   { error: "string" }                          -> plain message
  //   { error: { code, message } }                 -> typed (PluginCommandError)
  //   { errors: [{ path, message }, ...] }         -> validation list (above)
  let message = ''
  let code: string | undefined
  if (body && typeof body === 'object' && 'error' in body) {
    const errField = (body as { error: unknown }).error
    if (typeof errField === 'string') {
      message = errField
    } else if (errField && typeof errField === 'object') {
      const obj = errField as { code?: unknown; message?: unknown }
      if (typeof obj.message === 'string') message = obj.message
      if (typeof obj.code === 'string') code = obj.code
    }
  }
  if (!message && validationErrors) message = validationErrors
  if (!message) message = `HTTP ${res.status}`

  const err = new Error(message) as ApiError
  err.status = res.status
  if (code) err.code = code
  return err
}

export interface TransportRequestOptions {
  /** Wall-clock timeout in ms. 0 disables the limit. */
  timeoutMs?: number
}

export interface TransportFrameHandlers {
  /** A decoded server frame arrived. The value is untrusted — callers must
   *  shape-check it. (Web parses JSON; an IPC transport structured-clones an
   *  object.) */
  onFrame(raw: unknown): void
  /** The channel is open and ready to send. */
  onOpen(): void
  /** The channel closed. */
  onClose(): void
  /** Transport-level error. Never itself a disconnect signal. */
  onError?(): void
}

export interface TransportConnection {
  /** Send a client frame. Drops silently when the channel is not open. */
  send(frame: WsClientFrame): void
  /** Close the channel. Safe to call when already closed. */
  close(code?: number, reason?: string): void
}

export interface TransportConnectOptions {
  /** Test/dev override for the connection URL. Ignored by non-WebSocket
   *  transports. */
  url?: string
}

export interface Transport {
  request<T>(path: string, init?: RequestInit, opts?: TransportRequestOptions): Promise<T>
  connect(handlers: TransportFrameHandlers, opts?: TransportConnectOptions): TransportConnection
}
