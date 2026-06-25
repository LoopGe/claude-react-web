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
import { AnimatedDetails } from './AnimatedCollapse'
import { useToolResult, useToolStatus } from '../hooks/usePlanStatus'
import type { ToolResultEntry, ToolStatus } from '../session-store/types'
import type { Block } from '../types'
import { formatJson } from '../utils/format'
import { truncate, stripAnsi } from '../utils/text'
import { AnsiText } from './AnsiText'

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
// ToolResultDetails
// ---------------------------------------------------------------------------

/** Collapsible <details> rendering of a tool_result payload: a one-line
 *  preview in the summary, the (truncated) full body when expanded.
 *
 *  Shared by two call sites so the formatting stays identical:
 *   - inline inside ToolCard (the merged tool_use + tool_result card)
 *   - the orphan-fallback bubble in MessageList (a tool_result whose
 *     tool_use_id never matched a seeded card)
 *
 *  Memoised so search-query keystrokes (which re-render the whole
 *  transcript) don't rebuild large pre-formatted result bodies. */
export const ToolResultDetails = memo(function ToolResultDetails({
  content,
  className = '',
  searchQuery,
  activeMatchIdx,
}: {
  content: unknown
  className?: string
  searchQuery?: string
  activeMatchIdx?: number
}) {
  const preview = toolResultPreview(content)
  const isString = typeof content === 'string'
  const body = isString
    ? truncate(content, 4000)
    : (() => {
        const blocks = Array.isArray(content) ? (content as Block[]) : []
        const texts = blocks
          .map((b) => {
            if (b.type === 'text' && typeof b.text === 'string') return b.text
            return formatJson(b)
          })
          .join('\n\n')
        return truncate(texts || formatJson(content), 4000)
      })()
  const hasSearch = Boolean(searchQuery?.trim())
  const bodyRef = useRef<HTMLDivElement>(null)

  // When navigating search results, scroll the active <mark> into view
  // inside this (potentially scrollable) tool-result container.
  useEffect(() => {
    if (!hasSearch) return
    const el = bodyRef.current
    if (!el) return
    const active = el.querySelector('.search-hl-active')
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

  return (
    <AnimatedDetails
      className={`tool-result-details ${className}`.trim()}
      summaryClassName="tool-result-summary"
      summary={preview}
      open={hasSearch ? true : undefined}
    >
      <div className="tool-input" ref={bodyRef}>
        {isString ? <AnsiText text={body} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} /> : body}
      </div>
    </AnimatedDetails>
  )
})

/** One-line preview for the collapsed <summary>.
 *  Keeps the transcript scannable when many tool results are present. */
function toolResultPreview(content: unknown): string {
  if (typeof content === 'string') {
    const line = stripAnsi(content).split('\n')[0] ?? content
    return line ? truncate(line, 120) : '(empty)'
  }
  const blocks = Array.isArray(content) ? (content as Block[]) : []
  if (blocks.length === 0) return '(empty)'
  const first = blocks[0]
  if (first.type === 'text' && typeof first.text === 'string') {
    const line = stripAnsi(first.text).split('\n')[0] ?? first.text
    return line ? truncate(line, 120) : '(empty result)'
  }
  return `[${first.type}]`
}

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
  searchQuery,
  activeMatchIdx,
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
  /** Current search query — passed to inline tool result for highlighting. */
  searchQuery?: string
  /** Index of the active search match within this card's tool result.
   *  Passed through to AnsiText so the Nth <mark> gets `search-hl-active`. */
  activeMatchIdx?: number
}) {
  // The originating tool_result (when it has landed) is rendered inline at
  // the bottom of this card. `useToolResult` returns undefined while the
  // result is still pending or for tools that own their result rendering
  // (Plan/Question/Subagent never reach ToolCard anyway).
  const result = useToolResult(toolUseId)
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
      {result && <ToolCardResult result={result} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />}
    </div>
  )
})

/** Inline result section at the bottom of a merged tool card. Kept as a
 *  tiny wrapper (rather than inlining the JSX) so the result row carries
 *  its own container class for spacing/border and an error tint. */
const ToolCardResult = memo(function ToolCardResult({ result, searchQuery, activeMatchIdx }: { result: ToolResultEntry; searchQuery?: string; activeMatchIdx?: number }) {
  return (
    <div className={`tool-card-result${result.isError ? ' tool-card-result-error' : ''}`}>
      <ToolResultDetails content={result.content} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
    </div>
  )
})
