import { useCallback, useEffect, useRef, useState } from 'react'

export type ClearPhase = 'fading-in' | 'fading-out'

export interface UseClearAnimationOptions {
  fadeInMs?: number
  fadeOutMs?: number
}

export interface UseClearAnimationReturn {
  clearingByPanel: ReadonlyMap<string, ClearPhase>
  beginClear: (id: string) => Promise<void>
  swapAndEnd: (oldId: string, newId: string) => void
  cancelClear: (id: string) => void
}

const DEFAULT_FADE_IN_MS = 180
const DEFAULT_FADE_OUT_MS = 180

export function useClearAnimation(
  opts: UseClearAnimationOptions = {},
): UseClearAnimationReturn {
  const fadeInMs = opts.fadeInMs ?? DEFAULT_FADE_IN_MS
  const fadeOutMs = opts.fadeOutMs ?? DEFAULT_FADE_OUT_MS
  const [clearingByPanel, setClearingByPanel] = useState<Map<string, ClearPhase>>(
    () => new Map(),
  )
  const cleanupTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  )

  // Clear any pending cleanup timer on unmount so we don't setState after unmount.
  useEffect(
    () => () => {
      for (const t of cleanupTimersRef.current.values()) clearTimeout(t)
      cleanupTimersRef.current.clear()
    },
    [],
  )

  const cancelTimer = useCallback((id: string) => {
    const t = cleanupTimersRef.current.get(id)
    if (t != null) {
      clearTimeout(t)
      cleanupTimersRef.current.delete(id)
    }
  }, [])

  const beginClear = useCallback(
    (id: string): Promise<void> => {
      cancelTimer(id)
      setClearingByPanel((prev) => {
        const next = new Map(prev)
        next.set(id, 'fading-in')
        return next
      })
      return new Promise<void>((resolve) => {
        setTimeout(resolve, fadeInMs)
      })
    },
    [cancelTimer, fadeInMs],
  )

  const swapAndEnd = useCallback(
    (oldId: string, newId: string): void => {
      cancelTimer(oldId)
      cancelTimer(newId)
      setClearingByPanel((prev) => {
        const next = new Map(prev)
        next.delete(oldId)
        next.set(newId, 'fading-out')
        return next
      })
      const t = setTimeout(() => {
        cleanupTimersRef.current.delete(newId)
        setClearingByPanel((prev) => {
          if (!prev.has(newId)) return prev
          const next = new Map(prev)
          next.delete(newId)
          return next
        })
      }, fadeOutMs)
      cleanupTimersRef.current.set(newId, t)
    },
    [cancelTimer, fadeOutMs],
  )

  const cancelClear = useCallback(
    (id: string): void => {
      cancelTimer(id)
      setClearingByPanel((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    },
    [cancelTimer],
  )

  return { clearingByPanel, beginClear, swapAndEnd, cancelClear }
}
