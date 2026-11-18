// Shared primitives for tool_use card rendering.
//
// Three components live here because they're tightly coupled — every
// tool card uses the same icon-title-status-body layout, the same copy
// affordance, and the same status badge semantics. Putting them in
// separate files would just push the coupling into the import graph.
//
//   ToolCard       — the outer chrome (icon + title + chips + status badge)
//   CopyButton     — always-visible copy icon in the card header (only its
//                    backdrop appears on hover)
//   ToolStatusBadge — running/success/error pill, also used standalone
//                     by some tool views

import { memo, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import {
  IconAlertCircle,
  IconArrowDown,
  IconCheck,
  IconCopy,
  IconLoader,
} from './icons/ToolIcons'
import { AnimatedDetails } from './AnimatedCollapse'
import { HoverHint } from './HoverHint'
import { tweenGridTrack } from '../utils/grid-track-tween'
import { useToolResult, useResolvedToolStatus, useToolStatus } from '../hooks/usePlanStatus'
import { useEnterOnArrival } from '../hooks/useEnterOnArrival'
import { useRevealClass } from '../hooks/useRevealClass'
import { useReopenQuestion } from '../hooks/useReopenQuestion'
import { useCopy } from '../hooks/useCopy'
import type { ToolResultEntry, ToolStatus } from '../session-store/types'
import type { Block } from '../types'
import { truncate, stripAnsi } from '../utils/text'
import { toolResultBodyParts } from '../../shared/tool-result-text'
import { countMatches } from '../../shared/search/match'
import { MsgImage } from './MsgImage'
import { AnsiText } from './AnsiText'

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

/** Copy-to-clipboard button for a ToolCard header. The icon is always
 *  visible; only its backdrop brightens on hover (see `.tool-copy-btn`
 *  for the sizing/hit-area details), so it sits next to status badges
 *  without competing for attention. Flips to a green check + "Copied!"
 *  tooltip for 2s after a successful copy.
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
  const { copied, copy } = useCopy()

  return (
    <HoverHint label={copied ? 'Copied!' : label} side="top">
      <button
        type="button"
        className={`tool-copy-btn${copied ? ' copied' : ''} ${className}`.trim()}
        onClick={() => { void copy(getValue) }}
        aria-label={copied ? 'Copied' : label}
      >
        {copied ? <IconCheck size={size} /> : <IconCopy size={size} />}
      </button>
    </HoverHint>
  )
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

/** Presentational status pill for a concrete status — no context access.
 *  The caller has already resolved the value (ToolCard computes it for the
 *  background-button gate and passes it down), so rendering here must not
 *  re-subscribe to ToolStatusContext. Keeping this split makes the badge a
 *  leaf that only re-renders when its own status actually changes. */
const ToolStatusBadgeResolved = memo(function ToolStatusBadgeResolved({
  status,
  compact = false,
}: {
  status: ToolStatus
  /** When true, render the badge as an icon-only dot (no text) — saves
   *  horizontal space in dense rows like Grep/Read. */
  compact?: boolean
}) {
  const Icon =
    status === 'success' ? IconCheck : status === 'error' ? IconAlertCircle : IconLoader
  return (
    <HoverHint label={STATUS_TITLE[status]} side="top">
      <span
        className={`tool-status tool-status-${status}${compact ? ' tool-status-compact' : ''}`}
        aria-live="polite"
        aria-label={`Tool status: ${STATUS_LABEL[status]}`}
      >
        <Icon size={compact ? 11 : 12} />
        {!compact && <span className="tool-status-label">{STATUS_LABEL[status]}</span>}
      </span>
    </HoverHint>
  )
})

/** Context-reading badge: resolves a tool_use id's status from
 *  ToolStatusContext. A dedicated leaf so the subscription stays inside a
 *  component that always calls `useToolStatus` (rules-of-hooks — no
 *  conditional hook calls in ToolStatusBadge). */
const ToolStatusBadgeFromCtx = memo(function ToolStatusBadgeFromCtx({
  toolUseId,
  compact,
}: {
  toolUseId?: string
  compact?: boolean
}) {
  const status = useToolStatus(toolUseId)
  return <ToolStatusBadgeResolved status={status} compact={compact} />
})

/** Inline status pill: spinner for running, ✓ for success, ✕ for error.
 *  Standalone helper that reads a tool's status from ToolStatusContext when
 *  only an id is given; pass `status` directly (e.g. cards that maintain
 *  their own lifecycle like Plan/Question) to render that fixed value
 *  without a context subscription. ToolCard itself renders
 *  ToolStatusBadgeResolved with its already-resolved status, so a card's
 *  badge never double-subscribes. */
export const ToolStatusBadge = memo(function ToolStatusBadge({
  toolUseId,
  status: explicitStatus,
  compact = false,
}: {
  toolUseId?: string
  status?: ToolStatus
  compact?: boolean
}) {
  if (explicitStatus != null) {
    return <ToolStatusBadgeResolved status={explicitStatus} compact={compact} />
  }
  return <ToolStatusBadgeFromCtx toolUseId={toolUseId} compact={compact} />
})

// ---------------------------------------------------------------------------
// BackgroundToolButton
// ---------------------------------------------------------------------------

/** The shared "background this task" pill — rendered on a RUNNING generic
 *  tool card (inside the header, before the status badge) and on a
 *  synchronous subagent card (inside its metadata row). One component +
 *  one CSS class so the two surfaces can't drift apart. No
 *  stopPropagation needed: neither the ToolCard header nor any ancestor up
 *  to the document root carries a click handler. */
export function BackgroundToolButton({
  onClick,
  title,
  ariaLabel,
}: {
  onClick: () => void
  title: string
  ariaLabel: string
}) {
  return (
    <HoverHint label={title} side="top">
      <button
        type="button"
        className="tool-card-bg-btn"
        onClick={onClick}
        aria-label={ariaLabel}
      >
        <IconArrowDown size={12} />
        <span>background</span>
      </button>
    </HoverHint>
  )
}

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
  // One shared derivation (shared/tool-result-text) is the single writer of the
  // rendered runs; the server search segments and client match walks consume
  // the same view, so counts and marks always agree.
  const parts = toolResultBodyParts(content)
  const q = searchQuery?.trim()
  const hasSearch = Boolean(q)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Rebase the result-global active match index into per-run coordinates: each
  // text run owns countMatches(run, q) matches, image runs own none. The run
  // containing the active hit gets its part-local index; every other run gets
  // undefined (default highlight colour).
  const partActive = parts.map(() => undefined as number | undefined)
  if (q && activeMatchIdx != null && activeMatchIdx >= 0) {
    let remaining = activeMatchIdx
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part.kind !== 'text') continue
      const n = countMatches(part.text, q)
      if (n === 0) continue
      if (remaining < n) { partActive[i] = remaining; break }
      remaining -= n
    }
  }

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
        {parts.map((part, i) => {
          if (part.kind === 'text') {
            return (
              <AnsiText
                key={i}
                text={part.text}
                searchQuery={searchQuery}
                activeMatchIdx={partActive[i]}
              />
            )
          }
          // The WHOLE image run is one navigable viewer group, shared by every
          // MsgImage in the row (click image N → viewer opens at N with ←/→).
          const group = part.srcs.map((src) => ({ src }))
          return (
            <div key={`imgs-${i}`} className="tool-result-images">
              {part.srcs.map((src, j) => (
                <MsgImage key={j} src={src} alt="tool result image" decoding="async" group={group} index={j} />
              ))}
            </div>
          )
        })}
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
  if (first == null) return '(empty)'
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
 *  status), pass `hideStatus` to drop the badge entirely.
 *
 *  `onBackground` (when provided AND the card is still running) renders a
 *  "background this task" action in the header — the precise, per-card
 *  replacement for the removed Composer morph: the card knows its own
 *  tool_use id, so the click targets exactly this task instead of every
 *  foreground task (which is what Alt+B does). The button disappears on
 *  its own once the tool_result lands — backgrounding includes a result. */
export const ToolCard = memo(function ToolCard({
  icon,
  title,
  chips,
  toolUseId,
  status,
  hideStatus = false,
  copyValue,
  copyLabel,
  onBackground,
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
  /** Background exactly this tool call (Ctrl+B semantics, per-tool). Only
   *  offered while the card is running — a settled tool has nothing to
   *  detach. Views pass it only for backgroundable tools (Bash/PowerShell). */
  onBackground?: () => void
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
  // Arms a one-shot entrance animation on the merged result section when the
  // result genuinely lands (never on scroll-back remounts — see the hook).
  const resultEntering = useEnterOnArrival(result)
  // Resolved lifecycle status for the background-button gate — the same
  // resolver the badge below uses, so the two can never disagree.
  const resolvedStatus = useResolvedToolStatus(toolUseId, status)
  const showBackground = onBackground != null && resolvedStatus === 'running'
  const hasActions = showBackground || !hideStatus || copyValue != null
  // When this tool's pending permission dialog has been minimized, surface a
  // "Review permission" chip so the user can re-open it. Mirrors the inline
  // reopen button PlanCard/QuestionCard render when minimized.
  const { minimizedPermissionToolUseIds, onReopenPermission } = useReopenQuestion()
  const isPermMinimized = !!toolUseId && minimizedPermissionToolUseIds.has(toolUseId)
  return (
    <div className={`tool-card ${className}`.trim()}>
      <div className="tool-card-header">
        <span className="tool-card-icon" aria-hidden>
          {icon}
        </span>
        {title != null && <span className="tool-card-title">{title}</span>}
        {chips}
        {isPermMinimized && toolUseId && (
          <button
            type="button"
            className="tool-card-perm-reopen"
            onClick={() => onReopenPermission(toolUseId)}
          >
            Review permission
          </button>
        )}
        {hasActions && (
          <span className="tool-card-actions">
            {showBackground && (
              <BackgroundToolButton
                onClick={onBackground}
                title="Background this task — the turn continues while it detaches to the background task list (Alt+B backgrounds every running task)"
                ariaLabel="Background this task"
              />
            )}
            {!hideStatus && <ToolStatusBadgeResolved status={resolvedStatus} />}
            {copyValue && <CopyButton getValue={copyValue} label={copyLabel} />}
          </span>
        )}
      </div>
      {children != null && <div className="tool-card-body">{children}</div>}
      {result && <ToolResultSection result={result} entering={resultEntering} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />}
    </div>
  )
})

/** Inline result section at the bottom of a merged tool card — shared by
 *  ToolCard, SubagentCard and WorkflowCard so the entrance animation and
 *  error tint can't drift apart across the three surfaces.
 *
 *  `entering` (from useEnterOnArrival) arms a one-shot fade/rise/expand. The
 *  class lifecycle — latch across the re-render that lands in the same frame
 *  the status badge flips, `animationend` strip, reduced-motion fallback —
 *  is the shared useRevealClass latch. */
export const ToolResultSection = memo(function ToolResultSection({ result, entering = false, searchQuery, activeMatchIdx }: { result: ToolResultEntry; entering?: boolean; searchQuery?: string; activeMatchIdx?: number }) {
  const { revealing, handleAnimationEnd } = useRevealClass(entering, 'item-enter')
  const wrapperRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  // The reveal's height is driven from rAF in whole CSS px: a fractional
  // `grid-template-rows` tween re-phases every glyph below the section each
  // frame (the reported shimmer when expanding a tool result inside a card).
  // `entering` still supplies the class's opacity/rise beat.
  useLayoutEffect(() => {
    if (!revealing) return
    const el = wrapperRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    // Cancel on unmount: a card recycled mid-reveal must not keep an inline track.
    return tweenGridTrack(el, inner)
  }, [revealing])

  return (
    <div
      ref={wrapperRef}
      className={`tool-card-result${result.isError ? ' tool-card-result-error' : ''}${revealing ? ' tool-card-result-enter' : ''}`}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="tool-card-result-inner" ref={innerRef}>
        <ToolResultDetails content={result.content} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
      </div>
    </div>
  )
})
