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

  it('iterator return() closes the pushable', async () => {
    const p = createPushable<number>()
    const it = p.iterable[Symbol.asyncIterator]()
    await it.return!()
    expect(p.closed).toBe(true)
    // Subsequent pushes must not leak past the closed gate.
    p.push(99)
    expect(await it.next()).toEqual({ value: undefined, done: true })
  })
})
