// DragOverlay rendered through a portal to document.body.
//
// dnd-kit's DragOverlay does NOT portal — it renders in place as
// `position: fixed`. That is viewport-relative ONLY while every ancestor is
// untransformed; any ancestor with a non-none `transform` (e.g. the global
// settings modal's persistent `overlay-panel-in` fill, or any scale-in
// entrance) becomes the containing block instead, and the ghost's
// viewport-space `top/left` are then measured from that ancestor — the ghost
// jumps by the ancestor's offset and drifts further as inner scroll
// containers move. The profiles settings lists were the visible casualty.
//
// Portaling to <body> pins the containing block to the viewport for every
// surface at once (React context still flows through portals). The wrapper
// sits above the modal layer (--z-modal) so a drag started inside a modal
// paints over it, and below the toast host.
//
// Body is captured lazily: the app is client-only, but a module-level
// constant would break any future SSR/test harness that renders before the
// DOM is assembled.

import { type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DragOverlay } from '@dnd-kit/core'
import { DROP_ANIMATION } from './motion'

export function DragOverlayPortal({ children }: { children: ReactNode }) {
  const container = typeof document !== 'undefined' ? document.body : null
  if (!container) return null
  return createPortal(
    <DragOverlay
      dropAnimation={DROP_ANIMATION}
      className="dnd-overlay-ghost"
      // DragOverlay inlines a default z-index (999); an explicit undefined
      // key removes it so the layer decision lives on .dnd-overlay-ghost in
      // dnd.css (token math stays in CSS).
      style={{ zIndex: undefined } as CSSProperties}
    >
      {children}
    </DragOverlay>,
    container,
  )
}
