// Generic async-iterable factory that encapsulates the queue/waiter/closed
// pattern used by every subscribe* method in session-manager.ts.
//
// Before this extraction, subscribeGlobal(), subscribePermissions(), and
// subscribe() each contained ~50 lines of nearly identical boilerplate.
// This helper reduces each call-site to ~5 lines.

/** Default per-subscriber queue cap. When the queue exceeds this length
 *  (because a slow consumer isn't reading fast enough), the oldest entries
 *  are dropped so memory doesn't grow unbounded. */
export const SUBSCRIBER_QUEUE_CAP = 500

export interface AsyncSubscription<T> {
  /** The async iterable to hand to the HTTP streaming layer. */
  iterable: AsyncIterable<T>
  /** Push a value into the subscriber's queue. No-op after close(). */
  push: (value: T) => void
  /** Signal completion — resolves any pending `next()` with `done: true`.
   *  Idempotent. */
  end: () => void
  /** Whether end() has been called. */
  readonly closed: boolean
}

/**
 * Create a self-contained async subscription.
 *
 * @param onCleanup  Called exactly once when the iterable's consumer calls
 *                   `return()` (explicit break/teardown). Use this to
 *                   remove the subscriber from whatever registry it was
 *                   added to. NOT called on `end()` — only on `return()`.
 */
export function createAsyncSubscription<T>(
  onCleanup?: () => void,
): AsyncSubscription<T> {
  const queue: T[] = []
  let waiter: ((v: IteratorResult<T>) => void) | null = null
  let closed = false

  const push = (value: T) => {
    if (closed) return
    if (waiter) {
      const w = waiter
      waiter = null
      w({ value, done: false })
    } else {
      queue.push(value)
      if (queue.length > SUBSCRIBER_QUEUE_CAP) {
        queue.splice(0, queue.length - SUBSCRIBER_QUEUE_CAP)
      }
    }
  }

  const end = () => {
    if (closed) return
    closed = true
    if (waiter) {
      const w = waiter
      waiter = null
      w({ value: undefined as unknown as T, done: true })
    }
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<T>> => {
        if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false })
        if (closed) return Promise.resolve({ value: undefined as unknown as T, done: true })
        return new Promise((r) => { waiter = r })
      },
      return: (): Promise<IteratorResult<T>> => {
        end()
        onCleanup?.()
        return Promise.resolve({ value: undefined as unknown as T, done: true })
      },
    }),
  }

  return {
    iterable,
    push,
    end,
    get closed() {
      return closed
    },
  }
}
