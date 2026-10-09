// WebSocket implementation of the frame-bridge's FrameSink.
//
// Owns everything socket-specific that the old ws.ts inline connection did:
// an async write queue, kernel-buffer backpressure, the hard queue cap
// that force-closes a slow-but-alive client so it reconnects and replays from
// the server's bounded history ring, and replay-burst supersede (a newer
// replay burst for a session drops the older burst's still-queued frames).

import type { WebSocket } from 'ws'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'
import type { WsServerFrame } from './ws-protocol.js'
import type { FrameSink } from './frame-bridge.js'
import {
  ReplayBurstRegistry,
  type BurstQueueEntry,
  type ReplayBurstToken,
  type SupersededFrames,
} from './replay-bursts.js'

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
 * sink — the interleaving `setImmediate` gives other drivers a chance to
 * enqueue their (small) frames before the next drain iteration.
 *
 * **Replay-burst supersede:** replay frames may carry a burst token (one per
 * `sendReplay` call). When a NEW burst for session S is enqueued, the
 * still-queued (unsent) frames of the OLDER same-session burst — including
 * its replay-done — are dropped, so a StrictMode/multi-holder storm of
 * duplicate full-ring re-serves cannot pile ~12 bursts into the queue and
 * trip MAX_QUEUE_CHARS. See server/replay-bursts.ts for the client-safety
 * contract. The broadcast hot path (sendRaw) stays untagged and is never
 * dropped.
 */
export class WsWriteQueue {
  private queue: BurstQueueEntry[] = []
  private head = 0
  private draining = false
  private stopped = false
  private ws: WebSocket
  private totalChars = 0
  private readonly bursts = new ReplayBurstRegistry()

  constructor(ws: WebSocket) {
    this.ws = ws
  }

  /** Enqueue a frame for async delivery. Drops silently if the socket
   *  has been stopped or is no longer OPEN — callers don't need to
   *  check readyState themselves. `burst` tags the frame as a member of
   *  one replay burst (see supersede above). */
  enqueue(frame: WsServerFrame, burst?: ReplayBurstToken) {
    this.enqueueRaw(JSON.stringify(frame), frame.kind, burst)
  }

  /** Enqueue an already-serialized frame string. Used by the broadcast
   *  path where one message is fanned out to many connections: the frame
   *  is stringified once (see `messageFrameJson`) and the same string is
   *  pushed into every subscribed connection's queue, avoiding M×
   *  JSON.stringify on the hot path. */
  enqueueRaw(data: string, kind?: string, burst?: ReplayBurstToken) {
    if (this.stopped || this.ws.readyState !== this.ws.OPEN) return
    const entry: BurstQueueEntry = { data, kind, burst }
    // Supersede BEFORE push and BEFORE the cap check: the freed chars count
    // toward this frame's budget, which is exactly what keeps a burst storm
    // (each newer serve superseding the older queued remainder) under the cap.
    if (burst) {
      const freed = this.bursts.register(burst, entry)
      if (freed.frames > 0) {
        this.totalChars -= freed.chars
        log.info(
          `superseded ${freed.frames} queued replay frames (${freed.chars} chars) — ` +
          `a newer replay burst for the session took over`,
        )
        metrics.count('ws_replay_frames_superseded', { reason: 'superseded' }, freed.frames)
        metrics.count('ws_replay_chars_superseded', { reason: 'superseded' }, freed.chars)
      }
    }
    this.queue.push(entry)
    this.totalChars += data.length
    // Count only frames actually queued to a live socket — frames dropped
    // above (stopped / not OPEN) never reach a client and would inflate
    // the volume metric exactly in the overload scenarios it diagnoses.
    // (Frames later superseded while still queued are counted here too;
    // the ws_replay_*_superseded counters quantify that delta.)
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

  /** The client unsubscribed from a session: drop its queued replay
   *  remainder (the panel is gone — nobody will read it). Returns what
   *  was freed. */
  dropSessionReplays(sessionId: string): SupersededFrames {
    if (this.stopped) return { frames: 0, chars: 0 }
    const freed = this.bursts.dropSession(sessionId)
    if (freed.frames > 0) {
      this.totalChars -= freed.chars
      log.info(
        `dropped ${freed.frames} queued replay frames (${freed.chars} chars) — ` +
        `client unsubscribed from the session`,
      )
      metrics.count('ws_replay_frames_superseded', { reason: 'unsubscribed' }, freed.frames)
      metrics.count('ws_replay_chars_superseded', { reason: 'unsubscribed' }, freed.chars)
    }
    return freed
  }

  /** Signal that the socket is closing. Clears the queue and prevents
   *  any further drains from running. */
  stop() {
    this.stopped = true
    this.bursts.deactivateAll()
    this.queue.length = 0
    this.head = 0
    this.totalChars = 0
  }

  private async drain() {
    this.draining = true
    let framesSinceYield = 0
    try {
      while (this.head < this.queue.length && !this.stopped) {
        const entry = this.queue[this.head++]!
        // Superseded while queued — skip without sending.
        if (entry.dropped) continue
        // Mark taken BEFORE any await so a supersede running during the
        // backpressure wait can never drop a frame that is already on
        // the wire.
        entry.consumed = true
        this.bursts.onConsumed(entry)
        // Retire its chars from the cap accounting NOW, not in the
        // finally below: the finally only runs when the whole loop
        // exits, so during a long backpressure stall totalChars would
        // otherwise keep counting already-sent frames and trip the cap
        // on stale data. From here on totalChars is always exactly the
        // queued-and-unsent bytes.
        this.totalChars -= entry.data.length
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
            this.ws.send(entry.data, () => { cleanup(); resolve() })
          })
          // The await above already yielded to the event loop.
          framesSinceYield = 0
        } else {
          this.ws.send(entry.data)
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
      // Rebuild the remaining queue instead of splicing: physically purge
      // superseded entries so the cap accounting only ever sees live
      // frames. Consumed entries already had their chars retired at take
      // time; dropped entries at drop time — the rebuild drops both from
      // the array so nothing is ever counted twice.
      const remaining: BurstQueueEntry[] = []
      for (let i = this.head; i < this.queue.length; i++) {
        const e = this.queue[i]!
        if (!e.dropped && !e.consumed) remaining.push(e)
      }
      this.queue = remaining
      this.head = 0
      this.totalChars = 0
      for (const e of remaining) this.totalChars += e.data.length
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

  send(frame: WsServerFrame, burst?: ReplayBurstToken): void {
    this.queue.enqueue(frame, burst)
  }

  sendRaw(data: string, kind?: string): void {
    this.queue.enqueueRaw(data, kind)
  }

  dropQueuedReplays(sessionId: string): void {
    this.queue.dropSessionReplays(sessionId)
  }

  close(): void {
    this.queue.stop()
  }
}
