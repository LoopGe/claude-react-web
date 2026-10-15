import { describe, expect, it } from 'vitest'
import { SessionOpLock } from './session-op-lock.js'

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = () => new Promise((r) => setImmediate(r))

/** Reject when `p` hasn't settled within `ms` — the deadlock guard. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ])
}

describe('SessionOpLock', () => {
  it('serializes ops on the same key (B starts only after A finishes)', async () => {
    const lock = new SessionOpLock()
    const events: string[] = []
    const gateA = deferred()
    const a = lock.run('x', async () => {
      events.push('a:start')
      await gateA.promise
      events.push('a:end')
      return 'A'
    })
    const b = lock.run('x', async () => {
      events.push('b:start')
      return 'B'
    })
    await flush()
    expect(events).toEqual(['a:start'])
    gateA.resolve()
    expect(await a).toBe('A')
    expect(await b).toBe('B')
    expect(events).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('runs ops on different keys in parallel', async () => {
    const lock = new SessionOpLock()
    const gateA = deferred()
    let bRan = false
    const a = lock.run('x', () => gateA.promise)
    const b = lock.run('y', () => { bRan = true })
    await b
    expect(bRan).toBe(true)
    expect(lock.isBusy('x')).toBe(true)
    gateA.resolve()
    await a
  })

  it('invokes fn synchronously when the key is free', () => {
    const lock = new SessionOpLock()
    let ran = false
    void lock.run('x', () => { ran = true })
    expect(ran).toBe(true)
  })

  it('re-enters from inside a holder (nested run does not deadlock)', async () => {
    const lock = new SessionOpLock()
    const result = lock.run('x', async () => {
      await flush()
      const inner = await lock.run('x', async () => {
        await flush()
        return lock.run('x', () => 'deep')
      })
      return `outer+${inner}`
    })
    await expect(within(result, 1000)).resolves.toBe('outer+deep')
  })

  it('holding one key does not re-enter another', async () => {
    const lock = new SessionOpLock()
    const gateY = deferred()
    const y = lock.run('y', () => gateY.promise)
    let innerRan = false
    const x = lock.run('x', async () => {
      await lock.run('y', () => { innerRan = true })
    })
    await flush()
    expect(innerRan).toBe(false)
    gateY.resolve()
    await within(Promise.all([x, y]), 1000)
    expect(innerRan).toBe(true)
  })

  it('a detached task started inside an op is not a holder after release', async () => {
    const lock = new SessionOpLock()
    const resumeDetached = deferred()
    let detached!: Promise<string>
    const events: string[] = []
    await lock.run('x', () => {
      // Fire-and-forget: inherits the op's async context, but only runs its
      // locked call AFTER the op has released.
      detached = (async () => {
        await resumeDetached.promise
        return lock.run('x', () => { events.push('detached'); return 'd' })
      })()
    })
    // A new op takes the lock; the detached task must queue behind it.
    const gateC = deferred()
    const c = lock.run('x', async () => {
      events.push('c:start')
      await gateC.promise
      events.push('c:end')
    })
    resumeDetached.resolve()
    await flush()
    await flush()
    expect(events).toEqual(['c:start'])
    gateC.resolve()
    await c
    expect(await within(detached, 1000)).toBe('d')
    expect(events).toEqual(['c:start', 'c:end', 'detached'])
  })

  it('a detached task that runs while the op is still active re-enters', async () => {
    const lock = new SessionOpLock()
    const gate = deferred()
    let inner!: Promise<string>
    const op = lock.run('x', async () => {
      inner = (async () => lock.run('x', () => 'inner'))()
      await gate.promise
    })
    // The op is still holding the lock, so the nested call must not wait on it.
    expect(await within(inner, 1000)).toBe('inner')
    gate.resolve()
    await op
  })

  it('a throwing fn releases the lock and rejects only its caller', async () => {
    const lock = new SessionOpLock()
    const a = lock.run('x', async () => { throw new Error('boom') })
    const b = lock.run('x', () => 'ok')
    await expect(a).rejects.toThrow('boom')
    await expect(b).resolves.toBe('ok')
    // Synchronous throw too.
    const c = lock.run('x', () => { throw new Error('sync') })
    await expect(c).rejects.toThrow('sync')
    await expect(lock.run('x', () => 'after')).resolves.toBe('after')
  })

  it('drops the per-key tail once everything has settled', async () => {
    const lock = new SessionOpLock()
    const gate = deferred()
    const ops = [
      lock.run('x', () => gate.promise),
      lock.run('x', () => 1),
      lock.run('y', async () => { throw new Error('y') }),
    ]
    expect(lock.isBusy('x')).toBe(true)
    gate.resolve()
    await Promise.allSettled(ops)
    await flush()
    expect(lock.isBusy('x')).toBe(false)
    expect(lock.isBusy('y')).toBe(false)
  })

  it('maxWaitMs runs fn after the deadline even if the holder never releases', async () => {
    const lock = new SessionOpLock()
    const wedged = lock.run('x', () => new Promise<never>(() => { /* never settles */ }))
    const events: string[] = []
    const bounded = lock.run('x', () => { events.push('bounded'); return 'ran' }, { maxWaitMs: 30 })
    // Queued after the bounded op: still waits for it.
    const after = lock.run('x', () => { events.push('after') })
    await flush()
    expect(events).toEqual([])
    expect(await within(bounded, 1000)).toBe('ran')
    await within(after, 1000)
    expect(events).toEqual(['bounded', 'after'])
    void wedged
  })

  it('maxWaitMs does not overtake a holder that releases in time', async () => {
    const lock = new SessionOpLock()
    const gate = deferred()
    const events: string[] = []
    const a = lock.run('x', async () => { await gate.promise; events.push('a') })
    const b = lock.run('x', () => { events.push('b') }, { maxWaitMs: 1000 })
    await flush()
    gate.resolve()
    await within(Promise.all([a, b]), 1000)
    expect(events).toEqual(['a', 'b'])
  })

  it('the caller resumes after the release (a follow-up op is not stuck behind it)', async () => {
    const lock = new SessionOpLock()
    await lock.run('x', () => 'first')
    expect(lock.isBusy('x')).toBe(false)
    let ran = false
    void lock.run('x', () => { ran = true })
    expect(ran).toBe(true)
  })
})
