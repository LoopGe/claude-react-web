/** Register one transport drain waiter with symmetric abort cleanup. */
export function waitForDrainCancellation(
  waiters: Set<() => void>,
  cancelled?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      waiters.delete(done)
      cancelled?.removeEventListener('abort', done)
      resolve()
    }
    waiters.add(done)
    if (cancelled?.aborted) done()
    else cancelled?.addEventListener('abort', done, { once: true })
  })
}
