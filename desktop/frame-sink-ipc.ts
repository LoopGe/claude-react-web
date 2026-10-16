// MessagePort implementation of the frame bridge's FrameSink.
//
// The desktop host gives each renderer a dedicated MessageChannel pair; this
// sink writes that channel. It owns the queueing/overflow policy the WS sink
// gets from WsWriteQueue: unlike a WebSocket, a MessagePort cannot
// "disconnect and reconnect", so on overflow we surface a fatal signal the
// renderer handles by re-subscribing, rather than force-closing the pipe.

import type { MessagePortMain } from 'electron'
import { createLogger } from '../server/log.js'
import type { WsServerFrame } from '../server/ws-protocol.js'
import type { FrameSink } from '../server/frame-bridge.js'

const log = createLogger('desktop')

/** Mirror of WsWriteQueue.MAX_QUEUE_CHARS, measured in serialized chars. */
const MAX_QUEUE_CHARS = 8_000_000
/** Yield to the event loop every N frames so other channels stay fair. */
const FRAMES_PER_YIELD = 10

export class PortFrameSink implements FrameSink {
  private queue: string[] = []
  private head = 0
  private totalChars = 0
  private draining = false
  private stopped = false

  constructor(
    private readonly port: MessagePortMain,
    private readonly onFatal?: (reason: string) => void,
  ) {}

  send(frame: WsServerFrame): void {
    this.enqueue(JSON.stringify(frame))
  }

  /** Signature parity with the FrameSink interface; the WS sink uses `kind`
   *  for a per-kind metric, which has no IPC equivalent. */
  sendRaw(data: string, _kind?: string): void {
    this.enqueue(data)
  }

  private enqueue(data: string): void {
    if (this.stopped) return
    this.queue.push(data)
    this.totalChars += data.length
    if (this.totalChars > MAX_QUEUE_CHARS) {
      log.warn(
        `IPC write queue overflow (${this.totalChars} chars > ${MAX_QUEUE_CHARS}): ` +
        `asking renderer to re-subscribe`,
      )
      // Cannot tear down a MessagePort the way a WebSocket is closed. Drop the
      // backlog and tell the renderer to start over; its re-subscribe hits the
      // already-live path and the bridge re-attaches the listener.
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
        const data = this.queue[this.head++]!
        // Retire its chars now — same accounting rule as the WS sink.
        this.totalChars -= data.length
        try {
          this.port.postMessage(data)
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
      this.queue.length = 0
      this.head = 0
      this.totalChars = 0
      this.draining = false
    }
  }
}
