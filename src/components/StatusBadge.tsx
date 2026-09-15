import type { CSSProperties, ReactNode } from 'react'

/** Tones map to the shared semantic status tokens (defined for both themes).
 *  `muted` carries no colour: it's the neutral border + fg-muted fallback. */
export type StatusTone = 'muted' | 'warn' | 'danger' | 'accent'

/** Shared status/state chip. Used for both the Setting-Profiles "Active"
 *  indicator and the App-Plugin runtime-state chip so one function has one
 *  visual implementation (and one token set) instead of two divergent
 *  badges: `settings-card-badge` vs `app-plugins-state`. */
export function StatusBadge({
  tone = 'muted',
  className,
  style,
  children,
}: {
  tone?: StatusTone
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <span className={`status-badge status-badge-${tone}${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </span>
  )
}