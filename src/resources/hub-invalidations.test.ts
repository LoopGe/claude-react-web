// @vitest-environment node
// Hub → registry invalidation bridge: filters by frame kind, queues while the
// consumer is not awaiting, and unsubscribes on abort.

import { describe, it, expect } from 'vitest'
import { hubInvalidations } from './hub-invalidations'

function fakeHub() {
  const listeners = new Set<(frame: { kind: string }) => void>()
  return {
    addListener(onFrame: (frame: { kind: string }) => void) {
      listeners.add(onFrame)
      return () => listeners.delete(onFrame)
    },
    emit(frame: { kind: string }) {
      for (const listener of [...listeners]) listener(frame)
    },
    get size() {
      return listeners.size
    },
  }
}

async function next(iterable: AsyncIterator<unknown>): Promise<unknown> {
  const result = await iterable.next()
  return result.value
}

describe('hubInvalidations', () => {
  it('yields only frames whose kind was requested', async () => {
    const hub = fakeHub()
    const controller = new AbortController()
    const stream = hubInvalidations(hub)(['git-snapshot'], controller.signal)[Symbol.asyncIterator]()
    hub.emit({ kind: 'message' })
    const git = { kind: 'git-snapshot' }
    hub.emit(git)
    expect(await next(stream)).toEqual(git)
    controller.abort()
  })

  it('queues frames that arrive before the consumer awaits', async () => {
    const hub = fakeHub()
    const controller = new AbortController()
    const stream = hubInvalidations(hub)(['git-snapshot'], controller.signal)[Symbol.asyncIterator]()
    const first = { kind: 'git-snapshot', n: 1 }
    const second = { kind: 'git-snapshot', n: 2 }
    hub.emit(first)
    hub.emit(second)
    expect(await next(stream)).toEqual(first)
    expect(await next(stream)).toEqual(second)
    controller.abort()
  })

  it('unsubscribes on abort and ends the stream', async () => {
    const hub = fakeHub()
    const controller = new AbortController()
    const stream = hubInvalidations(hub)(['git-snapshot'], controller.signal)[Symbol.asyncIterator]()
    expect(hub.size).toBe(1)
    controller.abort()
    expect(hub.size).toBe(0)
    const result = await stream.next()
    expect(result.done).toBe(true)
  })
})