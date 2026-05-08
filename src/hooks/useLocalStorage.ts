// Minimal typed wrapper around localStorage with a React-friendly update API.
//
// SSR-safe (checks typeof window), JSON-encoded, and quietly ignores storage
// errors (quota exceeded, disabled storage, etc.). Returns the same tuple
// shape as useState so callers can drop it in.

import { useCallback, useEffect, useState } from 'react'

export function useLocalStorage<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    try {
      const raw = window.localStorage.getItem(key)
      return raw == null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })

  // Persist on every change.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* ignore quota / SecurityError */
    }
  }, [key, value])

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => (typeof next === 'function' ? (next as (p: T) => T)(prev) : next))
    },
    [],
  )

  return [value, update]
}
