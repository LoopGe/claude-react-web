import { describe, expect, it } from 'vitest'
import { createPushable } from './pushable.js'

describe('createPushable', () => {
  it('delivers items pushed before next() in FIFO order', async () => {
    const p = createPushable<number>()
    p.push(1)
    p.push(2)
    p.push(3)

    const it = p.iterable[Symbol.asyncIterator]()
    expect(await it.next()).toEqual({ value: 1, done: false })
    expect(await it.next()).toEqual({ value: 2, done: false })
    expect(await it.next()).toEqual({ value: 3, done: false })
  })

  it('resolves a pending next() when push arrives', async () => {
    const p = createPushable<string>()
    const it = p.iterable[Symbol.asyncIterator]()
    // next() parks before push — the waiter path.
    const pending = it.next()
    p.push('hi')
    expect(await pending).toEqual({ value: 'hi', done: false })
  })

  it('end() terminates the iterator after draining queue', async () => {
    const p = createPushable<number>()
    p.push(42)
    p.end()
    // Items pushed before end() must still be delivered — end is not
    // destructive, it just flips the "no more arrivals" bit.
    const it = p.iterable[Symbol.asyncIterator]()
    expect(await it.next()).toEqual({ value: 42, done: false })
    expect(await it.next()).toEqual({ value: undefined, done: true })
  })

  it('end() while a waiter is parked resolves it as done', async () => {
    const p = createPushable<number>()
    const it = p.iterable[Symbol.asyncIterator]()
    const pending = it.next()
    p.end()
    expect(await pending).toEqual({ value: undefined, done: true })
  })

  it('push() after end() is a no-op', async () => {
    const p = createPushable<number>()
    p.end()
    p.push(1)
    const it = p.iterable[Symbol.asyncIterator]()
    expect(await it.next()).toEqual({ value: undefined, done: true })
  })

  it('closed reflects end() state', () => {
    const p = createPushable<number>()
    expect(p.closed).toBe(false)
    p.end()
    expect(p.closed).toBe(true)
  })

  it('iterator return() closes the consumer but not the producer', async () => {
    const p = createPushable<number>()
    const it = p.iterable[Symbol.asyncIterator]()
    await it.return!()
    // return() only closes the current consumer iterator, NOT the
    // pushable as a whole — this is critical for shared iterables
    // (e.g. contextUsagePushable) that serve multiple sequential consumers.
    expect(p.closed).toBe(false)
    // Pushes still succeed for a new consumer.
    p.push(99)
    // A new iterator can consume the pushed item.
    const it2 = p.iterable[Symbol.asyncIterator]()
    expect(await it2.next()).toEqual({ value: 99, done: false })
    p.end()
    expect(p.closed).toBe(true)
  })

  describe('onConsume hook', () => {
    it('fires on the queue-shift path (item buffered, then read)', async () => {
      const consumed: number[] = []
      const p = createPushable<number>('t', undefined, (x) => consumed.push(x))
      // Push BEFORE next() — items sit in the queue and are shifted on read.
      p.push(1)
      p.push(2)
      expect(consumed).toEqual([]) // not consumed until read
      const it = p.iterable[Symbol.asyncIterator]()
      await it.next()
      expect(consumed).toEqual([1])
      await it.next()
      expect(consumed).toEqual([1, 2])
    })

    it('fires on the direct hand-off path (consumer parked, then push)', async () => {
      const consumed: string[] = []
      const p = createPushable<string>('t', undefined, (x) => consumed.push(x))
      const it = p.iterable[Symbol.asyncIterator]()
      // next() parks first → push delivers directly to the waiter, bypassing
      // the queue. The hook must still fire on this path.
      const pending = it.next()
      p.push('direct')
      await pending
      expect(consumed).toEqual(['direct'])
    })

    it('does not fire on push after end()', async () => {
      const consumed: number[] = []
      const p = createPushable<number>('t', undefined, (x) => consumed.push(x))
      p.end()
      p.push(7)
      expect(consumed).toEqual([])
    })

    it('a throwing hook never breaks iteration', async () => {
      const p = createPushable<number>('t', undefined, () => {
        throw new Error('hook boom')
      })
      p.push(5)
      const it = p.iterable[Symbol.asyncIterator]()
      // The throw is swallowed internally; next() still resolves normally.
      expect(await it.next()).toEqual({ value: 5, done: false })
    })
  })
})
