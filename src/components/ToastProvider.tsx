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

/** Default lifetime for `error` / `success` / `info`. Uniform 8s so the
 *  progress bar reads the same across kinds; callers can still override
 *  per-toast via `durationMs` (0 = sticky). */
const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  error: 8000,
  success: 8000,
  info: 8000,
}

/** Random id with a `crypto.randomUUID` fallback. The fallback path
 *  matters in older test environments where `crypto` is undefined. */
function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Per-toast countdown bookkeeping. `remaining` is recomputed on pause so
 *  resume can re-arm with the time left, keeping the JS removal in sync
 *  with the CSS progress bar (which pauses on hover). `startedAt` is the
 *  wall-clock the current run began (null while paused). */
type TimerEntry = {
  handle: ReturnType<typeof setTimeout>
  startedAt: number | null
  remaining: number
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  // id → timer entry. Kept in a ref so `dismiss`/`show`/`pause`/`resume`
  // can manage timers without the effect re-running on every state
  // change. Cleared on unmount.
  const timersRef = useRef<Map<string, TimerEntry>>(new Map())

  const dismiss = useCallback((id: string) => {
    const entry = timersRef.current.get(id)
    if (entry) {
      clearTimeout(entry.handle)
      timersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const pause = useCallback((id: string) => {
    const entry = timersRef.current.get(id)
    if (!entry || entry.startedAt === null) return
    clearTimeout(entry.handle)
    const elapsed = Date.now() - entry.startedAt
    entry.remaining = Math.max(0, entry.remaining - elapsed)
    entry.startedAt = null
  }, [])

  const resume = useCallback((id: string) => {
    const entry = timersRef.current.get(id)
    if (!entry || entry.startedAt !== null) return
    entry.startedAt = Date.now()
    entry.handle = setTimeout(() => {
      timersRef.current.delete(id)
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, entry.remaining)
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
          const entry = timersRef.current.get(dropped.id)
          if (entry) {
            clearTimeout(entry.handle)
            timersRef.current.delete(dropped.id)
          }
        }
        return next
      })
      if (durationMs > 0) {
        const handle = setTimeout(() => {
          timersRef.current.delete(id)
          setToasts((prev) => prev.filter((t) => t.id !== id))
        }, durationMs)
        timersRef.current.set(id, { handle, startedAt: Date.now(), remaining: durationMs })
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
      for (const e of timers.values()) clearTimeout(e.handle)
      timers.clear()
    }
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, show, dismiss, pause, resume }),
    [toasts, show, dismiss, pause, resume],
  )

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}
