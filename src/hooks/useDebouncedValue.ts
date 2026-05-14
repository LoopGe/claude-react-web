import { useEffect, useState } from 'react'

/** Returns `value` after it has been stable for `delayMs` milliseconds.
 *  During the debounce window, the previously-stable value is returned. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
