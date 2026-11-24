/** Shared test-side deferred: a promise with its settle handles exposed, so a
 *  test can hold a mock's completion open and resolve/reject it on cue.
 *  Promise.withResolvers is ES2024; the repo targets ES2022 libs and Node 20.
 *  Production code keeps its own private copy (e.g. pdf-runtime.ts) — this
 *  module is for tests only. */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}