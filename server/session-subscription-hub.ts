/**
 * SessionSubscriptionHub — manager-owned per-session subscriber registry
 * (spec §8.1).
 *
 * Subscriber queues live here, NOT on the replaceable `Session` object, so a
 * provider quiesce/resume (which swaps the Session and its pump/broker) never
 * closes a browser's queues. `rebind` replaces the pump/broker binding while
 * keeping connections; `detachBinding` (provider teardown) clears the binding
 * WITHOUT ending subscribers. Reset and control frames therefore survive a
 * Session replacement and stay ordered on the same per-connection queue.
 *
 * Frame shapes are unchanged — the hub is transport-agnostic (`unknown`); the
 * caller publishes the same frames the Session previously pushed.
 */

export interface HubConnection {
  id: string
  push: (frame: unknown) => void
  closed?: boolean
}

interface SessionChannel {
  conns: Map<string, HubConnection>
  /** Opaque pump/broker binding — replaced on rebind, cleared on teardown. */
  binding: unknown
}

export class SessionSubscriptionHub {
  private sessions = new Map<string, SessionChannel>()

  private channel(sessionId: string): SessionChannel {
    let ch = this.sessions.get(sessionId)
    if (!ch) {
      ch = { conns: new Map(), binding: null }
      this.sessions.set(sessionId, ch)
    }
    return ch
  }

  attach(sessionId: string, conn: HubConnection): void {
    this.channel(sessionId).conns.set(conn.id, conn)
  }

  detach(sessionId: string, connId: string): void {
    const ch = this.sessions.get(sessionId)
    if (!ch) return
    ch.conns.delete(connId)
    if (ch.conns.size === 0 && ch.binding === null) this.sessions.delete(sessionId)
  }

  /** Replace the pump/broker binding (Session replacement) — keeps queues. */
  rebind(sessionId: string, binding: unknown): void {
    this.channel(sessionId).binding = binding
  }

  /** Provider teardown: drop the binding, NOT the subscriber queues. */
  detachBinding(sessionId: string): void {
    const ch = this.sessions.get(sessionId)
    if (ch) ch.binding = null
  }

  bindingOf(sessionId: string): unknown {
    return this.sessions.get(sessionId)?.binding ?? null
  }

  subscriberCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.conns.size ?? 0
  }

  /** Fan a frame out to every live connection on the session's queue. */
  publish(sessionId: string, frame: unknown): void {
    const ch = this.sessions.get(sessionId)
    if (!ch) return
    for (const conn of ch.conns.values()) {
      if (conn.closed) continue
      conn.push(frame)
    }
  }
}
