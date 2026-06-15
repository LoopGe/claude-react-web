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
import { randomId } from '../utils/uuid'

/** Hard cap on simultaneously visible toasts. New ones evict the oldest
 *  so a tight loop of failures can't push the column past the viewport. */
const MAX_TOASTS = 3
const TOAST_EXIT_MS = 180

/** Default lifetime for `error` / `success` / `info`. Uniform 8s so the
 *  progress bar reads the same across kinds; callers can still override
 *  per-toast via `durationMs` (0 = sticky). */
const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  error: 8000,
  success: 8000,
  info: 8000,
}

/** Random id with a `crypto.randomUUID` fallback. The fallback path matters
 *  both in older test environments where `crypto` is undefined AND when the
 *  app is opened over plain HTTP from another machine (non-secure context,
 *  where `crypto.randomUUID` is not exposed). Shared impl in utils/uuid. */
const makeId = randomId

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
  const toastsRef = useRef<Toast[]>([])
  // id → timer entry. Kept in a ref so `dismiss`/`show`/`pause`/`resume`
  // can manage timers without the effect re-running on every state
  // change. Cleared on unmount.
  const timersRef = useRef<Map<string, TimerEntry>>(new Map())
  // id — final removal timeout after the exit animation has started. This
  // keeps dismissed toasts mounted long enough for CSS to animate them out.
  const removalTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const commitToasts = useCallback((next: Toast[]) => {
    toastsRef.current = next
    setToasts(next)
  }, [])

  const removeNow = useCallback((id: string) => {
    const entry = timersRef.current.get(id)
    if (entry) {
      clearTimeout(entry.handle)
      timersRef.current.delete(id)
    }
    const removal = removalTimersRef.current.get(id)
    if (removal) {
      clearTimeout(removal)
      removalTimersRef.current.delete(id)
    }
    commitToasts(toastsRef.current.filter((t) => t.id !== id))
  }, [commitToasts])

  const dismiss = useCallback((id: string) => {
    const entry = timersRef.current.get(id)
    if (entry) {
      clearTimeout(entry.handle)
      timersRef.current.delete(id)
    }
    if (removalTimersRef.current.has(id)) return

    const hasToast = toastsRef.current.some((t) => t.id === id && !t.exiting)
    if (!hasToast) return

    commitToasts(toastsRef.current.map((t) => (t.id === id ? { ...t, exiting: true } : t)))
    const removal = setTimeout(() => removeNow(id), TOAST_EXIT_MS)
    removalTimersRef.current.set(id, removal)
  }, [commitToasts, removeNow])

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
    entry.handle = setTimeout(() => dismiss(id), entry.remaining)
  }, [dismiss])

  const show = useCallback(
    (kind: ToastKind, message: string, opts?: PushOptions): string => {
      const id = makeId()
      const durationMs = opts?.durationMs ?? DEFAULT_DURATIONS[kind]
      const onClick = opts?.onClick
      const actionLabel = opts?.actionLabel
      const active = toastsRef.current.filter((t) => !t.exiting)
      const overflow = Math.max(0, active.length + 1 - MAX_TOASTS)
      const evictedIds = new Set(active.slice(0, overflow).map((t) => t.id))
      for (const droppedId of evictedIds) {
        const entry = timersRef.current.get(droppedId)
        if (entry) {
          clearTimeout(entry.handle)
          timersRef.current.delete(droppedId)
        }
      }
      commitToasts([
        ...toastsRef.current.map((t) => (evictedIds.has(t.id) ? { ...t, exiting: true } : t)),
        { id, kind, message, durationMs, onClick, actionLabel },
      ])
      for (const droppedId of evictedIds) {
        if (removalTimersRef.current.has(droppedId)) continue
        const removal = setTimeout(() => removeNow(droppedId), TOAST_EXIT_MS)
        removalTimersRef.current.set(droppedId, removal)
      }
      if (durationMs > 0) {
        const handle = setTimeout(() => dismiss(id), durationMs)
        timersRef.current.set(id, { handle, startedAt: Date.now(), remaining: durationMs })
      }
      return id
    },
    [commitToasts, dismiss, removeNow],
  )

  // Clear pending timers on unmount so they can't setState on an
  // unmounted provider (StrictMode double-mount also benefits).
  useEffect(() => {
    const timers = timersRef.current
    const removalTimers = removalTimersRef.current
    return () => {
      for (const e of timers.values()) clearTimeout(e.handle)
      timers.clear()
      toastsRef.current = []
      for (const removal of removalTimers.values()) clearTimeout(removal)
      removalTimers.clear()
    }
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, show, dismiss, pause, resume }),
    [toasts, show, dismiss, pause, resume],
  )

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}
