import { useCallback, useEffect, useRef, useState } from 'react'

/** Reusable error toast with auto-dismiss. Returns the current error string
 *  (or null), a setter that schedules automatic clearing after `duration` ms,
 *  and an immediate `clearError` for dismiss buttons.
 *  Calling `showError` while a previous toast is still visible resets the timer. */
export function useErrorToast(duration = 5000) {
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showError = useCallback(
    (msg: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      setError(msg)
      timerRef.current = setTimeout(() => setError(null), duration)
    },
    [duration],
  )

  const clearError = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setError(null)
  }, [])

  // Clean up timer on unmount to avoid setState on unmounted component.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  return [error, showError, clearError] as const
}
