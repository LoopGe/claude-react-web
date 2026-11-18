// server/providers/native/mcp/shared-registry.ts
//
// The host-global registry of shared external MCP connections: one
// `SharedRecord` per `sharingKey(config)`, refcounted across sessions, so N
// sessions with an identical stdio config drive ONE child process.
//
// Lifetime rules:
//   - `acquire` is synchronous (it returns the record; callers await
//     `record.ready` for the initial connect). Its map mutation — users++ or
//     create + users=1 + fire-and-forget connect — happens inline.
//   - `release` runs its whole mutation (users--, and at 0 the map delete +
//     bounded close) on one serialized queue, the `enqueue` pattern from
//     `connections.ts`. That serialization is what keeps a release-at-0 from
//     racing a concurrent acquire of the same key: an acquire that lands
//     before the queued task runs bumps the refcount the task then observes
//     (so it stands down), and the map delete happens BEFORE the close await,
//     so an acquire that lands during teardown creates a fresh record instead
//     of reviving a closing one.
//   - Teardown at users==0 is immediate — no idle grace. The next acquire of
//     the same key spawns a fresh child.
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
  private queue: Promise<void> = Promise.resolve()

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

  /** Drop one user of the record; at 0 close it and remove it from the map.
   *  Resolves once the teardown (if any) has settled. */
  release(record: SharedRecord): Promise<void> {
    return this.enqueue(async () => {
      record.users--
      metrics.count('mcp_shared_release')
      if (record.users > 0) return
      // Delete BEFORE awaiting close: a concurrent acquire of the same key
      // during teardown must create a fresh record, never revive a closing one.
      this.records.delete(record.key)
      metrics.gauge('shared_mcp_records', this.records.size)
      await record.close()
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

  // ── internals ──────────────────────────────────────────────────────────

  /** Run `task` after every earlier release has settled. The returned promise
   *  carries the task's rejection to its caller, but the queue itself never
   *  rejects, so one failed release cannot poison the next. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(noop, noop)
    return run
  }
}

function noop(): void {}
