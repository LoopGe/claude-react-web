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

import { debugLog, debugWarn } from './debug.js'

let pushableSeq = 0

export interface Pushable<T> {
  iterable: AsyncIterable<T>
  push: (item: T) => void
  end: () => void
  closed: boolean
  /** Diagnostic: true when a consumer is blocked on next() waiting for data. */
  readonly hasWaiter: boolean
  /** Diagnostic: number of items sitting in the queue. */
  readonly queueDepth: number
}

export function createPushable<T>(label = 'pushable', maxDepth?: number): Pushable<T> {
  const id = `${label}#${++pushableSeq}`
  const queue: T[] = []
  let waiter: ((value: IteratorResult<T>) => void) | null = null
  let ended = false
  let nextCallCount = 0
  let pushCallCount = 0

  const state = {
    push(item: T) {
      pushCallCount++
      if (ended) {
        debugWarn(`[${id}] push #${pushCallCount} DROPPED — ended=true`)
        return
      }
      if (waiter) {
        const w = waiter
        waiter = null
        debugLog(`[${id}] push #${pushCallCount} → resolved waiter directly (queue was empty, consumer was waiting)`)
        w({ value: item, done: false })
      } else {
        queue.push(item)
        // When a maxDepth is set, drop the oldest item to prevent
        // unbounded growth for slow consumers (e.g. background tabs).
        if (maxDepth !== undefined && queue.length > maxDepth) {
          queue.shift()
          debugLog(`[${id}] push #${pushCallCount} → queued, dropped oldest (queue depth now: ${queue.length})`)
        } else {
          debugLog(`[${id}] push #${pushCallCount} → queued (no waiter, queue depth now: ${queue.length})`)
        }
      }
    },
    end() {
      if (ended) return
      ended = true
      debugLog(`[${id}] end() called — queue depth: ${queue.length}, waiter: ${!!waiter}`)
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
      debugLog(`[${id}] [Symbol.asyncIterator]() called — new iterator created`)
      return {
        next(): Promise<IteratorResult<T>> {
          nextCallCount++
          if (queue.length) {
            const item = queue.shift()!
            debugLog(`[${id}] next #${nextCallCount} → resolved from queue (queue depth now: ${queue.length})`)
            return Promise.resolve({ value: item, done: false })
          }
          if (ended) {
            debugLog(`[${id}] next #${nextCallCount} → done (ended=true)`)
            return Promise.resolve({ value: undefined as unknown as T, done: true })
          }
          debugLog(`[${id}] next #${nextCallCount} → waiting (setting waiter, no items in queue)`)
          return new Promise<IteratorResult<T>>((resolve) => {
            waiter = resolve
          })
        },
        // NOTE: intentionally does NOT set `ended = true`. Setting it
        // would permanently kill the producer — a problem for pushables
        // whose iterable is shared across multiple sequential consumers
        // (e.g. contextUsageSubscribers, where each WS subscriber creates
        // a new iterator). `end()` is the proper way to terminate the
        // producer; `return()` only closes the current consumer.
        return(): Promise<IteratorResult<T>> {
          debugWarn(`[${id}] return() called on iterator — waiter: ${!!waiter}, queue: ${queue.length}, ended: ${ended}`)
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
    get hasWaiter() {
      return waiter !== null
    },
    get queueDepth() {
      return queue.length
    },
  }
}
