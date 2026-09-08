// In-memory scheduled sends: a per-session pending map + a capped recent
// terminal ring. NOT persisted — a server restart drops every schedule.
// A single unref'd ticker fires due sends through the injected `send`
// delegate (sm.send/sendContent in production, a fake in tests).

import { randomUUID } from 'node:crypto'
import { HttpError } from './errors.js'
import type { ScheduledSend, ScheduledSendBody } from '../shared/scheduled-send.js'

export const MIN_DELAY_MS = 5_000
export const MAX_PENDING_PER_SESSION = 20
export const TERMINAL_KEEP = 10

export interface ScheduledSendDeps {
  send(sessionId: string, body: ScheduledSendBody): { uuid: string } | Promise<{ uuid: string }>
  /** Session-removed feed (sm.subscribeGlobal). Each `removed` drops that
   *  session's schedules so deleted sessions can't leave garbage. */
  subscribeGlobal?(): { iterable: AsyncIterable<{ kind: string; id?: string }>; unsubscribe(): void }
  now?(): number
  tickMs?: number
}

export class ScheduledSendManager {
  /** pending records by session — the only entries the ticker fires. */
  private active = new Map<string, Map<string, ScheduledSend>>()
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
    if ((pending?.size ?? 0) >= MAX_PENDING_PER_SESSION) {
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
    this.terminal.delete(sessionId)
  }

  async tick(): Promise<void> {
    const nowMs = this.now()
    for (const [sessionId, m] of [...this.active]) {
      for (const [id, rec] of [...m]) {
        if (rec.status !== 'pending' || rec.fireAt > nowMs) continue
        m.delete(id)
        if (m.size === 0) this.active.delete(sessionId)
        try {
          const { uuid } = await this.deps.send(sessionId, rec.body)
          rec.status = 'sent'
          rec.sentUuid = uuid
        } catch (err) {
          rec.status = 'failed'
          rec.error = err instanceof Error ? err.message : String(err)
        }
        this.pushTerminal(sessionId, rec)
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
