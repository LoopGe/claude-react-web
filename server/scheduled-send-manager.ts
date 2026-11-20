// In-memory scheduled sends: a per-session pending map + a capped recent
// terminal ring. NOT persisted — a server restart drops every schedule.
// A single unref'd ticker fires due sends through the injected `send`
// delegate (sm.send/sendContent in production, a fake in tests).

import { randomUUID } from 'node:crypto'
import { HttpError } from './errors.js'
import type { ScheduledSend, ScheduledSendBody } from '../shared/scheduled-send.js'
import { REBUILD_REQUIRED } from '../shared/ws-protocol.js'

export const MIN_DELAY_MS = 5_000
export const MAX_PENDING_PER_SESSION = 20
export const TERMINAL_KEEP = 10

export interface ScheduledSendDeps {
  send(sessionId: string, body: ScheduledSendBody): { uuid?: string } | Promise<{ uuid?: string }>
  /** Session-removed feed (sm.subscribeGlobal). Each `removed` drops that
   *  session's schedules so deleted sessions can't leave garbage. */
  subscribeGlobal?(): { iterable: AsyncIterable<{ kind: string; id?: string }>; unsubscribe(): void }
  now?(): number
  tickMs?: number
}

/** The transcript-mutation admission refusal (spec §8.1): a due send that
 *  hits it is DEFERRED (retried in order once admission restores), not failed
 *  — REBUILD_REQUIRED is not a persistence failure and must not lose the
 *  scheduled payload. Any other error keeps the terminal-failure semantics. */
const isRebuildRequired = (err: unknown): boolean =>
  err instanceof HttpError && err.status === 409 && err.message === REBUILD_REQUIRED

export class ScheduledSendManager {
  /** pending records by session — the only entries the ticker fires. */
  private active = new Map<string, Map<string, ScheduledSend>>()
  /** Due sends refused with REBUILD_REQUIRED, per session in original attempt
   *  order (FIFO). Retried at the head of every tick until admission restores;
   *  NOT terminal — the payload is kept, not lost (spec §8.1). */
  private deferred = new Map<string, ScheduledSend[]>()
  /** recent terminal (sent/failed/cancelled) by session, capped TERMINAL_KEEP. */
  private terminal = new Map<string, ScheduledSend[]>()
  private timer: ReturnType<typeof setInterval> | null = null
  private globalCleanup: (() => void) | null = null
  private readonly now: () => number

  constructor(private readonly deps: ScheduledSendDeps) {
    this.now = deps.now ?? Date.now
    this.timer = setInterval(() => { void this.tick() }, deps.tickMs ?? 1000)
    this.timer.unref?.()
    const sg = deps.subscribeGlobal
    if (sg) {
      const sub = sg()
      this.globalCleanup = sub.unsubscribe
      void (async () => {
        try {
          for await (const ev of sub.iterable) {
            if (ev.kind === 'removed' && typeof ev.id === 'string') this.cancelAll(ev.id)
          }
        } catch { /* intentionally empty */ }
      })()
    }
  }

  create(sessionId: string, body: ScheduledSendBody, fireAt: number): ScheduledSend {
    if (!Number.isFinite(fireAt) || fireAt <= this.now() + MIN_DELAY_MS) {
      throw new HttpError(400, `fireAt must be a finite time at least ${MIN_DELAY_MS / 1000}s in the future`)
    }
    const pending = this.active.get(sessionId)
    // Deferred records keep their slot: during a long admission closure they
    // cycle active→deferred, and counting only active would let the deferred
    // FIFO grow unbounded past the per-session budget.
    const deferredCount = this.deferred.get(sessionId)?.length ?? 0
    if ((pending?.size ?? 0) + deferredCount >= MAX_PENDING_PER_SESSION) {
      throw new HttpError(400, `too many scheduled messages for session ${sessionId}`)
    }
    const rec: ScheduledSend = {
      id: randomUUID(),
      sessionId,
      fireAt,
      body,
      status: 'pending',
      createdAt: this.now(),
    }
    const m = pending ?? new Map<string, ScheduledSend>()
    m.set(rec.id, rec)
    this.active.set(sessionId, m)
    return rec
  }

  list(sessionId: string): ScheduledSend[] {
    return [
      ...(this.active.get(sessionId)?.values() ?? []),
      ...(this.deferred.get(sessionId) ?? []),
      ...(this.terminal.get(sessionId) ?? []),
    ]
  }

  remove(sessionId: string, id: string): void {
    const pending = this.active.get(sessionId)
    const rec = pending?.get(id)
    if (rec) {
      pending!.delete(id)
      if (pending!.size === 0) this.active.delete(sessionId)
      rec.status = 'cancelled'
      this.pushTerminal(sessionId, rec)
      return
    }
    const deferred = this.deferred.get(sessionId)
    const di = deferred?.findIndex((r) => r.id === id) ?? -1
    if (deferred && di >= 0) {
      const [rec] = deferred.splice(di, 1)
      if (deferred.length === 0) this.deferred.delete(sessionId)
      rec.status = 'cancelled'
      this.pushTerminal(sessionId, rec)
      return
    }
    const ring = this.terminal.get(sessionId)
    const idx = ring?.findIndex((t) => t.id === id) ?? -1
    if (ring && idx >= 0) {
      ring.splice(idx, 1)
      return
    }
    throw new HttpError(404, `schedule ${id} not found`)
  }

  cancelAll(sessionId: string): void {
    this.active.delete(sessionId)
    this.deferred.delete(sessionId)
    this.terminal.delete(sessionId)
  }

  /** Attempt one due/deferred record. Returns true when it reached a terminal
   *  state (sent/failed); false when it was refused with REBUILD_REQUIRED and
   *  must stay deferred (payload retained, retried in order — spec §8.1). */
  private async fire(sessionId: string, rec: ScheduledSend): Promise<boolean> {
    try {
      const { uuid } = await this.deps.send(sessionId, rec.body)
      rec.status = 'sent'
      rec.sentUuid = uuid
      this.pushTerminal(sessionId, rec)
      return true
    } catch (err) {
      if (isRebuildRequired(err)) {
        rec.status = 'deferred'
        return false
      }
      rec.status = 'failed'
      rec.error = err instanceof Error ? err.message : String(err)
      this.pushTerminal(sessionId, rec)
      return true
    }
  }

  async tick(): Promise<void> {
    const nowMs = this.now()
    // Deferred sends retry FIRST, in original attempt order — admission may
    // have cleared since the last tick (rebuild commit / cancel). Claim the
    // whole batch synchronously so an overlapping tick cannot double-fire a
    // record while its send is in flight.
    for (const [sessionId, batch] of [...this.deferred]) {
      this.deferred.delete(sessionId)
      const stillDeferred: ScheduledSend[] = []
      for (const rec of batch) {
        if (!(await this.fire(sessionId, rec))) stillDeferred.push(rec)
      }
      if (stillDeferred.length > 0) {
        // Older attempts keep the head ahead of any deferral a concurrent
        // tick appended while this batch was in flight.
        this.deferred.set(sessionId, [...stillDeferred, ...(this.deferred.get(sessionId) ?? [])])
      }
    }
    for (const [sessionId, m] of [...this.active]) {
      for (const [id, rec] of [...m]) {
        if (rec.status !== 'pending' || rec.fireAt > nowMs) continue
        m.delete(id)
        if (m.size === 0) this.active.delete(sessionId)
        if (!(await this.fire(sessionId, rec))) {
          const d = this.deferred.get(sessionId) ?? []
          d.push(rec)
          this.deferred.set(sessionId, d)
        }
      }
    }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.globalCleanup?.()
    this.globalCleanup = null
  }

  private pushTerminal(sessionId: string, rec: ScheduledSend): void {
    let ring = this.terminal.get(sessionId)
    if (!ring) {
      ring = []
      this.terminal.set(sessionId, ring)
    }
    ring.push(rec)
    if (ring.length > TERMINAL_KEEP) ring.splice(0, ring.length - TERMINAL_KEEP)
  }
}
