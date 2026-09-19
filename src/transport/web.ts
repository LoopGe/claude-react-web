// Web transport: REST over fetch, realtime over WebSocket.
//
// This is the browser implementation of Transport — the only one that opens a
// network socket. It owns the two things that used to live in useApi.ts and
// useWsHub.ts: the timeout/abort/error-shaping request wrapper, and the
// WebSocket construction + JSON framing. Reconnect/backoff, heartbeats,
// subscription bookkeeping and fan-out stay in useWsHub (app-level policy,
// shared with any future transport).

import { WS_PATH, type WsClientFrame } from '../ws-types'
import { toApiError, type ApiError, type Transport, type TransportConnection, type TransportFrameHandlers } from './types'

const DEFAULT_TIMEOUT_MS = 30_000

/** URL the realtime channel connects to — relative to the current origin so
 *  it works in both dev (Vite proxies /api/ws to 3456) and prod (served from
 *  the same origin as /api). */
function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}${WS_PATH}`
}

/** REST over `fetch('/api' + path)`. Exported so non-WebSocket transports can
 *  reuse the exact timeout/abort/error semantics — the desktop build serves
 *  the client from a custom scheme and proxies /api to the in-process app, so
 *  its requests are ordinary same-origin fetches too. */
export async function webRequest<T>(
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  // Merge caller-supplied signal with our timeout signal. When either
  // fires the request is aborted. `timeoutMs: 0` disables the wall-clock
  // limit — used by the `!` bash exec path, which runs until the command
  // exits or the user hits the stop button (/exec/abort) rather than being
  // cut off at a fixed deadline.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutController = new AbortController()
  const timeoutId = timeoutMs > 0
    ? setTimeout(() => timeoutController.abort(), timeoutMs)
    : null

  // If the caller already provided a signal, propagate its abort to our
  // controller so either source can cancel the fetch.
  const callerSignal = init.signal
  let callerAbort: (() => void) | undefined
  if (callerSignal) {
    if (callerSignal.aborted) {
      timeoutController.abort(callerSignal.reason)
    } else {
      callerAbort = () => timeoutController.abort(callerSignal.reason)
      callerSignal.addEventListener('abort', callerAbort, { once: true })
    }
  }

  try {
    const res = await fetch(`/api${path}`, {
      ...init,
      signal: timeoutController.signal,
      headers: {
        // Only set Content-Type when a body is present. GET/DELETE
        // requests have no body and the header is meaningless there;
        // some proxies / CDNs treat it as a CORS preflight trigger.
        ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    const contentType = res.headers.get('content-type') ?? ''
    const body = contentType.includes('application/json') ? await res.json() : await res.text()
    if (!res.ok) throw toApiError(res, body)
    return body as T
  } catch (err) {
    // Use duck-typing instead of instanceof checks: DOMException may not
    // inherit from Error in every test/browser runtime, and DOMException can
    // be undefined in some environments.
    if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
      const reason = callerSignal?.aborted
        ? 'Request cancelled'
        : `Request timed out after ${timeoutMs / 1000}s`
      const timeoutErr = new Error(reason) as ApiError
      if (callerSignal?.aborted) timeoutErr.name = 'AbortError'
      timeoutErr.status = 0
      throw timeoutErr
    }
    throw err
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (callerSignal && callerAbort) {
      callerSignal.removeEventListener('abort', callerAbort)
    }
  }
}

function connect(
  handlers: TransportFrameHandlers,
  opts?: { url?: string },
): TransportConnection {
  const target = opts?.url ?? wsUrl()
  // Construction can throw synchronously on a bad URL in some browsers; let
  // it propagate — the hub schedules a retry rather than crashing the tree.
  const ws = new WebSocket(target)

  ws.addEventListener('open', () => handlers.onOpen())
  ws.addEventListener('message', (ev) => {
    let raw: unknown
    try {
      raw = JSON.parse(ev.data as string)
    } catch {
      // Malformed payload — drop it; the caller never sees invalid frames.
      return
    }
    handlers.onFrame(raw)
  })
  ws.addEventListener('close', () => handlers.onClose())
  ws.addEventListener('error', () => {
    // Browsers don't give useful detail here; the close event follows and the
    // hub's reconnect handles the retry. Logging the event itself is noise.
    handlers.onError?.()
  })

  return {
    send(frame: WsClientFrame) {
      if (ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify(frame))
      } catch {
        /* socket may have transitioned to CLOSING; ignore */
      }
    },
    close(code?: number, reason?: string) {
      if (ws.readyState === WebSocket.CLOSED) return
      try {
        ws.close(code, reason)
      } catch {
        /* already closing */
      }
    },
  }
}

export function createWebTransport(): Transport {
  return { request: webRequest, connect }
}
