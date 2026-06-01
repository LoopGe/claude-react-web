import { createContext } from 'react'

/** Severity controls colour + icon. `info` is the neutral accent variant.
 *  Add new kinds here AND in `ToastHost`'s class-name map. */
export type ToastKind = 'error' | 'success' | 'info'

export type Toast = {
  id: string
  kind: ToastKind
  message: string
  /** 0 = sticky, no auto-dismiss. Otherwise milliseconds before auto-clear. */
  durationMs: number
  /** Optional click handler. When set, the toast becomes interactive:
   *  - If `actionLabel` is also provided, it renders as a separate action
   *    button between the message and the dismiss ✕.
   *  - If `actionLabel` is omitted, the message itself becomes a button
   *    (cursor pointer + hover state). Useful for "Open session" jumps.
   *  Clicking the action auto-dismisses the toast. */
  onClick?: () => void
  /** Label for the dedicated action button. Ignored without `onClick`. */
  actionLabel?: string
}

export type PushOptions = {
  /** Override the kind's default lifetime. Pass `0` for sticky. */
  durationMs?: number
  /** Make the toast clickable — see Toast.onClick for behaviour. */
  onClick?: () => void
  /** Pair with `onClick` to render a separate action button. */
  actionLabel?: string
}

export type ToastContextValue = {
  toasts: Toast[]
  show: (kind: ToastKind, message: string, opts?: PushOptions) => string
  dismiss: (id: string) => void
}

/** Internal — Provider lives in components/ToastProvider.tsx, hooks in
 *  hooks/useToast.ts. Exporting the context from a third file keeps
 *  fast-refresh happy (each file exports either components or
 *  non-components, never both). */
export const ToastContext = createContext<ToastContextValue | null>(null)
