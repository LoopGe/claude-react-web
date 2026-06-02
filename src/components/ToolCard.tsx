// Shared primitives for tool_use card rendering.
//
// Three components live here because they're tightly coupled — every
// tool card uses the same icon-title-status-body layout, the same copy
// affordance, and the same status badge semantics. Putting them in
// separate files would just push the coupling into the import graph.
//
//   ToolCard       — the outer chrome (icon + title + chips + status badge)
//   CopyButton     — hover-revealed clipboard button used inside cards
//   ToolStatusBadge — running/success/error pill, also used standalone
//                     by some tool views

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconAlertCircle,
  IconCheck,
  IconCopy,
  IconLoader,
} from './icons/ToolIcons'
import { useToolStatus } from '../hooks/usePlanStatus'
import type { ToolStatus } from '../session-store/types'

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

/** Tiny copy-to-clipboard button. Appears as a static icon, flips to a
 *  green check + "Copied!" tooltip for 2s after a successful copy.
 *  Designed for placement in a ToolCard header — has a 24×24 visual
 *  size with a 32×32 hit area (room for thumbs on touch devices)
 *  and inherits parent text color so it sits next to status badges
 *  without competing for attention.
 *
 *  Use `getValue` (a function) rather than passing the raw string when
 *  the value is large — the function is only called on click, so we
 *  avoid eagerly serialising whole diff bodies into clipboard-button
 *  props on every render. */
export function CopyButton({
  getValue,
  label = 'Copy',
  className = '',
  size = 14,
}: {
  getValue: () => string
  label?: string
  className?: string
  size?: number
}) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Clear any in-flight "Copied!" timer when this button unmounts so a
  // post-unmount setState (silently swallowed by React in dev mode but
  // still a leak) can't fire.
  useEffect(() => () => {
    if (timerRef.current != null) clearTimeout(timerRef.current)
  }, [])

  const handle = useCallback(() => {
    const value = getValue()
    if (!value) return
    const onSuccess = () => {
      setCopied(true)
      if (timerRef.current != null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    }
    const writer = navigator.clipboard?.writeText(value)
    if (writer) {
      writer.then(onSuccess, () => {
        // Fallback: hidden textarea + execCommand (Safari without HTTPS,
        // or browsers blocking clipboard inside an iframe).
        legacyCopy(value, onSuccess)
      })
    } else {
      legacyCopy(value, onSuccess)
    }
  }, [getValue])

  return (
    <button
      type="button"
      className={`tool-copy-btn${copied ? ' copied' : ''} ${className}`.trim()}
      onClick={handle}
      title={copied ? 'Copied!' : label}
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? <IconCheck size={size} /> : <IconCopy size={size} />}
    </button>
  )
}

function legacyCopy(text: string, onSuccess: () => void) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    onSuccess()
  } catch {
    // Last resort — silent failure.
  }
}

// ---------------------------------------------------------------------------
// ToolStatusBadge
// ---------------------------------------------------------------------------

const STATUS_TITLE: Record<ToolStatus, string> = {
  running: 'Tool is still running — Claude has not yet received the result.',
  success: 'Tool completed successfully.',
  error: 'Tool failed — Claude received an error result and may retry or abort the turn.',
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: 'running',
  success: 'done',
  error: 'failed',
}

/** Inline status pill: spinner for running, ✓ for success, ✕ for error.
 *  Reads from the ToolStatusContext when an id is provided; pass
 *  `status` directly to override (e.g. for cards that maintain their
 *  own lifecycle like Plan/Question). */
export const ToolStatusBadge = memo(function ToolStatusBadge({
  toolUseId,
  status: explicitStatus,
  compact = false,
}: {
  toolUseId?: string
  status?: ToolStatus
  /** When true, render the badge as an icon-only dot (no text) — saves
   *  horizontal space in dense rows like Grep/Read. */
  compact?: boolean
}) {
  const ctxStatus = useToolStatus(toolUseId)
  const status = explicitStatus ?? ctxStatus
  const Icon =
    status === 'success' ? IconCheck : status === 'error' ? IconAlertCircle : IconLoader
  return (
    <span
      className={`tool-status tool-status-${status}${compact ? ' tool-status-compact' : ''}`}
      title={STATUS_TITLE[status]}
      aria-live="polite"
      aria-label={`Tool status: ${STATUS_LABEL[status]}`}
    >
      <Icon size={compact ? 11 : 12} />
      {!compact && <span className="tool-status-label">{STATUS_LABEL[status]}</span>}
    </span>
  )
})

// ---------------------------------------------------------------------------
// ToolCard
// ---------------------------------------------------------------------------

/** Outer chrome shared by every tool_use card.
 *
 *  Layout:
 *    ┌──────────────────────────────────────────────────────┐
 *    │ [icon] title       chip chip chip   [status] [copy]  │  ← header
 *    ├──────────────────────────────────────────────────────┤
 *    │  body…                                               │  ← children
 *    └──────────────────────────────────────────────────────┘
 *
 *  Pass `collapsible=true` to wrap in <details>; otherwise a plain div.
 *  Plan and Question cards bring their own collapsibles because they
 *  also need to remount on status flip — they don't use this primitive.
 *
 *  The `copyValue` getter (when provided) places a copy button at the
 *  far right of the header. Status badge sits to its left.
 *
 *  When you don't have a tool_use id (e.g. for cards that own their
 *  status), pass `hideStatus` to drop the badge entirely. */
export const ToolCard = memo(function ToolCard({
  icon,
  title,
  chips,
  toolUseId,
  status,
  hideStatus = false,
  copyValue,
  copyLabel,
  className = '',
  children,
}: {
  icon: ReactNode
  title?: ReactNode
  chips?: ReactNode
  /** When set, ToolStatusBadge reads from context for live updates. */
  toolUseId?: string
  /** Override status (used by Plan/Question which carry their own). */
  status?: ToolStatus
  hideStatus?: boolean
  copyValue?: () => string
  copyLabel?: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={`tool-card ${className}`.trim()}>
      <div className="tool-card-header">
        <span className="tool-card-icon" aria-hidden>
          {icon}
        </span>
        {title != null && <span className="tool-card-title">{title}</span>}
        {chips}
        <span className="tool-card-spacer" />
        {!hideStatus && <ToolStatusBadge toolUseId={toolUseId} status={status} />}
        {copyValue && <CopyButton getValue={copyValue} label={copyLabel} />}
      </div>
      {children != null && <div className="tool-card-body">{children}</div>}
    </div>
  )
})
