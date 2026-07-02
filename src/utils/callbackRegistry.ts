// A tiny per-key callback registry with a stale-guarded unregister.
//
// Used by App.tsx for the per-session interrupt / recap-refresh /
// input-injection callback Maps. The previous pattern stored closures in a
// `useRef(Map)` keyed by sessionId and only ever `.set()` — closing a session
// left the closure pinned forever (and the component scope it captured).
//
// `register` returns an unregister function. The unregister is *stale-guarded*:
// it only deletes the entry when the value still matches the one it registered.
// This matters because React effect cleanup for an OLD callback can run AFTER a
// NEW one has already registered (StrictMode double-invoke, or a rapid session
// switch) — a naive `delete` would clobber the fresh entry.

export interface CallbackRegistry<T> {
  /** Register `fn` for `id`. Returns an unregister function that removes the
   *  entry only if it still holds `fn` (stale-guard). Safe to call more than
   *  once. */
  register: (id: string, fn: T) => () => void
  /** Get the callback for `id`, or undefined. */
  get: (id: string) => T | undefined
  /** True when `id` has a registered callback. */
  has: (id: string) => boolean
  /** Remove the entry for `id` unconditionally. Use on session-removed. */
  delete: (id: string) => void
}

export function createCallbackRegistry<T>(): CallbackRegistry<T> {
  const map = new Map<string, T>()
  return {
    register(id, fn) {
      map.set(id, fn)
      return () => {
        // Stale guard: only delete if the current entry is still the one we
        // registered. A newer registration (rapid remount / StrictMode) must
        // not be clobbered by a late cleanup of the old one.
        if (map.get(id) === fn) map.delete(id)
      }
    },
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    delete: (id) => {
      map.delete(id)
    },
  }
}
