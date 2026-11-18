// server/providers/native/mcp/shared-registry.ts
//
// The host-global registry of shared external MCP connections: one
// `SharedRecord` per `sharingKey(config)`, refcounted across sessions, so N
// sessions with an identical stdio config drive ONE child process.
//
// Lifetime rules:
//   - `acquire` is synchronous (it returns the record; callers await
//     `record.ready` for the initial connect). Its map mutation — users++ or
//     create + users=1 + fire-and-forget connect — happens inline. An acquire
//     of a `cleanupFailed` record returns that SAME blocked record (users++)
//     without a fresh connect: automatic replacement is refused until a
//     death-gated manual `reconnect()` clears the flag.
//   - `release` runs its whole mutation (users--, and at 0 the bounded close +
//     the map decision) on a PER-KEY serialized queue — one tail promise per
//     sharing key, the `enqueue` pattern from `connections.ts`. Same-key
//     serialization is what keeps a release-at-0 from racing a concurrent
//     acquire of that key: an acquire that lands before the queued task runs
//     bumps the refcount the task then observes (so it stands down). Different
//     keys' releases run concurrently, so a hung close on one server never
//     blocks another server's teardown.
//   - At users==0 the close settles BEFORE the map decision, because only a
//     settled close knows whether cleanup failed: a `cleanupFailed` record is
//     RETAINED (users 0) so it blocks automatic replacement — deleting first
//     would let a concurrent acquire spawn a replacement overlapping the live
//     hung child, the exact hazard fail-closed prevents. A healthy close
//     removes the record; an acquire that landed DURING teardown (users > 0)
//     gets the record REVIVED for it (fire-and-forget reconnect) instead of a
//     closed zombie every future acquire would join.
//   - Teardown at users==0 is immediate — no idle grace. After a healthy
//     close + remove, the next acquire of the same key spawns a fresh child.
//
// The sharing key embeds env values, so it never reaches a log; diagnostics
// carry only the (non-secret) command.

import { createLogger } from '../../../log.js'
import { metrics } from '../../../metrics.js'
import type { NativeMcpServerConfig } from './connections.js'
import { SharedRecord, sharingKey, type SharedRecordOptions } from './shared-record.js'

const log = createLogger('native-mcp-registry')

export class SharedRegistry {
  private readonly records = new Map<string, SharedRecord>()
  private readonly opts: SharedRecordOptions
  /** One release-queue tail per sharing key; settled tails are removed. */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(opts: SharedRecordOptions = {}) {
    this.opts = opts
  }

  /** Register one user of `config`'s shared connection and return its record.
   *  The first user spawns the connection (fire-and-forget, like
   *  `connections.load`); await `record.ready` for the initial connect. */
  acquire(config: NativeMcpServerConfig): SharedRecord {
    const key = sharingKey(config)
    let rec = this.records.get(key)
    if (rec) {
      rec.users++
      if (rec.cleanupFailed) {
        // Fail-closed: the blocked record is returned as-is — no fresh connect,
        // no replacement child. It stays failed until a death-gated manual
        // reconnect() clears the flag.
        log.warn(
          `acquire of ${config.command ?? 'mcp'} returned a cleanup-failed record ` +
            '(automatic replacement blocked; reconnect gated on confirmed child death)',
        )
      }
    } else {
      rec = new SharedRecord(key, config, this.opts)
      rec.users = 1
      this.records.set(key, rec)
      void rec.connect()
      log.debug(`acquired ${config.command ?? 'mcp'} (first user)`)
    }
    metrics.count('mcp_shared_acquire')
    metrics.gauge('shared_mcp_records', this.records.size)
    return rec
  }

  /** Drop one user of the record; at 0 close it, then remove it from the map
   *  ONLY if cleanup succeeded. A `cleanupFailed` record is retained (users 0)
   *  so it blocks automatic replacement until a death-gated manual reconnect.
   *  Resolves once the teardown (if any) has settled. */
  release(record: SharedRecord): Promise<void> {
    return this.enqueue(record.key, async () => {
      record.users--
      metrics.count('mcp_shared_release')
      if (record.users > 0) return
      // Close BEFORE the map decision: only a settled close knows whether
      // cleanup failed, and a failed one must stay in the map — deleting
      // first would let a concurrent acquire spawn a replacement overlapping
      // the live hung child.
      await record.close()
      if (record.cleanupFailed) {
        log.warn(
          `retaining ${record.config.command ?? 'mcp'} at users 0 (cleanup failed; ` +
            'automatic replacement blocked until a death-gated reconnect)',
        )
        return
      }
      // An acquire that landed during teardown bumped the refcount: REVIVE the
      // closed record for the new user rather than leaving a zombie (client
      // gone, supervisor suppressed) that every future acquire of the key
      // would join. The death gate is a no-op here — cleanupFailed is false,
      // and the PER-KEY queue serializes SAME-KEY releases, so no close can
      // settle ahead of this reconnect's queued gate — hence the
      // fire-and-forget cannot reject.
      if (record.users > 0) {
        void record.reconnect()
        return
      }
      this.records.delete(record.key)
      metrics.gauge('shared_mcp_records', this.records.size)
      log.debug(`released ${record.config.command ?? 'mcp'} (last user; closed)`)
    })
  }

  get(key: string): SharedRecord | undefined {
    return this.records.get(key)
  }

  /** Active record count (the metrics gauge's source). */
  get size(): number {
    return this.records.size
  }

  /** Keys with a release queue still in flight (test/diagnostic seam). Settled
   *  tails are removed, so an idle registry reads 0. */
  get pendingQueueCount(): number {
    return this.queues.size
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Run `task` after every earlier release OF THE SAME KEY has settled. The
   *  returned promise carries the task's rejection to its caller, but the queue
   *  itself never rejects, so one failed release cannot poison the next. A
   *  settled tail with no newer task chained is removed, so the map holds only
   *  keys with releases still in flight. */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(key) ?? Promise.resolve()
    const run = tail.then(task, task)
    const next = run.then(noop, noop)
    this.queues.set(key, next)
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key)
    })
    return run
  }
}

function noop(): void {}
