// Pre-warmed CLI process pool using the SDK's `startup()` API.
//
// `startup()` pre-spawns and initializes a CLI subprocess, returning a
// `WarmQuery` handle. The first `warmQuery.query(prompt)` is ~20x faster
// than a cold `query()` call because the init phase is already done.
//
// `WarmQuery` is single-shot — after `.query()` it's consumed, so the pool
// refills asynchronously. Sessions with custom cwd/model fall back to
// regular cold spawn since options are baked at startup time.

import { startup, type Options, type WarmQuery } from '@anthropic-ai/claude-agent-sdk'

export interface WarmPoolOptions {
  /** Number of pre-warmed queries to maintain. Default 2. */
  poolSize: number
  /** Base SDK options for pre-warming (env, auth, claude binary path).
   *  Session-specific options (model, cwd, abortController) are NOT included. */
  baseOptions: Options
}

export class WarmPool {
  private pool: WarmQuery[] = []
  private targetSize: number
  private baseOptions: Options
  private filling = false
  private closed = false

  constructor(opts: WarmPoolOptions) {
    this.targetSize = opts.poolSize
    this.baseOptions = opts.baseOptions
  }

  /** Pre-fill the pool on startup. Non-blocking — fills in background. */
  async fill(): Promise<void> {
    if (this.closed || this.filling) return
    this.filling = true
    try {
      while (this.pool.length < this.targetSize && !this.closed) {
        try {
          const wq = await startup({ options: this.baseOptions })
          if (this.closed) {
            wq.close()
            break
          }
          this.pool.push(wq)
          console.log(`[warm-pool] warmed query ready (${this.pool.length}/${this.targetSize})`)
        } catch (err) {
          console.warn('[warm-pool] startup() failed:', (err as Error).message)
          // Don't retry immediately — the failure is likely persistent
          // (bad auth, missing binary, etc.). Break to avoid a tight loop.
          break
        }
      }
    } finally {
      this.filling = false
      // If acquire() was called while we were filling, the skipped fill()
      // calls left the pool below target. Re-check and fill again so we
      // don't permanently lose capacity after a burst of acquisitions.
      if (this.pool.length < this.targetSize && !this.closed) {
        void this.fill()
      }
    }
  }

  /** Try to acquire a pre-warmed query. Returns null if pool is empty.
   *  Caller is responsible for calling `.query(prompt)` on the result. */
  acquire(): WarmQuery | null {
    if (this.closed || this.pool.length === 0) return null
    const wq = this.pool.pop()!
    // Double-check after pop: close() may have fired between our
    // initial guard and the pop(). The popped element is no longer in
    // the pool so close()'s loop skipped it — close it here instead.
    if (this.closed) {
      try { wq.close() } catch { /* already closed */ }
      return null
    }
    // Refill asynchronously — don't await, don't block the caller
    void this.fill()
    return wq
  }

  /** Check if a warm query is available without consuming it. */
  get available(): boolean {
    return this.pool.length > 0
  }

  /** Current pool size (for debug/status). */
  get size(): number {
    return this.pool.length
  }

  /** Close all warm queries. Called during graceful shutdown. */
  close(): void {
    this.closed = true
    for (const wq of this.pool) {
      try { wq.close() } catch { /* already closed */ }
    }
    this.pool.length = 0
    console.log('[warm-pool] closed')
  }
}
