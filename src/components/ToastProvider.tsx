// Global toast Provider. Owns the toast list state and the auto-dismiss
// timer map. Consumers use the hooks in `useToast.ts`; the visual stack
// is rendered by `ToastHost`. Provider/hook/host are split across three
// files so each file exports either components or non-components only —
// this keeps Vite fast-refresh happy and matches the layout used by
// WsHubProvider in this codebase.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ToastContext,
  type Toast,
  type ToastContextValue,
  type ToastKind,
  type PushOptions,
} from '../hooks/toastContext'

/** Hard cap on simultaneously visible toasts. New ones evict the oldest
 *  so a tight loop of failures can't push the column past the viewport. */
const MAX_TOASTS = 3

/** Default lifetime for `error` / `success` / `info`. Errors stay a touch
 *  longer because users tend to scan-then-read, while successes are
 *  acknowledgements that just need to register. */
const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  error: 6000,
  success: 3000,
  info: 4500,
}

/** Random id with a `crypto.randomUUID` fallback. The fallback path
 *  matters in older test environments where `crypto` is undefined. */
function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  // id → timeout handle. Kept in a ref so `dismiss` and `show` can
  // clear/reset timers without the effect re-running on every state
  // change. Cleared on unmount.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const show = useCallback(
    (kind: ToastKind, message: string, opts?: PushOptions): string => {
      const id = makeId()
      const durationMs = opts?.durationMs ?? DEFAULT_DURATIONS[kind]
      const onClick = opts?.onClick
      const actionLabel = opts?.actionLabel
      setToasts((prev) => {
        const next = [
          ...prev,
          { id, kind, message, durationMs, onClick, actionLabel },
        ]
        // Evict from the front so the most recent toasts stay visible.
        // Evicted ids also need their timers cleared.
        while (next.length > MAX_TOASTS) {
          const dropped = next.shift()!
          const timer = timersRef.current.get(dropped.id)
          if (timer) {
            clearTimeout(timer)
            timersRef.current.delete(dropped.id)
          }
        }
        return next
      })
      if (durationMs > 0) {
        const timer = setTimeout(() => {
          timersRef.current.delete(id)
          setToasts((prev) => prev.filter((t) => t.id !== id))
        }, durationMs)
        timersRef.current.set(id, timer)
      }
      return id
    },
    [],
  )

  // Clear pending timers on unmount so they can't setState on an
  // unmounted provider (StrictMode double-mount also benefits).
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  const value = useMemo<ToastContextValue>(() => ({ toasts, show, dismiss }), [toasts, show, dismiss])

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}
