import { useContext, useMemo } from 'react'
import { ToastContext, type PushOptions, type Toast } from './toastContext'

/** App-wide toast hub. Exposes `error/success/info` shorthands plus the
 *  raw `show` and `dismiss`. Auto-dismiss timers live in the provider so
 *  consumers can fire-and-forget — call `toast.error('boom')` and walk
 *  away. Returns a stable handle (memoised), safe to drop into useEffect
 *  / useCallback dependency arrays. */
export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  const { show, dismiss } = ctx
  return useMemo(
    () => ({
      error: (message: string, opts?: PushOptions) => show('error', message, opts),
      success: (message: string, opts?: PushOptions) => show('success', message, opts),
      info: (message: string, opts?: PushOptions) => show('info', message, opts),
      show,
      dismiss,
    }),
    [show, dismiss],
  )
}

/** Read-only access to the toast list — used by `ToastHost` to render. */
export function useToastList(): Toast[] {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToastList must be used inside <ToastProvider>')
  return ctx.toasts
}

/** Read-only dismiss handle — used by `ToastHost`'s ✕ button. */
export function useToastDismiss(): (id: string) => void {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToastDismiss must be used inside <ToastProvider>')
  return ctx.dismiss
}
