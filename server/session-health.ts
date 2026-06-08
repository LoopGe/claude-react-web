// Stuck-session detection and auto-interrupt.
// Extracted from session-manager.ts for modularity.
//
// A periodic GC tick iterates all live sessions and checks whether any
// mid-turn session has been silent for longer than `workingStuckMs`.
// Silent sessions are auto-interrupted; if the interrupt doesn't unstick
// them within AUTO_INTERRUPT_DEDUP_MS, they're escalated to force-unload.

import type { Session } from './session-types.js'

/** How long after firing an auto-interrupt we give the SDK subprocess to
 *  respond before either (a) skipping the next GC tick or (b) escalating
 *  to a force-unload. Sized to be longer than typical interrupt round-trip
 *  but short enough that escalation kicks in within a couple of GC ticks. */
const AUTO_INTERRUPT_DEDUP_MS = 2 * 60 * 1000

/** GC interval — every 60 seconds the monitor sweeps all sessions. */
const GC_INTERVAL_MS = 60_000

/** Callbacks the health monitor needs from its owner (SessionManager). */
export interface HealthMonitorDeps {
  /** Live sessions map — the monitor iterates this and reads/writes
   *  session fields like `autoInterruptedAt`. */
  sessions: Map<string, Session>
  /** Maximum time (ms) a mid-turn session can stay silent before the
   *  monitor auto-interrupts it. 0 = disabled. */
  workingStuckMs: number
  /** Escalate: force-unload a session that couldn't be unstuck. */
  unload(id: string, opts: { terminate: boolean; reason: string }): Promise<void>
}

export class SessionHealthMonitor {
  private timer?: NodeJS.Timeout
  private deps: HealthMonitorDeps

  constructor(deps: HealthMonitorDeps) {
    this.deps = deps
    this.timer = setInterval(() => this.gc(), GC_INTERVAL_MS)
    // Don't keep the Node process alive just for GC
    this.timer.unref?.()
  }

  /** Stop the periodic GC timer. Call during graceful shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  // --- internals ---

  /** Periodic check for stuck sessions. Idle sessions are no longer
   *  auto-unloaded — they persist until explicitly deleted by the user. */
  private gc(): void {
    const now = Date.now()
    for (const [id, s] of this.deps.sessions) {
      this.checkStuck(id, s, now)
    }
  }

  /** Detect sessions that have made no progress for too long and try to
   *  shake them loose. Three flavours:
   *
   *  1. Mid-turn silence: pump received SOME messages but none recently.
   *     Measured by `lastActivityAt` — moves on every SDK message of any
   *     type (assistant, stream_event, task_progress, etc), so a session
   *     legitimately producing a long stream of progress events resets
   *     the clock and is never falsely classified as stuck. Only sessions
   *     that have actually gone silent get caught.
   *
   *  2. Init silence: session was spawned but NO messages have arrived
   *     yet. Common with proxy backends whose init handshake hangs. We
   *     can't interrupt() these usefully (the SDK subprocess hasn't
   *     wired up control yet), so we force-unload instead.
   *
   *  3. Already-interrupted: don't re-fire auto-interrupt every 60s.
   *     Once we've kicked a session, give it AUTO_INTERRUPT_DEDUP_MS to
   *     respond before kicking again. After that escalate to unload. */
  private checkStuck(id: string, s: Session, now: number): void {
    if (this.deps.workingStuckMs <= 0) return
    if (!s.running || s.terminated || s.exiting) return
    // Only check sessions that are actively working (mid-turn).
    // Idle sessions (pendingTurns=0, no pending permissions) are not stuck —
    // they are waiting for user input and should persist indefinitely.
    if (s.pendingTurns === 0 && s.pending.size === 0) return

    const idleSince = now - s.lastActivityAt
    if (idleSince <= this.deps.workingStuckMs) return

    // Init never landed: no point sending interrupt control frames into a
    // half-spawned subprocess. Schedule unload directly.
    if (s.history.length === 0) {
      console.warn(
        `[session ${id}] init never completed — no messages after ${idleSince}ms ` +
        `(pendingTurns=${s.pendingTurns}, subscribers=${s.subscribers.size}). Force-unloading.`,
      )
      void this.deps.unload(id, { terminate: true, reason: 'init_stuck' })
      return
    }

    // Mid-turn but truly stuck (lastActivityAt is older than threshold).
    // De-dup repeated kicks: if we already fired an interrupt recently,
    // wait it out before deciding what to do next.
    if (s.autoInterruptedAt && now - s.autoInterruptedAt < AUTO_INTERRUPT_DEDUP_MS) {
      return
    }

    // If we ALREADY tried interrupt once and it didn't break the silence
    // (autoInterruptedAt was set, dedup window has now passed, AND we're
    // still stuck), the SDK subprocess is wedged. Escalate to unload.
    if (s.autoInterruptedAt) {
      console.error(
        `[session ${id}] still silent ${now - s.autoInterruptedAt}ms after auto-interrupt — escalating to unload`,
      )
      void this.deps.unload(id, { terminate: true, reason: 'stuck' })
      return
    }

    const startedAt = Date.now()
    console.warn(
      `[session ${id}] no SDK message for ${idleSince}ms — auto-interrupting ` +
      `(pendingTurns=${s.pendingTurns}, pending perms=${s.pending.size}, ` +
      `subscribers=${s.subscribers.size}, history=${s.history.length})`,
    )
    s.autoInterruptedAt = now
    s.query.interrupt().then(
      () => console.warn(`[session ${id}] auto-interrupt() resolved in ${Date.now() - startedAt}ms`),
      (err) => console.error(`[session ${id}] auto-interrupt() rejected after ${Date.now() - startedAt}ms:`, err),
    )
  }
}
