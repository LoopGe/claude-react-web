/* eslint-disable no-irregular-whitespace -- zero-width spaces in code samples prevent nested comment closer */
/**
 * Per-session concurrency limiter for the auto-mode classifier.
 *
 * Prevents cost runaway when Claude makes many rapid tool calls:
 * each call triggers a classifier API request, and without a cap
 * a burst of 100 tool calls would fire 100 parallel API requests.
 *
 * Usage (inside the canUseTool closure):
 *   const limiter = new ClassifierLimiter(5)
 *   if (!limiter.tryAcquire()) { /* fall back to prompt *​/ }
 *   try { /* call classifier *​/ } finally { limiter.release() }
 */

export class ClassifierLimiter {
  private inFlight = 0
  private readonly maxConcurrent: number

  constructor(maxConcurrent = 5) {
    this.maxConcurrent = maxConcurrent
  }

  /** Try to acquire a slot. Returns false if at capacity. */
  tryAcquire(): boolean {
    if (this.inFlight >= this.maxConcurrent) return false
    this.inFlight++
    return true
  }

  /** Release a previously acquired slot. Safe to call multiple times. */
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }

  /** Current number of in-flight classifier calls. */
  get active(): number {
    return this.inFlight
  }
}
