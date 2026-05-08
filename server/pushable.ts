// Bounded AsyncIterable + push() utility.
//
// The Claude Agent SDK's `query({ prompt })` accepts an `AsyncIterable<SDKUserMessage>`
// for multi-turn streaming input. We need to feed user turns into the generator
// as they arrive from the HTTP layer, so we build a simple FIFO queue that
// resolves a pending `next()` promise as soon as an item is pushed.
//
// Rules:
// - push() after end() is a no-op (we never throw — the caller may race).
// - When the queue is empty and end() has been called, `next()` returns
//   { value: undefined, done: true }.
// - Only one consumer is expected per iterable (matches Query's usage).

export interface Pushable<T> {
  iterable: AsyncIterable<T>
  push: (item: T) => void
  end: () => void
  closed: boolean
}

export function createPushable<T>(): Pushable<T> {
  const queue: T[] = []
  let waiter: ((value: IteratorResult<T>) => void) | null = null
  let ended = false

  const state = {
    push(item: T) {
      if (ended) return
      if (waiter) {
        const w = waiter
        waiter = null
        w({ value: item, done: false })
      } else {
        queue.push(item)
      }
    },
    end() {
      if (ended) return
      ended = true
      if (waiter) {
        const w = waiter
        waiter = null
        w({ value: undefined as unknown as T, done: true })
      }
    },
    get closed() {
      return ended
    },
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length) {
            return Promise.resolve({ value: queue.shift()!, done: false })
          }
          if (ended) {
            return Promise.resolve({ value: undefined as unknown as T, done: true })
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            waiter = resolve
          })
        },
        return(): Promise<IteratorResult<T>> {
          ended = true
          if (waiter) {
            const w = waiter
            waiter = null
            w({ value: undefined as unknown as T, done: true })
          }
          return Promise.resolve({ value: undefined as unknown as T, done: true })
        },
      }
    },
  }

  return {
    iterable,
    push: (item) => state.push(item),
    end: () => state.end(),
    get closed() {
      return state.closed
    },
  }
}
