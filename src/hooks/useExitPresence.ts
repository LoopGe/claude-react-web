import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../utils/reduced-motion'

const DEFAULT_EXIT_MS = 180

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

  // When the value becomes non-null, adopt it SYNCHRONOUSLY (during render)
  // rather than in an effect. An effect-based update runs after paint, so the
  // element renders one frame late — its layout change falls outside the
  // browser's hadRecentInput window and is counted as CLS ("Ctrl+F 全部卡片
  // 闪烁"). The exit path still uses the effect + timer (that's its job).
  const activeValue = normalizedValue != null ? normalizedValue : presence.value
  const isExitingNow = normalizedValue == null && presence.isExiting

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

  return { value: activeValue, isExiting: isExitingNow }
}
