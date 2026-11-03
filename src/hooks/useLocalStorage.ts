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
  /** Optional normalizer applied at three boundaries — the initial read, a
   *  cross-tab storage event, and a local `update` — BEFORE `validate`. Lets a
   *  caller salvage a mixed-shape persisted value (e.g. filter non-strings out
   *  of an array) instead of discarding the whole thing. The same-tab echo path
   *  does NOT re-normalize: the writer already normalized, and re-filtering
   *  would mint fresh array references on every echo, looping
   *  setValue → effect → notify → setValue. */
  normalize?: (value: unknown) => T
  /** How an EXTERNAL storage event (cross-tab) that cannot be adopted is
   *  handled. `'ignore'` (default) keeps the current value and leaves the key
   *  untouched, preserving the long-standing behaviour for every existing
   *  caller. `'reset'` collapses every mounted instance on that key to its own
   *  `initial` and suppresses the persistence echo so a deleted or corrupt key
   *  is not immediately written back. Suppression is module-level and per-key:
   *  only a valid external write or a real user `update` clears it. */
  externalFailure?: 'ignore' | 'reset'
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

// Module-level suppression, keyed by storage key. When an external delete,
// corrupt-JSON, or validator-reject reset lands on a key, the key is added
// here so NO instance's persistence effect writes `setItem` for it until a
// valid external write or a real user `update` clears it. This MUST be shared
// across instances on the same key: if each instance cleared its own echo in
// its own effect, the first instance to run would clear the guard and the next
// instance's echo would write the deleted key straight back to disk.
const suppressPersistenceByKey = new Set<string>()

// Private sentinel dispatched through the same listener channel as a value.
// `removeLocalStorageKey` emits it so every reset-opted instance on the key
// adopts its own `initial` immediately — the writing tab does not receive a
// browser storage event for its own removeItem, so same-tab listeners must be
// notified directly. Default-opted instances ignore it. The sentinel carries
// no value: each instance supplies its own `initial` from its closure, so the
// module-level listener never needs to know per-instance state.
const DELETION_SENTINEL = Symbol('useLocalStorage:deletion')

/** Remove a storage key AND notify same-tab listeners that it was deleted.
 *  Reset-opted mounted instances collapse to their `initial` immediately; the
 *  key is added to the suppression set so the reset echo does not write it
 *  back. Default-opted instances are unaffected. */
export function removeLocalStorageKey(key: string): void {
  if (typeof window === 'undefined') return
  suppressPersistenceByKey.add(key)
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore — disabled storage, private mode, etc. */
  }
  notifyListeners(key, DELETION_SENTINEL)
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
  // normalize and externalFailure follow the same first-render ref semantics,
  // for the same reason (the storage listener identity must stay stable).
  const normalizeRef = useRef(options?.normalize)
  const externalFailureRef = useRef(options?.externalFailure ?? 'ignore')

  const [value, setValue] = useState<T>(() => {
    // null key → pure in-memory state: no read from localStorage.
    if (typeof window === 'undefined' || key == null) return initial
    try {
      const raw = window.localStorage.getItem(key)
      if (raw == null) return initial
      const parsed: unknown = JSON.parse(raw)
      // Initial READ boundary: normalize → validate. Read from `options`
      // directly (NOT the refs) — the useState initializer runs during
      // render, and the react-hooks/refs rule forbids ref access there.
      // On the first render (the only time this initializer runs)
      // `options?.X === XRef.current`, so behaviour is identical to the
      // ref reads used in the effect and `update` (which run after render).
      const normalize = options?.normalize
      const normalized = normalize ? normalize(parsed) : parsed
      const validate = options?.validate
      if (validate && !validate(normalized)) return initial
      return normalized as T
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
    const onSync: Listener<unknown> = (next) => {
      if (next === DELETION_SENTINEL) {
        // Same-tab deletion notification (removeLocalStorageKey). The
        // writing tab does not get a browser storage event for its own
        // removeItem, so the sentinel is the only same-tab signal. Only
        // reset-opted instances react; default instances keep their value.
        if (externalFailureRef.current === 'reset') {
          setValue(initial)
        }
        return
      }
      // Same-tab value echo: the writer already normalized before persisting,
      // so do NOT re-normalize here. Re-filtering would mint fresh array
      // references on every echo and loop setValue → effect → notify → setValue.
      setValue(next as T)
    }
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
      if (e.key !== key) return
      if (e.newValue == null) {
        // Cross-tab deletion of our key. Default 'ignore' keeps the current
        // value (the long-standing behaviour); 'reset' collapses to initial
        // and suppresses the echo so the deleted key stays deleted.
        if (externalFailureRef.current === 'reset') {
          suppressPersistenceByKey.add(key)
          setValue(initial)
        }
        return
      }
      try {
        const parsed: unknown = JSON.parse(e.newValue)
        // Cross-tab WRITE boundary: normalize → validate.
        const normalize = normalizeRef.current
        const normalized = normalize ? normalize(parsed) : parsed
        const validate = validateRef.current
        if (validate && !validate(normalized)) {
          // Another tab (often an older build) put something we can't use on
          // disk. 'ignore' keeps this tab's good value and warns; 'reset'
          // collapses to initial and suppresses the echo so the bad key is
          // not overwritten by the fallback.
          if (externalFailureRef.current === 'reset') {
            suppressPersistenceByKey.add(key)
            setValue(initial)
          } else {
            console.warn(
              `[useLocalStorage] ignoring invalid "${key}" written by another tab; keeping current value`,
            )
          }
          return
        }
        // A valid external write clears any active suppression and is adopted.
        suppressPersistenceByKey.delete(key)
        setValue(normalized as T)
      } catch {
        // Corrupt incoming JSON. 'ignore' drops it silently; 'reset'
        // collapses to initial and suppresses the echo so the corrupt key
        // is not overwritten.
        if (externalFailureRef.current === 'reset') {
          suppressPersistenceByKey.add(key)
          setValue(initial)
        }
        /* default ignore — corrupt incoming write */
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
    // Suppressed: an external delete / corrupt-JSON / validator reset added
    // this key to the suppression set. Skip setItem so the deleted/corrupt
    // key is not revived, but STILL notify same-tab listeners — every
    // instance must converge on the reset value. Never clear the suppression
    // here: clearing it in one instance's effect would let the next instance's
    // echo write the key back. Only a valid external write or a real user
    // `update` clears it.
    if (!suppressPersistenceByKey.has(key)) {
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
    }
    notifyListeners(key, value)
  }, [key, value])

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        // Local WRITE boundary: normalize → validate.
        const normalize = normalizeRef.current
        const normalized = normalize ? normalize(resolved) : resolved
        const validate = validateRef.current
        if (validate && !validate(normalized)) {
          // Drop the write, keep the value: the caller's state and the stored
          // copy stay untouched, and the reason says so out loud.
          console.warn(`[useLocalStorage] rejected write to "${key}" — it failed validation; keeping the current value`)
          return prev
        }
        // A real user update that passes validation releases any active
        // suppression so the persistence effect writes it through. This is
        // the only place suppression is cleared from the update path — a
        // rejected write does NOT clear it (the key stays suppressed until a
        // valid write lands).
        if (key != null) suppressPersistenceByKey.delete(key)
        return normalized
      })
    },
    [key],
  )

  return [value, update]
}
