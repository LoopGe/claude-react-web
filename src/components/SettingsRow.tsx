// Shared settings row layout — a left text column (title + optional
// description) and a right-aligned control. Used by the global Settings →
// Server tab and the per-session Settings panel so both surfaces line up.

import type { ReactNode } from 'react'

export function SettingsRow({ title, hint, children, stack }: {
  title: ReactNode
  hint?: ReactNode
  children: ReactNode
  /** Stack the control under the text column instead of pinning it right.
   *  For wide controls (text inputs, selects) in narrow surfaces. */
  stack?: boolean
}) {
  return (
    <div className={`settings-row${stack ? ' stack' : ''}`}>
      <div className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {hint != null && <span className="settings-row-hint">{hint}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}
