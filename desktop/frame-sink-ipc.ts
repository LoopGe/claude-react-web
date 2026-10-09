// MessagePort implementation of the frame bridge's FrameSink.
//
// The desktop host gives each renderer a dedicated MessageChannel pair; this
// sink writes that channel. It owns the queueing/overflow policy the WS sink
// gets from WsWriteQueue: unlike a WebSocket, a MessagePort cannot
// "disconnect and reconnect", so on overflow we surface a fatal signal the
// renderer handles by re-subscribing (the bridge re-serves a replay), rather
// than force-closing the pipe.
//
// Like the WS sink, replay bursts carry a token and a newer same-session
// burst supersedes the older burst's still-queued frames (see
// server/replay-bursts.ts) — a StrictMode/multi-holder re-serve storm must
// not pile ~12 full-ring replays into this queue either.

import type { MessagePortMain } from 'electron'
import { createLogger } from '../server/log.js'
import { metrics } from '../server/metrics.js'
import type { WsServerFrame } from '../server/ws-protocol.js'
import type { FrameSink } from '../server/frame-bridge.js'
import {
  ReplayBurstRegistry,
  type BurstQueueEntry,
  type ReplayBurstToken,
} from '../server/replay-bursts.js'

const log = createLogger('desktop')

/** Mirror of WsWriteQueue.MAX_QUEUE_CHARS, measured in serialized chars. */
const MAX_QUEUE_CHARS = 8_000_000
/** Yield to the event loop every N frames so other channels stay fair. */
const FRAMES_PER_YIELD = 10

export class PortFrameSink implements FrameSink {
  private queue: BurstQueueEntry[] = []
  private head = 0
  private totalChars = 0
  private draining = false
  private stopped = false
  private readonly bursts = new ReplayBurstRegistry()

  constructor(
    private readonly port: MessagePortMain,
    private readonly onFatal?: (reason: string) => void,
  ) {}

  send(frame: WsServerFrame, burst?: ReplayBurstToken): void {
    this.enqueue(JSON.stringify(frame), frame.kind, burst)
  }

  /** `kind` is accepted for FrameSink parity; it is only used by the WS sink
   *  for a per-kind metric, which has no IPC equivalent. */
  sendRaw(data: string, kind?: string): void {
    this.enqueue(data, kind)
  }

  /** The client unsubscribed from a session: drop its queued replay
   *  remainder (the panel is gone — nobody will read it). */
  dropQueuedReplays(sessionId: string): void {
    if (this.stopped) return
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
  }

  private enqueue(data: string, kind?: string, burst?: ReplayBurstToken): void {
    if (this.stopped) return
    const entry: BurstQueueEntry = { data, kind, burst }
    // Supersede BEFORE push and BEFORE the cap check (same order as the WS
    // sink): freed chars count toward the new frame's budget.
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
    if (this.totalChars > MAX_QUEUE_CHARS) {
      log.warn(
        `IPC write queue overflow (${this.totalChars} chars > ${MAX_QUEUE_CHARS}): ` +
        `asking renderer to re-subscribe`,
      )
      // Cannot tear down a MessagePort the way a WebSocket is closed. Drop the
      // backlog and tell the renderer to start over; its re-subscribe hits the
      // already-live path and the bridge re-serves a fresh replay. The registry
      // MUST be deactivated here: the queue is cleared without stopping, so a
      // stale active burst would make a later supersede subtract chars that no
      // longer exist (phantom frees → negative totalChars).
      this.bursts.deactivateAll()
      this.queue.length = 0
      this.head = 0
      this.totalChars = 0
      this.onFatal?.('overflow')
      return
    }
    if (!this.draining) void this.drain()
  }

  /** Stop accepting frames. Called by the bridge on connection teardown. */
  close(): void {
    this.stopped = true
    this.bursts.deactivateAll()
    this.queue.length = 0
    this.head = 0
    this.totalChars = 0
    try {
      this.port.close()
    } catch {
      /* already closed */
    }
  }

  private async drain(): Promise<void> {
    this.draining = true
    let sinceYield = 0
    try {
      while (this.head < this.queue.length && !this.stopped) {
        const entry = this.queue[this.head++]!
        // Superseded while queued — skip without posting.
        if (entry.dropped) continue
        // Mark taken before the (possible) yield so a supersede running
        // concurrently can never drop a frame that was already posted.
        entry.consumed = true
        this.bursts.onConsumed(entry)
        // Retire its chars now — same accounting rule as the WS sink.
        this.totalChars -= entry.data.length
        try {
          this.port.postMessage(entry.data)
        } catch (err) {
          // Port is gone (renderer navigated / crashed). Stop draining; the
          // bridge's own close() will run from the 'close'/'destroyed' path.
          log.warn('port postMessage failed:', err)
          this.stopped = true
          break
        }
        if (++sinceYield >= FRAMES_PER_YIELD) {
          sinceYield = 0
          await new Promise<void>((r) => setImmediate(r))
        }
      }
    } finally {
      // Rebuild the remaining queue, purging dropped/consumed entries so the
      // accounting only ever sees live frames (their chars were already
      // retired at drop/take time).
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
