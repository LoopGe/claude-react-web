import { describe, expect, it, vi } from 'vitest'
import { SessionDeleteQueue } from './session-delete-queue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('SessionDeleteQueue', () => {
  it('queues a permanent delete behind an in-flight ordinary delete', async () => {
    const first = deferred<boolean>()
    const perform = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(true)
    const queue = new SessionDeleteQueue()
    const settled = vi.fn()

    queue.run('s1', undefined, perform, settled)
    queue.run('s1', { deleteTranscript: true }, perform, settled)
    await Promise.resolve()
    expect(perform).toHaveBeenCalledTimes(1)
    expect(perform).toHaveBeenLastCalledWith('s1', undefined)

    first.resolve(true)
    await first.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(perform).toHaveBeenCalledTimes(2)
    expect(perform).toHaveBeenLastCalledWith('s1', { deleteTranscript: true })
  })

  it('does not duplicate an ordinary delete or weaken a permanent one', async () => {
    const perform = vi.fn().mockResolvedValue(true)
    const queue = new SessionDeleteQueue()
    const settled = vi.fn()

    queue.run('s1', { deleteTranscript: true }, perform, settled)
    queue.run('s1', undefined, perform, settled)
    queue.run('s1', undefined, perform, settled)
    await Promise.resolve()
    await Promise.resolve()

    expect(perform).toHaveBeenCalledTimes(1)
    expect(perform).toHaveBeenCalledWith('s1', { deleteTranscript: true })
  })

  it('settles a rejected operation and allows a later retry', async () => {
    const perform = vi.fn()
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce(true)
    const queue = new SessionDeleteQueue()
    const settled = vi.fn()

    queue.run('s1', undefined, perform, settled)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toHaveBeenCalledWith(false)
    expect(queue.hasPending('s1')).toBe(false)

    queue.run('s1', undefined, perform, settled)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(perform).toHaveBeenCalledTimes(2)
    expect(queue.hasPending('s1')).toBe(false)
  })
})
