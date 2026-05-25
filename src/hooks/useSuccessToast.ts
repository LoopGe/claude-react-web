import { useCallback, useEffect, useRef, useState } from 'react'

/** Reusable success toast with auto-dismiss. Returns the current message
 *  (or null), a setter that schedules automatic clearing after `duration` ms,
 *  and an immediate `clearSuccess` for dismiss buttons.
 *  Calling `showSuccess` while a previous toast is still visible resets the timer. */
export function useSuccessToast(duration = 3000) {
  const [message, setMessage] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showSuccess = useCallback(
    (msg: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      setMessage(msg)
      timerRef.current = setTimeout(() => setMessage(null), duration)
    },
    [duration],
  )

  const clearSuccess = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setMessage(null)
  }, [])

  // Clean up timer on unmount to avoid setState on unmounted component.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  return [message, showSuccess, clearSuccess] as const
}
