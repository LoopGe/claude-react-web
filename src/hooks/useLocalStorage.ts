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
//   - Optional `validate` predicate is invoked on the parsed JSON before
//     we trust the value. Anything that fails validation falls back to
//     `initial` — protects against shape drift, browser-extension edits,
//     and old-version data after schema bumps. Without this, a bad value
//     would round-trip into React state and crash the first consumer
//     that called `.map()` / iterated it.

import { useCallback, useEffect, useRef, useState } from 'react'

interface Options<T> {
  /** Optional type-guard run on parsed JSON. Returns true if the value
   *  matches the expected shape; false → use `initial` instead. */
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
  key: string,
  initial: T,
  options?: Options<T>,
): [T, (value: T | ((prev: T) => T)) => void] {
  // Stash the validator + initial in refs so the subscribe effect's
  // identity doesn't change every render (which would re-register the
  // window 'storage' listener constantly). We capture the first-render
  // values and never reassign — same semantics as React's lazy useState
  // initializer, which also only ever sees the first call's argument.
  // Callers passing different validators / initials across renders should
  // not expect the hook to track those changes.
  const validateRef = useRef(options?.validate)
  const initialRef = useRef(initial)

  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
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
    if (typeof window === 'undefined') return

    const onSync: Listener<unknown> = (next) => {
      const validate = validateRef.current
      if (validate && !validate(next)) {
        // Sender wrote a bad value — fall back to initial rather than
        // accept an invalid shape into React state.
        setValue(initialRef.current)
        return
      }
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
      if (e.key !== key || e.newValue == null) return
      try {
        const parsed: unknown = JSON.parse(e.newValue)
        const validate = validateRef.current
        if (validate && !validate(parsed)) {
          setValue(initialRef.current)
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
    if (typeof window === 'undefined') return
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
      setValue((prev) => (typeof next === 'function' ? (next as (p: T) => T)(prev) : next))
    },
    [],
  )

  return [value, update]
}
