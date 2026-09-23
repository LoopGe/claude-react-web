/** Shared Promise-vs-timer race helpers.
 *
 *  Single home for the two timeout idioms that were previously duplicated
 *  across mcp-config.ts (rejecting withTimeout) and session-manager.ts
 *  (inline Promise.race + resolve-fallback timers). */

/** Reject with a timeout Error when `promise` hasn't settled within `ms`.
 *  The underlying promise is NOT cancelled — late settlement is simply
 *  ignored (a handler was attached, so no unhandled-rejection warning). */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Connection timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** Resolve with `fallback` when `promise` hasn't settled within `ms`. Use
 *  this when the awaited work must KEEP RUNNING past the deadline (e.g. a
 *  snapshot capture that still has to release its lock) and the caller just
 *  wants to stop waiting. The timer is always cleared once either side
 *  settles. */
export function raceWithFallback<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
