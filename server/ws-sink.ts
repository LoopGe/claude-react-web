// WebSocket implementation of the frame-bridge's FrameSink.
//
// Owns everything socket-specific that the old ws.ts inline connection did:
// an async write queue, kernel-buffer backpressure, and the hard queue cap
// that force-closes a slow-but-alive client so it reconnects and replays from
// the server's bounded history ring.

import type { WebSocket } from 'ws'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'
import type { WsServerFrame } from './ws-protocol.js'
import type { FrameSink } from './frame-bridge.js'

const log = createLogger('ws')

/** Backpressure threshold: pause draining when the kernel socket buffer
 *  exceeds this many bytes. Prevents unbounded memory growth when the
 *  client is slow (e.g. rendering a large replay). */
const BACKPRESSURE_HIGH = 1_000_000

/** Hard cap on the total serialized chars buffered in a single
 *  WsWriteQueue. The backpressure mechanism (BACKPRESSURE_HIGH) suspends
 *  the drain loop when the kernel socket buffer is full, but while
 *  suspended the session drivers keep enqueuing — so a client that stays
 *  alive (TCP-wise) but never catches up could grow this buffer without
 *  bound. When the cap is exceeded we force-close the socket so the
 *  client reconnects and replays from the server's bounded history ring
 *  (mirrors the async-subscription overflow strategy). 8M chars is
 *  generous enough that it only trips on a pathologically slow client,
 *  not a transient slow spell. */
const MAX_QUEUE_CHARS = 8_000_000

/**
 * Async write queue with backpressure control for a single WebSocket.
 *
 * All session drivers call `enqueue()`/`enqueueRaw()` which serialize the
 * frame and append it to an in-memory buffer; a background drain loop sends
 * frames one-by-one, yielding via `setImmediate` between each so the event
 * loop stays responsive. When the kernel socket buffer exceeds
 * {@link BACKPRESSURE_HIGH} bytes, the drain loop suspends until the send
 * callback fires.
 *
 * This prevents a large replay frame from starving every other session's
 * live messages — the interleaving `setImmediate` gives other drivers a
 * chance to enqueue their (small) frames before the next drain iteration.
 */
export class WsWriteQueue {
  private queue: string[] = []
  private head = 0
  private draining = false
  private stopped = false
  private ws: WebSocket
  private totalChars = 0

  constructor(ws: WebSocket) {
    this.ws = ws
  }

  /** Enqueue a frame for async delivery. Drops silently if the socket
   *  has been stopped or is no longer OPEN — callers don't need to
   *  check readyState themselves. */
  enqueue(frame: WsServerFrame) {
    this.enqueueRaw(JSON.stringify(frame), frame.kind)
  }

  /** Enqueue an already-serialized frame string. Used by the broadcast
   *  path where one message is fanned out to many connections: the frame
   *  is stringified once (see `messageFrameJson`) and the same string is
   *  pushed into every subscribed connection's queue, avoiding M×
   *  JSON.stringify on the hot path. */
  enqueueRaw(data: string, kind?: string) {
    if (this.stopped || this.ws.readyState !== this.ws.OPEN) return
    this.queue.push(data)
    this.totalChars += data.length
    // Count only frames actually queued to a live socket — frames dropped
    // above (stopped / not OPEN) never reach a client and would inflate
    // the volume metric exactly in the overload scenarios it diagnoses.
    if (kind !== undefined) metrics.count('ws_frames_sent', { kind })
    // Hard cap: a slow-but-alive client can keep this buffer growing
    // while the drain loop is suspended on backpressure. Force-close so
    // the client reconnects and replays from the bounded history ring.
    if (this.totalChars > MAX_QUEUE_CHARS) {
      log.warn(
        `WS write queue overflow (${this.totalChars} chars > ${MAX_QUEUE_CHARS}): ` +
        `force-closing socket to trigger reconnect + replay`,
      )
      this.stop()
      try { this.ws.close(1011, 'write queue overflow') } catch { /* socket may already be closing */ }
      return
    }
    if (!this.draining) void this.drain()
  }

  /** Signal that the socket is closing. Clears the queue and prevents
   *  any further drains from running. */
  stop() {
    this.stopped = true
    this.queue.length = 0
    this.head = 0
    this.totalChars = 0
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
      // Recompute totalChars after compaction so the MAX_QUEUE_CHARS cap
      // reflects only buffered (unsent) data, not the running lifetime
      // total — otherwise a long-lived connection would trip the cap
      // even though its actual backlog is small.
      this.totalChars = 0
      for (let i = 0; i < this.queue.length; i++) this.totalChars += this.queue[i]!.length
      this.draining = false
    }
  }
}

/** FrameSink backed by a WebSocket + {@link WsWriteQueue}. */
export class WsFrameSink implements FrameSink {
  private readonly queue: WsWriteQueue

  constructor(ws: WebSocket) {
    this.queue = new WsWriteQueue(ws)
  }

  send(frame: WsServerFrame): void {
    this.queue.enqueue(frame)
  }

  sendRaw(data: string, kind?: string): void {
    this.queue.enqueueRaw(data, kind)
  }

  close(): void {
    this.queue.stop()
  }
}
