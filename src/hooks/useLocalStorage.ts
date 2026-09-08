// Minimal type wrapper around localStorage with a React-friendly update API.
//
// SSR-safe (checks typeof window), JSON-encoded, and quietly ignores storage
// errors (quota exceeded, disabled storage, etc.). Returns the same tuple
// shape as useState so callers can drop it in.
//
// Multi-instance behaviour:
//   - Same-tab: a module-level Map of listeners means any number of
//     useLocalStorage(SAME_KEY, …) instances on the same page stay in sync.
//     When one instance writes, every other instance subscribed to that
//     key receives the new value and updates its React state. Without
//     this, two Composer panels would each cache their own copy of
//     `composer-snippets` and silently disagree until one re-mounts.
//   - Cross-tab: a window 'storage' listener catches writes from other
//     tabs (storage events do NOT fire in the writing tab — the in-tab
//     emitter above covers that case).
//
// Schema validation:
//   - Optional `validate` predicate guards the value at BOTH boundaries:
//   - READ (the initial load, and a storage event from another tab): a value
//     that fails validation is untrusted data, so the load collapses to
//     `initial` / an incoming bad write is ignored rather than adopted.
//   - WRITE (`update`): the resolved value is validated before it is applied.
//     A rejected write is DROPPED with a console warning — the current value
//     and the stored copy are left exactly as they were.
//
// The write gate is deliberate. Validation used to live only on the same-tab
// echo, where a rejected write fell back to `initial` — which silently turned
// "one field of my setting was bad" into "the whole setting is gone", and then
// persisted that loss to disk (and, via the storage event, into every other
// tab). A caller whose validator is stricter than its TypeScript type hit that
// with a plain click: the click undone and no trace of why.

import { useCallback, useEffect, useRef, useState } from 'react'

interface Options<T> {
  /** Optional type-guard, applied at two boundaries: the READ boundary (a stored
   *  value that fails it collapses to `initial`) and the WRITE boundary
   *  (`update` drops a value that fails it and keeps the current one). */
  validate?: (value: unknown) => value is T
}

// Module-level set of subscribers per storage key — populated by each
// useLocalStorage instance via its subscribe effect. The setters live
// here, not the values, so adding a new listener is O(1) and dispatching
// is O(N) over instances on the same key (typically 1-3).
type Listener<T> = (value: T) => void
const listenersByKey = new Map<string, Set<Listener<unknown>>>()

function notifyListeners(key: string, value: unknown): void {
  const set = listenersByKey.get(key)
  if (!set) return
  // Copy before iterating — a listener could in theory unsubscribe
  // during dispatch and mutate the set mid-loop.
  for (const cb of [...set]) cb(value)
}

export function useLocalStorage<T>(
  key: string | null,
  initial: T,
  options?: Options<T>,
): [T, (value: T | ((prev: T) => T)) => void] {
  // Stash the validator in a ref so the subscribe effect's identity doesn't
  // change every render (which would re-register the window 'storage' listener
  // constantly). We capture the first-render value and never reassign — same
  // semantics as React's lazy useState initializer, which also only ever sees
  // the first call's argument. Callers passing a different validator across
  // renders should not expect the hook to track that change.
  const validateRef = useRef(options?.validate)

  const [value, setValue] = useState<T>(() => {
    // null key → pure in-memory state: no read from localStorage.
    if (typeof window === 'undefined' || key == null) return initial
    try {
      const raw = window.localStorage.getItem(key)
      if (raw == null) return initial
      const parsed: unknown = JSON.parse(raw)
      const validate = options?.validate
      if (validate && !validate(parsed)) return initial
      return parsed as T
    } catch {
      return initial
    }
  })

  // Subscribe to (a) other useLocalStorage instances on the same key in
  // this tab, (b) localStorage writes from other tabs. Only depends on
  // `key` so the listener set-up runs once per key change.
  useEffect(() => {
    // null key → no cross-instance / cross-tab subscription.
    if (typeof window === 'undefined' || key == null) return

    // Adopt whatever a same-key co-tenant holds, unverified. Writes through
    // `update` are gated before they can be broadcast, but a co-tenant's
    // mount-time persist can still emit its own `initial` (which this hook does
    // not validate) — the point here is that instances agree, not that they
    // police each other. Re-validating at this boundary is what used to undo
    // the writer's own click; see the write gate in `update`.
    const onSync: Listener<unknown> = (next) => setValue(next as T)
    let set = listenersByKey.get(key)
    if (!set) {
      set = new Set()
      listenersByKey.set(key, set)
    }
    set.add(onSync)

    const onStorage = (e: StorageEvent) => {
      // Only react to writes against our key (and skip 'clear all'
      // events whose key is null — those would force every instance
      // back to initial which is rarely what callers want).
      if (e.key !== key || e.newValue == null) return
      try {
        const parsed: unknown = JSON.parse(e.newValue)
        const validate = validateRef.current
        if (validate && !validate(parsed)) {
          // Another tab (often an older build) put something we can't use on
          // disk. Ignore it: adopting it, or "recovering" to `initial`, would
          // both destroy this tab's good value and re-persist the loss.
          console.warn(
            `[useLocalStorage] ignoring invalid "${key}" written by another tab; keeping current value`,
          )
          return
        }
        setValue(parsed as T)
      } catch {
        /* ignore — corrupt incoming write */
      }
    }
    window.addEventListener('storage', onStorage)

    return () => {
      set!.delete(onSync)
      if (set!.size === 0) listenersByKey.delete(key)
      window.removeEventListener('storage', onStorage)
    }
  }, [key])

  // Persist on every change AND notify same-tab subscribers. The
  // notification will land on every instance subscribed to this key —
  // including this one. Since `value` is already what each instance is
  // about to be set to, React's Object.is bailout absorbs the echo.
  useEffect(() => {
    // null key → pure in-memory state: no write to localStorage.
    if (typeof window === 'undefined' || key == null) return
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch (err) {
      // Quota exhausted (or SecurityError in private mode): the write is
      // dropped but in-memory state still updates and notifies. Warn —
      // never swallow silently. A full quota here means the value the user
      // sees won't survive reload, and a silent failure makes that class
      // of bug (e.g. a group losing a member after refresh) near-impossible
      // to diagnose.
      const quota =
        err instanceof DOMException &&
        (err.code === 22 ||
          err.code === 1014 ||
          err.name === 'QuotaExceededError' ||
          err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
      console.warn(
        `[useLocalStorage] failed to persist "${key}"` +
          (quota ? ' — localStorage quota is full; this key was NOT saved' : '') +
          ':',
        err,
      )
    }
    notifyListeners(key, value)
  }, [key, value])

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        const validate = validateRef.current
        if (validate && !validate(resolved)) {
          // Drop the write, keep the value: the caller's state and the stored
          // copy stay untouched, and the reason says so out loud.
          console.warn(`[useLocalStorage] rejected write to "${key}" — it failed validation; keeping the current value`)
          return prev
        }
        return resolved
      })
    },
    [key],
  )

  return [value, update]
}
