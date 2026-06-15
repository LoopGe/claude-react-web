import { useEffect, useRef, useState } from 'react'

const DEFAULT_EXIT_MS = 180

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useExitPresence(open: boolean, durationMs = DEFAULT_EXIT_MS) {
  const presence = usePresenceValue(open ? true : null, durationMs)
  return {
    shouldRender: presence.value != null,
    isExiting: presence.isExiting,
  }
}

export function usePresenceValue<T>(value: T | null | undefined | false, durationMs = DEFAULT_EXIT_MS) {
  const normalizedValue = value || null
  const [presence, setPresence] = useState<{ value: T | null; isExiting: boolean }>(() => ({
    value: normalizedValue,
    isExiting: false,
  }))
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect -- presence mirrors the open prop and delays only the exit unmount */
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (normalizedValue != null) {
      setPresence({ value: normalizedValue, isExiting: false })
      return
    }

    setPresence((current) => {
      if (current.value == null) return current.isExiting ? { value: null, isExiting: false } : current
      if (prefersReducedMotion()) return { value: null, isExiting: false }

      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setPresence({ value: null, isExiting: false })
      }, durationMs)

      return { value: current.value, isExiting: true }
    })

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [durationMs, normalizedValue])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return presence
}
